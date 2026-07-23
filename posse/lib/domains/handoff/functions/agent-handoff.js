import crypto from "crypto";

import {
  AGENT_HANDOFF_PLANNER_CONTRACT_KEYS,
  AGENT_HANDOFF_PLANNER_CONTRACT_VERSION,
  AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES,
  AGENT_HANDOFF_WORK_ITEM_CONTRACT_ERROR,
} from "../../../catalog/handoff.js";
import { HASH_REF_ALIAS_PATTERN, normalizeHashRefAlias } from "../../../catalog/hash-store.js";
import { ARTIFICER_COMPLETION_STATUSES, DEV_COMPLETION_STATUSES } from "../../../catalog/native-tools.js";
import { fetchHashRefForContext } from "../../queue/functions/hash-refs.js";
import { createAgentHandoffPacketTable, getDb } from "../../../shared/storage/functions/index.js";
import { validatePlannedTask } from "../../planning/functions/plan-routing.js";
import { validateScopedPath } from "../../../shared/scope/functions/validation.js";
import {
  detectSensitiveAgentHandoffText,
  findCopiedAgentHandoffEvidence,
} from "./agent-handoff-boundaries.js";
import {
  normalizePlannerReportMetadata,
  normalizeResearchData,
  PLANNER_REPORT_METADATA_KEYS,
  structuredStringLength,
} from "./helpers/terminal-report-metadata.js";

export const AGENT_HANDOFF_PROTOCOL = "posse.agent_handoff.v1";
export const AGENT_HANDOFF_LIMITS = Object.freeze({
  maxCallBytes: 256 * 1024,
  maxEntryBytes: 32 * 1024,
  maxClaims: 12,
  maxSelectorsPerClaim: 8,
  recommendedIdChars: 40,
  maxIdChars: 80,
  recommendedSummaryChars: 2000,
  maxSummaryChars: 4000,
  recommendedSelectorLines: 40,
  maxSelectorLines: 300,
  recommendedSelectorChars: 4000,
  maxSelectorChars: 24000,
  recommendedEvidenceChars: 12000,
  maxEvidenceChars: 32000,
  maxCitationChildEvidenceChars: 4000,
  recommendedNarrativeChars: 4000,
  maxNarrativeChars: 12000,
  maxCitationChildNarrativeChars: 2000,
  maxStructuredMetadataChars: 12000,
});

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
  "role",
  "job_type",
  "intent",
  "summary",
  "claims",
  "scope",
  "constraints",
  "success_criteria",
  ...PLANNER_REPORT_METADATA_KEYS,
]);

const PROFILE_POLICY = Object.freeze({
  "researcher.pipeline.v1": Object.freeze({ roles: ["researcher"], outcomes: ["success", "gap", "input_required"], targetKinds: ["pipeline"], maxHandoffs: 1 }),
  "researcher.report.v1": Object.freeze({ roles: ["researcher"], outcomes: ["complete"], targetKinds: ["result"], maxHandoffs: 1 }),
  "planner.plan.v1": Object.freeze({ roles: ["planner"], outcomes: ["success", "complete"], targetKinds: ["agent", "system"], maxHandoffs: 50 }),
  "dev.result.v1": Object.freeze({ roles: ["dev", "fix"], outcomes: ["complete", "failed", "blocked"], targetKinds: ["pipeline"], maxHandoffs: 1 }),
  "artificer.result.v1": Object.freeze({ roles: ["artificer"], outcomes: ["complete", "failed", "blocked"], targetKinds: ["pipeline"], maxHandoffs: 1 }),
  "assessor.verdict.v1": Object.freeze({ roles: ["assessor"], outcomes: ["pass", "fail", "needs_replan", "needs_review", "blocked"], targetKinds: ["pipeline"], maxHandoffs: 1 }),
  "citation_synthesis.v1": Object.freeze({ roles: ["subagent"], outcomes: ["complete", "partial", "failed"], targetKinds: ["parent"], maxHandoffs: 1 }),
});

const TABLE = "agent_handoff_packets";
const READY_DBS = new WeakSet();

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
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

function compatibilityAlias(source, canonicalKey, aliasKey, label) {
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
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${key} is not allowed`);
  }
  return object;
}

function boundedString(value, label, max, { required = true, allowRef = false } = {}) {
  if (typeof value !== "string") fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be a string`);
  const text = value.trim();
  if (required && !text) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} is required`);
  if (text.length > max) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${max} characters`);
  if (!allowRef && /#[0-9a-z]{4,12}\b/i.test(text)) {
    fail("AGENT_HANDOFF_REF_OUTSIDE_SELECTOR", `${label} contains a hash ref outside an evidence selector`);
  }
  const sensitiveLabel = detectSensitiveAgentHandoffText(text);
  if (sensitiveLabel) {
    fail("AGENT_HANDOFF_SENSITIVE_CONTENT", `${label} contains sensitive content (${sensitiveLabel})`);
  }
  return text;
}

