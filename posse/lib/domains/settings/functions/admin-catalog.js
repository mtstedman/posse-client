import { PROVIDER_ROLE_NAMES } from "../../providers/functions/roles.js";
import {
  SETTINGS_CATALOG,
  getCatalogNumericRule,
  getCatalogOptionValues,
  getCatalogOptions,
  isCatalogBooleanSetting,
} from "./catalog.js";

export const DELEGATION_MODE_OPTIONS = getCatalogOptionValues("delegation_mode");
export const PROVIDER_SETTING_KEYS = new Set(PROVIDER_ROLE_NAMES.map((role) => `provider_${role}`));
export const SYNTHETIC_SETTING_KEYS = new Set(["delegation_mode"]);
export const ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS = new Set(["artifact_image_provider"]);
export const SKILL_SETTING_PREFIX = "skill_enabled:";

export const BOOLEAN_SETTING_KEYS = new Set(
  SETTINGS_CATALOG
    .filter((entry) => isCatalogBooleanSetting(entry.key))
    .map((entry) => entry.key),
);

export const CODEX_AUTH_MODE_OPTIONS = getCatalogOptions("codex_auth_mode");

export const ENUM_SETTING_OPTIONS = Object.freeze(Object.fromEntries(
  SETTINGS_CATALOG
    .filter((entry) => Array.isArray(entry.options) && !entry.multi)
    .map((entry) => [entry.key, getCatalogOptions(entry.key)]),
));

export const DEFAULT_ACCOUNT_SETTING_ROWS = Object.freeze(
  SETTINGS_CATALOG
    .filter((entry) => entry.scope !== "repo")
    .map((entry) => Object.freeze({
      setting_key: entry.key,
      setting_value: entry.default == null ? "" : String(entry.default),
    })),
);

export const TURN_BASE_KEY_MAP = Object.freeze({
  max_turns_researcher: "base_turns_researcher",
  max_turns_planner: "base_turns_planner",
  max_turns_dev: "base_turns_dev",
  max_turns_assessor: "base_turns_assessor",
});
export const TURN_BASE_KEY_REVERSE_MAP = Object.freeze(
  Object.fromEntries(Object.entries(TURN_BASE_KEY_MAP).map(([from, to]) => [to, from]))
);

export const ATLAS_PHASE_OPTIONS = getCatalogOptions("atlas_phases");
export const ATLAS_PHASE_VALUES = new Set(ATLAS_PHASE_OPTIONS.map((option) => option.value));
export const MULTI_SETTING_KEYS = new Set(
  SETTINGS_CATALOG
    .filter((entry) => Array.isArray(entry.options) && entry.multi)
    .map((entry) => entry.key),
);
export const MULTI_SETTING_OPTIONS = Object.freeze(Object.fromEntries(
  [...MULTI_SETTING_KEYS].map((key) => [key, getCatalogOptions(key)]),
));
export const MULTI_SETTING_VALUES = Object.freeze(Object.fromEntries(
  Object.entries(MULTI_SETTING_OPTIONS).map(([key, options]) => [
    key,
    new Set(options.map((option) => option.value)),
  ]),
));
export const ATLAS_PHASE_SETTING_KEYS = new Set(["atlas_phases"]);

export const NUMERIC_SETTING_RULES = Object.freeze(Object.fromEntries(
  SETTINGS_CATALOG
    .map((entry) => [entry.key, getCatalogNumericRule(entry.key)])
    .filter(([, rule]) => !!rule),
));

export const ATLAS_LOCKED_SETTING_KEYS = new Set([
  "atlas_transport",
  "atlas_install_path",
  "atlas_node_path",
  "atlas_command",
  "atlas_args",
  "atlas_url",
  "atlas_host",
  "atlas_port",
  "atlas_server_name",
]);

export const HIDDEN_SETTING_KEYS = new Set([
  "claude_session_tokens",
  "claude_session_max",
  "claude_session_reset_at",
  "claude_weekly_tokens",
  "claude_weekly_max",
  "claude_weekly_reset_at",
  "claude_usage_subscription_type",
  "claude_usage_rate_limit_tier",
  "claude_usage_source",
  "claude_usage_last_updated",
  "claude_limit_tokens_session",
  "claude_limit_tokens_week",
  "claude_observed_pct_session",
  "claude_observed_pct_week",
  "openai_limit_tokens_session",
  "openai_limit_tokens_week",
  "openai_observed_pct_session",
  "openai_observed_pct_week",
  "bridge_bind_host",
  "bridge_local_token",
  "bridge_instance_id",
  "bridge_relay_token",
  "bridge_relay_url",
  // Remote encoder is an advanced/experimental path — keep it functional (config
  // still reads these) but out of the admin settings editor.
  "atlas_remote_encoder_mode",
  "atlas_remote_encoder_url",
  "atlas_remote_encoder_model",
  "atlas_remote_encoder_dim",
  "atlas_remote_encoder_model_version",
  "atlas_remote_encoder_timeout_ms",
  ...ATLAS_LOCKED_SETTING_KEYS,
]);

