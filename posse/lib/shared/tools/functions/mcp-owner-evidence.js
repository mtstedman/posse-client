import { isResearchWorkBudgetBlock } from "../../../domains/research/functions/work-budget.js";
import { effectiveAtlasResearchAction, OWNER_MODEL_CONTROL_NOTICES } from "./planner-triage.js";
import crypto from "node:crypto";
import { isResearchAtlasExplorationAction } from "../../../domains/integrations/functions/deterministic-mcp/research-synthesis.js";
import path from "node:path";
import { sourceSelectorFingerprint } from "../../../domains/research/classes/SourceCoverageOwner.js";
import { recordObservation } from "../../../domains/observability/functions/observations.js";
import { requestedToolPolicyName } from "./mcp-owner-tool-policy.js";

export const OWNER_EVIDENCE_IDENTITY_VERSION = 2;

const OWNER_EVIDENCE_IDENTITY_MAX = 64;

// 10-line quantization of delivered source ranges. Fine enough that a window
// extending a few lines past prior coverage still mints a new identity; coarse
// enough that a full window stays within OWNER_EVIDENCE_IDENTITY_MAX blocks.
const OWNER_SOURCE_RANGE_BLOCK_LINES = 10;

const OWNER_EVIDENCE_KEY_NAMES = new Set([
  "content_hash",
  "contentHash",
  "file",
  "filePath",
  "path",
  "repo_rel_path",
  "repoRelPath",
  "qualifiedName",
  "symbolId",
  "symbol_id",
]);

const OWNER_EVIDENCE_COLLECTION_KEYS = new Set([
  "cards",
  "candidateFiles",
  "edges",
  "files",
  "items",
  "matches",
  "symbols",
]);

const OWNER_EVIDENCE_MATERIAL_KEY_NAMES = new Set([
  "body",
  "content",
  "signature",
  "snippet",
  "sourceText",
  "source_text",
  "text",
]);

const OWNER_SOURCE_BEARING_ACTIONS = new Set([
  "code.lens",
  "code.window",
  "symbol.get",
  "file.read",
]);

function ownerResultTextWithoutControls(result = null) {
  let text = Array.isArray(result?.content)
    ? result.content.filter((entry) => !isResearchWorkBudgetBlock(entry, result))
      .map((entry) => typeof entry?.text === "string" ? entry.text : "").join("\n")
    : "";
  for (const notice of result?.[OWNER_MODEL_CONTROL_NOTICES] || []) {
    const noticeText = String(notice?.text || "");
    if (noticeText) text = text.replace(noticeText, "");
  }
  return text.trim();
}

function normalizedEvidenceDigestValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => normalizedEvidenceDigestValue(item, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      if (/^(?:_?meta|runtimeTelemetry|timings?|duration|created_at|updated_at)$/i.test(childKey)) continue;
      if (/^(?:evidence_ref|traversal_ref|next_traversal_ref|nextTraversalRef|view_ref|surveyRef|ref)$/i.test(childKey)) continue;
      out[childKey] = normalizedEvidenceDigestValue(value[childKey], childKey);
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/#[0-9a-z]{4,64}\b/gi, "#ref")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
  }
  void key;
  return value;
}

function collectOwnerEvidenceIdentities(value, identities, key = "", depth = 0) {
  if (depth > 8 || identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      collectOwnerEvidenceIdentities(item, identities, key, depth + 1);
      if (identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) break;
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (OWNER_EVIDENCE_KEY_NAMES.has(childKey) && childValue != null) {
      const normalized = String(childValue).replace(/\\/g, "/").trim().toLowerCase();
      if (normalized) identities.add(`${childKey.toLowerCase()}:${normalized.slice(0, 240)}`);
    }
    if (OWNER_EVIDENCE_MATERIAL_KEY_NAMES.has(childKey) && typeof childValue === "string") {
      const normalized = childValue.replace(/\r\n?/g, "\n").trim();
      if (normalized) {
        identities.add(
          `material:${childKey.toLowerCase()}:sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`,
        );
      }
    }
    if (OWNER_EVIDENCE_COLLECTION_KEYS.has(childKey) || (childValue && typeof childValue === "object")) {
      collectOwnerEvidenceIdentities(childValue, identities, childKey, depth + 1);
    }
    if (identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) break;
  }
  void key;
}

