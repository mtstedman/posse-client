// @ts-check
//
// code.getSkeleton / code.getHotPath / code.needWindow handlers.
//
// All three operate on file content. The View knows about symbol byte
// ranges; the actual source has to come from disk. Callers provide a
// `readFile` function so this module stays pure — the dispatcher decides
// where to read from (worktree fs, in-memory fixture, etc.).

import { parseSymbolId, locationOf } from "./cards.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { isCanonicalRepoPath } from "../paths.js";
import { redactSecrets, redactSecretsAsync, redactSecretsLines, redactSecretsLinesAsync } from "./redaction.js";
import { findOverlaySymbol, getOverlaySymbols } from "./buffer.js";
import { sha256Hex } from "../hash.js";
import { getEffectivePolicy } from "./policy.js";
import { buildAstSkeleton, selectSkeletonSymbols } from "./skeleton.js";
import { buildAstHotPath, buildAstHotPathAsync } from "./hotpath.js";
import { annotateCodeLadder, validateCodeLadder } from "./code-ladder.js";

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
export function codeGetSkeleton({ view, versionId, params, readFile, repoRoot }) {
  return codeGetSkeletonWithRedaction({ view, versionId, params, readFile, repoRoot }, redactSecrets);
}

/**
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: CodeGetSkeletonParams,
 *   readFile: ReadFile,
 *   repoRoot?: string,
 * }} args
 */
export async function codeGetSkeletonAsync({ view, versionId, params, readFile, repoRoot }) {
  return await codeGetSkeletonWithRedaction({ view, versionId, params, readFile, repoRoot }, redactSecretsAsync);
}

