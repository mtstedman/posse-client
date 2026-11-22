import { readonlySet } from "./readonly-collections.js";
// Physical Atlas requests, distinct from expanded tool.atlas execution rows.
export const ATLAS_REQUEST_OBSERVATION_TYPE = "system.atlas_request";

export const RESPONSE_TRANSFORM_OBSERVATION_TYPE = "system.response_transform";
export const PROVIDER_TOOL_REFERENCE_UNRESOLVED_OBSERVATION_TYPE = "provider.tool_reference_unresolved";
export const RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE = "handoff.research_child_envelope_normalized";
export const ASSESSMENT_VERDICT_OBSERVATION_TYPE = "assessment.verdict";
export const HANDOFF_TRAVERSAL_COMPLETION_CHECK_OBSERVATION_TYPE = "handoff.traversal_completion_check";
export const TOOL_SURFACE_ISSUED_OBSERVATION_TYPE = "tool.surface.issued";
// Bounded provider commentary (the visible text between tool calls), kept
// beside the job's tool rows so the conversation orders and retains both alike.
export const AGENT_COMMENTARY_OBSERVATION_TYPE = "agent.commentary";
export const AGENT_HANDOFF_OBSERVATION_TYPES = Object.freeze({
  SHAPE_NORMALIZED: "agent_handoff.shape_normalized",
  TARGET_DERIVED: "agent_handoff.target_derived",
  EVIDENCE_CLEANUP: "agent_handoff.evidence_cleanup",
  TRAVERSAL_COMPLETION_GATE: "agent_handoff.traversal_completion_gate",
});

// A frozen baseline that fails after passing for an earlier job of the same
// work item, attributed to the jobs whose commits landed in between.
export const BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE = "command.baseline_sibling_regression";

export const INTERNAL_BACKGROUND_OBSERVATION_TYPES = Object.freeze([
  RESPONSE_TRANSFORM_OBSERVATION_TYPE,
  ATLAS_REQUEST_OBSERVATION_TYPE,
  "tool.response_transform",
]);

const INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET = readonlySet(INTERNAL_BACKGROUND_OBSERVATION_TYPES);

export function isInternalBackgroundObservationType(value) {
  return INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET.has(String(value || ""));
}

// ── tool.* rows that are not agent tool calls ───────────────────────────────
// Every tool.* observation is one of four kinds:
//   call     a tool call the agent issued (its .started twin included)
//   message  the live operator channel: the operator's nudges the agent pulls
//            or acknowledges, and the progress updates it posts
//   system   harness rows about calls: model-visible notices appended to a
//            result, budget advisories, argument repairs, transport errors,
//            and tool-surface/response bookkeeping
//   harness  background prefetch and autofeedback the agent never issued
// Tool history and tool counts show calls only. Message and system notices
// belong in the system feed; bookkeeping records are shown nowhere.
// @catalog-sync id=posse.tool_observation.kinds role=authority relation=strict compare=names extract=strings projection_source=posse
// @linked_repos posse-bossy:catalog/tool_observations.go
export const TOOL_MESSAGE_OBSERVATION_TYPES = readonlySet([
  "tool.agent_feedback",
  "tool.get_operator_feedback",
  "tool.ack_operator_feedback",
]);
export const TOOL_SYSTEM_NOTICE_OBSERVATION_TYPES = readonlySet([
  "tool.response_control",
  "tool.budget_advisory",
  "tool.dispatch_agent.repaired",
  "tool.surface.list_failed",
  "tool.sub_agent.error",
  "tool.sub_agent_next_input.error",
  "tool.dispatch_agent.error",
]);
export const TOOL_SYSTEM_RECORD_OBSERVATION_TYPES = readonlySet([
  "tool.response_transform",
  "tool.surface.issued",
]);
export const TOOL_HARNESS_OBSERVATION_SUFFIXES = Object.freeze([".prefetch", ".autofeedback"]);
// @catalog-sync end
// A read of a missing path is an ordinary call outcome, not a failure.
export const TOOL_BENIGN_OBSERVATION_TYPES = readonlySet(["tool.read.not_found"]);
const TOOL_STARTED_SUFFIX = ".started";

/**
 * @param {unknown} value an observation_type
 * @returns {"call" | "message" | "system" | "harness" | null} null outside tool.*
 */