/**
 * @param {{
 *   session?: any,
 *   toolName?: string,
 *   toolArgs?: Record<string, any>,
 *   result?: any,
 *   outcome?: string,
 * }} [input]
 */
export function ownerAtlasEvidenceIdentities({ session, toolName, toolArgs, result, outcome } = {}) {
  const role = String(session?.bootConfig?.role || "");
  const action = effectiveAtlasResearchAction(requestedToolPolicyName(toolName, toolArgs));
  if (role !== "researcher" || !isResearchAtlasExplorationAction(action)) return null;
  if (outcome !== "succeeded" || result?.isError === true) return [];

  const text = ownerResultTextWithoutControls(result);
  if (!text || /^(?:Error:|AUDIT ERROR:)/i.test(text)) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain source evidence */ }
  if (
    parsed?.ok === false
    || parsed?.found === false
    || parsed?.duplicateSuppressed === true
    || parsed?.alreadySurfaced === true
    || parsed?.structureAlreadyVisible === true
    || String(parsed?.status || "").toLowerCase() === "covered"
  ) {
    return [];
  }

  const identities = new Set();
  collectOwnerEvidenceIdentities(parsed, identities);
  collectOwnerEvidenceIdentities(result?._meta?.atlasArtifacts, identities);
  collectOwnerEvidenceIdentities(result?._meta?.atlasBatch, identities);

  const hasStructuredMaterial = identities.size > 0 || (() => {
    if (!parsed || typeof parsed !== "object") return text.length > 0;
    for (const key of OWNER_EVIDENCE_COLLECTION_KEYS) {
      if (Array.isArray(parsed?.[key]) && parsed[key].length > 0) return true;
      if (Array.isArray(parsed?.data?.[key]) && parsed.data[key].length > 0) return true;
    }
    return [parsed.text, parsed.content, parsed.source, parsed.data?.text, parsed.data?.content]
      .some((value) => typeof value === "string" && value.length > 0);
  })();
  if (!hasStructuredMaterial) return [];

  // Stable paths/symbols and exact evidence-bearing source fields are the
  // monotonic novelty contract. A whole-result digest is fallback-only:
  // ranking scores, result order, pagination, and request echo fields may
  // legitimately change while returning no new repository evidence.
  if (identities.size === 0) {
    let digestSource;
    try {
      digestSource = parsed == null
        ? text.replace(/#[0-9a-z]{4,64}\b/gi, "#ref")
        : JSON.stringify(normalizedEvidenceDigestValue(parsed));
    } catch {
      digestSource = text.replace(/#[0-9a-z]{4,64}\b/gi, "#ref");
    }
    identities.add(`result:sha256:${crypto.createHash("sha256").update(digestSource).digest("hex")}`);
  }
  return [...identities].slice(0, OWNER_EVIDENCE_IDENTITY_MAX);
}

export function normalizedOwnerSourcePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

function collectOwnerSourcePaths(value, paths, depth = 0) {
  if (depth > 8 || paths.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectOwnerSourcePaths(item, paths, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["repo_rel_path", "repoRelPath"].includes(key)) {
      const sourcePath = normalizedOwnerSourcePath(child);
      if (sourcePath) paths.add(sourcePath);
    }
    if (child && typeof child === "object") collectOwnerSourcePaths(child, paths, depth + 1);
  }
}

function collectOwnerSymbolSourcePaths(value, mappings, depth = 0) {
  if (depth > 8 || mappings.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectOwnerSymbolSourcePaths(item, mappings, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const symbolId = String(value.symbolId || value.symbol_id || "").trim().toLowerCase();
  const sourcePath = normalizedOwnerSourcePath(
    value.location?.repo_rel_path
      || value.location?.repoRelPath
      || value.sourceExcerpt?.repo_rel_path
      || value.sourceExcerpt?.repoRelPath,
  );
  if (symbolId && sourcePath) mappings.set(symbolId, sourcePath);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectOwnerSymbolSourcePaths(child, mappings, depth + 1);
  }
}

/**
 * @param {{result?:any,outcome?:string|null}} [input]
 */
export function ownerAtlasSymbolSourcePaths({ result, outcome } = {}) {
  if (outcome !== "succeeded" || result?.isError === true) return [];
  const text = ownerResultTextWithoutControls(result);
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const mappings = new Map();
  collectOwnerSymbolSourcePaths(parsed, mappings);
  return [...mappings].slice(0, OWNER_EVIDENCE_IDENTITY_MAX).map(([symbol_id, repo_rel_path]) => ({
    symbol_id,
    repo_rel_path,
  }));
}

/**
 * @param {{
 *   toolName?: string,
 *   toolArgs?: Record<string, unknown>,
 *   result?: Record<string, unknown> | null,
 *   outcome?: string,
 * }} [input]
 */
export function ownerAtlasSourcePaths(input = {}) {
  const { toolName, toolArgs, result, outcome } = input;
  const action = effectiveAtlasResearchAction(requestedToolPolicyName(toolName, toolArgs));
  if (!OWNER_SOURCE_BEARING_ACTIONS.has(action) || outcome !== "succeeded" || result?.isError === true) {
    return null;
  }
  const text = ownerResultTextWithoutControls(result);
  if (!text || /^(?:Error:|AUDIT ERROR:)/i.test(text)) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* bounded or plain-text source result */ }
  if (String(parsed?.status || parsed?.data?.status || "").toLowerCase() === "covered") return [];
  const paths = new Set();
  const requestedPath = normalizedOwnerSourcePath(toolArgs?.file);
  if (requestedPath) paths.add(requestedPath);
  collectOwnerSourcePaths(parsed, paths);
  return [...paths].slice(0, OWNER_EVIDENCE_IDENTITY_MAX);
}

export function sourceSelectionItems(toolArgs = {}) {
  return [toolArgs || {}];
}

// Range-normalized evidence identity for delivered source (staged-plan Stage-5
// lever 2). Content hashes minted a fresh identity for every re-window of an
// already-read file, so the stale-novelty closeout never fired on re-window
// churn. Identities here are quantized line blocks of what this call actually
// delivered: re-delivering seen lines repeats seen identities (stale), while
// any unseen block is novel — including disjoint later ranges of a seen file.
// A delivery longer than OWNER_EVIDENCE_IDENTITY_MAX blocks truncates; the
// bounded failure mode is marking an over-long read stale, never crediting it.
//
// Identity strings deliberately exclude source_version: the same lines must
// map to the same identity whether they were ledgered or derived from the
// response payload, or one path would re-mint the other's blocks as novel.
// A file edited mid-attempt re-reads as seen; research attempts are read-only.
function ownerAddRangeBlocks(identities, relPath, startLine, endLine) {
  const start = Number(startLine);
  const end = Number(endLine);
  if (!relPath || !Number.isFinite(start) || !Number.isFinite(end)) return;
  const firstBlock = Math.max(0, Math.floor((Math.min(start, end) - 1) / OWNER_SOURCE_RANGE_BLOCK_LINES));
  const lastBlock = Math.max(firstBlock, Math.floor((Math.max(start, end) - 1) / OWNER_SOURCE_RANGE_BLOCK_LINES));
  for (let block = firstBlock; block <= lastBlock; block += 1) {
    if (identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) break;
    identities.add(`lines:${relPath}:${block}`);
  }
}

export function ownerSourceRangeEvidence(coverageOwner, sinceId, toolArgs) {
  if (!coverageOwner?.db || !coverageOwner?.attemptId) return null;
  let rows;
  try {
    rows = coverageOwner.db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'source.coverage' AND id > ?
      ORDER BY id ASC
    `).all(coverageOwner.attemptId, Math.max(0, Number(sinceId) || 0));
  } catch {
    return null;
  }
  const fingerprint = sourceSelectorFingerprint(toolArgs || {});
  const identities = new Set();
  let sourceChars = 0;
  let deliveredRows = 0;
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
    if (String(detail?.selector_fingerprint || "") !== fingerprint) continue;
    if (detail?.delivery_state !== "delivered") continue;
    if (String(detail?.origin || "").includes("prefetch")
      || String(detail?.origin || "").includes("reuse")) continue;
    deliveredRows += 1;
    sourceChars += Math.max(0, Number(detail?.returned_chars) || 0);
    const relPath = String(detail?.repo_rel_path || "").replace(/\\/g, "/").trim().toLowerCase();
    ownerAddRangeBlocks(identities, relPath, detail?.start_line, detail?.end_line);
  }
  if (deliveredRows === 0) return null;
  return { identities: [...identities], sourceChars };
}

// Fallback range evidence parsed from the response payload itself. The
// coverage ledger misses deliveries whose content is not one contiguous
// on-disk slice — multi-identifier windows stitch several segments — so a
// ledgered join alone leaves those calls on always-novel content hashes.
// The payload's own window ranges carry the same task-blind information.
export function ownerWindowResponseRangeEvidence(result) {
  const text = ownerResultTextWithoutControls(result);
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!data || typeof data !== "object") return null;
  if (String(data.status || "").toLowerCase() === "covered") return null;
  const relPath = String(data.repo_rel_path || "").replace(/\\/g, "/").trim().toLowerCase();
  if (!relPath) return null;
  const windows = [
    ...(typeof data.content === "string" && data.content
      ? [{ content: data.content, startLine: data.startLine, endLine: data.endLine }]
      : []),
    ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : []),
  ];
  const identities = new Set();
  let sourceChars = 0;
  for (const window of windows) {
    if (typeof window?.content !== "string" || !window.content) continue;
    sourceChars += window.content.length;
    ownerAddRangeBlocks(identities, relPath, window.startLine, window.endLine);
  }
  if (identities.size === 0) return null;
  return { identities: [...identities], sourceChars };
}

export function sourceSelectionCoverageCursor(coverageOwner) {
  if (!coverageOwner?.db || !coverageOwner?.attemptId) return 0;
  try {
    return Number(coverageOwner.db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS id
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'source.coverage'
    `).get(coverageOwner.attemptId)?.id || 0);
  } catch {
    return 0;
  }
}