function stringArray(value, label, maxItems = 50, maxChars = 1000) {
  if (!Array.isArray(value)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an array`);
  if (value.length > maxItems) fail("AGENT_HANDOFF_TOO_LARGE", `${label} exceeds ${maxItems} items`);
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, maxChars));
}

export function parseAgentHandoffEvidenceSelector(value) {
  let ref;
  let start = null;
  let end = null;
  if (typeof value === "string") {
    const match = value.trim().toLowerCase().match(/^(#[0-9a-z]{4,12})(?::(?:l)?(\d+)(?:-(?:l)?(\d+))?)?$/);
    if (!match) fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid evidence selector: ${String(value).slice(0, 80)}`);
    [, ref] = match;
    if (match[2]) {
      start = Number(match[2]);
      end = Number(match[3] || match[2]);
    }
  } else {
    const selector = exactKeys(value, ["ref", "lines"], "evidence selector");
    ref = normalizeHashRefAlias(selector.ref);
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
          `Evidence line count for ${ref} must be an integer from 1 through ${AGENT_HANDOFF_LIMITS.maxSelectorLines}`,
        );
      }
    }
  }
  if (!HASH_REF_ALIAS_PATTERN.test(ref || "")) fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid evidence ref: ${String(ref || "")}`);
  if ((start == null) !== (end == null)) fail("AGENT_HANDOFF_SELECTOR_INVALID", `Evidence line range must include start and end for ${ref}`);
  if (start != null && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid 1-based inclusive line range for ${ref}`);
  }
  return { ref, start, end };
}

function normalizedLines(payload) {
  const text = String(payload ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
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

export function materializeAgentHandoffEvidenceSelector(selectorValue, context) {
  const selector = parseAgentHandoffEvidenceSelector(selectorValue);
  const fetched = fetchHashRefForContext(context, selector.ref);
  if (!fetched?.found || !fetched.entry) {
    fail("AGENT_HANDOFF_EVIDENCE_NOT_FOUND", `Evidence ${selector.ref} is not visible to the current agent call`);
  }
  const entry = fetched.entry;
  if (entry.entry_kind !== "materialized" || entry.payload_text == null) {
    fail("AGENT_HANDOFF_EVIDENCE_NOT_MATERIALIZED", `Evidence ${selector.ref} is not materialized`);
  }
  const lines = normalizedLines(entry.payload_text);
  const start = selector.start ?? 1;
  const end = selector.end ?? Math.max(1, lines.length);
  if (end > lines.length || start > lines.length) {
    fail("AGENT_HANDOFF_EVIDENCE_RANGE_INVALID", `Evidence ${selector.ref} has ${lines.length} lines; requested ${start}-${end}`);
  }
  const lineCount = end - start + 1;
  if (lineCount > AGENT_HANDOFF_LIMITS.maxSelectorLines) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Evidence ${selector.ref}:${start}-${end} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorLines} lines`);
  }
  const excerpt = lines.slice(start - 1, end).join("\n");
  if (!excerpt) {
    fail("AGENT_HANDOFF_EVIDENCE_EMPTY", `Evidence ${selector.ref}:${start}-${end} resolved to an empty excerpt`);
  }
  if (excerpt.length > AGENT_HANDOFF_LIMITS.maxSelectorChars) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Evidence ${selector.ref}:${start}-${end} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorChars} characters`);
  }
  const provenance = evidenceProvenance(entry, context);
  return {
    selector: `${selector.ref}:L${start}-L${end}`,
    ref: selector.ref,
    lines: { start, end },
    excerpt,
    excerpt_sha256: crypto.createHash("sha256").update(excerpt).digest("hex"),
    source_content_sha256: entry.content_hash,
    provenance,
  };
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
  const source = exactKeys(value, ["claim", "name", "proof", "support", "decoy", "prose", "summary"], label);
  const claim = compatibilityAlias(source, "claim", "name", label);
  const prose = compatibilityAlias(source, "prose", "summary", label);
  const detail = {};
  for (const lane of ["proof", "support", "decoy"]) {
    if (source[lane] != null) detail[lane] = source[lane];
  }
  if (prose != null) detail.prose = prose;
  return Object.keys(detail).length > 0 ? [claim, detail] : [claim];
}

