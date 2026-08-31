import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AGENT_HANDOFF_ALIAS_POLICY,
  AGENT_HANDOFF_ASSESSOR_FAIL_EVIDENCE_POLICY,
  AGENT_HANDOFF_LIMITS,
  AGENT_HANDOFF_PLANNER_CONTRACT_KEYS,
  AGENT_HANDOFF_PLANNER_CONTRACT_VERSION,
  AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES,
  AGENT_HANDOFF_PROFILE_POLICY,
  AGENT_HANDOFF_PROTOCOL,
  AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY,
  AGENT_HANDOFF_WORK_ITEM_CONTRACT_ERROR,
} from "../../../catalog/handoff.js";
import { HASH_REF_ALIAS_PATTERN, normalizeHashRefAlias } from "../../../catalog/hash-store.js";
import { ARTIFICER_COMPLETION_STATUSES, DEV_COMPLETION_STATUSES } from "../../../catalog/native-tools.js";
import {
  fetchHashRefForContext,
  findFetchedHashRefViewsForContext,
  findVisibleHashRefSourceWindowsForContext,
  materializeHashRefEvidenceForContext,
  surfaceHashRefForContext,
} from "../../queue/functions/hash-refs.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { createAgentHandoffPacketTable, getDb } from "../../../shared/storage/functions/index.js";
import {
  hashRefModelVisibility,
  hashRefModelVisibleScope,
} from "../../../shared/tools/functions/fetch-ref-policy.js";
import {
  resolveDeterministicReadableFile,
} from "../../../shared/tools/functions/toolkit/path-policy.js";
import { splitEditableLines } from "../../../shared/tools/functions/toolkit/structured-read.js";
import {
  canonicalEvidenceSourcePath,
  normalizedEvidenceSourceWindow,
} from "../../../shared/tools/functions/source-evidence.js";
import { validatePlannedTask } from "../../planning/functions/plan-routing.js";
import { validatePlannerPacketFileKinds } from "../../planning/functions/scope-reconciliation.js";
import { validateScopedPath } from "../../../shared/scope/functions/validation.js";
import {
  detectSensitiveAgentHandoffText,
  findCopiedAgentHandoffEvidence,
} from "./agent-handoff-boundaries.js";
import { redactString } from "../../bridge/functions/redaction.js";
import {
  normalizePlannerReportMetadata,
  normalizeResearchData,
  PLANNER_REPORT_METADATA_KEYS,
  structuredStringLength,
} from "./helpers/terminal-report-metadata.js";
import {
  filterKnownHandoffFields,
  runWithHandoffFieldDiagnostics,
} from "./helpers/field-diagnostics.js";
import { normalizeResearchSymbolSeeds } from "./helpers/research-symbols.js";

export { AGENT_HANDOFF_LIMITS, AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";

const PLANNER_TASK_MODES = new Set([
  "code",
  "report",
  "content",
  "image",
  "intake_processing",
  "db",
]);

const PLANNER_REPORT_KEYS = Object.freeze([
  "summary",
  "claims",
  "scope",
  "constraints",
  "success_criteria",
  "questions",
  "research",
  ...PLANNER_REPORT_METADATA_KEYS,
  "payload",
]);

const PLANNER_COMPACT_TASK_KEYS = Object.freeze([
  "id",
  "depends_on",
  ...compatibilityAliasKeys("plannerTaskRole"),
  "intent",
  "summary",
  "claims",
  "scope",
  "constraints",
  "success_criteria",
  ...PLANNER_REPORT_METADATA_KEYS,
]);

const TABLE = "agent_handoff_packets";
const EVIDENCE_MATERIALIZATION_CACHE = Symbol("agent_handoff_evidence_materialization_cache");
const EVIDENCE_CLEANUP = Symbol("agent_handoff_evidence_cleanup");
const READY_DBS = new WeakSet();

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function evidenceSelectorText(selector) {
  if (typeof selector === "string") return selector;
  try { return JSON.stringify(selector); } catch { return String(selector || ""); }
}

function recordEvidenceCleanup(context, {
  action,
  selector,
  normalizedSelector = null,
  code = "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
  message = null,
} = {}) {
  const records = context?.[EVIDENCE_CLEANUP];
  if (!Array.isArray(records) || !action) return;
  const record = {
    action,
    selector: evidenceSelectorText(selector).slice(0, 500),
    ...(normalizedSelector == null ? {} : {
      normalized_selector: evidenceSelectorText(normalizedSelector).slice(0, 500),
    }),
    code,
    ...(message == null ? {} : { message: String(message).slice(0, 500) }),
  };
  const key = JSON.stringify(record);
  if (records.some((entry) => entry.key === key)) return;
  if (records.length < 24) records.push({ key, ...record });
}

function isCleanableEvidenceRangeError(error) {
  return String(error?.code || "") === "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID";
}

// Pipeline handoffs feed the next role, not a human-facing report. A
// reject-and-retry loop on them buys nothing the consumer cannot do itself:
// the planner (or dev) can surface an imperfect citation on its own, so prose
// is redacted rather than rejected and unverifiable selectors demote to
// recorded annotations. Standalone research reports (researcher.report.v1)
// keep report-grade output by moving unsupported claims into a marked summary
// note instead of retrying. Dev results keep strict rejection. Assessor prose
// is redacted, while its defect-evidence selectors retain strict validation.
const LENIENT_PIPELINE_HANDOFF_PROFILES = new Set([
  "researcher.pipeline.v1",
  "planner.plan.v1",
]);

const LENIENT_HANDOFF_PROSE_PROFILES = new Set([
  ...LENIENT_PIPELINE_HANDOFF_PROFILES,
  "assessor.verdict.v1",
]);

function isLenientHandoffProseProfile(profile) {
  return LENIENT_HANDOFF_PROSE_PROFILES.has(String(profile || ""));
}

function alternateEvidenceCleanupAction(error, { lenient = false } = {}) {
  const code = String(error?.code || "");
  if (code === "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID") return "drop_invalid_range";
  if (code === "AGENT_HANDOFF_EVIDENCE_EMPTY") {
    return "drop_whitespace_only_selector_with_alternate_evidence";
  }
  if (code === "AGENT_HANDOFF_EVIDENCE_PATH_NOT_SURFACED") {
    return "drop_unsurfaced_path_with_alternate_evidence";
  }
  if (code === "AGENT_HANDOFF_EVIDENCE_NOT_FOUND") {
    return "drop_invisible_ref_with_alternate_evidence";
  }
  if (lenient && code === "AGENT_HANDOFF_EVIDENCE_NOT_VISIBLE") {
    return "defer_unseen_ref_to_downstream_surface";
  }
  return null;
}

const ADVISORY_RESEARCH_EVIDENCE_ERRORS = new Set([
  "AGENT_HANDOFF_EVIDENCE_CHANGED",
  "AGENT_HANDOFF_EVIDENCE_EMPTY",
  "AGENT_HANDOFF_EVIDENCE_NOT_CITABLE",
  "AGENT_HANDOFF_EVIDENCE_NOT_FOUND",
  "AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED",
  "AGENT_HANDOFF_EVIDENCE_NOT_VISIBLE",
  "AGENT_HANDOFF_EVIDENCE_PATH_AMBIGUOUS",
  "AGENT_HANDOFF_EVIDENCE_PATH_NOT_SURFACED",
  "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
]);

const STRICT_CLAIM_EVIDENCE_RECOVERY_PROFILES = new Set([
  "planner.plan.v1",
  "researcher.report.v1",
]);

const CLAIM_EVIDENCE_DEMOTION = Symbol("claimEvidenceDemotion");

function advisoryResearchEvidenceCleanupAction(error) {
  return ADVISORY_RESEARCH_EVIDENCE_ERRORS.has(String(error?.code || ""))
    ? "drop_advisory_research_selector"
    : null;
}

function strictClaimEvidenceCleanupAction(error) {
  const code = String(error?.code || "");
  if (ADVISORY_RESEARCH_EVIDENCE_ERRORS.has(code)
    || code === "AGENT_HANDOFF_CONTEXT_INVALID"
    || code === "AGENT_HANDOFF_EVIDENCE_TOO_LARGE") {
    return "drop_unverifiable_strict_claim_selector";
  }
  return null;
}

function evidenceRecoveryAction(error, mode) {
  if (mode === "annotate") return advisoryResearchEvidenceCleanupAction(error);
  if (mode === "demote") return strictClaimEvidenceCleanupAction(error);
  return null;
}

function evidenceFailureModeForProfile(profile) {
  if (profile === "researcher.pipeline.v1") return "annotate";
  if (STRICT_CLAIM_EVIDENCE_RECOVERY_PROFILES.has(profile)) return "demote";
  return null;
}

export function isRetryableTerminalHandoffError(error) {
  if (String(error?.code || "") !== "TERMINAL_PROTOCOL_ERROR") return false;
  return /agent_handoff was required but no report was staged|agent_handoff was rejected/i.test(
    String(error?.message || ""),
  );
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function sameCompatibilityValue(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function acceptedFieldAliasPolicy(aliasId) {
  const policy = AGENT_HANDOFF_ALIAS_POLICY.accepted.fieldAliases[aliasId];
  if (!policy) throw new Error(`Unknown agent_handoff compatibility alias policy: ${aliasId}`);
  return policy;
}

function compatibilityAliasKeys(aliasId) {
  const policy = acceptedFieldAliasPolicy(aliasId);
  return [policy.canonical, policy.alias];
}

function uniqueKeys(...groups) {
  return [...new Set(groups.flat())];
}

function compatibilityAlias(source, aliasId, label) {
  const { canonical: canonicalKey, alias: aliasKey } = acceptedFieldAliasPolicy(aliasId);
  const canonicalPresent = source[canonicalKey] != null;
  const aliasPresent = source[aliasKey] != null;
  if (canonicalPresent && aliasPresent
    && !sameCompatibilityValue(source[canonicalKey], source[aliasKey])) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      `${label}.${canonicalKey} conflicts with compatibility alias ${label}.${aliasKey}`,
    );
  }
  return canonicalPresent ? source[canonicalKey] : source[aliasKey];
}

function exactKeys(value, allowed, label) {
  const object = plainObject(value);
  if (!object) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an object`);
  const filtered = filterKnownHandoffFields(object, allowed, label);
  if (filtered) return filtered;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${key} is not allowed`);
  }
  return object;
}

function boundedString(value, label, max, { required = true, lenient = false, context = null } = {}) {
  if (typeof value !== "string") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be a string`);
  const text = value.trim();
  if (required && !text) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  if (text.length > max) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${max} characters`);
  const sensitiveLabel = detectSensitiveAgentHandoffText(text);
  if (sensitiveLabel) {
    if (lenient) {
      // Pipeline prose about credentials (an auth plan naming Bearer/JWT
      // examples) is redacted and committed instead of bounced back to the
      // producer — but only when the deterministic redaction provably
      // neutralizes the match; anything still detected after redaction is
      // rejected exactly as before.
      const redacted = redactString(text);
      if (!detectSensitiveAgentHandoffText(redacted)) {
        recordEvidenceCleanup(context, {
          action: "redact_sensitive_prose",
          selector: label,
          code: "AGENT_HANDOFF_SENSITIVE_CONTENT",
          message: `${label} contained ${sensitiveLabel}; committed with the match redacted`,
        });
        return redacted;
      }
    }
    fail("AGENT_HANDOFF_SENSITIVE_CONTENT", `${label} contains sensitive content (${sensitiveLabel})`);
  }
  return text;
}

function stringArray(value, label, maxItems = 50, maxChars = 1000, options = {}) {
  if (!Array.isArray(value)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an array`);
  if (value.length > maxItems) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${maxItems} items`);
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, maxChars, options));
}

function evidenceSourcePathSyntaxError(value) {
  const raw = String(value || "");
  if (!raw || raw !== raw.trim()) return "evidence selector.path must be a non-empty trimmed path";
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    return "evidence selector.path must be repo-relative, not absolute";
  }
  if (/[\r\n\t]/.test(raw)) return "evidence selector.path must be a single-line path";
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".."
    || normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    return "evidence selector.path must not traverse directories";
  }
  return null;
}

