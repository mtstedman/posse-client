// @ts-check
//
// slice.build / slice.refresh / slice.spillover.get handlers.
//
// Slice semantics:
//   1. Resolve entry symbols from any combination of taskText (semantic
//      search when embeddings are active), entrySymbols (SymbolId list),
//      editedFiles (paths → symbols), failingTestPath (path → symbols).
//   2. Run View.query.slice() to expand the neighborhood (callers,
//      callees, type relationships) with a depth bound.
//   3. Hydrate each symbol into a SymbolCard at the requested detail.
//   4. Apply budget caps; remaining cards become spillover.

import { buildSymbolCard, parseSymbolId, symbolIdOf } from "./cards.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { hybridSearch } from "./orchestrator/index.js";
import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "../paths.js";
import { loadSliceEntry, saveSliceEntry } from "./slice-store.js";
import { memorySurface } from "./memory.js";
import { getEffectivePolicy } from "./policy.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { recordPrefetchAccess } from "./prefetch.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";
import { ensureEmbeddingsForView } from "../embeddings/on-demand.js";
import { logAtlasError } from "../verbose-errors.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/tool-params.js").SliceBuildParams} SliceBuildParams */
/** @typedef {import("../contracts/tool-params.js").SliceRefreshParams} SliceRefreshParams */
/** @typedef {import("../contracts/tool-params.js").SliceSpilloverGetParams} SliceSpilloverGetParams */
/** @typedef {import("../contracts/tool-params.js").CardDetail} CardDetail */
/** @typedef {import("../contracts/tool-params.js").TaskType} TaskType */
/** @typedef {import("../contracts/tool-results.js").SliceData} SliceData */
/** @typedef {import("../contracts/tool-results.js").SliceRefreshData} SliceRefreshData */
/** @typedef {import("../contracts/tool-results.js").SliceSpilloverGetData} SliceSpilloverGetData */
/** @typedef {import("../contracts/tool-results.js").SymbolCard} SymbolCard */
/** @typedef {import("./orchestrator/index.js").HybridSearchResult} HybridSearchResult */
/** @typedef {import("./orchestrator/query-planner-types.js").QueryPlan} QueryPlan */
/** @typedef {ReturnType<typeof okEnvelope<SliceData>> | ReturnType<typeof errorEnvelope> | ReturnType<typeof notModifiedEnvelope>} SliceBuildEnvelope */
/** @typedef {{
 *   versionId: string,
 *   wireFormat: { kind: "standard" | "compact" | "agent" | "packed", version: 1 | 2 | 3 },
 *   cards: SymbolCard[],
 *   spillover: SymbolCard[],
 *   detail: CardDetail,
 *   minCallConfidence: number,
 *   includeResolutionMetadata: boolean,
 *   etag: string,
 *   expiresAt?: number,
 * }} SliceRegistryEntry */

const DEFAULT_BUDGET_CARDS = 50;
const DEFAULT_BUDGET_TOKENS = 12_000;
const TOKENS_PER_CARD_ESTIMATE = 220;

/**
 * Shared in-memory store keyed by sliceHandle. Slices are ephemeral —
 * they live as long as the process. The shim layer can persist these
 * later if cross-process resume is needed.
 *
 * @type {Map<string, SliceRegistryEntry>}
 */
const SLICE_REGISTRY = new Map();

// Hot-cache bound for the in-memory registry. Handles are content-addressed
// per (view version × entry set), so a long-lived reader thread accumulates
// one entry per distinct slice as versions advance — unbounded without this.
// Durable resolution survives eviction via slices.db (loadSliceEntry).
const SLICE_REGISTRY_MAX = 256;

function rememberSliceEntry(sliceHandle, entry) {
  // Map preserves insertion order; delete+set keeps this LRU-ish so repeat
  // builds of the same handle refresh recency instead of aging out.
  if (SLICE_REGISTRY.has(sliceHandle)) SLICE_REGISTRY.delete(sliceHandle);
  SLICE_REGISTRY.set(sliceHandle, entry);
  while (SLICE_REGISTRY.size > SLICE_REGISTRY_MAX) {
    const oldest = SLICE_REGISTRY.keys().next().value;
    if (oldest == null) break;
    SLICE_REGISTRY.delete(oldest);
  }
}

