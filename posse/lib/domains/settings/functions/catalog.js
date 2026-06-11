// lib/settings-catalog.js — Single source of truth for every account setting.
//
// Adding a new setting? Add it here. The default seeds into ~/.posse/account.db
// on first open via INSERT OR IGNORE, so every key is visible immediately.
//
// Conventions:
// - default: empty string ("") means "no override; let calling code use its
//   computed fallback or a provider/tier default". A non-empty default
//   ("true", "4", "claude") becomes the actual value used at runtime.
// - description: shown in admin TUI and used to document settings on disk.
// - adminVisible: false documents internal settings that must stay hidden
//   while remaining available to runtime code. Otherwise catalog entries are
//   admin-visible by default, and specialized admin sections can still filter
//   provider/model/internal rows into their own renderers.

import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_TIERS as MODEL_TIER_NAMES,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  getDefaultTierModel,
} from "../../providers/functions/model-catalog.js";
import { PROVIDER_ROLE_SETTING_DEFS } from "../../providers/functions/roles.js";

// Value enums for individual settings live in the catalogue (split by domain
// — generic settings in lib/catalog/settings.js, ATLAS-specific in
// lib/catalog/atlas.js). Imported here for use inside SETTINGS_CATALOG below
// and re-exported so admin UI / validation imports keep their existing paths.
import {
  CLAUDE_EXECUTION_MODE_VALUES,
  CODEX_AUTH_MODE_OPTIONS,
  DELEGATION_MODE_VALUES,
  FIX_SCOPE_HANDOFF_GUARD_VALUES,
  HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES,
  KAIZEN_TO_ATLAS_MODE_VALUES,
  LOG_LEVEL_VALUES,
  MODEL_CATALOG_ENFORCEMENT_VALUES,
  PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES,
  POSSE_REMOTE_MODE_VALUES,
  RESEARCH_FANOUT_MODE_VALUES,
  ATLAS_MEMORY_SURFACE_MODE_VALUES,
  SESSION_RECYCLE_MODE_VALUES,
  STARTUP_DIRTY_TREE_POLICY_VALUES,
} from "../../../catalog/settings.js";
import {
  ATLAS_AUTO_FEEDBACK_VALUES,
  ATLAS_BOOT_REINDEX_POLICY_VALUES,
  ATLAS_MODE_VALUES,
  ATLAS_PHASE_VALUES,
  ATLAS_REMOTE_ENCODER_MODE_VALUES,
  ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  ATLAS_SCIP_MODE_VALUES,
  ATLAS_SCIP_RESTAGE_POLICY_VALUES,
  ATLAS_TREE_COMPRESSION_MODE_VALUES,
  ATLAS_TRANSPORT_VALUES,
  ATLAS_V2_MODE_VALUES,
  ATLAS_VECTOR_BACKEND_VALUES,
  ATLAS_WI_EMBEDDINGS_VALUES,
} from "../../../catalog/atlas.js";

export {
  CLAUDE_EXECUTION_MODE_VALUES,
  CODEX_AUTH_MODE_OPTIONS,
  DELEGATION_MODE_VALUES,
  FIX_SCOPE_HANDOFF_GUARD_VALUES,
  HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES,
  KAIZEN_TO_ATLAS_MODE_VALUES,
  LOG_LEVEL_VALUES,
  MODEL_CATALOG_ENFORCEMENT_VALUES,
  PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES,
  POSSE_REMOTE_MODE_VALUES,
  RESEARCH_FANOUT_MODE_VALUES,
  ATLAS_MEMORY_SURFACE_MODE_VALUES,
  SESSION_RECYCLE_MODE_VALUES,
  STARTUP_DIRTY_TREE_POLICY_VALUES,
  ATLAS_AUTO_FEEDBACK_VALUES,
  ATLAS_BOOT_REINDEX_POLICY_VALUES,
  ATLAS_MODE_VALUES,
  ATLAS_PHASE_VALUES,
  ATLAS_REMOTE_ENCODER_MODE_VALUES,
  ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  ATLAS_SCIP_MODE_VALUES,
  ATLAS_SCIP_RESTAGE_POLICY_VALUES,
  ATLAS_TREE_COMPRESSION_MODE_VALUES,
  ATLAS_TRANSPORT_VALUES,
  ATLAS_V2_MODE_VALUES,
  ATLAS_VECTOR_BACKEND_VALUES,
  ATLAS_WI_EMBEDDINGS_VALUES,
};

function buildModelSelectionSettings() {
  const entries = [];
  for (const provider of PROVIDER_OPTIONS) {
    for (const tier of MODEL_TIER_NAMES) {
      const fallbackModel = getDefaultTierModel(provider, tier);
      entries.push({
        key: `${provider}_model_${tier}`,
        default: "",
        description: `${PROVIDER_LABELS[provider]} model for ${tier} tier${fallbackModel ? ` (empty = ${fallbackModel})` : ""}`,
      });
    }
  }
  for (const option of IMAGE_PROVIDER_OPTIONS) {
    entries.push({
      key: `${option.value}_image_model`,
      default: "",
      description: `${PROVIDER_LABELS[option.value]} image generation model`,
    });
  }
  return entries;
}

const MODEL_SELECTION_SETTINGS = Object.freeze(buildModelSelectionSettings());