export function parseAgentHandoffEvidenceSelector(value) {
  let ref = null;
  let sourcePath = null;
  let qualifiedPath = null;
  let start = null;
  let end = null;
  if (typeof value === "string") {
    const raw = value.trim();
    const refMatch = raw.toLowerCase().match(/^(#[0-9a-z]{4,12})(?::(?:l)?(\d+)(?:-(?:l)?(\d+))?)?$/);
    const pathMatch = refMatch
      ? null
      : raw.match(/^(.+):(?:l)?(\d+)(?:-(?:l)?(\d+))?$/i);
    if (refMatch) {
      [, ref] = refMatch;
      if (refMatch[2]) {
        start = Number(refMatch[2]);
        end = Number(refMatch[3] || refMatch[2]);
      }
    } else if (pathMatch) {
      sourcePath = String(pathMatch[1] || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      start = Number(pathMatch[2]);
      end = Number(pathMatch[3] || pathMatch[2]);
    } else {
      // Bare paths are useful for inspected binary artifacts, which have no
      // meaningful source line coordinates. Materialization still requires a
      // successful current-call artifact inspection and normal path policy.
      sourcePath = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    }
  } else {
    const selector = exactKeys(value, ["ref", "path", "lines"], "evidence selector");
    if (selector.ref == null && selector.path == null) {
      fail("AGENT_HANDOFF_SELECTOR_INVALID", "Evidence selector must contain ref or path");
    }
    if (selector.ref != null) {
      ref = normalizeHashRefAlias(selector.ref);
      if (selector.path != null) {
        qualifiedPath = String(selector.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      }
    } else {
      sourcePath = String(selector.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    }
    if (selector.lines != null) {
      const lines = exactKeys(selector.lines, ["start", "end", "count"], "evidence selector.lines");
      start = Number(lines.start);
      if (lines.count != null && lines.end != null) {
        fail("AGENT_HANDOFF_SELECTOR_INVALID", `Evidence line range for ${ref} must use count or end, not both`);
      }
      const count = lines.count == null ? null : Number(lines.count);
      end = count == null ? Number(lines.end) : start + count - 1;
      if (count != null && (!Number.isInteger(count) || count < 1 || count > AGENT_HANDOFF_LIMITS.maxSelectorLines)) {
        fail(
          "AGENT_HANDOFF_SELECTOR_INVALID",
          `Evidence line count for ${ref || sourcePath} must be an integer from 1 through ${AGENT_HANDOFF_LIMITS.maxSelectorLines}`,
        );
      }
    }
  }
  if (ref != null && !HASH_REF_ALIAS_PATTERN.test(ref)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid evidence ref: ${String(ref || "")}`);
  }
  if (sourcePath != null) {
    const pathError = evidenceSourcePathSyntaxError(sourcePath);
    if (pathError) fail("AGENT_HANDOFF_SELECTOR_INVALID", pathError);
  }
  if (qualifiedPath != null) {
    const pathError = evidenceSourcePathSyntaxError(qualifiedPath);
    if (pathError) fail("AGENT_HANDOFF_SELECTOR_INVALID", pathError);
    if (start == null) {
      fail("AGENT_HANDOFF_SELECTOR_INVALID", `Path-qualified evidence selector ${ref} requires a line range`);
    }
  }
  if ((start == null) !== (end == null)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Evidence line range must include start and end for ${ref || sourcePath}`);
  }
  if (start != null && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid 1-based inclusive line range for ${ref || sourcePath}`);
  }
  return sourcePath == null
    ? { ref, ...(qualifiedPath == null ? {} : { path: qualifiedPath }), start, end }
    : { path: sourcePath, start, end };
}

function normalizedLines(payload) {
  const text = String(payload ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function canonicalSourcePath(value) {
  return evidenceSourcePathSyntaxError(value) ? null : canonicalEvidenceSourcePath(value);
}

function sourceLineage(entry, context, seen = new Set()) {
  const recorded = String(entry?.metadata?.line_semantics || "").toLowerCase();
  const recordedWindows = (Array.isArray(entry?.metadata?.source_windows)
    ? entry.metadata.source_windows
    : []).map(normalizedEvidenceSourceWindow).filter(Boolean);
  if (recorded === "source" && recordedWindows.length > 0) {
    return {
      line_semantics: "source",
      source_windows: recordedWindows,
      content_entry: entry,
      source_metadata: entry.metadata || {},
    };
  }
  if (recorded === "materialized") {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }

  const source = String(entry?.source || "").trim().toLowerCase();
  if (source !== "agent:create_ref") {
    // Compatibility for refs created before source-window metadata existed:
    // preserve the original stored-result coordinate contract explicitly.
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const sourceRef = normalizeHashRefAlias(entry?.descriptor?.source_ref ?? entry?.metadata?.source_ref);
  const slice = entry?.descriptor?.slice ?? entry?.metadata?.slice;
  if (!sourceRef || !slice || seen.has(sourceRef)) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const fetched = fetchHashRefForContext(context, sourceRef);
  const sourceEntry = fetched?.found ? fetched.entry : null;
  if (!sourceEntry || sourceEntry.entry_kind !== "materialized" || sourceEntry.payload_text == null) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const derived = exactDerivedSlice(sourceEntry.payload_text, slice);
  if (derived == null || derived !== String(entry?.payload_text ?? "")) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const lineMatch = /^lines:(\d+)-(\d+)$/.exec(String(slice));
  if (!lineMatch) return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  const sliceStart = Number(lineMatch[1]);
  const sliceEnd = Number(lineMatch[2]);
  const nextSeen = new Set(seen);
  nextSeen.add(sourceRef);
  const parent = sourceLineage(sourceEntry, context, nextSeen);
  if (parent.line_semantics !== "source") {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const inherited = parent.source_windows.flatMap((window) => {
    if (!Number.isInteger(window.materialized_start_line)
      || !Number.isInteger(window.materialized_end_line)
      || window.materialized_end_line < sliceStart
      || window.materialized_start_line > sliceEnd) return [];
    const materializedStart = Math.max(window.materialized_start_line, sliceStart);
    const materializedEnd = Math.min(window.materialized_end_line, sliceEnd);
    const sourceSpan = window.source_end_line - window.source_start_line;
    const materializedSpan = window.materialized_end_line - window.materialized_start_line;
    if (sourceSpan !== materializedSpan) return [];
    return [{
      ...window,
      source_start_line: window.source_start_line
        + materializedStart - window.materialized_start_line,
      source_end_line: window.source_start_line
        + materializedEnd - window.materialized_start_line,
      materialized_start_line: materializedStart - sliceStart + 1,
      materialized_end_line: materializedEnd - sliceStart + 1,
    }];
  });
  return inherited.length > 0
    ? {
        line_semantics: "source",
        source_windows: inherited,
        content_entry: entry,
        source_metadata: parent.source_metadata || parent.content_entry?.metadata || {},
      }
    : { line_semantics: "materialized", source_windows: [], content_entry: entry };
}

function mergeSourceContentRecords(records) {
  const ordered = records
    .filter((record) => record?.path
      && Number.isInteger(record.source_start_line)
      && Number.isInteger(record.source_end_line)
      && record.source_end_line >= record.source_start_line
      && Array.isArray(record.content_lines)
      && record.content_lines.length === record.source_end_line - record.source_start_line + 1)
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.source_start_line - right.source_start_line
      || left.source_end_line - right.source_end_line
    ));
  const merged = [];
  for (const record of ordered) {
    const prior = merged.at(-1);
    if (!prior || prior.path !== record.path
      || record.source_start_line > prior.source_end_line + 1) {
      merged.push({ ...record, content_lines: [...record.content_lines] });
      continue;
    }
    let compatible = true;
    const overlapEnd = Math.min(prior.source_end_line, record.source_end_line);
    for (let line = record.source_start_line; line <= overlapEnd; line += 1) {
      if (prior.content_lines[line - prior.source_start_line]
        !== record.content_lines[line - record.source_start_line]) {
        compatible = false;
        break;
      }
    }
    if (!compatible) {
      merged.push({ ...record, content_lines: [...record.content_lines] });
      continue;
    }
    const appendFrom = Math.max(0, prior.source_end_line - record.source_start_line + 1);
    prior.content_lines.push(...record.content_lines.slice(appendFrom));
    prior.source_end_line = Math.max(prior.source_end_line, record.source_end_line);
  }
  return merged;
}

function payloadSourceContentWindows(entry, lineage) {
  const payload = String(entry?.payload_text || "");
  // Citation-child delegated excerpts are canonical joins of the source-line
  // array, not raw file bytes. A trailing LF can therefore be the declared
  // final blank source line rather than an ignorable file terminator. Keep it
  // here and let the authoritative materialized window count validate it.
  const payloadLines = entry?.metadata?.source_payload_encoding === "delegated_excerpt"
    ? payload.replace(/\r\n?/g, "\n").split("\n")
    : normalizedLines(payload);
  const authoritative = lineage.source_windows;
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const records = [];
  const add = (sourcePath, sourceStart, content, expectedLineCount = null) => {
    const canonicalPath = canonicalSourcePath(sourcePath);
    const lines = Number.isInteger(expectedLineCount) && expectedLineCount > 0
      ? String(content ?? "").replace(/\r\n?/g, "\n").split("\n")
      : normalizedLines(content);
    if (!canonicalPath || !Number.isInteger(sourceStart) || sourceStart < 1 || lines.length === 0) return;
    if (Number.isInteger(expectedLineCount) && lines.length !== expectedLineCount) return;
    records.push({
      path: canonicalPath,
      source_start_line: sourceStart,
      source_end_line: sourceStart + lines.length - 1,
      content_lines: lines,
    });
  };

  const worktreeHeaderPrefix = "[posse.worktree_evidence.v1 ";
  const worktreeHeader = payloadLines[0] || "";
  if (worktreeHeader.startsWith(worktreeHeaderPrefix) && worktreeHeader.endsWith("]")) {
    try {
      const identity = JSON.parse(worktreeHeader.slice(worktreeHeaderPrefix.length, -1));
      const headerEnd = payload.indexOf("\n");
      const sourceLineCount = Number(identity.end_line) - Number(identity.start_line) + 1;
      add(
        identity.path,
        Number(identity.start_line),
        headerEnd >= 0 ? payload.slice(headerEnd + 1) : "",
        sourceLineCount,
      );
    } catch {
      // Invalid identity headers are not authoritative source content.
    }
  }

  if (parsed?.kind === "posse.worktree_evidence.v1" && typeof parsed.content === "string") {
    add(parsed.path, Number(parsed.start_line), parsed.content);
  }

  const candidates = data && typeof data === "object" ? [
    data,
    ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : []),
    ...(Array.isArray(data.additional_windows) ? data.additional_windows : []),
  ] : [];
  const fallbackPath = data?.repo_rel_path || data?.repoRelPath || data?.path || entry?.metadata?.path;
  for (const candidate of candidates) {
    if (candidate && typeof candidate.content === "string") {
      const sourceStart = Number(candidate.startLine ?? candidate.start_line);
      const sourceEnd = Number(candidate.endLine ?? candidate.end_line);
      const expectedLineCount = Number.isInteger(sourceStart)
        && Number.isInteger(sourceEnd)
        && sourceEnd >= sourceStart
        ? sourceEnd - sourceStart + 1
        : null;
      add(
        candidate.repo_rel_path || candidate.repoRelPath || candidate.path || fallbackPath,
        sourceStart,
        candidate.content,
        expectedLineCount,
      );
    }
  }
  for (const candidate of Array.isArray(data?.requestedWindows) ? data.requestedWindows : []) {
    if (candidate && typeof candidate.content === "string") {
      const sourceStart = Number(candidate.startLine ?? candidate.start_line);
      const sourceEnd = Number(candidate.endLine ?? candidate.end_line);
      const expectedLineCount = Number.isInteger(sourceStart)
        && Number.isInteger(sourceEnd)
        && sourceEnd >= sourceStart
        ? sourceEnd - sourceStart + 1
        : null;
      add(
        candidate.repo_rel_path || candidate.repoRelPath || candidate.path || fallbackPath,
        sourceStart,
        candidate.content,
        expectedLineCount,
      );
    }
  }

  const lensMatches = [
    ...(Array.isArray(data?.matches) ? data.matches : []),
    ...(Array.isArray(data?.tailMatches) ? data.tailMatches : []),
  ];
  if (lensMatches.length > 0) {
    const byPath = new Map();
    for (const match of lensMatches) {
      const sourcePath = canonicalSourcePath(match?.repo_rel_path || match?.repoRelPath || fallbackPath);
      const sourceLine = Number(match?.line);
      if (!sourcePath || !Number.isInteger(sourceLine) || sourceLine < 1 || typeof match?.text !== "string") continue;
      const lineMap = byPath.get(sourcePath) || new Map();
      byPath.set(sourcePath, lineMap);
      const before = Array.isArray(match?.context?.before) ? match.context.before.map(String) : [];
      const after = Array.isArray(match?.context?.after) ? match.context.after.map(String) : [];
      const values = [...before, match.text, ...after];
      const firstLine = Math.max(1, sourceLine - before.length);
      for (const [index, text] of values.entries()) {
        const lineNumber = firstLine + index;
        const prior = lineMap.get(lineNumber);
        if (prior == null) lineMap.set(lineNumber, text);
        else if (prior !== text) lineMap.set(lineNumber, null);
      }
    }
    for (const [sourcePath, lineMap] of byPath) {
      for (const window of authoritative.filter((candidate) => candidate.path === sourcePath)) {
        const lines = [];
        for (let line = window.source_start_line; line <= window.source_end_line; line += 1) {
          const text = lineMap.get(line);
          if (typeof text !== "string") {
            lines.length = 0;
            break;
          }
          lines.push(text);
        }
        if (lines.length > 0) records.push({ ...window, content_lines: lines });
      }
    }
  }

  const uniqueAuthoritativePaths = [...new Set(authoritative.map((window) => window.path))];
  const gutterPath = canonicalSourcePath(entry?.metadata?.path)
    || (uniqueAuthoritativePaths.length === 1 ? uniqueAuthoritativePaths[0] : null);
  let current = null;
  for (const line of normalizedLines(payload)) {
    const matched = /^\s*(\d+)\t(.*)$/.exec(line);
    const sourceLine = Number(matched?.[1]);
    if (!gutterPath || !matched || !Number.isInteger(sourceLine) || sourceLine < 1) {
      current = null;
      continue;
    }
    if (!current || sourceLine !== current.source_end_line + 1) {
      current = {
        path: gutterPath,
        source_start_line: sourceLine,
        source_end_line: sourceLine,
        content_lines: [],
      };
      records.push(current);
    }
    current.source_end_line = sourceLine;
    current.content_lines.push(matched[2]);
  }

  for (const window of authoritative) {
    if (!Number.isInteger(window.materialized_start_line)
      || !Number.isInteger(window.materialized_end_line)) continue;
    const selected = payloadLines.slice(
      window.materialized_start_line - 1,
      window.materialized_end_line,
    );
    const numbered = selected.map((line) => /^\s*(\d+)\t(.*)$/.exec(line));
    if (numbered.length === window.source_end_line - window.source_start_line + 1
      && numbered.every((match, index) => (
        Number(match?.[1]) === window.source_start_line + index
      ))) {
      records.push({
        ...window,
        content_lines: numbered.map((match) => match[2]),
      });
    }
    if (selected.length === window.source_end_line - window.source_start_line + 1) {
      records.push({ ...window, content_lines: selected });
    }
  }

  const mergedRecords = mergeSourceContentRecords(records);
  return authoritative.map((window) => {
    const record = mergedRecords.find((candidate) => (
      candidate.path === window.path
      && candidate.source_start_line <= window.source_start_line
      && candidate.source_end_line >= window.source_end_line
    ));
    if (!record) return { ...window, content_lines: null };
    return {
      ...window,
      content_lines: record.content_lines.slice(
        window.source_start_line - record.source_start_line,
        window.source_end_line - record.source_start_line + 1,
      ),
    };
  });
}

function coalescedSourceContentWindows(entry, lineage) {
  const windows = payloadSourceContentWindows(lineage.content_entry || entry, lineage);
  if (windows.some((window) => !Array.isArray(window.content_lines))) return windows;
  const merged = mergeSourceContentRecords(windows);
  for (let index = 1; index < merged.length; index += 1) {
    const prior = merged[index - 1];
    const current = merged[index];
    if (prior.path === current.path && current.source_start_line <= prior.source_end_line) {
      return windows;
    }
  }
  return merged.map((window) => {
    const contributors = windows.filter((candidate) => (
      candidate.path === window.path
      && candidate.source_start_line <= window.source_end_line
      && candidate.source_end_line >= window.source_start_line
    ));
    return {
      ...window,
      materialized_start_line: Math.min(...contributors.map((candidate) => (
        Number(candidate.materialized_start_line) || Number.MAX_SAFE_INTEGER
      ))),
      materialized_end_line: Math.max(...contributors.map((candidate) => (
        Number(candidate.materialized_end_line) || 0
      ))),
    };
  });
}

function sourceLineSlice(entry, lineage, start, end, {
  sourcePath = null,
  sourceWindow = null,
} = {}) {
  const windows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage);
  const containing = windows.filter((window) => (
    start >= window.source_start_line && end <= window.source_end_line
  ));
  const requestedPath = canonicalSourcePath(sourcePath || sourceWindow?.path);
  const matches = requestedPath
    ? containing.filter((window) => window.path === requestedPath)
    : containing;
  const sourceRanges = windows.map((window) => ({
    path: window.path,
    start: window.source_start_line,
    end: window.source_end_line,
  }));
  if (matches.length === 0) return { matched: false, sourceRanges };
  const excerpts = matches.map((window) => Array.isArray(window.content_lines)
    ? window.content_lines.slice(
        start - window.source_start_line,
        end - window.source_start_line + 1,
      ).join("\n")
    : null);
  const distinctPaths = new Set(matches.map((window) => window.path));
  const distinctExcerpts = new Set(excerpts);
  if (matches.length > 1 && (distinctPaths.size !== 1 || distinctExcerpts.size !== 1)) {
    return { matched: false, sourceRanges };
  }
  const matched = matches[0];
  if (!Array.isArray(matched.content_lines)) {
    return { matched: false, sourceRanges, contentUnavailable: true };
  }
  return {
    matched: true,
    path: matched.path,
    sourceStart: start,
    sourceEnd: end,
    sourceRanges,
    excerpt: excerpts[0],
    sourceWindow: Object.fromEntries(
      Object.entries(matched).filter(([key]) => key !== "content_lines"),
    ),
  };
}

// Ref-relative ("page") coordinates → source coordinates. Every materialized
// ref the model can cite — a continuation page, a batched symbol-mode window
// item, a single symbol body — is delivered to the model as lines 1..N of that
// ref, and the tool labels it `cite_or_handoff`. A selector is translated when
// it fits the materialized range of exactly one recorded window; source
// coordinates are still tried first by the caller, so a cite that already fits
// a window in source space never reaches this path. A single recorded window
// without materialized coordinates is treated as materialized at 1..span.
function refRelativeCoordinates(entry, lineage, start, end, { sourcePath = null } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const requestedPath = canonicalSourcePath(sourcePath);
  const scoped = lineage.source_windows.filter((window) => !requestedPath || window.path === requestedPath);
  const eligible = scoped
    .map((window) => {
      const sourceSpan = Number(window.source_end_line) - Number(window.source_start_line);
      let materializedStart = Number(window.materialized_start_line);
      let materializedEnd = Number(window.materialized_end_line);
      if ((!Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)) && scoped.length === 1) {
        materializedStart = 1;
        materializedEnd = 1 + sourceSpan;
      }
      if (!Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)) return null;
      if (materializedEnd - materializedStart !== sourceSpan) return null;
      return { ...window, materialized_start_line: materializedStart, materialized_end_line: materializedEnd };
    })
    .filter(Boolean);
  const candidates = eligible.filter((window) => {
    const materializedStart = Number(window.materialized_start_line);
    const materializedEnd = Number(window.materialized_end_line);
    return start >= materializedStart
      && end <= materializedEnd;
  });
  const singleStartCovered = candidates.length === 0 && eligible.length === 1
    && start >= eligible[0].materialized_start_line
    && start <= eligible[0].materialized_end_line;
  const translatable = candidates.length === 1
    ? candidates
    : (singleStartCovered ? eligible : []);
  if (translatable.length !== 1) {
    // A compact code.window envelope can be one serialized JSON line while
    // carrying exact multi-line source windows in its content fields. The
    // model cites that visible embedded body as 1..N, but the envelope's
    // recorded materialized range is then 1..1. When there is exactly one
    // path/window and its full source content is available, translate against
    // uniquely covering body deterministically. Never apply this when two
    // embedded windows could satisfy the same ref-relative selector.
    const contentWindows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage)
      .filter((window) => !requestedPath || window.path === requestedPath)
      .filter((window) => Array.isArray(window.content_lines)
        && window.content_lines.length === window.source_end_line - window.source_start_line + 1);
    const coveringContentWindows = contentWindows.filter((window) => (
      start >= 1 && start <= window.content_lines.length
    ));
    const contentWindow = coveringContentWindows.length === 1 ? coveringContentWindows[0] : null;
    if (contentWindow) {
      const clampedRelativeEnd = Math.min(end, contentWindow.content_lines.length);
      return {
        matched: true,
        path: contentWindow.path,
        translatedStart: contentWindow.source_start_line + start - 1,
        translatedEnd: contentWindow.source_start_line + clampedRelativeEnd - 1,
        sourceContentRelative: true,
        ...(clampedRelativeEnd === end ? {} : {
          requestedMaterializedEnd: end,
          clampedMaterializedEnd: clampedRelativeEnd,
        }),
        materializedRange: { start: 1, end: contentWindow.content_lines.length },
        materializedRanges: [{
          path: contentWindow.path,
          start: 1,
          end: contentWindow.content_lines.length,
        }],
      };
    }
    return {
      matched: false,
      ambiguous: candidates.length > 1,
      materializedRanges: lineage.source_windows.map((window) => ({
        path: window.path,
        start: window.materialized_start_line,
        end: window.materialized_end_line,
      })),
    };
  }
  const window = translatable[0];
  const clampedMaterializedEnd = Math.min(end, window.materialized_end_line);
  const translatedStart = window.source_start_line + start - window.materialized_start_line;
  const translatedEnd = window.source_start_line + clampedMaterializedEnd - window.materialized_start_line;
  return {
    matched: true,
    path: window.path,
    translatedStart,
    translatedEnd,
    ...(clampedMaterializedEnd === end ? {} : {
      requestedMaterializedEnd: end,
      clampedMaterializedEnd,
    }),
    materializedRange: {
      start: window.materialized_start_line,
      end: window.materialized_end_line,
    },
    materializedRanges: [{
      path: window.path,
      start: window.materialized_start_line,
      end: window.materialized_end_line,
    }],
  };
}

function disjointSourceMaterialization(entry, lineage) {
  const contentWindows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage);
  if (contentWindows.length === 0
    || contentWindows.some((window) => !Array.isArray(window.content_lines))) return null;
  const ordered = [...contentWindows].sort((left, right) => (
    (Number(left.materialized_start_line) || Number.MAX_SAFE_INTEGER)
    - (Number(right.materialized_start_line) || Number.MAX_SAFE_INTEGER)
    || left.path.localeCompare(right.path)
    || left.source_start_line - right.source_start_line
  ));
  const excerptLines = [];
  const sourceWindows = [];
  for (const window of ordered) {
    const materializedStart = excerptLines.length + 1;
    excerptLines.push(...window.content_lines);
    const sourceWindow = Object.fromEntries(
      Object.entries(window).filter(([key]) => key !== "content_lines"),
    );
    sourceWindows.push({
      ...sourceWindow,
      materialized_start_line: materializedStart,
      materialized_end_line: excerptLines.length,
    });
  }
  return {
    excerpt: excerptLines.join("\n"),
    lineCount: excerptLines.length,
    sourceWindows,
    paths: [...new Set(sourceWindows.map((window) => window.path))],
  };
}

function directProvenance(entry) {
  const objectType = String(entry?.object_type || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (
    source === "agent:create_ref"
    || /(?:^|[._:-])(?:agent|assistant|prose)(?:[._:-]|$)/.test(objectType)
  ) {
    return "Agent Prose";
  }
  if (["full_tool_call", "tool_call_envelope", "tool.call.envelope"].includes(objectType)) {
    return "Full Tool Call";
  }
  if (
    objectType === "tool_result"
    || source === "system:worktree_read"
    || source.startsWith("tool:")
    || source.startsWith("tools.")
    || source.startsWith("atlas:")
    || source.startsWith("atlas.")
    || (source.startsWith("sub_agent:") && objectType === "tool_result")
  ) {
    return "Tool Result";
  }
  return "Materialized Text";
}

function exactDerivedSlice(sourceText, slice) {
  const value = String(sourceText ?? "");
  const lineMatch = /^lines:(\d+)-(\d+)$/.exec(String(slice || ""));
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = Number(lineMatch[2]);
    // Match atlas.create_ref's server-side line slicer byte-for-byte. This is
    // deliberately separate from terminal excerpt normalization below.
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    if (start < 1 || end < start || end > lines.length) return null;
    return lines.slice(start - 1, end).join("\n");
  }
  const charMatch = /^chars:(\d+)-(\d+)$/.exec(String(slice || ""));
  if (charMatch) {
    const start = Number(charMatch[1]);
    const end = Number(charMatch[2]);
    if (start < 0 || end < start || end > value.length) return null;
    return value.slice(start, end);
  }
  return null;
}

function evidenceProvenance(entry, context, seen = new Set()) {
  const kind = directProvenance(entry);
  const source = String(entry?.source || "").trim().toLowerCase();
  if (source !== "agent:create_ref") {
    return {
      kind,
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }

  const sourceRef = normalizeHashRefAlias(entry?.descriptor?.source_ref ?? entry?.metadata?.source_ref);
  const slice = entry?.descriptor?.slice ?? entry?.metadata?.slice;
  if (!sourceRef || !slice || seen.has(sourceRef)) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const fetched = fetchHashRefForContext(context, sourceRef);
  const sourceEntry = fetched?.found ? fetched.entry : null;
  if (!sourceEntry || sourceEntry.entry_kind !== "materialized" || sourceEntry.payload_text == null) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const derived = exactDerivedSlice(sourceEntry.payload_text, slice);
  if (derived == null || derived !== String(entry?.payload_text ?? "")) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(sourceRef);
  const origin = evidenceProvenance(sourceEntry, context, nextSeen);
  return {
    kind: origin.kind,
    source: origin.source,
    object_type: entry?.object_type || sourceEntry.object_type || "text",
    derived_from: sourceRef,
    derivation: "server_slice",
  };
}

function deliveredSourceCoverageCandidates(context) {
  const attemptId = Number(context?.attemptId ?? context?.attempt_id) || null;
  if (!attemptId) return [];
  const agentCallId = Number(context?.agentCallId ?? context?.agent_call_id) || null;
  const database = context?.db || getDb();
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'source.coverage'
      ORDER BY id ASC
    `).all(attemptId);
  } catch {
    return [];
  }
  const candidates = [];
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { continue; }
    if (detail?.delivery_state !== "delivered") continue;
    const deliveredCallId = Number(detail?.agent_call_id) || null;
    if (!agentCallId || deliveredCallId !== agentCallId) continue;
    const sourcePath = canonicalSourcePath(detail?.path ?? detail?.repo_rel_path);
    if (!sourcePath) continue;
    const start = Number(detail?.start_line ?? detail?.source_start_line);
    const end = Number(detail?.end_line ?? detail?.source_end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    candidates.push({
      path: sourcePath,
      repository_identity: detail?.repository_identity || null,
      source_version: detail?.source_version || null,
      start,
      end,
    });
  }
  return candidates;
}

function observedToolReadPath(detail, context) {
  const rawPath = String(detail?.path || "").trim();
  if (!rawPath) return null;
  const projectDir = String(context?.projectDir || context?.cwd || "").trim();
  if (!projectDir) return canonicalSourcePath(rawPath);
  const projectRoot = path.resolve(projectDir);
  const observedCwd = String(detail?.cwd || projectRoot).trim();
  const absolute = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(observedCwd || projectRoot, rawPath);
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return canonicalSourcePath(relative);
}

function successfulToolReadCandidates(context) {
  const attemptId = Number(context?.attemptId ?? context?.attempt_id) || null;
  const agentCallId = Number(context?.agentCallId ?? context?.agent_call_id) || null;
  if (!attemptId || !agentCallId) return [];
  const database = context?.db || getDb();
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.read'
      ORDER BY id ASC
    `).all(attemptId);
  } catch {
    return [];
  }
  const candidates = [];
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { continue; }
    if (Number(detail?.agent_call_id) !== agentCallId) continue;
    if (detail?.phase && detail.phase !== "finish") continue;
    if (detail?.ok === false) continue;
    if (detail?.outcome && detail.outcome !== "succeeded") continue;
    const sourcePath = observedToolReadPath(detail, context);
    const start = Number(detail?.offset) || 1;
    const resultLines = Number(detail?.result_lines);
    if (!sourcePath || !Number.isInteger(start) || start < 1 || !Number.isInteger(resultLines) || resultLines < 1) continue;
    candidates.push({ path: sourcePath, start, end: start + resultLines - 1 });
  }
  return candidates;
}

function successfulArtifactInspectionCandidates(context) {
  const attemptId = Number(context?.attemptId ?? context?.attempt_id) || null;
  const agentCallId = Number(context?.agentCallId ?? context?.agent_call_id) || null;
  if (!attemptId || !agentCallId) return [];
  const database = context?.db || getDb();
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.read_image_metadata'
      ORDER BY id ASC
    `).all(attemptId);
  } catch {
    return [];
  }
  const candidates = [];
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { continue; }
    if (Number(detail?.agent_call_id) !== agentCallId) continue;
    if (detail?.phase !== "finish" || detail?.ok === false) continue;
    if (detail?.outcome && detail.outcome !== "succeeded") continue;
    const sourcePath = observedToolReadPath(detail, context);
    if (sourcePath) candidates.push({ path: sourcePath, artifact_inspection: "read_image_metadata" });
  }
  return candidates;
}

function mergedLineRanges(ranges = []) {
  const sorted = ranges
    .filter((range) => Number.isInteger(range?.start) && Number.isInteger(range?.end) && range.start > 0 && range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const out = [];
  for (const range of sorted) {
    const previous = out.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      out.push({ start: range.start, end: range.end });
    }
  }
  return out;
}