const REFRESH_DIFF_LIMIT = 100;

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SliceBuildParams,
 *   ledger?: Ledger,
 *   repoRoot?: string,
 *   repoId?: string | null,
 *   embeddingIndex?: EmbeddingIndex,
 *   encoder?: EmbeddingEncoder,
 *   taskType?: TaskType,
 *   planner?: (input: string) => QueryPlan | Promise<QueryPlan>,
 * }} args
 * @returns {Promise<SliceBuildEnvelope>}
 */
export async function sliceBuild({ view, versionId, params, ledger, repoRoot, repoId, embeddingIndex, encoder, taskType, planner, onDemandEmbeddingFill = true }) {
  const detail = /** @type {CardDetail} */ (params.cardDetail || "compact");
  const budget = params.budget || {};
  const maxCards = budget.maxCards ?? DEFAULT_BUDGET_CARDS;
  const maxTokens = budget.maxEstimatedTokens ?? DEFAULT_BUDGET_TOKENS;
  const wireFormatKind = params.wireFormat || "compact";
  const wireFormatVersion = params.wireFormatVersion || 2;
  let effectiveMinConfidence = params.minConfidence ?? 0.5;
  const effectiveRepoId = effectiveRepo(repoId);
  const effectiveTaskType = params.taskType || taskType || null;
  const minCallConfidence = params.minCallConfidence ?? getEffectivePolicy(ledger, effectiveRepoId).defaultMinCallConfidence;
  const semanticEntryDiscovery = !!params.taskText
    && params.semantic !== false
    && !!embeddingIndex
    && !!encoder
    && encoder.dim === embeddingIndex.dim;
  const hasExplicitEntries = (params.entrySymbols || []).length > 0
    || (params.editedFiles || []).length > 0
    || !!params.failingTestPath;
  const cacheParams = /** @type {Record<string, unknown>} */ ({
    ...params,
    ...(params.taskText ? { semantic: semanticEntryDiscovery } : {}),
    ...(semanticEntryDiscovery ? { semanticModel: `${encoder.model || "unknown"}:${encoder.model_version || "unknown"}:${encoder.dim}` } : {}),
    ...(effectiveTaskType ? { taskType: effectiveTaskType } : {}),
    minCallConfidence,
  });
  delete cacheParams.ifNoneMatch;
  const cache = getRetrievalCache();
  const cacheKey = cache.sliceKey({
    versionId,
    repoId: effectiveRepoId,
    params: cacheParams,
  });
  const cached = cache.getSlice(cacheKey);
  recordPrefetchAccess({ kind: "slice", key: cacheKey, hit: !!cached });
  if (cached) {
    if (params.ifNoneMatch && params.ifNoneMatch === cached.etag) {
      return /** @type {any} */ (notModifiedEnvelope({ action: "slice.build", versionId, etag: cached.etag }));
    }
    return okEnvelope({
      action: "slice.build",
      versionId,
      data: cached.data,
      meta: { etag: cached.etag },
    });
  }

  // 1. Resolve entry symbols.
  /** @type {ViewSymbol[]} */
  const entries = [];
  /** @type {Set<number>} */
  const seenGlobalIds = new Set();
  /** @param {ViewSymbol | null} s */
  const addEntry = (s) => {
    if (!s) return;
    if (seenGlobalIds.has(s.global_id)) return;
    seenGlobalIds.add(s.global_id);
    entries.push(s);
  };

  for (const id of params.entrySymbols || []) {
    const parsed = parseSymbolId(id);
    if (!parsed) continue;
    const sym = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (sym) addEntry(sym);
  }

  for (const filePath of params.editedFiles || []) {
    if (!isCanonicalRepoPath(filePath)) continue;
    for (const s of (await view.query.symbolsInFile(filePath)).filter(isDefaultVisibleSymbol)) addEntry(s);
  }

  if (params.failingTestPath && isCanonicalRepoPath(params.failingTestPath)) {
    for (const s of (await view.query.symbolsInFile(params.failingTestPath)).filter(isDefaultVisibleSymbol)) addEntry(s);
  }

  const applySearchResult = (result) => {
    const sync = /** @type {HybridSearchResult} */ (result);
    for (const sym of sync.symbols.slice(0, 10)) addEntry(sym);
  };

  if (params.taskText && semanticEntryDiscovery) {
    const semantic = true;
    const searchArgs = {
      view,
      query: params.taskText,
      ledger,
      repoId,
      embeddingIndex,
      encoder,
      options: {
        semantic,
        taskText: params.taskText,
        taskType: effectiveTaskType,
        limit: 25,
        planner,
      },
    };
    // Skipped when the caller opted out of the bulk fill (in-process
    // retrieval fallback): entry discovery searches what's already indexed.
    if (onDemandEmbeddingFill) {
      try {
        await ensureEmbeddingsForView({
          view,
          index: /** @type {EmbeddingIndex} */ (embeddingIndex),
          encoder: /** @type {EmbeddingEncoder} */ (encoder),
          repoRoot,
          limit: 5000,
          timeoutMs: 15000,
        });
      } catch (err) {
        logAtlasError("[sliceBuild.ensureEmbeddingsForView] threw:", err);
      }
    }
    applySearchResult(await hybridSearch(searchArgs));
    return await finishBuild();
  }
  if (params.taskText && !semanticEntryDiscovery && !hasExplicitEntries) {
    applySearchResult(await hybridSearch({
      view,
      query: params.taskText,
      ledger,
      repoId,
      options: {
        semantic: false,
        taskText: params.taskText,
        taskType: effectiveTaskType,
        limit: 25,
        searchScope: "either",
        planner,
      },
    }));
  }
  return await finishBuild();

  // 2. Expand neighborhood.
  async function finishBuild() {
    const maxSymbols = Math.max(maxCards * 2, 50);
    let sliceResult = await querySliceWithMetadata(view, entries.map((s) => s.global_id), {
      depth: 2,
      maxSymbols,
      minConfidence: effectiveMinConfidence,
    });
    if (params.minConfidence == null && sliceResult.symbols.length < Math.min(maxSymbols, maxCards + entries.length)) {
      const relaxed = await querySliceWithMetadata(view, entries.map((s) => s.global_id), {
        depth: 2,
        maxSymbols,
        minConfidence: 0.3,
      });
      if (relaxed.symbols.length > sliceResult.symbols.length) {
        sliceResult = relaxed;
        effectiveMinConfidence = 0.3;
      }
    }
    const neighbors = sliceResult.symbols;
    /** @type {ViewSymbol[]} */
    const ordered = [];
    for (const s of entries) ordered.push(s);
    for (const s of neighbors) {
      if (!isDefaultVisibleSymbol(s)) continue;
      if (!seenGlobalIds.has(s.global_id)) {
        seenGlobalIds.add(s.global_id);
        ordered.push(s);
      }
    }

    // 3. Hydrate cards with budget tracking. Cards whose etag the caller
    // already has are retained in the registered slice but returned as refs,
    // so repeated slice calls can spend their card/token budget on new signal.
    const knownCardEtags = normalizeKnownCardEtags(params.knownCardEtags);
    /** @type {SymbolCard[]} */
    const registryCards = [];
    /** @type {SymbolCard[]} */
    const returnedCards = [];
    /** @type {SymbolCard[]} */
    const spillover = [];
    /** @type {NonNullable<SliceData["cardRefs"]>} */
    const cardRefs = [];
    /** @type {Map<string, string>} */
    const spilloverReasonBySymbolId = new Map();
    let estimatedTokens = 0;
    let hitCardCap = false;
    let hitTokenCap = false;
    for (const s of ordered) {
      const card = await buildSymbolCard({
        symbol: s,
        view,
        detail,
        minCallConfidence,
        includeResolutionMetadata: !!params.includeResolutionMetadata,
      });
      const knownEtag = knownCardEtags.get(card.symbolId);
      if (knownEtag && knownEtag === card.etag) {
        registryCards.push(card);
        cardRefs.push({
          symbolId: card.symbolId,
          etag: card.etag || "",
          detailLevel: detail,
        });
        continue;
      }

      if (returnedCards.length >= maxCards) {
        hitCardCap = true;
        const minimal = await buildSymbolCard({ symbol: s, view, detail: "minimal" });
        spilloverReasonBySymbolId.set(minimal.symbolId, "deferred: card budget reached");
        spillover.push(minimal);
        continue;
      }
      if (estimatedTokens + TOKENS_PER_CARD_ESTIMATE > maxTokens) {
        hitTokenCap = true;
        const minimal = await buildSymbolCard({ symbol: s, view, detail: "minimal" });
        spilloverReasonBySymbolId.set(minimal.symbolId, "deferred: token budget reached");
        spillover.push(minimal);
        continue;
      }
      registryCards.push(card);
      returnedCards.push(card);
      estimatedTokens += TOKENS_PER_CARD_ESTIMATE;
    }

    const truncated = spillover.length > 0;
    const frontier = sliceFrontier({
      spillover,
      spilloverReasonBySymbolId,
      metadata: sliceResult.frontier,
    });
    const frontierTokensEstimate = frontier.length * TOKENS_PER_CARD_ESTIMATE;
    const sliceHandle = sliceHandleFor({ versionId, ordered });
    const etag = sliceEtagFor({ versionId, cards: registryCards, spillover });
    const wireFormat = /** @type {SliceData["wireFormat"]} */ ({
      kind: wireFormatKind,
      version: wireFormatVersion,
    });
    const packed = wireFormatKind === "packed" ? packSliceCards(returnedCards) : null;
    const data = /** @type {SliceData} */ ({
      sliceHandle,
      knownVersion: versionId,
      cards: packed ? [] : returnedCards,
      ...(cardRefs.length > 0 ? { cardRefs } : {}),
      budgetUsage: {
        cardsReturned: returnedCards.length,
        ...(cardRefs.length > 0 ? { cardRefsReturned: cardRefs.length } : {}),
        ...(packed ? { packedRows: packed.rows.length } : {}),
        estimatedTokens,
        frontierTokensEstimate,
        hitCardCap,
        hitTokenCap,
      },
      truncated,
      totalCardCount: registryCards.length + spillover.length,
      wireFormat,
      ...(packed ? { packed } : {}),
      ...(frontier.length > 0 ? { frontier } : {}),
    });
    if (ledger) {
      try {
        const mem = await memorySurface({
          versionId,
          ledger,
          repoId,
          params: {
            symbolIds: [...new Set(returnedCards.map((card) => card.symbolId))],
            fileRelPaths: params.editedFiles || [],
          },
        });
        const memoryAnchorCount = (Array.isArray(mem?.data?.symbols) ? mem.data.symbols.length : 0)
          + (Array.isArray(mem?.data?.files) ? mem.data.files.length : 0);
        if (mem?.ok && memoryAnchorCount > 0) {
          data.memorySurface = mem.data;
        }
      } catch {
        // Memory enrichment is intentionally non-critical.
      }
    }
    if (truncated) data.spilloverHandle = `${sliceHandle}:spill`;
    const entry = {
      versionId,
      wireFormat,
      cards: registryCards,
      spillover,
      detail,
      minCallConfidence,
      includeResolutionMetadata: !!params.includeResolutionMetadata,
      etag,
    };
    rememberSliceEntry(sliceHandle, entry);
    // Durable-store persistence is best-effort: the slice is already built
    // and resolvable via the in-memory registry, so slices.db contention or
    // corruption must not fail a completed slice.build.
    try {
      saveSliceEntry({ repoRoot, handle: sliceHandle, entry });
    } catch { /* handle stays resolvable in-process */ }
    cache.setSlice(cacheKey, { data, etag });
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return /** @type {any} */ (notModifiedEnvelope({ action: "slice.build", versionId, etag }));
    }
    return okEnvelope({ action: "slice.build", versionId, data, meta: { etag } });
  }
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SliceRefreshParams,
 *   repoRoot?: string,
 * }} args
 */
