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

export const PROJECT_DB_SETTING_DEFS = Object.freeze([
  Object.freeze({ key: "project_db_enabled", default: "false", valueType: "boolean" }),
  Object.freeze({ key: "project_db_type", default: "", options: PROJECT_DB_TYPE_OPTIONS }),
  Object.freeze({ key: "project_db_permissions", default: "", options: PROJECT_DB_PERMISSION_OPTIONS, multi: true }),
  Object.freeze({ key: "project_db_database", default: "" }),
  Object.freeze({ key: "project_db_host", default: "" }),
  Object.freeze({ key: "project_db_port", default: "", numeric: Object.freeze({ integer: true, min: 0 }) }),
  Object.freeze({ key: "project_db_username", default: "" }),
  Object.freeze({ key: "project_db_password", default: "", sensitive: true }),
]);

// Visual ordering for specialized AdminTUI rows lives beside the ordinary
// settings groups so machine projections and the interactive editor cannot
// silently acquire separate policy tables.
export const ADMIN_AGENT_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ role: "researcher", label: "Researcher", keys: Object.freeze(["base_turns_researcher", "max_output_tokens_researcher"]) }),
  Object.freeze({ role: "planner", label: "Planner", keys: Object.freeze(["base_turns_planner", "max_output_tokens_planner", "planner_max_tasks", "planner_under_scoped_broad_gate"]) }),
  Object.freeze({ role: "dev", label: "Dev", keys: Object.freeze(["base_turns_dev", "max_output_tokens_dev"]) }),
  Object.freeze({ role: "artificer", label: "Artificer", keys: Object.freeze(["max_output_tokens_artificer"]) }),
  Object.freeze({ role: "preflight", label: "Preflight", keys: Object.freeze(["max_output_tokens_preflight"]) }),
  Object.freeze({ role: "assessor", label: "Assessor", keys: Object.freeze(["base_turns_assessor", "max_output_tokens_assessor"]) }),
  Object.freeze({ role: "delegator", label: "Delegator", keys: Object.freeze(["delegation_mode", "max_output_tokens_delegator"]) }),
]);

export const ADMIN_PROVIDER_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ provider: "claude", label: "Claude", budgetKeys: Object.freeze(["claude_run_budget_pct_session"]) }),
  Object.freeze({ provider: "codex", label: "Codex", budgetKeys: Object.freeze(["codex_auth_mode", "codex_run_budget_pct_session"]) }),
  Object.freeze({ provider: "openai", label: "OpenAI", budgetKeys: Object.freeze(["openai_run_budget_usd", "openai_daily_budget_usd", "openai_account_limit_tokens_session", "openai_account_limit_tokens_week"]) }),
  Object.freeze({ provider: "grok", label: "Grok", budgetKeys: Object.freeze(["grok_run_budget_usd", "grok_daily_budget_usd"]) }),
  Object.freeze({ provider: "copilot", label: "Copilot", budgetKeys: Object.freeze([]) }),
  Object.freeze({ provider: "posse-local", label: "Local (Qwen / Gemma)", budgetKeys: Object.freeze([]) }),
]);

export const ADMIN_PROVIDER_CATALOG_SETTING_KEYS = Object.freeze([
  "model_catalog_enforcement",
  "model_catalog_cache_ms",
  "claude_execution_mode",
]);

export const ADMIN_IMAGE_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ provider: "grok", label: "Grok", budgetKeys: Object.freeze(["grok_image_budget_usd"]) }),
  Object.freeze({ provider: "openai", label: "OpenAI", budgetKeys: Object.freeze(["openai_image_budget_usd"]) }),
]);