export const SETTINGS_CATALOG = [
  // ── Provider routing ─────────────────────────────────────────────────────
  // Provider keys default empty so admin code falls through persisted setting
  // before using the hardcoded default.
  ...PROVIDER_ROLE_SETTING_DEFS,
  { key: "delegation_mode",     default: "js", options: DELEGATION_MODE_VALUES, description: "Delegation engine mode: js or ml" },

  // ── Model selection (empty = use provider tier default) ──────────────────
  ...MODEL_SELECTION_SETTINGS,
  { key: "artifact_image_provider", default: "", description: "Provider used for image artifacts (openai or grok)" },

  // ── Remote model catalog (fetched from posse-remote /v1/catalog/models) ──
  { key: "model_catalog_cache_ms", default: "86400000", numeric: { integer: true, min: 60000 }, description: "Milliseconds to cache the remote model catalog before refreshing (default 24h)" },
  { key: "model_catalog_enforcement", default: "warn_and_fallback", options: MODEL_CATALOG_ENFORCEMENT_VALUES, description: "Stale configured-model handling: warn_and_fallback substitutes the tier default at runtime, warn_only keeps the configured model, off disables validation" },
  { key: "model_catalog_json", default: "", adminVisible: false, description: "Cached remote model/pricing catalog payload (auto-updated)" },
  { key: "model_catalog_fetched_at", default: "", adminVisible: false, description: "Timestamp of the last successful model catalog fetch (auto-updated)" },

  // ── Token caps and observed-usage calibration ────────────────────────────
  { key: "claude_limit_tokens_session", default: "", numeric: { integer: true, min: 0 }, description: "Token cap for Claude's 5-hour rolling window" },
  { key: "claude_limit_tokens_week",    default: "", numeric: { integer: true, min: 0 }, description: "Token cap for Claude's 7-day rolling window" },
  { key: "claude_observed_pct_session", default: "", numeric: { integer: false, min: 0, max: 100 }, description: "Observed Claude session usage % (calibrates 5-hour cap)" },
  { key: "claude_observed_pct_week",    default: "", numeric: { integer: false, min: 0, max: 100 }, description: "Observed Claude weekly usage % (calibrates 7-day cap)" },
  { key: "openai_limit_tokens_session", default: "", numeric: { integer: true, min: 0 }, description: "Token cap for OpenAI's session window" },
  { key: "openai_limit_tokens_week",    default: "", numeric: { integer: true, min: 0 }, description: "Token cap for OpenAI's weekly window" },
  { key: "openai_observed_pct_session", default: "", numeric: { integer: false, min: 0, max: 100 }, description: "Observed OpenAI session usage % calibration" },
  { key: "openai_observed_pct_week",    default: "", numeric: { integer: false, min: 0, max: 100 }, description: "Observed OpenAI weekly usage % calibration" },
  { key: "openai_account_limit_tokens_session", default: "", numeric: { integer: true, min: 0 }, description: "Hard OpenAI account-level session token cap" },
  { key: "openai_account_limit_tokens_week",    default: "", numeric: { integer: true, min: 0 }, description: "Hard OpenAI account-level weekly token cap" },
  { key: "openai_daily_budget_usd", default: "", numeric: { integer: false, min: 0 }, description: "OpenAI daily spend budget in USD (empty = no dashboard budget bar)" },
  { key: "grok_daily_budget_usd",   default: "", numeric: { integer: false, min: 0 }, description: "Grok daily spend budget in USD (empty = no dashboard budget bar)" },
  { key: "claude_usage_cache_ms", default: "120000", numeric: { integer: true, min: 1000 }, description: "Milliseconds to cache Claude usage summaries before refreshing" },
  { key: "claude_usage_backoff_ms", default: "300000", numeric: { integer: true, min: 1000 }, description: "Milliseconds to wait before retrying Claude usage refresh after an error" },
  { key: "codex_usage_cache_ms", default: "120000", numeric: { integer: true, min: 1000 }, description: "Milliseconds to cache Codex usage summaries before refreshing" },
  { key: "codex_usage_backoff_ms", default: "300000", numeric: { integer: true, min: 1000 }, description: "Milliseconds to wait before retrying Codex usage refresh after an error" },

  // ── Hidden runtime tracking (live usage state, written by providers) ─────
  { key: "claude_session_tokens",        default: "", adminVisible: false, description: "Live Claude session token count (auto-updated)" },
  { key: "claude_session_max",           default: "", adminVisible: false, description: "Live Claude session token max (auto-updated)" },
  { key: "claude_session_reset_at",      default: "", adminVisible: false, description: "Live Claude session reset timestamp (auto-updated)" },
  { key: "claude_weekly_tokens",         default: "", adminVisible: false, description: "Live Claude weekly token count (auto-updated)" },
  { key: "claude_weekly_max",            default: "", adminVisible: false, description: "Live Claude weekly token max (auto-updated)" },
  { key: "claude_weekly_reset_at",       default: "", adminVisible: false, description: "Live Claude weekly reset timestamp (auto-updated)" },
  { key: "claude_usage_subscription_type", default: "", adminVisible: false, description: "Detected Claude subscription type (auto-updated)" },
  { key: "claude_usage_rate_limit_tier", default: "", adminVisible: false, description: "Detected Claude rate limit tier (auto-updated)" },
  { key: "claude_usage_source",          default: "", adminVisible: false, description: "Source of last Claude usage observation (auto-updated)" },
  { key: "claude_usage_last_updated",    default: "", adminVisible: false, description: "Last Claude usage update timestamp (auto-updated)" },
  ...PROVIDER_OPTIONS.map((provider) => ({
    key: `${provider}_rate_limit_state`,
    default: "",
    adminVisible: false,
    description: `${PROVIDER_LABELS[provider]} persisted rate-limit cooldown state (auto-updated)`,
  })),

  // ── Scheduler ────────────────────────────────────────────────────────────
  { key: "scheduler_concurrency", default: "", runtimeFallback: "3", numeric: { integer: true, min: 1 }, description: "Default number of worker slots when --concurrency is not passed (empty = 3)" },
  { key: "scheduler_max_active_worktrees", default: "", numeric: { integer: true, min: 1 }, description: "Maximum number of active work-item worktrees the scheduler may run at once (empty = no cap)" },
  { key: "scheduler_poll_ms",     default: "500", numeric: { integer: true, min: 1 }, description: "Scheduler poll interval in milliseconds" },
  { key: "scheduler_repair_poll_ms", default: "5000", numeric: { integer: true, min: 1 }, description: "Fallback scheduler repair interval when no queue-state wake arrives" },
  { key: "default_lease_seconds", default: "120", numeric: { integer: true, min: 1 }, description: "Default job lease duration in seconds" },
  { key: "worker_lease_renew_max_transient_errors", default: "2", numeric: { integer: true, min: 0 }, description: "Transient lease-renewal errors tolerated before aborting a job" },
  { key: "posse_db_telemetry_tail_limit", default: "20", numeric: { integer: true, min: 0 }, description: "Recent event/observation telemetry rows kept in SQLite after file mirroring; 0 disables pruning" },
  { key: "posse_retention_days", default: "90", numeric: { integer: true, min: 0 }, description: "Days to retain runtime DB telemetry rows; 0 disables scheduled retention" },
  { key: "lease_requeue_grace_sec", default: "60", numeric: { integer: true, min: 0 }, description: "Grace seconds after lease expiry before requeueing held jobs" },
  { key: "worker_provider_circuit_ttl_ms", default: "300000", numeric: { integer: true, min: 1000 }, description: "Milliseconds a worker keeps a provider circuit open after fast repeated failures" },
  { key: "worktree_lock_wait_ms", default: "180000", numeric: { integer: true, min: 0 }, description: "Milliseconds to wait for a worker worktree lock before retrying without attempt penalty" },
  { key: "startup_dirty_tree_policy", default: "block", options: STARTUP_DIRTY_TREE_POLICY_VALUES, description: "Boot behavior when the target git tree is dirty: block startup or commit current work first" },
  { key: "git_atlas_post_commit_hook_timeout_ms", default: "600000", numeric: { integer: true, min: 1000 }, description: "Milliseconds to wait for the ATLAS post-commit hook during scoped git commits" },
  { key: "stall_timeout",         default: "", runtimeFallback: "600", numeric: { integer: true, min: 1 }, description: "Seconds before a stalled job is killed (empty = 600)" },
  { key: "max_job_runtime_sec",   default: "", numeric: { integer: true, min: 1 }, description: "Maximum seconds a job may run before runtime cancellation (empty = 2x stall_timeout)" },
  { key: "headless_human_timeout_sec", default: "600", numeric: { integer: true, min: 1 }, description: "Seconds to wait for human input in headless mode" },
  { key: "default_max_attempts",  default: "3", numeric: { integer: true, min: 1 }, description: "Default maximum attempts per job" },
  { key: "scheduler_shadow_conflict_metrics", default: "true", valueType: "boolean", description: "Emit shadow metrics for relaxed scheduler root-root conflicts that strict mode would block" },
  { key: "target_branch",         default: "", scope: "repo", description: "Repo merge target branch (empty = auto-detect current/upstream/remote default/main/master)" },
  { key: "session_recycle_mode",  default: "off", options: SESSION_RECYCLE_MODE_VALUES, description: "Session recycling mode: off, dev-fix, or full" },
  { key: "session_recycle_strict_provider", default: "true", valueType: "boolean", description: "Reset recycled lanes instead of resuming when a later job chooses a different provider" },
  { key: "posse_session_lease_ttl", default: "300", numeric: { integer: true, min: 1 }, description: "Seconds before a recycled session lease is released" },

  // ── Pipeline / escalation limits ─────────────────────────────────────────
  { key: "posse_wi_failure_threshold", default: "5", numeric: { integer: true, min: 1 }, description: "Failed dev/fix jobs per work item before assessor escalates to human_input" },
  { key: "posse_max_fix_chain_depth", default: "2", numeric: { integer: true, min: 1 }, description: "Maximum fix-chain depth (fix→fix→fix…) before escalating to human_input" },
  { key: "posse_max_replans", default: "3", numeric: { integer: true, min: 1 }, description: "Maximum needs_replan loops per work item before escalating to human_input" },
  { key: "posse_max_file_request_depth", default: "2", numeric: { integer: true, min: 0 }, description: "Maximum follow-up depth for dev file-request approval chains" },
  { key: "file_request_low_risk_extensions", default: "", description: "Comma-separated extensions to treat as low-risk file creation requests; protected, package, and CI paths remain high-risk" },
  { key: "posse_fanout_child_timeout_sec", default: "1200", numeric: { integer: true, min: 1 }, description: "Seconds a fanout research child may sit in queued status before being marked timed-out so synthesis can proceed" },
  { key: "posse_display_max_events", default: "250", numeric: { integer: true, min: 10 }, description: "Maximum live events held in the terminal UI ring buffer" },
  { key: "posse_display_event_rate_limit_per_sec", default: "300", numeric: { integer: true, min: 10 }, description: "Per-second event rate above which the terminal UI starts dropping events to stay responsive" },

  // ── Bridge ───────────────────────────────────────────────────────────────
  // Identity is repo-scoped: each repo is its own relay instance so one
  // machine can expose N posse sessions to the phone. The LAN token, bind
  // host, and relay URL stay machine-global.
  { key: "bridge_port", default: "", scope: "repo", numeric: { integer: true, min: 1, max: 65535 }, description: "Loopback port for this repo's Posse bridge (empty = auto-pick 7531+)" },
  { key: "bridge_label", default: "", scope: "repo", description: "Optional display label for this repo's Posse bridge instance" },
  { key: "bridge_bind_host", default: "127.0.0.1", adminVisible: false, description: "Bind host for the local Posse bridge" },
  { key: "bridge_local_token", default: "", adminVisible: false, description: "Bearer token for local Posse bridge clients" },
  { key: "bridge_instance_id", default: "", scope: "repo", adminVisible: false, description: "Stable Posse bridge instance identifier for this repo" },
  { key: "bridge_relay_token", default: "", scope: "repo", adminVisible: false, description: "Bearer token for this repo's Posse relay bridge connection" },
  { key: "bridge_relay_url", default: "wss://app.yourposseai.com/v1/instance", adminVisible: false, description: "Relay WebSocket URL for the Posse bridge" },
  { key: "bridge_identity_migrated_to", default: "", adminVisible: false, description: "Project dir that claimed the legacy machine-global bridge identity (auto-updated)" },

  // ── Behaviors ────────────────────────────────────────────────────────────
  { key: "auto_merge_completed", default: "false", valueType: "boolean", description: "Auto-merge work items that pass assessment" },
  { key: "claude_execution_mode", default: "print", options: CLAUDE_EXECUTION_MODE_VALUES, description: "Claude execution mode: print uses claude -p stream-json; interactive uses a PTY session and Claude session/log idle state" },
  { key: "codex_auth_mode",      default: "oauth", options: CODEX_AUTH_MODE_OPTIONS, description: "Codex auth mode (oauth, api, or auto). oauth/auto never fall back to API keys; api must be explicit." },
  { key: "codex_cli_path",       default: "",      adminVisible: false, description: "Explicit path to Codex CLI binary (empty = auto-detect)" },
  { key: "pre_assess_cmd",       default: "",      description: "Optional shell command to run before assessment" },
  { key: "pre_push_verify_cmd",  default: "",      description: "Optional shell command to run before pushing" },
  { key: "posse_log_scrub_secrets", default: "true", valueType: "boolean", description: "Scrub secret-looking values from prompt and output logs" },
  { key: "posse_log_level",        default: "info", options: LOG_LEVEL_VALUES, description: "Minimum runtime file-log level: debug, info, warn, or error" },
  { key: "skip_hooks",           default: "false", valueType: "boolean", description: "Skip all deterministic safety hooks" },
  { key: "skip_hook_secrets_scan", default: "false", valueType: "boolean", description: "Skip the staged secret scan hook" },
  { key: "skip_hook_post_dev_verify", default: "false", valueType: "boolean", description: "Skip the post-dev verification hook" },
  { key: "skip_hook_pre_push_gate", default: "false", valueType: "boolean", description: "Skip the pre-push gate hook" },
  { key: "worktree_clean_ignored", default: "false", valueType: "boolean", description: "Clean ignored files when resetting worker worktrees" },
  { key: "snapshot_retention_days", default: "30", numeric: { integer: true, min: 0 }, description: "Days to retain recovered dirty-worktree snapshots" },
  { key: "snapshot_max_bytes", default: "2147483648", numeric: { integer: true, min: 0 }, description: "Maximum recovered snapshot storage bytes" },
  { key: "snapshot_max_refs", default: "500", numeric: { integer: true, min: 0 }, description: "Maximum recovered snapshot refs to retain" },
  { key: "snapshot_dedup", default: "true", valueType: "boolean", description: "Reuse duplicate recovered dirty-worktree snapshots" },
  { key: "web_tools_enabled",    default: "true", valueType: "boolean", description: "Allow web research tools (Claude WebSearch/WebFetch, Codex web_search) for researcher & artificer roles" },
  { key: "research_fanout",      default: "off", options: RESEARCH_FANOUT_MODE_VALUES, description: "Research fanout mode for preflight fanout-clear decisions (off, shadow, on)" },
  { key: "plan_approval_mode",   default: "false", valueType: "boolean", description: "Require human approval before executing plans" },
  { key: "disable_system_tools", default: "true", valueType: "boolean", adminVisible: false, description: "Disable Claude's native Read/Write/Grep/Glob/Edit/Bash; agents use only the deterministic MCP + ATLAS tool surface" },

  // ── Assessor tuning ──────────────────────────────────────────────────────
  { key: "assessor_fallback_reads",                default: "4", numeric: { integer: true, min: 0 }, description: "Extra assessor fallback file reads allowed during verification before retrying (read on attempt 1 if dev didn't surface output)" },
  { key: "assessor_fallback_reads_retry_step",     default: "2", numeric: { integer: true, min: 0 }, description: "Additional fallback reads added per retry attempt" },
  { key: "assessor_internal_retry_limit",          default: "2", numeric: { integer: true, min: 0 }, description: "Internal retry limit before failing assessment" },
  { key: "assessor_parse_retry_input_tokens_cap",  default: "", numeric: { integer: true, min: 1 }, description: "Input token cap for parse-error retries (empty = no cap)" },

  // ── Handoff / planner ────────────────────────────────────────────────────
  { key: "handoff_max_prompt_chars", default: "600000", numeric: { integer: true, min: 1 }, description: "Maximum characters in a single agent prompt" },
  { key: "handoff_max_context_chars", default: "", numeric: { integer: true, min: 1 }, description: "Maximum characters for rendered handoff file context before optional sections are dropped (empty = derived from prompt cap)" },
  { key: "handoff_preload_editable_file_bodies", default: "off", options: HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES, description: "Editable file body preload mode: off, small, or always. Merge-conflict handoffs force preload so conflict markers remain visible." },
  { key: "fix_scope_handoff_guard", default: "enforce", options: FIX_SCOPE_HANDOFF_GUARD_VALUES, description: "Fix handoff scope broadening mode: off, warn, or enforce" },
  { key: "handoff_max_file_bytes", default: "150000", numeric: { integer: true, min: 1 }, description: "Maximum bytes to preload from a single handoff file" },
  { key: "handoff_max_preload_total_bytes", default: "80000", numeric: { integer: true, min: 1 }, description: "Maximum cumulative bytes to bulk-preload from source files for no-read handoffs" },
  { key: "handoff_max_related_files_total_bytes", default: "400000", numeric: { integer: true, min: 1 }, description: "Maximum cumulative bytes to preload from related handoff files" },
  { key: "posse_remote_mode", default: "required", options: POSSE_REMOTE_MODE_VALUES, description: "Remote prompt compiler mode. Required is the only supported mode; local prompt generation fallback has been removed." },
  { key: "posse_remote_url", default: "", description: "Remote prompt compiler base URL (empty = https://api.yourposseai.com)" },
  { key: "posse_remote_timeout_ms", default: "", runtimeFallback: "60000", numeric: { integer: true, min: 100 }, description: "Remote prompt compiler request timeout in milliseconds (empty = 60000)" },
  { key: "context_expand_max_steps", default: "2", numeric: { integer: true, min: 0 }, description: "Maximum in-attempt MISSING_CONTEXT expansion retries per agent call" },
  { key: "context_expand_file_budget_per_attempt", default: "8", numeric: { integer: true, min: 0 }, description: "Maximum distinct files auto-added from MISSING_CONTEXT per attempt" },
  { key: "skills_enabled", default: "true", valueType: "boolean", description: "Enable planner-selected skill attachments for dev jobs" },
  { key: "skills_disabled_ids", default: "", description: "Skill ids disabled by admin; new skills are enabled by default" },
  { key: "planner_max_tasks",        default: "50", numeric: { integer: true, min: 1 }, description: "Maximum tasks the planner is allowed to emit" },
  { key: "planner_under_scoped_broad_gate", default: "warn", options: PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES, description: "Broad under-scoped gate mode: off, warn, or enforce" },

  // ── Max turns per role (empty = use computed base) ───────────────────────
  { key: "max_turns_researcher", default: "", numeric: { integer: true, min: 1 }, description: "Override base turn count for researcher" },
  { key: "max_turns_planner",    default: "", numeric: { integer: true, min: 1 }, description: "Override base turn count for planner" },
  { key: "max_turns_dev",        default: "", numeric: { integer: true, min: 1 }, description: "Override base turn count for dev" },
  { key: "max_turns_assessor",   default: "", numeric: { integer: true, min: 1 }, description: "Override base turn count for assessor" },

  // ── ATLAS integration ──────────────────────────────────────────────────────
  { key: "atlas_mode",                    default: "preferred",          options: ATLAS_MODE_VALUES, adminVisible: false, description: "Legacy ATLAS authority mode. preferred is the default alias for ATLAS v2 on." },
  { key: "atlas_v2",                      default: "on",                 options: ATLAS_V2_MODE_VALUES, description: "ATLAS v2 backend mode: on/v2 by default; off disables ATLAS" },
  { key: "atlas_parse_max_parallel",       default: "",                   numeric: { integer: true, min: 1 }, adminVisible: false, description: "Internal Atlas Parse maximum concurrent SCIP-stage subprocesses (empty = computed from languages and CPU)" },
  { key: "atlas_parse_per_lang_tandem",    default: "true",               valueType: "boolean", adminVisible: false, description: "Internal Atlas Parse tandem tree-sitter/SCIP staging flag" },
  { key: "atlas_parse_file_progress_throttle_ms", default: "100",         numeric: { integer: true, min: 0 }, adminVisible: false, description: "Internal Atlas Parse filename progress throttle in milliseconds; 0 emits every event" },
  { key: "atlas_parse_band_max_rows",      default: "8",                  numeric: { integer: true, min: 1 }, adminVisible: false, description: "Internal Atlas Parse terminal band maximum row count" },
  { key: "atlas_parse_onnx_background_initial", default: "true",          valueType: "boolean", adminVisible: false, description: "Internal Atlas Parse initial ONNX embedding background flag" },
  { key: "atlas_parse_onnx_background_batch_size", default: "128",        numeric: { integer: true, min: 1 }, adminVisible: false, description: "Internal Atlas Parse background ONNX embedding batch size" },
  // Native (Rust) binary delegation. Git and ATLAS are hardwired native in
  // BinaryManager (no setting, no env override, no JS path); the keys below
  // only gate tools still mid-migration, and only take effect when a compiled
  // build is staged for the host os/arch (BinaryManager.shouldUse). Runtime
  // env overrides POSSE_NATIVE_BINARIES / POSSE_NATIVE_<TOOL> win.
  { key: "posse_native_remote",           default: "true",               valueType: "boolean", adminVisible: false, description: "Delegate authenticated Posse remote prompt/catalog HTTP calls to the native posse-remote binary when present" },
  { key: "posse_native_heartbeat_url",    default: "",                   adminVisible: false, description: "Heartbeat URL passed explicitly to key-gated native Posse binaries" },
  { key: "posse_native_heartbeat_public_key_url", default: "",           adminVisible: false, description: "Optional heartbeat public-key discovery URL passed explicitly to native Posse binaries" },
  { key: "posse_native_heartbeat_jwt_public_key", default: "",           adminVisible: false, description: "Ed25519 JWT public key passed explicitly to native Posse binaries" },
  { key: "posse_native_heartbeat_jwt_public_key_sha256", default: "",     adminVisible: false, description: "Pinned SHA-256 fingerprint for native Posse binary heartbeat public-key trust" },
  { key: "posse_native_heartbeat_jwt_audience", default: "",             adminVisible: false, description: "Optional JWT audience override passed explicitly to native Posse binaries" },
  { key: "posse_native_heartbeat_timeout_seconds", default: "",          numeric: { integer: true, min: 1 }, adminVisible: false, description: "Timeout in seconds for native Posse binary heartbeat requests" },
  { key: "atlas_scip_mode",               default: "on",                 options: ATLAS_SCIP_MODE_VALUES, description: "ATLAS v2 SCIP mode: off, on, on-demand, or both. on stages/consumes .scip indexes during warmup." },
  { key: "atlas_scip_languages",          default: ATLAS_SCIP_LANGUAGE_VALUES.join(","), options: ATLAS_SCIP_LANGUAGE_OPTIONS, multi: true, description: "Enabled SCIP indexer languages. Saving this selector installs Posse-managed deps for the selected languages." },
  { key: "atlas_scip_index_command",      default: "",                   description: "Optional override for the central Posse SCIP indexer registry (empty = auto-detect Posse-managed indexers)" },
  { key: "atlas_scip_index_args",         default: "",                   description: "Arguments for atlas_scip_index_command. Supports {output}, {repoRoot}, and {scipDir} placeholders" },
  { key: "atlas_scip_index_timeout_ms",   default: "360000",             numeric: { integer: true, min: 1000 }, description: "Maximum time to wait for a SCIP indexer child process during boot/warmup (default 6min — generous so I/O or CPU contention during boot doesn't masquerade as a hang)" },
  { key: "atlas_scip_cold_index_timeout_ms", default: "1800000",         numeric: { integer: true, min: 1000 }, description: "Maximum time to wait when a SCIP language has no canonical output or the previous staging attempt failed (default 30min — first-index on a large repo can take a while)" },
  { key: "atlas_scip_restage_policy",     default: "smart",              options: ATLAS_SCIP_RESTAGE_POLICY_VALUES, description: "SCIP restage policy: never, missing, smart, or always" },
  { key: "atlas_scip_max_age_hours",      default: String(ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT), numeric: { integer: true, min: 0 }, description: "Maximum age in hours before smart SCIP restage refreshes an otherwise unchanged index" },
  { key: "atlas_phases",                  default: ATLAS_PHASE_VALUES.join(","), options: ATLAS_PHASE_VALUES, multi: true, description: "ATLAS phases: research, planning, assessment, dev" },
  { key: "atlas_live_funnel",             default: "true",               valueType: "boolean", description: "Whether ATLAS actively injects context into prompts" },
  { key: "atlas_auto_feedback",           default: "write",              options: ATLAS_AUTO_FEEDBACK_VALUES, description: "Emit ATLAS agent.feedback at job end: off, dry-run, or write" },
  { key: "atlas_live_index",              default: "true",               valueType: "boolean", description: "Enable ATLAS live index overlays so long-running jobs see in-progress edits" },
  { key: "atlas_live_buffers",            default: "true",               valueType: "boolean", description: "Push deterministic write/edit buffers into ATLAS during dev jobs" },
  { key: "atlas_memory_surface",          default: "auto",               options: ATLAS_MEMORY_SURFACE_MODE_VALUES, description: "Surface promoted ATLAS memories in handoffs. auto = on once at least one promoted memory exists in this project; off = never surface; on = always attempt to surface." },
  { key: "posse_kaizen_to_atlas",         default: "shadow",             options: KAIZEN_TO_ATLAS_MODE_VALUES, description: "Promote Posse Kaizen insights to ATLAS memory: off, shadow, or write" },
  { key: "atlas_semantic_enabled",        default: "true",               valueType: "boolean", description: "Enable ATLAS semantic search dispatch (default on, backed by the local ONNX jina-v2-code encoder; FTS remains the fallback when the encoder is unavailable)" },
  { key: "atlas_vector_backend",          default: "auto",               options: ATLAS_VECTOR_BACKEND_VALUES, description: "ATLAS embedding vector backend: auto, usearch, or off" },
  { key: "atlas_wi_embeddings",           default: "on_demand",          options: ATLAS_WI_EMBEDDINGS_VALUES, description: "ATLAS WI embedding mode: off, on_demand, or on" },
  { key: "atlas_view_layer_merge",        default: "on",                 options: ["off", "on"], description: "ATLAS v2 order-independent view build: source view symbols/edges from per-source tree-sitter+SCIP layers (on, default) vs the legacy flat tables (off). Off is a fallback during the layer-merge rollout." },
  { key: "atlas_tree_compression_mode",   default: "ml",                 options: ATLAS_TREE_COMPRESSION_MODE_VALUES, description: "ATLAS tree compression seed mode: off, deterministic, or ml. ml runs an explicit one-time model enrichment pass over the cached tree seed snapshot." },
  { key: "atlas_tree_compression_provider", default: "", options: [{ value: "", label: "active (researcher provider)" }, ...PROVIDER_OPTIONS.map((provider) => ({ value: provider, label: PROVIDER_LABELS[provider] || provider }))], description: "Provider for the optional ATLAS tree compression ML pass (empty = active researcher provider)" },
  { key: "atlas_tree_compression_model_tier", default: "standard",       options: MODEL_TIER_NAMES, description: "Model tier for the optional ATLAS tree compression ML pass" },
  { key: "atlas_tree_compression_max_seeds", default: "80",              numeric: { integer: true, min: 1, max: 500 }, description: "Maximum ATLAS tree compression seeds stored in the cached snapshot" },
  { key: "atlas_tree_compression_model_max_seeds", default: "40",        numeric: { integer: true, min: 1, max: 200 }, description: "Maximum ATLAS tree compression seeds sent to the one-time ML enrichment pass" },
  { key: "atlas_embedding_provider",      default: "jina-v2-code",       description: "ATLAS embedding provider: jina-v2-code (default) uses the local ONNX encoder; empty/off disables embeddings; stub uses deterministic local vectors; openai-compatible uses the configured HTTP endpoint" },
  { key: "atlas_local_onnx_cache_dir",    default: "",                   adminVisible: false, description: "Optional local ONNX model cache directory (empty = repo .posse/atlas/models/onnx)" },
  { key: "atlas_embedding_endpoint",      default: "",                   description: "ATLAS embedding HTTP endpoint for openai-compatible providers" },
  { key: "atlas_embedding_model",         default: "",                   description: "ATLAS embedding model name for the configured embedding provider" },
  { key: "atlas_embedding_dim",           default: "",                   numeric: { integer: true, min: 1 }, description: "ATLAS embedding vector dimension for the configured model" },
  { key: "atlas_embedding_model_version", default: "",                   adminVisible: false, description: "Optional ATLAS embedding model-version override used to partition persisted vectors" },
  { key: "atlas_embedding_timeout_ms",    default: "90000",              numeric: { integer: true, min: 1000 }, adminVisible: false, description: "Maximum milliseconds to wait for ATLAS embedding provider requests (default 90s — covers slow first encode under contention)" },
  { key: "atlas_embedding_threads",       default: "2",                  numeric: { integer: true, min: 1, max: 8 }, description: "ATLAS local ONNX embedding worker threads. 2 is the measured default sweet spot; 1 disables encode fanout." },
  { key: "atlas_embedding_headers",       default: "",                   adminVisible: false, description: "Optional JSON object of non-secret HTTP headers for ATLAS embedding provider requests" },
  { key: "atlas_embedding_send_dimensions", default: "false",            valueType: "boolean", adminVisible: false, description: "Include the configured vector dimension in ATLAS embedding provider requests" },
  { key: "atlas_remote_encoder_mode",     default: "off",                options: ATLAS_REMOTE_ENCODER_MODE_VALUES, description: "ATLAS remote encoder mode: off, shadow, preferred, or required. When enabled, remote encoding sends repo paths, names, signatures, doc comments, body lead snippets, and query text for vectorization. Shadow keeps local vectors authoritative while comparing remote batches." },
  { key: "atlas_remote_encoder_url",      default: "",                   description: "Posse remote encoder base URL (empty = POSSE_ATLAS_REMOTE_ENCODER_URL or POSSE_REMOTE_URL)" },
  { key: "atlas_remote_encoder_model",    default: "",                   description: "Remote ATLAS encoder model name used for request hints and vector store partitioning" },
  { key: "atlas_remote_encoder_dim",      default: "",                   numeric: { integer: true, min: 1 }, description: "Remote ATLAS encoder vector dimension" },
  { key: "atlas_remote_encoder_model_version", default: "",              adminVisible: false, description: "Remote ATLAS encoder model version used to partition persisted vectors" },
  { key: "atlas_remote_encoder_timeout_ms", default: "90000",            numeric: { integer: true, min: 1000 }, adminVisible: false, description: "Maximum milliseconds to wait for remote ATLAS encoder requests (default 90s — generous to absorb network jitter)" },
  { key: "atlas_transport",               default: "v2",                 options: ATLAS_TRANSPORT_VALUES, adminVisible: false, description: "ATLAS transport: v2 native" },
  { key: "atlas_install_path",            default: "",                   adminVisible: false, description: "Deprecated ATLAS runtime path setting; ignored by v2 native ATLAS" },
  { key: "atlas_node_path",               default: "",                   adminVisible: false, description: "Deprecated ATLAS Node.js path setting; ignored by v2 native ATLAS" },
  { key: "atlas_command",                 default: "",                   adminVisible: false, description: "Deprecated ATLAS server command setting; ignored by v2 native ATLAS" },
  { key: "atlas_args",                    default: "",                   adminVisible: false, description: "Deprecated ATLAS server args setting; ignored by v2 native ATLAS" },
  { key: "atlas_url",                     default: "",                   adminVisible: false, description: "Deprecated ATLAS HTTP URL setting; ignored by v2 native ATLAS" },
  { key: "atlas_host",                    default: "",                   adminVisible: false, description: "Deprecated ATLAS HTTP host setting; ignored by v2 native ATLAS" },
  { key: "atlas_port",                    default: "",                   numeric: { integer: true, min: 1 }, adminVisible: false, description: "Deprecated ATLAS HTTP port setting; ignored by v2 native ATLAS" },
  { key: "atlas_server_name",             default: "",                   adminVisible: false, description: "MCP server name for ATLAS (default atlas-v2)" },
  { key: "atlas_boot_reindex_policy",     default: "smart",              options: ATLAS_BOOT_REINDEX_POLICY_VALUES, description: "Boot reindex: always, missing, or smart" },
  { key: "atlas_reindex_on_commit",       default: "true",               valueType: "boolean", description: "Install merge-only post-commit hook for incremental reindex" },
  { key: "atlas_drift_check",             default: "true",               valueType: "boolean", description: "Periodically check ATLAS graph drift against HEAD" },
  { key: "atlas_verbose_errors",          default: "false",              valueType: "boolean", adminVisible: false, description: "Include ATLAS error stacks in logs and skipped records" },
  { key: "atlas_drift_check_interval_ms", default: "",                   runtimeFallback: "600000", numeric: { integer: true, min: 60000 }, adminVisible: false, description: "ATLAS drift check interval in milliseconds" },
  { key: "atlas_v2_view_wait_ms",         default: "2500",               numeric: { integer: true, min: 0 }, adminVisible: false, description: "Maximum milliseconds ATLAS v2 proxy waits for a current view before reporting not-ready" },
  { key: "atlas_v2_auto_refresh_stale",   default: "true",               valueType: "boolean", adminVisible: false, description: "Allow ATLAS v2 proxy reads to queue a baseline main-view refresh when a stale view is detected" },
  { key: "atlas_tool_gate_enabled",       default: "true",               valueType: "boolean", description: "Hard-gate native file/search/read tools until agents make ATLAS retrieval attempts" },
  { key: "atlas_tool_gate_default_migrated_at", default: "",             adminVisible: false, description: "Internal migration marker for the ATLAS tool-gate default change" },
  { key: "atlas_v2_boot_timeout_ms",      default: "5400000",            numeric: { integer: true, min: 1000 }, adminVisible: false, description: "Maximum milliseconds to wait for ATLAS v2 boot/warm worker completion (default 90min — enough for a full first ONNX index on slower machines)" },
  { key: "atlas_handoff_prefetch_timeout_ms", default: "60000",          numeric: { integer: true, min: 1000 }, adminVisible: false, description: "Maximum milliseconds to wait for ATLAS handoff prefetch before deterministic fallback (default 60s — absorbs short restage/index contention)" },
  { key: "atlas_v2_boot_soft_timeout_ms", default: "15000",              numeric: { integer: true, min: 0 }, adminVisible: false, description: "Milliseconds before ATLAS boot warmup moves to background so scheduler boot can continue; 0 waits for completion" },
  { key: "atlas_embedded_timeout_ms",     default: "90000",              numeric: { integer: true, min: 1000 }, adminVisible: false, description: "Default timeout in milliseconds for embedded ATLAS tool calls (default 90s — survives contention)" },
  { key: "atlas_embedded_queue_wait_ms",  default: "90000",              numeric: { integer: true, min: 0 }, adminVisible: false, description: "Maximum milliseconds embedded ATLAS calls wait for protected ATLAS assets (default 90s)" },
  { key: "atlas_job_cache_ttl_ms",        default: "300000",             numeric: { integer: true, min: 0 }, adminVisible: false, description: "TTL in milliseconds for per-job embedded ATLAS result cache entries" },
  { key: "atlas_prefetch_cache_ttl_ms",   default: "600000",             numeric: { integer: true, min: 0 }, adminVisible: false, description: "TTL in milliseconds for ATLAS prefetch cache entries" },
  { key: "atlas_corruption_cooldown_ms",  default: "120000",             numeric: { integer: true, min: 0 }, adminVisible: false, description: "Cooldown in milliseconds after ATLAS graph corruption before retrying embedded ATLAS" },
  { key: "atlas_job_cache",               default: "true",               valueType: "boolean", adminVisible: false, description: "Cache repeated read-only embedded ATLAS tool results within a single job" },
];

