// @ts-check
//
// code.skeleton / code.lens / code.window handlers.
//
// All three operate on file content. The View knows about symbol byte
// ranges; the actual source has to come from disk. Callers provide a
// `readFile` function so this module stays pure — the dispatcher decides
// where to read from (worktree fs, in-memory fixture, etc.).

import { parseSymbolId, symbolHit } from "./cards.js";
import { okEnvelope, errorEnvelope, notModifiedEnvelope } from "./envelope.js";
import { isCanonicalRepoPath } from "../paths.js";
import { findOverlaySymbol, getOverlaySymbols } from "./buffer.js";
import { getEffectivePolicy } from "./policy.js";
import { normalizeAtlasCodeWindowPolicy } from "../../../../../catalog/atlas-tools.js";
import {
  codeLensNative,
  codeSkeletonNative,
  codeWindowNative,
} from "../native/code-context.js";
import { calledFromBreadcrumbs } from "./usages.js";
import { readRepoFileResult } from "./repo-read.js";
import { redactSecrets } from "./redaction.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").CodeGetSkeletonParams} CodeGetSkeletonParams */
/** @typedef {import("../contracts/tool-params.js").CodeLensParams} CodeLensParams */
/** @typedef {import("../contracts/tool-params.js").CodeNeedWindowParams} CodeNeedWindowParams */
/** @typedef {import("../contracts/tool-results.js").CodeSkeletonData} CodeSkeletonData */
/** @typedef {import("../contracts/tool-results.js").CodeLensData} CodeLensData */
/** @typedef {import("../contracts/tool-results.js").CodeLensMatch} CodeLensMatch */
/** @typedef {import("../contracts/tool-results.js").CodeWindowData} CodeWindowData */

/** @typedef {(path: string) => string | null} ReadFile */

export const MAX_LENS_CONTEXT_LINES_JS = 8;
// Per-call ceiling on match lines plus context. A dense file keeps every
// match; context is trimmed evenly across matches instead, so the occurrence
// map never trades completeness for lines nobody asked about.
export const MAX_LENS_TOTAL_LINES_JS = 600;
const MAX_LENS_SCOPE_SIGNATURE_CHARS = 160;
export const CODE_WINDOW_MAP_MAX_CHARS = 4000;
const CODE_WINDOW_MAP_MAX_REQUESTS = 12;
const CODE_WINDOW_MAP_MAX_TARGETS_PER_REQUEST = 3;
const CODE_WINDOW_MAP_TEXT_MAX_CHARS = 160;

export function normalizeCodeLensContextLines(value) {
  return typeof value === "number" ? Math.min(value, MAX_LENS_CONTEXT_LINES_JS) : 2;
}

/**
 * @param {CodeLensMatch[]} matches
 * @param {number} [maxTotalLines]
 * @returns {{ matches: CodeLensMatch[], contextLinesApplied: number | null, contextTrimmed: boolean }}
 */
export function fitLensContextBudget(matches, maxTotalLines = MAX_LENS_TOTAL_LINES_JS) {
  const rows = Array.isArray(matches) ? matches : [];
  if (rows.length === 0) return { matches: rows, contextLinesApplied: null, contextTrimmed: false };
  const total = rows.reduce((sum, match) => (
    sum + 1 + (match?.context?.before?.length || 0) + (match?.context?.after?.length || 0)
  ), 0);
  if (total <= maxTotalLines) return { matches: rows, contextLinesApplied: null, contextTrimmed: false };
  const perSide = Math.max(0, Math.floor((maxTotalLines - rows.length) / (2 * rows.length)));
  const trimmed = rows.map((match) => {
    const before = Array.isArray(match?.context?.before) ? match.context.before : [];
    const after = Array.isArray(match?.context?.after) ? match.context.after : [];
    return {
      ...match,
      context: {
        before: before.slice(Math.max(0, before.length - perSide)),
        after: after.slice(0, perSide),
      },
    };
  });
  return { matches: trimmed, contextLinesApplied: perSide, contextTrimmed: true };
}

