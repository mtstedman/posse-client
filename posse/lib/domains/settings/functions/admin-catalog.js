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

// ── Project database (opt-in agent SQL access) ──────────────────────────────
// These are synthetic settings rows: they render in the admin settings UI but
// persist to the per-repo orchestrator.db (via the project-db accessor), NOT to
// the account.db settings catalog. The password row is masked and never shown.
export const PROJECT_DB_SETTING_KEYS = new Set([
  "project_db_enabled",
  "project_db_type",
  "project_db_permissions",
  "project_db_database",
  "project_db_host",
  "project_db_port",
  "project_db_username",
  "project_db_password",
]);
export const PROJECT_DB_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: "sqlite", label: "sqlite" }),
  Object.freeze({ value: "postgres", label: "postgres" }),
  Object.freeze({ value: "mysql", label: "mysql" }),
]);
export const PROJECT_DB_PERMISSION_OPTIONS = Object.freeze([
  Object.freeze({ value: "read", label: "read (SELECT)" }),
  Object.freeze({ value: "write", label: "write (UPDATE)" }),
  Object.freeze({ value: "insert", label: "insert (INSERT)" }),
  Object.freeze({ value: "delete", label: "delete (DELETE)" }),
  Object.freeze({ value: "create", label: "create (CREATE)" }),
  Object.freeze({ value: "alter", label: "alter (ALTER)" }),
]);

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
  "mcp_oauth_signing_key",
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

// ── Admin settings panes & groups ───────────────────────────────────────────
//
// The admin TUI settings tab is split into broad panes (switched with ←/→).
// Each group below belongs to exactly one pane and renders its `keys`
// (display-keys, matching what the settings snapshot returns) in the listed
// order. Any catalog key not mentioned here lands in a "Misc" group — in the
// Debug pane when it's a tuning key, otherwise in General — so newly-added
// settings stay visible until they're explicitly placed.
export const SETTINGS_PANES = Object.freeze([
  Object.freeze({ id: "providers", label: "Providers" }),
  Object.freeze({ id: "atlas", label: "ATLAS" }),
  Object.freeze({ id: "general", label: "General" }),
  Object.freeze({ id: "repo", label: "Repo" }),
  Object.freeze({ id: "debug", label: "Debug" }),
]);

// Catalog keys whose rows persist per-repo rather than machine-global. They
// render on the Repo pane so operators can tell at a glance which knobs follow
// the repository and which follow the account.
export const REPO_SCOPED_DISPLAY_KEYS = new Set(
  SETTINGS_CATALOG
    .filter((entry) => entry.scope === "repo")
    .map((entry) => entry.key),
);

