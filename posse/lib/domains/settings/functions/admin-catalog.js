import { ADMIN_SETTING_LABEL_OVERRIDES, ADMIN_SETTING_DESCRIPTION_OVERRIDES, ADMIN_UNSET_VALUE_LABELS, ADMIN_SETTING_UNIT_OVERRIDES, ADMIN_LABEL_WORDS, ADMIN_ROLE_PURPOSES, ADMIN_AGENT_SETTING_SECTIONS, ADMIN_PROVIDER_SETTING_SECTIONS, ADMIN_PROVIDER_CATALOG_SETTING_KEYS, ADMIN_IMAGE_SETTING_SECTIONS, TURN_BASE_KEY_MAP, TURN_BASE_KEY_REVERSE_MAP } from "../../../catalog/admin-settings.js";
export { PROVIDER_SETTING_KEYS, ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS, SKILL_SETTING_PREFIX, PROJECT_DB_TYPE_OPTIONS, PROJECT_DB_PERMISSION_OPTIONS, PROJECT_DB_SETTING_DEFS, PROJECT_DB_SETTING_KEYS, ADMIN_AGENT_SETTING_SECTIONS, ADMIN_PROVIDER_SETTING_SECTIONS, ADMIN_PROVIDER_CATALOG_SETTING_KEYS, ADMIN_IMAGE_SETTING_SECTIONS, ADMIN_CREDENTIAL_SETTING_DEFS, TURN_BASE_KEY_MAP, TURN_BASE_KEY_REVERSE_MAP, SETTINGS_PANES, ADMIN_DEFAULT_SETTINGS_PANE } from "../../../catalog/admin-settings.js";
import { PLANNER_DISPATCH_SETTING_KEYS, PLANNER_DISPATCH_MODES } from "../../../catalog/planner-dispatch.js";
import { PROVIDER_ROLE_NAMES } from "../../providers/functions/roles.js";
import { SETTINGS_CATALOG, getCatalogNumericRule, getCatalogOptions, getCatalogRuntimeFallback, isCatalogBooleanSetting } from "./catalog.js";














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
  ...ATLAS_LOCKED_SETTING_KEYS,
]);

export function toDisplaySettingKey(settingKey = "") {
  return TURN_BASE_KEY_MAP[settingKey] || settingKey;
}

export function toStorageSettingKey(settingKey = "") {
  return TURN_BASE_KEY_REVERSE_MAP[settingKey] || settingKey;
}





function adminSettingUnit(storageKey = "") {
  if (ADMIN_SETTING_UNIT_OVERRIDES[storageKey]) return ADMIN_SETTING_UNIT_OVERRIDES[storageKey];
  if (/_ms$/.test(storageKey)) return "ms";
  if (/_(sec|seconds)$/.test(storageKey)) return "sec";
  return null;
}

