// @ts-check
//
// Hybrid retrieval orchestrator. Entry point for the v2 symbol-search
// path: runs FTS + (optionally) vector backends, fuses with RRF, applies
// feedback boost and task-query re-ranking, and returns the fused list
// alongside a per-backend degradation report.
//
// Sync-vs-async: the vector backend is async because the encoder is.
// A caller-provided async planner also makes the orchestrator async, which
// lets the conductor use the warmed native worker without changing direct
// sync callers.
//
// The orchestrator NEVER throws on backend failure — it downgrades.
// A degraded ranking is always preferred to an error envelope.

import { rrfFuse, rrfFuseAsync, RRF_K } from "./rrf.js";
import { runFtsBackend, runFtsBackendAsync } from "./backends/fts.js";
import { runVectorBackend } from "./backends/vector.js";
import { runEntityFtsBackends } from "./backends/entity-fts.js";
import { buildFeedbackIndex, applyFeedbackBoost } from "./feedback-boost.js";
import { applyTaskQueryRanking, applyTaskQueryRankingAsync } from "./task-query-ranking.js";
import { summarizeBackends } from "./fallback.js";
import { fallbackQueryPlan, planQuery, planQueryAsync } from "./query-planner.js";

/** @typedef {import("../../contracts/api.js").View} View */
/** @typedef {import("../../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("./rrf.js").FusedEntry<ViewSymbol>} FusedSymbolEntry */
/** @typedef {import("./fallback.js").DegradationReport} DegradationReport */

/**
 * @typedef {Object} HybridSearchOptions
 * @property {boolean} [semantic]                Try vector backend when context is wired.
 * @property {string} [taskText]                 When set, task-query re-ranking promotes overlap.
 * @property {string} [taskType]                 Scopes feedback boost to a task type.
 * @property {number} [limit]                    Items returned. Default 50.
 * @property {string} [feedbackSinceTs]          Override feedback window. Default 30 days.
 * @property {number} [feedbackHalfLifeDays]     When set, decay feedback signals by exp(-age/halfLife).
 *                                               Unset = equal-weight within the window (v1 default).
 * @property {number} [rrfK]                     Override the RRF k constant. Default 60.
 * @property {string[]} [entities]               Optional extra ledger entity types: "feedback". (Memories moved to the per-repo memory DB; they are not an FTS entity here.)
 * @property {"name" | "body" | "either"} [searchScope]
 * @property {import("./query-planner-types.js").QueryPlan} [plan]
 * @property {(input: string) => import("./query-planner-types.js").QueryPlan | Promise<import("./query-planner-types.js").QueryPlan>} [planner]
 */

/**
 * @typedef {Object} HybridSearchResult
 * @property {FusedSymbolEntry[]} items          Trimmed to `limit`.
 * @property {ViewSymbol[]} symbols              Convenience parallel array: payloads only.
 * @property {number} total                      Total fused entries before trim.
 * @property {boolean} truncated                 True iff total > items.length.
 * @property {DegradationReport} degraded
 * @property {import("./query-planner-types.js").QueryPlan} [plan]
 *   The QueryPlan used to drive probes — surfaced so the agent/UX can
 *   show "we searched for these identifiers / files / keywords", and so
 *   benchmarks can validate planning quality independently of fusion.
 * @property {import("../../contracts/tool-results.js").EntitySearchHit[]} [entities]
 * @property {RetrievalSeparation} [separation]
 */

/**
 * @typedef {Object} RetrievalSeparation
 * @property {"decisive"|"contested"|"flat"} confidence
 * @property {"pre_boost_rrf"} basis
 * @property {number} poolSize
 * @property {number} maxBackendPoolSize
 * @property {Record<string, number>} backendPoolSizes
 * @property {number} topGap
 * @property {number} relativeGap
 * @property {boolean} smallPool
 * @property {{id:string,score:number,contributionCount:number,backends:string[]}[]} top
 */

const DEFAULT_LIMIT = 50;
const MIN_SEPARATION_POOL = 15;