export const SETTINGS_GROUPS = Object.freeze([
  // ── Providers pane ──
  {
    id: "budgets",
    pane: "providers",
    label: "budgets & account limits",
    keys: Object.freeze([
      "openai_account_limit_tokens_session",
      "openai_account_limit_tokens_week",
      "openai_daily_budget_usd",
      "grok_daily_budget_usd",
    ]),
  },
  // ── ATLAS pane ──
  {
    id: "atlas",
    pane: "atlas",
    label: "ATLAS",
    keys: Object.freeze([
      "atlas_v2",
      "atlas_scip_mode",
      "atlas_scip_languages",
      "atlas_scip_restage_policy",
      "atlas_phases",
      "atlas_live_funnel",
      "atlas_live_index",
      "atlas_memory_surface",
      "atlas_semantic_enabled",
      "atlas_reindex_on_commit",
      "atlas_tool_gate_enabled",
    ]),
  },
  {
    id: "atlas_advanced",
    pane: "atlas",
    label: "ATLAS advanced",
    keys: Object.freeze([
      "atlas_scip_index_command",
      "atlas_scip_index_args",
      "atlas_scip_index_timeout_ms",
      "atlas_scip_cold_index_timeout_ms",
      "atlas_scip_max_age_hours",
      "atlas_auto_feedback",
      "atlas_live_buffers",
      "posse_kaizen_to_atlas",
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
      "atlas_embedding_threads",
      "atlas_wi_embeddings",
      "atlas_remote_encoder_mode",
      "atlas_remote_encoder_url",
      "atlas_remote_encoder_model",
      "atlas_remote_encoder_dim",
      "atlas_boot_reindex_policy",
      "atlas_v2_boot_soft_timeout_ms",
      "atlas_drift_check",
      "atlas_handoff_prefetch_timeout_ms",
      "git_atlas_post_commit_hook_timeout_ms",
    ]),
  },
  // ── General pane ──
  {
    id: "scheduler",
    pane: "general",
    label: "scheduler & branches",
    keys: Object.freeze([
      "scheduler_concurrency",
      "startup_dirty_tree_policy",
      "session_recycle_mode",
    ]),
  },
  {
    id: "behaviors",
    pane: "general",
    label: "behaviors & safety hooks",
    keys: Object.freeze([
      "auto_merge_completed",
      "plan_approval_mode",
      "web_tools_enabled",
      "claude_execution_mode",
      "codex_auth_mode",
      "pre_assess_cmd",
      "pre_push_verify_cmd",
    ]),
  },
  {
    id: "remote",
    pane: "general",
    label: "file requests",
    keys: Object.freeze([
      "file_request_low_risk_extensions",
    ]),
  },
  {
    id: "planner",
    pane: "general",
    label: "skills",
    keys: Object.freeze([
      "skills_enabled",
      "skills_disabled_ids",
    ]),
  },
  // ── Repo pane (rows persist per-repo, not as machine-global account state) ──
  {
    id: "repo_git",
    pane: "repo",
    label: "git & merge",
    keys: Object.freeze([
      "target_branch",
    ]),
  },
  {
    id: "bridge",
    pane: "repo",
    label: "local bridge",
    keys: Object.freeze([
      "bridge_port",
      "bridge_label",
    ]),
  },
  // ── Debug pane ──
  {
    id: "scheduler_tuning",
    pane: "debug",
    label: "scheduler tuning",
    keys: Object.freeze([
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
    ]),
  },
  {
    id: "hook_overrides",
    pane: "debug",
    label: "hook & worktree overrides",
    keys: Object.freeze([
      "skip_hooks",
      "skip_hook_secrets_scan",
      "skip_hook_post_dev_verify",
      "skip_hook_pre_push_gate",
      "worktree_clean_ignored",
      "research_fanout",
      "fix_scope_handoff_guard",
    ]),
  },
  {
    id: "snapshots",
    pane: "debug",
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
    pane: "debug",
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
    pane: "debug",
    label: "handoff & context",
    keys: Object.freeze([
      "handoff_max_prompt_chars",
      "handoff_max_context_chars",
      "handoff_preload_editable_file_bodies",
      "handoff_max_file_bytes",
      "handoff_max_preload_total_bytes",
      "handoff_max_related_files_total_bytes",
      "posse_remote_timeout_ms",
      "context_expand_max_steps",
      "context_expand_file_budget_per_attempt",
    ]),
  },
  {
    id: "planner_turns",
    pane: "debug",
    label: "planner & per-role caps",
    keys: Object.freeze([
      "planner_max_tasks",
      "planner_under_scoped_broad_gate",
      "base_turns_researcher",
      "base_turns_planner",
      "base_turns_dev",
      "base_turns_assessor",
      "max_output_tokens_researcher",
      "max_output_tokens_planner",
      "max_output_tokens_dev",
      "max_output_tokens_artificer",
      "max_output_tokens_assessor",
      "max_output_tokens_preflight",
      "max_output_tokens_delegator",
    ]),
  },
  {
    id: "usage_polling",
    pane: "debug",
    label: "usage polling",
    keys: Object.freeze([
      "claude_usage_cache_ms",
      "claude_usage_backoff_ms",
      "codex_usage_cache_ms",
      "codex_usage_backoff_ms",
    ]),
  },
  {
    id: "limits_logging",
    pane: "debug",
    label: "limits & logging",
    keys: Object.freeze([
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
  "max_output_tokens_researcher",
  "max_output_tokens_planner",
  "max_output_tokens_dev",
  "max_output_tokens_artificer",
  "max_output_tokens_assessor",
  "max_output_tokens_preflight",
  "max_output_tokens_delegator",
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

// Pane an editable DB-backed setting renders under. Ungrouped keys fall back
// to Repo when the catalog scopes them per-repo, to Debug when they're tuning
// knobs, otherwise General, so new catalog keys stay visible until they're
// explicitly slotted into SETTINGS_GROUPS.
export function settingsPaneForKey(displayKey) {
  const group = settingsGroupForKey(displayKey);
  if (group?.pane) return group.pane;
  if (REPO_SCOPED_DISPLAY_KEYS.has(toStorageSettingKey(displayKey))) return "repo";
  return isTuningSettingKey(displayKey) ? "debug" : "general";
}
