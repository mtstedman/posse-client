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
import { CONTEXT_SYMBOL_SEARCH_SELF_BOUND_CHARS } from "../../../../../catalog/context.js";
import { resolveVendoredSourcePromotions } from "./vendored-dependencies.js";
import { treeScope } from "./tree.js";
import { codeStructure } from "./exact.js";
import {
  attachScopeBeam,
  compactScopeBeamCandidate,
  markScopeBeamDegraded,
  scopeBeamConfig,
  scopeBeamMaxFiles,
  SCOPE_BEAM_STRUCTURE_FILE_LIMIT,
  symbolSearchHasUnusedSlots,
  syncScopeBeamMetadata,
} from "./search-beam.js";

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
 *   feedbackEnabled?: boolean,
 *   repoId?: string | null,
 *   repoRoot?: string,
 *   planner?: (input: string) => QueryPlan | Promise<QueryPlan>,
 *   onDemandEmbeddingFill?: boolean,
 *   config?: Record<string, unknown>,
 *   scopeBeamEnabled?: boolean,
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
  feedbackEnabled = false,
  repoId,
  repoRoot,
  planner,
  onDemandEmbeddingFill = true,
  config = {},
  scopeBeamEnabled = true,
}) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;
  const vendoredPromotions = /** @type {any} */ (params).filterToolingPaths === true
    ? resolveVendoredSourcePromotions(repoRoot)
    : [];
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
        feedbackEnabled,
        entities: normalizeEntities(/** @type {any} */ (params).entities),
        searchScope: normalizeSearchScope(/** @type {any} */ (params).scope),
        filterDeclarationFiles: /** @type {any} */ (params).filterDeclarationFiles,
        filterToolingPaths: /** @type {any} */ (params).filterToolingPaths,
        genericSymbolFrequencyThreshold: /** @type {any} */ (params).genericSymbolFrequencyThreshold,
        hierarchicalFileLimit: /** @type {any} */ (params).hierarchicalFileLimit,
        withinFileSymbolRerank: /** @type {any} */ (params).withinFileSymbolRerank,
        fileLexicalOverlapWeight: /** @type {any} */ (params).fileLexicalOverlapWeight,
        monorepoPackagePriors: /** @type {any} */ (params).monorepoPackagePriors,
        vendoredPromotions,
        semanticQueryNormalization: /** @type {any} */ (params).semanticQueryNormalization,
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
      repoRoot,
      planner,
      taskType,
      config,
      scopeBeamEnabled,
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
      feedbackEnabled,
      entities: normalizeEntities(/** @type {any} */ (params).entities),
      searchScope: normalizeSearchScope(/** @type {any} */ (params).scope),
      filterDeclarationFiles: /** @type {any} */ (params).filterDeclarationFiles,
      filterToolingPaths: /** @type {any} */ (params).filterToolingPaths,
      genericSymbolFrequencyThreshold: /** @type {any} */ (params).genericSymbolFrequencyThreshold,
      hierarchicalFileLimit: /** @type {any} */ (params).hierarchicalFileLimit,
      withinFileSymbolRerank: /** @type {any} */ (params).withinFileSymbolRerank,
      fileLexicalOverlapWeight: /** @type {any} */ (params).fileLexicalOverlapWeight,
      monorepoPackagePriors: /** @type {any} */ (params).monorepoPackagePriors,
      vendoredPromotions,
      semanticQueryNormalization: /** @type {any} */ (params).semanticQueryNormalization,
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
    repoRoot,
    planner,
    taskType,
    config,
    scopeBeamEnabled,
  });
}

/**
 * @param {{ view: View, result: HybridSearchResult, versionId: string, limit: number, query: string, semanticRequested?: boolean, encoder?: EmbeddingEncoder, overlayHits?: Array<Awaited<ReturnType<typeof overlayHit>>>, ledger?: Ledger, repoId?: string | null, embeddingEnsureStatus?: any, repoRoot?: string, planner?: (input: string) => QueryPlan | Promise<QueryPlan>, taskType?: TaskType, config?: Record<string, unknown>, scopeBeamEnabled?: boolean }} args
 */