function formatDurationHint(totalSeconds) {
  if (!(totalSeconds >= 60)) return null;
  const units = [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]];
  let remaining = Math.round(totalSeconds);
  const parts = [];
  for (const [suffix, size] of units) {
    if (remaining < size) continue;
    const count = Math.floor(remaining / size);
    remaining -= count * size;
    parts.push(`${count}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

function formatBytesHint(bytes) {
  if (!(bytes >= 1024)) return null;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Human hint for a raw numeric setting value ("600" → "10m" for a seconds
 * setting). Returns null when no hint adds information.
 */
export function adminSettingValueHint(settingKey = "", value = "") {
  const storageKey = toStorageSettingKey(settingKey);
  const unit = adminSettingUnit(storageKey);
  const text = String(value ?? "").trim();
  if (!unit || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (unit === "ms") return formatDurationHint(number / 1000);
  if (unit === "sec") return formatDurationHint(number);
  if (unit === "bytes") return formatBytesHint(number);
  return null;
}

/**
 * What an empty stored value means at runtime, or null when there is no
 * meaningful default to show.
 */
export function adminUnsetValueLabel(settingKey = "") {
  const displayKey = toDisplaySettingKey(settingKey);
  const storageKey = toStorageSettingKey(displayKey);
  const fallback = getCatalogRuntimeFallback(storageKey);
  if (fallback != null) return fallback;
  if (ADMIN_UNSET_VALUE_LABELS[storageKey]) return ADMIN_UNSET_VALUE_LABELS[storageKey];
  if (/^provider_/.test(storageKey)) return "claude";
  if (/_model_(cheap|standard|strong)$|_image_model$/.test(storageKey)) return "catalog default";
  if (/^(max_turns|max_output_tokens)_/.test(storageKey)) return "auto (per provider)";
  if (/_budget_(usd|pct_session)$/.test(storageKey)) return "no budget";
  if (/_limit_tokens_(session|week)$/.test(storageKey)) return "no limit";
  if (/^project_db_/.test(storageKey)) return "not set";
  return null;
}

/**
 * Display text for a setting value: the stored value (with a unit hint for raw
 * durations and sizes), or what a blank value means at runtime.
 */
export function formatAdminSettingValue(settingKey = "", value = null) {
  const stored = value == null ? "" : String(value);
  const text = stored.trim() === "" ? adminUnsetValueLabel(settingKey) : stored;
  if (!text) return "not set";
  const option = ENUM_SETTING_OPTIONS[toStorageSettingKey(settingKey)]
    ?.find((candidate) => candidate.value === text.trim().toLowerCase());
  if (option) return option.label;
  const hint = adminSettingValueHint(settingKey, text);
  return hint ? `${text} (${hint})` : text;
}


function titleCaseLabel(value = "") {
  if (!value) return "Setting";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function roleLabel(role = "") {
  if (role === "dev") return "Developer";
  return titleCaseLabel(role);
}


function roleNoun(role = "") {
  return role === "dev" ? "developer" : role;
}

function roleSettingDescription(displayKey) {
  const provider = displayKey.match(/^provider_(.+)$/);
  if (provider) {
    const role = provider[1];
    const purpose = ADMIN_ROLE_PURPOSES[role] ? `, which ${ADMIN_ROLE_PURPOSES[role]}` : "";
    return `Provider that runs ${roleNoun(role)} jobs${purpose}. Pick more than one to share jobs between them; Posse skips providers that are not ready or are rate-limited.`;
  }
  const tier = displayKey.match(/^model_tier_(.+)$/);
  if (tier) {
    return `Default model size for ${roleNoun(tier[1])} jobs: cheap, standard, or strong. The Providers tab maps each tier to a model. Deep-think jobs step up from here, and per-job choices still win.`;
  }
  const effort = displayKey.match(/^reasoning_effort_(.+)$/);
  if (effort) {
    return `Default reasoning effort for ${roleNoun(effort[1])} jobs: low, medium, or high. Higher effort thinks longer and costs more. Deep-think jobs step up from here, and per-job choices still win.`;
  }
  const turns = displayKey.match(/^base_turns_(.+)$/);
  if (turns) {
    return `Starting turn budget for ${roleNoun(turns[1])} calls. Posse scales it by task size and model tier; blank uses each provider's built-in budget.`;
  }
  const output = displayKey.match(/^max_output_tokens_(.+)$/);
  if (output) {
    return `Most tokens one ${roleNoun(output[1])} response may produce. Blank uses each provider's built-in cap for the role.`;
  }
  return null;
}

function modelSettingPresentation(displayKey) {
  const tierModel = displayKey.match(/^([a-z0-9-]+)_model_(cheap|standard|strong)$/);
  if (tierModel) {
    return {
      description: `Model Posse runs on this provider when a role asks for the ${tierModel[2]} tier.`,
    };
  }
  const imageModel = displayKey.match(/^([a-z0-9-]+)_image_model$/);
  if (imageModel) {
    return { description: "Model this provider uses to generate image artifacts." };
  }
  return null;
}