export function toDisplaySettingKey(settingKey = "") {
  return TURN_BASE_KEY_MAP[settingKey] || settingKey;
}

export function toStorageSettingKey(settingKey = "") {
  return TURN_BASE_KEY_REVERSE_MAP[settingKey] || settingKey;
}

// ── Admin settings groups ───────────────────────────────────────────────────
//
// Source of truth for how the catch-all "Database Settings" section is split
// in the admin TUI. Each entry's `keys` are display-keys (matching what the
// settings snapshot returns) and render in the listed order. Any catalog key
// not mentioned here lands in a "Misc" group at the bottom so newly-added
// settings stay visible until they're explicitly placed.
export const SETTINGS_GROUPS = Object.freeze([
  {
    id: "scheduler",
    label: "scheduler & concurrency",
    keys: Object.freeze([
      "scheduler_concurrency",
      "scheduler_max_active_worktrees",
      "scheduler_poll_ms",
      "scheduler_repair_poll_ms",
      "default_lease_seconds",
      "worker_lease_renew_max_transient_errors",
      "lease_requeue_grace_sec",
      "worker_provider_circuit_ttl_ms",
      "worktree_lock_wait_ms",
      "startup_dirty_tree_policy",
      "stall_timeout",
      "max_job_runtime_sec",
      "headless_human_timeout_sec",
      "default_max_attempts",
      "scheduler_shadow_conflict_metrics",
      "target_branch",
      "session_recycle_mode",
      "session_recycle_strict_provider",
      "posse_session_lease_ttl",
    ]),
  },
  {
    id: "behaviors",
    label: "behaviors & safety hooks",
    keys: Object.freeze([
      "auto_merge_completed",
      "plan_approval_mode",
      "research_fanout",
      "web_tools_enabled",
      "claude_execution_mode",
      "codex_auth_mode",
      "pre_assess_cmd",
      "pre_push_verify_cmd",
      "skip_hooks",
      "skip_hook_secrets_scan",
      "skip_hook_post_dev_verify",
      "skip_hook_pre_push_gate",
      "worktree_clean_ignored",
    ]),
  },
  {
    id: "bridge",
    label: "local bridge",
    keys: Object.freeze([
      "bridge_port",
      "bridge_label",
    ]),
  },
  {
    id: "snapshots",
    label: "snapshots & recovery",
    keys: Object.freeze([
      "snapshot_retention_days",
      "snapshot_max_bytes",
      "snapshot_max_refs",
      "snapshot_dedup",
    ]),
  },
  {
    id: "assessor",
    label: "assessor",
    keys: Object.freeze([
      "assessor_fallback_reads",
      "assessor_fallback_reads_retry_step",
      "assessor_internal_retry_limit",
      "assessor_parse_retry_input_tokens_cap",
    ]),
  },
  {
    id: "handoff",
    label: "handoff & context",
    keys: Object.freeze([
      "handoff_max_prompt_chars",
      "handoff_max_context_chars",
      "handoff_preload_editable_file_bodies",
      "handoff_max_file_bytes",
      "handoff_max_preload_total_bytes",
      "handoff_max_related_files_total_bytes",
      "posse_remote_mode",
      "posse_remote_url",
      "posse_remote_timeout_ms",
      "file_request_low_risk_extensions",
      "context_expand_max_steps",
      "context_expand_file_budget_per_attempt",
    ]),
  },
  {
    id: "planner",
    label: "planner & skills",
    keys: Object.freeze([
      "planner_max_tasks",
      "planner_under_scoped_broad_gate",
      "skills_enabled",
      "skills_disabled_ids",
    ]),
  },
  {
    id: "turns",
    label: "max turns per role",
    keys: Object.freeze([
      "base_turns_researcher",
      "base_turns_planner",
      "base_turns_dev",
      "base_turns_assessor",
    ]),
  },
  {
    id: "budgets",
    label: "budgets & account limits",
    keys: Object.freeze([
      "openai_account_limit_tokens_session",
      "openai_account_limit_tokens_week",
      "openai_daily_budget_usd",
      "grok_daily_budget_usd",
      "claude_usage_cache_ms",
      "claude_usage_backoff_ms",
      "codex_usage_cache_ms",
      "codex_usage_backoff_ms",
    ]),
  },
  {
    id: "atlas",
    label: "ATLAS integration",
    keys: Object.freeze([
      "atlas_v2",
      "atlas_scip_mode",
      "atlas_scip_languages",
      "atlas_scip_index_command",
      "atlas_scip_index_args",
      "atlas_scip_index_timeout_ms",
      "atlas_scip_cold_index_timeout_ms",
      "atlas_scip_restage_policy",
      "atlas_scip_max_age_hours",
      "atlas_phases",
      "atlas_live_funnel",
      "atlas_auto_feedback",
      "atlas_live_index",
      "atlas_live_buffers",
      "atlas_memory_surface",
      "posse_kaizen_to_atlas",
      "atlas_semantic_enabled",
      "atlas_vector_backend",
      "atlas_tree_compression_mode",
      "atlas_tree_compression_provider",
      "atlas_tree_compression_model_tier",
      "atlas_tree_compression_max_seeds",
      "atlas_tree_compression_model_max_seeds",
      "atlas_embedding_provider",
      "atlas_embedding_endpoint",
      "atlas_embedding_model",
      "atlas_embedding_dim",
      "atlas_remote_encoder_mode",
      "atlas_remote_encoder_url",
      "atlas_remote_encoder_model",
      "atlas_remote_encoder_dim",
      "atlas_boot_reindex_policy",
      "atlas_v2_boot_soft_timeout_ms",
      "atlas_reindex_on_commit",
      "atlas_drift_check",
      "atlas_tool_gate_enabled",
    ]),
  },
]);