export async function sliceRefresh({ view, versionId, params, repoRoot }) {
  const entry = SLICE_REGISTRY.get(params.sliceHandle)
    || /** @type {SliceRegistryEntry | undefined} */ (loadSliceEntry({ repoRoot, handle: params.sliceHandle })?.entry);
  if (!entry) {
    return errorEnvelope({
      action: "slice.refresh",
      versionId,
      code: "unknown_slice_handle",
      message: `No slice registered for handle ${params.sliceHandle}`,
    });
  }
  if (entry.versionId === params.knownVersion && entry.versionId === versionId) {
    // Same view, same handle, same version — nothing changed.
    /** @type {SliceRefreshData} */
    const data = {
      sliceHandle: params.sliceHandle,
      knownVersion: versionId,
      addedCards: [],
      removedSymbolIds: [],
      changedCards: [],
      stillValid: true,
    };
    return okEnvelope({ action: "slice.refresh", versionId, data, meta: { etag: entry.etag } });
  }

  const diff = await diffSliceAgainstView({ view, entry, versionId });
  if (!diff.safe) {
    /** @type {SliceRefreshData} */
    const data = {
      sliceHandle: params.sliceHandle,
      knownVersion: params.knownVersion,
      addedCards: [],
      removedSymbolIds: [],
      changedCards: [],
      stillValid: false,
    };
    return okEnvelope({ action: "slice.refresh", versionId, data });
  }

  rememberSliceEntry(params.sliceHandle, {
    ...entry,
    versionId,
    cards: diff.cards,
    spillover: diff.spillover,
    etag: diff.etag,
  });
  try {
    saveSliceEntry({
      repoRoot,
      handle: params.sliceHandle,
      entry: { ...entry, versionId, cards: diff.cards, spillover: diff.spillover, etag: diff.etag },
    });
  } catch { /* handle stays resolvable in-process */ }

  /** @type {SliceRefreshData} */
  const data = {
    sliceHandle: params.sliceHandle,
    knownVersion: versionId,
    addedCards: diff.addedCards,
    removedSymbolIds: diff.removedSymbolIds,
    changedCards: diff.changedCards,
    stillValid: true,
  };
  return okEnvelope({ action: "slice.refresh", versionId, data, meta: { etag: diff.etag } });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SliceSpilloverGetParams,
 *   repoRoot?: string,
 * }} args
 */
