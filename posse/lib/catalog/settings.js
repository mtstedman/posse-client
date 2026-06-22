// Settings catalogue.
//
// Setting key names (SETTING_KEYS) and enumerated value lists for non-ATLAS
// settings. The settings catalogue in `lib/domains/settings/functions/catalog.js`
// references these to populate the admin UI and to validate persisted
// values. ATLAS-specific value lists live in `lib/catalog/atlas.js`.
//
// SETTING_KEYS exists so a typo in `getSetting("typo_here")` becomes a
// ReferenceError at import time instead of silently returning null and
// falling back to a default. New settings should be added here first, then
// referenced by name in SETTINGS_CATALOG and consumers.

export const SETTING_KEYS = Object.freeze({
  ASSESSOR_FALLBACK_READS: "assessor_fallback_reads",
  ASSESSOR_FALLBACK_READS_RETRY_STEP: "assessor_fallback_reads_retry_step",
  ASSESSOR_INTERNAL_RETRY_LIMIT: "assessor_internal_retry_limit",
  ASSESSOR_PARSE_RETRY_INPUT_TOKENS_CAP: "assessor_parse_retry_input_tokens_cap",
  AUTO_MERGE_COMPLETED: "auto_merge_completed",
  BRIDGE_BIND_HOST: "bridge_bind_host",
  BRIDGE_IDENTITY_MIGRATED_TO: "bridge_identity_migrated_to",
  BRIDGE_INSTANCE_ID: "bridge_instance_id",
  BRIDGE_LABEL: "bridge_label",
  BRIDGE_LOCAL_TOKEN: "bridge_local_token",
  MCP_OAUTH_SIGNING_KEY: "mcp_oauth_signing_key",
  BRIDGE_PORT: "bridge_port",
  BRIDGE_RELAY_TOKEN: "bridge_relay_token",
  BRIDGE_RELAY_URL: "bridge_relay_url",
  CONTEXT_EXPAND_FILE_BUDGET_PER_ATTEMPT: "context_expand_file_budget_per_attempt",
  CONTEXT_EXPAND_MAX_STEPS: "context_expand_max_steps",
  CLAUDE_EXECUTION_MODE: "claude_execution_mode",
  CLAUDE_USAGE_BACKOFF_MS: "claude_usage_backoff_ms",
  CLAUDE_USAGE_CACHE_MS: "claude_usage_cache_ms",
  CODEX_USAGE_BACKOFF_MS: "codex_usage_backoff_ms",
  CODEX_USAGE_CACHE_MS: "codex_usage_cache_ms",
  DEFAULT_MAX_ATTEMPTS: "default_max_attempts",
  DELEGATION_MODE: "delegation_mode",
  DISABLE_SYSTEM_TOOLS: "disable_system_tools",
  FILE_REQUEST_LOW_RISK_EXTENSIONS: "file_request_low_risk_extensions",
  FIX_SCOPE_HANDOFF_GUARD: "fix_scope_handoff_guard",
  HANDOFF_MAX_CONTEXT_CHARS: "handoff_max_context_chars",
  HANDOFF_MAX_PRELOAD_TOTAL_BYTES: "handoff_max_preload_total_bytes",
  HANDOFF_PRELOAD_EDITABLE_FILE_BODIES: "handoff_preload_editable_file_bodies",
  MODEL_CATALOG_JSON: "model_catalog_json",
  MODEL_CATALOG_FETCHED_AT: "model_catalog_fetched_at",
  MODEL_CATALOG_CACHE_MS: "model_catalog_cache_ms",
  MODEL_CATALOG_ENFORCEMENT: "model_catalog_enforcement",
  PLAN_APPROVAL_MODE: "plan_approval_mode",
  PLANNER_MAX_TASKS: "planner_max_tasks",
  PLANNER_UNDER_SCOPED_BROAD_GATE: "planner_under_scoped_broad_gate",
  POSSE_REMOTE_MODE: "posse_remote_mode",
  POSSE_REMOTE_RESPONSE_SIGNING_SECRET: "posse_remote_response_signing_secret",
  POSSE_REMOTE_TIMEOUT_MS: "posse_remote_timeout_ms",
  POSSE_REMOTE_URL: "posse_remote_url",
  KAIZEN_TO_ATLAS: "posse_kaizen_to_atlas",
  LOG_SCRUB_SECRETS: "posse_log_scrub_secrets",
  LOG_LEVEL: "posse_log_level",
  DB_TELEMETRY_TAIL_LIMIT: "posse_db_telemetry_tail_limit",
  RETENTION_DAYS: "posse_retention_days",
  SCHEDULER_CONCURRENCY: "scheduler_concurrency",
  SESSION_RECYCLE_STRICT_PROVIDER: "session_recycle_strict_provider",
  STARTUP_DIRTY_TREE_POLICY: "startup_dirty_tree_policy",
  ATLAS_MEMORY_SURFACE: "atlas_memory_surface",
  ATLAS_V2_BOOT_TIMEOUT_MS: "atlas_v2_boot_timeout_ms",
  ATLAS_HANDOFF_PREFETCH_TIMEOUT_MS: "atlas_handoff_prefetch_timeout_ms",
  ATLAS_EMBEDDED_TIMEOUT_MS: "atlas_embedded_timeout_ms",
  ATLAS_EMBEDDED_DISPATCH: "atlas_embedded_dispatch",
  ATLAS_EMBEDDED_QUEUE_WAIT_MS: "atlas_embedded_queue_wait_ms",
  ATLAS_JOB_CACHE_TTL_MS: "atlas_job_cache_ttl_ms",
  ATLAS_PREFETCH_CACHE_TTL_MS: "atlas_prefetch_cache_ttl_ms",
  ATLAS_CORRUPTION_COOLDOWN_MS: "atlas_corruption_cooldown_ms",
  ATLAS_SCIP_INDEX_ARGS: "atlas_scip_index_args",
  ATLAS_SCIP_INDEX_COMMAND: "atlas_scip_index_command",
  ATLAS_SCIP_LANGUAGES: "atlas_scip_languages",
  ATLAS_SCIP_INDEX_TIMEOUT_MS: "atlas_scip_index_timeout_ms",
  ATLAS_SCIP_COLD_INDEX_TIMEOUT_MS: "atlas_scip_cold_index_timeout_ms",
  ATLAS_SCIP_MAX_AGE_HOURS: "atlas_scip_max_age_hours",
  ATLAS_SCIP_MODE: "atlas_scip_mode",
  ATLAS_SCIP_RESTAGE_POLICY: "atlas_scip_restage_policy",
  ATLAS_REMOTE_ENCODER_MODE: "atlas_remote_encoder_mode",
  ATLAS_REMOTE_ENCODER_URL: "atlas_remote_encoder_url",
  ATLAS_REMOTE_ENCODER_MODEL: "atlas_remote_encoder_model",
  ATLAS_REMOTE_ENCODER_DIM: "atlas_remote_encoder_dim",
  ATLAS_REMOTE_ENCODER_MODEL_VERSION: "atlas_remote_encoder_model_version",
  ATLAS_REMOTE_ENCODER_TIMEOUT_MS: "atlas_remote_encoder_timeout_ms",
  ATLAS_EMBEDDING_THREADS: "atlas_embedding_threads",
  ATLAS_TREE_COMPRESSION_MODE: "atlas_tree_compression_mode",
  ATLAS_TREE_COMPRESSION_PROVIDER: "atlas_tree_compression_provider",
  ATLAS_TREE_COMPRESSION_MODEL_TIER: "atlas_tree_compression_model_tier",
  ATLAS_TREE_COMPRESSION_MAX_SEEDS: "atlas_tree_compression_max_seeds",
  ATLAS_TREE_COMPRESSION_MODEL_MAX_SEEDS: "atlas_tree_compression_model_max_seeds",
  SKILLS_DISABLED_IDS: "skills_disabled_ids",
  SKILLS_ENABLED: "skills_enabled",
  STALL_TIMEOUT: "stall_timeout",
  TARGET_BRANCH: "target_branch",
  WEB_TOOLS_ENABLED: "web_tools_enabled",
  WORKER_LEASE_RENEW_MAX_TRANSIENT_ERRORS: "worker_lease_renew_max_transient_errors",
  WORKER_PROVIDER_CIRCUIT_TTL_MS: "worker_provider_circuit_ttl_ms",
  WORKTREE_LOCK_WAIT_MS: "worktree_lock_wait_ms",
  GIT_ATLAS_POST_COMMIT_HOOK_TIMEOUT_MS: "git_atlas_post_commit_hook_timeout_ms",
  NATIVE_REMOTE: "posse_native_remote",

  // Account-level keys read via getAccountSetting() directly (bypassing the
  // queue facade). Listed here so the typo-safety story is identical.
  ARTIFACT_IMAGE_PROVIDER: "artifact_image_provider",
  OPENAI_ACCOUNT_LIMIT_TOKENS_SESSION: "openai_account_limit_tokens_session",
  OPENAI_ACCOUNT_LIMIT_TOKENS_WEEK: "openai_account_limit_tokens_week",
});

