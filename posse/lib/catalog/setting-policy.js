// @ts-check
// Settings value policy and limits; setting identities derive from setting-definitions.js.

export const ADMIN_PROTOCOL = "posse.admin.v1";
export const ADMIN_MAX_SETTINGS = 2048;
export const ADMIN_MAX_OPTIONS_PER_SETTING = 256;
export const ADMIN_MAX_TEXT_CHARS = 2048;
export const ADMIN_MAX_VALUE_CHARS = 16384;
export const ADMIN_MAX_JSON_BYTES = 2 * 1024 * 1024;

// Default ceiling applied when `assessor_max_tool_calls` is not configured as
// an integer. Shared by the settings catalogue default and by the assessor
// tool-call budget policy enforced at every assessor tool transport.
export const ASSESSOR_MAX_TOOL_CALLS_DEFAULT = 12;

export const SHARED_TRUNK_DEFAULTS = Object.freeze({
  enabled: false,
  branch: "",
  remote: "origin",
  fetchIntervalSec: 30,
  fetchIntervalIdleSec: 300,
  pushRetryMax: 3,
  claimsEnabled: false,
  claimsTtlMin: 30,
  claimDeferMaxMin: 30,
});

export const SHARED_TRUNK_LIMITS = Object.freeze({
  fetchIntervalSec: Object.freeze({ min: 5, max: 86_400 }),
  fetchIntervalIdleSec: Object.freeze({ min: 5, max: 86_400 }),
  pushRetryMax: Object.freeze({ min: 0, max: 20 }),
  claimsTtlMin: Object.freeze({ min: 1, max: 1_440 }),
  claimDeferMaxMin: Object.freeze({ min: 0, max: 1_440 }),
});

// Gates for compacting the project's orchestrator.db (VACUUM) once no run
// holds the scheduler lock. Retention deletes leave free pages behind and
// auto_vacuum is off, so the file otherwise never shrinks. The busy budget
// keeps a VACUUM that meets another process's reader from stalling shutdown.
export const RUNTIME_DB_COMPACTION_POLICY = Object.freeze({
  minFreelistRatio: 0.5,
  minFileBytes: 32 * 1024 * 1024,
  busyTimeoutMs: 2_000,
});





export const CODEX_AUTH_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: "oauth", label: "oauth (ChatGPT login)" }),
  Object.freeze({ value: "api", label: "api (API key)" }),
  Object.freeze({ value: "auto", label: "auto (oauth only)" }),
]);

export const ASSESSMENT_SCOPE_MODE_VALUES = Object.freeze(["off", "shadow"]);
export const AGENT_COORDINATION_MODE_VALUES = Object.freeze(["off", "handoff", "subagents"]);
export const CONTEXT_COMPACTION_MODE_VALUES = Object.freeze(["off", "shadow", "inject", "enforce"]);
// A database (task_mode "db") task that depends on file changes still only on
// its work item's branch: hold it until the merge and an operator's go-ahead
// (the project database may be production), or run it at once against the
// branch state for repositories whose project database is not production.
export const DB_TASK_PRE_MERGE_POLICIES = Object.freeze({ HOLD: "hold", RUN: "run" });
export const DB_TASK_PRE_MERGE_POLICY_VALUES = Object.freeze(Object.values(DB_TASK_PRE_MERGE_POLICIES));
export const FIX_SCOPE_HANDOFF_GUARD_VALUES = Object.freeze(["off", "auto", "warn", "enforce"]);
export const GIT_COMMIT_STYLE_VALUES = Object.freeze(["off", "conventional", "gitmoji"]);
export const HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES = Object.freeze(["off", "small", "always"]);
export const KAIZEN_TO_ATLAS_MODE_VALUES = Object.freeze(["off", "shadow", "write"]);
export const LOG_LEVEL_VALUES = Object.freeze(["debug", "info", "warn", "error"]);
export const MODEL_CATALOG_ENFORCEMENT_VALUES = Object.freeze(["warn_and_fallback", "warn_only", "off"]);
export const PLAN_APPROVAL_MODES = Object.freeze({
  AUTO_APPROVE: "auto_approve",
  CRITICAL_RISK: "critical_risk",
  ALL_PLANS: "all_plans",
});
export const PLAN_APPROVAL_MODE_VALUES = Object.freeze(Object.values(PLAN_APPROVAL_MODES));
export const PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES = Object.freeze(["off", "warn", "enforce"]);
export const RESEARCH_FANOUT_MODE_VALUES = Object.freeze(["off", "shadow", "on"]);
export const RESEARCH_TRAVERSAL_COMPLETION_MODE_VALUES = Object.freeze(["off", "shadow", "on"]);
export const RESEARCH_BUDGET_VISIBILITY_VALUES = Object.freeze(["countdown", "always"]);
export const RESEARCH_EVIDENCE_REUSE_MODE_VALUES = Object.freeze(["off", "shadow"]);
export const ATLAS_SHADOW_GUARDRAILS_MODE_VALUES = Object.freeze(["off", "shadow"]);
export const ATLAS_HANDOFF_PREFETCH_MODE_VALUES = Object.freeze(["on", "off"]);
export const ATLAS_RESEARCH_PREFETCH_FOCUS_MODE_VALUES = Object.freeze(["off", "shadow", "on"]);
export const ATLAS_MEMORY_SURFACE_MODE_VALUES = Object.freeze(["auto", "off", "on"]);
export const SESSION_RECYCLE_MODE_VALUES = Object.freeze(["off", "dev-fix", "full"]);
export const STARTUP_DIRTY_TREE_POLICY_VALUES = Object.freeze(["block", "commit"]);
export const WAITING_LANE_SHADOW_MODE_VALUES = Object.freeze(["off", "shadow"]);

// Settings no code reads any more. Opening the account DB deletes their stored
// rows, so an operator cannot keep a value that silently does nothing.
export const RETIRED_SETTING_KEYS = Object.freeze([
  "atlas_tool_gate_enabled",
  "atlas_tool_gate_default_migrated_at",
  "claude_cli_path",
  "claude_execution_mode",
  "engagement_engine",
]);