export function sliceSpilloverGet({ view, versionId, params, repoRoot }) {
  const baseHandle = params.spilloverHandle.replace(/:spill$/, "");
  const entry = SLICE_REGISTRY.get(baseHandle)
    || /** @type {SliceRegistryEntry | undefined} */ (loadSliceEntry({ repoRoot, handle: baseHandle })?.entry);
  if (!entry) {
    return errorEnvelope({
      action: "slice.spillover.get",
      versionId,
      code: "unknown_spillover_handle",
      message: `No spillover for handle ${params.spilloverHandle}`,
    });
  }
  const pageSize =
    typeof params.pageSize === "number" && params.pageSize > 0 ? params.pageSize : 25;
  const parsedCursor = params.cursor ? Number(params.cursor) : 0;
  const startIdx = Number.isFinite(parsedCursor) && parsedCursor > 0
    ? Math.floor(parsedCursor)
    : 0;
  const slice = entry.spillover.slice(startIdx, startIdx + pageSize);
  const nextIdx = startIdx + slice.length;
  /** @type {SliceSpilloverGetData} */
  const data = {
    cards: slice,
    hasMore: nextIdx < entry.spillover.length,
  };
  if (nextIdx < entry.spillover.length) data.nextCursor = String(nextIdx);
  return okEnvelope({ action: "slice.spillover.get", versionId, data });
}

