// lib/domains/handoff/functions/helpers/shape-normalizer.js
//
// Shape-only coercions applied to agent_handoff arguments before validation.
//
// Every rule here preserves what the agent meant and only repairs how the
// transport or the model spelled it: a list delivered as JSON text or as an
// object keyed by position, a target given as its role name, an enum in the
// wrong case, an absolute path inside the repository, or completion prose a
// few hundred characters over a hard cap. Rejecting a whole handoff over any
// of these costs a full re-run of the agent call; the caller records each
// applied rule so the bounce that was avoided stays visible in telemetry and
// in the tool result the agent reads.
//
// Rules never invent content. Anything semantic (evidence custody, claim
// text, scope) is left for the validator to judge.

import path from "node:path";

export const AGENT_HANDOFF_COMPLETION_PROSE_MAX_CHARS = 1000;

const COMPLETION_PROSE_FIELDS = Object.freeze([
  "no_change_rationale",
  "blocker",
  "verification_unavailable",
  "evidence_gap",
]);

const ENTRY_LIST_FIELDS = Object.freeze(["depends_on"]);
const REPORT_LIST_FIELDS = Object.freeze(["claims", "constraints", "success_criteria", "questions"]);
const PLANNER_TASK_LIST_FIELDS = Object.freeze(["depends_on", "constraints", "success_criteria", "claims", "contract_refs"]);
const SCOPE_PATH_LIST_FIELDS = Object.freeze([
  "files_to_modify", "files_to_create", "files_to_delete", "create_roots", "key_files", "related_files",
]);

