// @ts-check
//
// Hybrid retrieval orchestrator. Entry point for the v2 symbol-search
// path: runs FTS + (optionally) vector backends, fuses with RRF, applies
// feedback boost and task-query re-ranking, and returns the fused list
// alongside a per-backend degradation report.
//
// Sync-vs-async: the vector backend is async because the encoder is.
// When the caller did not pass an encoder + index, the orchestrator
// runs synchronously and returns immediately. The dispatcher uses this
// to keep symbol.search synchronous in the default config.
//
// The orchestrator NEVER throws on backend failure — it downgrades.
// A degraded ranking is always preferred to an error envelope.

import { rrfFuse, RRF_K } from "./rrf.js";
import { runFtsBackend } from "./backends/fts.js";
import { runVectorBackend } from "./backends/vector.js";
import { runEntityFtsBackends } from "./backends/entity-fts.js";
import { buildFeedbackIndex, applyFeedbackBoost } from "./feedback-boost.js";
import { applyTaskQueryRanking } from "./task-query-ranking.js";
import { summarizeBackends } from "./fallback.js";
import { planQuery } from "./query-planner.js";

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
 * @property {string[]} [entities]               Optional extra ledger entity types: "memories", "feedback".
 * @property {"name" | "body" | "either"} [searchScope]
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
 */

const DEFAULT_LIMIT = 50;

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
  const wantSemantic =
    !!args.options?.semantic &&
    !!args.embeddingIndex &&
    !!args.encoder &&
    args.encoder.dim === args.embeddingIndex.dim;
  if (wantSemantic) {
    return hybridSearchAsync(args);
  }
  return hybridSearchSync(args);
}

/**
 * Synchronous path. No vector backend.
 *
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @returns {HybridSearchResult}
 */
function hybridSearchSync(args) {
  const { view, query, ledger, repoId, options } = args;
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  // Build the plan once. The FTS backend drives probes off it; the
  // task-query ranking pass falls back to the plan when taskText is
  // missing so the fused order reflects identifier/keyword overlap
  // instead of the noisy whole-string tokenization.
  const plan = planQuery(options?.taskText || query);
  const fts = runFtsBackend({ view, query, limit, plan, scope: options?.searchScope });
  /** @type {Record<string, { ok: boolean, total: number, reason?: string }>} */
  const backendStatus = { fts: { ok: fts.ok, total: fts.total, reason: fts.reason } };
  // Vector reason is "unavailable" — we did not run it.
  backendStatus.vector = { ok: false, total: 0, reason: "unavailable" };

  const fused = fuseAndAdjust({
    fts,
    vector: null,
    ledger,
    taskType: options?.taskType,
    taskText: options?.taskText,
    feedbackSinceTs: options?.feedbackSinceTs,
    feedbackHalfLifeDays: options?.feedbackHalfLifeDays,
    k: options?.rrfK,
  });
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
    ...(entities.length > 0 ? { entities } : {}),
  };
}

/**
 * Async path. Runs FTS and vector backends in parallel.
 *
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @returns {Promise<HybridSearchResult>}
 */
async function hybridSearchAsync(args) {
  const { view, query, ledger, repoId, embeddingIndex, encoder, options, signal } = args;
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const plan = planQuery(options?.taskText || query);

  // Run both backends in parallel. Each backend handles its own errors
  // and returns a degraded result rather than throwing.
  const [fts, vector] = await Promise.all([
    Promise.resolve(runFtsBackend({ view, query, limit, plan, scope: options?.searchScope })),
    runVectorBackend({ view, query, limit, embeddingIndex, encoder, signal }),
  ]);

  /** @type {Record<string, { ok: boolean, total: number, reason?: string }>} */
  const backendStatus = {
    fts: { ok: fts.ok, total: fts.total, reason: fts.reason },
    vector: { ok: vector.ok, total: vector.total, reason: vector.reason },
  };

  const fused = fuseAndAdjust({
    fts,
    vector,
    ledger,
    taskType: options?.taskType,
    taskText: options?.taskText,
    feedbackSinceTs: options?.feedbackSinceTs,
    feedbackHalfLifeDays: options?.feedbackHalfLifeDays,
    k: options?.rrfK,
  });
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
    ...(entities.length > 0 ? { entities } : {}),
  };
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
 * @returns {FusedSymbolEntry[]}
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
  /** @type {Record<string, ReturnType<typeof runFtsBackend>["entries"]>} */
  const lists = {};
  if (fts.ok && fts.entries.length > 0) lists.fts = fts.entries;
  if (vector && vector.ok && vector.entries.length > 0) lists.vector = vector.entries;
  const fused = rrfFuse(lists, { k: typeof k === "number" ? k : RRF_K });

  const feedbackIndex = buildFeedbackIndex({
    ledger,
    taskType,
    taskText,
    sinceTs: feedbackSinceTs,
    halfLifeDays: feedbackHalfLifeDays,
  });
  applyFeedbackBoost(fused, feedbackIndex);
  applyTaskQueryRanking(fused, taskText);
  return fused;
}

export { RRF_K };
