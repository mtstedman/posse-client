// @ts-check
//
// symbol.getCard handler. Resolves the symbol by ID or ref and produces
// a SymbolCard envelope.

import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { bareSymbolCard, buildSymbolCard, parseSymbolId, symbolIdOf, etagOf, locationOf, symbolHit } from "./cards.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { findOverlaySymbol, findOverlaySymbolByRef, getOverlaySymbols } from "./buffer.js";
import { getEffectivePolicy } from "./policy.js";
import { recordPrefetchAccess } from "./prefetch.js";
import { recordCodeLadderStep } from "./code-ladder.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").SymbolGetCardParams} SymbolGetCardParams */
/** @typedef {import("../contracts/tool-params.js").SymbolGetCardsParams} SymbolGetCardsParams */
/** @typedef {import("../contracts/tool-results.js").SymbolCard} SymbolCard */

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SymbolGetCardParams,
 *   repoRoot?: string,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function symbolGetCard({ view, versionId, params, repoRoot, ledger, repoId }) {
  /** @type {ViewSymbol | null} */
  let target = null;
  /** @type {{ entry: any, symbol: ViewSymbol } | null} */
  let overlayTarget = null;
  const sessionId = /** @type {any} */ (params).sessionId;

  if (params.symbolId) {
    const parsed = parseSymbolId(params.symbolId);
    if (!parsed) {
      return errorEnvelope({
        action: "symbol.getCard",
        versionId,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${params.symbolId}`,
      });
    }
    target = view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (!target) {
      overlayTarget = findOverlaySymbol({ repoRoot, sessionId, symbolId: params.symbolId });
    }
  } else if (params.symbolRef) {
    const ref = params.symbolRef;
    const opts = /** @type {any} */ ({ fuzzy: false });
    if (ref.kind) opts.kinds = [ref.kind];
    if (ref.file) opts.pathPrefix = ref.file;
    const matches = view.query.findSymbol(ref.name, opts);
    if (matches.length === 0) {
      const fuzzyOpts = { ...opts, fuzzy: true, limit: 25 };
      const fuzzy = view.query.findSymbol(ref.name, fuzzyOpts);
      target = fuzzy.find((s) => s.name === ref.name) || null;
    } else {
      target = matches[0];
    }
    if (!target) {
      overlayTarget = findOverlaySymbolByRef({ repoRoot, sessionId, ref: params.symbolRef });
    }
  } else {
    return errorEnvelope({
      action: "symbol.getCard",
      versionId,
      code: "invalid_params",
      message: "symbol.getCard requires symbolId or symbolRef",
    });
  }

  if (!target && !overlayTarget) {
    return errorEnvelope({
      action: "symbol.getCard",
      versionId,
      code: "unresolved_symbol",
      message: "Symbol not found",
    });
  }

  if (overlayTarget) {
    const minCallConfidence = params.minCallConfidence ?? getEffectivePolicy(ledger, effectiveRepo(repoId)).defaultMinCallConfidence;
    const card = buildOverlayCard({
      repoRoot,
      sessionId,
      target: overlayTarget,
      minCallConfidence,
      includeResolutionMetadata: !!params.includeResolutionMetadata,
    });
    const etag = etagOf(overlayTarget.symbol);
    recordCodeLadderStep({
      action: "symbol.getCard",
      sessionId,
      symbolId: symbolIdOf(overlayTarget.symbol),
      file: overlayTarget.symbol.repo_rel_path,
    });
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "symbol.getCard", versionId, etag });
    }
    return okEnvelope({
      action: "symbol.getCard",
      versionId,
      data: card,
      meta: { etag },
    });
  }

  const effectiveRepoId = effectiveRepo(repoId);
  const minCallConfidence = params.minCallConfidence ?? getEffectivePolicy(ledger, effectiveRepoId).defaultMinCallConfidence;
  const includeResolutionMetadata = !!params.includeResolutionMetadata;
  const targetSymbol = /** @type {ViewSymbol} */ (target);
  const etag = etagOf(targetSymbol);
  recordCodeLadderStep({
    action: "symbol.getCard",
    sessionId,
    symbolId: symbolIdOf(targetSymbol),
    file: targetSymbol.repo_rel_path,
  });
  const cache = getRetrievalCache();
  const cacheKey = cache.cardKey({
    versionId,
    repoId: effectiveRepoId,
    symbolId: symbolIdOf(targetSymbol),
    detail: "compact",
    minCallConfidence,
    includeResolutionMetadata,
  });
  const cachedCard = cache.getCard(cacheKey);
  recordPrefetchAccess({ kind: "card", key: cacheKey, hit: !!cachedCard });
  if (cachedCard) {
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "symbol.getCard", versionId, etag });
    }
    return okEnvelope({
      action: "symbol.getCard",
      versionId,
      data: cachedCard,
      meta: { etag },
    });
  }

  const card = buildSymbolCard({
    symbol: /** @type {ViewSymbol} */ (target),
    view,
    detail: "compact",
    minCallConfidence,
    includeResolutionMetadata,
  });
  cache.setCard(cacheKey, card);

  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "symbol.getCard", versionId, etag });
  }

  return okEnvelope({
    action: "symbol.getCard",
    versionId,
    data: card,
    meta: { etag },
  });
}

/**
 * Batch card hydration. This deliberately reuses symbol.getCard behavior so
 * single-card and batch-card resolution cannot drift.
 *
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SymbolGetCardsParams,
 *   repoRoot?: string,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function symbolGetCards({ view, versionId, params, repoRoot, ledger, repoId, action = "symbol.getCards" }) {
  const { requests, invalidRequests } = normalizeBatchRequests(params);
  if (requests.length === 0) {
    if (invalidRequests.length > 0) {
      return okEnvelope({
        action,
        versionId,
        data: {
          cards: [],
          errors: invalidRequests,
          total: invalidRequests.length,
          okCount: 0,
          errorCount: invalidRequests.length,
          partial: false,
        },
      });
    }
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: `${action} requires symbolIds, symbolRefs, or cards`,
    });
  }
  const cards = [];
  const errors = [...invalidRequests];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const result = /** @type {any} */ (symbolGetCard({
      view,
      versionId,
      repoRoot,
      ledger,
      repoId,
      params: {
        ...request,
        minCallConfidence: params.minCallConfidence,
        includeResolutionMetadata: params.includeResolutionMetadata,
        sessionId: /** @type {any} */ (params).sessionId,
      },
    }));
    if (result.ok) {
      cards.push(result.data);
    } else {
      errors.push({
        index,
        request,
        code: result.error?.code || "unknown",
        message: result.error?.message || "Unable to hydrate symbol card",
      });
    }
  }
  return okEnvelope({
    action,
    versionId,
    data: {
      cards,
      errors,
      total: requests.length + invalidRequests.length,
      okCount: cards.length,
      errorCount: errors.length,
      partial: errors.length > 0 && cards.length > 0,
    },
  });
}

/**
 * @param {SymbolGetCardsParams} params
 * @returns {{ requests: SymbolGetCardParams[], invalidRequests: Array<Record<string, unknown>> }}
 */
function normalizeBatchRequests(params) {
  const out = [];
  const invalidRequests = [];
  const seen = new Set();
  const add = (request) => {
    const key = request.symbolId
      ? `id:${request.symbolId}`
      : `ref:${stableRefKey(request.symbolRef || {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(request);
  };
  const addInvalid = (index, request, message) => {
    invalidRequests.push({
      index,
      request,
      code: "invalid_symbol_ref",
      message,
    });
  };
  for (const symbolId of Array.isArray(params.symbolIds) ? params.symbolIds : []) {
    const text = String(symbolId || "").trim();
    if (text) add({ symbolId: text });
  }
  const symbolRefs = Array.isArray(params.symbolRefs) ? params.symbolRefs : [];
  for (let index = 0; index < symbolRefs.length; index += 1) {
    const symbolRef = symbolRefs[index];
    if (isValidSymbolRef(symbolRef)) {
      add({ symbolRef });
    } else if (symbolRef && typeof symbolRef === "object") {
      addInvalid(index, { symbolRef }, "symbolRef must be a plain object with a string name");
    }
  }
  const cards = Array.isArray(params.cards) ? params.cards : [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!card || typeof card !== "object") continue;
    if (typeof card.symbolId === "string" && card.symbolId.trim()) add({ symbolId: card.symbolId.trim() });
    else if (isValidSymbolRef(card.symbolRef)) add({ symbolRef: card.symbolRef });
    else if (card.symbolRef && typeof card.symbolRef === "object") {
      addInvalid(index, { symbolRef: card.symbolRef }, "card.symbolRef must be a plain object with a string name");
    }
  }
  return { requests: out.slice(0, 100), invalidRequests };
}

/**
 * @param {string | null | undefined} repoId
 * @returns {string}
 */
function effectiveRepo(repoId) {
  const text = String(repoId || "default").trim();
  return text || "default";
}

function stableRefKey(value) {
  if (value === undefined) return "null";
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableRefKey).join(",")}]`;
  if (typeof value === "object") {
    if (!isPlainObject(value)) return JSON.stringify(`[nonPlain:${Object.prototype.toString.call(value)}]`);
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableRefKey(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function isValidSymbolRef(value) {
  return isPlainObject(value)
    && typeof value.name === "string"
    && hasOnlyPlainRefValues(value);
}

function hasOnlyPlainRefValues(value) {
  if (value === undefined || value == null) return true;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((entry) => hasOnlyPlainRefValues(entry));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => hasOnlyPlainRefValues(entry));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {{
 *   repoRoot?: string,
 *   sessionId?: string,
 *   target: { entry: any, symbol: ViewSymbol },
 *   minCallConfidence: number,
 *   includeResolutionMetadata: boolean,
 * }} args
 * @returns {SymbolCard}
 */
function buildOverlayCard({ repoRoot, sessionId, target, minCallConfidence, includeResolutionMetadata }) {
  const { entry, symbol } = target;
  const card = bareSymbolCard({ symbol, detail: "compact" });
  card.location = locationOf(symbol, { source: entry.content });
  /** @type {any} */ (card).overlay = true;
  /** @type {any} */ (card).source = "buffer";
  /** @type {any} */ (card).buffer = {
    filePath: entry.filePath,
    sessionId: entry.sessionId,
    version: entry.version,
  };
  const edges = entry.parseResult?.edges || [];
  const overlaySymbols = getOverlaySymbols({ repoRoot, sessionId });
  const bySymbolId = new Map(overlaySymbols.map((item) => [`${item.symbol.content_hash}:${item.symbol.local_id}`, item.symbol]));
  card.callees = edges
    .filter((edge) => edge.from_content_hash === symbol.content_hash && edge.from_local_id === symbol.local_id)
    .filter((edge) => edge.confidence / 100 >= minCallConfidence)
    .slice(0, 25)
    .map((edge) => {
      const resolved = edge.to_content_hash != null && edge.to_local_id != null
        ? bySymbolId.get(`${edge.to_content_hash}:${edge.to_local_id}`)
        : null;
      if (resolved) {
        const hit = symbolHit(resolved);
        hit.confidence = edge.confidence / 100;
        /** @type {any} */ (hit).overlay = true;
        /** @type {any} */ (hit).source = "buffer";
        return hit;
      }
      const edgeStartLine = Number.isInteger(edge.range_start_line) && edge.range_start_line > 0
        ? edge.range_start_line
        : 1;
      const edgeEndLine = Number.isInteger(edge.range_end_line) && edge.range_end_line > 0
        ? edge.range_end_line
        : edgeStartLine;
      return {
        symbolId: `unresolved:${edge.to_name}`,
        name: edge.to_name,
        kind: "function",
        lang: symbol.lang,
        location: {
          repo_rel_path: edge.repo_rel_path,
          startLine: edgeStartLine,
          endLine: edgeEndLine,
          startByte: edge.range_start,
          endByte: edge.range_end,
        },
        confidence: edge.confidence / 100,
      };
    });
  card.callers = [];
  if (includeResolutionMetadata) {
    card.resolution = { confidence: 0.95, method: "buffer-parse" };
  }
  return card;
}