// Role-name targets and their canonical envelopes. Planner tasks address
// agents and system steps; other profiles address the pipeline, the result
// sink, or the parent call.
const TARGET_BY_NAME = Object.freeze({
  dev: { kind: "agent", role: "dev" },
  artificer: { kind: "agent", role: "artificer" },
  promote: { kind: "system", role: "promote" },
  human_input: { kind: "system", role: "human_input" },
  human: { kind: "system", role: "human_input" },
  pipeline: { kind: "pipeline", role: "$pipeline" },
  $pipeline: { kind: "pipeline", role: "$pipeline" },
  result: { kind: "result", role: "$result" },
  $result: { kind: "result", role: "$result" },
  parent: { kind: "parent", role: "$parent" },
  $parent: { kind: "parent", role: "$parent" },
});

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJsonText(text, expect) {
  const trimmed = String(text).trim();
  if (!trimmed) return undefined;
  const head = trimmed[0];
  if (expect === "array" && head !== "[") return undefined;
  if (expect === "object" && head !== "{") return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (expect === "array" && !Array.isArray(parsed)) return undefined;
    if (expect === "object" && !plain(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// A list delivered as JSON text, as an object keyed by position, or as a
// single bare entry. Returns undefined when no safe reading exists.
export function coerceList(value) {
  if (Array.isArray(value)) return { value, how: null };
  if (value == null) return undefined;
  if (typeof value === "string") {
    const parsed = parseJsonText(value, "array");
    if (parsed) return { value: parsed, how: "json_text" };
    const text = value.trim();
    return text ? { value: [text], how: "single_entry" } : undefined;
  }
  const object = plain(value);
  if (object) {
    const keys = Object.keys(object);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      return {
        value: keys.sort((left, right) => Number(left) - Number(right)).map((key) => object[key]),
        how: "keyed_object",
      };
    }
  }
  return undefined;
}

export function coerceObject(value) {
  if (plain(value)) return { value, how: null };
  if (typeof value === "string") {
    const parsed = parseJsonText(value, "object");
    if (parsed) return { value: parsed, how: "json_text" };
  }
  return undefined;
}

const TARGET_KINDS = new Set(["agent", "system", "pipeline", "result", "parent"]);
const TARGET_KIND_ALIASES = Object.freeze(["kind", "type", "target_kind", "target_type"]);
const TARGET_ROLE_ALIASES = Object.freeze(["role", "agent", "name", "to", "target_role", "role_name"]);

function targetFromTokens(tokens, how) {
  const cleaned = tokens.map((token) => String(token ?? "").trim()).filter(Boolean);
  if (cleaned.length === 1) {
    const named = TARGET_BY_NAME[cleaned[0].toLowerCase()];
    return named ? { value: { ...named }, how } : undefined;
  }
  if (cleaned.length === 2) {
    const [first, second] = cleaned;
    if (TARGET_KINDS.has(first.toLowerCase())) return { value: { kind: first.toLowerCase(), role: second }, how };
    if (TARGET_KINDS.has(second.toLowerCase())) return { value: { kind: second.toLowerCase(), role: first }, how };
    const byRole = TARGET_BY_NAME[second.toLowerCase()] || TARGET_BY_NAME[first.toLowerCase()];
    return byRole ? { value: { ...byRole }, how } : undefined;
  }
  return undefined;
}

export function coerceTarget(value) {
  if (plain(value)) {
    const hasCanonical = Object.hasOwn(value, "kind") && Object.hasOwn(value, "role");
    if (hasCanonical) return { value, how: null };
    // {type: "agent", agent: "dev"} and friends: map alias keys onto kind/role.
    const kindKey = TARGET_KIND_ALIASES.find((key) => typeof value[key] === "string" && value[key].trim());
    const roleKey = TARGET_ROLE_ALIASES.find((key) => typeof value[key] === "string" && value[key].trim());
    const kind = kindKey ? value[kindKey].trim().toLowerCase() : null;
    const role = roleKey ? value[roleKey].trim() : null;
    if (kind && role == null && TARGET_BY_NAME[kind] && !TARGET_KINDS.has(kind)) {
      return { value: { ...TARGET_BY_NAME[kind] }, how: "kind_as_role" };
    }
    if (role && kind == null && TARGET_BY_NAME[role.toLowerCase()]) {
      return { value: { ...TARGET_BY_NAME[role.toLowerCase()] }, how: "role_only" };
    }
    if (kind && role && TARGET_KINDS.has(kind) && (kindKey !== "kind" || roleKey !== "role")) {
      return { value: { kind, role }, how: "alias_keys" };
    }
    return { value, how: null };
  }
  if (Array.isArray(value)) return targetFromTokens(value.filter((entry) => typeof entry === "string"), "array_pair");
  if (typeof value !== "string") return undefined;
  const parsed = parseJsonText(value, "object");
  if (parsed) return coerceTarget(parsed) ?? { value: parsed, how: "json_text" };
  const text = value.trim();
  const named = TARGET_BY_NAME[text.toLowerCase()];
  if (named) return { value: { ...named }, how: "role_name" };
  // "agent:dev", "agent/dev", "agent.dev", "agent - dev", "dev (agent)"
  const tokens = text.replace(/[()[\]{}"']/g, " ").split(/[\s:/.\-]+/).filter(Boolean);
  return targetFromTokens(tokens, "kind_role_text");
}

function coerceEnumCase(value, allowed) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!allowed.includes(normalized) || normalized === value) return undefined;
  return normalized;
}

// Keep the head of over-long completion prose and say so inside the text
// itself, so the operator reading the completion sees the cut.
export function truncateCompletionProse(text, max = AGENT_HANDOFF_COMPLETION_PROSE_MAX_CHARS) {
  if (typeof text !== "string" || text.length <= max) return undefined;
  const marker = ` … [truncated by harness from ${text.length} chars]`;
  const keep = Math.max(0, max - marker.length);
  return `${text.slice(0, keep).trimEnd()}${marker}`;
}

// An absolute path that lives inside the repository (or the current agent
// cwd) is the same file the validator wants spelled repo-relative.
export function relativizeProjectPath(value, { projectDir = null, cwd = null } = {}) {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || !(path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))) return undefined;
  // The project root wins so the result matches surfaced-path custody; the
  // cwd only helps when the file is outside the project checkout.
  for (const root of [projectDir, cwd].map((entry) => String(entry || "").trim()).filter(Boolean)) {
    const relative = path.relative(path.resolve(root), path.resolve(raw)).replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    return relative;
  }
  return undefined;
}

// Evidence selectors are strings ("path:10-20", "#ref") or {ref, path, lines}.
export function relativizeEvidenceSelector(selector, roots) {
  if (typeof selector === "string") {
    const raw = selector.trim();
    if (raw.startsWith("#")) return undefined;
    const match = raw.match(/^(.+?)(:(?:l)?\d+(?:-(?:l)?\d+)?)?$/i);
    if (!match) return undefined;
    const relative = relativizeProjectPath(match[1], roots);
    if (relative == null) return undefined;
    return `${relative}${match[2] || ""}`;
  }
  const object = plain(selector);
  if (!object || typeof object.path !== "string") return undefined;
  const relative = relativizeProjectPath(object.path, roots);
  if (relative == null) return undefined;
  return { ...object, path: relative };
}