export function humanizeSettingKey(settingKey = "") {
  const displayKey = toDisplaySettingKey(settingKey);
  const roleBaseTurns = displayKey.match(/^base_turns_(.+)$/);
  if (roleBaseTurns) return `${roleLabel(roleBaseTurns[1])} base turns`;
  const roleOutputTokens = displayKey.match(/^max_output_tokens_(.+)$/);
  if (roleOutputTokens) return `${roleLabel(roleOutputTokens[1])} output token limit`;
  const roleReasoningEffort = displayKey.match(/^reasoning_effort_(.+)$/);
  if (roleReasoningEffort) return `${roleLabel(roleReasoningEffort[1])} reasoning`;
  const roleModelTier = displayKey.match(/^model_tier_(.+)$/);
  if (roleModelTier) return `${roleLabel(roleModelTier[1])} model tier`;
  const roleProviders = displayKey.match(/^provider_(.+)$/);
  if (roleProviders) return `${roleLabel(roleProviders[1])} provider`;

  const words = displayKey
    .split("_")
    .filter(Boolean);
  if (words[0] === "posse") words.shift();
  const rendered = words.map((word) => ADMIN_LABEL_WORDS[word] || word).join(" ");
  return titleCaseLabel(rendered);
}

const SETTINGS_CATALOG_BY_KEY = new Map(SETTINGS_CATALOG.map((entry) => [entry.key, entry]));

export function getAdminSettingPresentation(settingKey = "", entry = null) {
  const displayKey = toDisplaySettingKey(settingKey);
  const storageKey = toStorageSettingKey(displayKey);
  const catalogEntry = SETTINGS_CATALOG_BY_KEY.get(storageKey);
  const label = entry?.label
    || ADMIN_SETTING_LABEL_OVERRIDES[displayKey]
    || catalogEntry?.label
    || humanizeSettingKey(displayKey);
  const description = ADMIN_SETTING_DESCRIPTION_OVERRIDES[displayKey]
    || roleSettingDescription(displayKey)
    || modelSettingPresentation(displayKey)?.description
    || entry?.adminDescription
    || entry?.description
    || catalogEntry?.adminDescription
    || catalogEntry?.description
    || `Controls ${label.toLowerCase()}.`;
  return { label, description };
}



// Catalog keys whose rows persist per-repo rather than machine-global.
export const REPO_SCOPED_DISPLAY_KEYS = new Set(
  SETTINGS_CATALOG
    .filter((entry) => entry.scope === "repo")
    .map((entry) => entry.key),
);

const PLANNER_DISPATCH_TUNING_KEYS = Object.freeze(
  PLANNER_DISPATCH_SETTING_KEYS.filter((key) => key !== "planner_dispatch_mode"),
);

const group = (id, pane, label, keys, hint = null) => Object.freeze({
  id,
  pane,
  label,
  ...(hint ? { hint } : {}),
  keys: Object.freeze([...keys]),
});

