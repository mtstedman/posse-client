// @ts-check
//
// Hybrid retrieval orchestrator. Entry point for the v2 symbol-search
// path: runs FTS + (optionally) vector backends, fuses with RRF, applies
// feedback boost and task-query re-ranking, and returns the fused list
// alongside a per-backend degradation report.
//
// Single async path: every backend, the planner, RRF fusion, tokenization,
// and task-query ranking route through the warmed native worker, so the
// orchestrator is always async. A caller-provided planner may be sync or
// async — it is always awaited.
//
// The orchestrator NEVER throws on backend failure — it downgrades.
// A degraded ranking is always preferred to an error envelope.

import { rrfFuse, RRF_K } from "./rrf.js";
import { runFtsBackend } from "./backends/fts.js";
import { runVectorBackend } from "./backends/vector.js";
import { runGraphBackend } from "./backends/graph.js";
import { runEntityFtsBackends } from "./backends/entity-fts.js";
import { buildFeedbackIndex, applyFeedbackBoost } from "./feedback-boost.js";
import { applyTaskQueryRanking } from "./task-query-ranking.js";
import { summarizeBackends } from "./fallback.js";
import { fallbackQueryPlan, planQuery } from "./query-planner.js";
import { applyPathQualityPriors, pathQualityPriorsEnabled } from "../path-priors.js";
import { applyWithinFileSymbolReranking } from "./within-file-ranking.js";
import { combineVectorResults, normalizedSemanticQuery } from "./semantic-query.js";

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
 * @property {boolean} [filterDeclarationFiles] Apply declaration-file path priors.
 * @property {boolean} [filterToolingPaths] Apply tooling/test/generated/legacy path priors.
 * @property {number} [genericSymbolFrequencyThreshold] Penalize names repeated across this many files.
 * @property {number} [hierarchicalFileLimit] Admit and interleave this many non-exact files.
 * @property {boolean} [withinFileSymbolRerank] Reorder symbols only within slots belonging to the same file.
 * @property {number} [fileLexicalOverlapWeight] Native lexical file-score weight, 0..1.
 * @property {boolean} [monorepoPackagePriors] Apply generic monorepo package/path agreement priors.
 * @property {boolean} [semanticQueryNormalization] Add a normalized semantic vector probe.
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
 * @property {ReturnType<typeof applyPathQualityPriors>["summary"]} [pathPriors]
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
 * Top-level hybrid search. Always async: it awaits the planner, backends,
 * fusion, and ranking, all of which route through the warmed native worker.
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
 * @returns {Promise<HybridSearchResult>}
 */
export async function hybridSearch(args) {
  // The QUERY names what the caller wants found; taskText is context. The
  // plan (which generates every FTS probe) must derive from the query — with
  // taskText as plan input, a symbol.search for "RetrievalCache" alongside
  // divergent task prose never issued a single probe containing the queried
  // name (bare identifiers are not literal-name probes). taskText still
  // shapes ranking via the feedback task-text filter, and callers whose
  // query IS the task text (slice.build entry discovery) are unaffected.
  const planInput = args.query || args.options?.taskText || "";
  let plan;
  if (args.options?.plan) {
    plan = args.options.plan;
  } else if (args.options?.planner) {
    // Injected planner (conductor read lane) owns its own downgrade contract;
    // it may be sync or async, so always await it.
    plan = await args.options.planner(planInput);
  } else {
    // Native planner failure degrades to the JS fallback plan instead of
    // failing the search — honor the downgrade-not-throw contract.
    try {
      plan = await planQuery(planInput);
    } catch {
      plan = fallbackQueryPlan(planInput);
    }
  }
  return hybridSearchWithPlan(args, plan);
}

/**
 * Run the backends against the resolved plan, fuse, and assemble. Each
 * backend handles its own errors and returns a degraded result rather than
 * throwing.
 *
 * @param {Parameters<typeof hybridSearch>[0]} args
 * @param {import("./query-planner-types.js").QueryPlan} plan
 * @returns {Promise<HybridSearchResult>}
 */
