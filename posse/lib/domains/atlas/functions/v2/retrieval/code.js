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
      });
    }
    const target = resolved.symbol;
    if (!target) {
      return errorEnvelope({
        action: "code.skeleton",
        versionId,
        code: "unresolved_symbol",
        message: "Symbol not found",
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
    const failure = repoReadFailure(repoRoot, targetPath, "file");
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
  return await codeNeedWindowWithNative({ view, versionId, params, readFile, repoRoot, ledger, repoId }, codeWindowNative);
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
      return { ok: false, code: "invalid_symbol_id", message: `Malformed symbolId ${params.symbolId}` };
    }
    const target = resolved.symbol;
    if (!target) return { ok: false, code: "unresolved_symbol", message: "Symbol not found" };
    const source = resolved.entry?.content ?? readFile(target.repo_rel_path);
    if (source == null) return { ok: false, ...repoReadFailure(repoRoot, target.repo_rel_path, "symbolId") };
    return { ok: true, target, targetPath: target.repo_rel_path, source, symbolId: params.symbolId };
  }

  if (params.file) {
    if (!isCanonicalRepoPath(params.file)) {
      return { ok: false, code: "invalid_path", message: `${action}: file must be canonical, got ${params.file}` };
    }
    const source = readFile(params.file);
    if (source == null) return { ok: false, ...repoReadFailure(repoRoot, params.file, "file") };
    return { ok: true, target: null, targetPath: params.file, source, symbolId: null };
  }

  return { ok: false, code: "invalid_params", message: `${action} requires symbolId or file` };
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