// Quick-lookup map: key → default value.
export const SETTINGS_DEFAULTS = Object.freeze(
  Object.fromEntries(SETTINGS_CATALOG.map((entry) => [entry.key, entry.default])),
);

function normalizeCatalogOption(option) {
  if (option && typeof option === "object") {
    const value = String(option.value ?? "").trim();
    if (!value) return null;
    return Object.freeze({ value, label: String(option.label ?? value) });
  }
  const value = String(option ?? "").trim();
  return value ? Object.freeze({ value, label: value }) : null;
}

export function getCatalogEntry(key) {
  return SETTINGS_CATALOG.find((entry) => entry.key === key) || null;
}

export function getCatalogDefault(key) {
  const entry = getCatalogEntry(key);
  return entry ? entry.default : null;
}

export function getCatalogOptions(key) {
  const entry = getCatalogEntry(key);
  const options = Array.isArray(entry?.options) ? entry.options : [];
  return Object.freeze(options.map(normalizeCatalogOption).filter(Boolean));
}

export function getCatalogOptionValues(key) {
  return Object.freeze(getCatalogOptions(key).map((option) => option.value));
}

export function isCatalogBooleanSetting(key) {
  const entry = getCatalogEntry(key);
  if (!entry) return false;
  if (entry.valueType === "boolean") return true;
  const value = String(entry.default ?? "").trim().toLowerCase();
  return value === "true" || value === "false";
}

