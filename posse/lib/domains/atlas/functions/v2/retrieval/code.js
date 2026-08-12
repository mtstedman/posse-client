// @ts-check
//
// code.skeleton / code.lens / code.window handlers.
//
// All three operate on file content. The View knows about symbol byte
// ranges; the actual source has to come from disk. Callers provide a
// `readFile` function so this module stays pure — the dispatcher decides
// where to read from (worktree fs, in-memory fixture, etc.).

import { parseSymbolId } from "./cards.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { isCanonicalRepoPath } from "../paths.js";
import { findOverlaySymbol, getOverlaySymbols } from "./buffer.js";
import { getEffectivePolicy } from "./policy.js";
import {
  codeHotPathNative,
  codeSkeletonNative,
  codeWindowNative,
} from "../native/code-context.js";
import { calledFromBreadcrumbs } from "./usages.js";
import { readRepoFileResult } from "./repo-read.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").CodeGetSkeletonParams} CodeGetSkeletonParams */
/** @typedef {import("../contracts/tool-params.js").CodeGetHotPathParams} CodeGetHotPathParams */
/** @typedef {import("../contracts/tool-params.js").CodeNeedWindowParams} CodeNeedWindowParams */
/** @typedef {import("../contracts/tool-params.js").CodeWindowItemParams} CodeWindowItemParams */
/** @typedef {import("../contracts/tool-results.js").CodeSkeletonData} CodeSkeletonData */
/** @typedef {import("../contracts/tool-results.js").CodeHotPathData} CodeHotPathData */
/** @typedef {import("../contracts/tool-results.js").CodeWindowData} CodeWindowData */

/** @typedef {(path: string) => string | null} ReadFile */

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: CodeGetSkeletonParams,
 *   readFile: ReadFile,
 *   repoRoot?: string,
 * }} args
 */
export async function codeGetSkeleton({ view, versionId, params, readFile, repoRoot }) {
  return await codeGetSkeletonWithNative({ view, versionId, params, readFile, repoRoot }, codeSkeletonNative);
}

