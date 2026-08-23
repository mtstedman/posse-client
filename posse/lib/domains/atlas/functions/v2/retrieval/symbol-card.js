// @ts-check
//
// symbol.card handler. Resolves the symbol by ID or ref and produces
// a SymbolCard envelope.

import fs from "node:fs";
import path from "node:path";

import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { bareSymbolCard, buildSymbolCard, parseSymbolId, symbolIdOf, etagOf, locationOf, symbolHit } from "./cards.js";
import { applyDbAccessToCard } from "./db-symbol-access.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { findOverlaySymbol, findOverlaySymbolByRef, getOverlaySymbols } from "./buffer.js";
import { getEffectivePolicy } from "./policy.js";
import { recordPrefetchAccess } from "./prefetch.js";
import { splitEditableLines } from "../../../../../shared/tools/functions/toolkit/structured-read.js";
import { CONTEXT_SYMBOL_CARD_SELF_BOUND_CHARS } from "../../../../../catalog/context.js";

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
    const selectedSymbolId = /** @type {string} */ (params.symbolId);
    const parsed = parseSymbolId(selectedSymbolId);
    if (!parsed) {
      return errorEnvelope({
        action: "symbol.card",
        versionId,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${selectedSymbolId}`,
      });
    }
    target = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (!target) {
      overlayTarget = await findOverlaySymbol({ repoRoot, sessionId, symbolId: selectedSymbolId });
    }
  } else if (params.symbolRef) {
    const ref = /** @type {import("../contracts/tool-params.js").SymbolRef} */ (params.symbolRef);
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
      overlayTarget = await findOverlaySymbolByRef({ repoRoot, sessionId, ref });
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
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "symbol.card", versionId, etag });
    }
    return finishCardEnvelope({
      action: "symbol.card",
      versionId,
      card,
      meta: { etag },
      repoRoot,
      sourceText: overlayTarget.entry.content,
    });
  }

  const effectiveRepoId = effectiveRepo(repoId);
  const minCallConfidence = params.minCallConfidence ?? getEffectivePolicy(ledger, effectiveRepoId).defaultMinCallConfidence;
  const includeResolutionMetadata = !!params.includeResolutionMetadata;
  const targetSymbol = /** @type {ViewSymbol} */ (target);
  const etag = etagOf(targetSymbol);
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
    return finishCardEnvelope({
      action: "symbol.card",
      versionId,
      card: cachedCard,
      meta: { etag },
      repoRoot,
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

  return finishCardEnvelope({
    action: "symbol.card",
    versionId,
    card,
    meta: { etag },
    repoRoot,
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
      message: "symbol.card requires symbolId or symbolRef as one selector or an array",
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

  return boundSymbolCardEnvelope(okEnvelope({
    action,
    versionId,
    data: {
      cards,
      errors,
      total: requests.length,
      okCount: cards.length,
      returnedCount: cards.length,
      omittedCount: 0,
      errorCount: errors.length,
      partial: cards.length > 0 && errors.length > 0,
    },
  }));
}

function finishCardEnvelope({ action, versionId, card, meta, repoRoot, sourceText = null }) {
  const materialized = cloneCard(card);
  const sourceExcerpt = sourceExcerptForCard({ repoRoot, card: materialized, sourceText });
  if (sourceExcerpt) materialized.sourceExcerpt = sourceExcerpt;
  return boundSymbolCardEnvelope(okEnvelope({ action, versionId, data: materialized, meta }));
}

function cloneCard(card) {
  return JSON.parse(JSON.stringify(card));
}

function sourceExcerptForCard({ repoRoot, card, sourceText }) {
  const relative = String(card?.location?.repo_rel_path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relative) return null;
  let source = typeof sourceText === "string" ? sourceText : null;
  if (source == null) {
    if (!repoRoot) return null;
    const root = path.resolve(repoRoot);
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
    try { source = fs.readFileSync(absolute, "utf8"); } catch { return null; }
  }
  source = source.replace(/\r\n/g, "\n");
  const lines = splitEditableLines(source).lines;
  const startLine = Math.max(1, Math.floor(Number(card?.location?.startLine) || 1));
  const requestedEnd = Math.max(startLine, Math.floor(Number(card?.location?.endLine) || startLine));
  if (startLine > lines.length) return null;
  const maximumEnd = Math.min(requestedEnd, lines.length, startLine + 119);
  let endLine = maximumEnd;
  let content = lines.slice(startLine - 1, endLine).join("\n");
  while (content.length > 3600 && endLine > startLine) {
    endLine -= 1;
    content = lines.slice(startLine - 1, endLine).join("\n");
  }
  // A partial physical line cannot be registered as exact source coverage.
  if (content.length > 3600) return null;
  if (endLine === lines.length && source.endsWith("\n")) content += "\n";
  return {
    repo_rel_path: relative,
    startLine,
    endLine,
    content,
    truncated: endLine < requestedEnd,
  };
}

/**
 * Keep symbol cards below the transport pager. Counts describe the complete
 * graph neighborhood even when address lists or batch cards are omitted.
 *
 * @param {any} envelope
 * @param {number} [maxChars]
 */
export function boundSymbolCardEnvelope(envelope, maxChars = CONTEXT_SYMBOL_CARD_SELF_BOUND_CHARS) {
  if (!envelope?.data || JSON.stringify(envelope).length <= maxChars) return envelope;
  const data = envelope.data;
  if (Array.isArray(data.cards)) {
    while (data.cards.length > 0 && JSON.stringify(envelope).length > maxChars) data.cards.pop();
    data.returnedCount = data.cards.length;
    data.omittedCount = Math.max(0, Number(data.okCount || 0) - data.cards.length);
    data.truncated = data.omittedCount > 0;
    data.partial = data.partial || data.truncated;
    while (Array.isArray(data.errors) && data.errors.length > 0 && JSON.stringify(envelope).length > maxChars) {
      data.errors.pop();
      data.truncated = true;
    }
    if (JSON.stringify(envelope).length > maxChars) {
      envelope.data = {
        cards: [],
        errors: [],
        total: Number(data.total || 0),
        okCount: Number(data.okCount || 0),
        returnedCount: 0,
        omittedCount: Number(data.okCount || 0),
        errorCount: Number(data.errorCount || 0),
        partial: true,
        truncated: true,
      };
    }
    if (JSON.stringify(envelope).length > maxChars) delete envelope.meta;
    return envelope;
  }

  const card = data;
  for (const key of ["callers", "callees"]) {
    while (Array.isArray(card[key]) && card[key].length > 0 && JSON.stringify(envelope).length > maxChars) {
      card[key].pop();
      card[`${key}Truncated`] = true;
    }
  }
  while (card.sourceExcerpt?.content && card.sourceExcerpt.endLine > card.sourceExcerpt.startLine
    && JSON.stringify(envelope).length > maxChars) {
    const lines = splitEditableLines(card.sourceExcerpt.content).lines;
    lines.pop();
    card.sourceExcerpt.endLine -= 1;
    card.sourceExcerpt.content = lines.join("\n");
    card.sourceExcerpt.truncated = true;
  }
  for (const key of ["deps", "resolution", "summary", "dbAccess"]) {
    if (JSON.stringify(envelope).length <= maxChars) break;
    delete card[key];
    card.truncated = true;
  }
  if (JSON.stringify(envelope).length > maxChars && typeof card.signature === "string") {
    card.signature = `${card.signature.slice(0, 157)}…`;
    card.truncated = true;
  }
  if (JSON.stringify(envelope).length > maxChars) {
    delete card.sourceExcerpt;
    card.truncated = true;
  }
  if (JSON.stringify(envelope).length > maxChars) {
    envelope.data = {
      symbolId: compactCardText(card.symbolId, 96),
      name: compactCardText(card.name, 160),
      ...(card.qualifiedName ? { qualifiedName: compactCardText(card.qualifiedName, 240) } : {}),
      kind: compactCardText(card.kind, 40),
      lang: compactCardText(card.lang, 24),
      location: {
        repo_rel_path: compactCardText(card.location?.repo_rel_path, 320),
        startLine: card.location?.startLine,
        endLine: card.location?.endLine,
      },
      ...(card.signature ? { signature: compactCardText(card.signature, 160) } : {}),
      callerCount: Number(card.callerCount || 0),
      calleeCount: Number(card.calleeCount || 0),
      callers: [],
      callees: [],
      callersTruncated: Number(card.callerCount || 0) > 0,
      calleesTruncated: Number(card.calleeCount || 0) > 0,
      truncated: true,
    };
  }
  if (JSON.stringify(envelope).length > maxChars) delete envelope.meta;
  return envelope;
}

function compactCardText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * @param {SymbolGetCardParams} params
 */
function hasBatchCardParams(params) {
  return Array.isArray(/** @type {any} */ (params).symbolId)
    || Array.isArray(/** @type {any} */ (params).symbolRef)
    || Array.isArray(/** @type {any} */ (params).symbolIds)
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

  for (const symbolId of scalarOrArray(/** @type {any} */ (params).symbolId)) addSymbolId(symbolId);
  for (const symbolId of arrayParam(/** @type {any} */ (params).symbolIds)) addSymbolId(symbolId);

  const addSymbolRef = (value) => {
    const normalized = normalizeBatchSymbolRef(value);
    if (normalized.ok === false) {
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

  for (const symbolRef of scalarOrArray(/** @type {any} */ (params).symbolRef)) addSymbolRef(symbolRef);
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
 * @returns {unknown[]}
 */
function scalarOrArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
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
 * @returns {Promise<SymbolCard>}
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
  const allCalleeEdges = edges
    .filter((edge) => edge.from_content_hash === symbol.content_hash && edge.from_local_id === symbol.local_id)
    .filter((edge) => edge.confidence / 100 >= minCallConfidence);
  card.callees = allCalleeEdges
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
  /** @type {any} */ (card).callerCount = 0;
  /** @type {any} */ (card).calleeCount = allCalleeEdges.length;
  /** @type {any} */ (card).callersTruncated = false;
  /** @type {any} */ (card).calleesTruncated = allCalleeEdges.length > card.callees.length;
  if (includeResolutionMetadata) {
    card.resolution = { confidence: 0.95, method: "buffer-parse" };
  }
  return card;
}