function getDynamicNumericRule(key) {
  const normalizedKey = String(key || "");
  if (/^[a-z0-9]+_(?:account_)?limit_tokens_(?:session|week)$/i.test(normalizedKey)) {
    return { integer: true, min: 0 };
  }
  if (/^[a-z0-9]+_observed_pct_(?:session|week)$/i.test(normalizedKey)) {
    return { integer: false, min: 0, max: 100 };
  }
  return null;
}

export function getCatalogNumericRule(key) {
  const entry = getCatalogEntry(key);
  const rule = entry?.numeric || getDynamicNumericRule(key);
  return rule ? Object.freeze({ ...rule }) : null;
}

function normalizeCatalogBooleanValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return "true";
  if (["false", "0", "no", "off"].includes(normalized)) return "false";
  return null;
}

function validateCatalogNumericValue(key, value, rule) {
  const trimmed = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `${key} must be a number.` };
  }
  const numberValue = Number(trimmed);
  if (!Number.isFinite(numberValue)) {
    return { ok: false, error: `${key} must be finite.` };
  }
  if (rule.integer && !Number.isInteger(numberValue)) {
    return { ok: false, error: `${key} must be an integer.` };
  }
  if (rule.min != null && numberValue < rule.min) {
    return { ok: false, error: `${key} must be at least ${rule.min}.` };
  }
  if (rule.max != null && numberValue > rule.max) {
    return { ok: false, error: `${key} must be at most ${rule.max}.` };
  }
  if (Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: `${key} is too large to store safely.` };
  }
  return { ok: true, value: rule.integer ? String(Math.trunc(numberValue)) : String(numberValue) };
}

