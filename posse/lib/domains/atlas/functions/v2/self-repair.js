// @ts-check
//
// ATLAS v2 self-repair. When a layer is not ready and its owner is gone —
// boot reindex failed, the boot wait was backgrounded and then died, the
// process crashed mid-encode — enqueue the bounded warm job that repairs that
// layer instead of disabling ATLAS for the run. Every repair goes through the
// transactional outbox (PipelineHooks), so repeated calls coalesce onto the
// already-queued job rather than stacking duplicates, and warm-job failures
// stay silent-by-policy (maxAttempts 1) so a deterministic failure cannot
// hot-loop.

import {
  emitAtlasPipelineEvent,
  emitEmbeddingsResume,
  emitScipRestageRequested,
} from "../../classes/v2/PipelineHooks.js";
import { ATLAS_EVENTS } from "./contracts/events.js";
import { computeAtlasLayerReadiness, summarizeAtlasReadiness } from "./readiness.js";

/** @typedef {import("./readiness.js").AtlasLayerReadiness} AtlasLayerReadiness */

/**
 * Inspect per-layer readiness and enqueue repair warms for whatever is not
 * ready. Safe to call from any boot/session path: read-only inspection plus
 * coalescing enqueues; never throws.
 *
 * @param {{
 *   repoRoot: string,
 *   config?: Record<string, any>,
 *   reason?: string,
 *   targetBranch?: string,
 *   onError?: (err: Error) => void,
 * }} args
 * @returns {{
 *   ok: boolean,
 *   skipped?: string,
 *   summary: string,
 *   layers: AtlasLayerReadiness[],
 *   actions: Array<{ layer: string, event: string, warmJobId: number | null, coalesced: boolean }>,
 * }}
 */
export function enqueueAtlasSelfRepair({
  repoRoot,
  config = {},
  reason = "unspecified",
  targetBranch = "main",
  onError = undefined,
}) {
  try {
    if (config?.enabled === false) {
      return { ok: false, skipped: "atlas_disabled", summary: "atlas disabled", layers: [], actions: [] };
    }
    const { layers, notReady } = computeAtlasLayerReadiness({ repoRoot, config });
    const summary = summarizeAtlasReadiness(layers);
    /** @type {Array<{ layer: string, event: string, warmJobId: number | null, coalesced: boolean }>} */
    const actions = [];
    if (notReady.length === 0) {
      return { ok: true, summary, layers, actions };
    }

    const viewsLayer = layers.find((layer) => layer.layer === "views");
    const viewExists = viewsLayer?.status === "ready" || viewsLayer?.status === "stale";
    const structuralBroken = notReady.some(
      (layer) => layer.layer === "views" || layer.layer === "treesitter",
    );

    // Structural repair: a missing/stale/failed view or parse layer gets one
    // full main warm. main-full is resumable in practice — blobs are
    // content-addressed, so unchanged files are reused, not reparsed.
    if (structuralBroken) {
      const result = emitAtlasPipelineEvent({
        eventType: ATLAS_EVENTS.SELF_REPAIR,
        payload: {
          reason,
          layers: notReady.map((layer) => layer.layer),
        },
        warmJobPayload: {
          purpose: "main-full",
          branch: targetBranch,
          trigger_event: ATLAS_EVENTS.SELF_REPAIR,
        },
        onError,
      });
      if (result.ok) {
        actions.push({
          layer: "views",
          event: ATLAS_EVENTS.SELF_REPAIR,
          warmJobId: result.warmJobId,
          coalesced: !!result.coalesced,
        });
      }
    }

    // SCIP repair: a failed stager meta gets a restage request. The stager's
    // own failure backoff decides whether each language actually relaunches,
    // so this cannot thrash a deterministically broken indexer.
    if (notReady.some((layer) => layer.layer.startsWith("scip") && layer.status === "failed")) {
      const result = emitScipRestageRequested({
        payload: {
          to_sha: "",
          target_branch: targetBranch,
          reason: `self_repair: ${reason}`,
          source: "drift_reconciliation",
        },
        onError,
      });
      if (result.ok) {
        actions.push({
          layer: "scip",
          event: ATLAS_EVENTS.SCIP_RESTAGE_REQUESTED,
          warmJobId: result.warmJobId,
          coalesced: !!result.coalesced,
        });
      }
    }

    // Embeddings repair: below-parity coverage resumes via budget-sliced warms
    // (keys.db/inflight.json carry the resume state). Only when a view exists —
    // without one the structural main-full warm above rebuilds the view and
    // runs its ride-along embeddings ingest anyway.
    const embeddingsGap = notReady.find(
      (layer) => layer.layer.startsWith("embeddings") && layer.status === "warming",
    );
    if (embeddingsGap && viewExists && !structuralBroken) {
      const result = emitEmbeddingsResume({
        payload: {
          target_branch: targetBranch,
          reason: `self_repair: ${reason}`,
        },
        onError,
      });
      if (result.ok) {
        actions.push({
          layer: embeddingsGap.layer,
          event: ATLAS_EVENTS.EMBEDDINGS_RESUME,
          warmJobId: result.warmJobId,
          coalesced: !!result.coalesced,
        });
      }
    }

    return { ok: true, summary, layers, actions };
  } catch (err) {
    if (typeof onError === "function") onError(/** @type {Error} */ (err));
    return {
      ok: false,
      skipped: "self_repair_error",
      summary: String(/** @type {any} */ (err)?.message || err || "unknown"),
      layers: [],
      actions: [],
    };
  }
}