async function buildEnvelope({ view, result, versionId, limit, query, semanticRequested = false, encoder, overlayHits = [], ledger, repoId, embeddingEnsureStatus = null, repoRoot, planner, taskType, config = {}, scopeBeamEnabled = true }) {
  const durableItems = result.items
    .filter((entry) => isDefaultVisibleSymbol(entry.payload) || isExplicitLiteralSymbolQuery(query, entry.payload))
    .map((entry) => {
      const hit = symbolHit(entry.payload);
      hit.score = Number(entry.score) || 0;
      const signature = compactSearchText(/** @type {any} */ (entry.payload).signature_text, 160);
      if (signature) /** @type {any} */ (hit).signature = signature;
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
    const degradedReason = vector?.ok ? ensureReason : (vector?.reason || ensureReason || "unavailable");
    meta.semantic = {
      requested: true,
      available: !!vector?.ok,
      provider: encoder?.model || null,
      ...(degradedReason ? { degradedReason } : {}),
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
  // Collision diagnostics still contribute a compact warning, but the lookup
  // response stays address-only. Reachability and liveness belong in the
  // follow-up card/usage tools rather than every search hit.
  if (process.env.POSSE_ATLAS_DISAMBIG !== "0") {
    const disambiguation = detectNameCollisions(visibleItems);
    const trust = buildRetrievalTrustCaution({ disambiguation, separation: result.separation });
    if (trust) {
      meta.warnings = [
        ...(Array.isArray(meta.warnings) ? meta.warnings : []),
        trust.message,
      ];
    }
  }

  const envelope = okEnvelope({
    action: "symbol.search",
    versionId,
    data,
    meta,
  });
  if (scopeBeamEnabled && symbolSearchHasUnusedSlots(envelope, limit)) {
    await attachNodeScopeBeam({
      envelope,
      view,
      versionId,
      query,
      limit,
      repoRoot,
      planner,
      taskType,
      config,
    });
  }
  return boundSymbolSearchEnvelope(envelope);
}

async function attachNodeScopeBeam({ envelope, view, versionId, query, limit, repoRoot, planner, taskType, config }) {
  // Compatibility/internal fallback only. Product symbol.search runs through
  // AtlasToolExecutor's native-complete path, which shares the request deadline
  // across search, scope, and structure. These Node helpers are not cancellable;
  // their conductor caller owns the outer timeout, so an inner Promise.race
  // would only orphan work after returning.
  const [scopeResult] = await Promise.allSettled([
    treeScope({
      view,
      versionId,
      params: {
        taskText: query,
        ...(taskType ? { taskType } : {}),
        maxFiles: scopeBeamMaxFiles(limit),
      },
      config: scopeBeamConfig(config),
      planner,
    }),
  ]);
  if (scopeResult.status !== "fulfilled") {
    markScopeBeamDegraded(envelope);
    return;
  }
  const scopeEnvelope = /** @type {any} */ (scopeResult.value);
  const paths = (Array.isArray(scopeEnvelope?.data?.candidateFiles)
    ? scopeEnvelope.data.candidateFiles
    : [])
    .map((entry) => String(entry?.path || "").trim())
    .filter(Boolean)
    .slice(0, SCOPE_BEAM_STRUCTURE_FILE_LIMIT);
  let structureEnvelope = null;
  if (paths.length > 0) {
    const [structureResult] = await Promise.allSettled([
      codeStructure({
        view,
        versionId,
        params: {
          paths,
          maxFiles: paths.length,
          includeSymbols: true,
          includeEdges: false,
        },
        repoRoot,
      }),
    ]);
    if (structureResult.status === "fulfilled") structureEnvelope = structureResult.value;
  }
  attachScopeBeam(envelope, { query, limit, scopeEnvelope, structureEnvelope });
}

/**
 * Final constructor rail. Transport paging remains a safety net, but a search
 * hit list must never need it. Optional diagnostics are discarded before
 * addresses; at least one compact address can always fit under the rail.
 *
 * @param {any} envelope
 * @param {number} [maxChars]
 */
export function boundSymbolSearchEnvelope(envelope, maxChars = CONTEXT_SYMBOL_SEARCH_SELF_BOUND_CHARS) {
  if (!envelope?.data) return envelope;
  const data = envelope.data;
  const meta = envelope.meta || {};
  if (Array.isArray(data.items)) data.items = data.items.map(compactSymbolAddress);
  if (Array.isArray(data.beam)) data.beam = data.beam.map(compactScopeBeamCandidate);
  delete meta.scoreScheme;
  if (JSON.stringify(envelope).length <= maxChars) return envelope;
  if (Array.isArray(data.entities) && JSON.stringify(envelope).length > maxChars) delete data.entities;
  for (const key of ["warnings", "semantic", "queryPlan", "prefetch"]) {
    if (JSON.stringify(envelope).length <= maxChars) break;
    delete meta[key];
  }
  while (Array.isArray(data.beam) && data.beam.length > 0 && JSON.stringify(envelope).length > maxChars) {
    data.beam.pop();
  }
  syncScopeBeamMetadata(envelope);
  while (Array.isArray(data.items) && data.items.length > 1 && JSON.stringify(envelope).length > maxChars) {
    data.items.pop();
    data.truncated = true;
  }
  if (JSON.stringify(envelope).length > maxChars && meta.backendHealth) {
    const health = meta.backendHealth;
    meta.backendHealth = {
      active: Array.isArray(health.active) ? health.active : [],
      unavailable: Array.isArray(health.unavailable) ? health.unavailable : [],
      fullyDegraded: !!health.fullyDegraded,
    };
  }
  if (Array.isArray(data.items) && data.items[0] && JSON.stringify(envelope).length > maxChars) {
    data.items[0] = compactSymbolAddress(data.items[0], { minimal: true });
    data.truncated = true;
  }
  if (JSON.stringify(envelope).length > maxChars) {
    const first = Array.isArray(data.items) && data.items[0]
      ? compactSymbolAddress(data.items[0], { minimal: true })
      : null;
    envelope.data = {
      items: first ? [first] : [],
      total: Math.max(0, Number(data.total || 0)),
      truncated: true,
    };
    delete envelope.meta;
  }
  return envelope;
}

function compactSymbolAddress(value, { minimal = false } = {}) {
  const location = value?.location && typeof value.location === "object"
    ? value.location
    : {
        repo_rel_path: value?.path,
        startLine: value?.startLine,
        endLine: value?.endLine,
      };
  return {
    symbolId: compactSearchText(value?.symbolId, 96),
    name: compactSearchText(value?.name, 160),
    ...(!minimal && value?.qualifiedName
      ? { qualifiedName: compactSearchText(value.qualifiedName, 240) }
      : {}),
    kind: compactSearchText(value?.kind, 40),
    location: {
      repo_rel_path: compactSearchText(location?.repo_rel_path, 320),
      startLine: location?.startLine,
      endLine: location?.endLine,
    },
    ...(!minimal && value?.signature
      ? { signature: compactSearchText(value.signature, 160) }
      : {}),
  };
}

function compactSearchText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
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
  const signature = compactSearchText(/** @type {any} */ (symbol).signature_text, 160);
  if (signature) /** @type {any} */ (hit).signature = signature;
  return hit;
}
