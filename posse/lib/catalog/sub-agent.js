import { readonlySet } from "./readonly-collections.js";
// Canonical local policy for deterministic tools that a citation child may
// consume through its private evidence cursor. Remote issuance surfaces carry
// canonical tool names but do not trust remote-provided access labels, so both
// native and Atlas evidence safety must be explicit closed sets.

import { AGENT_HANDOFF_PROFILES } from "./handoff.js";

export const RESEARCH_CHILD_PROFILE = AGENT_HANDOFF_PROFILES.RESEARCH_INVESTIGATION;
export const RESEARCH_CHILD_PROMPT_PROFILE = "researcher_code_child";
// A research child's full compact report, surfaced to the parent only when a
// multi-child tool result would otherwise cross the physical client limit.
export const RESEARCH_REPORT_OBJECT_TYPE = "research_report";
export const SUB_AGENT_PROTOCOL = "posse.sub_agent.v1";
export const SUB_AGENT_OBSERVATION_TYPES = Object.freeze({
  RESULT_OVER_TARGET: "sub_agent.result_over_target",
  RESEARCH_UNCITED_REPORT: "sub_agent.research_uncited_report",
  BRIEF_OVERLAP: "research.brief_overlap",
  INTENT_OVERSIZED: "sub_agent.intent_oversized",
  RESEARCH_EXPAND: "sub_agent.research_expand",
});
// The per-file source brief a research batch expands its cited hunks into.
export const RESEARCH_SOURCE_BRIEF_OBJECT_TYPE = "source_brief";
export const RESEARCH_EXPANSION_SOURCE = "tool:dispatch_agent.expand";
// Why a cited range was not expanded; stamped on the evidence item.
export const RESEARCH_EXPANSION_REASONS = Object.freeze({
  DISABLED: "expansion_disabled",
  BUDGET_EXHAUSTED: "expansion_budget_exhausted",
  SOURCE_UNAVAILABLE: "source_unavailable",
  HUNK_LIMIT: "hunk_limit",
  VISIBILITY_RANGE_UNRESOLVED: "visibility_range_unresolved",
  PATH_UNRESOLVED: "path_unresolved",
  LINE_RANGE_UNRESOLVED: "line_range_unresolved",
});
export const RESEARCH_EXPANSION_USAGE_GUIDANCE = "This brief is already visible. Cite files[].ref without rereading; use an issued traversal_ref only for source beyond the shown hunks.";
export const SUB_AGENT_EVIDENCE_OUTCOMES = Object.freeze({
  DELIVERED: "evidence_delivered",
  COVERED: "covered",
  CONTROL: "control",
  ERROR: "error",
});
export const SUB_AGENT_LIMITS = Object.freeze({
  maxBatch: 3,
  maxResearchBatch: 8,
  maxInputs: 3,
  maxActiveChildren: 8,
  // The child lane is shared by every concurrent parent. A batch that does not
  // fit waits in FIFO order for this long (further bounded by what its tool
  // deadline leaves after the children's own timeout) before it is refused.
  admissionWaitMs: 180_000,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 60_000,
  maxStatusWaitMs: 5_000,
  maxCursorAttempts: 5,
  maxInputArgumentBytes: 8 * 1024,
  maxInputDepth: 6,
  maxInputArrayItems: 32,
  maxInputStringChars: 4000,
  // Soft cap: a longer child question is dispatched as written and recorded
  // (INTENT_OVERSIZED). Rejecting it makes the parent regenerate the call.
  maxIntentChars: 2000,
  maxEvidenceLines: 80,
  maxEvidenceChars: 4000,
  targetTerminalEvidenceLines: 30,
  maxAtlasWindowTokens: 900,
  maxRequestBytes: 32 * 1024,
  maxExpandedFiles: 12,
  maxExpansionReasonChars: 48,
  maxResearchAnchors: 8,
  registryTtlMs: 8 * 60 * 60 * 1000,
  settledBatchRetentionMs: 60_000,
  maxCursorRetriesPerPosition: 1,
  // Codex middle-clips tool results at roughly 48k characters. Leave room for
  // the MCP envelope and move only whole reports when a batch approaches it.
  transportResultTargetChars: 46_000,
});

const errorCodes = (names) => Object.freeze(Object.fromEntries(names.map((name) => [name, `SUB_AGENT_${name}`])));
export const SUB_AGENT_ERROR_CODES = errorCodes([
  "ADMIN_DISABLED",
  "BATCH_LIMIT",
  "BATCH_NOT_FOUND",
  "CANCELLED",
  "CAPACITY",
  "CHILDREN_PENDING",
  "CHILD_BINDING_CONFLICT",
  "CHILD_BINDING_INVALID",
  "CHILD_FAILED",
  "CONTEXT_INVALID",
  "CURSOR_ATTEMPTS_EXHAUSTED",
  "CURSOR_BUDGET_EXHAUSTED",
  "CURSOR_CONFLICT",
  "CURSOR_INVALID",
  "CURSOR_OUT_OF_ORDER",
  "CURSOR_SEALED",
  "CURSOR_UNBOUND",
  "ERROR",
  "EVIDENCE_REQUIRED",
  "EVIDENCE_SCOPE_VIOLATION",
  "EVIDENCE_SURFACE_FAILED",
  "INPUT_CHANGED",
  "INPUT_EMPTY",
  "INPUT_EXECUTOR_UNAVAILABLE",
  "INPUT_INVALID",
  "INPUT_NOT_EVIDENCE",
  "INPUT_PATH_SELECTOR_UNSUPPORTED",
  "INPUT_TOOL_ERROR",
  "INPUT_TOOL_FORBIDDEN",
  "INPUT_TOO_LARGE",
  "PARENT_CLOSED",
  "PARENT_UNAVAILABLE",
  "PROFILE_INVALID",
  "PROTOCOL_INVALID",
  "RESEARCH_DISABLED",
  "RESEARCH_UNBOUND",
  "SCHEMA_INVALID",
  "TERMINAL_REPORT_MISSING",
  "TIMEOUT",
  "TOO_LARGE",
]);

