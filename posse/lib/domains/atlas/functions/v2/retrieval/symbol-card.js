// @ts-check
//
// symbol.card handler. Resolves the symbol by ID or ref and produces
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
        action: "symbol.card",
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
    const card = buildOverlayCard({
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

  const card = buildSymbolCard({
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