const GROUPED_KEY_SET = new Set(SETTINGS_GROUPS.flatMap((group) => group.keys));
export const TUNING_SETTING_KEYS = new Set([
  "scheduler_max_active_worktrees",
  "scheduler_poll_ms",
  "scheduler_repair_poll_ms",
  "default_lease_seconds",
  "worker_lease_renew_max_transient_errors",
  "lease_requeue_grace_sec",
  "worker_provider_circuit_ttl_ms",
  "worktree_lock_wait_ms",
  "stall_timeout",
  "max_job_runtime_sec",
  "headless_human_timeout_sec",
  "default_max_attempts",
  "scheduler_shadow_conflict_metrics",
  "session_recycle_strict_provider",
  "posse_session_lease_ttl",
  "skip_hooks",
  "skip_hook_secrets_scan",
  "skip_hook_post_dev_verify",
  "skip_hook_pre_push_gate",
  "worktree_clean_ignored",
  "research_fanout",
  "snapshot_retention_days",
  "snapshot_max_bytes",
  "snapshot_max_refs",
  "snapshot_dedup",
  "assessor_fallback_reads",
  "assessor_fallback_reads_retry_step",
  "assessor_internal_retry_limit",
  "assessor_parse_retry_input_tokens_cap",
  "fix_scope_handoff_guard",
  "handoff_max_prompt_chars",
  "handoff_max_context_chars",
  "handoff_preload_editable_file_bodies",
  "handoff_max_file_bytes",
  "handoff_max_preload_total_bytes",
  "handoff_max_related_files_total_bytes",
  "posse_remote_timeout_ms",
  "context_expand_max_steps",
  "context_expand_file_budget_per_attempt",
  "planner_max_tasks",
  "planner_under_scoped_broad_gate",
  "base_turns_researcher",
  "base_turns_planner",
  "base_turns_dev",
  "base_turns_assessor",
  "claude_usage_cache_ms",
  "claude_usage_backoff_ms",
  "codex_usage_cache_ms",
  "codex_usage_backoff_ms",
  "atlas_scip_index_command",
  "atlas_scip_index_args",
  "atlas_scip_index_timeout_ms",
  "atlas_scip_cold_index_timeout_ms",
  "atlas_scip_max_age_hours",
  "atlas_auto_feedback",
  "atlas_live_buffers",
  "posse_kaizen_to_atlas",
  "atlas_semantic_enabled",
  "atlas_vector_backend",
  "atlas_wi_embeddings",
  "atlas_tree_compression_mode",
  "atlas_tree_compression_provider",
  "atlas_tree_compression_model_tier",
  "atlas_tree_compression_max_seeds",
  "atlas_tree_compression_model_max_seeds",
  "atlas_embedding_provider",
  "atlas_embedding_endpoint",
  "atlas_embedding_model",
  "atlas_embedding_dim",
  "atlas_embedding_threads",
  "atlas_remote_encoder_mode",
  "atlas_remote_encoder_url",
  "atlas_remote_encoder_model",
  "atlas_remote_encoder_dim",
  "atlas_boot_reindex_policy",
  "atlas_handoff_prefetch_timeout_ms",
  "atlas_v2_boot_soft_timeout_ms",
  "atlas_reindex_on_commit",
  "atlas_drift_check",
  "atlas_tool_gate_enabled",
  "git_atlas_post_commit_hook_timeout_ms",
  "posse_retention_days",
  "posse_wi_failure_threshold",
  "posse_max_fix_chain_depth",
  "posse_max_replans",
  "posse_max_file_request_depth",
  "posse_fanout_child_timeout_sec",
  "posse_display_max_events",
  "posse_display_event_rate_limit_per_sec",
  "posse_log_level",
  "posse_log_scrub_secrets",
]);

export function isTuningSettingKey(displayKey) {
  return TUNING_SETTING_KEYS.has(displayKey);
}

export function settingsGroupForKey(displayKey) {
  for (const group of SETTINGS_GROUPS) {
    if (group.keys.includes(displayKey)) return group;
  }
  return null;
}
export function isGroupedSettingKey(displayKey) {
  return GROUPED_KEY_SET.has(displayKey);
}