/**
 * Top-level hybrid search. Returns either a result (sync path) or a
 * Promise for one (async path).
 *
 * @param {{
 *   view: View,
 *   query: string,
 *   ledger?: Ledger,
 *   repoId?: string | null,
 *   embeddingIndex?: EmbeddingIndex,
 *   encoder?: EmbeddingEncoder,
 *   options?: HybridSearchOptions,
 *   signal?: AbortSignal,
 * }} args
 * @returns {HybridSearchResult | Promise<HybridSearchResult>}
 */
export function hybridSearch(args) {
  // The QUERY names what the caller wants found; taskText is context. The
  // plan (which generates every FTS probe) must derive from the query — with
  // taskText as plan input, a symbol.search for "RetrievalCache" alongside
  // divergent task prose never issued a single probe containing the queried
  // name (bare identifiers are not literal-name probes). taskText still
  // shapes ranking via the feedback task-text filter, and callers whose
  // query IS the task text (slice.build entry discovery) are unaffected.
  const planInput = args.query || args.options?.taskText || "";
  const wantSemantic =
    !!args.options?.semantic &&
    !!args.embeddingIndex &&
    !!args.encoder &&
    args.encoder.dim === args.embeddingIndex.dim;
  // Native planner failure degrades to the JS fallback plan instead of
  // failing the search — conductor paths already do this via their injected
  // planner; the bare sync/async paths here (direct dispatch, tests) must
  // honor the same downgrade-not-throw contract.
  const planned = args.options?.plan
    || (args.options?.planner
      ? args.options.planner(planInput)
      : (wantSemantic
        ? planQueryAsync(planInput).catch(() => fallbackQueryPlan(planInput))
        : (() => { try { return planQuery(planInput); } catch { return fallbackQueryPlan(planInput); } })()));
  if (planned && typeof /** @type {any} */ (planned).then === "function") {
    return /** @type {Promise<import("./query-planner-types.js").QueryPlan>} */ (planned)
      .then((plan) => hybridSearchWithPlan(args, plan, true));
  }
  return hybridSearchWithPlan(args, /** @type {import("./query-planner-types.js").QueryPlan} */ (planned), false);
}

/**
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @param {import("./query-planner-types.js").QueryPlan} plan
 * @param {boolean} preferAsync
 * @returns {HybridSearchResult | Promise<HybridSearchResult>}
 */
function hybridSearchWithPlan(args, plan, preferAsync = false) {
  const wantSemantic =
    !!args.options?.semantic &&
    !!args.embeddingIndex &&
    !!args.encoder &&
    args.encoder.dim === args.embeddingIndex.dim;
  if (preferAsync || wantSemantic) {
    return hybridSearchAsync(args, plan);
  }
  return hybridSearchSync(args, plan);
}

/**
 * Synchronous path. No vector backend.
 *
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @param {import("./query-planner-types.js").QueryPlan} plan
 * @returns {HybridSearchResult}
 */
function hybridSearchSync(args, plan) {
  const { view, query, ledger, repoId, options } = args;
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const fts = runFtsBackend({ view, query, limit, plan, scope: options?.searchScope });
  /** @type {Record<string, { ok: boolean, total: number, reason?: string }>} */
  const backendStatus = { fts: { ok: fts.ok, total: fts.total, reason: fts.reason } };
  // Vector reason is "unavailable" — we did not run it.
  backendStatus.vector = { ok: false, total: 0, reason: "unavailable" };

  const { fused, separation } = fuseAndAdjust({
    fts,
    vector: null,
    ledger,
    taskType: options?.taskType,
    taskText: options?.taskText,
    feedbackSinceTs: options?.feedbackSinceTs,
    feedbackHalfLifeDays: options?.feedbackHalfLifeDays,
    k: options?.rrfK,
  });
  return assembleHybridResult({ fused, limit, plan, backendStatus, ledger, query, repoId, options, separation });
}

/**
 * Async path. Runs FTS and vector backends in parallel.
 *
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @param {import("./query-planner-types.js").QueryPlan} plan
 * @returns {Promise<HybridSearchResult>}
 */