function codeGetSkeletonWithRedaction({ view, versionId, params, readFile, repoRoot }, redactText) {
  const sessionId = /** @type {any} */ (params).sessionId;
  const ladder = validateCodeLadder({
    action: "code.getSkeleton",
    sessionId,
    symbolId: params.symbolId || null,
    file: params.file || null,
  });
  /** @type {string | null} */
  let targetPath = null;
  let explicitFileRequest = false;
  /** @type {ViewSymbol[]} */
  let symbols = [];
  if (params.symbolId) {
    const resolved = resolveCodeSymbol({ view, symbolId: params.symbolId, repoRoot, sessionId });
    if (resolved.error === "invalid") {
      return errorEnvelope({
        action: "code.getSkeleton",
        versionId,
        code: "invalid_symbol_id",
        message: `Malformed symbolId ${params.symbolId}`,
      });
    }
    const target = resolved.symbol;
    if (!target) {
      return errorEnvelope({
        action: "code.getSkeleton",
        versionId,
        code: "unresolved_symbol",
        message: "Symbol not found",
      });
    }
    targetPath = target.repo_rel_path;
    const overlay = getOverlaySymbols({
      repoRoot,
      sessionId,
      filePath: target.repo_rel_path,
    });
    symbols = overlay.length > 0
      ? overlay.map((item) => item.symbol)
      : view.query.symbolsInFile(target.repo_rel_path);
  } else if (params.file) {
    explicitFileRequest = true;
    if (!isCanonicalRepoPath(params.file)) {
      return errorEnvelope({
        action: "code.getSkeleton",
        versionId,
        code: "invalid_path",
        message: `code.getSkeleton: file must be canonical, got ${params.file}`,
      });
    }
    targetPath = params.file;
    const overlay = getOverlaySymbols({
      repoRoot,
      sessionId,
      filePath: params.file,
    });
    symbols = overlay.length > 0
      ? overlay.map((item) => item.symbol)
      : view.query.symbolsInFile(params.file);
  } else {
    return errorEnvelope({
      action: "code.getSkeleton",
      versionId,
      code: "invalid_params",
      message: "code.getSkeleton requires symbolId or file",
    });
  }

  const filtered = params.exportedOnly
    ? symbols.filter((s) => s.visibility !== "private" && s.visibility !== "protected")
    : symbols;
  const source = targetPath ? readFile(targetPath) : null;
  if (source != null) {
    const astSkeleton = buildAstSkeleton({
      repoRoot,
      file: targetPath,
      source,
      symbols: filtered,
      identifiersToFind: params.identifiersToFind,
      maxLines: params.maxLines,
      maxTokens: params.maxTokens,
    });
    if (astSkeleton.ok) {
      const etag = `sk:${targetPath}:${sha256Hex(source).slice(0, 16)}:${astSkeleton.etagSeed}`;
      if (params.ifNoneMatch && params.ifNoneMatch === etag) {
        return notModifiedEnvelope({ action: "code.getSkeleton", versionId, etag });
      }
      return mapMaybePromise(redactText(astSkeleton.content), (content) => {
        /** @type {CodeSkeletonData} */
        const data = {
          repo_rel_path: targetPath,
          content,
          startLine: astSkeleton.startLine,
          endLine: astSkeleton.endLine,
          truncated: astSkeleton.truncated,
          etag,
        };
        return annotateCodeLadder(okEnvelope({
          action: "code.getSkeleton",
          versionId,
          data,
          meta: { etag },
        }), ladder, { action: "code.getSkeleton", sessionId, symbolId: params.symbolId || null, file: targetPath });
      });
    }
  }

  const maxLines = params.maxLines || 200;
  if (source == null && explicitFileRequest) {
    return errorEnvelope({
      action: "code.getSkeleton",
      versionId,
      code: "file_unreadable",
      message: `Could not read ${targetPath}`,
    });
  }
  const lines = [];
  let truncated = false;
  const fallbackSymbols = selectSkeletonSymbols(filtered, params.identifiersToFind);
  for (const s of fallbackSymbols) {
    const sig = signatureLine(s);
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    lines.push(sig);
  }

  const etag = `sk:${targetPath}:${fallbackSymbols.length}`;
  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "code.getSkeleton", versionId, etag });
  }

  /** @type {CodeSkeletonData} */
  const data = {
    repo_rel_path: targetPath,
    content: lines.join("\n"),
    startLine: 1,
    endLine: lines.length || 1,
    truncated,
    etag,
  };
  return annotateCodeLadder(okEnvelope({
    action: "code.getSkeleton",
    versionId,
    data,
    meta: { etag },
  }), ladder, { action: "code.getSkeleton", sessionId, symbolId: params.symbolId || null, file: targetPath });
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
export function codeGetHotPath({ view, versionId, params, readFile, repoRoot }) {
  return codeGetHotPathWithRedaction({ view, versionId, params, readFile, repoRoot }, {
    buildHotPath: buildAstHotPath,
    redactLines: redactSecretsLines,
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
export async function codeGetHotPathAsync({ view, versionId, params, readFile, repoRoot }) {
  return await codeGetHotPathWithRedaction({ view, versionId, params, readFile, repoRoot }, {
    buildHotPath: buildAstHotPathAsync,
    redactLines: redactSecretsLinesAsync,
  });
}

function codeGetHotPathWithRedaction({ view, versionId, params, readFile, repoRoot }, redaction) {
  const resolved = resolveCodeTarget({ view, params, readFile, repoRoot, action: "code.getHotPath" });
  if (!resolved.ok) return errorEnvelope({ action: "code.getHotPath", versionId, code: resolved.code, message: resolved.message });
  const { source, targetPath, symbolId } = resolved;
  const sessionId = /** @type {any} */ (params).sessionId;
  const ladder = validateCodeLadder({
    action: "code.getHotPath",
    sessionId,
    symbolId: symbolId || null,
    file: targetPath,
  });
  const lines = source.split(/\r?\n/);
  const idents = normalizeIdentifiers(params.identifiersToFind);
  const contextLines = typeof params.contextLines === "number" ? params.contextLines : 2;
  const astHotPath = redaction.buildHotPath({
    repoRoot,
    file: targetPath,
    source,
    target: resolved.target,
    identifiers: idents,
    contextLines,
  });
  return mapMaybePromise(astHotPath, (resolvedAstHotPath) => {
    return finishCodeHotPath({
      versionId,
      params,
      source,
      targetPath,
      symbolId,
      sessionId,
      ladder,
      lines,
      idents,
      contextLines,
      astHotPath: resolvedAstHotPath,
      redactLines: redaction.redactLines,
    });
  });
}

function finishCodeHotPath({ versionId, params, source, targetPath, symbolId, sessionId, ladder, lines, idents, contextLines, astHotPath, redactLines }) {
  if (astHotPath.ok) {
    const etagSeed = symbolId || `${targetPath}:${sha256Hex(source).slice(0, 16)}`;
    const etag = `hp:${etagSeed}:${idents.join(",")}:${astHotPath.etagSeed}`;
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "code.getHotPath", versionId, etag });
    }
    /** @type {CodeHotPathData} */
    const data = {
      ...(symbolId ? { symbolId } : {}),
      repo_rel_path: targetPath,
      matches: astHotPath.matches,
      identifiersFound: astHotPath.identifiersFound,
      identifiersMissing: astHotPath.identifiersMissing,
      etag,
    };
    return annotateCodeLadder(okEnvelope({
      action: "code.getHotPath",
      versionId,
      data,
      meta: { etag },
    }), ladder, { action: "code.getHotPath", sessionId, symbolId: symbolId || null, file: targetPath });
  }
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Array<{ li: number, ident: string }>} */
  const rawMatches = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const ident of idents) {
      if (!ident) continue;
      const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`);
      if (re.test(line)) {
        found.add(ident);
        rawMatches.push({ li, ident });
      }
    }
  }
  // One native redaction call for the whole file instead of one per matched
  // line plus one per context line (each sync call is a process spawn).
  const redactedLines = rawMatches.length > 0 ? redactLines(lines) : lines;
  return mapMaybePromise(redactedLines, (resolvedLines) => {
    /** @type {CodeHotPathData["matches"]} */
    const matches = rawMatches.map(({ li, ident }) => ({
      repo_rel_path: targetPath,
      line: li + 1,
      text: resolvedLines[li],
      identifier: ident,
      context: {
        before: resolvedLines.slice(Math.max(0, li - contextLines), li),
        after: resolvedLines.slice(li + 1, Math.min(lines.length, li + 1 + contextLines)),
      },
    }));
    const missing = idents.filter((i) => !found.has(i));
    const etagSeed = symbolId || `${targetPath}:${sha256Hex(source).slice(0, 16)}`;
    const etag = `hp:${etagSeed}:${idents.join(",")}:${matches.length}`;
    if (params.ifNoneMatch && params.ifNoneMatch === etag) {
      return notModifiedEnvelope({ action: "code.getHotPath", versionId, etag });
    }
    /** @type {CodeHotPathData} */
    const data = {
      ...(symbolId ? { symbolId } : {}),
      repo_rel_path: targetPath,
      matches,
      identifiersFound: [...found].sort(),
      identifiersMissing: missing.sort(),
      etag,
    };
    return annotateCodeLadder(okEnvelope({
      action: "code.getHotPath",
      versionId,
      data,
      meta: { etag },
    }), ladder, { action: "code.getHotPath", sessionId, symbolId: symbolId || null, file: targetPath });
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
export function codeNeedWindow({ view, versionId, params, readFile, repoRoot, ledger, repoId }) {
  return codeNeedWindowWithRedaction({ view, versionId, params, readFile, repoRoot, ledger, repoId }, redactSecrets);
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
export async function codeNeedWindowAsync({ view, versionId, params, readFile, repoRoot, ledger, repoId }) {
  return await codeNeedWindowWithRedaction({ view, versionId, params, readFile, repoRoot, ledger, repoId }, redactSecretsAsync);
}

function codeNeedWindowWithRedaction({ view, versionId, params, readFile, repoRoot, ledger, repoId }, redactText) {
  const resolved = resolveCodeTarget({ view, params, readFile, repoRoot, action: "code.needWindow" });
  if (!resolved.ok) return errorEnvelope({ action: "code.needWindow", versionId, code: resolved.code, message: resolved.message });
  const sessionId = /** @type {any} */ (params).sessionId;
  const ladder = validateCodeLadder({
    action: "code.needWindow",
    sessionId,
    symbolId: resolved.symbolId || null,
    file: resolved.targetPath,
  });
  if (!params.reason || params.reason.trim().length < 3) {
    return errorEnvelope({
      action: "code.needWindow",
      versionId,
      code: "missing_reason",
      message: "code.needWindow requires a proof-of-need reason",
    });
  }
  const policy = getEffectivePolicy(ledger, repoId);
  const identifiers = normalizeIdentifiers(params.identifiersToFind);
  const { source, target, targetPath, symbolId } = resolved;
  if (policy.requireIdentifiers && identifiers.length === 0 && !target) {
    return errorEnvelope({
      action: "code.needWindow",
      versionId,
      code: "missing_identifiers",
      message: "code.needWindow requires identifiersToFind under the active ATLAS policy",
    });
  }
  const window = target
    ? symbolWindow({ source, target, granularity: params.granularity || "symbol" })
    : fileWindow({ source, identifiers, expectedLines: params.expectedLines });
  const policyLimited = limitWindowLines(window, policy.maxWindowLines);
  /** @type {CodeWindowData} */
  const data = {
    ...(symbolId ? { symbolId } : {}),
    repo_rel_path: targetPath,
    content: policyLimited.content,
    startLine: policyLimited.startLine,
    endLine: policyLimited.endLine,
    estimatedTokens: Math.ceil(policyLimited.content.length / 4),
    truncated: policyLimited.truncated,
  };
  const maxTokens = Math.min(
    typeof params.maxTokens === "number" && params.maxTokens > 0 ? params.maxTokens : policy.maxWindowTokens,
    policy.maxWindowTokens,
  );
  if (data.estimatedTokens > maxTokens) {
    const sliceLen = maxTokens * 4;
    data.content = data.content.slice(0, sliceLen);
    data.estimatedTokens = Math.ceil(data.content.length / 4);
    data.truncated = true;
  }
  return mapMaybePromise(redactText(data.content), (content) => {
    data.content = content;
    return annotateCodeLadder(
      okEnvelope({ action: "code.needWindow", versionId, data }),
      ladder,
      { action: "code.needWindow", sessionId, symbolId: resolved.symbolId || null, file: resolved.targetPath },
    );
  });
}

function mapMaybePromise(value, map) {
  if (value && typeof /** @type {any} */ (value).then === "function") {
    return /** @type {any} */ (value).then(map);
  }
  return map(value);
}

function limitWindowLines(window, maxLines) {
  const limit = Number.isFinite(Number(maxLines)) ? Math.max(1, Number(maxLines)) : 500;
  const lines = String(window.content || "").split(/\r?\n/);
  if (lines.length <= limit) return window;
  const kept = lines.slice(0, limit);
  return {
    ...window,
    content: kept.join("\n"),
    endLine: window.startLine + kept.length - 1,
    truncated: true,
  };
}

function symbolWindow({ source, target, granularity }) {
  let content;
  let startByte = target.range_start;
  let endByte = target.range_end;
  if (granularity === "symbol") {
    content = source.slice(startByte, endByte);
  } else if (granularity === "block") {
    const blockStart = source.lastIndexOf("\n", startByte) + 1;
    const blockEnd = source.indexOf("\n", endByte);
    startByte = blockStart;
    endByte = blockEnd < 0 ? source.length : blockEnd;
    content = source.slice(startByte, endByte);
  } else {
    content = source;
    startByte = 0;
    endByte = source.length;
  }
  const loc = locationOf({ ...target, range_start: startByte, range_end: endByte }, { source });
  return { content, startLine: loc.startLine, endLine: loc.endLine, truncated: false };
}

function fileWindow({ source, identifiers, expectedLines }) {
  const lines = source.split(/\r?\n/);
  const targetLines = Math.max(1, Math.min(2000, Number(expectedLines) || 120));
  let center = 0;
  for (let li = 0; li < lines.length; li++) {
    if ((identifiers || []).some((ident) => ident && new RegExp(`\\b${escapeRegExp(ident)}\\b`).test(lines[li]))) {
      center = li;
      break;
    }
  }
  const half = Math.floor(targetLines / 2);
  let start = Math.max(0, center - half);
  let end = Math.min(lines.length, start + targetLines);
  start = Math.max(0, Math.min(start, Math.max(0, end - targetLines)));
  const content = lines.slice(start, end).join("\n");
  return {
    content,
    startLine: start + 1,
    endLine: Math.max(start + 1, end),
    truncated: start > 0 || end < lines.length,
  };
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
  return text.split(/[\s,;]+/u).map((item) => item.trim()).filter(Boolean);
}

function resolveCodeTarget({ view, params, readFile, repoRoot, action }) {
  if (params.symbolId) {
    const resolved = resolveCodeSymbol({ view, symbolId: params.symbolId, repoRoot, sessionId: /** @type {any} */ (params).sessionId });
    if (resolved.error === "invalid") {
      return { ok: false, code: "invalid_symbol_id", message: `Malformed symbolId ${params.symbolId}` };
    }
    const target = resolved.symbol;
    if (!target) return { ok: false, code: "unresolved_symbol", message: "Symbol not found" };
    const source = resolved.entry?.content ?? readFile(target.repo_rel_path);
    if (source == null) return { ok: false, code: "file_unreadable", message: `Could not read ${target.repo_rel_path}` };
    return { ok: true, target, targetPath: target.repo_rel_path, source, symbolId: params.symbolId };
  }

  if (params.file) {
    if (!isCanonicalRepoPath(params.file)) {
      return { ok: false, code: "invalid_path", message: `${action}: file must be canonical, got ${params.file}` };
    }
    const source = readFile(params.file);
    if (source == null) return { ok: false, code: "file_unreadable", message: `Could not read ${params.file}` };
    return { ok: true, target: null, targetPath: params.file, source, symbolId: null };
  }

  return { ok: false, code: "invalid_params", message: `${action} requires symbolId or file` };
}

/**
 * @param {{ view: View, symbolId: string, repoRoot?: string, sessionId?: string }} args
 * @returns {{ symbol: ViewSymbol | null, entry?: any, error?: "invalid" }}
 */
function resolveCodeSymbol({ view, symbolId, repoRoot, sessionId }) {
  const parsed = parseSymbolId(symbolId);
  if (!parsed) return { symbol: null, error: "invalid" };
  const durable = view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
  if (durable) return { symbol: durable };
  const overlay = findOverlaySymbol({ repoRoot, sessionId, symbolId });
  if (overlay) return { symbol: overlay.symbol, entry: overlay.entry };
  return { symbol: null };
}

/**
 * @param {ViewSymbol} sym
 * @returns {string}
 */
function signatureLine(sym) {
  const visibility = sym.visibility ? `${sym.visibility} ` : "";
  const qname = sym.qualified_name || sym.name;
  return `${visibility}${sym.kind} ${qname}`.trim();
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