export const CODEX_AUTH_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: "oauth", label: "oauth (ChatGPT login)" }),
  Object.freeze({ value: "api", label: "api (API key)" }),
  Object.freeze({ value: "auto", label: "auto (oauth only)" }),
]);

export const CLAUDE_EXECUTION_MODE_VALUES = Object.freeze(["print", "interactive"]);
export const DELEGATION_MODE_VALUES = Object.freeze(["js", "ml"]);
export const FIX_SCOPE_HANDOFF_GUARD_VALUES = Object.freeze(["off", "auto", "warn", "enforce"]);
export const HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES = Object.freeze(["off", "small", "always"]);
export const KAIZEN_TO_ATLAS_MODE_VALUES = Object.freeze(["off", "shadow", "write"]);
export const LOG_LEVEL_VALUES = Object.freeze(["debug", "info", "warn", "error"]);
export const MODEL_CATALOG_ENFORCEMENT_VALUES = Object.freeze(["warn_and_fallback", "warn_only", "off"]);
export const PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES = Object.freeze(["off", "warn", "enforce"]);
export const POSSE_REMOTE_MODE_VALUES = Object.freeze(["required"]);
export const RESEARCH_FANOUT_MODE_VALUES = Object.freeze(["off", "shadow", "on"]);
export const ATLAS_MEMORY_SURFACE_MODE_VALUES = Object.freeze(["auto", "off", "on"]);
export const SESSION_RECYCLE_MODE_VALUES = Object.freeze(["off", "dev-fix", "full"]);
export const STARTUP_DIRTY_TREE_POLICY_VALUES = Object.freeze(["block", "commit"]);