function relativizeClaimSelectors(claims, roots, note, label) {
  if (!Array.isArray(claims)) return claims;
  return claims.map((claim, claimIndex) => {
    const claimLabel = `${label}[${claimIndex}]`;
    const rewriteLane = (lane, laneLabel) => {
      if (!Array.isArray(lane)) return lane;
      return lane.map((entry, entryIndex) => {
        // decoy entries are [selector, reason] tuples
        if (Array.isArray(entry)) {
          const relative = relativizeEvidenceSelector(entry[0], roots);
          if (relative == null) return entry;
          note(`${laneLabel}[${entryIndex}]`, "absolute_path_relativized");
          return [relative, ...entry.slice(1)];
        }
        const relative = relativizeEvidenceSelector(entry, roots);
        if (relative == null) return entry;
        note(`${laneLabel}[${entryIndex}]`, "absolute_path_relativized");
        return relative;
      });
    };
    const rewriteDetail = (detail, detailLabel) => {
      const object = plain(detail);
      if (!object) return detail;
      const out = { ...object };
      for (const lane of ["evidence", "proof", "support", "decoy"]) {
        if (out[lane] != null) out[lane] = rewriteLane(out[lane], `${detailLabel}.${lane}`);
      }
      return out;
    };
    if (Array.isArray(claim)) {
      if (claim.length < 2) return claim;
      return [claim[0], rewriteDetail(claim[1], `${claimLabel}[1]`), ...claim.slice(2)];
    }
    return rewriteDetail(claim, claimLabel);
  });
}

function coerceListFields(object, fields, label, note) {
  const out = { ...object };
  for (const field of fields) {
    if (out[field] == null || Array.isArray(out[field])) continue;
    const coerced = coerceList(out[field]);
    if (!coerced || coerced.how == null) continue;
    out[field] = coerced.value;
    note(`${label}.${field}`, `list_from_${coerced.how}`);
  }
  return out;
}

function relativizePathList(object, fields, label, roots, note) {
  const out = { ...object };
  for (const field of fields) {
    if (!Array.isArray(out[field])) continue;
    out[field] = out[field].map((entry, index) => {
      const relative = relativizeProjectPath(entry, roots);
      if (relative == null) return entry;
      note(`${label}.${field}[${index}]`, "absolute_path_relativized");
      return relative;
    });
  }
  if (typeof out.output_root === "string") {
    const relative = relativizeProjectPath(out.output_root, roots);
    if (relative != null) {
      out.output_root = relative;
      note(`${label}.output_root`, "absolute_path_relativized");
    }
  }
  return out;
}

function normalizeReport(report, label, roots, note) {
  const coerced = coerceObject(report);
  if (!coerced) return report;
  if (coerced.how) note(label, `object_from_${coerced.how}`);
  let out = coerceListFields(coerced.value, REPORT_LIST_FIELDS, label, note);
  if (out.claims != null) out = { ...out, claims: relativizeClaimSelectors(out.claims, roots, note, `${label}.claims`) };
  const scope = coerceObject(out.scope);
  if (scope) {
    if (scope.how) note(`${label}.scope`, `object_from_${scope.how}`);
    out = { ...out, scope: relativizePathList(scope.value, SCOPE_PATH_LIST_FIELDS, `${label}.scope`, roots, note) };
  }
  const research = plain(out.research);
  if (research) {
    out = { ...out, research: relativizePathList(research, ["key_files", "related_files"], `${label}.research`, roots, note) };
  }
  return out;
}

function normalizeEnvelope(source, roots, note) {
  let out = { ...source };
  const confidence = coerceEnumCase(out.confidence, ["low", "medium", "high"]);
  if (confidence != null) { out.confidence = confidence; note("confidence", "enum_case"); }
  if (typeof out.outcome === "string" && out.outcome !== out.outcome.trim().toLowerCase()) {
    out.outcome = out.outcome.trim().toLowerCase();
    note("outcome", "enum_case");
  }
  if (out.handoffs != null && !Array.isArray(out.handoffs)) {
    const list = coerceList(out.handoffs);
    if (list?.how && list.how !== "single_entry") {
      out.handoffs = list.value;
      note("handoffs", `list_from_${list.how}`);
    } else if (plain(out.handoffs) && ("report" in out.handoffs || "target" in out.handoffs)) {
      out.handoffs = [out.handoffs];
      note("handoffs", "list_from_single_entry");
    }
  }
  if (Array.isArray(out.handoffs)) {
    out.handoffs = out.handoffs.map((raw, index) => {
      const label = `handoffs[${index}]`;
      const entryCoerced = coerceObject(raw);
      if (!entryCoerced) return raw;
      if (entryCoerced.how) note(label, `object_from_${entryCoerced.how}`);
      let entry = coerceListFields(entryCoerced.value, ENTRY_LIST_FIELDS, label, note);
      if (entry.target != null) {
        const target = coerceTarget(entry.target);
        if (target?.how) { entry = { ...entry, target: target.value }; note(`${label}.target`, `target_from_${target.how}`); }
      }
      if (entry.report != null) entry = { ...entry, report: normalizeReport(entry.report, `${label}.report`, roots, note) };
      return entry;
    });
  }
  // Assessor compact form carries evidence at the top level.
  for (const lane of ["evidence", "proof", "support"]) {
    if (Array.isArray(out[lane])) {
      out[lane] = out[lane].map((entry, index) => {
        const relative = relativizeEvidenceSelector(entry, roots);
        if (relative == null) return entry;
        note(`${lane}[${index}]`, "absolute_path_relativized");
        return relative;
      });
    }
  }
  return out;
}