/**
 * Stable handle: hash of versionId + ordered symbolIds. Same inputs in
 * the same view always yield the same handle, which makes refresh
 * trivial.
 *
 * @param {{ versionId: string, ordered: ViewSymbol[] }} args
 * @returns {string}
 */
function sliceHandleFor({ versionId, ordered }) {
  const ids = ordered.map((s) => symbolIdOf(s)).join(",");
  return `sl_${sha256Hex(`${versionId}|${ids}`).slice(0, 16)}`;
}

/**
 * @param {{ versionId: string, cards: SymbolCard[], spillover: SymbolCard[] }} args
 * @returns {string}
 */
function sliceEtagFor({ versionId, cards, spillover }) {
  const payload = [...cards, ...spillover]
    .map((card) => `${card.symbolId}:${card.etag || ""}`)
    .join(",");
  return `slice:${sha256Hex(`${versionId}|${payload}`).slice(0, 24)}`;
}

/**
 * Columnar, low-overhead projection for agents that want many symbols without
 * the repeated object keys and nested card arrays.
 *
 * @param {SymbolCard[]} cards
 * @returns {NonNullable<SliceData["packed"]>}
 */
function packSliceCards(cards) {
  const columns = [
    "symbolId",
    "name",
    "kind",
    "lang",
    "path",
    "startLine",
    "endLine",
    "etag",
    "signature",
    "fanIn",
    "fanOut",
  ];
  const rows = cards.map((card) => [
    card.symbolId,
    card.name,
    card.kind,
    card.lang,
    card.location?.repo_rel_path || null,
    card.location?.startLine || null,
    card.location?.endLine || null,
    card.etag || null,
    card.signature || null,
    Number(/** @type {any} */ (card).metrics?.fanIn || 0),
    Number(/** @type {any} */ (card).metrics?.fanOut || 0),
  ]);
  return {
    schemaVersion: 1,
    columns,
    rows,
    cardCount: cards.length,
  };
}