async function hybridSearchWithPlan(args, plan) {
  const { view, query, ledger, repoId, embeddingIndex, encoder, options, signal } = args;
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  const wantSemantic =
    !!options?.semantic &&
    !!embeddingIndex &&
    !!encoder &&
    encoder.dim === embeddingIndex.dim;
  const normalizedVectorQuery = wantSemantic && options?.semanticQueryNormalization === true
    ? await normalizedSemanticQuery(query)
    : null;
  // Bounded fan-out onto the serial native worker; each backend
  // keeps its own native calls sequential internally.
  const [fts, rawVector, normalizedVector, graph] = await Promise.all([
    runFtsBackend({ view, query, limit, plan, scope: options?.searchScope }),
    wantSemantic
      ? runVectorBackend({ view, query, limit, embeddingIndex, encoder, signal })
      : Promise.resolve({ ok: false, entries: [], raw: [], total: 0, reason: "unavailable" }),
    wantSemantic && normalizedVectorQuery
      ? runVectorBackend({ view, query: normalizedVectorQuery, limit, embeddingIndex, encoder, signal })
      : Promise.resolve(null),
    runGraphBackend({ view, limit, plan }),
  ]);
  const vector = combineVectorResults(rawVector, normalizedVector);

  /** @type {Record<string, { ok: boolean, total: number, reason?: string }>} */
  const backendStatus = {
    fts: { ok: fts.ok, total: fts.total, reason: fts.reason },
    vector: { ok: vector.ok, total: vector.total, reason: vector.reason },
    graph: { ok: graph.ok, total: graph.total, reason: graph.reason },
  };

  const { fused, separation, rawScoreById } = await fuseAndAdjust({
    fts,
    vector,
    graph,
    ledger,
    taskType: options?.taskType,
    taskText: options?.taskText,
    feedbackSinceTs: options?.feedbackSinceTs,
    feedbackHalfLifeDays: options?.feedbackHalfLifeDays,
    k: options?.rrfK,
  });
  const symbolRanked = options?.withinFileSymbolRerank === true
    ? await applyWithinFileSymbolReranking(fused, options?.taskText || query)
    : fused;
  const pathPriorResult = pathQualityPriorsEnabled(options)
    ? applyPathQualityPriors(symbolRanked, { query, plan, options, rawScoreById })
    : null;
  return assembleHybridResult({
    fused: pathPriorResult?.entries || symbolRanked,
    limit,
    plan,
    backendStatus,
    ledger,
    query,
    repoId,
    options,
    separation,
    pathPriors: pathPriorResult?.summary,
    fusedTotal: fused.length,
  });
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
 *   pathPriors?: ReturnType<typeof applyPathQualityPriors>["summary"],
 *   fusedTotal?: number,
 * }} args
 * @returns {HybridSearchResult}
 */
function assembleHybridResult({ fused, limit, plan, backendStatus, ledger, query, repoId, options, separation, pathPriors, fusedTotal = fused.length }) {
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
    total: fusedTotal,
    truncated: fusedTotal > items.length,
    degraded: summarizeBackends(backendStatus),
    plan,
    ...(separation ? { separation } : {}),
    ...(pathPriors ? { pathPriors } : {}),
    ...(entities.length > 0 ? { entities } : {}),
  };
}

/**
 * Fuse the available backends with RRF, then apply feedback + task-query
 * passes. All native helper calls (fusion, tokenization) route through the
 * warmed daemon.
 *
 * @param {{
 *   fts: Awaited<ReturnType<typeof runFtsBackend>>,
 *   vector: Awaited<ReturnType<typeof runVectorBackend>> | null,
 *   graph?: Awaited<ReturnType<typeof runGraphBackend>> | null,
 *   ledger?: Ledger,
 *   taskType?: string,
 *   taskText?: string,
 *   feedbackSinceTs?: string,
 *   feedbackHalfLifeDays?: number,
 *   k?: number,
 * }} args
 * @returns {Promise<{fused:FusedSymbolEntry[], separation:RetrievalSeparation, rawScoreById:Map<string, number>}>}
 */
async function fuseAndAdjust({
  fts,
  vector,
  graph = null,
  ledger,
  taskType,
  taskText,
  feedbackSinceTs,
  feedbackHalfLifeDays,
  k,
}) {
  const lists = buildFusionLists(fts, vector, graph);
  const fused = await rrfFuse(lists, { k: typeof k === "number" ? k : RRF_K });
  const separation = assessRetrievalSeparation(fused, lists);
  const rawScoreById = new Map(fused.map((entry) => [entry.id, entry.score]));
  applyFusedFeedbackBoost(fused, { ledger, taskType, taskText, feedbackSinceTs, feedbackHalfLifeDays });
  await applyTaskQueryRanking(fused, taskText);
  return { fused, separation, rawScoreById };
}

/**
 * @param {Awaited<ReturnType<typeof runFtsBackend>>} fts
 * @param {Awaited<ReturnType<typeof runVectorBackend>> | null} vector
 * @param {Awaited<ReturnType<typeof runGraphBackend>> | null} graph
 * @returns {Record<string, Awaited<ReturnType<typeof runFtsBackend>>["entries"]>}
 */
function buildFusionLists(fts, vector, graph) {
  /** @type {Record<string, Awaited<ReturnType<typeof runFtsBackend>>["entries"]>} */
  const lists = {};
  if (fts.ok && fts.entries.length > 0) lists.fts = fts.entries;
  if (vector && vector.ok && vector.entries.length > 0) lists.vector = vector.entries;
  if (graph && graph.ok && graph.entries.length > 0) lists.graph = graph.entries;
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
 * Summarize how separated the raw fused pool was before feedback and task
 * boosts. This deliberately describes the evidence pool; it does not change
 * ranking.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {Record<string, Awaited<ReturnType<typeof runFtsBackend>>["entries"]>} lists
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
