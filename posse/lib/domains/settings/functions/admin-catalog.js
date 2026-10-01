import { PLANNER_DISPATCH_SETTING_KEYS, PLANNER_DISPATCH_MODES } from "../../../catalog/planner-dispatch.js";
import { PROVIDER_ROLE_NAMES } from "../../providers/functions/roles.js";
import {
  SETTINGS_CATALOG,
  getCatalogNumericRule,
  getCatalogOptions,
  getCatalogRuntimeFallback,
  isCatalogBooleanSetting,
} from "./catalog.js";

export const PROVIDER_SETTING_KEYS = new Set(PROVIDER_ROLE_NAMES.map((role) => `provider_${role}`));
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
  Object.freeze({ value: "read", label: "read (SELECT, inspection)" }),
  Object.freeze({ value: "write", label: "write (UPDATE, INSERT, DELETE, CREATE, ALTER)" }),
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
//
// Agents carry only the choices operators make day to day (provider, model
// tier, reasoning). Turn budgets, output caps, planner-dispatch tuning, and
// planning limits live in Debug groups below.
export const ADMIN_AGENT_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ role: "coordination", label: "Coordination", keys: Object.freeze(["agent_coordination_mode", "planner_dispatch_mode"]) }),
  Object.freeze({ role: "researcher", label: "Researcher", keys: Object.freeze(["model_tier_researcher", "reasoning_effort_researcher"]) }),
  Object.freeze({ role: "planner", label: "Planner", keys: Object.freeze(["model_tier_planner", "reasoning_effort_planner"]) }),
  Object.freeze({ role: "dev", label: "Developer", keys: Object.freeze(["model_tier_dev", "reasoning_effort_dev"]) }),
  Object.freeze({ role: "artificer", label: "Artificer", keys: Object.freeze(["model_tier_artificer", "reasoning_effort_artificer"]) }),
  Object.freeze({ role: "preflight", label: "Preflight", keys: Object.freeze(["model_tier_preflight", "reasoning_effort_preflight"]) }),
  Object.freeze({ role: "assessor", label: "Assessor", keys: Object.freeze(["model_tier_assessor", "reasoning_effort_assessor"]) }),
  // No delegator: provider assignment always runs on the deterministic
  // JavaScript path at plan time.
]);

export const ADMIN_PROVIDER_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ provider: "claude", label: "Claude", settingKeys: Object.freeze(["claude_execution_mode", "claude_run_budget_pct_session"]) }),
  Object.freeze({ provider: "codex", label: "Codex", settingKeys: Object.freeze(["codex_auth_mode", "codex_run_budget_pct_session"]) }),
  Object.freeze({ provider: "openai", label: "OpenAI", settingKeys: Object.freeze(["openai_run_budget_usd", "openai_daily_budget_usd", "openai_account_limit_tokens_session", "openai_account_limit_tokens_week"]) }),
  Object.freeze({ provider: "grok", label: "Grok", settingKeys: Object.freeze(["grok_run_budget_usd", "grok_daily_budget_usd"]) }),
  Object.freeze({ provider: "copilot", label: "Copilot", settingKeys: Object.freeze([]) }),
  Object.freeze({ provider: "posse-local", label: "Local Models", settingKeys: Object.freeze(["posse_local_generation_enabled"]) }),
]);

export const ADMIN_PROVIDER_CATALOG_SETTING_KEYS = Object.freeze([
  "model_catalog_enforcement",
]);

// Image generation renders on the Providers pane, after the text providers.
export const ADMIN_IMAGE_SETTING_SECTIONS = Object.freeze([
  Object.freeze({ provider: "grok", label: "Grok", settingKeys: Object.freeze(["grok_image_budget_usd"]) }),
  Object.freeze({ provider: "openai", label: "OpenAI", settingKeys: Object.freeze(["openai_image_budget_usd"]) }),
]);