export function validateCatalogSettingValue(key, value, { allowUnknown = true } = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return { ok: false, error: "Setting key is required." };
  const entry = getCatalogEntry(normalizedKey);
  const dynamicNumericRule = getDynamicNumericRule(normalizedKey);
  if (!entry && !dynamicNumericRule) {
    return allowUnknown
      ? { ok: true, key: normalizedKey, value: String(value ?? "") }
      : { ok: false, error: `Unknown setting: ${normalizedKey}` };
  }

  const rawValue = String(value ?? "");
  const trimmed = rawValue.trim();
  if (trimmed === "") return { ok: true, key: normalizedKey, value: "" };

  const options = getCatalogOptions(normalizedKey);
  if (options.length > 0) {
    const allowed = new Set(options.map((option) => option.value));
    if (entry.multi) {
      const picked = [...new Set(trimmed.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean))];
      const invalid = picked.filter((part) => !allowed.has(part));
      if (invalid.length > 0 || picked.length === 0) {
        return { ok: false, error: `${normalizedKey} must include one or more of: ${[...allowed].join(", ")}.` };
      }
      return { ok: true, key: normalizedKey, value: picked.join(",") };
    }
    const normalized = trimmed.toLowerCase();
    if (!allowed.has(normalized)) {
      return { ok: false, error: `${normalizedKey} must be one of: ${[...allowed].join(", ")}.` };
    }
    return { ok: true, key: normalizedKey, value: normalized };
  }

  if (isCatalogBooleanSetting(normalizedKey)) {
    const normalized = normalizeCatalogBooleanValue(trimmed);
    if (normalized == null) return { ok: false, error: `${normalizedKey} must be true or false.` };
    return { ok: true, key: normalizedKey, value: normalized };
  }

  const numericRule = getCatalogNumericRule(normalizedKey);
  if (numericRule) {
    const numeric = validateCatalogNumericValue(normalizedKey, trimmed, numericRule);
    return numeric.ok ? { ok: true, key: normalizedKey, value: numeric.value } : numeric;
  }

  return { ok: true, key: normalizedKey, value: rawValue };
}

export function getCatalogRuntimeFallback(key) {
  const entry = getCatalogEntry(key);
  if (!entry) return null;
  const fallback = entry.runtimeFallback ?? entry.default;
  return fallback == null || String(fallback).trim() === "" ? null : String(fallback);
}

export function getCatalogRuntimeFallbackInt(key, fallback = null) {
  const raw = getCatalogRuntimeFallback(key);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isCatalogKey(key) {
  return SETTINGS_CATALOG.some((entry) => entry.key === key);
}

export function isAdminVisibleCatalogKey(key) {
  const entry = getCatalogEntry(key);
  return !!entry && entry.adminVisible !== false;
}