function surfacedPathCandidates(context) {
  const byPath = new Map();
  for (const candidate of deliveredSourceCoverageCandidates(context)) {
    const exactRange = { start: candidate.start, end: candidate.end };
    const existing = byPath.get(candidate.path);
    if (existing) {
      if (existing.restrict_to_opened_ranges) existing.opened_ranges.push(exactRange);
      continue;
    }
    byPath.set(candidate.path, {
      ...candidate,
      restrict_to_opened_ranges: true,
      opened_ranges: [exactRange],
    });
  }
  for (const candidate of successfulToolReadCandidates(context)) {
    const existing = byPath.get(candidate.path);
    if (existing) {
      if (existing.restrict_to_opened_ranges) existing.opened_ranges.push({ start: candidate.start, end: candidate.end });
      continue;
    }
    byPath.set(candidate.path, {
      path: candidate.path,
      repository_identity: null,
      source_version: null,
      restrict_to_opened_ranges: true,
      opened_ranges: [{ start: candidate.start, end: candidate.end }],
    });
  }
  for (const candidate of successfulArtifactInspectionCandidates(context)) {
    const existing = byPath.get(candidate.path);
    if (existing) {
      existing.artifact_inspection = candidate.artifact_inspection;
      continue;
    }
    byPath.set(candidate.path, {
      path: candidate.path,
      repository_identity: null,
      source_version: null,
      restrict_to_opened_ranges: false,
      opened_ranges: [],
      artifact_inspection: candidate.artifact_inspection,
    });
  }
  for (const window of findVisibleHashRefSourceWindowsForContext(context, {
    db: context?.db || getDb(),
    excludeSurfacedBy: ["agent_handoff_path_selector"],
  })) {
    const canonical = canonicalSourcePath(window.path);
    if (!canonical) continue;
    const existing = byPath.get(canonical);
    if (existing) {
      if (existing.restrict_to_opened_ranges) {
        existing.opened_ranges.push({ start: window.start, end: window.end });
      }
      continue;
    }
    byPath.set(canonical, {
      ...window,
      path: canonical,
      restrict_to_opened_ranges: true,
      opened_ranges: [{ start: window.start, end: window.end }],
    });
  }
  return [...byPath.values()]
    .map((candidate) => ({ ...candidate, opened_ranges: mergedLineRanges(candidate.opened_ranges) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function resolveSurfacedEvidencePath(requestedPath, context) {
  const requested = canonicalSourcePath(requestedPath);
  if (!requested) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid surfaced evidence path: ${String(requestedPath || "")}`);
  }
  const candidates = surfacedPathCandidates(context);
  const resolveUnique = (matches) => {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_PATH_AMBIGUOUS",
        `Evidence path ${requested} is ambiguous among surfaced paths: ${matches.slice(0, 12).map((entry) => entry.path).join(", ")}`,
      );
    }
    return null;
  };
  const exact = resolveUnique(candidates.filter((candidate) => candidate.path === requested));
  if (exact) return exact;
  const suffix = resolveUnique(candidates.filter((candidate) => candidate.path.endsWith(`/${requested}`)));
  if (suffix) return suffix;
  if (!requested.includes("/")) {
    const basename = path.posix.basename(requested);
    const byBasename = resolveUnique(candidates.filter((candidate) => path.posix.basename(candidate.path) === basename));
    if (byBasename) return byBasename;
  }
  fail(
    "AGENT_HANDOFF_EVIDENCE_PATH_NOT_SURFACED",
    `Evidence path ${requested} was not surfaced to the current agent call`,
  );
}

function materializeWorktreeEvidenceSelector(selector, context) {
  const projectDir = String(context?.projectDir || context?.cwd || "").trim();
  if (!projectDir) {
    fail("AGENT_HANDOFF_CONTEXT_INVALID", "File-backed evidence requires the current job worktree");
  }
  const resolved = resolveSurfacedEvidencePath(selector.path, context);
  if (selector.start == null) {
    if (!resolved.artifact_inspection) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_PATH_NOT_SURFACED",
        `Evidence path ${resolved.path} requires a line range unless it was inspected as an artifact in the current agent call`,
      );
    }
    const readableArtifact = resolveDeterministicReadableFile(
      projectDir,
      resolved.path,
      context?.scopePredicates || null,
    );
    if (!readableArtifact.ok) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_PATH_INVALID",
        `Evidence path ${resolved.path} is not readable: ${readableArtifact.error}`,
      );
    }
    const bytes = fs.readFileSync(readableArtifact.path);
    const artifactSummary = JSON.stringify({
      path: resolved.path,
      size_bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      inspected_by: resolved.artifact_inspection,
    });
    const payload = `[posse.artifact_evidence.v1]\n${artifactSummary}`;
    const surfaced = surfaceHashRefForContext(context, {
      entryKind: "materialized",
      payloadText: payload,
      descriptor: {
        kind: "artifact_evidence",
        tool: resolved.artifact_inspection,
        path: resolved.path,
      },
      objectType: "tool_result",
      source: `system:${resolved.artifact_inspection}`,
      note: resolved.path,
      sizeChars: payload.length,
      recomputable: false,
      metadata: {
        surfaced_by: "agent_handoff_artifact_path_selector",
        fetch_class: "visible_copy",
        tool: resolved.artifact_inspection,
        handoff_evidence_pinned: true,
        path: resolved.path,
        line_semantics: "materialized",
        ...hashRefModelVisibility(context, {
          visibility: "full",
          ranges: [{ start: 0, end: payload.length }],
          issuedAs: "evidence",
        }),
      },
    }, { ownerScope: "work_item", db: context?.db || getDb() });
    if (!surfaced?.ok || !surfaced.entry?.ref) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED",
        `Artifact evidence path ${resolved.path} could not be stored`,
      );
    }
    const materialized = materializeAgentHandoffEvidenceSelector({
      ref: surfaced.entry.ref,
      lines: { start: 1, end: 2 },
    }, context, { expectedLineSemantics: "materialized" });
    return {
      ...materialized,
      selector_kind: "path",
      source_selector: resolved.path,
    };
  }
  const readable = resolveDeterministicReadableFile(
    projectDir,
    resolved.path,
    context?.scopePredicates || null,
  );
  if (!readable.ok) {
    const missing = /^File not found:/i.test(readable.error);
    fail(
      missing ? "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID" : "AGENT_HANDOFF_EVIDENCE_PATH_INVALID",
      `Evidence path ${resolved.path} is not readable: ${readable.error}`,
    );
  }
  const content = fs.readFileSync(readable.path, "utf8");
  const lines = splitEditableLines(content).lines;
  if (selector.start > lines.length) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
      `Evidence path ${resolved.path} has ${lines.length} lines; requested ${selector.start}-${selector.end}`,
    );
  }
  const endLine = Math.min(selector.end, lines.length);
  const selectedLineCount = endLine - selector.start + 1;
  if (selectedLineCount > AGENT_HANDOFF_LIMITS.maxSelectorLines) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_TOO_LARGE",
      `Evidence ${resolved.path}:${selector.start}-${endLine} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorLines} lines`,
    );
  }
  if (resolved.restrict_to_opened_ranges
    && !resolved.opened_ranges.some((range) => selector.start >= range.start && endLine <= range.end)) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
      `Evidence ${resolved.path}:${selector.start}-${endLine} was not opened by read_file in the current agent call`,
    );
  }
  const excerpt = lines.slice(selector.start - 1, endLine).join("\n");
  if (!excerpt.trim()) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_EMPTY",
      `Evidence ${resolved.path}:${selector.start}-${endLine} contains only whitespace`,
    );
  }
  if (excerpt.length > AGENT_HANDOFF_LIMITS.maxSelectorChars) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_TOO_LARGE",
      `Evidence ${resolved.path}:${selector.start}-${endLine} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorChars} characters`,
    );
  }
  const identity = JSON.stringify({
    path: resolved.path,
    start_line: selector.start,
    end_line: endLine,
    repository_identity: resolved.repository_identity,
    source_version: resolved.source_version,
  });
  const payload = `[posse.worktree_evidence.v1 ${identity}]\n${excerpt}`;
  const excerptLineCount = endLine - selector.start + 1;
  const surfaced = surfaceHashRefForContext(context, {
    entryKind: "materialized",
    payloadText: payload,
    descriptor: {
      kind: "worktree_evidence",
      tool: "read_file",
      path: resolved.path,
      start_line: selector.start,
      end_line: endLine,
      repository_identity: resolved.repository_identity,
      source_version: resolved.source_version,
    },
    objectType: "tool_result",
    source: "system:worktree_read",
    note: `${resolved.path}:${selector.start}-${endLine}`,
    sizeChars: payload.length,
    recomputable: false,
    versionId: resolved.source_version,
    metadata: {
      surfaced_by: "agent_handoff_path_selector",
      fetch_class: "visible_copy",
      tool: "read_file",
      handoff_evidence_pinned: true,
      path: resolved.path,
      repository_identity: resolved.repository_identity,
      source_version: resolved.source_version,
      line_semantics: "source",
      source_payload_encoding: "worktree_excerpt",
      source_windows: [{
        path: resolved.path,
        source_start_line: selector.start,
        source_end_line: endLine,
        materialized_start_line: 2,
        materialized_end_line: excerptLineCount + 1,
      }],
      ...hashRefModelVisibility(context, {
        visibility: "full",
        ranges: [{ start: 0, end: payload.length }],
        issuedAs: "evidence",
      }),
    },
  }, { ownerScope: "work_item", db: context?.db || getDb() });
  if (!surfaced?.ok || !surfaced.entry?.ref) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED",
      `Evidence path ${resolved.path}:${selector.start}-${endLine} could not be stored`,
    );
  }
  const materialized = materializeAgentHandoffEvidenceSelector({
    ref: surfaced.entry.ref,
    lines: { start: selector.start, end: endLine },
  }, context, { expectedLineSemantics: "source" });
  return {
    ...materialized,
    selector_kind: "path",
    source_selector: `${resolved.path}:${selector.start}-${endLine}`,
  };
}

function materializeRefCoordinatesAsSurfacedPath({
  selector,
  selectedSourcePath,
  sourceContentWindows,
  context,
}) {
  if (
    !Number.isInteger(selector?.start)
    || !Number.isInteger(selector?.end)
    || selector.start < 1
    || selector.end < selector.start
    || !String(context?.projectDir || context?.cwd || "").trim()
  ) return null;
  const sourcePaths = [...new Set((sourceContentWindows || [])
    .map((window) => canonicalSourcePath(window?.path))
    .filter(Boolean))];
  const requestedPath = canonicalSourcePath(selectedSourcePath);
  const sourcePath = requestedPath || (sourcePaths.length === 1 ? sourcePaths[0] : null);
  if (!sourcePath || (requestedPath && !sourcePaths.includes(requestedPath))) return null;

  const overlapping = (sourceContentWindows || []).filter((window) => (
    canonicalSourcePath(window?.path) === sourcePath
    && window.source_start_line <= selector.end
    && window.source_end_line >= selector.start
  ));
  // A ref may have presented several disjoint windows from one file. Never
  // reinterpret a selector that bridges those windows as authority to fill
  // the unseen gap. A range wholly inside one declared window is eligible
  // only to repair inconsistent materialization metadata; a range wholly
  // outside the ref may be treated as source coordinates only because the
  // same unique path is already surfaced to this agent call.
  if (overlapping.length > 1) return null;
  if (overlapping.length === 1 && !(
    selector.start >= overlapping[0].source_start_line
    && selector.end <= overlapping[0].source_end_line
  )) return null;

  try {
    return materializeWorktreeEvidenceSelector({
      path: sourcePath,
      start: selector.start,
      end: selector.end,
    }, context);
  } catch (error) {
    if (String(error?.code || "").startsWith("AGENT_HANDOFF_")) return null;
    throw error;
  }
}

export function materializeAgentHandoffEvidenceSelector(selectorValue, context, {
  expectedLineSemantics = null,
  allowDisjointSource = false,
  stagedSourcePath = null,
  stagedSourceWindow = null,
} = {}) {
  const coordinateSpace = ["materialized", "source"].includes(expectedLineSemantics)
    ? expectedLineSemantics
    : null;
  let selector = parseAgentHandoffEvidenceSelector(selectorValue);
  const selectorKind = selector.ref == null ? "path" : "ref";
  const selectedSourcePath = selector.ref == null
    ? null
    : canonicalSourcePath(selector.path || stagedSourcePath || stagedSourceWindow?.path);
  const stagedWindowKey = stagedSourceWindow == null
    ? ""
    : `${stagedSourceWindow.path || ""}:${stagedSourceWindow.source_start_line || ""}-${stagedSourceWindow.source_end_line || ""}`;
  const cacheKey = `${selectorKind}:${selector.ref || selector.path}:${selectedSourcePath || ""}:${selector.start ?? "all"}-${selector.end ?? "all"}:${coordinateSpace || "recorded"}:${allowDisjointSource ? "disjoint" : "contiguous"}:${stagedWindowKey}`;
  const cache = context?.[EVIDENCE_MATERIALIZATION_CACHE];
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  if (selectorKind === "path") {
    const materialized = materializeWorktreeEvidenceSelector(selector, context);
    cache?.set(cacheKey, materialized);
    return materialized;
  }
  const capabilityEvidence = materializeHashRefEvidenceForContext(context, selector.ref);
  if (capabilityEvidence?.found && !capabilityEvidence.ok) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED",
      `Evidence ${selector.ref} could not be reconstructed from its promoted traversal view`,
    );
  }
  const fetched = capabilityEvidence?.found
    ? capabilityEvidence
    : fetchHashRefForContext(context, selector.ref);
  if (!fetched?.found || !fetched.entry) {
    fail("AGENT_HANDOFF_EVIDENCE_NOT_FOUND", `Evidence ${selector.ref} is not visible to the current agent call`);
  }
  let entry = fetched.entry;
  if (entry.entry_kind !== "materialized" || entry.payload_text == null) {
    fail("AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED", `Evidence ${selector.ref} is not materialized`);
  }
  if (entry.metadata?.citable === false) {
    const parentRef = normalizeHashRefAlias(entry.metadata?.parent_ref
      ?? entry.metadata?.capability_source_ref);
    fail(
      "AGENT_HANDOFF_EVIDENCE_NOT_CITABLE",
      `Evidence ${selector.ref} is a non-citable search result view; cite or fetch a source-coordinate slice from ${parentRef || "the parent ref"}`,
    );
  }
  const visible = hashRefModelVisibleScope(entry, context);
  if (!capabilityEvidence?.found && visible.contracted && !visible.fully_visible) {
    const sourceRef = selector.ref;
    const fetchedViews = findFetchedHashRefViewsForContext(context, sourceRef)
      .filter((candidate) => {
        if (candidate?.entry_kind !== "materialized" || candidate.payload_text == null) return false;
        if (!hashRefModelVisibleScope(candidate, context).fully_visible) return false;
        if (selector.end == null) return true;
        const candidateLineage = sourceLineage(candidate, context);
        if (candidateLineage.line_semantics === "source") {
          return candidateLineage.source_windows.some((window) => (
            selector.start >= window.source_start_line
            && selector.end <= window.source_end_line
            && (!selectedSourcePath || window.path === selectedSourcePath)
          ));
        }
        return selector.end <= normalizedLines(candidate.payload_text).length;
      });
    const exactView = fetchedViews[0] || null;
    if (!exactView) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_NOT_VISIBLE",
        `Evidence ${sourceRef} is still an unseen traversal or partial ref for this agent call. Traverse it first so the same identity is promoted to evidence, or use an already visible evidence ref.`,
      );
    }
    entry = exactView;
    selector = { ...selector, ref: entry.ref };
  }
  const lines = normalizedLines(entry.payload_text);
  const lineage = sourceLineage(entry, context);
  const lineSemantics = lineage.line_semantics;
  if (coordinateSpace && coordinateSpace !== lineSemantics) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
      `Evidence ${selector.ref} is recorded with ${lineSemantics} line semantics, not ${coordinateSpace}`,
    );
  }
  let start;
  let end;
  let excerpt;
  let selectedPath = null;
  let selectedSourceWindows = lineage.source_windows;
  let selectedLineCount = null;
  let bareDisjoint = false;
  if (lineSemantics === "source") {
    if (selector.start == null) {
      if (lineage.source_windows.length !== 1) {
        const allowBare = allowDisjointSource || entry.metadata?.bare_multi_window_citable === true;
        const disjoint = allowBare ? disjointSourceMaterialization(entry, lineage) : null;
        if (!disjoint) {
          const ranges = lineage.source_windows
            .map((window) => `${window.path}:${window.source_start_line}-${window.source_end_line}`)
            .join(", ");
          fail(
            "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
            `Evidence ${selector.ref} contains disjoint source windows (${ranges}); select one range explicitly`,
          );
        }
        start = Math.min(...disjoint.sourceWindows.map((window) => window.source_start_line));
        end = Math.max(...disjoint.sourceWindows.map((window) => window.source_end_line));
        excerpt = disjoint.excerpt;
        selectedSourceWindows = disjoint.sourceWindows;
        selectedLineCount = disjoint.lineCount;
        bareDisjoint = true;
      } else {
        [start, end] = [
          lineage.source_windows[0].source_start_line,
          lineage.source_windows[0].source_end_line,
        ];
      }
    } else {
      start = selector.start;
      end = selector.end;
    }
    if (excerpt == null) {
      let sourceSlice = sourceLineSlice(entry, lineage, start, end, {
        sourcePath: selectedSourcePath,
        sourceWindow: stagedSourceWindow,
      });
      const requestedStart = start;
      const requestedEnd = end;
      let translatedCoordinates = null;
      if (!sourceSlice.matched && selector.start != null) {
        const requestedPath = canonicalSourcePath(selectedSourcePath);
        const sourceContentWindows = coalescedSourceContentWindows(
          lineage.content_entry || entry,
          lineage,
        );
        const startCoveredWindows = sourceContentWindows.filter((window) => (
          (!requestedPath || window.path === requestedPath)
          && start >= window.source_start_line
          && start <= window.source_end_line
        ));
        const startWindow = startCoveredWindows[0] || null;
        const crossesAnotherWindow = startWindow != null && sourceContentWindows.some((window) => (
          window !== startWindow
          && window.path === startWindow.path
          && window.source_start_line <= end
          && window.source_end_line >= start
        ));
        if (startCoveredWindows.length === 1
          && end > startWindow.source_end_line
          && !crossesAnotherWindow) {
          const clampedEnd = startWindow.source_end_line;
          const clampedSlice = sourceLineSlice(entry, lineage, start, clampedEnd, {
            sourcePath: selectedSourcePath,
            sourceWindow: stagedSourceWindow,
          });
          if (clampedSlice.matched) {
            end = clampedEnd;
            sourceSlice = clampedSlice;
            recordEvidenceCleanup(context, {
              action: "clamp_source_end",
              selector: selectorValue,
              normalizedSelector: `${selector.ref}:${start}-${end}`,
            });
          }
        }
        if (!sourceSlice.matched) translatedCoordinates = refRelativeCoordinates(entry, lineage, start, end, {
          sourcePath: selectedSourcePath,
        });
        if (translatedCoordinates?.matched) {
          start = translatedCoordinates.translatedStart;
          end = translatedCoordinates.translatedEnd;
          if (translatedCoordinates.sourceContentRelative === true) {
            recordEvidenceCleanup(context, {
              action: "normalize_compact_source_relative_range",
              selector: selectorValue,
              normalizedSelector: `${selector.ref}:${start}-${end}`,
            });
          }
          if (translatedCoordinates.clampedMaterializedEnd != null) {
            recordEvidenceCleanup(context, {
              action: "clamp_ref_relative_end",
              selector: selectorValue,
              normalizedSelector: `${selector.ref}:${start}-${end}`,
            });
          }
          sourceSlice = sourceLineSlice(entry, lineage, start, end, {
            sourcePath: translatedCoordinates.path,
            sourceWindow: stagedSourceWindow,
          });
        }
      }
      if (!sourceSlice.matched) {
        const surfacedPathEvidence = materializeRefCoordinatesAsSurfacedPath({
          selector,
          selectedSourcePath,
          sourceContentWindows: coalescedSourceContentWindows(
            lineage.content_entry || entry,
            lineage,
          ),
          context,
        });
        if (surfacedPathEvidence) {
          recordEvidenceCleanup(context, {
            action: "normalize_ref_source_coordinates_to_surfaced_path",
            selector: selectorValue,
            normalizedSelector: surfacedPathEvidence.source_selector,
          });
          cache?.set(cacheKey, surfacedPathEvidence);
          return surfacedPathEvidence;
        }
        const ranges = sourceSlice.sourceRanges
          .map((range) => `${range.path}:${range.start}-${range.end}`)
          .join(", ");
        const materializedRanges = (translatedCoordinates?.materializedRanges || [])
          .filter((range) => Number.isInteger(range.start)
            && Number.isInteger(range.end)
            && !(range.start === 1 && range.end === 1))
          .map((range) => `${range.path}:${range.start}-${range.end}`)
          .join(", ");
        fail(
          "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
          `Evidence ${selector.ref}:${requestedStart}-${requestedEnd} does not fit wholly within one recorded source window`
            + `${ranges ? ` (source coordinates: ${ranges})` : ""}`
            + `${materializedRanges ? `; ref-relative coordinates: ${materializedRanges}` : ""}`
            + (translatedCoordinates?.matched
              ? `; translated source range: ${start}-${end}`
              : ""),
        );
      }
      excerpt = sourceSlice.excerpt;
      selectedPath = sourceSlice.path;
      selectedSourceWindows = [sourceSlice.sourceWindow];
    }
  } else {
    start = selector.start ?? 1;
    end = selector.end ?? Math.max(1, lines.length);
    if (start > lines.length) {
      fail(
        "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID",
        `Evidence ${selector.ref} has ${lines.length} materialized lines; requested ${start}-${end}`,
      );
    }
    if (end > lines.length) {
      end = lines.length;
      recordEvidenceCleanup(context, {
        action: "clamp_materialized_end",
        selector: selectorValue,
        normalizedSelector: `${selector.ref}:${start}-${end}`,
      });
    }
    excerpt = lines.slice(start - 1, end).join("\n");
  }
  if (!excerpt.trim()) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_EMPTY",
      `Evidence ${selector.ref}:${start}-${end} contains only whitespace`,
    );
  }
  const lineCount = selectedLineCount ?? end - start + 1;
  if (lineCount > AGENT_HANDOFF_LIMITS.maxSelectorLines) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Evidence ${selector.ref}:${start}-${end} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorLines} lines`);
  }
  if (excerpt.length > AGENT_HANDOFF_LIMITS.maxSelectorChars) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Evidence ${selector.ref}:${start}-${end} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorChars} characters`);
  }
  const baseProvenance = evidenceProvenance(entry, context);
  const sourceMetadata = lineage.source_metadata || lineage.content_entry?.metadata || entry?.metadata || {};
  const provenance = {
    ...baseProvenance,
    ...(sourceMetadata.repository_identity
      ? { repository_identity: sourceMetadata.repository_identity }
      : {}),
    ...(sourceMetadata.source_version ? { source_version: sourceMetadata.source_version } : {}),
    ...(selectedSourceWindows.length > 0 ? { source_windows: selectedSourceWindows } : {}),
    ...(selectedPath ? { path: selectedPath } : {}),
    line_semantics: lineSemantics,
  };
  const evidenceLines = bareDisjoint
    ? { start: 1, end: lineCount }
    : { start, end };
  const materialized = {
    selector: bareDisjoint ? selector.ref : `${selector.ref}:${start}-${end}`,
    ref: selector.ref,
    lines: evidenceLines,
    excerpt,
    excerpt_sha256: crypto.createHash("sha256").update(excerpt).digest("hex"),
    source_content_sha256: entry.content_hash,
    provenance,
    ...(selectedPath ? {
      path: selectedPath,
      source_start_line: start,
      source_end_line: end,
    } : {}),
  };
  cache?.set(cacheKey, materialized);
  return materialized;
}

function normalizeScope(value, label, profile) {
  const source = exactKeys(
    value || {},
    ["task_mode", "files_to_modify", "files_to_create", "files_to_delete", "create_roots", "output_root", "key_files", "related_files"],
    label,
  );
  if (!["researcher.pipeline.v1", "researcher.report.v1"].includes(profile)
    && (source.key_files != null || source.related_files != null)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} does not allow researcher seed fields for ${profile}`);
  }
  if (profile !== "planner.plan.v1" && source.output_root != null) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} does not allow output_root for ${profile}`);
  }
  const out = {};
  if (source.task_mode != null) {
    const taskMode = boundedString(source.task_mode, `${label}.task_mode`, 40).toLowerCase();
    if (!PLANNER_TASK_MODES.has(taskMode)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.task_mode is not supported: ${taskMode}`);
    }
    out.task_mode = taskMode;
  }
  for (const key of ["files_to_modify", "files_to_create", "files_to_delete", "create_roots", "key_files", "related_files"]) {
    if (source[key] != null) out[key] = stringArray(source[key], `${label}.${key}`, 100, 500);
  }
  if (source.output_root != null) out.output_root = boundedString(source.output_root, `${label}.output_root`, 500);
  return out;
}

function normalizeClaimInput(value, claimIndex) {
  if (Array.isArray(value)) return value;
  const label = `claims[${claimIndex}]`;
  const source = exactKeys(value, uniqueKeys(
    compatibilityAliasKeys("claimName"),
    compatibilityAliasKeys("claimSummary"),
    ["evidence", "proof", "support", "decoy"],
  ), label);
  const claim = compatibilityAlias(source, "claimName", label);
  const prose = compatibilityAlias(source, "claimSummary", label);
  const detail = {};
  for (const lane of ["evidence", "proof", "support", "decoy"]) {
    if (source[lane] != null) detail[lane] = source[lane];
  }
  if (prose != null) detail.prose = prose;
  return Object.keys(detail).length > 0 ? [claim, detail] : [claim];
}