export const ADMIN_CREDENTIAL_SETTING_DEFS = Object.freeze([
  Object.freeze({ key: "OPENAI_API_KEY", label: "OpenAI API key", description: "Used by the OpenAI provider and, in API mode, by Codex. Set it in your environment; Posse never stores or shows it.", env: "OPENAI_API_KEY" }),
  Object.freeze({ key: "CODEX_API_KEY", label: "Codex API key", description: "Optional key for Codex API mode. Set it in your environment; Posse never stores or shows it.", env: "CODEX_API_KEY" }),
  Object.freeze({ key: "XAI_API_KEY", label: "xAI API key", description: "Used by the Grok provider. Set it in your environment; Posse never stores or shows it.", env: "XAI_API_KEY" }),
  Object.freeze({ key: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude OAuth token", description: "Optional Claude login token for headless machines. Set it in your environment; Posse never stores or shows it.", env: "CLAUDE_CODE_OAUTH_TOKEN" }),
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
  // General
  plan_approval_mode: "Plan approval",
  auto_merge_completed: "Auto-merge approved work",
  scheduler_concurrency: "Concurrent jobs",
  scheduler_max_active_worktrees: "Active work item limit",
  scheduler_implementation_reserved_slots: "Slots kept for planned work",
  startup_dirty_tree_policy: "Uncommitted changes at startup",
  session_recycle_mode: "Reuse agent sessions",
  web_tools_enabled: "Web research tools",
  scope_auto_approval: "Auto-approve routine file requests",
  fix_scope_handoff_guard: "Fix scope expansion",
  file_request_low_risk_extensions: "Low-risk file extensions",
  posse_log_scrub_secrets: "Remove secrets from logs",
  default_max_attempts: "Attempts per job",
  posse_wi_failure_threshold: "Failures before human review",
  posse_max_fix_chain_depth: "Fixes in a row before human review",
  posse_max_replans: "Replans before human review",
  posse_max_file_request_depth: "File request follow-up limit",
  stall_timeout: "Stalled job timeout",
  max_job_runtime_sec: "Job runtime limit",
  runtime_write_grace_sec: "Runtime extension while writing",
  runtime_write_ceiling_multiplier: "Runtime ceiling while writing",
  headless_human_timeout_sec: "Headless question timeout",
  skills_enabled: "Planner-selected skills",
  skills_disabled_ids: "Disabled skills",
  posse_log_level: "Log level",
  posse_retention_days: "Telemetry retention",
  snapshot_retention_days: "Recovery snapshot retention",
  snapshot_max_bytes: "Recovery snapshot storage limit",
  snapshot_max_refs: "Recovery snapshot count limit",
  // Agents
  agent_coordination_mode: "Agent coordination",
  planner_dispatch_mode: "Planner-led intake",
  // Providers
  artifact_image_provider: "Image provider",
  claude_execution_mode: "Claude CLI mode",
  claude_run_budget_pct_session: "Claude run budget (%)",
  codex_auth_mode: "Codex sign-in",
  codex_run_budget_pct_session: "Codex run budget (%)",
  openai_run_budget_usd: "OpenAI run budget ($)",
  openai_daily_budget_usd: "OpenAI daily budget ($)",
  openai_account_limit_tokens_session: "OpenAI session token limit",
  openai_account_limit_tokens_week: "OpenAI weekly token limit",
  grok_run_budget_usd: "Grok run budget ($)",
  grok_daily_budget_usd: "Grok daily budget ($)",
  grok_image_budget_usd: "Grok image budget ($)",
  openai_image_budget_usd: "OpenAI image budget ($)",
  posse_local_generation_enabled: "Experimental local generation",
  model_catalog_enforcement: "Retired model policy",
  // ATLAS
  atlas_v2: "ATLAS code index",
  atlas_phases: "Roles using ATLAS",
  atlas_live_funnel: "Add ATLAS context to prompts",
  atlas_live_index: "Index in-progress edits",
  atlas_memory_mode: "ATLAS memory",
  atlas_scip_mode: "SCIP indexing",
  atlas_scip_languages: "SCIP languages",
  atlas_boot_reindex_policy: "Startup reindex",
  atlas_reindex_on_commit: "Reindex after merges",
  atlas_scip_restage_policy: "SCIP rebuild policy",
  atlas_embedding_model_id: "Embedding model",
  atlas_tree_compression_mode: "Repository map",
  // Repository
  target_branch: "Merge target branch",
  git_commit_style: "Commit message style",
  db_task_pre_merge_policy: "Database tasks before merge",
  canonical_verify_cmd: "Verification command",
  verification_wall_timeout_ms: "Verification timeout",
  verification_idle_timeout_ms: "Verification silence timeout",
  verification_dependency_network_policy: "Dependency downloads for verification",
  pre_dev_typecheck: "Show type errors to developers",
  bridge_port: "Bridge port",
  bridge_label: "Bridge name",
  project_db_enabled: "Agent database access",
  project_db_type: "Database type",
  project_db_permissions: "Allowed database scopes",
  project_db_database: "Database name or file",
  project_db_host: "Database host",
  project_db_port: "Database port",
  project_db_username: "Database username",
  project_db_password: "Database password",
  // Debug · ATLAS token levers
  atlas_answer_contract_tight: "Compact research answers",
  atlas_search_result_paging: "Page large search results",
  atlas_result_ref_paging: "Page large code results",
  atlas_result_ref_paging_min_chars: "Code result paging threshold",
  atlas_prefetch_entrypoint_rank: "Prefer entry points in prefetch",
  atlas_handoff_prefetch: "Preload ATLAS context at handoff",
  atlas_survey_brief_edge_count: "Survey relationship preview",
  atlas_survey_edge_cap: "Survey relationship limit",
  atlas_gate_nudge: "Area-survey nudge",
  atlas_gateway_dedup_advertise: "Hide redundant gateway tools",
  atlas_prose_dedup: "Compact tool guidance",
  atlas_code_lens_callable: "Allow code lens tool",
  atlas_view_layer_merge: "Layered ATLAS views",
  // Debug · tool ablation
  atlas_tools_disabled: "Hidden ATLAS actions",
  agent_tools_disabled: "Hidden agent tools",
  // Debug · ATLAS internals
  atlas_usage_telemetry: "ATLAS usage telemetry",
  atlas_live_buffers: "Stream edit buffers to ATLAS",
  atlas_tool_gate_enabled: "Require ATLAS before file tools",
  atlas_memory_surface: "Memory lookups in handoffs",
  atlas_drift_check: "Index drift checks",
  atlas_auto_feedback: "ATLAS result feedback",
  git_atlas_post_commit_hook_timeout_ms: "Post-commit reindex timeout",
  atlas_tree_compression_provider: "Repository map provider",
  atlas_tree_compression_model_tier: "Repository map model tier",
  atlas_tree_compression_max_seeds: "Repository map size",
  atlas_tree_compression_model_max_seeds: "Repository map entries summarized",
  // Debug · SCIP overrides
  atlas_scip_index_command: "Custom SCIP command",
  atlas_scip_index_args: "Custom SCIP arguments",
  atlas_scip_index_timeout_ms: "SCIP index timeout",
  atlas_scip_cold_index_timeout_ms: "First SCIP index timeout",
  atlas_scip_max_age_hours: "SCIP index maximum age",
  // Debug · shadow experiments
  context_compaction_mode: "Rolling context",
  context_compaction_trigger_input_tokens: "Rolling context threshold",
  context_compaction_session_reset_input_tokens: "Rolling context reset threshold",
  context_compaction_recent_target_tokens: "Rolling context recent window",
  research_fanout: "Parallel research",
  research_evidence_reuse: "Research evidence reuse",
  research_claim_review: "Research claim review",
  research_traversal_completion_check: "Traversal completion check",
  research_traversal_completion_max_chars: "Traversal check text limit",
  research_synthesis_max_physical_calls: "Researcher tool-call ceiling",
  assessment_scope_mode: "Grouped assessment",
  assessment_scope_max_group_jobs: "Grouped assessment job limit",
  assessment_scope_max_group_chars: "Grouped assessment evidence limit",
  atlas_shadow_guardrails: "ATLAS shadow guardrails",
  atlas_ambient_ref_stamping: "Reusable result references",
  scheduler_shadow_conflict_metrics: "Shadow lock-conflict metrics",
  // Debug · waiting lanes
  waiting_lane_shadow_mode: "Waiting-lane observation",
  waiting_lane_git_preparation_enabled: "Prepare waiting-lane worktrees",
  waiting_lane_atlas_snapshot_enabled: "Snapshot ATLAS for waiting lanes",
  waiting_lane_atlas_catchup_enabled: "Refresh parked lane views",
  waiting_lane_activation_enabled: "Start jobs from prepared lanes",
  waiting_lane_preparation_concurrency: "Lanes prepared at once",
  waiting_lane_max_prepared_lanes: "Prepared lane limit",
  waiting_lane_prepared_ttl_ms: "Prepared lane idle lifetime",
  waiting_lane_max_hot_paths: "Hot files per lane",
  // Debug · planner-led intake tuning
  planner_research_effort_ceiling: "Research helper effort ceiling",
  planner_research_max_children: "Research helpers per plan",
  planner_research_child_timeout_ms: "Research helper timeout",
  planner_research_child_max_turns: "Research helper turn limit",
  planner_research_result_chars: "Research helper result size",
  planner_research_expand_chars: "Source expansion budget",
  planner_dispatch_triage_max_turns: "Planner triage turns",
  planner_dispatch_model_tier: "Planner-led model tier",
  planner_dispatch_reasoning_effort: "Planner-led reasoning",
  planner_research_child_model_tier: "Research helper model tier",
  planner_research_child_reasoning_effort: "Research helper reasoning",
  agent_dispatch_tool_timeout_sec: "Dispatch tool timeout",
  // Debug · agent limits
  planner_max_tasks: "Tasks per plan",
  planner_under_scoped_broad_gate: "Under-scoped plan policy",
  // Debug · assessor
  assessor_fallback_reads: "Assessor fallback reads",
  assessor_fallback_reads_retry_step: "Extra reads per retry",
  assessor_internal_retry_limit: "Assessment retry limit",
  assessor_max_tool_calls: "Assessor tool-call limit",
  assessor_parse_retry_input_tokens_cap: "Assessment retry token budget",
  // Debug · handoff & context
  handoff_max_prompt_chars: "Prompt size limit",
  handoff_max_context_chars: "Handoff context size limit",
  handoff_preload_editable_file_bodies: "Preload editable files",
  handoff_max_file_bytes: "Single preloaded file limit",
  handoff_max_preload_total_bytes: "Editable preload limit",
  handoff_max_related_files_total_bytes: "Related file preload limit",
  posse_remote_timeout_ms: "Remote prompt timeout",
  context_expand_max_steps: "Missing-context retry limit",
  context_expand_file_budget_per_attempt: "Files added per context retry",
  // Debug · scheduler internals
  scheduler_poll_ms: "Scheduler poll interval",
  scheduler_repair_poll_ms: "Scheduler repair interval",
  default_lease_seconds: "Job lease duration",
  worker_lease_renew_max_transient_errors: "Lease renewal error limit",
  lease_requeue_grace_sec: "Expired lease grace period",
  worker_provider_circuit_ttl_ms: "Provider failure cooldown",
  worktree_lock_wait_ms: "Worktree lock wait",
  session_recycle_strict_provider: "Reset sessions on provider change",
  posse_session_lease_ttl: "Reused session lease",
  human_gate_resnooze_sec: "Question reminder interval",
  human_gate_max_resurfaces: "Question reminder limit",
  posse_fanout_child_timeout_sec: "Research child queue timeout",
  // Debug · hooks
  skip_hooks: "Skip all safety hooks",
  skip_hook_secrets_scan: "Skip secret scanning",
  skip_hook_post_dev_verify: "Skip developer verification",
  skip_hook_pre_push_gate: "Skip pre-push checks",
  worktree_clean_ignored: "Clean ignored worktree files",
  pre_assess_cmd: "Command before assessment",
  pre_push_verify_cmd: "Command before push",
  verification_wall_timeout_max_ms: "Verification timeout ceiling",
  // Debug · telemetry & polling
  posse_db_telemetry_tail_limit: "Database telemetry tail",
  posse_display_max_events: "Live event history",
  posse_display_event_rate_limit_per_sec: "Live event rate limit",
  snapshot_dedup: "Deduplicate recovery snapshots",
  claude_usage_cache_ms: "Claude usage refresh interval",
  claude_usage_backoff_ms: "Claude usage retry delay",
  codex_usage_cache_ms: "Codex usage refresh interval",
  codex_usage_backoff_ms: "Codex usage retry delay",
  model_catalog_cache_ms: "Model catalog refresh interval",
});

// Operator-facing explanations: what the setting changes, what each option
// means, and the unit. Blank-value meanings are shown in the value column via
// ADMIN_UNSET_VALUE_LABELS, so descriptions only mention them when the
// behavior needs explaining.
const ADMIN_SETTING_DESCRIPTION_OVERRIDES = Object.freeze({
  // General · Workflow
  plan_approval_mode: "Whether new plans start on their own. Auto-approve runs every plan; critical-risk pauses only plans rated critical risk; every plan pauses all plans until you approve them.",
  auto_merge_completed: "Merge a work item's branch into the target branch as soon as it passes assessment. When off, finished work waits for you to review and merge it.",
  scheduler_concurrency: "How many agent jobs may run at the same time. A --concurrency flag on the command line overrides this for that run.",
  scheduler_max_active_worktrees: "How many work items may have jobs running at once, each in its own worktree. Use it to cap disk and CPU use separately from the job limit.",
  scheduler_implementation_reserved_slots: "Agent slots that new plans leave for work already planned. Once plan jobs fill all but this many slots, the rest go first to ready developer, fix, artificer, and promote jobs; plans still use them when none can start. 0 turns this off.",
  startup_dirty_tree_policy: "What happens when the repository has uncommitted changes at startup. Block stops and asks you to clean up; commit saves your changes in a commit before work begins.",
  session_recycle_mode: "Let follow-up jobs resume an earlier compatible agent session instead of starting fresh, which saves tokens. Dev/fix reuses sessions for developer fixes only; full reuses them wherever supported; off always starts fresh.",
  web_tools_enabled: "Let researcher, assessor, and native-team agents search the web and read web pages, let developers do so as a fallback for missing external facts, and let the artificer download files into its output folder.",
  // General · Approvals & safety
  scope_auto_approval: "Approve routine file requests without asking you: new files under an already-approved folder, test files for developer and fix jobs, and generated lockfiles.",
  fix_scope_handoff_guard: "Controls fixes that name existing files outside their approved scope. Auto/warn adds those files; enforce blocks the handoff; off ignores them.",
  file_request_low_risk_extensions: "Comma-separated file extensions (for example .md,.txt) that developers may create without asking you. Protected, package, and CI files always need approval.",
  posse_log_scrub_secrets: "Mask values that look like API keys, tokens, or passwords before prompts and model output are written to logs.",
  // General · Limits & retries
  default_max_attempts: "How many times a job may run before Posse stops retrying it and applies its normal failure handling.",
  posse_wi_failure_threshold: "Hand a work item to you for review after this many failed developer or fix jobs.",
  posse_max_fix_chain_depth: "Hand a work item to you for review after this many fix jobs in a row still fail assessment.",
  posse_max_replans: "Hand a work item to you for review after the assessor asks for a new plan this many times.",
  posse_max_file_request_depth: "How many rounds of follow-up file requests a developer may chain onto one approval.",
  stall_timeout: "Stop a job that shows no progress (no output or tool activity) for this many seconds.",
  max_job_runtime_sec: "Stop any job that runs longer than this many seconds in total, even while it is still making progress.",
  runtime_write_grace_sec: "A job past its runtime limit keeps running while it wrote or edited a file within this many seconds, so it is not stopped just before it finishes. 0 turns the extension off.",
  runtime_write_ceiling_multiplier: "The most write activity can extend a job, as a multiple of its runtime limit. A job past this is stopped even if it is still writing.",
  headless_human_timeout_sec: "In non-interactive runs, how many seconds Posse waits for an answer to a question before timing out.",
  // General · Skills
  skills_enabled: "Let the planner attach skills (reusable instructions from the prompt bundle) to developer jobs when they fit the task.",
  skills_disabled_ids: "Skills the planner may never attach. Newly installed skills are allowed until you disable them.",
  // General · Logs & storage
  posse_log_level: "Lowest severity written to the runtime log file: debug, info, warn, or error.",
  posse_retention_days: "Days to keep job telemetry (events, observations, agent calls) in the runtime database. 0 keeps it forever.",
  snapshot_retention_days: "Days to keep recovery snapshots, which save uncommitted work before Posse resets a worktree.",
  snapshot_max_bytes: "Total disk space recovery snapshots may use, in bytes. The oldest snapshots are removed first.",
  snapshot_max_refs: "Maximum number of recovery snapshots to keep. The oldest are removed first.",
  // Agents
  agent_coordination_mode: "How agents report back when a job ends. Handoff has each agent file a closing handoff report; subagents also lets agents start small helpers that gather citations; off turns both off.",
  planner_dispatch_mode: "How new requests reach the planner, for every repository on this account. Router runs research and preflight first, as usual; planner lets the planner take the request directly and send out its own bounded research helpers.",
  // Providers
  artifact_image_provider: "Provider that generates image artifacts. Only providers with a configured key can be selected.",
  claude_execution_mode: "How Posse drives the Claude CLI. Print runs each call with claude -p and streams JSON (recommended); interactive runs a terminal session and follows Claude's own session log.",
  claude_run_budget_pct_session: "Share of your current Claude session window a single Posse run is expected to use. Shown as a budget bar; Posse does not stop jobs when it is reached.",
  codex_auth_mode: "How Posse signs in to Codex. OAuth uses your ChatGPT login; API uses an API key from the environment; auto tries OAuth only. OAuth and auto never fall back to an API key.",
  codex_run_budget_pct_session: "Share of your current Codex session window a single Posse run is expected to use. Shown as a budget bar; Posse does not stop jobs when it is reached.",
  openai_run_budget_usd: "Expected OpenAI spend for a single Posse run, in US dollars. Shown as a budget bar; Posse does not stop jobs when it is reached.",
  openai_daily_budget_usd: "Expected OpenAI spend per day, in US dollars. Shown as a budget bar on Overview; Posse does not stop jobs when it is reached.",
  openai_account_limit_tokens_session: "Your OpenAI account's token allowance per session window. Used to show remaining capacity in usage bars.",
  openai_account_limit_tokens_week: "Your OpenAI account's token allowance per week. Used to show remaining capacity in usage bars.",
  grok_run_budget_usd: "Expected Grok spend for a single Posse run, in US dollars. Shown as a budget bar; Posse does not stop jobs when it is reached.",
  grok_daily_budget_usd: "Expected Grok spend per day, in US dollars. Shown as a budget bar on Overview; Posse does not stop jobs when it is reached.",
  grok_image_budget_usd: "Expected Grok image-generation spend, in US dollars. Shown for tracking; Posse does not stop jobs when it is reached.",
  openai_image_budget_usd: "Expected OpenAI image-generation spend, in US dollars. Shown for tracking; Posse does not stop jobs when it is reached.",
  posse_local_generation_enabled: "Allow the staged posse-local provider to appear in Admin for an operator-run test. Runtime checks still require a supported platform, the native ML worker, and an installed model package.",
  model_catalog_enforcement: "What to do when a model you picked is no longer in the model catalog. Warn and fallback switches to that tier's current default; warn only keeps your model; off skips the check.",
  // ATLAS
  atlas_v2: "Master switch for ATLAS, Posse's code index. On gives agents indexed code search and context; required refuses to start jobs when ATLAS is unavailable; off falls back to plain file reads and search.",
  atlas_phases: "Which agent roles get ATLAS context and tools: research, planning, assessment, and dev.",
  atlas_live_funnel: "Automatically add relevant ATLAS search results and code context to agent prompts.",
  atlas_live_index: "Let long-running jobs search their own unmerged edits, not only the last indexed commit.",
  atlas_memory_mode: "Master switch for ATLAS memory: saved notes attached to files and symbols that agents can read and write. Off removes memory tools, prompts, and storage.",
  atlas_scip_mode: "Use SCIP compiler indexes for precise definitions and references. On builds them during startup; on-demand builds them when first needed; both does both; off relies on tree-sitter parsing alone.",
  atlas_scip_languages: "Languages that get SCIP indexing and scoped lint. Saving installs the Posse-managed indexers for any newly selected language.",
  atlas_boot_reindex_policy: "When startup refreshes the ATLAS index. Smart updates only what changed; missing builds an index only if there is none; always rebuilds everything.",
  atlas_reindex_on_commit: "Install a git hook that updates the ATLAS index after Posse merges work.",
  atlas_scip_restage_policy: "When existing SCIP indexes are rebuilt. Smart rebuilds after source changes or once an index passes its maximum age; missing builds only absent indexes; always rebuilds every time; never keeps existing ones.",
  atlas_embedding_model_id: "Local embedding model ATLAS uses to find code by meaning rather than by exact names.",
  atlas_tree_compression_mode: "How ATLAS builds the compact repository map agents start from. ML adds a one-time model-written summary; deterministic uses rules only; off skips the map.",
  // Repository
  target_branch: "Branch completed work merges into. When blank, Posse uses the remote's default branch, then main or master.",
  git_commit_style: "Format of the commit subjects Posse writes: off (plain), Conventional Commits, or Conventional Commits with Gitmoji. Styled modes add one standard-tier model pass per commit.",
  db_task_pre_merge_policy: "Database tasks that depend on file changes not yet merged. Hold waits until the work item merges, then asks you before writing the project database; run writes it right away, reading the work item's branch. Use run only when the project database is not production.",
  canonical_verify_cmd: "Your repository's own verification command (for example npm test). Posse runs it before assessment and before pushing.",
  verification_wall_timeout_ms: "How long a verification command may run, in milliseconds, before Posse stops it. Match the time your test suite documents; capped by the Debug verification ceiling.",
  verification_idle_timeout_ms: "Stop a verification command that prints nothing for this many milliseconds. Leave it off for test runners that stay silent while healthy.",
  pre_dev_typecheck: "Before a developer job starts, run your typecheck script and list the existing type errors in the files the job may edit, so the developer fixes them while making its change. Needs a typecheck script in package.json.",
  verification_dependency_network_policy: "Whether Posse may download missing dependencies (from your lockfile) before verification. Allow downloads them; cache only uses what is already cached; disabled never repairs dependencies.",
  bridge_port: "Local port for this repository's phone bridge. When blank, Posse picks a free port starting at 7531 and remembers it.",
  bridge_label: "Name shown for this repository in the phone app.",
  project_db_enabled: "Allow agents to query the project database using the permissions below.",
  project_db_type: "Database engine used by this repository: SQLite, PostgreSQL, or MySQL.",
  project_db_permissions: "Database scopes agents may use: read and/or write. DROP and TRUNCATE are never allowed. Read-only roles can still only read.",
  project_db_database: "SQLite file path relative to the repository, or the PostgreSQL/MySQL database name.",
  project_db_host: "Host name for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_port: "Port for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_username: "Username for PostgreSQL or MySQL. SQLite does not use this setting.",
  project_db_password: "Password for PostgreSQL or MySQL. It is stored securely and never displayed; leave blank to keep it unchanged, or clear it to remove it.",
  // Debug · ATLAS token levers (adopted defaults; turn one off to roll back)
  atlas_answer_contract_tight: "Use shorter, citation-focused research answers. Turn off to restore the standard research response format.",
  atlas_search_result_paging: "Keep large symbol-search results compact and make the remaining results available on demand.",
  atlas_result_ref_paging: "Keep large code-window and code-lens results compact and make the remaining content available on demand.",
  atlas_result_ref_paging_min_chars: "Result size, in characters, at which code-window and code-lens paging begins.",
  atlas_prefetch_entrypoint_rank: "Prefer likely entry points and heavily imported files during ATLAS prefetch. Turn off for the older ranking.",
  atlas_handoff_prefetch: "Attach an ATLAS survey and code context to each agent's first prompt. Off makes agents fetch ATLAS context themselves when they need it.",
  atlas_survey_brief_edge_count: "How many ranked relationships (calls, imports) the first code survey shows. Above 8 uses a larger, balanced preview; the full survey stays available either way.",
  atlas_survey_edge_cap: "Maximum total relationship rows a code survey returns. 0 uses the normal per-section limits.",
  atlas_gate_nudge: "Suggest an area survey after an agent calls code lens or code window on the same target several times. Off only records the pattern.",
  atlas_gateway_dedup_advertise: "Hide the redundant ATLAS gateway tools when the individual ATLAS tools are already offered. Turn off for the older tool list.",
  atlas_prose_dedup: "Keep role prompts to the routed tool names and short cross-tool guidance. Turn off to restore the longer handoff and tool-schema text.",
  atlas_code_lens_callable: "Let agents call code lens directly. Off removes it from new agent sessions; Posse still uses it internally.",
  atlas_view_layer_merge: "Build ATLAS views from separate per-source symbol layers. Turn off only to fall back to the older single-table views.",
  // Debug · tool ablation
  atlas_tools_disabled: "Comma-separated ATLAS actions to hide from new agent sessions (for example code.survey,symbol.card).",
  agent_tools_disabled: "Comma-separated tools to hide from new agent sessions. Plain names (read_file) are native tools; dotted names (code.lens) are ATLAS actions; prefix with a role (dev:code.lens) to target one role. agent_handoff is always kept.",
  // Debug · ATLAS internals
  atlas_usage_telemetry: "Record ATLAS action counts and latency in a per-repository telemetry store. Off stops recording; tool results are unaffected.",
  atlas_live_buffers: "Send developer file writes and edits to the live ATLAS index as they happen.",
  atlas_tool_gate_enabled: "Make agents try ATLAS before they may use the general file read and search tools.",
  atlas_memory_surface: "Check each handoff for saved ATLAS memory on the files and symbols involved. On and auto list what they find; off never checks.",
  atlas_drift_check: "Periodically check that the ATLAS index still matches the current commit.",
  atlas_auto_feedback: "Let agents rate ATLAS results when a job ends. Write saves the ratings and uses them to rank future results; dry-run records what would be saved; off disables it.",
  git_atlas_post_commit_hook_timeout_ms: "How long, in milliseconds, a Posse commit waits for the ATLAS reindex hook.",
  atlas_tree_compression_provider: "Provider for the model pass that summarizes the repository map.",
  atlas_tree_compression_model_tier: "Model tier for the repository map summary pass.",
  atlas_tree_compression_max_seeds: "Maximum entries kept in the cached repository map.",
  atlas_tree_compression_model_max_seeds: "Maximum map entries sent to the one-time model summary pass.",
  // Debug · SCIP overrides
  atlas_scip_index_command: "Run your own SCIP indexer command instead of Posse's managed indexers.",
  atlas_scip_index_args: "Arguments for the custom SCIP command. {output}, {repoRoot}, and {scipDir} are filled in for you.",
  atlas_scip_index_timeout_ms: "How long, in milliseconds, one SCIP indexer may run during startup before Posse gives up on it.",
  atlas_scip_cold_index_timeout_ms: "Longer limit, in milliseconds, for a language's first index or a retry after a failed one.",
  atlas_scip_max_age_hours: "Smart rebuilds refresh a SCIP index older than this many hours even when nothing changed.",
  // Debug · shadow experiments
  context_compaction_mode: "Unfinished rolling-context experiment. Shadow only records estimated savings; inject and enforce are experimental and change prompts.",
  context_compaction_trigger_input_tokens: "Input-token size at which rolling-context measurements start.",
  context_compaction_session_reset_input_tokens: "Resumed-session input-token size at which the experiment would reset the conversation.",
  context_compaction_recent_target_tokens: "Tokens of the most recent conversation the rolling-context estimate keeps unchanged.",
  research_fanout: "Split research across parallel helpers. Shadow records what would happen without changing anything; on runs it.",
  research_evidence_reuse: "Measure how much planner evidence repeats what research already found. Shadow only records; retrieval is unchanged.",
  research_claim_review: "Check research claims against their cited sources after the report is written. Shadow records findings and cost; the report is never edited.",
  research_traversal_completion_check: "Check whether a researcher or developer skipped part of the code it was tracing before it hands off. Shadow records; on adds guidance to the handoff.",
  research_traversal_completion_max_chars: "Maximum characters of traversal-check guidance added to one handoff.",
  research_synthesis_max_physical_calls: "Ceiling on tool calls a researcher may make in one attempt. Other research limits are unchanged; each session reads it once at start.",
  assessment_scope_mode: "Record how jobs could be grouped for a single combined assessment. Shadow only records; jobs, dependencies, and assessment are unchanged.",
  assessment_scope_max_group_jobs: "Most jobs one recorded assessment group may contain.",
  assessment_scope_max_group_chars: "Most estimated evidence characters one recorded assessment group may contain.",
  atlas_shadow_guardrails: "Record ATLAS guardrail findings (deploy provenance, exact counts, negative evidence, token pressure) without changing agent behavior.",
  atlas_ambient_ref_stamping: "Make more ATLAS results reusable by reference, including small ones. Off keeps references for results over 4,000 characters.",
  scheduler_shadow_conflict_metrics: "Record when relaxed scheduling runs jobs that strict file locking would have held back. Telemetry only.",
  // Debug · waiting lanes
  waiting_lane_shadow_mode: "Record which queued work could be prepared ahead of time, without preparing anything.",
  waiting_lane_git_preparation_enabled: "Create a detached worktree for eligible queued work once its research starts.",
  waiting_lane_atlas_snapshot_enabled: "Save an ATLAS snapshot into each prepared waiting lane.",
  waiting_lane_atlas_catchup_enabled: "Refresh parked lanes' ATLAS views after new work merges.",
  waiting_lane_activation_enabled: "Let a developer job start from its prepared lane instead of a fresh worktree.",
  waiting_lane_preparation_concurrency: "How many lanes may be prepared at the same time, separate from agent job slots.",
  waiting_lane_max_prepared_lanes: "How many prepared lanes are kept on disk; the least recently used are removed first.",
  waiting_lane_prepared_ttl_ms: "Remove a prepared lane after it sits unused for this many milliseconds.",
  waiting_lane_max_hot_paths: "How many researcher-touched files each lane remembers for its final prefetch.",
  // Debug · planner-led intake tuning
  planner_research_effort_ceiling: "Highest reasoning effort the planner may request for a research helper.",
  planner_research_max_children: "Most research helpers one planner call may start.",
  planner_research_child_timeout_ms: "How long one research helper may run, in milliseconds. The dispatch tool timeout also bounds it.",
  planner_research_child_max_turns: "Turn budget for each research helper.",
  planner_research_result_chars: "Most characters each research helper returns to the planner.",
  planner_research_expand_chars: "Characters of source briefs expanded automatically across one research batch. 0 turns expansion off.",
  planner_dispatch_triage_max_turns: "Turns the planner may spend deciding whether it needs research.",
  planner_dispatch_model_tier: "Model tier for the planner when it takes requests directly.",
  planner_dispatch_reasoning_effort: "Reasoning effort for the planner when it takes requests directly.",
  planner_research_child_model_tier: "Model tier for research helpers; cheaper than the planner by default.",
  planner_research_child_reasoning_effort: "Reasoning effort for a research helper when the planner does not ask for one. The effort ceiling still applies.",
  agent_dispatch_tool_timeout_sec: "How long, in seconds, the dispatch tool waits for helpers before returning to the planner.",
  // Debug · agent limits
  planner_max_tasks: "Most tasks the planner may put in one plan.",
  planner_under_scoped_broad_gate: "What happens to broad plans that list too few files. Off allows them; warn flags them; enforce rejects them.",
  // Debug · assessor
  assessor_fallback_reads: "Extra file reads the assessor may make on its own when the developer did not show enough output to verify the change.",
  assessor_fallback_reads_retry_step: "Extra fallback reads added on each assessment retry.",
  assessor_internal_retry_limit: "How many times assessment retries internally (for example after unreadable output) before the job fails.",
  assessor_max_tool_calls: "Hard limit on tool calls in one assessor call. The assessor can always still hand off.",
  assessor_parse_retry_input_tokens_cap: "Input tokens shared by all assessment retries of one job. 0 removes the limit.",
  // Debug · handoff & context
  handoff_max_prompt_chars: "Largest prompt, in characters, Posse will send to an agent.",
  handoff_max_context_chars: "Characters of file context allowed in a handoff before optional sections are dropped.",
  handoff_preload_editable_file_bodies: "Include the full text of files a developer may edit in its first prompt: off, small files only, or always. Merge-conflict fixes always include them.",
  handoff_max_file_bytes: "Largest single file, in bytes, preloaded into a handoff.",
  handoff_max_preload_total_bytes: "Total bytes of editable files preloaded into one handoff.",
  handoff_max_related_files_total_bytes: "Total bytes of related, read-only files preloaded into one handoff.",
  posse_remote_timeout_ms: "How long, in milliseconds, Posse waits for the remote prompt service.",
  context_expand_max_steps: "How many times an agent may report missing files and retry within one attempt.",
  context_expand_file_budget_per_attempt: "Files Posse may add for each missing-context retry.",
  // Debug · scheduler internals
  scheduler_poll_ms: "How often, in milliseconds, the scheduler checks the queue for work.",
  scheduler_repair_poll_ms: "Backup queue check interval, in milliseconds, in case a change notification is missed.",
  default_lease_seconds: "How long a worker holds a job before it must renew its lease, in seconds.",
  worker_lease_renew_max_transient_errors: "Lease renewal errors a worker tolerates before it abandons the job.",
  lease_requeue_grace_sec: "Seconds after a lease expires before the job goes back in the queue.",
  worker_provider_circuit_ttl_ms: "After repeated fast failures, how long (in milliseconds) a worker stops sending jobs to that provider.",
  worktree_lock_wait_ms: "How long (in milliseconds) a job waits for a busy worktree before retrying later without using up an attempt.",
  session_recycle_strict_provider: "Start a fresh session instead of resuming when a follow-up job uses a different provider.",
  posse_session_lease_ttl: "Seconds before an idle reused session is released.",
  human_gate_resnooze_sec: "Seconds a waiting question stays snoozed before Posse reminds you again (interactive sessions).",
  human_gate_max_resurfaces: "Most automatic reminders for one waiting question. 0 turns reminders off.",
  posse_fanout_child_timeout_sec: "Seconds a parallel research child may wait in the queue before it is timed out so the others' results can be combined.",
  // Debug · hooks
  skip_hooks: "Turn off every built-in safety hook (secret scan, post-developer verification, pre-push checks). For debugging only.",
  skip_hook_secrets_scan: "Skip the scan that blocks commits containing secrets.",
  skip_hook_post_dev_verify: "Skip the verification run after each developer job.",
  skip_hook_pre_push_gate: "Skip the checks that run before Posse pushes.",
  worktree_clean_ignored: "Also delete git-ignored files (build output, caches) when a worktree is reset.",
  pre_assess_cmd: "Shell command run in the worktree before each assessment.",
  pre_push_verify_cmd: "Shell command run before Posse pushes.",
  verification_wall_timeout_max_ms: "Ceiling, in milliseconds, on any repository's verification timeout.",
  // Debug · telemetry & polling
  posse_db_telemetry_tail_limit: "Recent telemetry rows kept in the database after they are copied to log files. 0 keeps everything.",
  posse_display_max_events: "Recent events kept by the live terminal display.",
  posse_display_event_rate_limit_per_sec: "Events per second above which the terminal display skips updates to stay responsive.",
  snapshot_dedup: "Reuse an existing recovery snapshot when the uncommitted work is identical.",
  claude_usage_cache_ms: "How often, in milliseconds, Posse refreshes Claude usage numbers.",
  claude_usage_backoff_ms: "Wait, in milliseconds, before retrying after a Claude usage refresh fails.",
  codex_usage_cache_ms: "How often, in milliseconds, Posse refreshes Codex usage numbers.",
  codex_usage_backoff_ms: "Wait, in milliseconds, before retrying after a Codex usage refresh fails.",
  model_catalog_cache_ms: "How often, in milliseconds, Posse downloads the model catalog again.",
});

// What an empty value means at runtime, for settings whose catalog default is
// blank. The admin shows this in place of an empty cell. Catalog
// `runtimeFallback` values take precedence, so numeric fallbacks live in one
// place; this table covers the non-numeric meanings.
const ADMIN_UNSET_VALUE_LABELS = Object.freeze({
  scheduler_max_active_worktrees: "no limit",
  max_job_runtime_sec: "2× stalled job timeout",
  file_request_low_risk_extensions: "none",
  skills_disabled_ids: "none",
  target_branch: "auto-detect",
  bridge_port: "auto (7531+)",
  bridge_label: "folder @ host",
  canonical_verify_cmd: "none",
  verification_idle_timeout_ms: "off",
  pre_assess_cmd: "none",
  pre_push_verify_cmd: "none",
  handoff_max_context_chars: "65% of prompt limit",
  research_synthesis_max_physical_calls: "26 (built-in)",
  atlas_tree_compression_provider: "researcher's provider",
  atlas_scip_index_command: "managed indexers",
  atlas_scip_index_args: "none",
  atlas_tools_disabled: "none",
  agent_tools_disabled: "none",
  artifact_image_provider: "auto",
});

// Numeric settings stored in raw units get a short human-readable hint next to
// the stored number, so "86400000" also reads as "24h".
const ADMIN_SETTING_UNIT_OVERRIDES = Object.freeze({
  stall_timeout: "sec",
  max_job_runtime_sec: "sec",
  headless_human_timeout_sec: "sec",
  posse_session_lease_ttl: "sec",
  default_lease_seconds: "sec",
  snapshot_max_bytes: "bytes",
  handoff_max_file_bytes: "bytes",
  handoff_max_preload_total_bytes: "bytes",
  handoff_max_related_files_total_bytes: "bytes",
});

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

// What each agent role does, for role-pattern descriptions.
const ADMIN_ROLE_PURPOSES = Object.freeze({
  researcher: "investigate the codebase before planning",
  planner: "turn research into a task plan",
  dev: "write and fix the code",
  artificer: "produce non-code artifacts such as images",
  preflight: "triage each new request",
  assessor: "review and verify finished work",
});

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

// ── Admin settings panes & groups ───────────────────────────────────────────
//
// The admin TUI settings tab is split into panes (switched with ←/→), ordered
// by how often operators reach for them: everyday workflow first, internals
// last. Each group below belongs to exactly one pane and renders its `keys`
// (display-keys, matching what the settings snapshot returns) in the listed
// order. Debug holds experiments, rollbacks, and tuning; its groups carry a
// short `hint` naming what kind of knob they are.
//
// Every admin-visible catalog key must be placed in a group (a test enforces
// it). Ungrouped keys still fall back to Repository (repo-scoped) or Debug so
// a missed placement stays visible instead of disappearing.
export const SETTINGS_PANES = Object.freeze([
  Object.freeze({ id: "general", label: "General" }),
  Object.freeze({ id: "agents", label: "Agents" }),
  Object.freeze({ id: "providers", label: "Providers" }),
  Object.freeze({ id: "atlas", label: "ATLAS" }),
  Object.freeze({ id: "repo", label: "Repository" }),
  Object.freeze({ id: "debug", label: "Debug" }),
]);

export const ADMIN_DEFAULT_SETTINGS_PANE = "general";

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
    "atlas_tool_gate_enabled",
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