function normalizePlannerTasks(source, roots, note) {
  const out = { ...source };
  const list = coerceList(out.tasks);
  if (list?.how && list.how !== "single_entry") {
    out.tasks = list.value;
    note("tasks", `list_from_${list.how}`);
  }
  if (!Array.isArray(out.tasks)) return out;
  out.tasks = out.tasks.map((raw, index) => {
    const label = `tasks[${index}]`;
    const coerced = coerceObject(raw);
    if (!coerced) return raw;
    if (coerced.how) note(label, `object_from_${coerced.how}`);
    let task = coerceListFields(coerced.value, PLANNER_TASK_LIST_FIELDS, label, note);
    if (task.claims != null) task = { ...task, claims: relativizeClaimSelectors(task.claims, roots, note, `${label}.claims`) };
    const scope = coerceObject(task.scope);
    if (scope) {
      if (scope.how) note(`${label}.scope`, `object_from_${scope.how}`);
      task = { ...task, scope: relativizePathList(scope.value, SCOPE_PATH_LIST_FIELDS, `${label}.scope`, roots, note) };
    }
    return task;
  });
  return out;
}

function normalizeCompletion(source, roots, note) {
  const out = { ...source };
  for (const field of COMPLETION_PROSE_FIELDS) {
    const truncated = truncateCompletionProse(out[field]);
    if (truncated != null) { out[field] = truncated; note(field, "prose_truncated"); }
  }
  if (out.remaining_work != null && !Array.isArray(out.remaining_work)) {
    const list = coerceList(out.remaining_work);
    if (list?.how) { out.remaining_work = list.value; note("remaining_work", `list_from_${list.how}`); }
  }
  if (Array.isArray(out.remaining_work)) {
    out.remaining_work = out.remaining_work.map((entry, index) => {
      const truncated = truncateCompletionProse(entry);
      if (truncated == null) return entry;
      note(`remaining_work[${index}]`, "prose_truncated");
      return truncated;
    });
  }
  if (out.file_requests != null && !Array.isArray(out.file_requests)) {
    const list = coerceList(out.file_requests);
    if (list?.how && list.how !== "single_entry") { out.file_requests = list.value; note("file_requests", `list_from_${list.how}`); }
  }
  if (Array.isArray(out.file_requests)) {
    out.file_requests = out.file_requests.map((entry, index) => {
      const request = plain(entry);
      if (!request) return entry;
      const relative = relativizeProjectPath(request.path, roots);
      if (relative == null) return entry;
      note(`file_requests[${index}].path`, "absolute_path_relativized");
      return { ...request, path: relative };
    });
  }
  return out;
}

const ENVELOPE_KEYS = ["protocol", "profile", "outcome", "handoffs"];

/**
 * Apply shape-only coercions to raw agent_handoff arguments.
 *
 * @returns {{ value: any, normalizations: Array<{ path: string, rule: string }> }}
 *   `value` is the coerced argument object (the input when nothing applied);
 *   `normalizations` lists each applied rule by argument path.
 */
export function normalizeAgentHandoffShape(args, { role = "", projectDir = null, cwd = null } = {}) {
  const normalizations = [];
  const source = plain(args);
  if (!source) return { value: args, normalizations };
  const roots = { projectDir, cwd };
  const note = (fieldPath, rule) => {
    if (normalizations.length < 64) normalizations.push({ path: fieldPath, rule });
  };
  const normalizedRole = String(role || "").trim().toLowerCase();
  let value;
  if (normalizedRole === "planner" && Object.hasOwn(source, "tasks") && !Object.hasOwn(source, "handoffs")) {
    value = normalizePlannerTasks(source, roots, note);
  } else if (ENVELOPE_KEYS.some((key) => Object.hasOwn(source, key)) || Object.hasOwn(source, "verdict")) {
    value = normalizeEnvelope(source, roots, note);
  } else {
    value = normalizeCompletion(source, roots, note);
  }
  return { value: normalizations.length > 0 ? value : args, normalizations };
}