function sourceSelectionCoverageStats(coverageOwner, sinceId, selections) {
  const byFingerprint = new Map(selections.map((selection) => [
    sourceSelectorFingerprint(selection),
    { returnedChars: 0, storedChars: 0, novel: false },
  ]));
  if (!coverageOwner?.db || !coverageOwner?.attemptId) return byFingerprint;
  try {
    const rows = coverageOwner.db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'source.coverage' AND id > ?
      ORDER BY id ASC
    `).all(coverageOwner.attemptId, Math.max(0, Number(sinceId) || 0));
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
      const stats = byFingerprint.get(String(detail?.selector_fingerprint || ""));
      if (!stats) continue;
      stats.returnedChars += Math.max(0, Number(detail?.returned_chars) || 0);
      stats.storedChars += Math.max(0, Number(detail?.stored_chars) || 0);
      if (detail?.novel_source === true || (
        detail?.novel_source !== false
        && Number(detail?.stored_chars) > 0
        && !String(detail?.origin || "").includes("reuse")
      )) stats.novel = true;
    }
  } catch {
    // Compatibility databases may not expose the coverage ledger.
  }
  return byFingerprint;
}

function parsedSourceEvidenceItems(result, selectionCount) {
  const byIndex = new Map();
  const text = result?.content?.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
  if (!text) return byIndex;
  const suffixAt = text.indexOf("\n\n[");
  let parsed;
  try { parsed = JSON.parse(suffixAt >= 0 ? text.slice(0, suffixAt) : text); } catch { return byIndex; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (selectionCount < 1) return byIndex;
  let returnedChars = typeof data?.content === "string" ? data.content.length : 0;
  for (const additional of Array.isArray(data?.additionalWindows) ? data.additionalWindows : []) {
    if (typeof additional?.content === "string") returnedChars += additional.content.length;
  }
  byIndex.set(0, { returnedChars });
  return byIndex;
}

export function coveredSourceSelectionObservation(admission) {
  return {
    outcome: "covered",
    reason: admission?.reason || "covered_reuse",
    reasonClass: "reaccess",
    coverageScope: admission?.coverageScope || admission?.result?.coverage_scope || null,
    coverageOriginJobId: admission?.coverageOrigin?.job_id || admission?.result?.coverage_origin?.job_id || null,
    coverageOriginAttemptId: admission?.coverageOrigin?.attempt_id || admission?.result?.coverage_origin?.attempt_id || null,
    evidenceRef: admission?.result?.reaccess?.ref || admission?.result?.evidence_ref?.ref || null,
  };
}

export function suppressedSourceSelectionObservation(admission, resolvedChars, suppressedChars = resolvedChars) {
  if (admission?.partial === true) {
    return {
      outcome: "executed",
      reason: admission.reason || "overlapping_interval",
      reasonClass: "suppression",
      sourceDeduplicated: true,
      resolvedChars: Math.max(0, Number(resolvedChars) || 0),
      suppressedChars: Math.max(0, Number(suppressedChars) || 0),
    };
  }
  return {
    ...coveredSourceSelectionObservation(admission),
    executed: true,
    sourceSuppressed: true,
    resolvedChars: Math.max(0, Number(resolvedChars) || 0),
  };
}

/**
 * @param {{
 *   session?: any,
 *   toolArgs?: Record<string, any>,
 *   entries?: Array<Record<string, any>>,
 *   coverageOwner?: any,
 *   coverageCursor?: number,
 *   evidenceResult?: any,
 *   action?: string,
 * }} input
 */
export function recordSourceSelectionObservations({
  session,
  toolArgs,
  entries,
  coverageOwner = null,
  coverageCursor = 0,
  evidenceResult = null,
  action = "code.window",
} = {}) {
  const boot = session?.bootConfig || {};
  const selections = sourceSelectionItems(toolArgs);
  const coverageStats = sourceSelectionCoverageStats(coverageOwner, coverageCursor, selections);
  const resultStats = parsedSourceEvidenceItems(evidenceResult, selections.length);
  for (const [index, selection] of selections.entries()) {
    const entry = entries?.[index] || {};
    const outcome = ["executed", "covered", "blocked"].includes(entry.outcome)
      ? entry.outcome
      : "blocked";
    const fingerprint = sourceSelectorFingerprint(selection);
    const coverage = coverageStats.get(fingerprint) || {};
    const returnedChars = outcome === "executed"
      ? Math.max(Number(resultStats.get(index)?.returnedChars) || 0, Number(coverage.returnedChars) || 0)
      : Math.max(0, Number(coverage.returnedChars) || 0);
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "research.source_selection",
      summary: `Source selection ${index + 1} ${outcome}: ${entry.reason || "unspecified"}`,
      detail: {
        version: 1,
        action,
        item_index: index,
        selector_fingerprint: fingerprint,
        attempted: true,
        outcome,
        executed: entry.executed === true || outcome === "executed",
        covered: outcome === "covered",
        blocked: outcome === "blocked",
        novel_source: outcome === "executed" && coverage.novel === true,
        returned_chars: returnedChars,
        stored_chars: entry.storedChars == null
          ? Math.max(0, Number(coverage.storedChars) || 0)
          : Math.max(0, Number(entry.storedChars) || 0),
        reason: entry.reason || "unspecified",
        reason_class: entry.reasonClass || null,
        coverage_scope: entry.coverageScope || null,
        coverage_origin_job_id: entry.coverageOriginJobId || null,
        coverage_origin_attempt_id: entry.coverageOriginAttemptId || null,
        evidence_ref: entry.evidenceRef || null,
        ...(entry.sourceSuppressed === true ? {
          source_suppressed: true,
          resolved_chars: Math.max(0, Number(entry.resolvedChars) || 0),
        } : {}),
        ...(entry.sourceDeduplicated === true ? {
          source_deduplicated: true,
          resolved_chars: Math.max(0, Number(entry.resolvedChars) || 0),
          suppressed_chars: Math.max(0, Number(entry.suppressedChars) || 0),
        } : {}),
        agent_call_id: boot.agentCallId ?? null,
      },
    });
  }
}

export function __testOwnerSourceRangeEvidence(coverageOwner, sinceId, toolArgs) {
  return ownerSourceRangeEvidence(coverageOwner, sinceId, toolArgs);
}

export function __testOwnerWindowResponseRangeEvidence(result) {
  return ownerWindowResponseRangeEvidence(result);
}
