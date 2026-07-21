import crypto from "crypto";

import { HASH_REF_ALIAS_PATTERN, normalizeHashRefAlias } from "../../../catalog/hash-store.js";
import { ARTIFICER_COMPLETION_STATUSES, DEV_COMPLETION_STATUSES } from "../../../catalog/native-tools.js";
import { fetchHashRefForContext } from "../../queue/functions/hash-refs.js";
import { createAgentHandoffPacketTable, getDb } from "../../../shared/storage/functions/index.js";

export const AGENT_HANDOFF_PROTOCOL = "posse.agent_handoff.v1";
export const AGENT_HANDOFF_LIMITS = Object.freeze({
  maxCallBytes: 256 * 1024,
  maxEntryBytes: 16 * 1024,
  maxClaims: 12,
  maxSelectorsPerClaim: 8,
  maxSelectorLines: 40,
  maxSelectorChars: 4000,
  maxEvidenceChars: 12000,
  maxNarrativeChars: 4000,
});

const PROFILE_POLICY = Object.freeze({
  "researcher.pipeline.v1": Object.freeze({ roles: ["researcher"], outcomes: ["success", "gap", "input_required"], targetKinds: ["pipeline"], maxHandoffs: 1 }),
  "researcher.report.v1": Object.freeze({ roles: ["researcher"], outcomes: ["complete"], targetKinds: ["result"], maxHandoffs: 1 }),
  "planner.plan.v1": Object.freeze({ roles: ["planner"], outcomes: ["success"], targetKinds: ["agent", "system"], maxHandoffs: 50 }),
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

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
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
      const lines = exactKeys(selector.lines, ["start", "end"], "evidence selector.lines");
      start = Number(lines.start);
      end = Number(lines.end);
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

function provenanceKind(entry) {
  const label = `${entry?.object_type || ""} ${entry?.source || ""}`.toLowerCase();
  return /agent|assistant|prose/.test(label) ? "Agent Prose" : "FullToolCall";
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
  return {
    selector: `${selector.ref}:L${start}-L${end}`,
    ref: selector.ref,
    lines: { start, end },
    excerpt,
    excerpt_sha256: crypto.createHash("sha256").update(excerpt).digest("hex"),
    source_content_sha256: entry.content_hash,
    provenance: {
      kind: provenanceKind(entry),
      source: entry.source || null,
      object_type: entry.object_type || "text",
    },
  };
}

function normalizeScope(value, label) {
  const source = exactKeys(value || {}, ["files_to_modify", "files_to_create", "files_to_delete", "create_roots"], label);
  const out = {};
  for (const key of ["files_to_modify", "files_to_create", "files_to_delete", "create_roots"]) {
    if (source[key] != null) out[key] = stringArray(source[key], `${label}.${key}`, 100, 500);
  }
  return out;
}

function materializeClaim(value, claimIndex, context, counters) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    fail("AGENT_HANDOFF_SCHEMA_INVALID", `claims[${claimIndex}] must be [claim, optional evidence]`);
  }
  const claim = boundedString(value[0], `claims[${claimIndex}][0]`, 1000);
  counters.narrative += claim.length;
  if (value.length === 1) return [claim];
  const detail = exactKeys(value[1], ["proof", "support", "decoy", "prose"], `claims[${claimIndex}][1]`);
  const out = {};
  let selectorCount = 0;
  for (const lane of ["proof", "support"]) {
    if (detail[lane] == null) continue;
    if (!Array.isArray(detail[lane])) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${lane} must be an array`);
    out[lane] = detail[lane].map((selector) => {
      selectorCount += 1;
      const evidence = materializeAgentHandoffEvidenceSelector(selector, context);
      counters.evidence += evidence.excerpt.length;
      return evidence;
    });
  }
  if (detail.decoy != null) {
    if (!Array.isArray(detail.decoy)) fail("AGENT_HANDOFF_SCHEMA_INVALID", "decoy must be an array");
    out.decoy = detail.decoy.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail("AGENT_HANDOFF_SCHEMA_INVALID", `decoy[${index}] must be [selector, reason]`);
      selectorCount += 1;
      const evidence = materializeAgentHandoffEvidenceSelector(entry[0], context);
      const reason = boundedString(entry[1], `decoy[${index}][1]`, 500);
      counters.evidence += evidence.excerpt.length;
      counters.narrative += reason.length;
      return [evidence, reason];
    });
  }
  if (selectorCount > AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim) {
    fail("AGENT_HANDOFF_TOO_LARGE", `claims[${claimIndex}] exceeds ${AGENT_HANDOFF_LIMITS.maxSelectorsPerClaim} selectors`);
  }
  if (detail.prose != null) {
    out.prose = boundedString(detail.prose, `claims[${claimIndex}].prose`, 2000, { required: false });
    counters.narrative += out.prose.length;
  }
  return [claim, out];
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
    authoritative: true,
  };
}

export function materializeAgentHandoff(args, { context = {}, role = "", maxHandoffs = null } = {}) {
  const serialized = JSON.stringify(args ?? null);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_HANDOFF_LIMITS.maxCallBytes) {
    fail("AGENT_HANDOFF_TOO_LARGE", `agent_handoff exceeds ${AGENT_HANDOFF_LIMITS.maxCallBytes} bytes`);
  }
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (looksLikeTerminalCompletion(args || {})) {
    return materializeTerminalCompletion(args || {}, normalizedRole);
  }
  const source = exactKeys(args, ["protocol", "profile", "outcome", "handoffs"], "agent_handoff");
  if (source.protocol !== AGENT_HANDOFF_PROTOCOL) fail("AGENT_HANDOFF_PROTOCOL_INVALID", `protocol must be ${AGENT_HANDOFF_PROTOCOL}`);
  const profile = boundedString(source.profile, "profile", 80);
  const policy = PROFILE_POLICY[profile];
  if (!policy) fail("AGENT_HANDOFF_PROFILE_INVALID", `Unsupported profile: ${profile}`);
  if (!policy.roles.includes(normalizedRole)) fail("AGENT_HANDOFF_PROFILE_INVALID", `Role ${normalizedRole || "unknown"} cannot use ${profile}`);
  const outcome = boundedString(source.outcome, "outcome", 40);
  if (!policy.outcomes.includes(outcome)) fail("AGENT_HANDOFF_OUTCOME_INVALID", `${profile} does not allow outcome ${outcome}`);
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
    const id = boundedString(entry.id, `handoffs[${index}].id`, 40);
    const dependsOn = stringArray(entry.depends_on, `handoffs[${index}].depends_on`, effectiveLimit, 40);
    const intent = boundedString(entry.intent, `handoffs[${index}].intent`, 1000);
    entryCounters.narrative += intent.length;
    const report = exactKeys(entry.report, ["summary", "claims", "scope", "constraints", "success_criteria", "questions", "payload"], `handoffs[${index}].report`);
    const summary = boundedString(report.summary, `handoffs[${index}].report.summary`, 2000, { required: false });
    entryCounters.narrative += summary.length;
    if (!Array.isArray(report.claims) || report.claims.length > AGENT_HANDOFF_LIMITS.maxClaims) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}].report.claims exceeds ${AGENT_HANDOFF_LIMITS.maxClaims} claims`);
    }
    const claims = report.claims.map((claim, claimIndex) => materializeClaim(claim, claimIndex, context, entryCounters));
    const constraints = report.constraints == null ? [] : stringArray(report.constraints, `handoffs[${index}].report.constraints`);
    const successCriteria = report.success_criteria == null ? [] : stringArray(report.success_criteria, `handoffs[${index}].report.success_criteria`);
    const questions = report.questions == null ? [] : stringArray(report.questions, `handoffs[${index}].report.questions`);
    entryCounters.narrative += [...constraints, ...successCriteria, ...questions].reduce((sum, text) => sum + text.length, 0);
    if (entryCounters.narrative > AGENT_HANDOFF_LIMITS.maxNarrativeChars) {
      fail("AGENT_HANDOFF_TOO_LARGE", `handoffs[${index}] exceeds the ${AGENT_HANDOFF_LIMITS.maxNarrativeChars}-character narrative limit`);
    }
    counters.narrative += entryCounters.narrative;
    counters.evidence += entryCounters.evidence;
    if (report.payload != null) exactKeys(report.payload, [], `handoffs[${index}].report.payload`);
    return {
      id,
      depends_on: dependsOn,
      target: validateTarget(entry.target, policy, profile, `handoffs[${index}].target`),
      intent,
      report: {
        summary,
        claims,
        scope: normalizeScope(report.scope || {}, `handoffs[${index}].report.scope`),
        constraints,
        success_criteria: successCriteria,
        questions,
        payload: {},
      },
    };
  });
  validateDependencyGraph(handoffs);
  if (counters.evidence > AGENT_HANDOFF_LIMITS.maxEvidenceChars) fail("AGENT_HANDOFF_EVIDENCE_TOO_LARGE", `Materialized evidence exceeds ${AGENT_HANDOFF_LIMITS.maxEvidenceChars} characters`);
  return {
    protocol: AGENT_HANDOFF_PROTOCOL,
    profile,
    outcome,
    role: normalizedRole,
    handoffs,
    evidence_chars: counters.evidence,
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
  packet.agent_call_id = agentCallId;
  packet.work_item_id = resolvedContext.workItemId;
  packet.job_id = resolvedContext.jobId;
  packet.attempt_id = resolvedContext.attemptId;
  const materializedJson = JSON.stringify(packet);
  const digest = crypto.createHash("sha256").update(materializedJson).digest("hex");
  const existing = handoffRow(agentCallId, database);
  if (existing) {
    if (existing.packet_digest === digest && ["staged", "committed"].includes(existing.status)) {
      database.prepare(`
        UPDATE ${TABLE}
        SET stage_count=stage_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE agent_call_id=?
      `).run(agentCallId);
      return {
        ok: true,
        status: existing.status,
        digest,
        idempotent: true,
        callCount: Number(existing.stage_count || 1) + 1,
      };
    }
    database.prepare(`UPDATE ${TABLE} SET status='rejected', rejection_code='duplicate_conflict', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_call_id=?`).run(agentCallId);
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
  if (!row || row.status !== "staged") return false;
  ensureSchema(db).prepare(`
    UPDATE ${TABLE}
    SET status='rejected', rejection_code=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE agent_call_id=? AND status='staged'
  `).run(`later_tool:${String(toolName || "unknown").slice(0, 80)}`, Number(agentCallId));
  return true;
}

function renderEvidence(evidence, lane) {
  const title = `${lane} — ${evidence.provenance.kind} · ${evidence.provenance.source || evidence.provenance.object_type} · ${evidence.selector}`;
  const quoted = evidence.excerpt.split("\n").map((line) => `> ${line}`).join("\n");
  return `${title}\n${quoted}`;
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
    for (const [evidence, reason] of detail.decoy || []) parts.push(`${renderEvidence(evidence, "Decoy")}\nWhy decoy: ${reason}`);
    if (detail.prose) parts.push(`Agent synthesis: ${detail.prose}`);
  }
  if (report.constraints.length) parts.push(`Constraints:\n${report.constraints.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.success_criteria.length) parts.push(`Success criteria:\n${report.success_criteria.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.questions.length) parts.push(`Questions:\n${report.questions.map((entry) => `- ${entry}`).join("\n")}`);
  return parts.join("\n\n");
}

function evidenceRefs(report) {
  const lanes = { proof: [], support: [], decoy: [] };
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const lane of ["proof", "support"]) {
      for (const item of detail[lane] || []) lanes[lane].push([item.ref]);
    }
    for (const [item, reason] of detail.decoy || []) lanes.decoy.push([item.ref, reason]);
  }
  return lanes;
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