/**
 * @param {unknown} value
 * @returns {Map<string, string>}
 */
function normalizeKnownCardEtags(value) {
  const out = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [symbolId, etag] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (typeof symbolId !== "string" || typeof etag !== "string") continue;
    if (!symbolId || !etag) continue;
    out.set(symbolId, etag);
    if (out.size >= 1000) break;
  }
  return out;
}

/**
 * @param {View} view
 * @param {number[]} seedGlobalIds
 * @param {{ depth: number, maxSymbols: number, minConfidence: number }} opts
 * @returns {Promise<{ symbols: ViewSymbol[], frontier: { symbol: ViewSymbol, score: number, why: string }[] }>}
 */
async function querySliceWithMetadata(view, seedGlobalIds, opts) {
  if (typeof view.query.sliceWithMetadata === "function") {
    return await view.query.sliceWithMetadata(seedGlobalIds, opts);
  }
  return {
    symbols: await view.query.slice(seedGlobalIds, opts),
    frontier: [],
  };
}

/**
 * @param {{
 *   spillover: SymbolCard[],
 *   spilloverReasonBySymbolId: Map<string, string>,
 *   metadata: { symbol: ViewSymbol, score: number, why: string }[],
 * }} args
 * @returns {NonNullable<SliceData["frontier"]>}
 */
