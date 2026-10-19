import { getObservationContext } from "../../../observability/functions/observations.js";
import { SourceCoverageOwner } from "../../../research/classes/SourceCoverageOwner.js";

const MAX_INLINE_BODY_LINES = 120;
const renderedLifecycleCoverage = new WeakMap();

function positiveLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function normalizedLines(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

export function normalizeLifecyclePrefetchBody(target, item, requestArgs) {
  const content = normalizedLines(item?.content);
  const targetFile = String(target?.file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const returnedFile = String(item?.repo_rel_path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const fileMatched = targetFile.length > 0 && returnedFile === targetFile;
  const startLine = positiveLine(item?.startLine ?? item?.start_line);
  const endLine = positiveLine(item?.endLine ?? item?.end_line);
  const bounded = item?.truncated === true;
  const outputTruncated = item?.outputTruncated === true;
  const exactRange = startLine != null && endLine != null && endLine >= startLine;
  const identifiersReturned = Array.isArray(item?.identifiersReturned) ? item.identifiersReturned.map(String) : [];
  const identifiersMissing = Array.isArray(item?.identifiersMissing) ? item.identifiersMissing.map(String) : [];
  const identifiersOmitted = Array.isArray(item?.identifiersOmitted) ? item.identifiersOmitted.map(String) : [];
  const requestedIdentifier = String(target?.identifier || "").toLowerCase();
  const identifierMatched = requestedIdentifier.length > 0
    && identifiersReturned.some((identifier) => identifier.toLowerCase() === requestedIdentifier);
  const identifierIncomplete = [...identifiersMissing, ...identifiersOmitted]
    .some((identifier) => identifier.toLowerCase() === requestedIdentifier);
  const requestedSymbolId = String(requestArgs?.symbolId || target?.symbolId || "").trim();
  const returnedSymbolId = String(item?.symbolId || item?.symbol_id || "").trim();
  const symbolReceipt = requestedSymbolId.length > 0 && returnedSymbolId === requestedSymbolId;
  // Identifier-centered windows verify the anchor, not the declaration's end.
  // Only an echoed opaque symbolId proves this was the AST-bounded executable
  // selected by the symbol-level follow-up.
  const exactSelection = symbolReceipt && fileMatched;
  const targetStartLine = positiveLine(target?.startLine);
  const targetEndLine = positiveLine(target?.endLine);
  const targetRangeKnown = targetStartLine != null && targetEndLine != null && targetEndLine >= targetStartLine;
  const targetContained = targetRangeKnown
    && exactRange
    && startLine <= targetStartLine
    && endLine >= targetEndLine;
  // A symbolId window is AST-bounded and reports `truncated: false` only when
  // the exact body survived line/token limits. Identifier-centered windows do
  // not prove an executable end, even when a compact survey guessed one.
  const completeSpan = !bounded;
  const ok = content.length > 0;
  return {
    file: returnedFile || targetFile,
    symbol: target?.symbol || null,
    kind: target?.kind || null,
    families: Array.isArray(target?.families) ? target.families : [],
    focuses: Array.isArray(target?.focuses) ? target.focuses : [],
    reason: target?.reason || null,
    estimatedLines: target?.estimatedLines ?? null,
    ok,
    complete: ok && !outputTruncated && exactRange && exactSelection && completeSpan,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    startLine,
    endLine,
    truncated: bounded,
    outputTruncated,
    selectionBounded: item?.selectionBounded ?? null,
    identifiersReturned,
    identifiersMissing,
    identifiersOmitted,
    identifierMatched,
    identifierIncomplete,
    requestedSymbolId: requestedSymbolId || null,
    returnedSymbolId: returnedSymbolId || null,
    symbolReceipt,
    fileMatched,
    exactSelection,
    targetStartLine,
    targetEndLine,
    targetContained,
    requestArgs,
    coverageSelector: target?.completeSelectorEligible === true && target?.file && target?.identifier ? {
      file: target.file,
      identifiersToFind: [target.identifier],
      granularity: "symbol",
    } : null,
    error: ok ? null : "exact body unavailable",
  };
}

export function lifecycleBodyInlineDecision(body, { maxChars, maxLines = MAX_INLINE_BODY_LINES } = {}) {
  if (!body?.ok) return { inline: false, reason: "unavailable" };
  if (!body.complete) {
    let reason = "unverified_range";
    if (body.outputTruncated) reason = "output_truncated";
    else if (body.exactSelection === false) reason = "unverified_selection";
    else if (body.truncated) reason = "truncated";
    else if (body.targetContained === false) reason = "incomplete_span";
    return { inline: false, reason };
  }
  const content = normalizedLines(body.content);
  const lineCount = content ? content.split("\n").length : 0;
  if (lineCount > Math.max(1, Number(maxLines) || MAX_INLINE_BODY_LINES)) {
    return { inline: false, reason: "line_budget", lineCount };
  }
  if (content.length > Math.max(0, Number(maxChars) || 0)) {
    return { inline: false, reason: "character_budget", lineCount };
  }
  return { inline: true, reason: "complete_exact_body", lineCount };
}

export function lifecycleBodyRenderBudget(trim = 0) {
  if (trim >= 2) return { maxChars: 0, maxLines: MAX_INLINE_BODY_LINES };
  return {
    maxChars: trim >= 1 ? 1400 : 2200,
    maxLines: MAX_INLINE_BODY_LINES,
  };
}

// Developer and fix handoffs render their in-scope files whole. The developer
// edits exactly these files, so a 120-line preview only forces a re-read
// before the first edit (2026-10-19). The per-file and total allowances are
// rendered chars; the total is added to the ATLAS section cap for those
// recipients, and the trim ladder shrinks the bodies before dropping them.
export const ATLAS_SCOPED_BODY_MAX_CHARS_PER_FILE = 32000;
export const ATLAS_SCOPED_BODY_MAX_LINES = 1200;
export const ATLAS_SCOPED_BODY_TOTAL_CHARS = 64000;

function scopedBodyRenderBudget(trim = 0) {
  if (trim >= 3) return { maxChars: 0, maxLines: MAX_INLINE_BODY_LINES };
  if (trim >= 2) return { maxChars: 3200, maxLines: MAX_INLINE_BODY_LINES };
  if (trim >= 1) return { maxChars: 8000, maxLines: 400 };
  return { maxChars: ATLAS_SCOPED_BODY_MAX_CHARS_PER_FILE, maxLines: ATLAS_SCOPED_BODY_MAX_LINES };
}

export function exactPrefetchFileRenderBudget(trim = 0, { scoped = false } = {}) {
  if (scoped) return scopedBodyRenderBudget(trim);
  if (trim >= 3) return { maxChars: 0, maxLines: MAX_INLINE_BODY_LINES };
  return {
    maxChars: trim >= 2 ? 1000 : trim >= 1 ? 1800 : 3200,
    maxLines: MAX_INLINE_BODY_LINES,
  };
}

function normalizedScopedPath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return text ? text.toLowerCase() : "";
}

// Lowercased repo-relative paths whose whole body a dev or fix handoff renders:
// the planner's write scope plus the files it ranked as key context. Other
// recipients get the preview budget.
export function devScopedBodyPaths(packet) {
  if (!packet || typeof packet !== "object") return new Set();
  if (packet.recipient !== "dev" && packet.job_type !== "fix") return new Set();
  const raw = packet._raw_payload && typeof packet._raw_payload === "object" ? packet._raw_payload : {};
  const brief = packet.dev_brief && typeof packet.dev_brief === "object"
    ? packet.dev_brief
    : (raw.dev_brief && typeof raw.dev_brief === "object" ? raw.dev_brief : {});
  const priorities = Array.isArray(brief.planner_file_priorities) ? brief.planner_file_priorities : [];
  const paths = [
    ...(Array.isArray(packet.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(brief.key_files) ? brief.key_files : []),
    ...priorities.map((entry) => entry?.path),
  ].map(normalizedScopedPath).filter(Boolean);
  return new Set(paths);
}

export function exactPrefetchFileInlineDecision(item, { trim = 0, scoped = false } = {}) {
  if (!item?.ok || item.kind !== "read_file" || typeof item.content !== "string" || !item.content) {
    return { inline: false, reason: "unavailable" };
  }
  if (item.truncated === true) return { inline: false, reason: "truncated" };
  const budget = exactPrefetchFileRenderBudget(trim, { scoped });
  const lineCount = item.content.split(/\r?\n/u).length;
  if (lineCount > budget.maxLines) return { inline: false, reason: "line_budget", lineCount };
  if (item.content.length > budget.maxChars) return { inline: false, reason: "character_budget", lineCount };
  return { inline: true, reason: "complete_exact_file", lineCount };
}

export function stageRenderedLifecycleCoverage(packet, { text, trim = 0 } = {}) {
  if (!packet || typeof packet !== "object") return false;
  const renderedText = String(text || "").trim();
  if (!renderedText) return false;
  renderedLifecycleCoverage.set(packet, { text: renderedText, trim: Math.max(0, Number(trim) || 0) });
  return true;
}

export function materializeRenderedLifecycleCoverage(packet, { deliveredPrompt = "", coverageOwner = null } = {}) {
  const rendered = packet && typeof packet === "object" ? renderedLifecycleCoverage.get(packet) : null;
  if (!rendered) return { materialized: 0, skipped: "not_rendered" };
  const promptText = String(deliveredPrompt || "");
  // The remote prompt compiler renders client sections as literal JSON
  // strings, so the exact block may appear either raw or JSON-escaped.
  const encodedText = JSON.stringify(rendered.text).slice(1, -1);
  if (!promptText.includes(rendered.text) && !promptText.includes(encodedText)) {
    return { materialized: 0, skipped: "not_delivered" };
  }
  const context = getObservationContext() || {};
  const attemptId = Number(context.attempt_id) || null;
  const jobId = Number(packet?.job_id ?? context.job_id) || null;
  const workItemId = Number(packet?.work_item_id ?? context.work_item_id) || null;
  if (!coverageOwner && (!attemptId || !jobId || !workItemId || !packet?.cwd)) {
    return { materialized: 0, skipped: "missing_scope" };
  }
  const bodies = packet?.atlas_slice_context?.surveyContext?.lifecycleExpansion?.bodies;
  const exactFiles = packet?.atlas_slice_context?.exactFiles;
  if ((!Array.isArray(bodies) || bodies.length === 0)
    && (!Array.isArray(exactFiles) || exactFiles.length === 0)) {
    return { materialized: 0, skipped: "no_bodies" };
  }
  const budget = lifecycleBodyRenderBudget(rendered.trim);
  const owner = coverageOwner || new SourceCoverageOwner({
    cwd: packet.cwd,
    workItemId,
    jobId,
    attemptId,
    agentCallId: Number(context.agent_call_id) || null,
    repositoryIdentity: packet?.atlas?.repo?.repoId || packet?.atlas?.repo?.repoPath || packet.cwd,
  });
  let materialized = 0;
  for (const body of (Array.isArray(bodies) ? bodies : [])) {
    if (!lifecycleBodyInlineDecision(body, budget).inline || !body.requestArgs) continue;
    const result = owner.materializeData({
      repo_rel_path: body.file,
      startLine: body.startLine,
      endLine: body.endLine,
      content: body.content,
    }, body.requestArgs, {
      origin: "prefetch",
      deliveryState: "delivered",
      completeSymbolSelector: body.coverageSelector,
    });
    if (result) materialized += 1;
  }
  // Complete bounded source files injected into the final prompt are evidence,
  // too. Register only literal read_file payloads whose entire body survives
  // the selected render trim. Skeletons and clipped files remain navigation,
  // never line-level custody.
  const renderedBodies = packet?.atlas_render_exact_bodies && typeof packet.atlas_render_exact_bodies === "object"
    ? packet.atlas_render_exact_bodies
    : null;
  for (const item of (Array.isArray(exactFiles) ? exactFiles : [])) {
    // The renderer records whether each body survived the delivered trim
    // whole (scoped bodies share a total allowance, so the budget alone
    // cannot say). Fall back to the preview decision when nothing was recorded.
    const recorded = renderedBodies ? renderedBodies[normalizedScopedPath(item?.file)] : null;
    const inline = recorded ? recorded.complete === true
      : exactPrefetchFileInlineDecision(item, { trim: rendered.trim }).inline;
    if (!inline) continue;
    const endLine = Math.max(1, Number(item.sourceLines ?? item.totalLines ?? item.returnedLines) || 1);
    const result = owner.materializeData({
      repo_rel_path: item.file,
      startLine: 1,
      endLine,
      content: item.content,
      truncated: false,
      outputTruncated: false,
    }, { file: item.file }, {
      origin: "prefetch",
      deliveryState: "delivered",
      completeSymbolSelector: null,
      tool: "code.window",
    });
    if (result) materialized += 1;
  }
  return { materialized };
}