export function renderAgentHandoffCompatibilityOutput(packet) {
  if (packet.completion && ["dev.result.v1", "artificer.result.v1"].includes(packet.profile)) {
    return renderCompletionCompatibilityOutput(packet);
  }
  if (packet.profile === "planner.plan.v1") {
    const indexes = new Map(packet.handoffs.map((handoff, index) => [handoff.id, index]));
    const tasks = packet.handoffs.map((handoff) => {
      const reportText = renderReport(handoff.report);
      const refs = evidenceRefs(handoff.report);
      return {
        title: handoff.intent,
        task_spec: reportText || handoff.intent,
        success_criteria: handoff.report.success_criteria.length ? handoff.report.success_criteria : [handoff.intent],
        depends_on_index: handoff.depends_on.map((id) => indexes.get(id)),
        files_to_modify: handoff.report.scope.files_to_modify || [],
        files_to_create: handoff.report.scope.files_to_create || [],
        files_to_delete: handoff.report.scope.files_to_delete || [],
        create_roots: handoff.report.scope.create_roots || [],
        dev_mode: "standard",
        risk: "medium",
        risk_tags: ["agent_handoff_experimental"],
        scope_confidence: "medium",
        job_type: handoff.target.role === "artificer" ? "artificer" : handoff.target.role,
        dev_brief: {
          source: "agent_handoff",
          summary: handoff.report.summary,
          key_files: handoff.report.scope.files_to_modify || [],
          related_files: [],
          planner_file_priorities: (handoff.report.scope.files_to_modify || []).map((path, index) => ({ path, rank: index + 1 })),
          ...refs,
        },
      };
    });
    return `\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }
  const first = packet.handoffs[0];
  const report = renderReport(first.report);
  if (packet.profile === "assessor.verdict.v1") {
    return `\`\`\`json\n${JSON.stringify({
      verdict: packet.outcome,
      confidence: "medium",
      reasons: [first.report.summary, ...first.report.claims.map((claim) => claim[0])].filter(Boolean),
      spawn_jobs: [],
      human_questions: first.report.questions,
      suggestions: [],
    }, null, 2)}\n\`\`\``;
  }
  if (packet.profile === "dev.result.v1") return `--- DEV RESULT START ---\n${report}\n--- DEV RESULT END ---`;
  if (packet.profile === "artificer.result.v1") return `--- ARTIFICER RESULT START ---\n${report}\n--- ARTIFICER RESULT END ---`;
  if (packet.profile === "researcher.pipeline.v1") {
    const refs = evidenceRefs(first.report);
    const files = [...new Set([
      ...(first.report.scope.files_to_modify || []),
      ...(first.report.scope.files_to_create || []),
    ])];
    return `${report}\n\n\`\`\`json\n${JSON.stringify({
      synthesis: first.report.summary,
      key_files: files,
      related_files: [],
      planner_file_priorities: files.map((path, index) => ({ path, rank: index + 1, reason: "agent_handoff evidence" })),
      proof: refs.proof,
      support: refs.support,
      decoy: refs.decoy,
      constraints: first.report.constraints,
      questions_for_human: packet.outcome === "input_required",
      questions: first.report.questions,
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