export function toolObservationKind(value) {
  const text = String(value || "");
  const type = text.endsWith(TOOL_STARTED_SUFFIX) ? text.slice(0, -TOOL_STARTED_SUFFIX.length) : text;
  if (!type.startsWith("tool.")) return null;
  if (TOOL_MESSAGE_OBSERVATION_TYPES.has(type)) return "message";
  if (TOOL_SYSTEM_NOTICE_OBSERVATION_TYPES.has(type) || TOOL_SYSTEM_RECORD_OBSERVATION_TYPES.has(type)
    || isInternalBackgroundObservationType(type) || isInternalBackgroundObservationType(text)) return "system";
  if (TOOL_HARNESS_OBSERVATION_SUFFIXES.some((suffix) => type.endsWith(suffix))) return "harness";
  return "call";
}

export const isToolCallObservationType = (value) => toolObservationKind(value) === "call";

// What the system feed shows: harness notices and the agent's pickup of
// operator nudges. The agent's own progress posts are agent messages, and
// bookkeeping records are shown nowhere.
export const TOOL_SYSTEM_FEED_OBSERVATION_TYPES = readonlySet([
  ...TOOL_SYSTEM_NOTICE_OBSERVATION_TYPES,
  "tool.get_operator_feedback",
  "tool.ack_operator_feedback",
]);

// SQL guard for tool counts, matching toolObservationKind(...) === "call".
const quoted = (values) => [...values].map((value) => `'${value}'`).join(", ");
export const TOOL_CALL_OBSERVATION_SQL = (column = "observation_type") => `(${column} LIKE 'tool.%'
    AND ${column} NOT LIKE '%.started'
    AND ${column} NOT IN (${quoted([
      ...TOOL_MESSAGE_OBSERVATION_TYPES,
      ...TOOL_SYSTEM_NOTICE_OBSERVATION_TYPES,
      ...TOOL_SYSTEM_RECORD_OBSERVATION_TYPES,
      ...INTERNAL_BACKGROUND_OBSERVATION_TYPES,
    ])})
    ${TOOL_HARNESS_OBSERVATION_SUFFIXES.map((suffix) => `AND ${column} NOT LIKE '%${suffix}'`).join("\n    ")})`;

// Observation types that contribute to the local research exploration ledger.
export const RESEARCH_EXPLORATION_OBSERVATION_TYPES = Object.freeze([
  "tool.atlas",
  "tool.read",
  "tool.chain_verdict",
  "tool.list",
  "tool.search",
  "tool.git_history",
  "tool.inspect",
  "tool.hash",
]);
// Native tools a research call explores with; each records one of the tool.*
// exploration observations above. The synthesis gate also holds chain_read.
export const RESEARCH_NATIVE_EXPLORATION_TOOLS = readonlySet([
  "read_file",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
]);
export const RESEARCH_NATIVE_SYNTHESIS_GATED_TOOLS = readonlySet([
  "read_file",
  "chain_read",
  ...[...RESEARCH_NATIVE_EXPLORATION_TOOLS].filter((tool) => tool !== "read_file"),
]);

// Lookups the research guardrail diagnostics count per call: exploration
// without plain file reads.
export const RESEARCH_LOOKUP_OBSERVATION_TYPES = Object.freeze(
  RESEARCH_EXPLORATION_OBSERVATION_TYPES.filter((type) => type !== "tool.read"),
);
export const RESEARCH_LOOKUP_OBSERVATION_TYPES_SQL = RESEARCH_LOOKUP_OBSERVATION_TYPES.map((type) => `'${type}'`).join(", ");

export const RESEARCH_ATTEMPT_SCOPED_OBSERVATION_TYPES = readonlySet([
  "research.source_selection",
  "research.exploration_blocked",
  "research.ceiling_grace",
  "source.coverage",
  "context.headroom_decision",
  "context.headroom_actual",
]);

export const RESEARCH_INFRASTRUCTURE_FAILURE_CODES = readonlySet([
  "repo_root_unavailable",
  "repository_unavailable",
  "file_unreadable",
  "file_read_failed",
  "native_unavailable",
  "native_transport_error",
  "atlas_storage_error",
  "indexed_file_missing",
  "code_response_too_large",
  "code_window_response_too_large",
]);

export const RESEARCH_INFRASTRUCTURE_REFUND_LIMIT = 2;

export const TOOL_OBSERVATION_OUTCOMES = readonlySet(["succeeded", "rejected", "failed"]);

export const READ_NOT_FOUND_OBSERVATION = "tool.read.not_found";