function normalizeClaimDetail(value, label) {
  const source = exactKeys(value, uniqueKeys(
    compatibilityAliasKeys("claimSummary"),
    ["evidence", "proof", "support", "decoy"],
  ), label);
  const prose = compatibilityAlias(source, "claimSummary", label);
  const evidence = [];
  let hasEvidence = false;
  for (const lane of ["evidence", "proof", "support"]) {
    if (source[lane] == null) continue;
    hasEvidence = true;
    if (!Array.isArray(source[lane])) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${lane} must be an array`);
    }
    evidence.push(...source[lane]);
  }
  return {
    ...(hasEvidence ? { evidence } : {}),
    ...(source.decoy == null ? {} : { decoy: source.decoy }),
    ...(prose == null ? {} : { prose }),
  };
}

function normalizeDecoyInput(value, label) {
  if (Array.isArray(value)) return value;
  const source = exactKeys(value, uniqueKeys(
    ["selector", "ref", "lines"],
    compatibilityAliasKeys("decoyReason"),
  ), label);
  const refSelector = source.ref == null ? null : {
    ref: source.ref,
    ...(source.lines == null ? {} : { lines: source.lines }),
  };
  if (source.selector != null && refSelector != null
    && !sameCompatibilityValue(source.selector, refSelector)) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      `${label}.selector conflicts with compatibility alias ${label}.ref`,
    );
  }
  const selector = source.selector ?? refSelector;
  const reason = compatibilityAlias(source, "decoyReason", label);
  return [selector, reason ?? "Excluded from supporting evidence."];
}

function isGroundedClaimEvidence(evidence) {
  const kind = evidence?.provenance?.kind;
  return ["Tool Result", "Full Tool Call"].includes(kind);
}

function isCompatibilityProofProvenance(evidence) {
  return isGroundedClaimEvidence(evidence);
}

function materializeClaim(
  value,
  claimIndex,
  context,
  counters,
  {
    maxClaimChars = AGENT_HANDOFF_LIMITS.maxClaimChars,
    maxProseChars = AGENT_HANDOFF_LIMITS.maxSummaryChars,
    lenientProse = false,
    evidenceFailureMode = null,
  } = {},
) {
  const normalized = normalizeClaimInput(value, claimIndex);
  if (!Array.isArray(normalized) || normalized.length < 1 || normalized.length > 2) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `claims[${claimIndex}] must be [claim, optional evidence]`);
  }
  const claim = boundedString(
    normalized[0],
    `claims[${claimIndex}][0]`,
    maxClaimChars,
    { lenient: lenientProse, context },
  );
  counters.narrative += claim.length;
  if (normalized.length === 1) return [claim];
  const detail = normalizeClaimDetail(normalized[1], `claims[${claimIndex}][1]`);
  const out = {};
  const selectors = new Set();
  if (detail.evidence != null) {
    const materialized = new Map();
    const cleanableFailures = [];
    for (const selector of detail.evidence) {
      let evidence;
      try {
        evidence = materializeAgentHandoffEvidenceSelector(selector, context);
      } catch (error) {
        const action = evidenceRecoveryAction(error, evidenceFailureMode)
          || alternateEvidenceCleanupAction(error, {
            lenient: evidenceFailureMode === "annotate",
          });
        if (!action) throw error;
        cleanableFailures.push({ selector, error, action });
        continue;
      }
      selectors.add(evidence.selector);
      if (!materialized.has(evidence.selector)) {
        materialized.set(evidence.selector, evidence);
        counters.evidence += evidence.excerpt.length;
      }
    }
    if (materialized.size === 0 && cleanableFailures.length > 0 && !evidenceFailureMode) {
      throw cleanableFailures[0].error;
    }
    for (const { selector, error, action } of cleanableFailures) {
      const recordedAction = evidenceFailureMode === "demote" && materialized.size > 0
        ? (alternateEvidenceCleanupAction(error) || action)
        : action;
      recordEvidenceCleanup(context, {
        action: recordedAction,
        selector,
        code: error.code,
        message: error.message,
      });
    }
    if (evidenceFailureMode === "annotate" && cleanableFailures.length > 0) {
      // The consumer can surface the cited location itself, so the claim keeps
      // its pointer: retain each demoted selector as an unverified annotation
      // instead of forcing the producer through a reject-and-retry loop.
      out.unverified_evidence = cleanableFailures.slice(0, 8).map(({ selector, error }) => ({
        selector: evidenceSelectorText(selector).slice(0, 300),
        code: error.code,
      }));
    }
    if (materialized.size > 0) out.evidence = [...materialized.values()];
  }
  if (detail.decoy != null) {
    if (!Array.isArray(detail.decoy)) fail("AGENT_HANDOFF_SCHEMA_INVALID", "decoy must be an array");
    out.decoy = detail.decoy.flatMap((entry, index) => {
      const normalizedEntry = normalizeDecoyInput(entry, `decoy[${index}]`);
      if (normalizedEntry.length !== 2) fail("AGENT_HANDOFF_SCHEMA_INVALID", `decoy[${index}] must be [selector, reason]`);
      let evidence;
      try {
        evidence = materializeAgentHandoffEvidenceSelector(normalizedEntry[0], context);
      } catch (error) {
        const action = evidenceRecoveryAction(error, evidenceFailureMode);
        if (!action) throw error;
        recordEvidenceCleanup(context, {
          action: "drop_unverifiable_decoy_selector",
          selector: normalizedEntry[0],
          code: error.code,
          message: error.message,
        });
        return [];
      }
      selectors.add(evidence.selector);
      const reason = boundedString(normalizedEntry[1], `decoy[${index}][1]`, 500);
      counters.evidence += evidence.excerpt.length;
      counters.narrative += reason.length;
      return [[evidence, reason]];
    });
    if (out.decoy.length === 0) delete out.decoy;
  }
  if (selectors.size > AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim) {
    fail("AGENT_HANDOFF_TOO_LARGE", `claims[${claimIndex}] exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim} selectors`);
  }
  if (detail.prose != null) {
    out.prose = boundedString(
      detail.prose,
      `claims[${claimIndex}].prose`,
      maxProseChars,
      { required: false, lenient: lenientProse, context },
    );
    counters.narrative += out.prose.length;
  }
  const materializedClaim = [claim, out];
  if (evidenceFailureMode === "demote"
    && detail.evidence != null
    && !Array.isArray(out.evidence)) {
    Object.defineProperty(materializedClaim, CLAIM_EVIDENCE_DEMOTION, { value: true });
  }
  return materializedClaim;
}

function claimNarrativeChars(claim) {
  const detail = plainObject(claim?.[1]) || {};
  return String(claim?.[0] || "").length
    + String(detail.prose || "").length
    + (detail.decoy || []).reduce((sum, entry) => sum + String(entry?.[1] || "").length, 0);
}

function appendUnverifiedClaimSummaryNote(summary, claims, maxChars) {
  if (!Array.isArray(claims) || claims.length === 0) return summary;
  const claimText = claims
    .map((claim) => [claim?.[0], claim?.[1]?.prose]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" — "))
    .filter(Boolean)
    .join(" | ");
  const note = `[Unverified handoff note: evidence was unavailable, so this is not treated as an evidence-backed claim] ${claimText}`;
  const separator = summary ? "\n\n" : "";
  if (`${summary}${separator}${note}`.length <= maxChars) return `${summary}${separator}${note}`;
  const boundedNote = note.length <= maxChars
    ? note
    : `${note.slice(0, Math.max(0, maxChars - 1))}…`;
  const summaryBudget = Math.max(0, maxChars - boundedNote.length - (summary ? 2 : 0));
  const boundedSummary = summary.slice(0, summaryBudget).trimEnd();
  return boundedSummary ? `${boundedSummary}\n\n${boundedNote}` : boundedNote;
}

function rewriteSummaryEvidenceLabels(summary, originalClaims, retainedClaims) {
  const retainedIndexes = new Map(retainedClaims.map((claim, index) => [claim, index + 1]));
  return String(summary || "").replace(/\[E(\d+)\]/g, (label, rawIndex) => {
    const original = originalClaims[Number(rawIndex) - 1];
    if (!original) return label;
    const retainedIndex = retainedIndexes.get(original);
    return retainedIndex == null ? "[unverified]" : `[E${retainedIndex}]`;
  });
}

function validateResearchAbsenceClaims(research, claims, label) {
  const checks = research?.absence_checks;
  if (!Array.isArray(checks) || checks.length === 0) return;
  for (const [index, check] of checks.entries()) {
    if (check.result_count !== 0) {
      fail(
        "AGENT_HANDOFF_SCHEMA_INVALID",
        `${label}.absence_checks[${index}].result_count must be 0 for a repository-absence claim`,
      );
    }
    const expected = parseAgentHandoffEvidenceSelector(check.evidence_ref);
    if (expected.path != null) {
      fail(
        "AGENT_HANDOFF_SCHEMA_INVALID",
        `${label}.absence_checks[${index}].evidence_ref must be a stored ref selector`,
      );
    }
    const matchingClaim = claims.find((claim) => String(claim?.[0] || "").trim() === check.claim);
    const evidence = matchingClaim?.[1]?.evidence || [];
    const matchesExpected = evidence.some((entry) => (
      entry?.ref === expected.ref
      && (expected.start == null || (
        Number(entry?.lines?.start) === expected.start
        && Number(entry?.lines?.end) === expected.end
      ))
    ));
    const expectedSelector = expected.start == null
      ? expected.ref
      : `${expected.ref}:${expected.start}-${expected.end}`;
    if (!matchingClaim || !matchesExpected) {
      fail(
        "AGENT_HANDOFF_SCHEMA_INVALID",
        `${label}.absence_checks[${index}] must match a claim with the same text and an evidence selector for ${expectedSelector}`,
      );
    }
  }
}

function validateResearchClaimEvidence(claims, label) {
  for (const [index, claim] of claims.entries()) {
    const detail = plainObject(claim?.[1]) || {};
    const evidence = Array.isArray(detail.evidence) ? detail.evidence : [];
    if (evidence.some(isGroundedClaimEvidence)) continue;
    // A lenient pipeline materialization may have demoted every selector on a
    // claim to an unverified annotation; the researcher still named a
    // location, so the claim stands for the consumer to verify.
    const unverified = Array.isArray(detail.unverified_evidence) ? detail.unverified_evidence : [];
    if (unverified.length > 0) continue;
    fail(
      "AGENT_HANDOFF_RESEARCH_CLAIM_EVIDENCE_REQUIRED",
      `${label}.claims[${index}] has no evidence selector. Put narrative in summary and attach at least one existing ref or surfaced source range to evidence.`,
    );
  }
}

function plannerPromoteMappings(handoff) {
  const destinations = [...new Set([
    ...(handoff.report?.scope?.files_to_modify || []),
    ...(handoff.report?.scope?.files_to_create || []),
  ].map((value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean))];
  return destinations.map((dest) => ({
    pattern: dest.split("/").filter(Boolean).at(-1) || "",
    dest,
  }));
}

function validateTarget(target, policy, profile, label) {
  const out = exactKeys(target, ["kind", "role"], label);
  const kind = boundedString(out.kind, `${label}.kind`, 20);
  if (!policy.targetKinds.includes(kind)) fail("AGENT_HANDOFF_TARGET_INVALID", `${profile} does not allow target kind ${kind}`);
  const role = out.role == null ? null : boundedString(out.role, `${label}.role`, 40);
  if (profile === "planner.plan.v1") {
    const allowed = kind === "agent" ? ["dev", "artificer"] : ["human_input", "promote"];
    if (!allowed.includes(role)) fail("AGENT_HANDOFF_TARGET_INVALID", `${profile} target ${kind} requires one of: ${allowed.join(", ")}`);
  } else if (kind === "pipeline" && role != null && role !== "$pipeline") {
    fail("AGENT_HANDOFF_TARGET_INVALID", `${profile} pipeline target role must be $pipeline when present`);
  } else if (kind === "result" && role != null && role !== "$result") {
    fail("AGENT_HANDOFF_TARGET_INVALID", `${profile} result target role must be $result when present`);
  } else if (kind === "parent" && role != null && role !== "$parent") {
    fail("AGENT_HANDOFF_TARGET_INVALID", `${profile} parent target role must be $parent when present`);
  }
  return role == null ? { kind } : { kind, role };
}

function validateDependencyGraph(handoffs) {
  const ids = new Set(handoffs.map((handoff) => handoff.id));
  if (ids.size !== handoffs.length) fail("AGENT_HANDOFF_DEPENDENCY_INVALID", "handoff ids must be unique");
  for (const handoff of handoffs) {
    for (const dependency of handoff.depends_on) {
      if (!ids.has(dependency) || dependency === handoff.id) {
        fail("AGENT_HANDOFF_DEPENDENCY_INVALID", `Invalid dependency ${handoff.id} -> ${dependency}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  function visit(id) {
    if (visiting.has(id)) fail("AGENT_HANDOFF_DEPENDENCY_INVALID", "handoff dependencies must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
}

function validatePlannerPacketSemantics(packet) {
  if (packet.profile !== "planner.plan.v1") return;
  if (packet.outcome !== "success") return;
  for (const [index, handoff] of packet.handoffs.entries()) {
    if ((handoff.report?.questions || []).length > 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `planner success handoffs[${index}] cannot contain unresolved questions`,
      );
    }
    if (handoff.target?.kind === "system") {
      if (handoff.target?.role === "promote") {
        if ((handoff.report?.scope?.files_to_delete || []).length > 0) {
          fail(
            "AGENT_HANDOFF_SEMANTIC_INVALID",
            `planner success handoffs[${index}] promote cannot delete destination files`,
          );
        }
        if (plannerPromoteMappings(handoff).length === 0) {
          fail(
            "AGENT_HANDOFF_SEMANTIC_INVALID",
            `planner success handoffs[${index}] promote requires exact destination files in scope.files_to_create or scope.files_to_modify`,
          );
        }
        for (const [mappingIndex, mapping] of plannerPromoteMappings(handoff).entries()) {
          const pathError = validateScopedPath(mapping.dest, `handoffs[${index}] promote destination[${mappingIndex}]`);
          if (pathError) {
            fail("AGENT_HANDOFF_SEMANTIC_INVALID", pathError);
          }
        }
      }
      continue;
    }
    if (handoff.target?.kind !== "agent") continue;
    const scope = handoff.report?.scope || {};
    const taskMode = String(scope.task_mode || "code").trim().toLowerCase();
    const writablePaths = [
      ...(scope.files_to_modify || []),
      ...(scope.files_to_create || []),
      ...(scope.files_to_delete || []),
      ...(scope.create_roots || []),
    ];
    if ((handoff.report?.success_criteria || []).length === 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `planner success handoffs[${index}] requires non-empty success criteria`,
      );
    }
    if (taskMode === "db") {
      if (handoff.target?.role !== "dev") {
        fail(
          "AGENT_HANDOFF_SEMANTIC_INVALID",
          `planner success handoffs[${index}] task_mode db requires target role dev`,
        );
      }
      if (writablePaths.length > 0) {
        fail(
          "AGENT_HANDOFF_SEMANTIC_INVALID",
          `planner success handoffs[${index}] task_mode db requires empty file scope`,
        );
      }
    } else if (writablePaths.length === 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `planner success handoffs[${index}] task_mode ${taskMode} requires non-empty writable scope; `
          + "add at least one exact repository path to scope.files_to_modify, scope.files_to_create, "
          + "scope.files_to_delete, or scope.create_roots, then retry agent_handoff",
      );
    }
  }
}

function narrativeFragmentsForHandoff(handoff, handoffIndex) {
  const report = handoff.report || {};
  const fragments = [
    { label: `handoffs[${handoffIndex}].intent`, text: handoff.intent },
    { label: `handoffs[${handoffIndex}].report.summary`, text: report.summary },
  ];
  for (const [claimIndex, claim] of (report.claims || []).entries()) {
    fragments.push({ label: `handoffs[${handoffIndex}].report.claims[${claimIndex}]`, text: claim[0] });
    const detail = claim[1] || {};
    if (detail.prose) {
      fragments.push({ label: `handoffs[${handoffIndex}].report.claims[${claimIndex}].prose`, text: detail.prose });
    }
    for (const [decoyIndex, decoy] of (detail.decoy || []).entries()) {
      fragments.push({ label: `handoffs[${handoffIndex}].report.claims[${claimIndex}].decoy[${decoyIndex}].reason`, text: decoy[1] });
    }
  }
  for (const key of ["constraints", "success_criteria", "questions"]) {
    for (const [index, text] of (report[key] || []).entries()) {
      fragments.push({ label: `handoffs[${handoffIndex}].report.${key}[${index}]`, text });
    }
  }
  for (const [key, values] of Object.entries(report.scope || {})) {
    for (const [index, text] of (Array.isArray(values) ? values : [values]).entries()) {
      fragments.push({ label: `handoffs[${handoffIndex}].report.scope.${key}[${index}]`, text });
    }
  }
  const appendStructuredFragments = (value, label) => {
    if (typeof value === "string") {
      fragments.push({ label, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => appendStructuredFragments(entry, `${label}[${index}]`));
      return;
    }
    if (plainObject(value)) {
      for (const [key, entry] of Object.entries(value)) appendStructuredFragments(entry, `${label}.${key}`);
    }
  };
  if (report.research) appendStructuredFragments(report.research, `handoffs[${handoffIndex}].report.research`);
  for (const key of PLANNER_REPORT_METADATA_KEYS) {
    if (report[key] != null) appendStructuredFragments(report[key], `handoffs[${handoffIndex}].report.${key}`);
  }
  return fragments;
}

function validateNarrativeEvidenceBoundary(handoff, handoffIndex) {
  const evidence = [];
  for (const claim of handoff.report?.claims || []) {
    const detail = claim[1] || {};
    for (const lane of ["evidence", "proof", "support"]) {
      evidence.push(...(detail[lane] || []).map((entry) => entry.excerpt));
    }
    evidence.push(...(detail.decoy || []).map(([entry]) => entry.excerpt));
  }
  const overlap = findCopiedAgentHandoffEvidence(
    narrativeFragmentsForHandoff(handoff, handoffIndex),
    evidence,
  );
  if (overlap) {
    fail(
      "AGENT_HANDOFF_EVIDENCE_COPY_OUTSIDE_SELECTOR",
      `${overlap.label} copies at least ${overlap.overlapChars} normalized characters from selected evidence outside a selector`,
    );
  }
}

function validateCitationChildPacketSemantics(packet) {
  if (packet.profile !== "citation_synthesis.v1") return;
  const report = packet.handoffs[0]?.report || {};
  if (Object.keys(report.scope || {}).length > 0) {
    fail(
      "AGENT_HANDOFF_SEMANTIC_INVALID",
      "citation synthesis cannot return scope fields",
    );
  }
  for (const key of ["constraints", "success_criteria", "questions"]) {
    if ((report[key] || []).length > 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `citation synthesis cannot return ${key}`,
      );
    }
  }
}

function invalidPlannerContract(message) {
  fail(
    AGENT_HANDOFF_WORK_ITEM_CONTRACT_ERROR,
    `work-item metadata.agent_handoff.planner_contract ${message}`,
  );
}

function plannerContractFromWorkItem(workItem) {
  if (!workItem?.metadata_json) return null;
  let metadata;
  try {
    metadata = JSON.parse(workItem.metadata_json);
  } catch {
    invalidPlannerContract("must be valid JSON");
  }
  const metadataObject = plainObject(metadata);
  if (!metadataObject || metadataObject.agent_handoff == null) return null;
  const agentHandoff = plainObject(metadataObject.agent_handoff);
  if (!agentHandoff) invalidPlannerContract("parent must be an object");
  if (!Object.hasOwn(agentHandoff, "planner_contract")) return null;
  const contract = plainObject(agentHandoff.planner_contract);
  if (!contract) invalidPlannerContract("must be an object");
  for (const key of Object.keys(contract)) {
    if (!AGENT_HANDOFF_PLANNER_CONTRACT_KEYS.includes(key)) invalidPlannerContract(`does not allow ${key}`);
  }
  if (contract.version !== AGENT_HANDOFF_PLANNER_CONTRACT_VERSION) {
    invalidPlannerContract(`requires numeric version ${AGENT_HANDOFF_PLANNER_CONTRACT_VERSION}`);
  }
  const hasExactExecutableHandoffs = Object.hasOwn(contract, "exact_executable_handoffs");
  const exactExecutableHandoffs = contract.exact_executable_handoffs;
  const plannerLimit = AGENT_HANDOFF_PROFILE_POLICY["planner.plan.v1"].maxHandoffs;
  if (hasExactExecutableHandoffs && (
    !Number.isInteger(exactExecutableHandoffs)
    || exactExecutableHandoffs < 1
    || exactExecutableHandoffs > plannerLimit
  )) {
    invalidPlannerContract(`exact_executable_handoffs must be an integer from 1 through ${plannerLimit}`);
  }
  const hasDependencyEdges = Object.hasOwn(contract, "dependency_edges");
  const dependencyEdges = contract.dependency_edges;
  if (hasDependencyEdges && !AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES.includes(dependencyEdges)) {
    invalidPlannerContract(
      `dependency_edges must be one of: ${AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES.join(", ")}`,
    );
  }
  return {
    exactExecutableHandoffs: hasExactExecutableHandoffs ? exactExecutableHandoffs : null,
    dependencyEdges: hasDependencyEdges ? dependencyEdges : "unconstrained",
  };
}

function validatePlannerPacketAgainstWorkItem(packet, workItem) {
  if (packet.profile !== "planner.plan.v1" || !workItem) return;
  const contract = plannerContractFromWorkItem(workItem);
  if (!contract) return;
  const executableHandoffs = packet.handoffs.filter((handoff) => handoff.target?.kind === "agent");
  if (contract.exactExecutableHandoffs != null
    && executableHandoffs.length !== contract.exactExecutableHandoffs) {
    fail(
      "AGENT_HANDOFF_SEMANTIC_INVALID",
      `planner contract requires exactly ${contract.exactExecutableHandoffs} executable handoffs; received ${executableHandoffs.length}`,
    );
  }
  if (contract.dependencyEdges !== "unconstrained") {
    const dependencyCount = packet.handoffs.reduce(
      (sum, handoff) => sum + (handoff.depends_on || []).length,
      0,
    );
    if (contract.dependencyEdges === "at_least_one" && dependencyCount === 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        "planner contract requires at least one dependency edge",
      );
    }
    if (contract.dependencyEdges === "none" && dependencyCount > 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        "planner contract forbids dependency edges",
      );
    }
  }
}

const COMPLETION_ARGUMENT_KEYS = Object.freeze([
  "status",
  "no_change_rationale",
  "remaining_work",
  "blocker",
  "verification_unavailable",
  "evidence_gap",
  "file_requests",
]);

function looksLikeTerminalCompletion(value) {
  const source = plainObject(value);
  if (!source) return false;
  return !["protocol", "profile", "outcome", "handoffs"].some((key) => Object.hasOwn(source, key));
}

