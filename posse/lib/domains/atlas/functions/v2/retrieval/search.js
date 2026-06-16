// @ts-check
//
// symbol.search handler. Delegates ranking to the hybrid retrieval
// orchestrator, which runs FTS + (optionally) vector backends, fuses
// the rankings with RRF, applies the feedback boost from the ledger,
// and re-ranks by task-query overlap when provided.
//
// Sync vs async: the orchestrator runs synchronously when no vector
// backend is available (the common case in tests and the default
// production config until Workstream H stabilizes). It returns a
// Promise only when a usable encoder + index pair is wired and the
// caller asked for semantic=true.

import { buildSymbolCard, symbolHit, symbolIdOf } from "./cards.js";
import { okEnvelope } from "./envelope.js";
import { hybridSearch } from "./orchestrator/index.js";
import { RRF_K } from "./orchestrator/rrf.js";
import { getOverlaySymbols } from "./buffer.js";
import { lexicalScore } from "./rank.js";
import { getEffectivePolicy } from "./policy.js";
import { recordPrefetchPrediction } from "./prefetch.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { isDefaultVisibleSymbol, isExplicitLiteralSymbolQuery, visibleSymbolDedupeKey } from "./hygiene.js";
import { ensureEmbeddingsForView } from "../embeddings/on-demand.js";
import { logAtlasError } from "../verbose-errors.js";

// Module-level dedup so a misconfigured pair (e.g. encoder dim 384,
// index dim 128) doesn't flood the worker log on every search. Keyed
// by the (encoder, index) dim pair so an operator that fixes one and
// leaves another broken still gets warned about the second.
/** @type {Set<string>} */
const _DIM_MISMATCH_WARNED = new Set();
function warnOnceDimMismatch(encoder, index) {
  const key = `${encoder?.model ?? "?"}|enc=${encoder?.dim}|idx=${index?.dim}`;
  if (_DIM_MISMATCH_WARNED.has(key)) return;
  _DIM_MISMATCH_WARNED.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[atlas-v2] symbol.search semantic=true requested but encoder.dim (${encoder?.dim}) ` +
    `!== embeddingIndex.dim (${index?.dim}); falling back to FTS. ` +
    `Either rebuild the index with the encoder's dim or swap encoders.`,
  );
}

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/tool-params.js").SymbolSearchParams} SymbolSearchParams */
/** @typedef {import("../contracts/tool-params.js").TaskType} TaskType */
/** @typedef {import("../contracts/tool-results.js").SymbolSearchData} SymbolSearchData */
/** @typedef {import("./orchestrator/index.js").HybridSearchResult} HybridSearchResult */
/** @typedef {import("./orchestrator/query-planner-types.js").QueryPlan} QueryPlan */

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SymbolSearchParams,
 *   ledger?: Ledger,
 *   embeddingIndex?: EmbeddingIndex,
 *   encoder?: EmbeddingEncoder,
 *   taskText?: string,
 *   taskType?: TaskType,
 *   feedbackHalfLifeDays?: number,
 *   repoId?: string | null,
 *   repoRoot?: string,
 *   planner?: (input: string) => QueryPlan | Promise<QueryPlan>,
 * }} args
 * @returns {ReturnType<typeof okEnvelope<SymbolSearchData>> | Promise<ReturnType<typeof okEnvelope<SymbolSearchData>>>}
 */