function normalizeClaimDetail(value, label) {
  const source = exactKeys(value, ["proof", "support", "decoy", "prose", "summary"], label);
  const prose = compatibilityAlias(source, "prose", "summary", label);
  return {
    ...(source.proof == null ? {} : { proof: source.proof }),
    ...(source.support == null ? {} : { support: source.support }),
    ...(source.decoy == null ? {} : { decoy: source.decoy }),
    ...(prose == null ? {} : { prose }),
  };
}

function normalizeDecoyInput(value, label) {
  if (Array.isArray(value)) return value;
  const source = exactKeys(value, ["selector", "ref", "lines", "reason", "summary"], label);
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
  const reason = compatibilityAlias(source, "reason", "summary", label);
  return [selector, reason ?? "Excluded from supporting evidence."];
}

function isAllowedProofProvenance(evidence, { allowAgentProse = false } = {}) {
  const kind = evidence?.provenance?.kind;
  return ["Tool Result", "Full Tool Call"].includes(kind)
    || (allowAgentProse && kind === "Agent Prose");
}

function materializeClaim(
  value,
  claimIndex,
  context,
  counters,
  { allowAgentProseProof = false } = {},
) {
  const normalized = normalizeClaimInput(value, claimIndex);
  if (!Array.isArray(normalized) || normalized.length < 1 || normalized.length > 2) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `claims[${claimIndex}] must be [claim, optional evidence]`);
  }
  const claim = boundedString(normalized[0], `claims[${claimIndex}][0]`, 1000);
  counters.narrative += claim.length;
  if (normalized.length === 1) return [claim];
  const detail = normalizeClaimDetail(normalized[1], `claims[${claimIndex}][1]`);
  const out = {};
  let selectorCount = 0;
  for (const lane of ["proof", "support"]) {
    if (detail[lane] == null) continue;
    if (!Array.isArray(detail[lane])) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${lane} must be an array`);
    out[lane] = detail[lane].map((selector) => {
      selectorCount += 1;
      const evidence = materializeAgentHandoffEvidenceSelector(selector, context);
      if (lane === "proof" && !isAllowedProofProvenance(evidence, {
        allowAgentProse: allowAgentProseProof,
      })) {
        fail(
          "AGENT_HANDOFF_PROOF_PROVENANCE_INVALID",
          `claims[${claimIndex}] proof requires storage-owned tool evidence; ${evidence.ref} is ${evidence.provenance.kind}`,
        );
      }
      counters.evidence += evidence.excerpt.length;
      return evidence;
    });
  }
  if (detail.decoy != null) {
    if (!Array.isArray(detail.decoy)) fail("AGENT_HANDOFF_SCHEMA_INVALID", "decoy must be an array");
    out.decoy = detail.decoy.map((entry, index) => {
      const normalizedEntry = normalizeDecoyInput(entry, `decoy[${index}]`);
      if (normalizedEntry.length !== 2) fail("AGENT_HANDOFF_SCHEMA_INVALID", `decoy[${index}] must be [selector, reason]`);
      selectorCount += 1;
      const evidence = materializeAgentHandoffEvidenceSelector(normalizedEntry[0], context);
      const reason = boundedString(normalizedEntry[1], `decoy[${index}][1]`, 500);
      counters.evidence += evidence.excerpt.length;
      counters.narrative += reason.length;
      return [evidence, reason];
    });
  }
  if (selectorCount > AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim) {
    fail("AGENT_HANDOFF_TOO_LARGE", `claims[${claimIndex}] exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim} selectors`);
  }
  if (detail.prose != null) {
    out.prose = boundedString(
      detail.prose,
      `claims[${claimIndex}].prose`,
      AGENT_HANDOFF_LIMITS.maxSummaryChars,
      { required: false },
    );
    counters.narrative += out.prose.length;
  }
  return [claim, out];
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
    const allowed = kind === "agent" ? ["dev", "artificer"] : ["human_input", "promote", "no_tasks"];
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
  if (packet.outcome === "complete") {
    const [handoff] = packet.handoffs;
    if (packet.handoffs.length !== 1
      || handoff?.target?.kind !== "system"
      || handoff?.target?.role !== "no_tasks") {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        "planner complete requires exactly one system/no_tasks handoff",
      );
    }
    if ((handoff.depends_on || []).length > 0) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", "planner complete system/no_tasks cannot depend on another handoff");
    }
    if (!String(handoff.report?.summary || "").trim()) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", "planner complete system/no_tasks requires a summary reason");
    }
    if (Object.keys(handoff.report?.scope || {}).length > 0) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", "planner complete system/no_tasks requires empty scope");
    }
    if ((handoff.report?.success_criteria || []).length === 0) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", "planner complete system/no_tasks requires a completion criterion");
    }
    if ((handoff.report?.questions || []).length > 0) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", "planner complete system/no_tasks cannot contain unresolved questions");
    }
    const metadataKey = PLANNER_REPORT_METADATA_KEYS.find((key) => handoff.report?.[key] != null);
    if (metadataKey) {
      fail("AGENT_HANDOFF_SEMANTIC_INVALID", `planner complete system/no_tasks cannot contain ${metadataKey}`);
    }
    return;
  }
  if (packet.outcome !== "success") return;
  for (const [index, handoff] of packet.handoffs.entries()) {
    if (handoff.target?.kind === "system" && handoff.target?.role === "no_tasks") {
      fail(
        "AGENT_HANDOFF_SEMANTIC_INVALID",
        `planner success handoffs[${index}] cannot target system/no_tasks; use outcome complete`,
      );
    }
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
        `planner success handoffs[${index}] task_mode ${taskMode} requires non-empty writable scope`,
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
    for (const lane of ["proof", "support"]) {
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
  const plannerLimit = PROFILE_POLICY["planner.plan.v1"].maxHandoffs;
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
    const taskRoleInput = compatibilityAlias(task, "role", "job_type", label);
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
  const noTasks = handoffs.length === 1
    && handoffs[0].target.kind === "system"
    && handoffs[0].target.role === "no_tasks";
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: "planner.plan.v1",
    outcome: noTasks ? "complete" : "success",
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
    .replace(/#[0-9a-z]{4,12}(?::L?\d+(?:-L?\d+)?|:\d+(?:-\d+)?)?/gi, "stored evidence")
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
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile: "assessor.verdict.v1",
    outcome,
    confidence: source.confidence || first.confidence || report.confidence || "medium",
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
        payload: {},
      },
    }],
  };
}

function compactResearcherText(value, fallback = "") {
  return String(value || fallback)
    .replace(/#[0-9a-z]{4,12}(?::L?\d+(?:-L?\d+)?|:\d+(?:-\d+)?)?/gi, "stored evidence")
    .replace(/\s+/g, " ")
    .trim();
}

function researcherEvidenceSelector(value, context) {
  let candidate = value;
  if (Array.isArray(candidate)) candidate = candidate[0];
  const object = plainObject(candidate);
  if (object) candidate = object.selector ?? (
    object.ref == null
      ? null
      : { ref: object.ref, ...(object.lines == null ? {} : { lines: object.lines }) }
  );
  if (candidate == null) return null;
  try {
    const parsed = parseAgentHandoffEvidenceSelector(candidate);
    if (parsed.start != null) return candidate;
    const fetched = fetchHashRefForContext(context, parsed.ref);
    if (!fetched?.found || fetched.entry?.entry_kind !== "materialized"
      || fetched.entry?.payload_text == null) {
      return null;
    }
    const lineCount = normalizedLines(fetched.entry.payload_text).length;
    const end = Math.min(Math.max(1, lineCount), AGENT_HANDOFF_LIMITS.recommendedSelectorLines);
    return `${parsed.ref}:L1-L${end}`;
  } catch {
    return null;
  }
}

function researcherEvidenceSelectors(value, context) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => researcherEvidenceSelector(entry, context))
    .filter(Boolean)
    .slice(0, AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim);
}

function researcherClaims(value, { proof = [], support = [], context = {} } = {}) {
  const inputs = Array.isArray(value) ? value : [];
  const claims = inputs.slice(0, AGENT_HANDOFF_LIMITS.maxClaims).flatMap((raw, index) => {
    if (Array.isArray(raw)) return [raw];
    const source = plainObject(raw);
    if (!source) return [];
    const claim = firstAssessorText(source.claim, source.name, source.title)
      || `Research finding ${index + 1}`;
    const prose = firstAssessorText(
      source.prose,
      source.summary,
      source.description,
      source.reason,
    );
    const detail = {};
    const claimProof = researcherEvidenceSelectors(source.proof, context);
    const claimSupport = researcherEvidenceSelectors(source.support, context);
    if (claimProof.length) detail.proof = claimProof;
    if (claimSupport.length) detail.support = claimSupport;
    if (prose) detail.prose = compactResearcherText(prose);
    return [[compactResearcherText(claim), detail]];
  });
  const globalProof = researcherEvidenceSelectors(proof, context);
  const globalSupport = researcherEvidenceSelectors(support, context);
  if (globalProof.length || globalSupport.length) {
    const detail = {};
    if (globalProof.length) detail.proof = globalProof;
    if (globalSupport.length) detail.support = globalSupport;
    claims.push(["Research evidence", detail]);
  }
  return claims.slice(0, AGENT_HANDOFF_LIMITS.maxClaims);
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
  const report = plainObject(first.report) || plainObject(source.report) || {};
  const research = plainObject(report.research) || {};
  const reportScope = plainObject(report.scope) || {};
  const outcomeInput = firstAssessorText(
    source.outcome,
    source.status,
    first.outcome,
    report.outcome,
  ).toLowerCase();
  const profile = outcomeInput === "complete"
    ? "researcher.report.v1"
    : "researcher.pipeline.v1";
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
  ).filter((value) => /^[0-9a-f]{64}:[0-9]+$/.test(value)).slice(0, 12);
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
      key_symbols: researcherStringArray(entry.key_symbols, entry.keySymbols)
        .filter((value) => /^[0-9a-f]{64}:[0-9]+$/.test(value))
        .slice(0, 12),
    }];
  }).slice(0, 2);
  const claims = researcherClaims(
    first.claims ?? report.claims ?? research.claims ?? source.claims,
    {
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
        ).slice(0, AGENT_HANDOFF_LIMITS.maxSummaryChars),
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
          key_symbols: keySymbols,
          memories,
          planner_file_priorities: researcherFilePriorities(priorities, keyFiles),
          patterns,
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
          claims: compact.claims ?? [],
          scope: {
            key_files: keyFiles,
            related_files: compact.related_files ?? [],
          },
          constraints: [],
          success_criteria: [],
          questions: compact.questions ?? [],
          research: {
            key_symbols: compact.key_symbols ?? [],
            memories: compact.memories ?? [],
            planner_file_priorities: priorities,
            patterns: compact.patterns ?? [],
          },
          payload: {},
        },
      }],
    };
  }
  if (normalizedRole === "assessor" && !Array.isArray(source.handoffs)) {
    const compact = exactKeys(
      source,
      ["verdict", "outcome", "confidence", "proof", "questions"],
      "agent_handoff",
    );
    const outcome = compatibilityAlias(compact, "verdict", "outcome", "agent_handoff");
    if (outcome == null) {
      fail("AGENT_HANDOFF_SCHEMA_INVALID", "agent_handoff.verdict is required");
    }
    const proof = boundedString(compact.proof, "agent_handoff.proof", 500);
    const questions = compact.questions == null
      ? []
      : stringArray(compact.questions, "agent_handoff.questions", 3, 240);
    return {
      protocol: AGENT_HANDOFF_PROTOCOL,
      profile: "assessor.verdict.v1",
      outcome,
      confidence: compact.confidence || "medium",
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
          payload: {},
        },
      }],
    };
  }
  if (!Array.isArray(source.handoffs)) return args;
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
              `handoffs[${index}].report.${key} conflicts with flat compatibility field handoffs[${index}].${key}`,
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

function collectAgentHandoffValidationIssues(args, { context = {}, role = "", maxHandoffs = null } = {}) {
  const issues = [];
  const seen = new Set();
  const capture = (fn) => {
    try {
      return fn();
    } catch (error) {
      const code = String(error?.code || "AGENT_HANDOFF_SCHEMA_INVALID");
      const message = String(error?.message || "Invalid agent_handoff arguments");
      const key = `${code}\0${message}`;
      if (!seen.has(key) && issues.length < 24) {
        seen.add(key);
        issues.push({ code, message });
      }
      return null;
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
  const allowAgentProseProof = normalizedRole === "assessor"
    && profile === "assessor.verdict.v1";
  const policy = profile ? PROFILE_POLICY[profile] : null;
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
    capture(() => boundedString(entry.intent, `${label}.intent`, 1000));
    if (policy && profile) capture(() => validateTarget(entry.target, policy, profile, `${label}.target`));

    const report = capture(() => exactKeys(
      entry.report,
      PLANNER_REPORT_KEYS,
      `${label}.report`,
    ));
    if (!report) continue;
    capture(() => boundedString(
      report.summary,
      `${label}.report.summary`,
      AGENT_HANDOFF_LIMITS.maxSummaryChars,
      { required: false },
    ));
    capture(() => normalizeScope(report.scope || {}, `${label}.report.scope`, profile));
    if (report.research != null) capture(() => normalizeResearchData(report.research, `${label}.report.research`, profile));
    capture(() => normalizePlannerReportMetadata(report, `${label}.report`, profile));
    for (const key of ["constraints", "success_criteria", "questions"]) {
      if (report[key] != null) capture(() => stringArray(report[key], `${label}.report.${key}`));
    }
    if (report.payload != null) capture(() => exactKeys(report.payload, [], `${label}.report.payload`));

    if (!Array.isArray(report.claims)) {
      issues.push({ code: "AGENT_HANDOFF_SCHEMA_INVALID", message: `${label}.report.claims must be an array` });
      continue;
    }
    if (report.claims.length > AGENT_HANDOFF_LIMITS.maxClaims) {
      issues.push({
        code: "AGENT_HANDOFF_TOO_LARGE",
        message: `${label}.report.claims exceeds ${AGENT_HANDOFF_LIMITS.maxClaims} claims`,
      });
    }
    for (const [claimIndex, rawClaim] of report.claims.slice(0, AGENT_HANDOFF_LIMITS.maxClaims).entries()) {
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
      capture(() => boundedString(claim[0], `${claimLabel}.claim`, 1000));
      if (claim.length === 1) continue;
      const detail = capture(() => normalizeClaimDetail(claim[1], `${claimLabel}.evidence`));
      if (!detail) continue;
      if (detail.prose != null) capture(() => boundedString(
        detail.prose,
        `${claimLabel}.prose`,
        AGENT_HANDOFF_LIMITS.maxSummaryChars,
        { required: false },
      ));
      let selectorCount = 0;
      for (const lane of ["proof", "support"]) {
        if (detail[lane] == null) continue;
        if (!Array.isArray(detail[lane])) {
          issues.push({ code: "AGENT_HANDOFF_SCHEMA_INVALID", message: `${claimLabel}.${lane} must be an array` });
          continue;
        }
        for (const selector of detail[lane]) {
          selectorCount += 1;
          const evidence = capture(() => materializeAgentHandoffEvidenceSelector(selector, context));
          if (lane === "proof" && evidence && !isAllowedProofProvenance(evidence, {
            allowAgentProse: allowAgentProseProof,
          })) {
            issues.push({
              code: "AGENT_HANDOFF_PROOF_PROVENANCE_INVALID",
              message: `${claimLabel}.proof requires storage-owned tool evidence; ${evidence.ref} is ${evidence.provenance.kind}`,
            });
          }
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
            selectorCount += 1;
            capture(() => materializeAgentHandoffEvidenceSelector(decoy[0], context));
            capture(() => boundedString(decoy[1], `${claimLabel}.decoy[${decoyIndex}].reason`, 500));
          }
        }
      }
      if (selectorCount > AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim) {
        issues.push({
          code: "AGENT_HANDOFF_TOO_LARGE",
          message: `${claimLabel} exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim} selectors`,
        });
      }
    }
  }
  return issues;
}

function failCollectedAgentHandoffIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return;
  if (issues.length === 1) fail(issues[0].code, issues[0].message);
  const error = new Error(
    `agent_handoff rejected with ${issues.length} issues: ${issues.map((issue, index) => `${index + 1}. ${issue.message}`).join(" | ")}`,
  );
  error.code = "AGENT_HANDOFF_VALIDATION_FAILED";
  error.issues = issues;
  throw error;
}

export function materializeAgentHandoff(args, { context = {}, role = "", maxHandoffs = null } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
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
    context,
    role: normalizedRole,
    maxHandoffs,
  }));
  const source = exactKeys(normalizedArgs, ["protocol", "profile", "outcome", "confidence", "handoffs"], "agent_handoff");
  if (source.protocol !== AGENT_HANDOFF_PROTOCOL) fail("AGENT_HANDOFF_PROTOCOL_INVALID", `protocol must be ${AGENT_HANDOFF_PROTOCOL}`);
  const profile = boundedString(source.profile, "profile", 80);
  const policy = PROFILE_POLICY[profile];
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
  const counters = { evidence: 0, narrative: 0 };
  const handoffs = source.handoffs.map((raw, index) => {
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > AGENT_HANDOFF_LIMITS.maxEntryBytes) {
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
    const intent = boundedString(entry.intent, `handoffs[${index}].intent`, 1000);
    entryCounters.narrative += intent.length;
    const reportLabel = `handoffs[${index}].report`;
    const report = exactKeys(entry.report, PLANNER_REPORT_KEYS, reportLabel);
    const summary = boundedString(
      report.summary,
      `handoffs[${index}].report.summary`,
      AGENT_HANDOFF_LIMITS.maxSummaryChars,
      { required: false },
    );
    entryCounters.narrative += summary.length;
    if (!Array.isArray(report.claims) || report.claims.length > AGENT_HANDOFF_LIMITS.maxClaims) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}].report.claims exceeds ${AGENT_HANDOFF_LIMITS.maxClaims} claims`);
    }
    const claims = report.claims.map((claim, claimIndex) => materializeClaim(
      claim,
      claimIndex,
      context,
      entryCounters,
      {
        allowAgentProseProof: normalizedRole === "assessor"
          && profile === "assessor.verdict.v1",
      },
    ));
    const constraints = report.constraints == null ? [] : stringArray(report.constraints, `handoffs[${index}].report.constraints`);
    const successCriteria = report.success_criteria == null ? [] : stringArray(report.success_criteria, `handoffs[${index}].report.success_criteria`);
    const questions = report.questions == null ? [] : stringArray(report.questions, `handoffs[${index}].report.questions`);
    const research = normalizeResearchData(report.research, `${reportLabel}.research`, profile);
    const plannerMetadata = normalizePlannerReportMetadata(report, reportLabel, profile);
    entryCounters.narrative += [...constraints, ...successCriteria, ...questions].reduce((sum, text) => sum + text.length, 0);
    const structuredMetadataLength = structuredStringLength(research) + structuredStringLength(plannerMetadata);
    if (structuredMetadataLength > AGENT_HANDOFF_LIMITS.maxStructuredMetadataChars) {
      fail(
        "AGENT_HANDOFF_TOO_LARGE",
        `handoffs[${index}] exceeds the ${AGENT_HANDOFF_LIMITS.maxStructuredMetadataChars}-character structured metadata limit`,
      );
    }
    const narrativeLimit = normalizedRole === "subagent"
      ? AGENT_HANDOFF_LIMITS.maxCitationChildNarrativeChars
      : AGENT_HANDOFF_LIMITS.maxNarrativeChars;
    if (entryCounters.narrative > narrativeLimit) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}] exceeds the ${narrativeLimit}-character narrative limit for role ${normalizedRole || "unknown"}`);
    }
    counters.narrative += entryCounters.narrative;
    counters.evidence += entryCounters.evidence;
    if (report.payload != null) exactKeys(report.payload, [], `handoffs[${index}].report.payload`);
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
        payload: {},
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
  const evidenceLimit = normalizedRole === "subagent"
    ? AGENT_HANDOFF_LIMITS.maxCitationChildEvidenceChars
    : AGENT_HANDOFF_LIMITS.maxEvidenceChars;
  if (counters.evidence > evidenceLimit) {
    fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Materialized evidence exceeds ${evidenceLimit} characters for role ${normalizedRole || "unknown"}`);
  }
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile,
    outcome,
    ...(confidence == null ? {} : { confidence }),
    role: normalizedRole,
    handoffs,
    evidence_chars: counters.evidence,
    narrative_chars: counters.narrative,
    authoritative: true,
  };
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