async function codeGetSkeletonWithNative({ view, versionId, params, readFile, repoRoot }, buildSkeleton) {
  const sessionId = /** @type {any} */ (params).sessionId;
  /** @type {string | null} */
  let targetPath = null;
  let explicitFileRequest = false;
  /** @type {ViewSymbol[]} */
  let symbols = [];
  if (params.symbolId) {
    const resolved = await resolveCodeSymbol({ view, symbolId: params.symbolId, repoRoot, sessionId });
    if (resolved.error === "invalid") {
      return errorEnvelope({
        action: "code.skeleton",
        versionId,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${params.symbolId}`,
        details: symbolIdCorrectionDetails("code.skeleton", params),
      });
    }
    const target = resolved.symbol;
    if (!target) {
      return errorEnvelope({
        action: "code.skeleton",
        versionId,
        code: "unresolved_symbol",
        message: "Symbol not found",
        details: symbolIdCorrectionDetails("code.skeleton", params, { wellFormed: true }),
      });
    }
    targetPath = target.repo_rel_path;
    const overlay = await getOverlaySymbols({
      repoRoot,
      sessionId,
      filePath: target.repo_rel_path,
    });
    symbols = overlay.length > 0
      ? overlay.map((item) => item.symbol)
      : await view.query.symbolsInFile(target.repo_rel_path);
  } else if (params.file) {
    explicitFileRequest = true;
    if (!isCanonicalRepoPath(params.file)) {
      return errorEnvelope({
        action: "code.skeleton",
        versionId,
        code: "invalid_path",
        message: `code.skeleton: file must be canonical, got ${params.file}`,
        details: await pathCorrectionDetails(view, params.file, "code.skeleton", params),
      });
    }
    targetPath = params.file;
    const overlay = await getOverlaySymbols({
      repoRoot,
      sessionId,
      filePath: params.file,
    });
    symbols = overlay.length > 0
      ? overlay.map((item) => item.symbol)
      : await view.query.symbolsInFile(params.file);
  } else {
    return errorEnvelope({
      action: "code.skeleton",
      versionId,
      code: "invalid_params",
      message: "code.skeleton requires symbolId or file",
    });
  }

  const filtered = params.exportedOnly
    ? symbols.filter((s) => s.visibility !== "private" && s.visibility !== "protected")
    : symbols;
  const calledFrom = await calledFromBreadcrumbs(view, filtered);
  const source = targetPath ? readFile(targetPath) : null;
  if (source == null && explicitFileRequest) {
    const failure = await repoReadFailureWithSuggestions({
      view,
      repoRoot,
      repoRelPath: targetPath,
      targetSource: "file",
      action: "code.skeleton",
      params,
    });
    return errorEnvelope({
      action: "code.skeleton",
      versionId,
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });
  }
  const result = await buildSkeleton({
    repo_rel_path: targetPath,
    source,
    symbols,
    identifiersToFind: normalizeIdentifiers(params.identifiersToFind),
    exportedOnly: params.exportedOnly === true,
    maxLines: params.maxLines,
    maxTokens: params.maxTokens,
  });
  const etag = String(result.etag || "");
  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "code.skeleton", versionId, etag });
  }
  /** @type {CodeSkeletonData} */
  const data = {
    repo_rel_path: targetPath,
    content: String(result.content || ""),
    startLine: Number(result.startLine || 1),
    endLine: Number(result.endLine || 1),
    truncated: result.truncated === true,
    matchStatus: String(result.matchStatus || ""),
    ...(typeof result.degradedReason === "string" && result.degradedReason
      ? { degradedReason: result.degradedReason }
      : {}),
    ...(calledFrom.length > 0 ? { calledFrom } : {}),
    etag,
  };
  return okEnvelope({
    action: "code.skeleton",
    versionId,
    data,
    meta: { etag },
  });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: CodeGetHotPathParams,
 *   readFile: ReadFile,
 *   repoRoot?: string,
 * }} args
 */
export async function codeGetHotPath({ view, versionId, params, readFile, repoRoot }) {
  return await codeGetHotPathWithNative({ view, versionId, params, readFile, repoRoot }, codeHotPathNative);
}

async function codeGetHotPathWithNative({ view, versionId, params, readFile, repoRoot }, buildHotPath) {
  const resolved = await resolveCodeTarget({ view, params, readFile, repoRoot, action: "code.lens" });
  if (!resolved.ok) return errorEnvelope({
    action: "code.lens",
    versionId,
    code: resolved.code,
    message: resolved.message,
    details: "details" in resolved ? resolved.details : undefined,
  });
  const { source, targetPath, symbolId } = resolved;
  const idents = normalizeIdentifiers(params.identifiersToFind);
  if (idents.length === 0) {
    return errorEnvelope({
      action: "code.lens",
      versionId,
      code: "missing_identifiers",
      message: "code.lens requires at least one identifier in identifiersToFind",
    });
  }
  const contextLines = typeof params.contextLines === "number" ? params.contextLines : 2;
  // Breadcrumbs for the definitions the agent is actually looking at: the
  // resolved target plus any requested identifiers defined in this file.
  const identSet = new Set(idents.map((ident) => String(ident || "").toLowerCase()));
  const lensTargets = new Map();
  if (resolved.target?.global_id != null) lensTargets.set(resolved.target.global_id, resolved.target);
  for (const symbol of await view.query.symbolsInFile(targetPath)) {
    if (symbol?.global_id != null && identSet.has(String(symbol.name || "").toLowerCase())) {
      lensTargets.set(symbol.global_id, symbol);
    }
  }
  const calledFrom = await calledFromBreadcrumbs(view, [...lensTargets.values()], { maxSymbols: 4 });
  const resolvedHotPath = await buildHotPath({
    repo_rel_path: targetPath,
    source,
    target: resolved.target,
    symbolId,
    identifiersToFind: idents,
    contextLines,
  });
  return finishCodeHotPath({
    versionId,
    params,
    targetPath,
    symbolId,
    hotPath: resolvedHotPath,
    calledFrom,
  });
}

function finishCodeHotPath({ versionId, params, targetPath, symbolId, hotPath, calledFrom = [] }) {
  const etag = String(hotPath.etag || "");
  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "code.lens", versionId, etag });
  }
  /** @type {CodeHotPathData} */
  const data = {
    ...(symbolId ? { symbolId } : {}),
    repo_rel_path: targetPath,
    matches: Array.isArray(hotPath.matches) ? hotPath.matches : [],
    identifiersFound: Array.isArray(hotPath.identifiersFound) ? hotPath.identifiersFound : [],
    ...(hotPath.identifiersFoundInText?.length
      ? { identifiersFoundInText: hotPath.identifiersFoundInText }
      : {}),
    identifiersMissing: Array.isArray(hotPath.identifiersMissing) ? hotPath.identifiersMissing : [],
    truncated: hotPath.truncated === true,
    omittedMatchCount: Math.max(0, Number(hotPath.omittedMatchCount) || 0),
    ...(typeof hotPath.degradedReason === "string" && hotPath.degradedReason
      ? { degradedReason: hotPath.degradedReason }
      : {}),
    ...(calledFrom.length > 0 ? { calledFrom } : {}),
    etag,
  };
  return okEnvelope({
    action: "code.lens",
    versionId,
    data,
    meta: { etag },
  });
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: CodeNeedWindowParams,
 *   readFile: ReadFile,
 *   repoRoot?: string,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export async function codeNeedWindow({ view, versionId, params, readFile, repoRoot, ledger, repoId }) {
  if (Array.isArray(params.items)) {
    return await codeNeedWindowBatch({ view, versionId, params, readFile, repoRoot, ledger, repoId });
  }
  return await codeNeedWindowWithNative({ view, versionId, params, readFile, repoRoot, ledger, repoId }, codeWindowNative);
}

async function codeNeedWindowBatch({ view, versionId, params, readFile, repoRoot, ledger, repoId }) {
  const items = params.items.slice(0, 4);
  const policy = getEffectivePolicy(ledger, repoId);
  const policyItemCap = Math.max(64, positiveInteger(policy.maxWindowTokens) || 1200);
  const maximumBatchTokens = policyItemCap * items.length;
  const requestedBatchTokens = positiveInteger(params.maxTokens) || maximumBatchTokens;
  const totalMaxTokens = Math.max(
    64 * items.length,
    Math.min(requestedBatchTokens, maximumBatchTokens),
  );
  const fairItemCap = Math.max(64, Math.floor(totalMaxTokens / items.length));
  const envelopes = await Promise.all(items.map((item) => {
    const requestedItemCap = positiveInteger(item.maxTokens) || fairItemCap;
    return codeNeedWindowWithNative({
      view,
      versionId,
      params: {
        ...item,
        maxTokens: Math.min(requestedItemCap, fairItemCap),
        ...(item.sessionId || !params.sessionId ? {} : { sessionId: params.sessionId }),
      },
      readFile,
      repoRoot,
      ledger,
      repoId,
    }, codeWindowNative);
  }));
  const results = envelopes.map((envelope, index) => ({
    index,
    target: codeWindowItemTarget(items[index]),
    ok: envelope?.ok === true,
    ...(envelope?.ok === true ? { data: envelope.data } : { error: envelope?.error || {
      code: "window_failed",
      message: "code.window batch item returned no result",
    } }),
  }));
  return okEnvelope({
    action: "code.window",
    versionId,
    data: {
      batch: true,
      itemCount: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      totalMaxTokens,
      perItemMaxTokens: fairItemCap,
      items: results,
    },
  });
}

function codeWindowItemTarget(item = {}) {
  return item.symbolId
    ? { symbolId: String(item.symbolId) }
    : { file: String(item.file || "") };
}

async function codeNeedWindowWithNative({ view, versionId, params, readFile, repoRoot, ledger, repoId }, buildWindow) {
  const resolved = await resolveCodeTarget({ view, params, readFile, repoRoot, action: "code.window" });
  if (!resolved.ok) return errorEnvelope({
    action: "code.window",
    versionId,
    code: resolved.code,
    message: resolved.message,
    details: "details" in resolved ? resolved.details : undefined,
  });
  if (!params.reason || params.reason.trim().length < 3) {
    return errorEnvelope({
      action: "code.window",
      versionId,
      code: "missing_reason",
      message: "code.window requires a proof-of-need reason",
    });
  }
  const policy = getEffectivePolicy(ledger, repoId);
  const identifiers = normalizeIdentifiers(params.identifiersToFind);
  const { source, target, targetPath, symbolId } = resolved;
  if (policy.requireIdentifiers && identifiers.length === 0 && !target) {
    return errorEnvelope({
      action: "code.window",
      versionId,
      code: "missing_identifiers",
      message: "code.window requires identifiersToFind under the active ATLAS policy",
    });
  }
  const maxTokens = Math.min(
    typeof params.maxTokens === "number" && params.maxTokens > 0 ? params.maxTokens : policy.maxWindowTokens,
    policy.maxWindowTokens,
  );
  const result = await buildWindow({
    repo_rel_path: targetPath,
    source,
    target,
    symbolId,
    identifiersToFind: identifiers,
    expectedLines: positiveInteger(params.expectedLines),
    granularity: params.granularity || "symbol",
    maxWindowLines: policy.maxWindowLines,
    maxTokens,
  });
  const additionalWindows = normalizeCodeWindowSlices(result.additionalWindows);
  const continuationWindows = normalizeCodeWindowSlices(result._continuationWindows);
  const returnedFunctionAnchors = normalizeReturnedFunctionAnchors(result._returnedFunctionAnchors);
  const ownerSymbols = returnedFunctionAnchors.length > 0
    ? [
        ...(target ? [target] : []),
        ...(typeof view.query.symbolsInFile === "function"
          ? await view.query.symbolsInFile(targetPath)
          : []),
      ]
    : [];
  for (const anchor of returnedFunctionAnchors) {
    const owner = smallestContainingSymbol(ownerSymbols, anchor.rangeStart, anchor.rangeEnd);
    if (owner) anchor.owner = String(owner.qualified_name || owner.name || "").trim();
    anchor.anchor = returnedFunctionAnchorLabel(anchor);
  }
  /** @type {CodeWindowData} */
  const data = {
    ...(symbolId ? { symbolId } : {}),
    repo_rel_path: targetPath,
    content: String(result.content || ""),
    startLine: Number(result.startLine || 1),
    endLine: Number(result.endLine || 1),
    estimatedTokens: Number(result.estimatedTokens || 0),
    truncated: result.truncated === true,
    selectionBounded: result.selectionBounded == null
      ? result.truncated === true
      : result.selectionBounded === true,
    outputTruncated: result.outputTruncated === true,
    identifiersFound: stringArray(result.identifiersFound),
    identifiersReturned: stringArray(result.identifiersReturned),
    identifiersMissing: stringArray(result.identifiersMissing),
    identifiersOmitted: stringArray(result.identifiersOmitted),
    ...(additionalWindows.length > 0 ? { additionalWindows } : {}),
    // Private native-to-owner transport. The hash-ref pager removes this
    // before model delivery and exposes a continuationRef instead.
    ...(continuationWindows.length > 0 ? { _continuationWindows: continuationWindows } : {}),
    // Private native-to-owner transport. The owner materializes each exact
    // callable body once and replaces this carrier with a compact ref map.
    ...(returnedFunctionAnchors.length > 0 ? { _returnedFunctionAnchors: returnedFunctionAnchors } : {}),
    ...(Number(result.returnedFunctionAnchorsOmitted) > 0
      ? { returnedFunctionAnchorsOmitted: Number(result.returnedFunctionAnchorsOmitted) }
      : {}),
  };
  return okEnvelope({ action: "code.window", versionId, data });
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function normalizeCodeWindowSlices(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      content: String(entry.content || ""),
      startLine: Number(entry.startLine || 1),
      endLine: Number(entry.endLine || entry.startLine || 1),
      identifiers: stringArray(entry.identifiers),
    }))
    .filter((entry) => entry.content.length > 0);
}

function normalizeReturnedFunctionAnchors(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      content: String(entry.content || ""),
      startLine: Number(entry.startLine || 1),
      endLine: Number(entry.endLine || entry.startLine || 1),
      rangeStart: Math.max(0, Number(entry.rangeStart) || 0),
      rangeEnd: Math.max(0, Number(entry.rangeEnd) || Number(entry.rangeStart) || 0),
      signature: String(entry.signature || "").trim(),
      callableKind: String(entry.callableKind || "anonymous_function").trim(),
      owner: "",
      anchor: "",
    }))
    .filter((entry) => entry.content.length > 0)
    .filter((entry) => {
      const key = `${entry.rangeStart}:${entry.rangeEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function smallestContainingSymbol(symbols, rangeStart, rangeEnd) {
  return (Array.isArray(symbols) ? symbols : [])
    .filter((symbol) => {
      const start = Number(symbol?.range_start);
      const end = Number(symbol?.range_end);
      return Number.isFinite(start) && Number.isFinite(end)
        && start <= rangeStart && end >= rangeEnd;
    })
    .sort((left, right) => (
      (Number(left.range_end) - Number(left.range_start))
      - (Number(right.range_end) - Number(right.range_start))
    ))[0] || null;
}

function returnedFunctionAnchorLabel(anchor) {
  const signature = anchor.signature || anchor.callableKind || "anonymous function";
  return anchor.owner
    ? `${anchor.owner}::<returned ${signature}>`
    : `<returned ${signature} @ line ${anchor.startLine}>`;
}

function normalizeIdentifiers(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch {
      // Fall through to lightweight splitting below.
    }
  }
  // Preserve declaration/signature phrases such as "fn types" or
  // "pub(crate) fn printer". Splitting legacy scalar input on whitespace
  // silently turned those into broad identifiers ("fn", "types"), causing
  // code.window to anchor on earlier references instead of the requested
  // declaration. Comma/semicolon-delimited legacy lists remain supported.
  return text.split(/[,;]+/u).map((item) => item.trim()).filter(Boolean);
}

async function resolveCodeTarget({ view, params, readFile, repoRoot, action }) {
  if (params.symbolId) {
    const resolved = await resolveCodeSymbol({ view, symbolId: params.symbolId, repoRoot, sessionId: /** @type {any} */ (params).sessionId });
    if (resolved.error === "invalid") {
      return {
        ok: false,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${params.symbolId}`,
        details: symbolIdCorrectionDetails(action, params),
      };
    }
    const target = resolved.symbol;
    if (!target) return {
      ok: false,
      code: "unresolved_symbol",
      message: "Symbol not found",
      details: symbolIdCorrectionDetails(action, params, { wellFormed: true }),
    };
    const source = resolved.entry?.content ?? readFile(target.repo_rel_path);
    if (source == null) return {
      ok: false,
      ...await repoReadFailureWithSuggestions({
        view,
        repoRoot,
        repoRelPath: target.repo_rel_path,
        targetSource: "symbolId",
        action,
        params,
      }),
    };
    return { ok: true, target, targetPath: target.repo_rel_path, source, symbolId: params.symbolId };
  }

  if (params.file) {
    if (!isCanonicalRepoPath(params.file)) {
      return {
        ok: false,
        code: "invalid_path",
        message: `${action}: file must be canonical, got ${params.file}`,
        details: await pathCorrectionDetails(view, params.file, action, params),
      };
    }
    const source = readFile(params.file);
    if (source == null) return {
      ok: false,
      ...await repoReadFailureWithSuggestions({
        view,
        repoRoot,
        repoRelPath: params.file,
        targetSource: "file",
        action,
        params,
      }),
    };
    return { ok: true, target: null, targetPath: params.file, source, symbolId: null };
  }

  return { ok: false, code: "invalid_params", message: `${action} requires symbolId or file` };
}

async function repoReadFailureWithSuggestions({ view, repoRoot, repoRelPath, targetSource, action, params }) {
  const failure = repoReadFailure(repoRoot, repoRelPath, targetSource);
  if (targetSource !== "file") return failure;
  return {
    ...failure,
    details: {
      ...(failure.details || {}),
      ...await pathCorrectionDetails(view, repoRelPath, action, params),
    },
  };
}

async function pathCorrectionDetails(view, requestedPath, action, params = {}) {
  const requested = String(requestedPath || "");
  const normalized = requested.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const candidates = await nearestIndexedPaths(view, normalized);
  const unique = unambiguousPathCandidate(normalized, candidates);
  return {
    invalidField: "file",
    requestedValue: requested,
    expected: "canonical repository-relative indexed path",
    candidates,
    ...(unique ? {
      correctedRequest: {
        action,
        ...codeRequestFields(params),
        file: unique.path,
      },
    } : {}),
  };
}

function symbolIdCorrectionDetails(action, params = {}, { wellFormed = false } = {}) {
  return {
    invalidField: "symbolId",
    requestedValue: String(params.symbolId || ""),
    expected: "opaque ATLAS symbol ID matching <64 lowercase hex chars>:<local integer>",
    retryable: false,
    correctiveAction: {
      action: "symbol.search",
      message: wellFormed
        ? "The issued symbol is no longer resolvable. Search by its real symbol name and reuse the returned symbolId."
        : "Do not construct symbolId values. Search by the real symbol name, or use file for a known repository path.",
    },
    originalAction: action,
  };
}

function codeRequestFields(params = {}) {
  const allowed = [
    "reason",
    "identifiersToFind",
    "expectedLines",
    "granularity",
    "maxTokens",
    "exportedOnly",
    "maxLines",
    "ifNoneMatch",
    "sessionId",
    "surveyGap",
  ];
  return Object.fromEntries(allowed
    .filter((key) => params[key] !== undefined)
    .map((key) => [key, params[key]]));
}

async function nearestIndexedPaths(view, requestedPath, limit = 3) {
  if (typeof view?.query?.indexedPaths !== "function") return [];
  let indexed = [];
  try {
    indexed = await view.query.indexedPaths({ limit: 5000 });
  } catch {
    return [];
  }
  const requested = String(requestedPath || "").toLowerCase();
  const requestedBase = requested.split("/").pop() || requested;
  return [...new Set(indexed.map((entry) => String(entry || "")).filter(Boolean))]
    .map((candidate) => {
      const lowered = candidate.toLowerCase();
      const base = lowered.split("/").pop() || lowered;
      const editRatio = levenshteinDistance(requested, lowered) / Math.max(1, requested.length, lowered.length);
      const basenameRatio = levenshteinDistance(requestedBase, base) / Math.max(1, requestedBase.length, base.length);
      const score = Math.min(editRatio, basenameRatio + (requestedBase === base ? 0 : 0.15));
      return { path: candidate, score: Number(score.toFixed(3)) };
    })
    .filter((candidate) => candidate.score <= 0.55)
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, limit));
}

function unambiguousPathCandidate(normalizedRequested, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const exact = candidates.find((candidate) => candidate.path.toLowerCase() === normalizedRequested.toLowerCase());
  if (exact) return exact;
  const requestedBase = normalizedRequested.toLowerCase().split("/").pop();
  const sameBase = candidates.filter((candidate) => candidate.path.toLowerCase().split("/").pop() === requestedBase);
  if (sameBase.length === 1) return sameBase[0];
  if (candidates[0].score <= 0.2 && (!candidates[1] || candidates[1].score - candidates[0].score >= 0.2)) {
    return candidates[0];
  }
  return null;
}

function levenshteinDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prior = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        prior[j] + 1,
        prior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prior = current;
  }
  return prior[b.length];
}

function repoReadFailure(repoRoot, repoRelPath, targetSource) {
  const diagnosed = readRepoFileResult(repoRoot, repoRelPath, { targetSource });
  if (diagnosed.ok === false) return diagnosed;
  return {
    code: "file_unreadable",
    message: `Could not read ${repoRelPath}: the configured source reader returned no content`,
    details: {
      status: "failed",
      retryable: false,
      path: repoRelPath,
      targetSource,
      reason: "source_reader_empty",
    },
  };
}

/**
 * @param {{ view: View, symbolId: string, repoRoot?: string, sessionId?: string }} args
 * @returns {Promise<{ symbol: ViewSymbol | null, entry?: any, error?: "invalid" }>}
 */
async function resolveCodeSymbol({ view, symbolId, repoRoot, sessionId }) {
  const parsed = parseSymbolId(symbolId);
  if (!parsed) return { symbol: null, error: "invalid" };
  const durable = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
  if (durable) return { symbol: durable };
  const overlay = await findOverlaySymbol({ repoRoot, sessionId, symbolId });
  if (overlay) return { symbol: overlay.symbol, entry: overlay.entry };
  return { symbol: null };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