export const SETTINGS_GROUPS = Object.freeze([
  // ── General ──
  group("workflow", "general", "Workflow", [
    "plan_approval_mode",
    "auto_merge_completed",
    "scheduler_concurrency",
    "scheduler_max_active_worktrees",
    "scheduler_implementation_reserved_slots",
    "startup_dirty_tree_policy",
    "session_recycle_mode",
    "web_tools_enabled",
  ]),
  group("safety", "general", "Approvals & Safety", [
    "scope_auto_approval",
    "fix_scope_handoff_guard",
    "file_request_low_risk_extensions",
    "posse_log_scrub_secrets",
  ]),
  group("limits", "general", "Limits & Retries", [
    "default_max_attempts",
    "posse_wi_failure_threshold",
    "posse_max_fix_chain_depth",
    "posse_max_replans",
    "posse_max_file_request_depth",
    "stall_timeout",
    "max_job_runtime_sec",
    "runtime_write_grace_sec",
    "runtime_write_ceiling_multiplier",
    "headless_human_timeout_sec",
  ]),
  group("skills", "general", "Skills", [
    "skills_enabled",
    "skills_disabled_ids",
  ]),
  group("storage", "general", "Logs & Storage", [
    "posse_log_level",
    "posse_retention_days",
    "snapshot_retention_days",
    "snapshot_max_bytes",
    "snapshot_max_refs",
  ]),
  // ── Agents (provider rows are specialized; see ADMIN_AGENT_SETTING_SECTIONS) ──
  ...ADMIN_AGENT_SETTING_SECTIONS.map((section) => group(
    `agent_${section.role}`,
    "agents",
    section.label,
    section.keys,
    section.hint || null,
  )),
  // ── Providers (model rows are specialized; see ADMIN_PROVIDER_SETTING_SECTIONS) ──
  ...ADMIN_PROVIDER_SETTING_SECTIONS
    .filter((section) => section.settingKeys.length > 0)
    .map((section) => group(
      section.provider === "posse-local" ? "provider_local_models" : `provider_${section.provider}`,
      "providers",
      section.label,
      section.settingKeys,
    )),
  ...ADMIN_IMAGE_SETTING_SECTIONS.map((section) => group(
    `image_${section.provider}`,
    "providers",
    `${section.label} Images`,
    section.settingKeys,
  )),
  group("provider_catalog", "providers", "Model Catalog", ADMIN_PROVIDER_CATALOG_SETTING_KEYS),
  // ── ATLAS ──
  group("atlas_core", "atlas", "Core", [
    "atlas_v2",
    "atlas_phases",
    "atlas_live_funnel",
    "atlas_live_index",
    "atlas_memory_mode",
  ]),
  group("atlas_indexing", "atlas", "Indexing", [
    "atlas_scip_mode",
    "atlas_scip_languages",
    "atlas_boot_reindex_policy",
    "atlas_reindex_on_commit",
    "atlas_scip_restage_policy",
    "atlas_embedding_model_id",
    "atlas_tree_compression_mode",
  ]),
  // ── Repository (rows persist per-repo, not as machine-global account state) ──
  group("repo_git", "repo", "Git", [
    "target_branch",
    "git_commit_style",
    "db_task_pre_merge_policy",
  ]),
  group("repo_verification", "repo", "Verification", [
    "canonical_verify_cmd",
    "verification_wall_timeout_ms",
    "verification_idle_timeout_ms",
    "verification_dependency_network_policy",
    "pre_dev_typecheck",
    "final_review_mode",
  ]),
  group("bridge", "repo", "Phone Bridge", [
    "bridge_port",
    "bridge_label",
  ]),
  // ── Debug ──
  group("debug_atlas_levers", "debug", "ATLAS Token Levers", [
    "atlas_answer_contract_tight",
    "atlas_search_result_paging",
    "atlas_result_ref_paging",
    "atlas_result_ref_paging_min_chars",
    "atlas_prefetch_entrypoint_rank",
    "atlas_handoff_prefetch",
    "atlas_survey_brief_edge_count",
    "atlas_survey_edge_cap",
    "atlas_gate_nudge",
    "atlas_gateway_dedup_advertise",
    "atlas_prose_dedup",
    "atlas_code_lens_callable",
    "atlas_view_layer_merge",
    "atlas_compact_structure_dev_assessor",
  ], "rollback switches; defaults are the adopted behavior"),
  group("debug_tool_ablation", "debug", "Tool Ablation", [
    "atlas_tools_disabled",
    "agent_tools_disabled",
  ], "testing: hide tools from new agent sessions"),
  group("debug_experiments", "debug", "Experiments", [
    "context_compaction_mode",
    "context_compaction_trigger_input_tokens",
    "context_compaction_session_reset_input_tokens",
    "context_compaction_recent_target_tokens",
    "research_fanout",
    "research_evidence_reuse",
    "research_claim_review",
    "research_traversal_completion_check",
    "research_traversal_completion_max_chars",
    "research_synthesis_max_physical_calls",
    "research_budget_visibility",
    "assessment_scope_mode",
    "assessment_scope_max_group_jobs",
    "assessment_scope_max_group_chars",
    "atlas_shadow_guardrails",
    "atlas_ambient_ref_stamping",
    "scheduler_shadow_conflict_metrics",
  ], "shadow modes record telemetry only"),
  group("debug_waiting_lanes", "debug", "Waiting Lanes", [
    "waiting_lane_shadow_mode",
    "waiting_lane_git_preparation_enabled",
    "waiting_lane_atlas_snapshot_enabled",
    "waiting_lane_atlas_catchup_enabled",
    "waiting_lane_activation_enabled",
    "waiting_lane_preparation_concurrency",
    "waiting_lane_max_prepared_lanes",
    "waiting_lane_prepared_ttl_ms",
    "waiting_lane_max_hot_paths",
  ], "experimental ahead-of-time preparation"),
  group("debug_planner_dispatch", "debug", "Planner-Led Intake Tuning", PLANNER_DISPATCH_TUNING_KEYS,
    `applies when Planner-led intake is ${PLANNER_DISPATCH_MODES.PLANNER}`),
  group("debug_agent_limits", "debug", "Agent Turn & Output Limits", [
    ...PROVIDER_ROLE_NAMES.map((role) => `base_turns_${role}`).filter((key) => TURN_BASE_KEY_REVERSE_MAP[key]),
    ...PROVIDER_ROLE_NAMES.map((role) => `max_output_tokens_${role}`),
    "planner_max_tasks",
    "planner_under_scoped_broad_gate",
  ], "blank = provider defaults"),
  group("debug_assessor", "debug", "Assessor Tuning", [
    "assessor_fallback_reads",
    "assessor_fallback_reads_retry_step",
    "assessor_internal_retry_limit",
    "assessor_max_tool_calls",
    "assessor_parse_retry_input_tokens_cap",
  ]),
  group("debug_handoff", "debug", "Handoff & Context Limits", [
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
  group("debug_atlas_internals", "debug", "ATLAS Internals", [
    "atlas_usage_telemetry",
    "atlas_live_buffers",
    "atlas_memory_surface",
    "atlas_drift_check",
    "atlas_auto_feedback",
    "git_atlas_post_commit_hook_timeout_ms",
    "atlas_tree_compression_provider",
    "atlas_tree_compression_model_tier",
    "atlas_tree_compression_max_seeds",
    "atlas_tree_compression_model_max_seeds",
  ]),
  group("debug_scip", "debug", "SCIP Indexer Overrides", [
    "atlas_scip_index_command",
    "atlas_scip_index_args",
    "atlas_scip_index_timeout_ms",
    "atlas_scip_cold_index_timeout_ms",
    "atlas_scip_max_age_hours",
  ]),
  group("debug_scheduler", "debug", "Scheduler Internals", [
    "scheduler_poll_ms",
    "scheduler_repair_poll_ms",
    "default_lease_seconds",
    "worker_lease_renew_max_transient_errors",
    "lease_requeue_grace_sec",
    "worker_provider_circuit_ttl_ms",
    "worktree_lock_wait_ms",
    "session_recycle_strict_provider",
    "posse_session_lease_ttl",
    "human_gate_resnooze_sec",
    "human_gate_max_resurfaces",
    "posse_fanout_child_timeout_sec",
  ]),
  group("debug_hooks", "debug", "Safety Hook Overrides", [
    "skip_hooks",
    "skip_hook_secrets_scan",
    "skip_hook_post_dev_verify",
    "skip_hook_pre_push_gate",
    "worktree_clean_ignored",
    "pre_assess_cmd",
    "pre_push_verify_cmd",
    "verification_wall_timeout_max_ms",
  ], "leave off outside debugging"),
  group("debug_telemetry", "debug", "Telemetry & Polling", [
    "posse_db_telemetry_tail_limit",
    "posse_display_max_events",
    "posse_display_event_rate_limit_per_sec",
    "snapshot_dedup",
    "claude_usage_cache_ms",
    "claude_usage_backoff_ms",
    "codex_usage_cache_ms",
    "codex_usage_backoff_ms",
    "model_catalog_cache_ms",
  ]),
]);

const GROUPED_KEY_SET = new Set(SETTINGS_GROUPS.flatMap((entry) => entry.keys));

export function settingsGroupForKey(displayKey) {
  for (const entry of SETTINGS_GROUPS) {
    if (entry.keys.includes(displayKey)) return entry;
  }
  return null;
}

export function isGroupedSettingKey(displayKey) {
  return GROUPED_KEY_SET.has(displayKey);
}

// Pane an editable DB-backed setting renders under. Ungrouped keys fall back
// to Repository when the catalog scopes them per-repo; everything else falls
// into Debug, so a newly added key stays visible until it is placed.
export function settingsPaneForKey(displayKey) {
  const found = settingsGroupForKey(displayKey);
  if (found?.pane) return found.pane;
  if (REPO_SCOPED_DISPLAY_KEYS.has(toStorageSettingKey(displayKey))) return "repo";
  return "debug";
}

export function isDebugSettingKey(displayKey) {
  return settingsPaneForKey(displayKey) === "debug";
}