// One child request's lifecycle. `merged` marks a request absorbed into an
// overlapping brief: it never runs and its result row points at the survivor.
export const SUB_AGENT_ENTRY_STATUSES = Object.freeze({
  ADMITTED: "admitted",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  MERGED: "merged",
});
export const SUB_AGENT_ACTIVE_ENTRY_STATUSES = Object.freeze([
  SUB_AGENT_ENTRY_STATUSES.ADMITTED,
  SUB_AGENT_ENTRY_STATUSES.RUNNING,
]);
export const SUB_AGENT_BATCH_STATUSES = Object.freeze({
  RUNNING: "running",
  SETTLED: "settled",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
});

// Tools a citation child's evidence cursor never runs, read-only label or not.
export const SUB_AGENT_FORBIDDEN_CURSOR_TOOLS = Object.freeze([
  "tools.agent_handoff",
  "tools.sub_agent",
  "tools.sub_agent_next_input",
  "atlas.create_ref",
  "atlas.memory.feedback",
]);

// A planner's research request is repaired and noted, never rejected: these
// are the model-visible repair notes.
export const RESEARCH_BUDGET_KEYS = Object.freeze(["timeout_ms", "max_turns", "reasoning_effort", "model_tier"]);
export const RESEARCH_REPAIR_ACTIONS = Object.freeze({
  IGNORED: "ignored",
  COERCED: "coerced",
  DEFAULTED: "defaulted",
  DROPPED: "dropped",
  TRUNCATED: "truncated",
  RAISED: "raised",
  FOLDED_INTO_REQUESTS: "folded_into_requests",
});
export const RESEARCH_REPAIR_REASONS = Object.freeze({
  NOT_AN_OBJECT: "not_an_object",
  NOT_AN_ARRAY: "not_an_array",
  UNKNOWN_KEY: "unknown_key",
  INVALID_NUMBER: "invalid_number",
  INVALID_EFFORT: "invalid_effort",
  INVALID_MODEL_TIER: "invalid_model_tier",
  WEB_CHILD_TIER: "web_children_use_cheaper_tiers",
  STRONG_CHILD_LIMIT: "strong_child_limit_per_planner_call",
  ANCHOR_LIMIT: "at_most_eight_anchors",
  ANCHORS_CODE_ONLY: "repository anchors are supported only for code research children",
  MERGED_BRIEF_BUDGET: "merged_brief_takes_strongest_budget",
});

export const SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOLS = Object.freeze([
  "tools.read_file",
  "tools.list_files",
  "tools.search_files",
  "tools.git_history",
  "tools.inspect_file",
  "tools.hash_file",
  "tools.read_image_metadata",
  "tools.validate_artifact_output",
  "tools.extract_image_text",
]);

const SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOL_SET = readonlySet(SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOLS);

export function isSubAgentEvidenceSafeNativeTool(name) {
  return SUB_AGENT_EVIDENCE_SAFE_NATIVE_TOOL_SET.has(String(name || ""));
}

export const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS = Object.freeze([
  "atlas.query",
  "atlas.code",
  "atlas.repo",
  "atlas.action.search",
  "atlas.manual",
  "atlas.info",
  "atlas.traverse_ref",
  "atlas.fetch_ref",
  "atlas.repo.status",
  "atlas.repo.overview",
  "atlas.repo.quality",
  "atlas.buffer.status",
  "atlas.symbol.search",
  "atlas.symbol.card",
  "atlas.symbol.overview",
  "atlas.symbol.callers",
  "atlas.symbol.get",
  "atlas.tree.overview",
  "atlas.tree.branch",
  "atlas.tree.scope",
  "atlas.tree.expand",
  "atlas.slice.spillover.get",
  "atlas.edit.plan",
  "atlas.code.skeleton",
  "atlas.code.lens",
  "atlas.code.window",
  "atlas.code.survey",
  "atlas.code.structure",
  "atlas.code.db",
  "atlas.context",
  "atlas.context.summary",
  "atlas.agent.feedback.query",
  "atlas.review.delta",
  "atlas.review.analyze",
  "atlas.review.risk",
  "atlas.file.read",
  "atlas.memory.get",
  "atlas.memory.surface",
  "atlas.policy.get",
  "atlas.usage.stats",
  "atlas.runtime.queryOutput",
]);

const SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET = readonlySet(SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOLS);

export function isSubAgentEvidenceSafeAtlasTool(name) {
  return SUB_AGENT_EVIDENCE_SAFE_ATLAS_TOOL_SET.has(String(name || ""));
}

// Routing accounting subsets: these count parent reads and invalidate prior
// delegated selections after writes. Evidence authorization stays in the
// independent safe-tool catalogs above.
export const SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS = 2;

export const SUB_AGENT_ROUTING_MIN_TARGETS = 2;

export const SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS = 3000;

export const SUB_AGENT_ROUTING_EVIDENCE_TOOLS = readonlySet([
  "tools.read_file",
  "tools.search_files",
  "tools.chain_read",
  "atlas.code.window",
  "atlas.code.survey",
  "atlas.code.structure",
]);

export const SUB_AGENT_ROUTING_WRITE_TOOLS = readonlySet([
  "tools.write_file",
  "tools.edit_file",
  "tools.apply_patch",
  "atlas.edit.apply",
]);