function sliceFrontier({ spillover, spilloverReasonBySymbolId, metadata }) {
  /** @type {Map<string, { symbolId: string, why: string }>} */
  const out = new Map();
  for (const card of spillover.slice(0, 10)) {
    out.set(card.symbolId, {
      symbolId: card.symbolId,
      why: sanitizeFrontierWhy(spilloverReasonBySymbolId.get(card.symbolId)
        || "deferred: selected by slice but omitted by response budget",
      ),
    });
  }
  for (const item of metadata || []) {
    const symbolId = symbolIdOf(item.symbol);
    if (out.has(symbolId)) continue;
    out.set(symbolId, {
      symbolId,
      why: sanitizeFrontierWhy(item.why),
    });
    if (out.size >= 10) break;
  }
  return [...out.values()].slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeFrontierWhy(value) {
  return String(value || "")
    .replace(/\s*\(\d+(?:\.\d+)?%\)/g, "")
    .replace(/\bscore\s*=\s*[0-9.]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * @param {{ view: View, entry: SliceRegistryEntry, versionId: string }} args
 */
async function diffSliceAgainstView({ view, entry, versionId }) {
  const original = [...entry.cards, ...entry.spillover];
  /** @type {SymbolCard[]} */
  const refreshed = [];
  /** @type {SymbolCard[]} */
  const addedCards = [];
  /** @type {string[]} */
  const removedSymbolIds = [];
  /** @type {SymbolCard[]} */
  const changedCards = [];
  /** @type {Set<string>} */
  const seenCurrentIds = new Set();
  /** @type {Set<string>} */
  const originalKeys = new Set();
  /** @type {Set<string>} */
  const touchedPaths = new Set();

  for (const card of original) {
    originalKeys.add(cardSemanticKey(card));
    if (isCanonicalRepoPath(card.location?.repo_rel_path || "")) {
      touchedPaths.add(card.location.repo_rel_path);
    }

    const current = await currentSymbolForCard(view, card);
    if (!current) {
      removedSymbolIds.push(card.symbolId);
      continue;
    }

    const nextCard = await buildCardForRefresh({ view, entry, symbol: current });
    refreshed.push(nextCard);
    seenCurrentIds.add(nextCard.symbolId);
    if (nextCard.symbolId !== card.symbolId || nextCard.etag !== card.etag) {
      changedCards.push(nextCard);
    }
  }

  for (const repoPath of touchedPaths) {
    for (const sym of await view.query.symbolsInFile(repoPath)) {
      const id = symbolIdOf(sym);
      if (seenCurrentIds.has(id)) continue;
      const key = symbolSemanticKey(sym);
      if (originalKeys.has(key)) continue;
      const card = await buildCardForRefresh({ view, entry, symbol: sym });
      addedCards.push(card);
      refreshed.push(card);
      seenCurrentIds.add(id);
      if (addedCards.length > REFRESH_DIFF_LIMIT) break;
    }
    if (addedCards.length > REFRESH_DIFF_LIMIT) break;
  }

  const diffCount = addedCards.length + changedCards.length + removedSymbolIds.length;
  if (diffCount > REFRESH_DIFF_LIMIT) {
    return {
      safe: false,
      addedCards: [],
      removedSymbolIds: [],
      changedCards: [],
      cards: entry.cards,
      spillover: entry.spillover,
      etag: entry.etag,
    };
  }

  const cardCap = entry.cards.length;
  return {
    safe: true,
    addedCards,
    removedSymbolIds,
    changedCards,
    cards: refreshed.slice(0, cardCap),
    spillover: refreshed.slice(cardCap),
    etag: sliceEtagFor({ versionId, cards: refreshed.slice(0, cardCap), spillover: refreshed.slice(cardCap) }),
  };
}

/**
 * @param {{ view: View, entry: SliceRegistryEntry, symbol: ViewSymbol }} args
 * @returns {Promise<SymbolCard>}
 */
async function buildCardForRefresh({ view, entry, symbol }) {
  return await buildSymbolCard({
    symbol,
    view,
    detail: entry.detail,
    minCallConfidence: entry.minCallConfidence,
    includeResolutionMetadata: entry.includeResolutionMetadata,
  });
}

/**
 * @param {View} view
 * @param {SymbolCard} card
 * @returns {Promise<ViewSymbol | null>}
 */
async function currentSymbolForCard(view, card) {
  const parsed = parseSymbolId(card.symbolId);
  if (parsed) {
    const exact = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (exact) return exact;
  }
  const repoPath = card.location?.repo_rel_path;
  if (!isCanonicalRepoPath(repoPath || "")) return null;
  const qname = card.qualifiedName || "";
  for (const sym of await view.query.symbolsInFile(repoPath)) {
    if (sym.kind !== card.kind) continue;
    if (sym.name !== card.name) continue;
    if (qname && sym.qualified_name !== qname) continue;
    return sym;
  }
  return null;
}

/**
 * @param {SymbolCard} card
 * @returns {string}
 */
function cardSemanticKey(card) {
  return [
    card.location?.repo_rel_path || "",
    card.kind || "",
    card.qualifiedName || card.name || "",
  ].join("|");
}

/**
 * @param {ViewSymbol} sym
 * @returns {string}
 */
function symbolSemanticKey(sym) {
  return [
    sym.repo_rel_path,
    sym.kind,
    sym.qualified_name || sym.name,
  ].join("|");
}

/**
 * @param {string | null | undefined} repoId
 * @returns {string}
 */
function effectiveRepo(repoId) {
  const text = String(repoId || "default").trim();
  return text || "default";
}

/**
 * Test-only: drop all registered slices.
 */
export function __resetSliceRegistryForTests() {
  SLICE_REGISTRY.clear();
  getRetrievalCache().invalidateAll();
}