export function normalizePlannerAgentHandoffArgs(args, { role = "" } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const candidate = plainObject(args);
  if (normalizedRole !== "planner" || !candidate || !Object.hasOwn(candidate, "tasks")) return args;

  const source = exactKeys(candidate, ["tasks"], "agent_handoff");
  if (!Array.isArray(source.tasks) || source.tasks.length < 1) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.tasks must contain at least one task");
  }
  if (source.tasks.length > 50) {
    fail("AGENT_HANDOFF_TOO_LARGE", "agent_handoff.tasks exceeds 50 entries");
  }

  const handoffs = source.tasks.map((raw, index) => {
    const task = exactKeys(raw, PLANNER_COMPACT_TASK_KEYS, `agent_handoff.tasks[${index}]`);
    for (const key of ["summary", "scope", "success_criteria"]) {
      if (task[key] == null) {
        fail("AGENT_HANDOFF_SCHEMA_INVALID", `agent_handoff.tasks[${index}].${key} is required`);
      }
    }
    const label = `agent_handoff.tasks[${index}]`;
    const taskRoleInput = compatibilityAlias(task, "plannerTaskRole", label);
    if (taskRoleInput == null) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.role is required`);
    }
    const taskRole = boundedString(taskRoleInput, `${label}.role`, 40);
    const targetKind = ["dev", "artificer"].includes(taskRole) ? "agent" : "system";
    const report = {
      summary: task.summary,
      claims: task.claims ?? [],
      scope: task.scope ?? {},
      constraints: task.constraints ?? [],
      success_criteria: task.success_criteria ?? [],
    };
    for (const key of PLANNER_REPORT_METADATA_KEYS) {
      if (task[key] != null) report[key] = task[key];
    }
    return {
      id: task.id ?? `task-${index + 1}`,
      depends_on: task.depends_on ?? [],
      target: { kind: targetKind, role: taskRole },
      intent: task.intent ?? `Execute ${task.id ?? `task-${index + 1}`} as summarized`,
      report,
    };
  });
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: "planner.plan.v1",
    outcome: "success",
    handoffs,
  };
}

function firstAssessorText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
      const object = plainObject(entry);
      if (!object) continue;
      const nested = firstAssessorText(
        object.summary,
        object.prose,
        object.claim,
        object.reason,
      );
      if (nested) return nested;
    }
  }
  return "";
}

function compactAssessorProof(value, outcome) {
  const fallback = `Assessor submitted a terminal ${outcome} verdict.`;
  return String(value || fallback)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function compactAssessorQuestions(...values) {
  const questions = values.find((value) => Array.isArray(value)) || [];
  return questions
    .filter((value) => typeof value === "string" && value.trim())
    .slice(0, 3)
    .map((value) => value.trim().slice(0, 240));
}

function compactAssessorEvidence(...values) {
  const evidence = values.find((value) => Array.isArray(value)) || [];
  return evidence.slice(0, 8);
}

function hasCanonicalAssessorEnvelope(source) {
  if (!Array.isArray(source.handoffs) || source.handoffs.length < 1) {
    return false;
  }
  const topKeys = new Set(["protocol", "profile", "outcome", "confidence", "handoffs"]);
  if (Object.keys(source).some((key) => !topKeys.has(key))) return false;
  const entryKeys = new Set([
    "id",
    "depends_on",
    "target",
    "intent",
    "report",
    ...PLANNER_REPORT_KEYS,
  ]);
  return source.handoffs.every((raw) => {
    const entry = plainObject(raw);
    if (!entry || Object.keys(entry).some((key) => !entryKeys.has(key))) return false;
    const target = plainObject(entry.target);
    if (target?.kind !== "pipeline" || target?.role !== "$pipeline") return false;
    const report = plainObject(entry.report);
    return !report || Object.keys(report).every((key) => PLANNER_REPORT_KEYS.includes(key));
  });
}

function normalizeAssessorTerminalArgs(source) {
  if (hasCanonicalAssessorEnvelope(source)) return null;
  const entries = Array.isArray(source.handoffs)
    ? source.handoffs.map((entry) => plainObject(entry)).filter(Boolean)
    : [];
  const first = entries[0] || {};
  const report = plainObject(first.report) || {};
  const outcomeCandidates = [
    source.verdict,
    source.outcome,
    source.status,
    first.verdict,
    first.outcome,
    first.status,
    report.verdict,
    report.outcome,
    report.status,
  ].filter((value) => typeof value === "string" && value.trim());
  const normalizedOutcomes = [...new Set(
    outcomeCandidates.map((value) => value.trim().toLowerCase()),
  )];
  if (normalizedOutcomes.length > 1) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      "agent_handoff contains conflicting assessor verdicts",
    );
  }
  const outcome = normalizedOutcomes[0];
  if (!outcome) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.verdict is required");
  }
  const proof = compactAssessorProof(firstAssessorText(
    source.proof,
    first.proof,
    report.proof,
    report.summary,
    first.summary,
    source.summary,
    source.reasons,
    first.reasons,
    report.reasons,
    report.claims,
    first.claims,
  ), outcome);
  const questions = compactAssessorQuestions(
    source.questions,
    source.human_questions,
    first.questions,
    first.human_questions,
    report.questions,
    report.human_questions,
  );
  const repair = firstAssessorText(
    source.repair,
    first.repair,
    report.repair,
    source.spawn_jobs?.[0]?.payload?.instructions,
    first.spawn_jobs?.[0]?.payload?.instructions,
    report.spawn_jobs?.[0]?.payload?.instructions,
  ).replace(/\s+/g, " ").trim().slice(0, 1000);
  const evidence = compactAssessorEvidence(
    source.evidence,
    source.proof_refs,
    first.evidence,
    first.proof_refs,
    report.evidence,
    report.proof_refs,
  );
  if (outcome === "fail" && !repair) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.repair is required for fail");
  }
  if (outcome !== "fail" && repair) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.repair is only valid for fail");
  }
  const confidence = source.confidence ?? first.confidence ?? report.confidence;
  if (!["low", "medium", "high"].includes(confidence)) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      "agent_handoff.confidence must be low, medium, or high",
    );
  }
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: "assessor.verdict.v1",
    outcome,
    confidence,
    handoffs: [{
      id: "verdict",
      depends_on: [],
      target: { kind: "pipeline", role: "$pipeline" },
      intent: "Submit terminal assessor verdict",
      report: {
        summary: proof,
        claims: evidence.length > 0 ? [{ claim: proof, proof: evidence }] : [],
        scope: {},
        constraints: [],
        success_criteria: [],
        questions,
        payload: repair ? { repair } : {},
      },
    }],
  };
}

function compactResearcherText(value, fallback = "") {
  return String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function researcherEvidenceSelector(value, context) {
  let candidate = value;
  if (Array.isArray(candidate)) candidate = candidate[0];
  const object = plainObject(candidate);
  if (object) candidate = object.selector ?? (
    object.ref != null
      ? {
          ref: object.ref,
          ...(object.path == null ? {} : { path: object.path }),
          ...(object.lines == null ? {} : { lines: object.lines }),
        }
      : object.path != null
        ? { path: object.path, ...(object.lines == null ? {} : { lines: object.lines }) }
        : null
  );
  if (candidate == null) return null;
  try {
    const parsed = parseAgentHandoffEvidenceSelector(candidate);
    if (parsed.start != null) return candidate;
    const whole = materializeAgentHandoffEvidenceSelector(candidate, context);
    return whole.selector;
  } catch (error) {
    if (error?.code !== "AGENT_HANDOFF_EVIDENCE_TOO_LARGE") throw error;
    const parsed = parseAgentHandoffEvidenceSelector(candidate);
    const evidence = materializeHashRefEvidenceForContext(context, parsed.ref);
    const fetched = evidence?.found ? evidence : fetchHashRefForContext(context, parsed.ref);
    if (!fetched?.found || fetched.entry?.entry_kind !== "materialized"
      || fetched.entry?.payload_text == null) {
      throw error;
    }
    const lineage = sourceLineage(fetched.entry, context);
    if (lineage.line_semantics === "source" && lineage.source_windows.length > 0) {
      const first = lineage.source_windows[0];
      const count = Math.min(
        first.source_end_line - first.source_start_line + 1,
        AGENT_HANDOFF_LIMITS.targetSelectorLines,
      );
      return {
        ref: parsed.ref,
        path: first.path,
        lines: { start: first.source_start_line, count },
      };
    }
    const lineCount = normalizedLines(fetched.entry.payload_text).length;
    const end = Math.min(Math.max(1, lineCount), AGENT_HANDOFF_LIMITS.targetSelectorLines);
    return `${parsed.ref}:1-${end}`;
  }
}

function researcherEvidenceSelectors(value, context) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      try {
        const selector = researcherEvidenceSelector(entry, context);
        return selector == null ? [] : [selector];
      } catch (error) {
        if (!isCleanableEvidenceRangeError(error)) throw error;
        recordEvidenceCleanup(context, {
          action: "drop_invalid_range",
          selector: entry,
          message: error.message,
        });
        return [];
      }
    })
    .filter(Boolean)
    .slice(0, AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim);
}

function compactResearcherClaims(value, context) {
  if (!Array.isArray(value)) return value ?? [];
  return value.map((raw) => {
    const tuple = Array.isArray(raw);
    const detail = tuple ? plainObject(raw[1]) : plainObject(raw);
    if (!detail) return raw;
    const { proof, support, evidence, ...rest } = detail;
    const selectors = researcherEvidenceSelectors([
      ...(Array.isArray(evidence) ? evidence : []),
      ...(Array.isArray(proof) ? proof : []),
      ...(Array.isArray(support) ? support : []),
    ], context);
    const narrowed = {
      ...rest,
      ...(selectors.length > 0 ? { evidence: selectors } : {}),
    };
    return tuple ? [raw[0], narrowed, ...raw.slice(2)] : narrowed;
  });
}

function researcherClaimFromNarrative(value, index) {
  const text = compactResearcherText(value);
  if (!text) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      `claims[${index}] must contain substantive claim text`,
    );
  }
  if (text.length <= 1000) return { claim: text, prose: "" };
  const colon = text.indexOf(":");
  const sentence = text.search(/[.!?](?:\s|$)/);
  const preferredEnd = colon >= 20 && colon <= 240
    ? colon + 1
    : (sentence >= 20 && sentence < 500 ? sentence + 1 : Math.min(240, text.length));
  let claim = text.slice(0, preferredEnd).trim();
  if (claim.length < text.length && !/[.!?:]$/.test(claim)) {
    const lastSpace = claim.lastIndexOf(" ");
    if (lastSpace >= 40) claim = claim.slice(0, lastSpace);
    claim = `${claim}…`;
  }
  return { claim, prose: text };
}

function researcherClaims(value, {
  evidence = [], proof = [], support = [], context = {},
} = {}) {
  const inputs = Array.isArray(value) ? value : [];
  const claims = inputs.flatMap((raw, index) => {
    if (Array.isArray(raw)) return [raw];
    if (typeof raw === "string") {
      const normalized = researcherClaimFromNarrative(raw, index);
      return [[
        normalized.claim,
        ...(normalized.prose ? [{ prose: normalized.prose }] : []),
      ]];
    }
    const source = plainObject(raw);
    if (!source) return [];
    const explicitClaim = firstAssessorText(source.claim, source.name, source.title);
    const narrative = firstAssessorText(
      source.text,
      source.prose,
      source.summary,
      source.description,
      source.reason,
    );
    if (!explicitClaim && !narrative) {
      fail(
        "AGENT_HANDOFF_SCHEMA_INVALID",
        `claims[${index}] must include claim, name, title, text, prose, summary, description, or reason`,
      );
    }
    const normalized = explicitClaim
      ? { claim: compactResearcherText(explicitClaim), prose: compactResearcherText(narrative) }
      : researcherClaimFromNarrative(narrative, index);
    const detail = {};
    const claimEvidence = researcherEvidenceSelectors([
      ...(Array.isArray(source.evidence) ? source.evidence : []),
      ...(Array.isArray(source.proof) ? source.proof : []),
      ...(Array.isArray(source.support) ? source.support : []),
    ], context);
    if (claimEvidence.length) detail.evidence = claimEvidence;
    if (normalized.prose) detail.prose = normalized.prose;
    return [[normalized.claim, detail]];
  });
  const globalEvidence = researcherEvidenceSelectors([
    ...(Array.isArray(evidence) ? evidence : []),
    ...(Array.isArray(proof) ? proof : []),
    ...(Array.isArray(support) ? support : []),
  ], context);
  if (globalEvidence.length) {
    claims.push(["Research evidence", { evidence: globalEvidence }]);
  }
  return claims;
}

function researcherStringArray(...values) {
  const value = values.find((candidate) => Array.isArray(candidate)) || [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => compactResearcherText(entry))
    .filter(Boolean);
}

function researcherFilePriorities(value, keyFiles) {
  if (!Array.isArray(value)) {
    return keyFiles.map((path, index) => ({
      path,
      rank: index + 1,
      usefulness: "primary",
      evidence: "atlas",
      reason: "Selected terminal research seed.",
    }));
  }
  return value.flatMap((raw) => {
    const entry = plainObject(raw);
    const path = firstAssessorText(entry?.path, entry?.file);
    if (!path) return [];
    const usefulness = ["primary", "supporting", "context", "low"]
      .includes(String(entry.usefulness || "").toLowerCase())
      ? String(entry.usefulness).toLowerCase()
      : "primary";
    const evidence = ["audited_file_read", "atlas", "search", "prior_research", "web"]
      .includes(String(entry.evidence || "").toLowerCase())
      ? String(entry.evidence).toLowerCase()
      : "atlas";
    return [{
      path: compactResearcherText(path),
      usefulness,
      evidence,
      reason: compactResearcherText(
        entry.reason,
        "Selected terminal research seed.",
      ).slice(0, 240),
    }];
  }).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function hasCanonicalResearcherEnvelope(source) {
  if (!Array.isArray(source.handoffs) || source.handoffs.length < 1) return false;
  if (!["researcher.pipeline.v1", "researcher.report.v1"].includes(source.profile)) {
    return false;
  }
  const expectedTarget = source.profile === "researcher.report.v1"
    ? { kind: "result", role: "$result" }
    : { kind: "pipeline", role: "$pipeline" };
  return source.handoffs.every((raw) => {
    const entry = plainObject(raw);
    if (!entry) return false;
    const target = plainObject(entry.target);
    return target?.kind === expectedTarget.kind && target?.role === expectedTarget.role;
  });
}

function normalizeResearcherTerminalArgs(source, context) {
  if (!Array.isArray(source.handoffs) || hasCanonicalResearcherEnvelope(source)) {
    return null;
  }
  const first = source.handoffs.map((entry) => plainObject(entry)).find(Boolean) || {};
  if ((typeof first.content === "string" && first.content.trim())
    || (typeof first.report === "string" && first.report.trim())) {
    fail(
      "AGENT_HANDOFF_SCHEMA_INVALID",
      "researcher report prose must use compact summary and claims with evidence selectors; handoffs[].content and string-valued handoffs[].report cannot be materialized safely",
    );
  }
  const report = plainObject(first.report) || plainObject(source.report) || {};
  const research = plainObject(report.research) || {};
  const reportScope = plainObject(report.scope) || {};
  const outcomeInput = firstAssessorText(
    source.outcome,
    source.status,
    first.outcome,
    report.outcome,
  ).toLowerCase();
  const requestedProfile = ["researcher.pipeline.v1", "researcher.report.v1"].includes(source.profile)
    ? source.profile
    : null;
  const profile = requestedProfile || (outcomeInput === "complete"
    ? "researcher.report.v1"
    : "researcher.pipeline.v1");
  const outcome = profile === "researcher.report.v1"
    ? "complete"
    : (["success", "gap", "input_required"].includes(outcomeInput)
        ? outcomeInput
        : "success");
  const keyFiles = researcherStringArray(
    first.key_files,
    first.keyFiles,
    reportScope.key_files,
    research.key_files,
    research.keyFiles,
    research.files,
    source.key_files,
  ).slice(0, 100);
  const relatedFiles = researcherStringArray(
    first.related_files,
    first.relatedFiles,
    reportScope.related_files,
    research.related_files,
    research.relatedFiles,
    source.related_files,
  ).slice(0, 100);
  const priorities = first.file_priorities
    ?? first.filePriorities
    ?? research.planner_file_priorities
    ?? research.file_priorities
    ?? research.filePriorities
    ?? source.file_priorities;
  const keySymbols = researcherStringArray(
    first.key_symbols,
    first.keySymbols,
    research.key_symbols,
    research.keySymbols,
    source.key_symbols,
  );
  const normalizedKeySymbols = normalizeResearchSymbolSeeds(keySymbols, 12);
  const patternsInput = [
    first.patterns,
    research.patterns,
    source.patterns,
  ].find((value) => Array.isArray(value)) || [];
  const patterns = patternsInput.flatMap((raw) => {
    const entry = plainObject(raw);
    const name = firstAssessorText(entry?.name, entry?.label);
    const description = firstAssessorText(entry?.description, entry?.summary);
    if (!name || !description) return [];
    return [{
      name: compactResearcherText(name).slice(0, 80),
      description: compactResearcherText(description).slice(0, 500),
    }];
  }).slice(0, 50);
  const memoriesInput = [
    first.memories,
    research.memories,
    source.memories,
  ].find((value) => Array.isArray(value)) || [];
  const memories = memoriesInput.flatMap((raw) => {
    const entry = plainObject(raw);
    const title = firstAssessorText(entry?.title);
    const content = firstAssessorText(entry?.content, entry?.summary);
    if (!title || !content) return [];
    return [{
      title: compactResearcherText(title).slice(0, 120),
      content: compactResearcherText(content).slice(0, 1200),
      key_files: researcherStringArray(entry.key_files, entry.keyFiles).slice(0, 12),
      key_symbols: normalizeResearchSymbolSeeds(
        researcherStringArray(entry.key_symbols, entry.keySymbols),
        12,
      ),
    }];
  }).slice(0, 2);
  const absenceChecks = [
    first.absence_checks,
    first.absenceChecks,
    research.absence_checks,
    research.absenceChecks,
    source.absence_checks,
  ].find((value) => Array.isArray(value)) || [];
  const verificationTargets = [
    first.verification_targets,
    first.verificationTargets,
    research.verification_targets,
    research.verificationTargets,
    source.verification_targets,
  ].find((value) => Array.isArray(value)) || [];
  const claims = researcherClaims(
    first.claims ?? report.claims ?? research.claims ?? source.claims,
    {
      evidence: first.evidence ?? report.evidence ?? research.evidence ?? source.evidence,
      proof: first.proof ?? report.proof ?? research.proof ?? source.proof,
      support: first.support ?? report.support ?? research.support ?? source.support,
      context,
    },
  );
  const target = profile === "researcher.report.v1"
    ? { kind: "result", role: "$result" }
    : { kind: "pipeline", role: "$pipeline" };
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile,
    outcome,
    handoffs: [{
      id: "research",
      depends_on: [],
      target,
      intent: "Submit terminal research",
      report: {
        summary: compactResearcherText(
          first.summary ?? report.summary ?? source.summary,
          "Research complete.",
        ),
        claims,
        scope: { key_files: keyFiles, related_files: relatedFiles },
        constraints: researcherStringArray(
          first.constraints,
          report.constraints,
          source.constraints,
        ),
        success_criteria: researcherStringArray(
          first.success_criteria,
          first.successCriteria,
          report.success_criteria,
          source.success_criteria,
        ),
        questions: researcherStringArray(
          first.questions,
          report.questions,
          source.questions,
        ),
        research: {
          key_symbols: normalizedKeySymbols,
          memories,
          planner_file_priorities: researcherFilePriorities(priorities, keyFiles),
          patterns,
          absence_checks: absenceChecks,
          verification_targets: verificationTargets,
        },
        payload: {},
      },
    }],
  };
}

function normalizeSemanticAgentHandoffArgs(args, { role = "", context = {} } = {}) {
  const source = plainObject(args);
  const normalizedRole = String(role || "agent").trim().toLowerCase() || "agent";
  if (!source) return args;
  if (normalizedRole === "assessor") {
    const normalizedAssessor = normalizeAssessorTerminalArgs(source);
    if (normalizedAssessor) return normalizedAssessor;
  }
  if (normalizedRole === "researcher") {
    const normalizedResearcher = normalizeResearcherTerminalArgs(source, context);
    if (normalizedResearcher) return normalizedResearcher;
  }
  const compactResearcherKeys = [
    "profile",
    "outcome",
    "summary",
    "claims",
    "key_files",
    "related_files",
    "key_symbols",
    "memories",
    "file_priorities",
    "patterns",
    "absence_checks",
    "verification_targets",
    "questions",
  ];
  if (normalizedRole === "researcher"
    && !Array.isArray(source.handoffs)
    && compactResearcherKeys.some((key) => Object.hasOwn(source, key))) {
    const compact = exactKeys(
      source,
      compactResearcherKeys,
      "agent_handoff",
    );
    const profile = compact.profile;
    const keyFiles = compact.key_files ?? [];
    const priorities = compact.file_priorities ?? keyFiles.map((path, index) => ({
      path,
      rank: index + 1,
      usefulness: "primary",
      evidence: "atlas",
      reason: "Selected terminal research seed.",
    }));
    const target = profile === "researcher.report.v1"
      ? { kind: "result", role: "$result" }
      : { kind: "pipeline", role: "$pipeline" };
    return {
      protocol: AGENT_HANDOFF_PROTOCOL,
      profile,
      outcome: compact.outcome,
      handoffs: [{
        id: "research",
        depends_on: [],
        target,
        intent: "Submit terminal research",
        report: {
          summary: compact.summary,
          claims: compactResearcherClaims(compact.claims, context),
          scope: {
            key_files: keyFiles,
            related_files: compact.related_files ?? [],
          },
          constraints: [],
          success_criteria: [],
          questions: compact.questions ?? [],
          research: {
            key_symbols: normalizeResearchSymbolSeeds(compact.key_symbols, 12),
            memories: compact.memories ?? [],
            planner_file_priorities: priorities,
            patterns: compact.patterns ?? [],
            absence_checks: compact.absence_checks ?? [],
            verification_targets: compact.verification_targets ?? [],
          },
          payload: {},
        },
      }],
    };
  }
  if (normalizedRole === "assessor" && !Array.isArray(source.handoffs)) {
    const compact = exactKeys(
      source,
      uniqueKeys(
        compatibilityAliasKeys("assessorCompactOutcome"),
        ["confidence", "proof", "repair", "questions"],
      ),
      "agent_handoff",
    );
    const outcome = compatibilityAlias(compact, "assessorCompactOutcome", "agent_handoff");
    if (outcome == null) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.verdict is required");
    }
    const confidence = boundedString(compact.confidence, "agent_handoff.confidence", 20);
    if (!["low", "medium", "high"].includes(confidence)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.confidence must be low, medium, or high");
    }
    const proof = boundedString(compact.proof, "agent_handoff.proof", 500);
    const repair = compact.repair == null
      ? null
      : boundedString(compact.repair, "agent_handoff.repair", 1000);
    if (outcome === "fail" && !repair) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.repair is required for fail");
    }
    if (outcome !== "fail" && repair) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.repair is only valid for fail");
    }
    const questions = compact.questions == null
      ? []
      : stringArray(compact.questions, "agent_handoff.questions", 3, 240);
    return {
      protocol: AGENT_HANDOFF_PROTOCOL,
      profile: "assessor.verdict.v1",
      outcome,
      confidence,
      handoffs: [{
        id: "verdict",
        depends_on: [],
        target: { kind: "pipeline", role: "$pipeline" },
        intent: "Submit terminal assessor verdict",
        report: {
          summary: proof,
          claims: [],
          scope: {},
          constraints: [],
          success_criteria: [],
          questions,
          payload: repair ? { repair } : {},
        },
      }],
    };
  }
  if (!Array.isArray(source.handoffs)) return args;
  // Agent-facing semantic schemas advertise only handoffs[].report. Retain
  // this fold for legacy trusted callers and transports that do not enforce
  // the advertised JSON Schema before dispatch; normalized packets remain
  // canonical and never preserve the flat fields.
  return {
    ...source,
    handoffs: source.handoffs.map((raw, index) => {
      const rawEntry = plainObject(raw);
      if (!rawEntry) return raw;
      const entry = { ...rawEntry };
      const flatReportKeys = PLANNER_REPORT_KEYS.filter((key) => Object.hasOwn(entry, key));
      const reportSource = plainObject(entry.report);
      if (reportSource || flatReportKeys.length > 0) {
        const report = { ...(reportSource || {}) };
        for (const key of flatReportKeys) {
          if (report[key] != null && !sameCompatibilityValue(report[key], entry[key])) {
            fail(
              "AGENT_HANDOFF_SCHEMA_INVALID",
              `handoffs[${index}].report.${key} conflicts with legacy flat report field handoffs[${index}].${key}`,
            );
          }
          if (report[key] == null) report[key] = entry[key];
          delete entry[key];
        }
        if (report.summary == null) report.summary = "";
        if (report.claims == null) report.claims = [];
        entry.report = report;
      }
      if (entry.id == null) entry.id = `${normalizedRole}-handoff-${index + 1}`;
      if (entry.depends_on == null) entry.depends_on = [];
      if (entry.intent == null) entry.intent = `Submit ${normalizedRole} terminal handoff`;
      return entry;
    }),
  };
}

function optionalCompletionString(source, key) {
  return source[key] == null
    ? null
    : boundedString(source[key], key, 1000);
}

function materializeTerminalCompletion(args, role) {
  if (!["dev", "fix", "artificer"].includes(role)) {
    fail("AGENT_HANDOFF_PROFILE_INVALID", `Role ${role || "unknown"} cannot use the compact completion form`);
  }
  const source = exactKeys(args || {}, COMPLETION_ARGUMENT_KEYS, "agent_handoff");
  const allowedStatuses = role === "artificer"
    ? ARTIFICER_COMPLETION_STATUSES
    : DEV_COMPLETION_STATUSES;
  const status = String(source.status || "COMPLETE").trim().toUpperCase();
  if (!allowedStatuses.includes(status)) {
    fail("AGENT_HANDOFF_OUTCOME_INVALID", `${role} completion does not allow status ${status || "<empty>"}`);
  }

  const noChangeRationale = optionalCompletionString(source, "no_change_rationale");
  const blocker = optionalCompletionString(source, "blocker");
  const verificationUnavailable = optionalCompletionString(source, "verification_unavailable");
  const evidenceGap = optionalCompletionString(source, "evidence_gap");
  const remainingWork = source.remaining_work == null
    ? []
    : stringArray(source.remaining_work, "remaining_work", 20, 1000);
  if (source.file_requests != null && !Array.isArray(source.file_requests)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "file_requests must be an array");
  }
  const fileRequests = source.file_requests == null
    ? []
    : source.file_requests.map((raw, index) => {
        const request = exactKeys(raw, ["path", "reason"], `file_requests[${index}]`);
        return {
          path: boundedString(request.path, `file_requests[${index}].path`, 500),
          reason: boundedString(request.reason, `file_requests[${index}].reason`, 1000),
        };
      });
  if (fileRequests.length > 16) fail("AGENT_HANDOFF_TOO_LARGE", "file_requests exceeds 16 items");

  if (status === "VERIFIED_NO_CHANGE" && !noChangeRationale) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "VERIFIED_NO_CHANGE requires no_change_rationale");
  }
  if (status === "PARTIAL" && remainingWork.length === 0) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "PARTIAL requires remaining_work");
  }
  if (status === "BLOCKED" && !blocker) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "BLOCKED requires blocker");
  }
  if (status !== "VERIFIED_NO_CHANGE" && noChangeRationale) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "no_change_rationale is only valid for VERIFIED_NO_CHANGE");
  }
  if (status !== "PARTIAL" && remainingWork.length > 0) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "remaining_work is only valid for PARTIAL");
  }
  if (status !== "BLOCKED" && blocker) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "blocker is only valid for BLOCKED");
  }
  if (role === "artificer" && (verificationUnavailable || fileRequests.length > 0)) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "artificer completion does not allow verification_unavailable or file_requests");
  }
  if (role !== "artificer" && evidenceGap) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", "evidence_gap is only valid for artificer completion");
  }

  const profile = role === "artificer" ? "artificer.result.v1" : "dev.result.v1";
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile,
    outcome: status.toLowerCase(),
    role,
    completion: {
      status,
      ...(noChangeRationale ? { no_change_rationale: noChangeRationale } : {}),
      ...(remainingWork.length ? { remaining_work: remainingWork } : {}),
      ...(blocker ? { blocker } : {}),
      ...(verificationUnavailable ? { verification_unavailable: verificationUnavailable } : {}),
      ...(evidenceGap ? { evidence_gap: evidenceGap } : {}),
      ...(fileRequests.length ? { file_requests: fileRequests } : {}),
    },
    handoffs: [{
      id: "result",
      depends_on: [],
      target: { kind: "pipeline", role: "$pipeline" },
      intent: "Terminal completion",
      report: {
        summary: "",
        claims: [],
        scope: {},
        constraints: [],
        success_criteria: [],
        questions: [],
        payload: {},
      },
    }],
    evidence_chars: 0,
    narrative_chars: 0,
    authoritative: true,
  };
}

function normalizeReportPayload(value, label, profile, { lenientProse = false, context = null } = {}) {
  if (value == null) return {};
  if (profile !== "assessor.verdict.v1") {
    exactKeys(value, [], label);
    return {};
  }
  const payload = exactKeys(value, ["repair"], label);
  const repair = payload.repair == null
    ? null
    : boundedString(payload.repair, `${label}.repair`, 1000, {
        lenient: lenientProse,
        context,
      });
  return repair ? { repair } : {};
}

function collectAgentHandoffValidationIssues(args, { context = {}, role = "", maxHandoffs = null } = {}) {
  const issues = [];
  const seen = new Set();
  const collectError = (error, { selector = null } = {}) => {
    const code = String(error?.code || "AGENT_HANDOFF_SCHEMA_INVALID");
    const message = String(error?.message || "Invalid agent_handoff arguments");
    const selectorText = selector == null ? null : evidenceSelectorText(selector);
    const hint = selectorText == null ? null : handoffSelectorFailureHint(code);
    const key = `${code}\0${message}\0${selectorText || ""}`;
    if (!seen.has(key) && issues.length < 24) {
      seen.add(key);
      issues.push({
        code,
        message,
        ...(selectorText == null ? {} : {
          selector: selectorText.slice(0, 500),
          hint,
        }),
      });
    }
    return null;
  };
  const capture = (fn, options = {}) => {
    try {
      return fn();
    } catch (error) {
      return collectError(error, options);
    }
  };

  const serialized = JSON.stringify(args ?? null);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_HANDOFF_LIMITS.maxCallBytes) {
    issues.push({
      code: "AGENT_HANDOFF_TOO_LARGE",
      message: `agent_handoff exceeds ${AGENT_HANDOFF_LIMITS.maxCallBytes} bytes`,
    });
  }
  const source = capture(() => exactKeys(args, ["protocol", "profile", "outcome", "confidence", "handoffs"], "agent_handoff"));
  if (!source) return issues;

  if (source.protocol !== AGENT_HANDOFF_PROTOCOL) {
    issues.push({ code: "AGENT_HANDOFF_PROTOCOL_INVALID", message: `protocol must be ${AGENT_HANDOFF_PROTOCOL}` });
  }
  const normalizedRole = String(role || "").trim().toLowerCase();
  const profile = capture(() => boundedString(source.profile, "profile", 80));
  const policy = profile ? AGENT_HANDOFF_PROFILE_POLICY[profile] : null;
  if (profile && !policy) {
    issues.push({ code: "AGENT_HANDOFF_PROFILE_INVALID", message: `Unsupported profile: ${profile}` });
  } else if (policy && !policy.roles.includes(normalizedRole)) {
    issues.push({
      code: "AGENT_HANDOFF_PROFILE_INVALID",
      message: `Role ${normalizedRole || "unknown"} cannot use ${profile}`,
    });
  }
  const outcome = capture(() => boundedString(source.outcome, "outcome", 40));
  if (policy && outcome && !policy.outcomes.includes(outcome)) {
    issues.push({
      code: "AGENT_HANDOFF_OUTCOME_INVALID",
      message: `${profile} does not allow outcome ${outcome}`,
    });
  }
  if (profile === "assessor.verdict.v1") {
    if (source.confidence == null) {
      issues.push({
        code: "AGENT_HANDOFF_SCHEMA_INVALID",
        message: "assessor confidence is required and must be low, medium, or high",
      });
    } else if (!["low", "medium", "high"].includes(String(source.confidence))) {
      issues.push({
        code: "AGENT_HANDOFF_SCHEMA_INVALID",
        message: "assessor confidence must be low, medium, or high",
      });
    }
  } else if (source.confidence != null) {
    issues.push({
      code: "AGENT_HANDOFF_SCHEMA_INVALID",
      message: `confidence is not valid for ${profile || "this profile"}`,
    });
  }

  if (!Array.isArray(source.handoffs) || source.handoffs.length < 1) {
    issues.push({ code: "AGENT_HANDOFF_SCHEMA_INVALID", message: "handoffs must contain at least one entry" });
    return issues;
  }
  const policyLimit = policy?.maxHandoffs || 50;
  const localLimit = Number.isInteger(maxHandoffs) && maxHandoffs > 0 ? maxHandoffs : policyLimit;
  const effectiveLimit = Math.min(policyLimit, localLimit);
  if (source.handoffs.length > effectiveLimit) {
    issues.push({ code: "AGENT_HANDOFF_TOO_LARGE", message: `handoffs exceeds ${effectiveLimit} entries` });
  }

  const lenientProse = isLenientHandoffProseProfile(profile);
  const evidenceFailureMode = evidenceFailureModeForProfile(profile);
  const lenientOptions = { lenient: lenientProse, context };
  for (const [handoffIndex, raw] of source.handoffs.slice(0, effectiveLimit).entries()) {
    const label = `handoffs[${handoffIndex}]`;
    const entry = capture(() => exactKeys(raw, ["id", "depends_on", "target", "intent", "report"], label));
    if (!entry) continue;
    capture(() => boundedString(entry.id, `${label}.id`, AGENT_HANDOFF_LIMITS.maxIdChars));
    capture(() => stringArray(
      entry.depends_on,
      `${label}.depends_on`,
      effectiveLimit,
      AGENT_HANDOFF_LIMITS.maxIdChars,
    ));
    capture(() => boundedString(entry.intent, `${label}.intent`, 1000, lenientOptions));
    if (policy && profile) capture(() => validateTarget(entry.target, policy, profile, `${label}.target`));

    const report = capture(() => exactKeys(
      entry.report,
      PLANNER_REPORT_KEYS,
      `${label}.report`,
    ));
    if (!report) continue;
    const researcherLimits = AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY[profile];
    const researcherReport = profile === "researcher.report.v1";
    const summaryLimit = researcherLimits
      ? (researcherLimits.maxSummaryChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
      : AGENT_HANDOFF_LIMITS.maxSummaryChars;
    const claimCountLimit = researcherLimits
      ? researcherLimits.maxClaims
      : AGENT_HANDOFF_LIMITS.maxClaims;
    const claimLengthLimit = researcherLimits
      ? (researcherLimits.maxClaimChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
      : AGENT_HANDOFF_LIMITS.maxClaimChars;
    const claimSummaryLimit = researcherLimits
      ? (researcherLimits.maxClaimSummaryChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
      : AGENT_HANDOFF_LIMITS.maxSummaryChars;
    capture(() => boundedString(
      report.summary,
      `${label}.report.summary`,
      summaryLimit,
      { required: false, ...lenientOptions },
    ));
    capture(() => normalizeScope(report.scope || {}, `${label}.report.scope`, profile));
    if (report.research != null) capture(() => normalizeResearchData(report.research, `${label}.report.research`, profile));
    capture(() => normalizePlannerReportMetadata(report, `${label}.report`, profile));
    for (const key of ["constraints", "success_criteria", "questions"]) {
      if (report[key] != null) capture(() => stringArray(
        report[key],
        `${label}.report.${key}`,
        researcherReport ? AGENT_HANDOFF_LIMITS.maxCallBytes : 50,
        researcherReport ? AGENT_HANDOFF_LIMITS.maxCallBytes : 1000,
        lenientOptions,
      ));
    }
    if (report.payload != null) capture(() => normalizeReportPayload(
      report.payload,
      `${label}.report.payload`,
      profile,
      { lenientProse, context },
    ));

    if (!Array.isArray(report.claims)) {
      issues.push({ code: "AGENT_HANDOFF_SCHEMA_INVALID", message: `${label}.report.claims must be an array` });
      continue;
    }
    if (researcherReport && report.claims.length === 0) {
      issues.push({
        code: "AGENT_HANDOFF_RESEARCH_CLAIM_EVIDENCE_REQUIRED",
        message: `${label}.report.claims requires at least one evidence-backed claim`,
      });
    }
    if (claimCountLimit != null && report.claims.length > claimCountLimit) {
      issues.push({
        code: "AGENT_HANDOFF_TOO_LARGE",
        message: `${label}.report.claims exceeds ${claimCountLimit} claims`,
      });
    }
    const claimsToValidate = claimCountLimit == null
      ? report.claims
      : report.claims.slice(0, claimCountLimit);
    for (const [claimIndex, rawClaim] of claimsToValidate.entries()) {
      const claimLabel = `${label}.report.claims[${claimIndex}]`;
      const claim = capture(() => normalizeClaimInput(rawClaim, claimIndex));
      if (!claim || claim.length < 1 || claim.length > 2) {
        if (claim) {
          issues.push({
            code: "AGENT_HANDOFF_SCHEMA_INVALID",
            message: `${claimLabel} must be a named claim object or [claim, optional evidence]`,
          });
        }
        continue;
      }
      capture(() => boundedString(
        claim[0],
        `${claimLabel}.claim`,
        claimLengthLimit,
        lenientOptions,
      ));
      if (claim.length === 1) continue;
      const detail = capture(() => normalizeClaimDetail(claim[1], `${claimLabel}.evidence`));
      if (!detail) continue;
      if (detail.prose != null) capture(() => boundedString(
        detail.prose,
        `${claimLabel}.prose`,
        claimSummaryLimit,
        { required: false, ...lenientOptions },
      ));
      const selectors = new Set();
      if (detail.evidence != null) {
        const selectorFailures = [];
        for (const selector of detail.evidence) {
          let evidence = null;
          try {
            evidence = materializeAgentHandoffEvidenceSelector(selector, context);
          } catch (error) {
            selectorFailures.push({ selector, error });
          }
          if (evidence?.selector) selectors.add(evidence.selector);
        }
        for (const { selector, error } of selectorFailures) {
          const action = (evidenceFailureMode === "demote" && selectors.size > 0
            ? alternateEvidenceCleanupAction(error)
            : null)
            || evidenceRecoveryAction(error, evidenceFailureMode)
            || alternateEvidenceCleanupAction(error, {
              lenient: evidenceFailureMode === "annotate",
            });
          if ((selectors.size > 0 || evidenceFailureMode != null) && action) {
            recordEvidenceCleanup(context, {
              action,
              selector,
              code: error.code,
              message: error.message,
            });
          } else collectError(error, { selector });
        }
      }
      if (detail.decoy != null) {
        if (!Array.isArray(detail.decoy)) {
          issues.push({ code: "AGENT_HANDOFF_SCHEMA_INVALID", message: `${claimLabel}.decoy must be an array` });
        } else {
          for (const [decoyIndex, rawDecoy] of detail.decoy.entries()) {
            const decoy = capture(() => normalizeDecoyInput(
              rawDecoy,
              `${claimLabel}.decoy[${decoyIndex}]`,
            ));
            if (!decoy || decoy.length !== 2) continue;
            let evidence = null;
            try {
              evidence = materializeAgentHandoffEvidenceSelector(decoy[0], context);
            } catch (error) {
              const action = evidenceRecoveryAction(error, evidenceFailureMode);
              if (action) {
                recordEvidenceCleanup(context, {
                  action: "drop_unverifiable_decoy_selector",
                  selector: decoy[0],
                  code: error.code,
                  message: error.message,
                });
              } else {
                collectError(error, { selector: decoy[0] });
              }
            }
            if (evidence?.selector) selectors.add(evidence.selector);
            capture(() => boundedString(decoy[1], `${claimLabel}.decoy[${decoyIndex}].reason`, 500));
          }
        }
      }
      if (selectors.size > AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim) {
        issues.push({
          code: "AGENT_HANDOFF_TOO_LARGE",
          message: `${claimLabel} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim} selectors`,
        });
      }
    }
  }
  return issues;
}

function handoffSelectorFailureHint(code) {
  if (code === "AGENT_HANDOFF_EVIDENCE_RANGE_INVALID") {
    return "Choose a range wholly inside one recorded source window; continuation views accept source or page coordinates.";
  }
  if (["AGENT_HANDOFF_EVIDENCE_NOT_FOUND", "AGENT_HANDOFF_EVIDENCE_NOT_VISIBLE"].includes(code)) {
    return "Fetch the traversal ref first or cite an evidence ref already visible to this agent call.";
  }
  if (code === "AGENT_HANDOFF_EVIDENCE_PATH_NOT_SURFACED") {
    return "Read the cited source range, or inspect a binary artifact with read_image_metadata, before retrying the handoff.";
  }
  return "Correct this selector and retry the handoff.";
}

function failCollectedAgentHandoffIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return;
  const failingSelectors = issues
    .filter((issue) => issue?.selector)
    .map((issue) => ({ selector: issue.selector, code: issue.code, hint: issue.hint }));
  if (issues.length === 1) {
    const error = new Error(issues[0].message);
    error.code = issues[0].code;
    if (failingSelectors.length > 0) error.failing_selectors = failingSelectors;
    throw error;
  }
  const error = new Error(
    `agent_handoff rejected with ${issues.length} issues: ${issues.map((issue, index) => `${index + 1}. ${issue.message}`).join(" | ")}`,
  );
  error.code = "AGENT_HANDOFF_VALIDATION_FAILED";
  error.issues = issues;
  if (failingSelectors.length > 0) error.failing_selectors = failingSelectors;
  throw error;
}

function materializeAgentHandoffStrict(args, { context = {}, role = "", maxHandoffs = null } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const materializationContext = {
    ...context,
    [EVIDENCE_MATERIALIZATION_CACHE]: new Map(),
    [EVIDENCE_CLEANUP]: [],
  };
  const normalizedArgs = normalizeSemanticAgentHandoffArgs(
    normalizePlannerAgentHandoffArgs(args, { role: normalizedRole }),
    { role: normalizedRole, context },
  );
  const serialized = JSON.stringify(normalizedArgs ?? null);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_HANDOFF_LIMITS.maxCallBytes) {
    fail("AGENT_HANDOFF_TOO_LARGE", `agent_handoff exceeds ${AGENT_HANDOFF_LIMITS.maxCallBytes} bytes`);
  }
  if (looksLikeTerminalCompletion(normalizedArgs || {})) {
    return materializeTerminalCompletion(normalizedArgs || {}, normalizedRole);
  }
  failCollectedAgentHandoffIssues(collectAgentHandoffValidationIssues(normalizedArgs, {
    context: materializationContext,
    role: normalizedRole,
    maxHandoffs,
  }));
  const source = exactKeys(normalizedArgs, ["protocol", "profile", "outcome", "confidence", "handoffs"], "agent_handoff");
  if (source.protocol !== AGENT_HANDOFF_PROTOCOL) fail("AGENT_HANDOFF_PROTOCOL_INVALID", `protocol must be ${AGENT_HANDOFF_PROTOCOL}`);
  const profile = boundedString(source.profile, "profile", 80);
  const policy = AGENT_HANDOFF_PROFILE_POLICY[profile];
  if (!policy) fail("AGENT_HANDOFF_PROFILE_INVALID", `Unsupported profile: ${profile}`);
  if (!policy.roles.includes(normalizedRole)) fail("AGENT_HANDOFF_PROFILE_INVALID", `Role ${normalizedRole || "unknown"} cannot use ${profile}`);
  const outcome = boundedString(source.outcome, "outcome", 40);
  if (!policy.outcomes.includes(outcome)) fail("AGENT_HANDOFF_OUTCOME_INVALID", `${profile} does not allow outcome ${outcome}`);
  let confidence = null;
  if (profile === "assessor.verdict.v1") {
    if (source.confidence == null) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "assessor confidence is required and must be low, medium, or high");
    }
    confidence = boundedString(source.confidence, "confidence", 20);
    if (!["low", "medium", "high"].includes(confidence)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "assessor confidence must be low, medium, or high");
    }
  } else if (source.confidence != null) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `confidence is not valid for ${profile}`);
  }
  if (!Array.isArray(source.handoffs) || source.handoffs.length < 1) fail("AGENT_HANDOFF_SCHEMA_INVALID", "handoffs must contain at least one entry");
  const localLimit = Number.isInteger(maxHandoffs) && maxHandoffs > 0 ? maxHandoffs : policy.maxHandoffs;
  const effectiveLimit = Math.min(policy.maxHandoffs, localLimit);
  if (source.handoffs.length > effectiveLimit) fail("AGENT_HANDOFF_TOO_LARGE", `handoffs exceeds ${effectiveLimit} entries`);
  const lenientProse = isLenientHandoffProseProfile(profile);
  const evidenceFailureMode = evidenceFailureModeForProfile(profile);
  const counters = { evidence: 0, narrative: 0 };
  const researcherLimits = AGENT_HANDOFF_RESEARCHER_LIMIT_POLICY[profile];
  const researcherReport = profile === "researcher.report.v1";
  const summaryLimit = researcherLimits
    ? (researcherLimits.maxSummaryChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
    : AGENT_HANDOFF_LIMITS.maxSummaryChars;
  const claimCountLimit = researcherLimits
    ? researcherLimits.maxClaims
    : AGENT_HANDOFF_LIMITS.maxClaims;
  const claimLengthLimit = researcherLimits
    ? (researcherLimits.maxClaimChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
    : AGENT_HANDOFF_LIMITS.maxClaimChars;
  const claimSummaryLimit = researcherLimits
    ? (researcherLimits.maxClaimSummaryChars ?? AGENT_HANDOFF_LIMITS.maxCallBytes)
    : AGENT_HANDOFF_LIMITS.maxSummaryChars;
  const handoffs = source.handoffs.map((raw, index) => {
    if (!researcherReport
      && Buffer.byteLength(JSON.stringify(raw), "utf8") > AGENT_HANDOFF_LIMITS.maxEntryBytes) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}] exceeds ${AGENT_HANDOFF_LIMITS.maxEntryBytes} bytes`);
    }
    const entryCounters = { evidence: 0, narrative: 0 };
    const entry = exactKeys(raw, ["id", "depends_on", "target", "intent", "report"], `handoffs[${index}]`);
    const id = boundedString(entry.id, `handoffs[${index}].id`, AGENT_HANDOFF_LIMITS.maxIdChars);
    const dependsOn = stringArray(
      entry.depends_on,
      `handoffs[${index}].depends_on`,
      effectiveLimit,
      AGENT_HANDOFF_LIMITS.maxIdChars,
    );
    const intent = boundedString(entry.intent, `handoffs[${index}].intent`, 1000, {
      lenient: lenientProse,
      context: materializationContext,
    });
    entryCounters.narrative += intent.length;
    const reportLabel = `handoffs[${index}].report`;
    const report = exactKeys(entry.report, PLANNER_REPORT_KEYS, reportLabel);
    let summary = boundedString(
      report.summary,
      `handoffs[${index}].report.summary`,
      summaryLimit,
      { required: false, lenient: lenientProse, context: materializationContext },
    );
    entryCounters.narrative += summary.length;
    if (!Array.isArray(report.claims)) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", `handoffs[${index}].report.claims must be an array`);
    }
    if (researcherReport && report.claims.length === 0) {
      fail(
        "AGENT_HANDOFF_RESEARCH_CLAIM_EVIDENCE_REQUIRED",
        `handoffs[${index}].report.claims requires at least one evidence-backed claim`,
      );
    }
    if (claimCountLimit != null && report.claims.length > claimCountLimit) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}].report.claims exceeds ${claimCountLimit} claims`);
    }
    let claims = report.claims.map((claim, claimIndex) => materializeClaim(
      claim,
      claimIndex,
      materializationContext,
      entryCounters,
      {
        maxClaimChars: claimLengthLimit,
        maxProseChars: claimSummaryLimit,
        lenientProse,
        evidenceFailureMode,
      },
    ));
    if (STRICT_CLAIM_EVIDENCE_RECOVERY_PROFILES.has(profile)) {
      const unverifiedClaims = claims.filter((claim) => (
        profile === "researcher.report.v1"
          ? !Array.isArray(claim?.[1]?.evidence)
            || !claim[1].evidence.some(isGroundedClaimEvidence)
          : claim[CLAIM_EVIDENCE_DEMOTION] === true
      ));
      if (unverifiedClaims.length > 0) {
        const previousSummary = summary;
        const unverifiedSet = new Set(unverifiedClaims);
        const retainedClaims = claims.filter((claim) => !unverifiedSet.has(claim));
        summary = appendUnverifiedClaimSummaryNote(
          rewriteSummaryEvidenceLabels(summary, claims, retainedClaims),
          unverifiedClaims,
          summaryLimit,
        );
        entryCounters.narrative -= unverifiedClaims.reduce(
          (total, claim) => total + claimNarrativeChars(claim),
          0,
        );
        entryCounters.narrative += summary.length - previousSummary.length;
        for (const [claimIndex, claim] of unverifiedClaims.entries()) {
          recordEvidenceCleanup(materializationContext, {
            action: "demote_unverified_claim_to_summary",
            selector: `<claim:${claimIndex + 1}>`,
            code: "AGENT_HANDOFF_CLAIM_EVIDENCE_UNAVAILABLE",
            message: String(claim?.[0] || ""),
          });
        }
        claims = retainedClaims;
      }
    }
    if (profile === "researcher.report.v1") {
      validateResearchClaimEvidence(claims, reportLabel);
    }
    if (AGENT_HANDOFF_ASSESSOR_FAIL_EVIDENCE_POLICY.profiles.includes(profile)
      && AGENT_HANDOFF_ASSESSOR_FAIL_EVIDENCE_POLICY.outcomes.includes(outcome)) {
      const hasGroundedDefect = claims.some((claim) => (
        Array.isArray(claim?.[1]?.evidence)
        && claim[1].evidence.some(isGroundedClaimEvidence)
      ));
      if (!hasGroundedDefect) {
        fail(
          "AGENT_HANDOFF_ASSESSOR_FAIL_EVIDENCE_REQUIRED",
          `${reportLabel}.claims requires at least one evidence-backed defect claim for a fail verdict`,
        );
      }
    }
    const reportListMaxItems = researcherReport ? AGENT_HANDOFF_LIMITS.maxCallBytes : 50;
    const reportListMaxChars = researcherReport ? AGENT_HANDOFF_LIMITS.maxCallBytes : 1000;
    const reportListOptions = { lenient: lenientProse, context: materializationContext };
    const constraints = report.constraints == null ? [] : stringArray(
      report.constraints,
      `handoffs[${index}].report.constraints`,
      reportListMaxItems,
      reportListMaxChars,
      reportListOptions,
    );
    const successCriteria = report.success_criteria == null ? [] : stringArray(
      report.success_criteria,
      `handoffs[${index}].report.success_criteria`,
      reportListMaxItems,
      reportListMaxChars,
      reportListOptions,
    );
    const questions = report.questions == null ? [] : stringArray(
      report.questions,
      `handoffs[${index}].report.questions`,
      reportListMaxItems,
      reportListMaxChars,
      reportListOptions,
    );
    const research = normalizeResearchData(report.research, `${reportLabel}.research`, profile);
    validateResearchAbsenceClaims(research, claims, `${reportLabel}.research`);
    const plannerMetadata = normalizePlannerReportMetadata(report, reportLabel, profile);
    entryCounters.narrative += [...constraints, ...successCriteria, ...questions].reduce((sum, text) => sum + text.length, 0);
    const payload = normalizeReportPayload(report.payload, `${reportLabel}.payload`, profile, {
      lenientProse,
      context: materializationContext,
    });
    const structuredMetadataLength = structuredStringLength(research)
      + structuredStringLength(plannerMetadata)
      + structuredStringLength(payload);
    if (!researcherReport
      && structuredMetadataLength > AGENT_HANDOFF_LIMITS.maxStructuredMetadataChars) {
      fail(
        "AGENT_HANDOFF_TOO_LARGE",
        `handoffs[${index}] exceeds the ${AGENT_HANDOFF_LIMITS.maxStructuredMetadataChars}-character structured metadata limit`,
      );
    }
    let narrativeLimit = null;
    if (!researcherReport) {
      narrativeLimit = normalizedRole === "subagent"
        ? AGENT_HANDOFF_LIMITS.maxCitationChildNarrativeChars
        : AGENT_HANDOFF_LIMITS.maxNarrativeChars;
    }
    if (narrativeLimit != null && entryCounters.narrative > narrativeLimit) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}] exceeds the ${narrativeLimit}-character narrative limit for role ${normalizedRole || "unknown"}`);
    }
    counters.narrative += entryCounters.narrative;
    counters.evidence += entryCounters.evidence;
    const handoff = {
      id,
      depends_on: dependsOn,
      target: validateTarget(entry.target, policy, profile, `handoffs[${index}].target`),
      intent,
      report: {
        summary,
        claims,
        scope: normalizeScope(report.scope || {}, `handoffs[${index}].report.scope`, profile),
        constraints,
        success_criteria: successCriteria,
        questions,
        ...(research == null ? {} : { research }),
        ...plannerMetadata,
        payload,
      },
    };
    validateNarrativeEvidenceBoundary(handoff, index);
    return handoff;
  });
  validateDependencyGraph(handoffs);
  const semanticPacket = { profile, outcome, handoffs };
  validatePlannerPacketSemantics(semanticPacket);
  validatePlannerCompatibilityTasks(semanticPacket);
  validateCitationChildPacketSemantics({ profile, outcome, handoffs });
  const uniqueEvidence = packetEvidence({ handoffs });
  const evidenceChars = uniqueEvidence.reduce(
    (total, evidence) => total + String(evidence?.excerpt || "").length,
    0,
  );
  const evidenceLimit = normalizedRole === "subagent"
    ? AGENT_HANDOFF_LIMITS.maxCitationChildEvidenceChars
    : AGENT_HANDOFF_LIMITS.maxEvidenceChars;
  if (evidenceChars > evidenceLimit) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Materialized evidence exceeds ${evidenceLimit} characters for role ${normalizedRole || "unknown"}`);
  }
  const packet = {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile,
    outcome,
    ...(confidence == null ? {} : { confidence }),
    role: normalizedRole,
    handoffs,
    evidence_chars: evidenceChars,
    narrative_chars: counters.narrative,
    authoritative: true,
  };
  const cleanupItems = materializationContext[EVIDENCE_CLEANUP]
    .map(({ key: _key, ...entry }) => entry);
  if (cleanupItems.length > 0) {
    Object.defineProperty(packet, "evidence_cleanup", {
      value: Object.freeze({ count: cleanupItems.length, items: Object.freeze(cleanupItems) }),
      enumerable: false,
    });
  }
  return packet;
}

export function materializeAgentHandoff(args, options = {}) {
  const serialized = JSON.stringify(args ?? null);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_HANDOFF_LIMITS.maxCallBytes) {
    fail("AGENT_HANDOFF_TOO_LARGE", `agent_handoff exceeds ${AGENT_HANDOFF_LIMITS.maxCallBytes} bytes`);
  }
  const {
    value: packet,
    ignoredFieldCount,
    ignoredFields,
  } = runWithHandoffFieldDiagnostics(() => materializeAgentHandoffStrict(args, options));
  if (ignoredFieldCount > 0) {
    Object.defineProperties(packet, {
      ignored_field_count: {
        value: ignoredFieldCount,
        enumerable: false,
      },
      ignored_fields: {
        value: Object.freeze(ignoredFields),
        enumerable: false,
      },
    });
  }
  if (packet.evidence_cleanup?.count > 0) {
    try {
      const context = options?.context || {};
      recordObservation({
        ...(context.db ? { db: context.db } : {}),
        work_item_id: context.work_item_id ?? context.workItemId ?? null,
        job_id: context.job_id ?? context.jobId ?? null,
        attempt_id: context.attempt_id ?? context.attemptId ?? null,
        observation_type: "agent_handoff.evidence_cleanup",
        summary: `Cleaned ${packet.evidence_cleanup.count} terminal evidence selector(s)`,
        detail: packet.evidence_cleanup,
      });
    } catch {
      // Cleanup telemetry must never turn an accepted handoff into a retry.
    }
  }
  return packet;
}

function ensureSchema(db = getDb()) {
  if (READY_DBS.has(db)) return db;
  createAgentHandoffPacketTable(db);
  READY_DBS.add(db);
  return db;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function successfulImageGenerationObserved(context) {
  const attemptId = positiveInt(context?.attemptId ?? context?.attempt_id);
  const agentCallId = positiveInt(context?.agentCallId ?? context?.agent_call_id);
  if (!attemptId || !agentCallId) return false;
  let rows = [];
  try {
    rows = (context?.db || getDb()).prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.generate_image'
      ORDER BY id ASC
    `).all(attemptId);
  } catch {
    return false;
  }
  return rows.some((row) => {
    const detail = parseJsonObject(row?.detail_json);
    return Number(detail.agent_call_id) === agentCallId
      && detail.phase === "finish"
      && detail.ok !== false
      && (!detail.outcome || detail.outcome === "succeeded");
  });
}