export function symbolSearch({
  view,
  versionId,
  params,
  ledger,
  embeddingIndex,
  encoder,
  taskText,
  taskType,
  feedbackHalfLifeDays,
  repoId,
  repoRoot,
  planner,
  onDemandEmbeddingFill = true,
}) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 50;
  const overlayHits = rankOverlaySymbols({
    repoRoot,
    sessionId: /** @type {any} */ (params).sessionId,
    query: params.query,
    limit,
  });

  // Detect a usable semantic pair so we can warn once on dim mismatch.
  // The orchestrator handles the actual fallback; this is observability.
  if (params.semantic && embeddingIndex && encoder && encoder.dim !== embeddingIndex.dim) {
    warnOnceDimMismatch(encoder, embeddingIndex);
  }

  if (params.semantic && embeddingIndex && encoder && encoder.dim === embeddingIndex.dim) {
    return (async () => {
      let embeddingEnsureStatus = null;
      if (!onDemandEmbeddingFill) {
        // Caller opted out of the bulk fill (e.g. the in-process retrieval
        // fallback protecting the main loop): search whatever is already
        // indexed instead of encoding the gap first.
        embeddingEnsureStatus = { skipped: true, reason: "on_demand_fill_disabled" };
      } else {
        try {
          embeddingEnsureStatus = await ensureEmbeddingsForView({
            view,
            index: embeddingIndex,
            encoder,
            repoRoot,
            limit: 5000,
            timeoutMs: 15000,
          });
        } catch (err) {
          embeddingEnsureStatus = {
            skipped: false,
            incomplete: true,
            reason: String(err?.code || err?.message || err || "encode_error"),
          };
          logAtlasError("[symbolSearch.ensureEmbeddingsForView] threw:", err);
        }
      }
      const ensuredResult = await hybridSearch({
        view,
        query: params.query,
        ledger,
        repoId,
        embeddingIndex,
        encoder,
        options: {
          semantic: true,
          taskText,
          taskType,
          limit,
          feedbackHalfLifeDays,
          entities: normalizeEntities(/** @type {any} */ (params).entities),
          searchScope: normalizeSearchScope(/** @type {any} */ (params).scope),
          planner,
        },
      });
      return buildEnvelope({
        view,
        result: ensuredResult,
        versionId,
        limit,
        query: params.query,
        semanticRequested: true,
        encoder,
        overlayHits,
        ledger,
        repoId,
        embeddingEnsureStatus,
      });
    })();
  }

  const result = hybridSearch({
    view,
    query: params.query,
    ledger,
    repoId,
    embeddingIndex,
    encoder,
    options: {
      semantic: !!params.semantic,
      taskText,
      taskType,
      limit,
      feedbackHalfLifeDays,
      entities: normalizeEntities(/** @type {any} */ (params).entities),
      searchScope: normalizeSearchScope(/** @type {any} */ (params).scope),
      planner,
    },
  });
  if (result && typeof (/** @type {any} */ (result)).then === "function") {
    return /** @type {Promise<HybridSearchResult>} */ (result).then((r) =>
      buildEnvelope({ view, result: r, versionId, limit, query: params.query, semanticRequested: !!params.semantic, encoder, overlayHits, ledger, repoId, embeddingEnsureStatus: null }),
    );
  }
  return buildEnvelope({
    view,
    result: /** @type {HybridSearchResult} */ (result),
    versionId,
    limit,
    query: params.query,
    semanticRequested: !!params.semantic,
    encoder,
    overlayHits,
    ledger,
    repoId,
    embeddingEnsureStatus: null,
  });
}

/**
 * @param {{ view: View, result: HybridSearchResult, versionId: string, limit: number, query: string, semanticRequested?: boolean, encoder?: EmbeddingEncoder, overlayHits?: Array<ReturnType<typeof overlayHit>>, ledger?: Ledger, repoId?: string | null, embeddingEnsureStatus?: any }} args
 */
