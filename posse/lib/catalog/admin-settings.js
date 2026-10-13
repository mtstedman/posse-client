// @ts-check
import { readonlySet } from "./readonly-collections.js";

import { PROJECT_DB_PERMISSIONS, PROJECT_DB_TYPES } from "./project-db.js";
import { PROVIDER_ROLE_NAMES } from "./provider.js";

export const PROVIDER_SETTING_KEYS = readonlySet(PROVIDER_ROLE_NAMES.map((role) => `provider_${role}`));

export const ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS = readonlySet(["artifact_image_provider"]);

export const SKILL_SETTING_PREFIX = "skill_enabled:";

// ── Project database (opt-in agent SQL access) ──────────────────────────────
// These are synthetic settings rows: they render in the admin settings UI but
// persist to the per-repo orchestrator.db (via the project-db accessor), NOT to
// the account.db settings catalog. The password row is masked and never shown.
export const PROJECT_DB_TYPE_OPTIONS = Object.freeze(PROJECT_DB_TYPES.map((value) => Object.freeze({ value, label: value })));

export const PROJECT_DB_PERMISSION_LABELS = Object.freeze({
  read: "read (SELECT, inspection)",
  write: "write (UPDATE, INSERT, DELETE, CREATE, ALTER)",
});

export const PROJECT_DB_PERMISSION_OPTIONS = Object.freeze(PROJECT_DB_PERMISSIONS.map((value) => Object.freeze({
  value,
  label: PROJECT_DB_PERMISSION_LABELS[value],
})));

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

export const PROJECT_DB_SETTING_KEYS = readonlySet(PROJECT_DB_SETTING_DEFS.map((def) => def.key));

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
  Object.freeze({ provider: "claude", label: "Claude", settingKeys: Object.freeze(["claude_run_budget_pct_session"]) }),
  Object.freeze({ provider: "anthropic", label: "Anthropic API", settingKeys: Object.freeze([]) }),
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
  Object.freeze({ key: "ANTHROPIC_API_KEY", label: "Anthropic API key", description: "Used by the direct Anthropic Messages API provider. Set it in your environment; Posse never stores or shows it.", env: "ANTHROPIC_API_KEY" }),
  Object.freeze({ key: "OPENAI_API_KEY", label: "OpenAI API key", description: "Used by the OpenAI provider and, in API mode, by Codex. Set it in your environment; Posse never stores or shows it.", env: "OPENAI_API_KEY" }),
  Object.freeze({ key: "CODEX_API_KEY", label: "Codex API key", description: "Optional key for Codex API mode. Set it in your environment; Posse never stores or shows it.", env: "CODEX_API_KEY" }),
  Object.freeze({ key: "XAI_API_KEY", label: "xAI API key", description: "Used by the Grok provider. Set it in your environment; Posse never stores or shows it.", env: "XAI_API_KEY" }),
  Object.freeze({ key: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude OAuth token", description: "Optional Claude login token for headless machines. Set it in your environment; Posse never stores or shows it.", env: "CLAUDE_CODE_OAUTH_TOKEN" }),
]);

export const TURN_BASE_KEY_MAP = Object.freeze({
  max_turns_researcher: "base_turns_researcher",
  max_turns_planner: "base_turns_planner",
  max_turns_dev: "base_turns_dev",
  max_turns_assessor: "base_turns_assessor",
});

export const TURN_BASE_KEY_REVERSE_MAP = Object.freeze(
  Object.fromEntries(Object.entries(TURN_BASE_KEY_MAP).map(([from, to]) => [to, from]))
);

// Storage keys are intentionally stable machine identifiers. The admin UI
// presents a separate operator-facing label so changing the wording never
// breaks persisted settings, environment overrides, or automation.
export const ADMIN_SETTING_LABEL_OVERRIDES = Object.freeze({
  // General
  plan_approval_mode: "Plan approval",
  auto_merge_completed: "Auto-merge approved work",
  scheduler_concurrency: "Concurrent jobs",
  scheduler_max_active_worktrees: "Active work item limit",
  scheduler_implementation_reserved_slots: "Slots kept for planned work",
  startup_dirty_tree_policy: "Uncommitted changes at startup",
  startup_update_mode: "Startup update mode",
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
  test_strictness: "Test strictness",
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
  research_claim_review: "Research claim review",
  final_review_mode: "Developer final review",
  research_traversal_completion_check: "Traversal completion check",
  research_traversal_completion_max_chars: "Traversal check text limit",
  research_synthesis_max_physical_calls: "Researcher tool-call ceiling",
  research_budget_visibility: "Researcher budget visibility",
  atlas_ambient_ref_stamping: "Reusable result references",
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
  planner_research_result_chars: "Research helper result target",
  planner_research_expand_chars: "Source expansion budget",
  planner_dispatch_triage_max_turns: "Planner direct-read turns",
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
export const ADMIN_SETTING_DESCRIPTION_OVERRIDES = Object.freeze({
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
  test_strictness: "Permissive lets work pass when tests are missing, unavailable, or report zero cases. Strict requires verification and may ask for review. Actual test failures still count in either mode.",
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
  research_claim_review: "Check research claims against their cited sources after the report is written. Shadow records findings and cost; the report is never edited.",
  final_review_mode: "Before a developer hands off finished work, run its planned tests and an independent review, and return the findings so it can fix them first.",
  research_traversal_completion_check: "Check whether a researcher or developer skipped part of the code it was tracing before it hands off. Shadow records; on adds guidance to the handoff.",
  research_traversal_completion_max_chars: "Maximum characters of traversal-check guidance added to one handoff.",
  research_synthesis_max_physical_calls: "Ceiling on tool calls a researcher may make in one attempt. Other research limits are unchanged; each session reads it once at start.",
  research_budget_visibility: "When a researcher sees its tool-call budget: countdown shows the remaining calls near the end; always states the total up front and the remaining count after every call.",
  atlas_ambient_ref_stamping: "Make more ATLAS results reusable by reference, including small ones. Off keeps references for results over 4,000 characters.",
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
  planner_research_result_chars: "Target characters per research helper; longer reports are delivered in full and use more planner context.",
  planner_research_expand_chars: "Characters of source briefs expanded automatically across one research batch. 0 turns expansion off.",
  planner_dispatch_triage_max_turns: "Planner-owned read turns available after choosing the direct/simple path; research dispatch should happen before these reads.",
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
export const ADMIN_UNSET_VALUE_LABELS = Object.freeze({
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
export const ADMIN_SETTING_UNIT_OVERRIDES = Object.freeze({
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

export const ADMIN_LABEL_WORDS = Object.freeze({
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

// What each agent role does, for role-pattern descriptions.
export const ADMIN_ROLE_PURPOSES = Object.freeze({
  researcher: "investigate the codebase before planning",
  planner: "turn research into a task plan",
  dev: "write and fix the code",
  artificer: "produce non-code artifacts such as images",
  preflight: "triage each new request",
  assessor: "review and verify finished work",
});

// ── Admin settings panes & groups ───────────────────────────────────────────
//
// The admin TUI settings tab is split into panes (switched with ←/→), ordered
// by how often operators reach for them: everyday workflow first, internals
// last. Advanced is opened explicitly rather than included in normal pane
// rotation. Each group below belongs to exactly one pane and renders its `keys`
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
  Object.freeze({ id: "debug", label: "Advanced", advanced: true }),
]);

export const ADMIN_DEFAULT_SETTINGS_PANE = "general";