function enforceArtificerImageGeneration(packet, call, context) {
  const role = String(call?.role || packet?.role || "").trim().toLowerCase();
  const complete = packet?.profile === "artificer.result.v1"
    && (packet?.completion?.status === "COMPLETE" || packet?.outcome === "complete");
  if (role !== "artificer" || !complete) return;
  const payload = parseJsonObject(call?.payload_json);
  if (payload.task_mode !== "image" && payload.needs_image_generation !== true) return;
  if (successfulImageGenerationObserved(context)) return;
  fail(
    "AGENT_HANDOFF_IMAGE_GENERATION_REQUIRED",
    "Image artificer completion requires a successful generate_image tool call in the current agent call. Generate a raster image (.png, .jpg, .jpeg, or .webp), validate it, then retry agent_handoff; hand-authored SVG does not satisfy this task",
  );
}

function handoffRow(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return null;
  return ensureSchema(db).prepare(`SELECT * FROM ${TABLE} WHERE agent_call_id = ?`).get(id) || null;
}

function boundedHandoffRejection(error) {
  const code = String(error?.code || "AGENT_HANDOFF_REJECTED").slice(0, 120);
  const message = String(error?.message || error || "agent_handoff was rejected").slice(0, 1000);
  const issues = Array.isArray(error?.issues)
    ? error.issues.slice(0, 24).map((issue) => ({
        code: String(issue?.code || "AGENT_HANDOFF_SCHEMA_INVALID").slice(0, 120),
        message: String(issue?.message || "Invalid agent_handoff arguments").slice(0, 500),
        ...(issue?.selector ? { selector: String(issue.selector).slice(0, 500) } : {}),
        ...(issue?.hint ? { hint: String(issue.hint).slice(0, 500) } : {}),
      }))
    : [];
  const failing_selectors = Array.isArray(error?.failing_selectors)
    ? error.failing_selectors.slice(0, 24).map((failure) => ({
        selector: String(failure?.selector || "").slice(0, 500),
        code: String(failure?.code || "AGENT_HANDOFF_SCHEMA_INVALID").slice(0, 120),
        hint: String(failure?.hint || "Correct this selector and retry the handoff.").slice(0, 500),
      })).filter((failure) => failure.selector)
    : issues.filter((issue) => issue.selector).map((issue) => ({
        selector: issue.selector,
        code: issue.code,
        hint: issue.hint || "Correct this selector and retry the handoff.",
      }));
  return { code, message, issues, failing_selectors };
}