function lineStartOffsets(source) {
  const offsets = [0];
  const text = String(source || "");
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function lineForOffset(offsets, offset) {
  const target = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= target) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Innermost-first index of the file's symbols by line span. Line columns are
 * preferred; legacy rows (line column 1) fall back to the character range.
 *
 * @param {ViewSymbol[]} symbols
 * @param {string} source
 */
export function lensScopeIndex(symbols, source) {
  const offsets = lineStartOffsets(source);
  const entries = [];
  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    if (!symbol || typeof symbol !== "object" || !symbol.name) continue;
    const startLine = Number(symbol.range_start_line) > 1
      ? Number(symbol.range_start_line)
      : lineForOffset(offsets, symbol.range_start);
    const endLine = Number(symbol.range_end_line) > 1
      ? Number(symbol.range_end_line)
      : lineForOffset(offsets, Math.max(0, Number(symbol.range_end) - 1));
    if (!(startLine >= 1) || !(endLine >= startLine)) continue;
    entries.push({ symbol, startLine, endLine, span: endLine - startLine });
  }
  entries.sort((left, right) => left.span - right.span || left.startLine - right.startLine);
  return entries;
}

/**
 * @param {ReturnType<typeof lensScopeIndex>} index
 * @param {number} line
 * @returns {import("../contracts/tool-results.js").CodeLensScope | null}
 */
export function enclosingLensScope(index, line) {
  for (const entry of index) {
    if (line < entry.startLine || line > entry.endLine) continue;
    const signature = String(entry.symbol.signature_text || "").trim();
    return {
      kind: String(entry.symbol.kind || ""),
      name: String(entry.symbol.name || ""),
      ...(entry.symbol.qualified_name ? { qualifiedName: String(entry.symbol.qualified_name) } : {}),
      ...(signature ? { signature: signature.slice(0, MAX_LENS_SCOPE_SIGNATURE_CHARS) } : {}),
      startLine: entry.startLine,
      endLine: entry.endLine,
    };
  }
  return null;
}

function boundedCodeMapText(value) {
  return String(value || "").trim().slice(0, CODE_WINDOW_MAP_TEXT_MAX_CHARS);
}

function normalizedQualifiedIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/::/gu, ".")
    .replace(/[\\/#]/gu, ".")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "");
}

function symbolMatchesRequestedIdentifier(symbol, identifier) {
  const requested = normalizedQualifiedIdentifier(identifier);
  if (!requested) return false;
  const name = normalizedQualifiedIdentifier(symbol?.name);
  const qualifiedName = normalizedQualifiedIdentifier(symbol?.qualified_name);
  return name === requested
    || qualifiedName === requested
    || Boolean(qualifiedName && qualifiedName.endsWith(`.${requested}`));
}

function normalizedInlineRanges(value) {
  const ranges = (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object" && String(entry.content || "").length > 0)
    .map((entry) => ({
      startLine: Math.max(1, Number(entry.startLine) || 1),
      endLine: Math.max(
        Math.max(1, Number(entry.startLine) || 1),
        Number(entry.endLine) || Number(entry.startLine) || 1,
      ),
    }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function targetInlineCoverage(startLine, endLine, inlineRanges) {
  const intersections = [];
  for (const range of inlineRanges) {
    const start = Math.max(startLine, range.startLine);
    const end = Math.min(endLine, range.endLine);
    if (end >= start) intersections.push({ startLine: start, endLine: end });
  }
  if (intersections.length === 0) return { coverage: "none", inlineRanges: [] };
  let cursor = startLine;
  for (const range of intersections) {
    if (range.startLine > cursor) {
      return {
        coverage: "partial",
        inlineRanges: intersections.map((entry) => `${entry.startLine}-${entry.endLine}`),
      };
    }
    cursor = Math.max(cursor, range.endLine + 1);
  }
  return {
    coverage: cursor > endLine ? "full" : "partial",
    inlineRanges: intersections.map((entry) => `${entry.startLine}-${entry.endLine}`),
  };
}

function codeWindowMapTarget(entry, inlineRanges) {
  const hit = symbolHit(entry.symbol);
  const inlineCoverage = targetInlineCoverage(entry.startLine, entry.endLine, inlineRanges);
  return {
    symbolId: hit.symbolId,
    name: boundedCodeMapText(hit.qualifiedName || hit.name),
    kind: boundedCodeMapText(hit.kind),
    lines: [entry.startLine, entry.endLine],
    coverage: inlineCoverage.coverage,
    ...(inlineCoverage.inlineRanges.length > 0
      ? { inlineRanges: inlineCoverage.inlineRanges }
      : {}),
  };
}

function requestedCoverage(targets, textualReturned) {
  if (targets.some((entry) => entry.coverage === "full")) return "full";
  if (targets.some((entry) => entry.coverage === "partial") || textualReturned) return "partial";
  return "none";
}

function codeWindowMapFits(map, maxChars) {
  return JSON.stringify(map).length <= maxChars;
}

/**
 * Build the compact requested-symbol orientation attached to oversized
 * file-mode windows. Every requested identifier inside the request safety
 * limit gets a row before target details consume the remaining map budget.
 * The map describes only source that is actually inline; continuation ranges
 * are deliberately excluded so an indexed address is never mistaken for
 * delivered evidence.
 *
 * @param {{
 *   source:string,
 *   symbols:ViewSymbol[],
 *   identifiers:string[],
 *   identifiersFound:string[],
 *   identifiersReturned:string[],
 *   inlineWindows:Array<{content:string,startLine:number,endLine:number}>,
 *   maxChars?:number,
 * }} args
 */
export function buildCodeWindowMap({
  source,
  symbols,
  identifiers,
  identifiersFound,
  identifiersReturned,
  inlineWindows,
  maxChars = CODE_WINDOW_MAP_MAX_CHARS,
}) {
  const inlineRanges = normalizedInlineRanges(inlineWindows);
  const entries = lensScopeIndex(symbols, source)
    .sort((left, right) => (
      left.startLine - right.startLine
      || left.endLine - right.endLine
      || String(left.symbol.name || "").localeCompare(String(right.symbol.name || ""))
      || Number(left.symbol.local_id || 0) - Number(right.symbol.local_id || 0)
    ));
  const found = new Set(
    [...stringArray(identifiersFound), ...stringArray(identifiersReturned)]
      .map((entry) => entry.toLowerCase()),
  );
  const returned = new Set(stringArray(identifiersReturned).map((entry) => entry.toLowerCase()));
  const requested = [...new Set(stringArray(identifiers))];
  const requestedShown = requested.slice(0, CODE_WINDOW_MAP_MAX_REQUESTS);
  const map = {
    version: /** @type {2} */ (2),
    fileLines: String(source || "").split(/\r?\n/u).length,
    inlineRanges: inlineRanges.map((entry) => `${entry.startLine}-${entry.endLine}`),
    requested: [],
    ...(requested.length > requestedShown.length
      ? { requestedOmitted: requested.length - requestedShown.length }
      : {}),
  };

  const targetWork = [];
  for (const identifier of requestedShown) {
    const normalized = identifier.toLowerCase();
    const matches = entries.filter(({ symbol }) => symbolMatchesRequestedIdentifier(symbol, identifier));
    const candidates = matches
      .slice(0, CODE_WINDOW_MAP_MAX_TARGETS_PER_REQUEST)
      .map((entry) => codeWindowMapTarget(entry, inlineRanges));
    const textualFound = found.has(normalized);
    const textualReturned = returned.has(normalized);
    const item = {
      identifier: boundedCodeMapText(identifier),
      state: matches.length > 0
        ? "indexed"
        : (textualFound ? "textually_found_unindexed" : "absent"),
      coverage: requestedCoverage(candidates, textualReturned),
      targets: [],
      ...(matches.length > 0 ? { targetsOmitted: matches.length } : {}),
    };
    map.requested.push(item);
    targetWork.push({ item, candidates, matches: matches.length });
  }

  // Add one target per request before adding second or third matches. A noisy
  // identifier cannot starve later requested identifiers of their addresses.
  for (let targetIndex = 0; targetIndex < CODE_WINDOW_MAP_MAX_TARGETS_PER_REQUEST; targetIndex += 1) {
    for (const work of targetWork) {
      const candidate = work.candidates[targetIndex];
      if (!candidate) continue;
      work.item.targets.push(candidate);
      const omitted = Math.max(0, work.matches - work.item.targets.length);
      if (omitted > 0) work.item.targetsOmitted = omitted;
      else delete work.item.targetsOmitted;
      if (!codeWindowMapFits(map, maxChars)) {
        work.item.targets.pop();
        work.item.targetsOmitted = work.matches - work.item.targets.length;
      }
    }
  }

  for (const work of targetWork) {
    if (work.item.targets.length === 0) delete work.item.targets;
    if (work.item.targetsOmitted === 0) delete work.item.targetsOmitted;
  }
  return map;
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
 *   params: CodeLensParams,
 *   readFile: ReadFile,
 *   repoRoot?: string,
 * }} args
 */
export async function codeLens({ view, versionId, params, readFile, repoRoot }) {
  return await codeLensWithNative({ view, versionId, params, readFile, repoRoot }, codeLensNative);
}

async function codeLensWithNative({ view, versionId, params, readFile, repoRoot }, buildLens) {
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
  const contextLines = normalizeCodeLensContextLines(params.contextLines);
  // Breadcrumbs for the definitions the agent is actually looking at: the
  // resolved target plus any requested identifiers defined in this file.
  const identSet = new Set(idents.map((ident) => String(ident || "").toLowerCase()));
  const lensTargets = new Map();
  if (resolved.target?.global_id != null) lensTargets.set(resolved.target.global_id, resolved.target);
  const fileSymbols = await view.query.symbolsInFile(targetPath);
  for (const symbol of fileSymbols) {
    if (symbol?.global_id != null && identSet.has(String(symbol.name || "").toLowerCase())) {
      lensTargets.set(symbol.global_id, symbol);
    }
  }
  const calledFrom = await calledFromBreadcrumbs(view, [...lensTargets.values()], { maxSymbols: 4 });
  const resolvedLens = await buildLens({
    repo_rel_path: targetPath,
    source,
    target: resolved.target,
    symbolId,
    identifiersToFind: idents,
    contextLines,
  });
  return await finishCodeLens({
    versionId,
    params,
    targetPath,
    symbolId,
    source,
    lens: resolvedLens,
    calledFrom,
    scopeIndex: lensScopeIndex(fileSymbols, source),
  });
}

async function finishCodeLens({
  versionId, params, targetPath, symbolId, source, lens, calledFrom = [], scopeIndex = [],
}) {
  const etag = String(lens.etag || "");
  if (params.ifNoneMatch && params.ifNoneMatch === etag) {
    return notModifiedEnvelope({ action: "code.lens", versionId, etag });
  }
  const continuationWindows = dedupeCodeWindowSlices([
    ...normalizeCodeWindowSlices(lens._continuationWindows),
    ...await materializeLensContinuationRanges(source, lens._continuationRanges),
  ]);
  // A match is only as useful as the declaration and branch it sits in; the
  // enclosing symbol tells the caller where it is without a source read.
  const scoped = (Array.isArray(lens.matches) ? lens.matches : []).map((match) => {
    if (!match || typeof match !== "object" || match.scope !== undefined) return match;
    const scope = enclosingLensScope(scopeIndex, Number(match.line));
    return scope ? { ...match, scope } : match;
  });
  const fitted = fitLensContextBudget(scoped);
  /** @type {CodeLensData} */
  const data = {
    ...(symbolId ? { symbolId } : {}),
    repo_rel_path: targetPath,
    matches: fitted.matches,
    ...(fitted.contextTrimmed
      ? { contextLinesApplied: fitted.contextLinesApplied, contextTrimmed: true }
      : {}),
    identifiersFound: Array.isArray(lens.identifiersFound) ? lens.identifiersFound : [],
    ...(lens.identifiersFoundInText?.length
      ? { identifiersFoundInText: lens.identifiersFoundInText }
      : {}),
    identifiersMissing: Array.isArray(lens.identifiersMissing) ? lens.identifiersMissing : [],
    truncated: lens.truncated === true,
    omittedMatchCount: Math.max(0, Number(lens.omittedMatchCount) || 0),
    // Private native-to-owner carrier. The hash materializer replaces this
    // with one traversal_ref before the result reaches the model.
    ...(continuationWindows.length > 0 ? { _continuationWindows: continuationWindows } : {}),
    ...(typeof lens.degradedReason === "string" && lens.degradedReason
      ? { degradedReason: lens.degradedReason }
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

async function materializeLensContinuationRanges(source, value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const lines = String(source || "").split(/\r?\n/u);
  const windows = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const startLine = Math.max(1, Math.trunc(Number(entry.startLine || 1)));
    const endLine = Math.min(
      lines.length,
      Math.max(startLine, Math.trunc(Number(entry.endLine || startLine))),
    );
    if (startLine > lines.length) continue;
    windows.push({
      content: await redactSecrets(lines.slice(startLine - 1, endLine).join("\n")),
      startLine,
      endLine,
      identifiers: stringArray(entry.identifiers),
    });
  }
  return windows;
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
 *   config?: Record<string, any>,
 *   findIdentifierRedirects?: (identifiers: string[], requestedFile: string) => Promise<Array<{identifier:string,matches:any[]}>>,
 * }} args
 */
export async function codeNeedWindow({ view, versionId, params, readFile, repoRoot, ledger, repoId, config, findIdentifierRedirects }) {
  if (Array.isArray(/** @type {any} */ (params).items)) {
    return errorEnvelope({
      action: "code.window",
      versionId,
      code: "batching_disabled",
      message: "code.window multi-selection is disabled; issue independent scalar calls together",
    });
  }
  return await codeNeedWindowWithNative({ view, versionId, params, readFile, repoRoot, ledger, repoId, config, findIdentifierRedirects }, codeWindowNative);
}

async function codeNeedWindowWithNative({ view, versionId, params, readFile, repoRoot, ledger, repoId, config, findIdentifierRedirects }, buildWindow) {
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
  const liveCodeWindowPolicy = normalizeAtlasCodeWindowPolicy(policy);
  const snapshottedCodeWindowPolicy = config?.codeWindowPolicy
    ? normalizeAtlasCodeWindowPolicy(config.codeWindowPolicy)
    : liveCodeWindowPolicy;
  // The run snapshot keeps prompt/schema/execution stable. A live policy
  // tightening still wins, so a long-running agent cannot retain a larger
  // window after an operator lowers the repository ceiling.
  const codeWindowPolicy = {
    maxWindowTokens: Math.min(snapshottedCodeWindowPolicy.maxWindowTokens, liveCodeWindowPolicy.maxWindowTokens),
    maxWindowLines: Math.min(snapshottedCodeWindowPolicy.maxWindowLines, liveCodeWindowPolicy.maxWindowLines),
  };
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
    typeof params.maxTokens === "number" && params.maxTokens > 0 ? params.maxTokens : codeWindowPolicy.maxWindowTokens,
    codeWindowPolicy.maxWindowTokens,
  );
  const fileMode = Boolean(params.file && !params.symbolId);
  const oversizedFileMode = Boolean(
    fileMode && source.split(/\r?\n/u).length > codeWindowPolicy.maxWindowLines,
  );
  const fileSymbols = fileMode
    && (identifiers.length > 0 || oversizedFileMode)
    && typeof view.query.symbolsInFile === "function"
    ? await view.query.symbolsInFile(targetPath)
    : [];
  const nativeSelection = nativeIdentifierSelection(identifiers, fileSymbols);
  const result = await buildWindow({
    repo_rel_path: targetPath,
    source,
    target,
    symbolId,
    identifiersToFind: nativeSelection.identifiers,
    expectedLines: positiveInteger(params.expectedLines),
    granularity: params.granularity || "symbol",
    maxWindowLines: codeWindowPolicy.maxWindowLines,
    maxTokens,
  });
  let content = String(result.content || "");
  let startLine = Number(result.startLine || 1);
  let endLine = Number(result.endLine || 1);
  let estimatedTokens = Number(result.estimatedTokens || 0);
  let truncated = result.truncated === true;
  let selectionBounded = result.selectionBounded == null
    ? truncated
    : result.selectionBounded === true;
  let additionalWindows = remapCodeWindowSliceIdentifiers(
    normalizeCodeWindowSlices(result.additionalWindows),
    nativeSelection.aliases,
  );
  let continuationWindows = remapCodeWindowSliceIdentifiers(
    normalizeCodeWindowSlices(result._continuationWindows),
    nativeSelection.aliases,
  );
  const identifiersFound = remapNativeIdentifiers(result.identifiersFound, nativeSelection.aliases);
  const identifiersReturned = remapNativeIdentifiers(result.identifiersReturned, nativeSelection.aliases);
  const indexedIdentifiers = new Set(nativeSelection.indexed.map((entry) => entry.toLowerCase()));
  for (const identifier of nativeSelection.indexed) {
    if (![...identifiersFound, ...identifiersReturned]
      .some((entry) => entry.toLowerCase() === identifier.toLowerCase())) {
      identifiersFound.push(identifier);
    }
  }
  const identifiersMissing = remapNativeIdentifiers(result.identifiersMissing, nativeSelection.aliases)
    .filter((entry) => !indexedIdentifiers.has(entry.toLowerCase()));
  const identifiersOmitted = remapNativeIdentifiers(result.identifiersOmitted, nativeSelection.aliases);
  let identifierRedirects = [];
  /** @type {CodeWindowData["redirect"] | null} */
  let redirect = null;
  /** @type {CodeWindowData["map"] | null} */
  let codeMap = null;
  const matchedIdentifiers = new Set(
    [...identifiersFound, ...identifiersReturned].map((entry) => entry.toLowerCase()),
  );
  const missingIdentifiers = new Set(identifiersMissing.map((entry) => entry.toLowerCase()));
  const wholeFileDelivered = sameWholeFileSource(content, source);
  const allRequestedAnchorsMissed = Boolean(
    fileMode
    && identifiers.length > 0
    && !wholeFileDelivered
    && identifiers.every((entry) => (
      !matchedIdentifiers.has(entry.toLowerCase())
      && missingIdentifiers.has(entry.toLowerCase())
    )),
  );
  if (allRequestedAnchorsMissed) {
    try {
      identifierRedirects = typeof findIdentifierRedirects === "function"
        ? await findIdentifierRedirects(identifiers, targetPath)
        : identifiers.map((identifier) => ({ identifier, matches: [] }));
    } catch {
      identifierRedirects = identifiers.map((identifier) => ({ identifier, matches: [] }));
    }
    const originalWindow = content
      ? [{
          content,
          startLine: Number(result.startLine || 1),
          endLine: Number(result.endLine || result.startLine || 1),
          identifiers: [],
        }]
      : [];
    continuationWindows = dedupeCodeWindowSlices([
      ...originalWindow,
      ...additionalWindows,
      ...continuationWindows,
    ]);
    content = "";
    estimatedTokens = 0;
    truncated = true;
    selectionBounded = true;
    additionalWindows = [];
    redirect = {
      reason: "identifiers_not_in_requested_file",
      requestedFile: targetPath,
      searchedRepository: true,
      nextAction: "code.window",
    };
  } else if (oversizedFileMode) {
    codeMap = buildCodeWindowMap({
      source,
      symbols: fileSymbols,
      identifiers,
      identifiersFound,
      identifiersReturned,
      inlineWindows: [
        ...(content ? [{ content, startLine, endLine }] : []),
        ...additionalWindows,
      ],
    });
  }
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
    content,
    startLine,
    endLine,
    estimatedTokens,
    truncated,
    selectionBounded,
    outputTruncated: result.outputTruncated === true,
    identifiersFound,
    identifiersReturned,
    identifiersMissing,
    identifiersOmitted,
    ...(redirect ? { redirect, identifierRedirects } : {}),
    ...(codeMap ? { map: codeMap } : {}),
    ...(additionalWindows.length > 0 ? { additionalWindows } : {}),
    // Private native-to-owner transport. The hash-ref pager removes this
    // before model delivery and exposes a traversal_ref instead.
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

function nativeIdentifierSelection(requestedIdentifiers, symbols) {
  const identifiers = [];
  const indexed = [];
  const aliases = new Map();
  const seenNative = new Set();
  const seenIndexed = new Set();

  const addNative = (nativeIdentifier, requestedIdentifier) => {
    const native = String(nativeIdentifier || "").trim();
    if (!native) return;
    const normalized = native.toLowerCase();
    if (!seenNative.has(normalized)) {
      seenNative.add(normalized);
      identifiers.push(native);
    }
    const requested = String(requestedIdentifier || "").trim();
    const mapped = aliases.get(normalized) || [];
    if (requested && !mapped.some((entry) => entry.toLowerCase() === requested.toLowerCase())) {
      mapped.push(requested);
    }
    aliases.set(normalized, mapped);
  };

  for (const requested of stringArray(requestedIdentifiers)) {
    const matches = (Array.isArray(symbols) ? symbols : [])
      .filter((symbol) => symbolMatchesRequestedIdentifier(symbol, requested));
    if (matches.length === 0) {
      addNative(requested, requested);
      continue;
    }
    if (!seenIndexed.has(requested.toLowerCase())) {
      seenIndexed.add(requested.toLowerCase());
      indexed.push(requested);
    }
    const declaredNames = [...new Set(matches
      .map((symbol) => String(symbol?.name || "").trim())
      .filter(Boolean))];
    for (const declaredName of declaredNames.length > 0 ? declaredNames : [requested]) {
      addNative(declaredName, requested);
    }
  }

  return { identifiers, indexed, aliases };
}

function remapNativeIdentifiers(value, aliases) {
  const remapped = [];
  const seen = new Set();
  for (const identifier of stringArray(value)) {
    const requested = aliases.get(identifier.toLowerCase()) || [identifier];
    for (const entry of requested) {
      const normalized = entry.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      remapped.push(entry);
    }
  }
  return remapped;
}

function remapCodeWindowSliceIdentifiers(value, aliases) {
  return value.map((entry) => ({
    ...entry,
    identifiers: remapNativeIdentifiers(entry.identifiers, aliases),
  }));
}

function sameWholeFileSource(content, source) {
  const comparable = (value) => {
    const text = String(value || "").replace(/\r\n/gu, "\n");
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  };
  return String(content || "").length > 0 && comparable(content) === comparable(source);
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

function dedupeCodeWindowSlices(value) {
  const seen = new Set();
  return normalizeCodeWindowSlices(value).filter((entry) => {
    const key = `${entry.startLine}:${entry.endLine}:${entry.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
