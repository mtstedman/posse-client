// @ts-check
//
// symbol.card handler. Resolves the symbol by ID or ref and produces
// a SymbolCard envelope.

import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { bareSymbolCard, buildSymbolCard, parseSymbolId, symbolIdOf, etagOf, locationOf, symbolHit } from "./cards.js";
import { applyDbAccessToCard } from "./db-symbol-access.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { findOverlaySymbol, findOverlaySymbolByRef, getOverlaySymbols } from "./buffer.js";
import { getEffectivePolicy } from "./policy.js";
import { recordPrefetchAccess } from "./prefetch.js";
import { recordCodeLadderStep } from "./code-ladder.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").SymbolGetCardParams} SymbolGetCardParams */
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
export async function symbolGetCard({ view, versionId, params, repoRoot, ledger, repoId }) {
  if (hasBatchCardParams(params)) {
    return symbolGetCards({ view, versionId, params, repoRoot, ledger, repoId, action: "symbol.card" });
  }

  /** @type {ViewSymbol | null} */
  let target = null;
  /** @type {{ entry: any, symbol: ViewSymbol } | null} */
  let overlayTarget = null;
  const sessionId = /** @type {any} */ (params).sessionId;

  if (params.symbolId) {
    const parsed = parseSymbolId(params.symbolId);
    if (!parsed) {
      return errorEnvelope({
        action: "symbol.card",
        versionId,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${params.symbolId}`,
      });
    }
    target = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (!target) {
      overlayTarget = await findOverlaySymbol({ repoRoot, sessionId, symbolId: params.symbolId });
    }
  } else if (params.symbolRef) {
    const ref = params.symbolRef;
    const opts = /** @type {any} */ ({ fuzzy: false });
    if (ref.kind) opts.kinds = [ref.kind];
    if (ref.file) opts.pathPrefix = ref.file;
    const matches = await view.query.findSymbol(ref.name, opts);
    if (matches.length === 0) {
      const fuzzyOpts = { ...opts, fuzzy: true, limit: 25 };
      const fuzzy = await view.query.findSymbol(ref.name, fuzzyOpts);
      target = fuzzy.find((s) => s.name === ref.name) || null;
    } else {
      target = matches[0];
    }
    if (!target) {
      overlayTarget = await findOverlaySymbolByRef({ repoRoot, sessionId, ref: params.symbolRef });
    }
  } else {
    return errorEnvelope({
      action: "symbol.card",
      versionId,
      code: "invalid_params",
      message: "symbol.card requires symbolId or symbolRef",
    });
  }

  if (!target && !overlayTarget) {
    return errorEnvelope({
      action: "symbol.card",
      versionId,
      code: "unresolved_symbol",
      message: "Symbol not found",
    });
  }

  if (overlayTarget) {
    const minCallConfidence = params.minCallConfidence ?? getEffectivePolicy(ledger, effectiveRepo(repoId)).defaultMinCallConfidence;
    const card = await buildOverlayCard({
      repoRoot,
      sessionId,
      target: overlayTarget,
      minCallConfidence,
      includeResolutionMetadata: !!params.includeResolutionMetadata,
    });
    const etag = etagOf(overlayTarget.symbol);
    recordCodeLadderStep({
      action: "symbol.card",
      sessionId,
      symbolId: symbolIdOf(overlayTarget.symbol),
      file: overlayTarget.symbol.repo_rel_path,
    });
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "symbol.card", versionId, etag });
    }
    return okEnvelope({
      action: "symbol.card",
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
    action: "symbol.card",
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
    applyDbAccessToCard(cachedCard);
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "symbol.card", versionId, etag });
    }
    return okEnvelope({
      action: "symbol.card",
      versionId,
      data: cachedCard,
      meta: { etag },
    });
  }

  const card = await buildSymbolCard({
    symbol: /** @type {ViewSymbol} */ (target),
    view,
    detail: "compact",
    minCallConfidence,
    includeResolutionMetadata,
  });
  cache.setCard(cacheKey, card);

  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "symbol.card", versionId, etag });
  }

  return okEnvelope({
    action: "symbol.card",
    versionId,
    data: card,
    meta: { etag },
  });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: SymbolGetCardParams,
 *   repoRoot?: string,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   action?: "symbol.card",
 * }} args
 */
export async function symbolGetCards({ view, versionId, params, repoRoot, ledger, repoId, action = "symbol.card" }) {
  const requests = collectCardRequests(params);
  if (requests.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "symbol.card requires symbolId, symbolRef, symbolIds, or symbolRefs",
    });
  }

  const cards = [];
  const errors = [];
  for (const request of requests) {
    if (request.error) {
      errors.push(request.error);
      continue;
    }
    const childParams = {
      minCallConfidence: params.minCallConfidence,
      includeResolutionMetadata: params.includeResolutionMetadata,
      sessionId: /** @type {any} */ (params).sessionId,
      ...(request.symbolId ? { symbolId: request.symbolId } : {}),
      ...(request.symbolRef ? { symbolRef: request.symbolRef } : {}),
    };
    const result = await symbolGetCard({ view, versionId, params: /** @type {SymbolGetCardParams} */ (childParams), repoRoot, ledger, repoId });
    if (result.ok) {
      cards.push(result.data);
    } else {
      errors.push({
        index: request.index,
        code: result.error?.code || "symbol_card_error",
        message: result.error?.message || "Could not hydrate symbol card",
        ...(request.symbolId ? { symbolId: request.symbolId } : {}),
        ...(request.symbolRef ? { symbolRef: request.symbolRef } : {}),
      });
    }
  }

  return okEnvelope({
    action,
    versionId,
    data: {
      cards,
      errors,
      total: requests.length,
      okCount: cards.length,
      errorCount: errors.length,
      partial: cards.length > 0 && errors.length > 0,
    },
  });
}

/**
 * @param {SymbolGetCardParams} params
 */
function hasBatchCardParams(params) {
  return Array.isArray(/** @type {any} */ (params).symbolIds)
    || Array.isArray(/** @type {any} */ (params).symbolRefs);
}

/**
 * @param {SymbolGetCardParams} params
 * @returns {Array<{ index: number, symbolId?: string, symbolRef?: any, error?: any }>}
 */
function collectCardRequests(params) {
  const requests = [];
  const seen = new Set();
  let index = 0;

  const addSymbolId = (value) => {
    const symbolId = String(value || "").trim();
    if (!symbolId) return;
    const key = `id:${symbolId}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ index: index++, symbolId });
  };

  if (params.symbolId) addSymbolId(params.symbolId);
  for (const symbolId of arrayParam(/** @type {any} */ (params).symbolIds)) addSymbolId(symbolId);

  const addSymbolRef = (value) => {
    const normalized = normalizeBatchSymbolRef(value);
    if (!normalized.ok) {
      const requestIndex = index++;
      requests.push({
        index: requestIndex,
        error: {
          index: requestIndex,
          code: "invalid_symbol_ref",
          message: normalized.message,
        },
      });
      return;
    }
    const key = `ref:${stableRefKey(normalized.ref)}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ index: index++, symbolRef: normalized.ref });
  };

  if (params.symbolRef) addSymbolRef(params.symbolRef);
  for (const symbolRef of arrayParam(/** @type {any} */ (params).symbolRefs)) addSymbolRef(symbolRef);

  return requests;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arrayParam(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, ref: any } | { ok: false, message: string }}
 */
function normalizeBatchSymbolRef(value) {
  if (!isPlainRecord(value)) {
    return { ok: false, message: "symbolRef must be a plain object" };
  }
  const validKeys = new Set(["name", "file", "kind", "exportedOnly"]);
  for (const [key, child] of Object.entries(value)) {
    if (!validKeys.has(key) && child !== undefined) {
      return { ok: false, message: `symbolRef contains unsupported field ${key}` };
    }
    if (containsNonPlainObject(child)) {
      return { ok: false, message: `symbolRef field ${key} must be JSON-plain` };
    }
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return { ok: false, message: "symbolRef.name is required" };
  const ref = { name };
  if (typeof record.file === "string" && record.file.trim()) ref.file = record.file.trim();
  if (typeof record.kind === "string" && record.kind.trim()) ref.kind = record.kind.trim();
  if (typeof record.exportedOnly === "boolean") ref.exportedOnly = record.exportedOnly;
  return { ok: true, ref };
}

/**
 * @param {unknown} value
 */
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 */
function containsNonPlainObject(value) {
  if (value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsNonPlainObject(item));
  if (!isPlainRecord(value)) return true;
  return Object.values(value).some((item) => containsNonPlainObject(item));
}

/**
 * @param {any} ref
 */
function stableRefKey(ref) {
  const out = {};
  for (const key of ["name", "file", "kind", "exportedOnly"]) {
    if (ref[key] !== undefined) out[key] = ref[key];
  }
  return JSON.stringify(out);
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
 * @param {{
 *   repoRoot?: string,
 *   sessionId?: string,
 *   target: { entry: any, symbol: ViewSymbol },
 *   minCallConfidence: number,
 *   includeResolutionMetadata: boolean,
 * }} args
 * @returns {SymbolCard}
 */
async function buildOverlayCard({ repoRoot, sessionId, target, minCallConfidence, includeResolutionMetadata }) {
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
  const overlaySymbols = await getOverlaySymbols({ repoRoot, sessionId });
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