export function recordAgentHandoffRejection(agentCallId, error, { db = getDb() } = {}) {
  const id = positiveInt(agentCallId);
  if (!id) return false;
  try {
    const call = db.prepare(`
      SELECT work_item_id, job_id, attempt_id
      FROM agent_calls
      WHERE id = ?
    `).get(id);
    if (!call) return false;
    const rejection = boundedHandoffRejection(error);
    return recordObservation({
      db,
      work_item_id: positiveInt(call.work_item_id),
      job_id: positiveInt(call.job_id),
      attempt_id: positiveInt(call.attempt_id),
      observation_type: "agent_handoff.rejected",
      summary: `Rejected terminal agent handoff (${rejection.code})`,
      detail: {
        agent_call_id: id,
        code: rejection.code,
        message: rejection.message,
        ...(rejection.issues.length > 0 ? { issues: rejection.issues } : {}),
        ...(rejection.failing_selectors.length > 0
          ? { failing_selectors: rejection.failing_selectors }
          : {}),
      },
    });
  } catch {
    return false;
  }
}

function latestAgentHandoffRejection(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return null;
  try {
    const row = db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE observation_type = 'agent_handoff.rejected'
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.agent_call_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(id);
    if (!row?.detail_json) return null;
    const detail = JSON.parse(row.detail_json);
    return plainObject(detail) ? boundedHandoffRejection({
      code: detail.code,
      message: detail.message,
      issues: detail.issues,
      failing_selectors: detail.failing_selectors,
    }) : null;
  } catch {
    return null;
  }
}

export function getLatestAgentHandoffRejection(agentCallId, { db = getDb() } = {}) {
  return latestAgentHandoffRejection(agentCallId, db);
}

export function getAgentHandoffRecord(agentCallId, { db = getDb() } = {}) {
  const row = handoffRow(agentCallId, db);
  if (!row) return null;
  return { ...row, packet: parseStoredAgentHandoffPacket(row.materialized_packet_json) };
}

function mapStoredClaimEvidence(claim, mapEvidence) {
  const detail = claim?.[1];
  if (!detail || typeof detail !== "object") return claim;
  const mapped = { ...detail };
  for (const lane of ["evidence", "proof", "support"]) {
    if (Array.isArray(detail[lane])) mapped[lane] = detail[lane].map(mapEvidence);
  }
  if (Array.isArray(detail.decoy)) {
    mapped.decoy = detail.decoy.map(([evidence, reason]) => [mapEvidence(evidence), reason]);
  }
  return [claim[0], mapped];
}

function mapStoredPacketEvidence(packet, mapEvidence) {
  return {
    ...packet,
    handoffs: (packet.handoffs || []).map((handoff) => ({
      ...handoff,
      report: {
        ...handoff.report,
        claims: (handoff.report?.claims || []).map((claim) => mapStoredClaimEvidence(claim, mapEvidence)),
      },
    })),
  };
}

function serializeStoredAgentHandoffPacket(packet) {
  const evidenceCatalog = packetEvidence(packet);
  if (evidenceCatalog.length === 0) return JSON.stringify(packet);
  const evidenceIds = new Map(evidenceCatalog.map((evidence, index) => [evidence.selector, index]));
  const stored = mapStoredPacketEvidence(packet, (evidence) => ({
    evidence_id: evidenceIds.get(evidence.selector),
  }));
  stored.evidence_catalog = evidenceCatalog;
  return JSON.stringify(stored);
}

function parseStoredAgentHandoffPacket(materializedJson) {
  const stored = JSON.parse(materializedJson);
  if (!Array.isArray(stored.evidence_catalog)) return stored;
  const selectors = new Set();
  for (const evidence of stored.evidence_catalog) {
    const selector = String(evidence?.selector || "");
    if (!selector || selectors.has(selector)) {
      fail("AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED", "Stored agent_handoff evidence catalog is invalid");
    }
    selectors.add(selector);
  }
  const packet = mapStoredPacketEvidence(stored, (pointer) => {
    const evidenceId = Number(pointer?.evidence_id);
    const evidence = Number.isInteger(evidenceId) && evidenceId >= 0
      ? stored.evidence_catalog[evidenceId]
      : null;
    if (!evidence) {
      fail("AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED", "Stored agent_handoff evidence pointer is missing");
    }
    return evidence;
  });
  delete packet.evidence_catalog;
  return packet;
}

export function stageAgentHandoff(args, {
  context = {},
  role = "",
  maxHandoffs = null,
  projectDir = null,
  scopePredicates = null,
  db = getDb(),
} = {}) {
  const agentCallId = positiveInt(context.agentCallId ?? context.agent_call_id);
  if (!agentCallId) fail("AGENT_HANDOFF_CONTEXT_INVALID", "agent_handoff requires an active agent call");
  const database = ensureSchema(db);
  const call = database.prepare(`
    SELECT ac.work_item_id, ac.job_id, ac.attempt_id, ac.role, j.payload_json
    FROM agent_calls ac
    LEFT JOIN jobs j ON j.id = ac.job_id
    WHERE ac.id = ?
  `).get(agentCallId);
  if (!call) fail("AGENT_HANDOFF_CONTEXT_INVALID", "agent_handoff agent call does not exist");
  const resolvedContext = {
    workItemId: positiveInt(call.work_item_id),
    jobId: positiveInt(call.job_id),
    attemptId: positiveInt(call.attempt_id),
    agentCallId,
    projectDir,
    scopePredicates,
    db: database,
  };
  const effectiveRole = String(call.role || role || "");
  const packet = materializeAgentHandoff(args, { context: resolvedContext, role: effectiveRole, maxHandoffs });
  enforceArtificerImageGeneration(packet, call, resolvedContext);
  const diagnostics = {
    ...(packet.ignored_field_count > 0 ? {
      ignored_field_count: packet.ignored_field_count,
      ignored_fields: packet.ignored_fields,
    } : {}),
  };
  const hasDiagnostics = Object.keys(diagnostics).length > 0;
  const workItem = resolvedContext.workItemId
    ? database.prepare("SELECT metadata_json FROM work_items WHERE id = ?").get(resolvedContext.workItemId)
    : null;
  validatePlannerPacketAgainstWorkItem(packet, workItem);
  const fileKindIssues = validatePlannerPacketFileKinds(packet, projectDir);
  if (fileKindIssues.length > 0) {
    fail(
      "AGENT_HANDOFF_SCOPE_KIND_INVALID",
      `planner file-kind validation failed: ${fileKindIssues.map((issue) => (
        `task "${issue.taskId}" ${issue.declaredKind} path "${issue.path}" is invalid: ${issue.reason}`
      )).join("; ")}. Correct the path or declared file kind, then retry agent_handoff`,
    );
  }
  packet.agent_call_id = agentCallId;
  packet.work_item_id = resolvedContext.workItemId;
  packet.job_id = resolvedContext.jobId;
  packet.attempt_id = resolvedContext.attemptId;
  const materializedJson = serializeStoredAgentHandoffPacket(packet);
  const digest = crypto.createHash("sha256").update(materializedJson).digest("hex");
  const existing = handoffRow(agentCallId, database);
  if (existing) {
    if (existing.packet_digest === digest && ["staged", "committed"].includes(existing.status)) {
      if (existing.status === "staged") {
        database.prepare(`
          UPDATE ${TABLE}
          SET stage_count=stage_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE agent_call_id=? AND status='staged'
        `).run(agentCallId);
      }
      return {
        ok: true,
        status: existing.status,
        digest,
        idempotent: true,
        callCount: Number(existing.stage_count || 1) + (existing.status === "staged" ? 1 : 0),
        ...(hasDiagnostics ? { diagnostics } : {}),
      };
    }
    if (existing.status === "staged") {
      database.prepare(`UPDATE ${TABLE} SET status='rejected', rejection_code='duplicate_conflict', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_call_id=? AND status='staged'`).run(agentCallId);
    }
    fail("AGENT_HANDOFF_DUPLICATE_CONFLICT", "A different agent_handoff is already staged for this agent call");
  }
  database.prepare(`
    INSERT INTO ${TABLE} (
      agent_call_id, work_item_id, job_id, attempt_id, role, profile, outcome,
      status, materialized_packet_json, packet_digest, evidence_chars
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)
  `).run(
    agentCallId,
    resolvedContext.workItemId,
    resolvedContext.jobId,
    resolvedContext.attemptId,
    packet.role,
    packet.profile,
    packet.outcome,
    materializedJson,
    digest,
    packet.evidence_chars,
  );
  recordAtlasTrunkHitRate(packet, resolvedContext);
  return {
    ok: true,
    status: "staged",
    digest,
    idempotent: false,
    callCount: 1,
    ...(hasDiagnostics ? { diagnostics } : {}),
  };
}

function recordAtlasTrunkHitRate(packet, context) {
  const database = context?.db || getDb();
  const jobId = positiveInt(context?.jobId ?? context?.job_id);
  const attemptId = positiveInt(context?.attemptId ?? context?.attempt_id);
  if (!jobId) return false;
  try {
    const row = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE job_id = ?
        AND observation_type = 'atlas.prefetch.trunk'
        AND (? IS NULL OR attempt_id = ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(jobId, attemptId, attemptId);
    if (!row?.detail_json) return false;
    const trunk = JSON.parse(row.detail_json);
    const rankedFiles = canonicalPathList(trunk?.ranked_files);
    const surveyFiles = canonicalPathList(trunk?.survey_files);
    const pointedFiles = canonicalPathList(
      Array.isArray(trunk?.pointed_files)
        ? trunk.pointed_files
        : [...rankedFiles, ...surveyFiles],
    );
    const citedFiles = citedSourcePaths(packet);
    const pointed = new Set(pointedFiles);
    const hitFiles = citedFiles.filter((file) => pointed.has(file));
    const hitRate = citedFiles.length > 0 ? hitFiles.length / citedFiles.length : null;
    const pointedPrecision = pointedFiles.length > 0 ? hitFiles.length / pointedFiles.length : null;
    return recordObservation({
      db: database,
      work_item_id: positiveInt(context?.workItemId ?? context?.work_item_id),
      job_id: jobId,
      attempt_id: attemptId,
      observation_type: "atlas.prefetch.trunk_hit_rate",
      summary: `ATLAS trunk covered ${hitFiles.length}/${citedFiles.length} terminally cited file(s)`,
      detail: {
        kind: "atlas_prefetch_trunk_hit_rate",
        ranked_files: rankedFiles,
        survey_files: surveyFiles,
        pointed_files: pointedFiles,
        cited_files: citedFiles,
        hit_files: hitFiles,
        pointed_file_count: pointedFiles.length,
        cited_file_count: citedFiles.length,
        hit_file_count: hitFiles.length,
        hit_rate: hitRate,
        pointed_precision: pointedPrecision,
      },
    });
  } catch {
    return false;
  }
}

function citedSourcePaths(packet) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const sourcePath = canonicalSourcePath(value);
    if (!sourcePath || seen.has(sourcePath)) return;
    seen.add(sourcePath);
    out.push(sourcePath);
  };
  for (const handoff of Array.isArray(packet?.handoffs) ? packet.handoffs : []) {
    for (const claim of Array.isArray(handoff?.report?.claims) ? handoff.report.claims : []) {
      const detail = claim?.[1];
      for (const lane of ["evidence", "proof", "support"]) {
        for (const evidence of Array.isArray(detail?.[lane]) ? detail[lane] : []) {
          push(evidence?.path);
          for (const window of Array.isArray(evidence?.provenance?.source_windows)
            ? evidence.provenance.source_windows
            : []) {
            push(window?.path);
          }
        }
      }
    }
  }
  return out.sort();
}

function canonicalPathList(value) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const sourcePath = canonicalSourcePath(entry);
    if (!sourcePath || seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    out.push(sourcePath);
  }
  return out;
}

export function rejectAgentHandoffForLaterTool(agentCallId, toolName, { db = getDb() } = {}) {
  const row = handoffRow(agentCallId, db);
  if (!row || !["staged", "committed"].includes(row.status)) return false;
  if (row.status === "staged") {
    ensureSchema(db).prepare(`
      UPDATE ${TABLE}
      SET status='rejected', rejection_code=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agent_call_id=? AND status='staged'
    `).run(`later_tool:${String(toolName || "unknown").slice(0, 80)}`, Number(agentCallId));
  }
  return true;
}