export const ADMIN_CREDENTIAL_SETTING_DEFS = Object.freeze([
  Object.freeze({ key: "OPENAI_API_KEY", label: "OpenAI API key", description: "OpenAI API credential (environment-managed).", env: "OPENAI_API_KEY" }),
  Object.freeze({ key: "CODEX_API_KEY", label: "Codex API key", description: "Optional Codex CLI API credential (environment-managed).", env: "CODEX_API_KEY" }),
  Object.freeze({ key: "XAI_API_KEY", label: "xAI API key", description: "xAI/Grok API credential (environment-managed).", env: "XAI_API_KEY" }),
  Object.freeze({ key: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude OAuth token", description: "Claude OAuth credential (environment-managed).", env: "CLAUDE_CODE_OAUTH_TOKEN" }),
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
  ...ATLAS_LOCKED_SETTING_KEYS,
]);

export function toDisplaySettingKey(settingKey = "") {
  return TURN_BASE_KEY_MAP[settingKey] || settingKey;
}

export function toStorageSettingKey(settingKey = "") {
  return TURN_BASE_KEY_REVERSE_MAP[settingKey] || settingKey;
}

// Storage keys are intentionally stable machine identifiers. The admin UI
// presents a separate operator-facing label so changing the wording never
// breaks persisted settings, environment overrides, or automation.
const ADMIN_SETTING_LABEL_OVERRIDES = Object.freeze({
  atlas_v2: "ATLAS retrieval",
  atlas_phases: "Enabled ATLAS roles",
  atlas_live_funnel: "Prompt context injection",
  atlas_live_index: "Live edit indexing",
  atlas_live_buffers: "Live edit buffers",
  atlas_memory_surface: "Memory lookups",
  atlas_memory_mode: "ATLAS memory",
  atlas_tool_gate_enabled: "Require ATLAS retrieval first",
  atlas_reindex_on_commit: "Reindex after merges",
  atlas_boot_reindex_policy: "Startup reindex policy",
  atlas_drift_check: "Index drift checks",
  atlas_scip_mode: "SCIP indexing",
  atlas_scip_languages: "SCIP languages",
  atlas_scip_restage_policy: "SCIP refresh policy",
  atlas_embedding_model_id: "Embedding model",
  atlas_tree_compression_mode: "Tree summary mode",
  artifact_image_provider: "Image artifact provider",
  claude_run_budget_pct_session: "Claude run budget (%)",
  codex_auth_mode: "Codex authentication",
  codex_run_budget_pct_session: "Codex run budget (%)",
  openai_run_budget_usd: "OpenAI run budget",
  openai_daily_budget_usd: "OpenAI daily budget",
  openai_account_limit_tokens_session: "OpenAI session token limit",
  openai_account_limit_tokens_week: "OpenAI weekly token limit",
  grok_run_budget_usd: "Grok run budget",
  grok_daily_budget_usd: "Grok daily budget",
  grok_image_budget_usd: "Grok image budget",
  openai_image_budget_usd: "OpenAI image budget",
  scheduler_concurrency: "Concurrent workers",
  scheduler_max_active_worktrees: "Active worktree limit",
  stall_timeout: "Stalled job timeout",
  max_job_runtime_sec: "Job runtime limit",
  headless_human_timeout_sec: "Headless approval timeout",
  default_max_attempts: "Attempts per job",
  auto_merge_completed: "Auto-merge approved work",
  plan_approval_mode: "Require plan approval",
  startup_dirty_tree_policy: "Dirty tree at startup",
  fix_scope_handoff_guard: "Fix scope expansion",
  file_request_low_risk_extensions: "Low-risk file extensions",
  web_tools_enabled: "Web research tools",
  posse_log_scrub_secrets: "Remove secrets from logs",
  session_recycle_mode: "Reuse agent sessions",
  posse_wi_failure_threshold: "Failures before human review",
  posse_max_fix_chain_depth: "Consecutive fix limit",
  posse_max_replans: "Replan limit",
  posse_max_file_request_depth: "File request follow-up limit",
  snapshot_retention_days: "Snapshot retention",
  snapshot_max_bytes: "Snapshot storage limit",
  snapshot_max_refs: "Snapshot count limit",
  snapshot_dedup: "Deduplicate snapshots",
  skills_enabled: "Planner-selected skills",
  skills_disabled_ids: "Disabled skills",
  posse_log_level: "Log level",
  posse_retention_days: "Telemetry retention",
  posse_display_max_events: "Live event history",
  posse_display_event_rate_limit_per_sec: "Live event rate limit",
  target_branch: "Merge target branch",
  git_commit_style: "Commit message style",
  bridge_port: "Bridge port",
  bridge_label: "Bridge name",
  project_db_enabled: "Agent database access",
  project_db_type: "Database type",
  project_db_permissions: "Allowed database operations",
  project_db_database: "Database name or file",
  project_db_host: "Database host",
  project_db_port: "Database port",
  project_db_username: "Database username",
  project_db_password: "Database password",
  planner_max_tasks: "Tasks per plan",
  planner_under_scoped_broad_gate: "Under-scoped plan policy",
  delegation_mode: "Delegation engine",
  model_catalog_enforcement: "Unknown model policy",
  model_catalog_cache_ms: "Model catalog refresh interval",
  claude_execution_mode: "Claude execution mode",
  posse_kaizen_to_atlas: "Kaizen-to-ATLAS promotion (reserved)",
  posse_db_telemetry_tail_limit: "Database telemetry tail",
  atlas_answer_contract_tight: "Compact research answers",
  atlas_search_result_paging: "Page large search results",
  atlas_result_ref_paging: "Page large code results",
  atlas_result_ref_paging_min_chars: "Code result paging threshold",
  atlas_survey_tail_refs: "Survey paging (legacy)",
  atlas_ambient_ref_stamping: "Reusable result references",
  atlas_gate_nudge: "Large-result query suggestions",
  atlas_prefetch_entrypoint_rank: "Prefer entry points during prefetch",
  atlas_survey_brief_edge_count: "Initial survey relationship preview",
  atlas_survey_edge_cap: "Survey relationship limit",
  atlas_gateway_dedup_advertise: "Hide redundant gateway tools",
  atlas_prose_dedup: "Compact repeated policy text",
  atlas_tools_disabled: "Hidden ATLAS actions",
  atlas_code_lens_callable: "Allow code lens tool",
  atlas_view_layer_merge: "Layered ATLAS views",
  atlas_shadow_guardrails: "ATLAS shadow guardrails",
  atlas_auto_feedback: "ATLAS job feedback",
  atlas_tree_compression_provider: "Tree summary provider",
  atlas_tree_compression_model_tier: "Tree summary model tier",
  atlas_tree_compression_max_seeds: "Stored tree summary seeds",
  atlas_tree_compression_model_max_seeds: "Model tree summary seeds",
  git_atlas_post_commit_hook_timeout_ms: "Post-commit reindex timeout",
  atlas_scip_index_command: "Custom SCIP index command",
  atlas_scip_index_args: "Custom SCIP index arguments",
  atlas_scip_index_timeout_ms: "SCIP index timeout",
  atlas_scip_cold_index_timeout_ms: "First SCIP index timeout",
  atlas_scip_max_age_hours: "SCIP index maximum age",
  context_compaction_mode: "Rolling context experiment",
  context_compaction_trigger_input_tokens: "Context pressure threshold",
  context_compaction_session_reset_input_tokens: "Session reset threshold",
  context_compaction_recent_target_tokens: "Recent context target",
  research_fanout: "Parallel research",
  research_traversal_completion_check: "Traversal completion check",
  research_traversal_completion_max_chars: "Traversal check text limit",
  scheduler_poll_ms: "Scheduler poll interval",
  scheduler_repair_poll_ms: "Scheduler repair interval",
  default_lease_seconds: "Job lease duration",
  worker_lease_renew_max_transient_errors: "Lease renewal error limit",
  lease_requeue_grace_sec: "Expired lease grace period",
  worker_provider_circuit_ttl_ms: "Provider failure cooldown",
  worktree_lock_wait_ms: "Worktree lock wait",
  scheduler_shadow_conflict_metrics: "Shadow conflict metrics",
  session_recycle_strict_provider: "Reset sessions on provider change",
  posse_session_lease_ttl: "Reused session lease duration",
  worktree_clean_ignored: "Clean ignored worktree files",
  skip_hooks: "Skip all safety hooks",
  skip_hook_secrets_scan: "Skip secret scanning",
  skip_hook_post_dev_verify: "Skip developer verification",
  skip_hook_pre_push_gate: "Skip pre-push checks",
  pre_assess_cmd: "Command before assessment",
  pre_push_verify_cmd: "Command before push",
  assessor_fallback_reads: "Assessor fallback reads",
  assessor_fallback_reads_retry_step: "Extra reads per retry",
  assessor_internal_retry_limit: "Assessment retry limit",
  assessor_parse_retry_input_tokens_cap: "Parse retry token limit",
  handoff_max_prompt_chars: "Handoff prompt size limit",
  handoff_max_context_chars: "Handoff context size limit",
  handoff_preload_editable_file_bodies: "Preload editable files",
  handoff_max_file_bytes: "Single handoff file limit",
  handoff_max_preload_total_bytes: "Editable preload limit",
  handoff_max_related_files_total_bytes: "Related file preload limit",
  posse_remote_timeout_ms: "Remote prompt timeout",
  context_expand_max_steps: "Missing-context retry limit",
  context_expand_file_budget_per_attempt: "Files added per context retry",
  claude_usage_cache_ms: "Claude usage refresh interval",
  claude_usage_backoff_ms: "Claude usage retry delay",
  codex_usage_cache_ms: "Codex usage refresh interval",
  codex_usage_backoff_ms: "Codex usage retry delay",
  posse_fanout_child_timeout_sec: "Research child queue timeout",
});

const ADMIN_SETTING_DESCRIPTION_OVERRIDES = Object.freeze({
  atlas_v2: "Use ATLAS for code search and context. Turn it off only when ATLAS is unavailable.",
  atlas_phases: "Choose which agent roles receive ATLAS context.",
  atlas_live_funnel: "Add ATLAS search results and code context to agent prompts.",
  atlas_live_index: "Let running jobs search edits that have not been merged yet.",
  atlas_live_buffers: "Send developer write and edit buffers to the live ATLAS index.",
  atlas_memory_surface: "Look for saved ATLAS memory attached to relevant files and symbols.",
  atlas_memory_mode: "Enable ATLAS memory lookup, tools, prompts, and saved memory.",
  atlas_tool_gate_enabled: "Require agents to try ATLAS before using general file and search tools.",
  atlas_reindex_on_commit: "Update the ATLAS index after Posse merges a commit.",
  atlas_boot_reindex_policy: "Choose when startup refreshes the ATLAS index: always, only when missing, or when needed.",
  atlas_drift_check: "Periodically check whether the ATLAS index still matches the current commit.",
  atlas_scip_mode: "Use SCIP symbol indexes during ATLAS startup and search.",
  atlas_scip_languages: "Choose which languages get SCIP indexing and scoped lint support. Saving may install managed indexers.",
  atlas_scip_restage_policy: "Choose when existing SCIP indexes are rebuilt.",
  atlas_embedding_model_id: "Choose the local model ATLAS uses to find code with similar meaning.",
  atlas_tree_compression_mode: "Choose how ATLAS builds compact repository summaries: off, deterministic, or model-assisted.",
  scheduler_concurrency: "Number of worker jobs Posse may run at the same time when no command-line override is provided.",
  scheduler_max_active_worktrees: "Optional cap on work-item worktrees running at the same time. Leave blank for no separate cap.",
  stall_timeout: "Stop a job after this many seconds without progress. Leave blank for 600 seconds.",
  max_job_runtime_sec: "Stop any job that exceeds this total runtime. Leave blank to use twice the stalled-job timeout.",
  headless_human_timeout_sec: "How long a non-interactive run waits for required human input before timing out.",
  default_max_attempts: "How many times a job may be attempted before its normal failure handling begins.",
  auto_merge_completed: "Merge work automatically after it passes assessment.",
  plan_approval_mode: "Pause for human approval before a generated plan starts running.",
  startup_dirty_tree_policy: "Choose whether startup blocks on uncommitted changes or commits them before work begins.",
  fix_scope_handoff_guard: "Controls fixes that name existing files outside their approved scope. Auto/warn adds those files; enforce blocks the handoff; off ignores them.",
  file_request_low_risk_extensions: "Extra file extensions developers may request without high-risk approval. Protected, package, and CI paths stay high risk.",
  web_tools_enabled: "Allow researcher and artificer agents to use configured web search and page-fetch tools.",
  posse_log_scrub_secrets: "Hide values that look like secrets before prompts and model output are written to logs.",
  session_recycle_mode: "Reuse compatible agent sessions between jobs: off, developer fixes only, or all supported jobs.",
  posse_wi_failure_threshold: "Send a work item for human review after this many failed developer or fix jobs.",
  posse_max_fix_chain_depth: "Send a work item for human review after this many fixes in a row.",
  posse_max_replans: "Send a work item for human review after this many requests for a new plan.",
  posse_max_file_request_depth: "Maximum number of follow-up rounds allowed while approving a developer's file request.",
  snapshot_retention_days: "Number of days to keep recoverable snapshots of uncommitted work.",
  snapshot_max_bytes: "Maximum total disk space used by recoverable snapshots, in bytes.",
  snapshot_max_refs: "Maximum number of recoverable snapshot references to keep.",
  snapshot_dedup: "Reuse an existing snapshot when the uncommitted work is identical.",
  skills_enabled: "Allow the planner to attach relevant skills to developer jobs.",
  skills_disabled_ids: "Skills disabled by an administrator. Newly installed skills remain enabled unless listed here.",
  posse_log_level: "Lowest severity written to the runtime log: debug, info, warn, or error.",
  posse_retention_days: "Days to keep runtime telemetry in the database. Set to 0 to keep it indefinitely.",
  posse_display_max_events: "Maximum number of recent events retained by the live terminal display.",
  posse_display_event_rate_limit_per_sec: "Event rate at which the terminal starts dropping display-only updates to remain responsive.",
  target_branch: "Branch completed work merges into. Leave blank to detect the repository's default branch.",
  git_commit_style: "Choose plain subjects, Conventional Commits, or Conventional Commits with Gitmoji.",
  bridge_port: "Local port used by this repository's Posse bridge. Leave blank to choose an available port starting at 7531.",
  bridge_label: "Optional name used to identify this repository's local bridge.",
  project_db_enabled: "Allow agents to query the project database using the permissions below.",
  project_db_type: "Database engine used by this repository: SQLite, PostgreSQL, or MySQL.",
  project_db_permissions: "Database operations agents may use. Read-only roles can still only read.",
  project_db_database: "SQLite file path relative to the repository, or the PostgreSQL/MySQL database name.",
  project_db_host: "Host name for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_port: "Port for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_username: "Username for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_password: "Password for PostgreSQL or MySQL. It is stored securely and never displayed; leave blank to keep it unchanged, or clear it to remove it.",
  planner_max_tasks: "Maximum number of tasks the planner may place in one plan.",
  planner_under_scoped_broad_gate: "Choose whether broad plans with too little file scope are allowed, warned about, or rejected.",
  delegation_mode: "Choose whether delegation is handled by deterministic code or a model.",
  atlas_answer_contract_tight: "Use shorter, citation-focused research answers. Turn off to restore the standard research response format.",
  atlas_search_result_paging: "Keep large symbol-search results compact and make the remaining results available on demand.",
  atlas_result_ref_paging: "Keep large code-window and code-lens results compact and make the remaining content available on demand.",
  atlas_result_ref_paging_min_chars: "Result size, in characters, at which code-window and code-lens paging begins.",
  atlas_survey_tail_refs: "Legacy compatibility key. Large code surveys are now always stored as stable ten-file cursor pages.",
  atlas_ambient_ref_stamping: "Make more ATLAS results available through reusable result references. This is an experiment.",
  atlas_gate_nudge: "Suggest a narrower ATLAS query when a result becomes too large. This is an experiment.",
  atlas_prefetch_entrypoint_rank: "Prefer likely entry points and heavily imported files during ATLAS prefetch. Turn off for the older ranking.",
  atlas_survey_brief_edge_count: "Number of ranked relationship edges shown in the initial code-survey handoff. Larger previews remain navigation hints; exact sites stay in the retained survey pages.",
  atlas_survey_edge_cap: "Maximum total relationship rows returned by a code survey. Set to 0 to use the normal per-section limits.",
  atlas_gateway_dedup_advertise: "Hide redundant ATLAS gateway wrappers when their individual tools are already available. Turn off for the older tool list.",
  atlas_prose_dedup: "Use the shorter copy of repeated ATLAS policy text. Turn off to restore the older full text in every role prompt.",
  atlas_tools_disabled: "Comma-separated ATLAS actions to hide from new agent sessions. Leave blank to expose all normal actions.",
  atlas_code_lens_callable: "Allow agents to call code lens directly. Turning it off does not remove internal code-lens support.",
  atlas_view_layer_merge: "Build ATLAS views from the current per-source symbol layers. Turn off only to use the legacy flat-table fallback.",
  atlas_shadow_guardrails: "Collect diagnostic ATLAS guardrail results without changing agent behavior.",
  context_compaction_mode: "Controls the unfinished rolling-context experiment. Shadow records estimates; other active modes are experimental.",
  context_compaction_trigger_input_tokens: "Input-token level at which rolling-context shadow measurements begin.",
  context_compaction_session_reset_input_tokens: "Resumed-session input-token level used to model a future context reset.",
  context_compaction_recent_target_tokens: "Amount of the most recent conversation the rolling-context estimate tries to keep unchanged.",
  research_fanout: "Controls parallel research fanout: off, telemetry-only shadow mode, or active.",
  research_traversal_completion_check: "Controls the experimental check for incomplete code traversal before a researcher or developer hands off.",
  research_traversal_completion_max_chars: "Maximum amount of traversal-check guidance added to a researcher or developer handoff.",
  posse_kaizen_to_atlas: "Reserved for a retired integration path. It currently has no effect.",
});

const ADMIN_LABEL_WORDS = Object.freeze({
  api: "API",
  atlas: "ATLAS",
  db: "database",
  dev: "developer",
  id: "ID",
  ids: "IDs",
  jwt: "JWT",
  max: "maximum",
  mcp: "MCP",
  ml: "ML",
  ms: "milliseconds",
  onnx: "ONNX",
  openai: "OpenAI",
  pct: "percent",
  scip: "SCIP",
  sec: "seconds",
  ttl: "retention time",
  ui: "UI",
  usd: "USD",
  v2: "v2",
  wi: "work item",
});

function titleCaseLabel(value = "") {
  if (!value) return "Setting";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function roleLabel(role = "") {
  if (role === "dev") return "Developer";
  return titleCaseLabel(role);
}

export function humanizeSettingKey(settingKey = "") {
  const displayKey = toDisplaySettingKey(settingKey);
  const roleBaseTurns = displayKey.match(/^base_turns_(.+)$/);
  if (roleBaseTurns) return `${roleLabel(roleBaseTurns[1])} base turns`;
  const roleOutputTokens = displayKey.match(/^max_output_tokens_(.+)$/);
  if (roleOutputTokens) return `${roleLabel(roleOutputTokens[1])} output token limit`;
  const roleProviders = displayKey.match(/^provider_(.+)$/);
  if (roleProviders) return `${roleLabel(roleProviders[1])} providers`;

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
    || entry?.adminDescription
    || entry?.description
    || catalogEntry?.adminDescription
    || catalogEntry?.description
    || `Controls ${label.toLowerCase()}.`;
  return { label, description };
}

// ── Admin settings panes & groups ───────────────────────────────────────────
//
// The admin TUI settings tab is split into broad panes (switched with ←/→).
// Each group below belongs to exactly one pane and renders its `keys`
// (display-keys, matching what the settings snapshot returns) in the listed
// order. Any catalog key not mentioned here lands in a "Misc" group on the
// Debug pane, so newly-added settings stay visible until they're intentionally
// promoted into an operator-facing section.
export const SETTINGS_PANES = Object.freeze([
  Object.freeze({ id: "atlas", label: "ATLAS" }),
  Object.freeze({ id: "agents", label: "Agents" }),
  Object.freeze({ id: "providers", label: "Providers" }),
  Object.freeze({ id: "images", label: "Images" }),
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
  // ── ATLAS pane ──
  {
    id: "atlas_core",
    pane: "atlas",
    label: "Core",
    keys: Object.freeze([
      "atlas_v2",
      "atlas_phases",
      "atlas_live_funnel",
      "atlas_live_index",
      "atlas_live_buffers",
      "atlas_memory_surface",
      "atlas_memory_mode",
      "atlas_tool_gate_enabled",
    ]),
  },
  {
    id: "atlas_indexing",
    pane: "atlas",
    label: "Index Updates",
    keys: Object.freeze([
      "atlas_reindex_on_commit",
      "atlas_boot_reindex_policy",
      "atlas_drift_check",
    ]),
  },
  {
    id: "atlas_scip",
    pane: "atlas",
    label: "SCIP",
    keys: Object.freeze([
      "atlas_scip_mode",
      "atlas_scip_languages",
      "atlas_scip_restage_policy",
    ]),
  },
  {
    id: "atlas_search",
    pane: "atlas",
    label: "Search & Encoding",
    keys: Object.freeze([
      "atlas_embedding_model_id",
      "atlas_tree_compression_mode",
    ]),
  },
  // ── Agents pane ──
  {
    id: "agent_researcher",
    pane: "agents",
    label: "Researcher",
    keys: Object.freeze([
      "base_turns_researcher",
      "max_output_tokens_researcher",
    ]),
  },
  {
    id: "agent_planner",
    pane: "agents",
    label: "Planner",
    keys: Object.freeze([
      "base_turns_planner",
      "max_output_tokens_planner",
      "planner_max_tasks",
      "planner_under_scoped_broad_gate",
    ]),
  },
  {
    id: "agent_dev",
    pane: "agents",
    label: "Dev",
    keys: Object.freeze([
      "base_turns_dev",
      "max_output_tokens_dev",
    ]),
  },
  {
    id: "agent_artificer",
    pane: "agents",
    label: "Artificer",
    keys: Object.freeze([
      "max_output_tokens_artificer",
    ]),
  },
  {
    id: "agent_preflight",
    pane: "agents",
    label: "Preflight",
    keys: Object.freeze([
      "max_output_tokens_preflight",
    ]),
  },
  {
    id: "agent_assessor",
    pane: "agents",
    label: "Assessor",
    keys: Object.freeze([
      "base_turns_assessor",
      "max_output_tokens_assessor",
    ]),
  },
  {
    id: "agent_delegator",
    pane: "agents",
    label: "Delegator",
    keys: Object.freeze([
      "delegation_mode",
      "max_output_tokens_delegator",
    ]),
  },
  // ── Providers pane ──
  {
    id: "provider_claude",
    pane: "providers",
    label: "Claude",
    keys: Object.freeze([
      "claude_run_budget_pct_session",
    ]),
  },
  {
    id: "provider_codex",
    pane: "providers",
    label: "Codex",
    keys: Object.freeze([
      "codex_auth_mode",
      "codex_run_budget_pct_session",
    ]),
  },
  {
    id: "provider_openai",
    pane: "providers",
    label: "OpenAI",
    keys: Object.freeze([
      "openai_run_budget_usd",
      "openai_daily_budget_usd",
      "openai_account_limit_tokens_session",
      "openai_account_limit_tokens_week",
    ]),
  },
  {
    id: "provider_grok",
    pane: "providers",
    label: "Grok",
    keys: Object.freeze([
      "grok_run_budget_usd",
      "grok_daily_budget_usd",
    ]),
  },
  {
    id: "provider_catalog",
    pane: "providers",
    label: "Model Catalog",
    keys: Object.freeze([
      "model_catalog_enforcement",
      "model_catalog_cache_ms",
      "claude_execution_mode",
    ]),
  },
  // ── Images pane ──
  {
    id: "image_grok",
    pane: "images",
    label: "Grok",
    keys: Object.freeze([
      "grok_image_budget_usd",
    ]),
  },
  {
    id: "image_openai",
    pane: "images",
    label: "OpenAI",
    keys: Object.freeze([
      "openai_image_budget_usd",
    ]),
  },
  // ── General pane ──
  {
    id: "runtime",
    pane: "general",
    label: "Runtime",
    keys: Object.freeze([
      "scheduler_concurrency",
      "scheduler_max_active_worktrees",
      "stall_timeout",
      "max_job_runtime_sec",
      "headless_human_timeout_sec",
      "default_max_attempts",
    ]),
  },
  {
    id: "skills",
    pane: "general",
    label: "Skills",
    keys: Object.freeze([
      "skills_enabled",
      "skills_disabled_ids",
    ]),
  },
  {
    id: "safety",
    pane: "general",
    label: "Safety",
    keys: Object.freeze([
      "auto_merge_completed",
      "plan_approval_mode",
      "startup_dirty_tree_policy",
      "fix_scope_handoff_guard",
      "file_request_low_risk_extensions",
      "web_tools_enabled",
      "posse_log_scrub_secrets",
    ]),
  },
  {
    id: "workflow",
    pane: "general",
    label: "Workflow & Recovery",
    keys: Object.freeze([
      "session_recycle_mode",
      "posse_wi_failure_threshold",
      "posse_max_fix_chain_depth",
      "posse_max_replans",
      "posse_max_file_request_depth",
      "snapshot_retention_days",
      "snapshot_max_bytes",
      "snapshot_max_refs",
      "snapshot_dedup",
    ]),
  },
  {
    id: "logging",
    pane: "general",
    label: "Logging",
    keys: Object.freeze([
      "posse_log_level",
      "posse_retention_days",
      "posse_display_max_events",
      "posse_display_event_rate_limit_per_sec",
    ]),
  },
  // ── Repo pane (rows persist per-repo, not as machine-global account state) ──
  {
    id: "repo_git",
    pane: "repo",
    label: "Git & Merge",
    keys: Object.freeze([
      "target_branch",
      "git_commit_style",
    ]),
  },
  {
    id: "bridge",
    pane: "repo",
    label: "Local Bridge",
    keys: Object.freeze([
      "bridge_port",
      "bridge_label",
    ]),
  },
  // ── Debug pane ──
  {
    id: "atlas_experiments",
    pane: "debug",
    label: "ATLAS Experiments & Rollbacks",
    keys: Object.freeze([
      "atlas_answer_contract_tight",
      "atlas_search_result_paging",
      "atlas_result_ref_paging",
      "atlas_result_ref_paging_min_chars",
      "atlas_survey_tail_refs",
      "atlas_ambient_ref_stamping",
      "atlas_gate_nudge",
      "atlas_prefetch_entrypoint_rank",
      "atlas_survey_edge_cap",
      "atlas_gateway_dedup_advertise",
      "atlas_prose_dedup",
      "atlas_tools_disabled",
      "atlas_code_lens_callable",
      "atlas_view_layer_merge",
      "atlas_shadow_guardrails",
    ]),
  },
  {
    id: "atlas_advanced",
    pane: "debug",
    label: "ATLAS Advanced Tuning",
    keys: Object.freeze([
      "atlas_auto_feedback",
      "atlas_tree_compression_provider",
      "atlas_tree_compression_model_tier",
      "atlas_tree_compression_max_seeds",
      "atlas_tree_compression_model_max_seeds",
      "atlas_v2_boot_soft_timeout_ms",
      "atlas_handoff_prefetch_timeout_ms",
      "git_atlas_post_commit_hook_timeout_ms",
    ]),
  },
  {
    id: "atlas_scip_advanced",
    pane: "debug",
    label: "SCIP Advanced Tuning",
    keys: Object.freeze([
      "atlas_scip_index_command",
      "atlas_scip_index_args",
      "atlas_scip_index_timeout_ms",
      "atlas_scip_cold_index_timeout_ms",
      "atlas_scip_max_age_hours",
    ]),
  },
  {
    id: "context_experiments",
    pane: "debug",
    label: "Context & Research Experiments",
    keys: Object.freeze([
      "context_compaction_mode",
      "context_compaction_trigger_input_tokens",
      "context_compaction_session_reset_input_tokens",
      "context_compaction_recent_target_tokens",
      "research_fanout",
      "research_traversal_completion_check",
      "research_traversal_completion_max_chars",
    ]),
  },
  {
    id: "legacy_reserved",
    pane: "debug",
    label: "Legacy & Reserved",
    keys: Object.freeze([
      "posse_kaizen_to_atlas",
    ]),
  },
  {
    id: "scheduler_tuning",
    pane: "debug",
    label: "Scheduler Internals",
    keys: Object.freeze([
      "scheduler_poll_ms",
      "scheduler_repair_poll_ms",
      "default_lease_seconds",
      "worker_lease_renew_max_transient_errors",
      "lease_requeue_grace_sec",
      "worker_provider_circuit_ttl_ms",
      "worktree_lock_wait_ms",
      "scheduler_shadow_conflict_metrics",
      "session_recycle_strict_provider",
      "posse_session_lease_ttl",
    ]),
  },
  {
    id: "hook_overrides",
    pane: "debug",
    label: "Hooks & Overrides",
    keys: Object.freeze([
      "worktree_clean_ignored",
      "skip_hooks",
      "skip_hook_secrets_scan",
      "skip_hook_post_dev_verify",
      "skip_hook_pre_push_gate",
      "pre_assess_cmd",
      "pre_push_verify_cmd",
    ]),
  },
  {
    id: "assessor",
    pane: "debug",
    label: "Assessor Tuning",
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
    label: "Handoff & Context Tuning",
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
    id: "usage_polling",
    pane: "debug",
    label: "Provider Usage Polling",
    keys: Object.freeze([
      "claude_usage_cache_ms",
      "claude_usage_backoff_ms",
      "codex_usage_cache_ms",
      "codex_usage_backoff_ms",
    ]),
  },
  {
    id: "debug_limits",
    pane: "debug",
    label: "Research Internals",
    keys: Object.freeze([
      "posse_fanout_child_timeout_sec",
      "posse_db_telemetry_tail_limit",
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
  "research_traversal_completion_check",
  "research_traversal_completion_max_chars",
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
  "atlas_shadow_guardrails",
  "atlas_auto_feedback",
  "atlas_live_buffers",
  "posse_kaizen_to_atlas",
  "atlas_tree_compression_mode",
  "atlas_tree_compression_provider",
  "atlas_tree_compression_model_tier",
  "atlas_tree_compression_max_seeds",
  "atlas_tree_compression_model_max_seeds",
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
// to Repo when the catalog scopes them per-repo; everything else falls into
// Debug, so newly-added catalog keys stay visible without cluttering the
// operator-facing panes.
export function settingsPaneForKey(displayKey) {
  const group = settingsGroupForKey(displayKey);
  if (group?.pane) return group.pane;
  if (REPO_SCOPED_DISPLAY_KEYS.has(toStorageSettingKey(displayKey))) return "repo";
  return "debug";
}