function handoffRow(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return null;
  return ensureSchema(db).prepare(`SELECT * FROM ${TABLE} WHERE agent_call_id = ?`).get(id) || null;
}

export function getAgentHandoffRecord(agentCallId, { db = getDb() } = {}) {
  const row = handoffRow(agentCallId, db);
  if (!row) return null;
  return { ...row, packet: JSON.parse(row.materialized_packet_json) };
}

export function stageAgentHandoff(args, { context = {}, role = "", maxHandoffs = null, db = getDb() } = {}) {
  const agentCallId = positiveInt(context.agentCallId ?? context.agent_call_id);
  if (!agentCallId) fail("AGENT_HANDOFF_CONTEXT_INVALID", "agent_handoff requires an active agent call");
  const database = ensureSchema(db);
  const call = database.prepare(`
    SELECT work_item_id, job_id, attempt_id, role
    FROM agent_calls
    WHERE id = ?
  `).get(agentCallId);
  if (!call) fail("AGENT_HANDOFF_CONTEXT_INVALID", "agent_handoff agent call does not exist");
  const resolvedContext = {
    workItemId: positiveInt(call.work_item_id),
    jobId: positiveInt(call.job_id),
    attemptId: positiveInt(call.attempt_id),
    agentCallId,
  };
  const effectiveRole = String(call.role || role || "");
  const packet = materializeAgentHandoff(args, { context: resolvedContext, role: effectiveRole, maxHandoffs });
  const workItem = resolvedContext.workItemId
    ? database.prepare("SELECT metadata_json FROM work_items WHERE id = ?").get(resolvedContext.workItemId)
    : null;
  validatePlannerPacketAgainstWorkItem(packet, workItem);
  packet.agent_call_id = agentCallId;
  packet.work_item_id = resolvedContext.workItemId;
  packet.job_id = resolvedContext.jobId;
  packet.attempt_id = resolvedContext.attemptId;
  const materializedJson = JSON.stringify(packet);
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
  return { ok: true, status: "staged", digest, idempotent: false, callCount: 1 };
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

function renderEvidence(evidence, lane) {
  return `${lane}: ${evidence.selector}`;
}

function renderReport(report) {
  const parts = [];
  if (report.summary) parts.push(`Summary: ${report.summary}`);
  for (const claim of report.claims) {
    parts.push(`Claim: ${claim[0]}`);
    const detail = claim[1] || {};
    for (const lane of ["proof", "support"]) {
      for (const evidence of detail[lane] || []) parts.push(renderEvidence(evidence, lane[0].toUpperCase() + lane.slice(1)));
    }
    for (const [evidence, reason] of detail.decoy || []) parts.push(`${renderEvidence(evidence, "Decoy")} — ${reason}`);
    if (detail.prose) parts.push(`Agent synthesis: ${detail.prose}`);
  }
  if (report.constraints.length) parts.push(`Constraints:\n${report.constraints.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.success_criteria.length) parts.push(`Success criteria:\n${report.success_criteria.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.questions.length) parts.push(`Questions:\n${report.questions.map((entry) => `- ${entry}`).join("\n")}`);
  return parts.join("\n\n");
}

function evidenceRefs(report) {
  const lanes = { proof: [], support: [], decoy: [] };
  const selector = (item) => ({
    ref: item.ref,
    ...(item.lines ? {
      lines: {
        start: item.lines.start,
        count: item.lines.end - item.lines.start + 1,
      },
    } : {}),
  });
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const lane of ["proof", "support"]) {
      for (const item of detail[lane] || []) lanes[lane].push(selector(item));
    }
    for (const [item, reason] of detail.decoy || []) lanes.decoy.push({
      ...selector(item),
      why: reason,
    });
  }
  return lanes;
}