function buildEnvelope({ view, result, versionId, limit, query, semanticRequested = false, encoder, overlayHits = [], ledger, repoId, embeddingEnsureStatus = null }) {
  const durableItems = result.items
    .filter((entry) => isDefaultVisibleSymbol(entry.payload) || isExplicitLiteralSymbolQuery(query, entry.payload))
    .map((entry, index) => {
      const hit = symbolHit(entry.payload);
      hit.score = roundScore(entry.score);
      /** @type {any} */ (hit).relevance = relevanceLabel({ query, entry, rank: index + 1 });
      return hit;
    });
  const seen = new Set(overlayHits.map((hit) => hit.symbolId));
  const items = [
    ...dedupeHits(overlayHits),
    ...durableItems.filter((hit) => !seen.has(hit.symbolId)),
  ];
  const visibleItems = dedupeHits(items)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
  /** @type {SymbolSearchData} */
  const data = {
    items: visibleItems,
    total: result.total + overlayHits.length,
    truncated: result.truncated || (result.total + overlayHits.length > visibleItems.length),
    ...(Array.isArray(result.entities) && result.entities.length > 0 ? { entities: result.entities } : {}),
  };
  const vector = result.degraded.backends?.vector;
  /** @type {any} */
  const meta = { backendHealth: result.degraded };
  meta.scoreScheme = {
    score: "raw_rrf",
    rrfK: RRF_K,
    relevance: "exact|strong|weak",
  };
  meta.prefetch = schedulePrefetchTopCards({ view, result, versionId, ledger, repoId });
  if (result.plan) {
    meta.queryPlan = {
      identifiers: result.plan.identifiers || [],
      paths: result.plan.paths || [],
      fileNames: result.plan.fileNames || [],
      languageHints: result.plan.languageHints || [],
      symptom: result.plan.symptom || null,
      keywords: result.plan.keywords || [],
      identifierLike: !!result.plan.identifierLike,
      stackFrames: result.plan.stackFrames || [],
    };
  }
  if (semanticRequested) {
    const ensureIncomplete = !!embeddingEnsureStatus?.incomplete;
    const ensureReason = ensureIncomplete ? (embeddingEnsureStatus.reason || "encoding_incomplete") : null;
    meta.semantic = {
      requested: true,
      available: !!vector?.ok,
      provider: encoder?.model || null,
      degradedReason: vector?.ok ? ensureReason : (vector?.reason || ensureReason || "unavailable"),
      encoding: embeddingEnsureStatus ? {
        skipped: !!embeddingEnsureStatus.skipped,
        incomplete: ensureIncomplete,
        reason: embeddingEnsureStatus.reason || null,
        missing: embeddingEnsureStatus.missing == null || !Number.isFinite(Number(embeddingEnsureStatus.missing))
          ? null
          : Number(embeddingEnsureStatus.missing),
        encoded: embeddingEnsureStatus.encoded == null || !Number.isFinite(Number(embeddingEnsureStatus.encoded))
          ? null
          : Number(embeddingEnsureStatus.encoded),
      } : null,
    };
    if (!vector?.ok) {
      meta.warnings = [
        ...(Array.isArray(meta.warnings) ? meta.warnings : []),
        `semantic search unavailable; fell back to lexical ranking (${vector?.reason || "unavailable"})`,
      ];
    } else if (ensureIncomplete) {
      meta.warnings = [
        ...(Array.isArray(meta.warnings) ? meta.warnings : []),
        `semantic index encoding incomplete; ranking may be degraded (${ensureReason})`,
      ];
    }
  }
  return okEnvelope({
    action: "symbol.search",
    versionId,
    data,
    meta,
  });
}

/**
 * @param {{ query: string, entry: import("./orchestrator/rrf.js").FusedEntry<import("../contracts/api.js").ViewSymbol>, rank: number }} args
 * @returns {"exact" | "strong" | "weak"}
 */
function relevanceLabel({ query, entry, rank }) {
  const symbol = entry.payload;
  const q = String(query || "").trim().toLowerCase();
  const name = String(symbol.name || "").trim().toLowerCase();
  const qualified = String(symbol.qualified_name || "").trim().toLowerCase();
  if (q && (q === name || q === qualified)) return "exact";
  if (q && (name.startsWith(q) || qualified.includes(q))) return "strong";
  if (Object.keys(entry.contributions || {}).length > 1) return "strong";
  if (rank <= 3) return "strong";
  return "weak";
}

/**
 * @param {number} value
 */
function roundScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * @param {unknown} value
 * @returns {"name" | "body" | "either"}
 */
function normalizeSearchScope(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "name" || text === "body" || text === "either" ? text : "either";
}

/**
 * @param {import("../contracts/tool-results.js").SymbolHit[]} hits
 */