function renderedEvidenceSelector(evidence) {
  if (evidence?.path && Number.isInteger(evidence.source_start_line)
    && Number.isInteger(evidence.source_end_line)) {
    return `${evidence.path}:${evidence.source_start_line}-${evidence.source_end_line}`;
  }
  if (evidence?.provenance?.line_semantics === "source"
    && Array.isArray(evidence.provenance.source_windows)
    && evidence.provenance.source_windows.length > 0) {
    return evidence.provenance.source_windows.map((window) => (
      `${window.path}:${window.source_start_line}-${window.source_end_line}`
    )).join(", ");
  }
  return evidence?.selector || evidence?.ref || "unavailable";
}

function renderExpandedEvidence(report, maxChars = AGENT_HANDOFF_LIMITS.recommendedEvidenceChars) {
  const bySelector = new Map();
  const add = (evidence, lane, reason = null) => {
    if (!evidence?.selector || !evidence?.excerpt) return;
    const existing = bySelector.get(evidence.selector);
    if (existing) {
      existing.lanes.add(lane);
      if (reason) existing.reasons.add(reason);
      return;
    }
    bySelector.set(evidence.selector, {
      evidence,
      lanes: new Set([lane]),
      reasons: new Set(reason ? [reason] : []),
    });
  };
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const lane of ["evidence", "proof", "support"]) {
      for (const evidence of detail[lane] || []) add(evidence, lane);
    }
    for (const [evidence, reason] of detail.decoy || []) add(evidence, "decoy", reason);
  }
  if (bySelector.size === 0) return "";
  const sections = [];
  for (const { evidence, lanes, reasons } of bySelector.values()) {
    const provenance = evidence.provenance || {};
    const sourceWindows = provenance.line_semantics === "source"
      && Array.isArray(provenance.source_windows)
      ? provenance.source_windows
      : [];
    const sourceCoordinates = evidence.path
      ? `${evidence.path}:${evidence.source_start_line}-${evidence.source_end_line}`
      : sourceWindows.length > 0
        ? sourceWindows.map((window) => (
            `${window.path}:${window.source_start_line}-${window.source_end_line}`
          )).join(", ")
        : null;
    const sourcePaths = new Set(sourceWindows.map((window) => window.path));
    const sourceOwner = provenance.source || provenance.kind || "materialized evidence";
    const source = sourceCoordinates
      ? `${sourceCoordinates} (${sourceOwner})`
      : [provenance.source, provenance.object_type].filter(Boolean).join(" · ")
        || provenance.kind
        || "materialized evidence";
    const quoted = String(evidence.excerpt)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line, index) => {
        if (evidence.path) return `> ${evidence.source_start_line + index}\t${line}`;
        const materializedLine = index + 1;
        const window = sourceWindows.find((candidate) => (
          materializedLine >= candidate.materialized_start_line
          && materializedLine <= candidate.materialized_end_line
        ));
        if (!window) return `> ${line}`;
        const sourceLine = window.source_start_line
          + materializedLine - window.materialized_start_line;
        const gutter = sourcePaths.size > 1 ? `${window.path}:${sourceLine}` : sourceLine;
        return `> ${gutter}\t${line}`;
      })
      .join("\n");
    sections.push([
      `### ${evidence.selector}`,
      `Lanes: ${[...lanes].join(", ")}  `,
      `Source: ${source}`,
      ...(reasons.size > 0 ? [`Excluded because: ${[...reasons].join("; ")}`] : []),
      quoted,
    ].join("\n\n"));
  }
  const expanded = sections.join("\n\n");
  if (expanded.length <= maxChars) return `## Expanded evidence\n\n${expanded}`;
  const omitted = expanded.length - maxChars;
  return `## Expanded evidence\n\n${expanded.slice(0, maxChars).trimEnd()}\n\n[Expanded evidence truncated: ${omitted} additional characters remain available through the cited evidence selectors.]`;
}

function renderEvidenceAppendix(report) {
  const rows = [];
  for (const [index, claim] of (report.claims || []).entries()) {
    const detail = claim[1] || {};
    const marker = `[E${index + 1}]`;
    const rawClaimLabel = String(claim[0] || "").replace(/\s+/g, " ").trim();
    const claimLabel = rawClaimLabel === marker
      ? ""
      : rawClaimLabel.startsWith(`${marker} `)
        ? rawClaimLabel.slice(marker.length + 1)
        : rawClaimLabel;
    const claimPrefix = claimLabel ? `${claimLabel} — ` : "";
    const selectors = [...new Set(
      ["evidence", "proof", "support"].flatMap((lane) => (
        (detail[lane] || []).map(renderedEvidenceSelector)
      )).filter(Boolean),
    )];
    const lanes = selectors.length > 0 ? [`Evidence: ${selectors.join(", ")}`] : [];
    for (const [evidence, reason] of detail.decoy || []) {
      lanes.push(`Decoy: ${renderedEvidenceSelector(evidence)} — ${reason}`);
    }
    if (lanes.length > 0) rows.push(`- ${marker} ${claimPrefix}${lanes.join("; ")}`);
  }
  return rows.length > 0 ? `Evidence:\n${rows.join("\n")}` : "";
}

function renderReport(report, { expandEvidence = false, evidenceAppendix = false } = {}) {
  const parts = [];
  if (report.summary) parts.push(`Summary: ${report.summary}`);
  if (!evidenceAppendix) {
    for (const claim of report.claims) {
      parts.push(`Claim: ${claim[0]}`);
      const detail = claim[1] || {};
      for (const evidence of ["evidence", "proof", "support"]
        .flatMap((lane) => detail[lane] || [])) {
        parts.push(`Evidence: ${renderedEvidenceSelector(evidence)}`);
      }
      for (const [evidence, reason] of detail.decoy || []) {
        parts.push(`Decoy: ${renderedEvidenceSelector(evidence)} — ${reason}`);
      }
      if (detail.prose) parts.push(`Agent synthesis: ${detail.prose}`);
    }
  }
  if (report.constraints.length) parts.push(`Constraints:\n${report.constraints.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.success_criteria.length) parts.push(`Success criteria:\n${report.success_criteria.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.questions.length) parts.push(`Questions:\n${report.questions.map((entry) => `- ${entry}`).join("\n")}`);
  if (expandEvidence) {
    const evidence = renderExpandedEvidence(report);
    if (evidence) parts.push(evidence);
  }
  if (evidenceAppendix) {
    const appendix = renderEvidenceAppendix(report);
    if (appendix) parts.push(appendix);
  }
  return parts.join("\n\n");
}

function evidenceRefs(report) {
  const lanes = { proof: [], support: [], decoy: [] };
  const selector = (item) => ({
    ref: item.ref,
    ...(item.lines && item.selector !== item.ref ? {
      lines: {
        start: item.lines.start,
        count: item.lines.end - item.lines.start + 1,
      },
    } : {}),
  });
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const item of ["evidence", "proof", "support"].flatMap((lane) => detail[lane] || [])) {
      const lane = item?.selector_kind === "path" || item?.path
        ? "support"
        : (isCompatibilityProofProvenance(item) ? "proof" : "support");
      lanes[lane].push(selector(item));
    }
    for (const [item, reason] of detail.decoy || []) lanes.decoy.push({
      ...selector(item),
      why: reason,
    });
  }
  return lanes;
}

function plannerTaskSpec(handoff) {
  const report = handoff.report || {};
  const sections = [];
  const summary = String(report.summary || handoff.intent || "").trim();
  if (summary) sections.push(summary);
  const claims = [...new Set(
    (report.claims || [])
      .map((claim) => String(claim?.[0] || "").trim())
      .filter(Boolean),
  )];
  if (claims.length > 0) {
    sections.push(`Material context:\n${claims.map((claim) => `- ${claim}`).join("\n")}`);
  }
  const constraints = [...new Set(
    (report.constraints || []).map((constraint) => String(constraint || "").trim()).filter(Boolean),
  )];
  if (constraints.length > 0) {
    sections.push(`Constraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`);
  }
  return sections.join("\n\n") || String(handoff.intent || "").trim();
}

function packetEvidence(packet) {
  const bySelector = new Map();
  const add = (evidence) => {
    if (!evidence?.selector || bySelector.has(evidence.selector)) return;
    bySelector.set(evidence.selector, evidence);
  };
  for (const handoff of packet.handoffs || []) {
    for (const claim of handoff.report?.claims || []) {
      const detail = claim[1] || {};
      for (const lane of ["evidence", "proof", "support"]) {
        for (const evidence of detail[lane] || []) add(evidence);
      }
      for (const [evidence] of detail.decoy || []) add(evidence);
    }
  }
  return [...bySelector.values()];
}

function packetEvidenceMetrics(packet) {
  const evidence = packetEvidence(packet);
  const selectedLineCount = (item) => {
    const windows = item?.selector === item?.ref
      && Array.isArray(item?.provenance?.source_windows)
      ? item.provenance.source_windows
      : [];
    if (windows.length > 0) {
      const materializedLines = new Set();
      for (const window of windows) {
        for (let line = Number(window.materialized_start_line);
          line <= Number(window.materialized_end_line);
          line += 1) {
          if (Number.isInteger(line) && line > 0) materializedLines.add(line);
        }
      }
      if (materializedLines.size > 0) return materializedLines.size;
    }
    return Number(item?.lines?.end) - Number(item?.lines?.start) + 1;
  };
  const lineCounts = evidence.map(selectedLineCount)
    .filter((count) => Number.isInteger(count) && count > 0);
  const charCounts = evidence.map((item) => String(item?.excerpt || "").length);
  return {
    selectorCount: evidence.length,
    selectorLinesMax: lineCounts.length > 0 ? Math.max(...lineCounts) : 0,
    selectorCharsMax: charCounts.length > 0 ? Math.max(...charCounts) : 0,
    selectorsOverRecommendedCount: evidence.filter((item) => {
      const lines = selectedLineCount(item);
      const chars = String(item?.excerpt || "").length;
      return lines > AGENT_HANDOFF_LIMITS.recommendedSelectorLines
        || chars > AGENT_HANDOFF_LIMITS.recommendedSelectorChars;
    }).length,
  };
}

function verifyPacketEvidenceAtCommit(packet) {
  const context = {
    workItemId: positiveInt(packet.work_item_id),
    jobId: positiveInt(packet.job_id),
    attemptId: positiveInt(packet.attempt_id),
    agentCallId: positiveInt(packet.agent_call_id),
  };
  for (const evidence of packetEvidence(packet)) {
    const expectedLineSemantics = evidence.provenance?.line_semantics
      ?? evidence.line_semantics;
    const stagedSourcePath = evidence.path ?? evidence.provenance?.path;
    const stagedSourceWindow = Array.isArray(evidence.provenance?.source_windows)
      ? evidence.provenance.source_windows[0] || null
      : null;
    const verified = materializeAgentHandoffEvidenceSelector(
      evidence.selector,
      context,
      {
        expectedLineSemantics,
        stagedSourcePath,
        stagedSourceWindow,
      },
    );
    if (verified.source_content_sha256 !== evidence.source_content_sha256
      || verified.excerpt_sha256 !== evidence.excerpt_sha256
      || verified.excerpt !== evidence.excerpt
      || verified.provenance?.line_semantics !== expectedLineSemantics) {
      fail("AGENT_HANDOFF_EVIDENCE_CHANGED", `Evidence ${evidence.selector} changed after the report was staged`);
    }
  }
}

function boundedWords(value, maxWords = 30) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function renderCompletionCompatibilityOutput(packet) {
  const completion = packet.completion || {};
  const status = String(completion.status || "COMPLETE").toUpperCase();
  const artificer = packet.profile === "artificer.result.v1";
  const label = artificer ? "ARTIFICER RESULT" : "DEV RESULT";
  const summary = status === "VERIFIED_NO_CHANGE"
    ? "The requested end state already exists."
    : status === "PARTIAL"
      ? "Available assigned work was completed."
      : status === "BLOCKED"
        ? "Assigned work could not be completed."
        : artificer
          ? "All assigned deliverables were produced."
          : "All assigned work was completed.";
  let notes = "none";
  if (completion.verification_unavailable) {
    notes = `VERIFICATION_UNAVAILABLE: ${completion.verification_unavailable}`;
  } else if (completion.evidence_gap) {
    notes = `EVIDENCE_GAP: ${completion.evidence_gap}`;
  } else if (status === "VERIFIED_NO_CHANGE") {
    notes = completion.no_change_rationale;
  } else if (status === "PARTIAL") {
    notes = `Remaining: ${(completion.remaining_work || []).join("; ")}`;
  } else if (status === "BLOCKED") {
    notes = completion.blocker;
  }
  const result = `--- ${label} START ---\nstatus: ${status}\nsummary: ${summary}\nnotes: ${boundedWords(notes)}\n--- ${label} END ---`;
  const fileRequests = Array.isArray(completion.file_requests) ? completion.file_requests : [];
  if (fileRequests.length === 0) return result;
  const requestBlock = [
    "FILE_REQUEST:",
    ...fileRequests.map((request) => `- ${request.path} — ${request.reason}`),
    "FILE_REQUEST_END",
  ].join("\n");
  return `${requestBlock}\n${result}`;
}

function plannerCompatibilityTasks(packet) {
  const indexes = new Map(packet.handoffs.map((handoff, index) => [handoff.id, index]));
  return packet.handoffs.map((handoff) => {
    const taskSpec = plannerTaskSpec(handoff);
    const refs = evidenceRefs(handoff.report);
    const hasRefs = Object.values(refs).some((entries) => entries.length > 0);
    const metadata = Object.fromEntries(
      PLANNER_REPORT_METADATA_KEYS
        .filter((key) => handoff.report[key] != null)
        .map((key) => [key, handoff.report[key]]),
    );
    const task = {
        title: handoff.intent,
        task_spec: taskSpec,
        success_criteria: handoff.report.success_criteria.length ? handoff.report.success_criteria : [handoff.intent],
        depends_on_index: handoff.depends_on.map((id) => indexes.get(id)),
        task_mode: handoff.report.scope.task_mode || "code",
        files_to_modify: handoff.report.scope.files_to_modify || [],
        files_to_create: handoff.report.scope.files_to_create || [],
        files_to_delete: handoff.report.scope.files_to_delete || [],
        create_roots: handoff.report.scope.create_roots || [],
        ...(handoff.report.scope.output_root ? { output_root: handoff.report.scope.output_root } : {}),
        ...metadata,
        job_type: handoff.target.role === "artificer" ? "artificer" : handoff.target.role,
        dev_brief: {
          source: "hash_ref_store",
          ...(hasRefs ? {} : { summary: handoff.report.summary }),
          key_files: handoff.report.scope.files_to_modify || [],
          related_files: [],
          planner_file_priorities: (handoff.report.scope.files_to_modify || []).map((path, index) => ({ path, rank: index + 1 })),
          ...refs,
        },
    };
    if (handoff.target.kind === "system" && handoff.target.role === "promote") {
      task.mappings = plannerPromoteMappings(handoff);
    }
    return task;
  });
}

function validatePlannerCompatibilityTasks(packet) {
  if (packet.profile !== "planner.plan.v1" || packet.outcome !== "success") return;
  const tasks = plannerCompatibilityTasks(packet);
  for (const [index, task] of tasks.entries()) {
    const errors = validatePlannedTask(task, index, tasks.length);
    if (errors.length > 0) {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `planner success handoffs[${index}] is not downstream-valid: ${errors.join("; ")}`,
      );
    }
  }
}

export function renderAgentHandoffCompatibilityOutput(packet) {
  if (packet.completion && ["dev.result.v1", "artificer.result.v1"].includes(packet.profile)) {
    return renderCompletionCompatibilityOutput(packet);
  }
  if (packet.profile === "planner.plan.v1") {
    const tasks = plannerCompatibilityTasks(packet);
    return `\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }
  const first = packet.handoffs[0];
  const report = renderReport(first.report, {
    evidenceAppendix: packet.profile === "researcher.report.v1",
  });
  if (packet.profile === "assessor.verdict.v1") {
    const reasons = [...new Set(
      [first.report.summary, ...first.report.claims.map((claim) => claim[0])]
        .map((reason) => String(reason || "").trim())
        .filter(Boolean),
    )];
    const repair = String(first.report.payload?.repair || "").trim();
    const spawnJobs = packet.outcome === "fail" && repair
      ? [{
          job_type: "fix",
          title: "Fix assessed defect",
          payload: { instructions: repair },
        }]
      : [];
    return `\`\`\`json\n${JSON.stringify({
      verdict: packet.outcome,
      confidence: packet.confidence,
      reasons,
      spawn_jobs: spawnJobs,
      human_questions: first.report.questions,
      suggestions: [],
    }, null, 2)}\n\`\`\``;
  }
  if (packet.profile === "dev.result.v1") return `--- DEV RESULT START ---\n${report}\n--- DEV RESULT END ---`;
  if (packet.profile === "artificer.result.v1") return `--- ARTIFICER RESULT START ---\n${report}\n--- ARTIFICER RESULT END ---`;
  if (packet.profile === "researcher.pipeline.v1") {
    const refs = evidenceRefs(first.report);
    const research = first.report.research || {};
    const files = [...new Set([
      ...(first.report.scope.key_files || []),
      ...(first.report.scope.files_to_modify || []),
      ...(first.report.scope.files_to_create || []),
    ])];
    const relatedFiles = [...new Set(first.report.scope.related_files || [])];
    const plannerFilePriorities = Array.isArray(research.planner_file_priorities)
      ? research.planner_file_priorities
      : files.map((path, index) => ({ path, rank: index + 1, reason: "agent_handoff evidence" }));
    const patterns = Object.fromEntries(
      (research.patterns || []).map((entry) => [entry.name, entry.description]),
    );
    const questions = Array.isArray(research.question_details) && research.question_details.length > 0
      ? research.question_details
      : first.report.questions;
    return `\`\`\`json\n${JSON.stringify({
      synthesis: first.report.summary,
      claims: first.report.claims.map((claim) => claim[0]).filter(Boolean),
      key_files: files,
      related_files: relatedFiles,
      key_symbols: research.key_symbols || [],
      memories: research.memories || [],
      planner_file_priorities: plannerFilePriorities,
      proof: refs.proof,
      support: refs.support,
      decoy: refs.decoy,
      patterns,
      constraints: first.report.constraints,
      ...(research.scope_estimate ? { scope_estimate: research.scope_estimate } : {}),
      ...(Array.isArray(research.absence_checks) ? { absence_checks: research.absence_checks } : {}),
      ...(Array.isArray(research.verification_targets) ? { verification_targets: research.verification_targets } : {}),
      questions_for_human: packet.outcome === "input_required",
      questions,
    }, null, 2)}\n\`\`\``;
  }
  return report;
}

export function finalizeAgentHandoffForProvider({ agentCallId, output = "", required = false, db = getDb() } = {}) {
  const row = handoffRow(agentCallId, db);
  if (!required) {
    if (row?.status === "staged") {
      ensureSchema(db).prepare(`
        UPDATE ${TABLE}
        SET status='rejected', rejection_code='not_effectively_issued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE agent_call_id=? AND status='staged'
      `).run(Number(agentCallId));
    }
    return { output, packet: null, applied: false };
  }
  if (!row) {
    const rejection = latestAgentHandoffRejection(agentCallId, db);
    if (rejection) {
      const error = new Error(`agent_handoff was rejected (${rejection.code}: ${rejection.message})`);
      error.code = "TERMINAL_PROTOCOL_ERROR";
      error.handoffCode = rejection.code;
      if (rejection.issues.length > 0) error.issues = rejection.issues;
      if (rejection.failing_selectors.length > 0) {
        error.failing_selectors = rejection.failing_selectors;
      }
      throw error;
    }
    fail("TERMINAL_PROTOCOL_ERROR", "agent_handoff was required but no report was staged");
  }
  if (row.status === "rejected") fail("TERMINAL_PROTOCOL_ERROR", `agent_handoff was rejected (${row.rejection_code || "protocol violation"})`);
  const packet = parseStoredAgentHandoffPacket(row.materialized_packet_json);
  const digest = crypto.createHash("sha256").update(row.materialized_packet_json).digest("hex");
  if (digest !== row.packet_digest) fail("TERMINAL_PROTOCOL_ERROR", "agent_handoff digest verification failed");
  try {
    verifyPacketEvidenceAtCommit(packet);
  } catch (error) {
    ensureSchema(db).prepare(`
      UPDATE ${TABLE}
      SET status='rejected', rejection_code='evidence_recheck_failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agent_call_id=? AND status='staged'
    `).run(Number(agentCallId));
    fail("TERMINAL_PROTOCOL_ERROR", `agent_handoff evidence recheck failed: ${error?.message || String(error)}`);
  }
  const continuationChars = typeof output === "string" ? output.length : String(output ?? "").length;
  const isPlannerPacket = packet.profile === "planner.plan.v1";
  const plannerTaskSpecChars = isPlannerPacket
    ? plannerCompatibilityTasks(packet).map((task) => task.task_spec.length)
    : [];
  const evidenceMetrics = packetEvidenceMetrics(packet);
  if (row.status === "staged") {
    ensureSchema(db).prepare(`
      UPDATE ${TABLE}
      SET status='committed', continuation_prose_chars=?, committed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agent_call_id=? AND status='staged'
    `).run(continuationChars, Number(agentCallId));
  }
  return {
    output: renderAgentHandoffCompatibilityOutput(packet),
    packet,
    applied: true,
    digest,
    reportCalls: Number(row.stage_count || 1),
    continuationProseChars: continuationChars,
    evidenceChars: packet.evidence_chars,
    evidenceRecommendedChars: AGENT_HANDOFF_LIMITS.recommendedEvidenceChars,
    evidenceOverRecommended: packet.evidence_chars > AGENT_HANDOFF_LIMITS.recommendedEvidenceChars,
    evidenceSelectorCount: evidenceMetrics.selectorCount,
    evidenceSelectorLinesMax: evidenceMetrics.selectorLinesMax,
    evidenceSelectorCharsMax: evidenceMetrics.selectorCharsMax,
    evidenceSelectorsOverRecommendedCount: evidenceMetrics.selectorsOverRecommendedCount,
    evidenceSelectorRecommendedLines: AGENT_HANDOFF_LIMITS.recommendedSelectorLines,
    evidenceSelectorRecommendedChars: AGENT_HANDOFF_LIMITS.recommendedSelectorChars,
    materializedPacketChars: row.materialized_packet_json.length,
    plannerTaskSpecCount: isPlannerPacket ? plannerTaskSpecChars.length : null,
    plannerTaskSpecCharsMax: plannerTaskSpecChars.length > 0 ? Math.max(...plannerTaskSpecChars) : null,
    plannerTaskSpecCharsTotal: isPlannerPacket
      ? plannerTaskSpecChars.reduce((sum, chars) => sum + chars, 0)
      : null,
    plannerTaskSpecOverRecommendedCount: isPlannerPacket
      ? plannerTaskSpecChars.filter(
          (chars) => chars > AGENT_HANDOFF_LIMITS.recommendedPlannerTaskSpecChars,
        ).length
      : null,
    plannerTaskSpecRecommendedChars: isPlannerPacket
      ? AGENT_HANDOFF_LIMITS.recommendedPlannerTaskSpecChars
      : null,
  };
}