async function hybridSearchAsync(args, plan) {
  const { view, query, ledger, repoId, embeddingIndex, encoder, options, signal } = args;
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  // Run both backends in parallel. Each backend handles its own errors
  // and returns a degraded result rather than throwing.
  const wantSemantic =
    !!options?.semantic &&
    !!embeddingIndex &&
    !!encoder &&
    encoder.dim === embeddingIndex.dim;
  const [fts, vector] = await Promise.all([
    runFtsBackendAsync({ view, query, limit, plan, scope: options?.searchScope }),
    wantSemantic
      ? runVectorBackend({ view, query, limit, embeddingIndex, encoder, signal })
      : Promise.resolve({ ok: false, entries: [], raw: [], total: 0, reason: "unavailable" }),
  ]);

  /** @type {Record<string, { ok: boolean, total: number, reason?: string }>} */
  const backendStatus = {
    fts: { ok: fts.ok, total: fts.total, reason: fts.reason },
    vector: { ok: vector.ok, total: vector.total, reason: vector.reason },
  };

  const { fused, separation } = await fuseAndAdjustAsync({
    fts,
    vector,
    ledger,
    taskType: options?.taskType,
    taskText: options?.taskText,
    feedbackSinceTs: options?.feedbackSinceTs,
    feedbackHalfLifeDays: options?.feedbackHalfLifeDays,
    k: options?.rrfK,
  });
  return assembleHybridResult({ fused, limit, plan, backendStatus, ledger, query, repoId, options, separation });
}

/**
 * Shared result assembly for the sync/async search paths: trim to the
 * caller's limit, attach entity hits, and summarize backend degradation.
 *
 * @param {{
 *   fused: FusedSymbolEntry[],
 *   limit: number,
 *   plan: import("./query-planner-types.js").QueryPlan,
 *   backendStatus: Record<string, { ok: boolean, total: number, reason?: string }>,
 *   ledger?: Ledger,
 *   query: string,
 *   repoId?: string,
 *   options?: Parameters<typeof hybridSearch>[0]["options"],
 *   separation?: RetrievalSeparation,
 * }} args
 * @returns {HybridSearchResult}
 */
function assembleHybridResult({ fused, limit, plan, backendStatus, ledger, query, repoId, options, separation }) {
  const items = fused.slice(0, limit);
  const entities = runEntityFtsBackends({
    ledger,
    query,
    repoId,
    entities: options?.entities,
    limit,
  });
  return {
    items,
    symbols: items.map((e) => e.payload),
    total: fused.length,
    truncated: fused.length > items.length,
    degraded: summarizeBackends(backendStatus),
    plan,
    ...(separation ? { separation } : {}),
    ...(entities.length > 0 ? { entities } : {}),
  };
}

/**
 * Common async path used when planning or vector retrieval already made the
 * search asynchronous; keeps native helper calls on the warmed daemon.
 *
 * @param {Parameters<typeof fuseAndAdjust>[0]} args
 * @returns {Promise<{fused:FusedSymbolEntry[], separation:RetrievalSeparation}>}
 */
async function fuseAndAdjustAsync({
  fts,
  vector,
  ledger,
  taskType,
  taskText,
  feedbackSinceTs,
  feedbackHalfLifeDays,
  k,
}) {
  const lists = buildFusionLists(fts, vector);
  const fused = await rrfFuseAsync(lists, { k: typeof k === "number" ? k : RRF_K });
  const separation = assessRetrievalSeparation(fused, lists);
  applyFusedFeedbackBoost(fused, { ledger, taskType, taskText, feedbackSinceTs, feedbackHalfLifeDays });
  await applyTaskQueryRankingAsync(fused, taskText);
  return { fused, separation };
}

/**
 * @param {ReturnType<typeof runFtsBackend>} fts
 * @param {Awaited<ReturnType<typeof runVectorBackend>> | null} vector
 * @returns {Record<string, ReturnType<typeof runFtsBackend>["entries"]>}
 */
function buildFusionLists(fts, vector) {
  /** @type {Record<string, ReturnType<typeof runFtsBackend>["entries"]>} */
  const lists = {};
  if (fts.ok && fts.entries.length > 0) lists.fts = fts.entries;
  if (vector && vector.ok && vector.entries.length > 0) lists.vector = vector.entries;
  return lists;
}

/**
 * @param {FusedSymbolEntry[]} fused
 * @param {{ ledger?: Ledger, taskType?: string, taskText?: string, feedbackSinceTs?: string, feedbackHalfLifeDays?: number }} args
 */
