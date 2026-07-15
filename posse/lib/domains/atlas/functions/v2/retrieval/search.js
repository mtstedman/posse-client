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

import { buildSymbolCard, parseSymbolId, symbolHit, symbolIdOf } from "./cards.js";
import { countIncomingCallers } from "./usages.js";
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
 * @returns {Promise<ReturnType<typeof okEnvelope<SymbolSearchData>>>}
 */
export async function symbolSearch({
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
  const overlayHits = await rankOverlaySymbols({
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
        filterDeclarationFiles: /** @type {any} */ (params).filterDeclarationFiles,
        filterToolingPaths: /** @type {any} */ (params).filterToolingPaths,
        genericSymbolFrequencyThreshold: /** @type {any} */ (params).genericSymbolFrequencyThreshold,
        hierarchicalFileLimit: /** @type {any} */ (params).hierarchicalFileLimit,
        planner,
      },
    });
    return await buildEnvelope({
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
  }

  const result = await hybridSearch({
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
      filterDeclarationFiles: /** @type {any} */ (params).filterDeclarationFiles,
      filterToolingPaths: /** @type {any} */ (params).filterToolingPaths,
      genericSymbolFrequencyThreshold: /** @type {any} */ (params).genericSymbolFrequencyThreshold,
      hierarchicalFileLimit: /** @type {any} */ (params).hierarchicalFileLimit,
      planner,
    },
  });
  return await buildEnvelope({
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
 * @param {{ view: View, result: HybridSearchResult, versionId: string, limit: number, query: string, semanticRequested?: boolean, encoder?: EmbeddingEncoder, overlayHits?: Array<Awaited<ReturnType<typeof overlayHit>>>, ledger?: Ledger, repoId?: string | null, embeddingEnsureStatus?: any }} args
 */
async function buildEnvelope({ view, result, versionId, limit, query, semanticRequested = false, encoder, overlayHits = [], ledger, repoId, embeddingEnsureStatus = null }) {
  const durableItems = result.items
    .filter((entry) => isDefaultVisibleSymbol(entry.payload) || isExplicitLiteralSymbolQuery(query, entry.payload))
    .map((entry, index) => {
      const hit = symbolHit(entry.payload);
      hit.score = roundScore(entry.score);
      /** @type {any} */ (hit).relevance = relevanceLabel({ query, entry, rank: index + 1 });
      if (/** @type {any} */ (entry).pathPrior) {
        /** @type {any} */ (hit).ranking = { pathPrior: /** @type {any} */ (entry).pathPrior };
      }
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
    score: result.pathPriors ? "path_prior_adjusted_rrf" : "raw_rrf",
    rrfK: RRF_K,
    relevance: "exact|strong|weak",
  };
  if (result.pathPriors) meta.pathPriors = result.pathPriors;
  if (result.separation) meta.separation = result.separation;
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
  // Feature B (default ON; disable with POSSE_ATLAS_DISAMBIG=0 for A/B control).
  // B1: warn when a result NAME is defined in more than one file. Same-named
  // functions across subsystems (e.g. a live vs. offline-batch implementation)
  // let an agent confidently trace the wrong one; surface the collision so it
  // verifies reachability before tracing. B2: annotate the top hits with an
  // incoming caller count so "which of these collides is actually reachable?"
  // is answerable without a follow-up symbol.overview (callerCount===0 is itself
  // a "no callers found" signal). Both are pure/defensive and never throw. The
  // flag gates the whole feature so an experiment can compare with it off.
  if (process.env.POSSE_ATLAS_DISAMBIG !== "0") {
    const disambiguation = detectNameCollisions(visibleItems);
    if (disambiguation.length > 0) meta.disambiguation = disambiguation;
    await annotateReachability({ view, hits: visibleItems, limit: 5 });
    annotateLiveness({ hits: visibleItems, limit: 5 });
    const trust = buildRetrievalTrustCaution({ disambiguation, separation: result.separation });
    if (trust) {
      meta.trust = trust;
      meta.warnings = [
        ...(Array.isArray(meta.warnings) ? meta.warnings : []),
        trust.message,
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
 * Group result hits by NAME and flag any name defined in more than one distinct
 * file path. Pure and defensive — returns [] on any error and never throws.
 *
 * @param {import("../contracts/tool-results.js").SymbolHit[]} hits
 * @param {{ cap?: number }} [opts]
 * @returns {Array<{ name: string, definedIn: string[], note: string }>}
 */
export function detectNameCollisions(hits, { cap = 8 } = {}) {
  try {
    /** @type {Map<string, Set<string>>} */
    const byName = new Map();
    for (const hit of Array.isArray(hits) ? hits : []) {
      const name = hit && typeof hit.name === "string" ? hit.name : null;
      const rawPath = hit?.location?.repo_rel_path;
      if (!name || !rawPath) continue;
      const path = String(rawPath).replace(/\\/g, "/");
      let paths = byName.get(name);
      if (!paths) { paths = new Set(); byName.set(name, paths); }
      paths.add(path);
    }
    /** @type {Array<{ name: string, definedIn: string[], note: string }>} */
    const out = [];
    for (const [name, paths] of byName) {
      if (paths.size <= 1) continue;
      out.push({
        name,
        definedIn: [...paths],
        note: `same name defined in ${paths.size} files; verify which is on the live/reachable path before tracing`,
      });
      if (out.length >= cap) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {{ disambiguation?: Array<{ name: string, definedIn: string[] }>, separation?: { confidence?: string } | null }} [args]
 * @returns {{ verifyBeforeCommitting: true, reason: string, message: string, confidence: string, collisionNames: string[] } | null}
 */
export function buildRetrievalTrustCaution({ disambiguation = [], separation = null } = {}) {
  const confidence = separation?.confidence || "";
  if (!Array.isArray(disambiguation) || disambiguation.length === 0) return null;
  if (confidence !== "contested" && confidence !== "flat") return null;
  return {
    verifyBeforeCommitting: true,
    reason: "name_collision_low_separation",
    message: "same-named symbols found and retrieval separation is not decisive; verify the reachable/live target before editing",
    confidence,
    collisionNames: disambiguation.slice(0, 5).map((entry) => entry.name),
  };
}

/**
 * Annotate up to `limit` hits in place with `{ reachability: { callerCount,
 * callerPathsSample } }` computed from the view's caller edges. Best-effort:
 * skips the whole feature if the view/edges aren't available and never throws.
 *
 * @param {{ view: View, hits: import("../contracts/tool-results.js").SymbolHit[], limit?: number }} args
 */
async function annotateReachability({ view, hits, limit = 5 }) {
  try {
    if (!view?.query || typeof view.query.getByContentLocal !== "function") return;
    if (!Array.isArray(hits)) return;
    for (const hit of hits.slice(0, limit)) {
      try {
        const parsed = parseSymbolId(hit?.symbolId);
        if (!parsed) continue;
        const target = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
        if (!target || target.global_id == null) continue;
        const raw = await countIncomingCallers(view, target, { sampleLimit: 0, distinctPaths: false });
        const distinct = await countIncomingCallers(view, target, { sampleLimit: 3, distinctPaths: true });
        /** @type {any} */ (hit).reachability = {
          callerCount: distinct.callerCount,
          callerFileCount: distinct.callerCount,
          rawCallerEdgeCount: raw.callerCount,
          callerPathsSample: distinct.callerPathsSample,
        };
      } catch {
        // Per-hit failure must not strand the rest of the annotation pass.
      }
    }
  } catch {
    // Reachability is optional; a view without queryable edges just skips it.
  }
}

/**
 * Annotate likely live/stale status without filtering or ranking. This is a
 * hint only; caller reachability beats path-name heuristics.
 *
 * @param {{ hits: import("../contracts/tool-results.js").SymbolHit[], limit?: number }} args
 */
function annotateLiveness({ hits, limit = 5 }) {
  try {
    if (!Array.isArray(hits)) return;
    for (const hit of hits.slice(0, limit)) {
      const path = String(hit?.location?.repo_rel_path || "").replace(/\\/g, "/");
      const reachability = /** @type {any} */ (hit).reachability;
      const callerCount = Number(reachability?.callerCount || 0);
      const markers = [];
      if (callerCount > 0) markers.push("incoming-callers");
      if (looksStaleOrOffline(path)) markers.push("stale-or-offline-path");
      const status = callerCount > 0
        ? "possibly_live"
        : (markers.includes("stale-or-offline-path") ? "possibly_stale_or_offline" : "unknown");
      /** @type {any} */ (hit).liveness = {
        status,
        markers,
        note: status === "possibly_live"
          ? "incoming callers were found for this symbol"
          : "metadata-only hint; verify with callers/usages before editing",
      };
    }
  } catch {
    // Liveness is advisory metadata only.
  }
}

/**
 * @param {string} path
 */
function looksStaleOrOffline(path) {
  const normalized = String(path || "").toLowerCase();
  if (!normalized) return false;
  return /(^|[/_.-])(offline|archive|archived|backup|bak|legacy|deprecated|dead)([/_.-]|$)/.test(normalized)
    || /(^|[/_.-])old([/_.-]|$)/.test(normalized);
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
  queueMicrotask(async () => {
    try {
      await prefetchTopCards(job);
    } catch {
      // Predictive warming must never affect retrieval.
    }
  });
  return out;
}

/**
 * @param {{ view: View, result: HybridSearchResult, versionId: string, ledger?: Ledger, repoId?: string | null }} args
 */
async function prefetchTopCards({ view, result, versionId, ledger, repoId }) {
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
        const card = await buildSymbolCard({
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
    if (text !== "symbols" && text !== "feedback") continue;
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
async function rankOverlaySymbols({ repoRoot, sessionId, query, limit }) {
  if (!repoRoot) return [];
  // Resolve every overlay score first (the native scorer is async and the
  // worker is serial), then filter/sort — never await inside a comparator.
  const hits = [];
  for (const { entry, symbol } of await getOverlaySymbols({ repoRoot, sessionId })) {
    hits.push(await overlayHit({ entry, symbol, query }));
  }
  return hits
    .filter((hit) => (hit.score || 0) > 0.1)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * @param {{ entry: import("./buffer.js").OverlayEntry, symbol: import("../contracts/api.js").ViewSymbol, query: string }} args
 */
async function overlayHit({ entry, symbol, query }) {
  const hit = symbolHit(symbol);
  // Native scorer unavailable must not fail the search (this runs BEFORE the
  // durable hybridSearch); the floor score keeps the overlay symbol visible
  // with neutral ranking until the binary is back.
  let score = 0.1;
  try {
    score = Math.min(1, Math.max(0.1, await lexicalScore(query, symbol)));
  } catch { /* degrade to the floor score */ }
  hit.score = score;
  /** @type {any} */ (hit).overlay = true;
  /** @type {any} */ (hit).source = "buffer";
  /** @type {any} */ (hit).buffer = {
    filePath: entry.filePath,
    sessionId: entry.sessionId,
    version: entry.version,
  };
  return hit;
}