function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    const key = visibleSymbolDedupeKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * Warm compact cards for the most likely follow-up calls after symbol.search.
 *
 * @param {{ view: View, result: HybridSearchResult, versionId: string, ledger?: Ledger, repoId?: string | null }} args
 */
function schedulePrefetchTopCards(args) {
  const targets = args.result.items.slice(0, 5);
  const variantsPerTarget = 2;
  const out = {
    strategy: "top-search-cards",
    scheduled: targets.length > 0,
    targets: targets.length,
    variantsPerTarget,
    planned: targets.length * variantsPerTarget,
  };
  if (targets.length === 0) return out;
  const job = {
    ...args,
    result: {
      ...args.result,
      items: targets,
    },
  };
  queueMicrotask(() => {
    try {
      prefetchTopCards(job);
    } catch {
      // Predictive warming must never affect retrieval.
    }
  });
  return out;
}

/**
 * @param {{ view: View, result: HybridSearchResult, versionId: string, ledger?: Ledger, repoId?: string | null }} args
 */
function prefetchTopCards({ view, result, versionId, ledger, repoId }) {
  const effectiveRepoId = effectiveRepo(repoId);
  const minCallConfidence = getEffectivePolicy(ledger, effectiveRepoId).defaultMinCallConfidence;
  const cache = getRetrievalCache();
  const out = {
    strategy: "top-search-cards",
    attempted: 0,
    warmed: 0,
    skipped: 0,
    errors: 0,
  };
  for (const entry of result.items.slice(0, 5)) {
    const symbol = entry.payload;
    const symbolId = symbolIdOf(symbol);
    for (const includeResolutionMetadata of [false, true]) {
      const cacheKey = cache.cardKey({
        versionId,
        repoId: effectiveRepoId,
        symbolId,
        detail: "compact",
        minCallConfidence,
        includeResolutionMetadata,
      });
      out.attempted += 1;
      if (cache.peekCard(cacheKey)) {
        out.skipped += 1;
        continue;
      }
      try {
        const started = Date.now();
        const card = buildSymbolCard({
          symbol,
          view,
          detail: "compact",
          minCallConfidence,
          includeResolutionMetadata,
        });
        cache.setCard(cacheKey, card);
        recordPrefetchPrediction({
          kind: "card",
          key: cacheKey,
          source: "symbol.search",
          target: symbolId,
          latencyEstimateMs: Math.max(1, Date.now() - started),
        });
        out.warmed += 1;
      } catch {
        out.errors += 1;
      }
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeEntities(value) {
  const raw = Array.isArray(value) ? value : ["symbols"];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const text = String(entry || "").trim();
    if (!text || seen.has(text)) continue;
    if (text !== "symbols" && text !== "memories" && text !== "feedback") continue;
    seen.add(text);
    out.push(text);
  }
  return out.length > 0 ? out : ["symbols"];
}

/**
 * @param {string | null | undefined} repoId
 */
function effectiveRepo(repoId) {
  const text = String(repoId || "default").trim();
  return text || "default";
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, query: string, limit: number }} args
 */
function rankOverlaySymbols({ repoRoot, sessionId, query, limit }) {
  if (!repoRoot) return [];
  return getOverlaySymbols({ repoRoot, sessionId })
    .map(({ entry, symbol }) => overlayHit({ entry, symbol, query }))
    .filter((hit) => (hit.score || 0) > 0.1)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * @param {{ entry: import("./buffer.js").OverlayEntry, symbol: import("../contracts/api.js").ViewSymbol, query: string }} args
 */
function overlayHit({ entry, symbol, query }) {
  const hit = symbolHit(symbol);
  hit.score = Math.min(1, Math.max(0.1, lexicalScore(query, symbol)));
  /** @type {any} */ (hit).overlay = true;
  /** @type {any} */ (hit).source = "buffer";
  /** @type {any} */ (hit).buffer = {
    filePath: entry.filePath,
    sessionId: entry.sessionId,
    version: entry.version,
  };
  return hit;
}