function applyFusedFeedbackBoost(fused, { ledger, taskType, taskText, feedbackSinceTs, feedbackHalfLifeDays }) {
  const feedbackIndex = buildFeedbackIndex({
    ledger,
    taskType,
    taskText,
    sinceTs: feedbackSinceTs,
    halfLifeDays: feedbackHalfLifeDays,
  });
  applyFeedbackBoost(fused, feedbackIndex);
}

/**
 * Common path used by both sync and async variants: fuse the available
 * backends, then apply feedback + task-query passes.
 *
 * @param {{
 *   fts: ReturnType<typeof runFtsBackend>,
 *   vector: Awaited<ReturnType<typeof runVectorBackend>> | null,
 *   ledger?: Ledger,
 *   taskType?: string,
 *   taskText?: string,
 *   feedbackSinceTs?: string,
 *   feedbackHalfLifeDays?: number,
 *   k?: number,
 * }} args
 * @returns {{fused:FusedSymbolEntry[], separation:RetrievalSeparation}}
 */
function fuseAndAdjust({
  fts,
  vector,
  ledger,
  taskType,
  taskText,
  feedbackSinceTs,
  feedbackHalfLifeDays,
  k,
}) {
  const lists = buildFusionLists(fts, vector);
  const fused = rrfFuse(lists, { k: typeof k === "number" ? k : RRF_K });
  const separation = assessRetrievalSeparation(fused, lists);
  applyFusedFeedbackBoost(fused, { ledger, taskType, taskText, feedbackSinceTs, feedbackHalfLifeDays });
  applyTaskQueryRanking(fused, taskText);
  return { fused, separation };
}

/**
 * Summarize how separated the raw fused pool was before feedback and task
 * boosts. This deliberately describes the evidence pool; it does not change
 * ranking.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {Record<string, ReturnType<typeof runFtsBackend>["entries"]>} lists
 * @returns {RetrievalSeparation}
 */
export function assessRetrievalSeparation(fused, lists) {
  const backendPoolSizes = Object.fromEntries(
    Object.entries(lists).map(([backend, entries]) => [backend, entries.length]),
  );
  const poolSize = fused.length;
  const maxBackendPoolSize = Math.max(0, ...Object.values(backendPoolSizes));
  const top = fused[0] ?? null;
  const second = fused[1] ?? null;
  const topGap = top ? top.score - (second?.score ?? 0) : 0;
  const relativeGap = top && top.score > 0 ? topGap / top.score : 0;
  const smallPool = maxBackendPoolSize > 0 && maxBackendPoolSize < MIN_SEPARATION_POOL;
  const nearTopCount = top
    ? fused
      .slice(1, 5)
      .filter((entry) => top.score > 0 && ((top.score - entry.score) / top.score) <= 0.05)
      .length
    : 0;
  const topContributionCount = contributionCount(top);
  const secondContributionCount = contributionCount(second);

  /** @type {"decisive"|"contested"|"flat"} */
  let confidence = "flat";
  if (top && poolSize === 1) {
    confidence = smallPool ? "contested" : "decisive";
  } else if (top && topGap > 0) {
    if (nearTopCount >= 2 && relativeGap < 0.08) {
      confidence = "flat";
    } else if (
      relativeGap >= 0.18
      || (relativeGap >= 0.08 && topContributionCount > secondContributionCount)
    ) {
      confidence = "decisive";
    } else {
      confidence = "contested";
    }
  }

  return {
    confidence,
    basis: "pre_boost_rrf",
    poolSize,
    maxBackendPoolSize,
    backendPoolSizes,
    topGap: roundSeparation(topGap),
    relativeGap: roundSeparation(relativeGap),
    smallPool,
    top: fused.slice(0, 5).map((entry) => ({
      id: entry.id,
      score: roundSeparation(entry.score),
      contributionCount: contributionCount(entry),
      backends: Object.keys(entry.contributions ?? {}).sort(),
    })),
  };
}

/**
 * @param {FusedSymbolEntry | null | undefined} entry
 */
function contributionCount(entry) {
  return Object.keys(entry?.contributions ?? {}).length;
}

function roundSeparation(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

export { RRF_K };