const PLANNER_TASK_SPEC_MAX_CHARS = 2000;

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
  const taskSpec = sections.join("\n\n") || String(handoff.intent || "").trim();
  if (taskSpec.length > PLANNER_TASK_SPEC_MAX_CHARS) {
    fail(
      "AGENT_HANDOFF_TOO_LARGE",
      `planner task_spec exceeds ${PLANNER_TASK_SPEC_MAX_CHARS} characters; shorten summary, claims, or constraints`,
    );
  }
  return taskSpec;
}

function packetEvidence(packet) {
  const out = [];
  for (const handoff of packet.handoffs || []) {
    for (const claim of handoff.report?.claims || []) {
      const detail = claim[1] || {};
      for (const lane of ["proof", "support"]) out.push(...(detail[lane] || []));
      for (const [evidence] of detail.decoy || []) out.push(evidence);
    }
  }
  return out;
}

function verifyPacketEvidenceAtCommit(packet) {
  const context = {
    workItemId: positiveInt(packet.work_item_id),
    jobId: positiveInt(packet.job_id),
    attemptId: positiveInt(packet.attempt_id),
    agentCallId: positiveInt(packet.agent_call_id),
  };
  for (const evidence of packetEvidence(packet)) {
    const verified = materializeAgentHandoffEvidenceSelector({ ref: evidence.ref, lines: evidence.lines }, context);
    if (verified.source_content_sha256 !== evidence.source_content_sha256
      || verified.excerpt_sha256 !== evidence.excerpt_sha256
      || verified.excerpt !== evidence.excerpt) {
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
    if (packet.outcome === "complete") {
      const completion = packet.handoffs[0];
      return `NO_TASKS_NEEDED: ${completion.report.summary || completion.intent}`;
    }
    const tasks = plannerCompatibilityTasks(packet);
    return `\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }
  const first = packet.handoffs[0];
  const report = renderReport(first.report);
  if (packet.profile === "assessor.verdict.v1") {
    const reasons = [...new Set(
      [first.report.summary, ...first.report.claims.map((claim) => claim[0])]
        .map((reason) => String(reason || "").trim())
        .filter(Boolean),
    )];
    return `\`\`\`json\n${JSON.stringify({
      verdict: packet.outcome,
      confidence: packet.confidence || "medium",
      reasons,
      spawn_jobs: [],
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
    fail("TERMINAL_PROTOCOL_ERROR", "agent_handoff was required but no report was staged");
  }
  if (row.status === "rejected") fail("TERMINAL_PROTOCOL_ERROR", `agent_handoff was rejected (${row.rejection_code || "protocol violation"})`);
  const packet = JSON.parse(row.materialized_packet_json);
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
    materializedPacketChars: row.materialized_packet_json.length,
  };
}
