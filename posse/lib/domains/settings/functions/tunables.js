// lib/domains/settings/functions/tunables.js
//
// Centralized readers for project tunables that were previously hardcoded in
// pipeline modules. Each reader:
//   - Has a catalog entry in catalog.js with default, validation, description.
//   - Reads getSetting() and falls back to the hardcoded default if the
//     setting is unset, empty, or invalid (so behavior is unchanged at
//     defaults — no behavior change required by this refactor).
//   - Is safe to call when the DB is unavailable (e.g., very early boot or
//     test contexts without a runtime DB): the try/catch returns the default.
//
// Callers on hot paths should cache the value locally (e.g., once at
// construction time) rather than calling the reader per-tick. getSetting()
// uses prepared statements so per-call cost is small, but it is not free.

import os from "os";
import { getSetting } from "../../queue/functions/index.js";
import { VALID_BINARY_NAMES } from "../../../catalog/binary.js";

const TUNABLE_DEFAULTS = Object.freeze({
  git_atlas_post_commit_hook_timeout_ms: 600000,
  fix_scope_handoff_guard: "enforce",
  posse_wi_failure_threshold: 5,
  posse_max_fix_chain_depth: 2,
  posse_max_replans: 3,
  posse_max_file_request_depth: 2,
  posse_display_max_events: 250,
  posse_display_event_rate_limit_per_sec: 300,
  posse_log_level: "info",
  atlas_v2_boot_timeout_ms: 5400000,
  atlas_handoff_prefetch_timeout_ms: 60000,
  atlas_parse_per_lang_tandem: true,
  atlas_parse_file_progress_throttle_ms: 100,
  atlas_parse_band_max_rows: 8,
  atlas_parse_onnx_background_initial: true,
  atlas_parse_onnx_background_batch_size: 16,
  atlas_embedded_timeout_ms: 90000,
  atlas_embedded_queue_wait_ms: 90000,
  atlas_job_cache_ttl_ms: 300000,
  atlas_prefetch_cache_ttl_ms: 600000,
  atlas_corruption_cooldown_ms: 120000,
  posse_native_remote: true,
});

const LOG_LEVEL_VALUES = new Set(["debug", "info", "warn", "error"]);
const FIX_SCOPE_HANDOFF_GUARD_VALUES = new Set(["off", "warn", "enforce"]);

function readPositiveInt(key, fallback) {
  try {
    const raw = getSetting(key);
    if (raw == null || String(raw).trim() === "") return fallback;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // Settings DB may not be open yet during early imports.
  }
  return fallback;
}

function readNonNegativeInt(key, fallback) {
  try {
    const raw = getSetting(key);
    if (raw == null || String(raw).trim() === "") return fallback;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  } catch {
    // Settings DB may not be open yet during early imports.
  }
  return fallback;
}

function readEnum(key, allowedValues, fallback) {
  try {
    const raw = getSetting(key);
    const normalized = String(raw || "").trim().toLowerCase();
    if (allowedValues.has(normalized)) return normalized;
  } catch {
    // Settings DB may not be open yet during early imports.
  }
  return fallback;
}

function readBoolean(key, fallback) {
  try {
    const raw = getSetting(key);
    const normalized = String(raw ?? "").trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  } catch {
    // Settings DB may not be open yet during early imports.
  }
  return fallback;
}

function computedAtlasParseParallel({ languages = null, availableParallelism = null } = {}) {
  let available = Number(availableParallelism);
  if (!Number.isFinite(available) || available <= 0) {
    try {
      available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    } catch {
      available = 2;
    }
  }
  const half = Math.max(1, Math.floor(available / 2));
  const parsedLanguages = Number(languages);
  const languageCount = Number.isFinite(parsedLanguages) && parsedLanguages > 0
    ? Math.max(1, Math.floor(parsedLanguages))
    : Math.min(half, 4);
  return Math.max(1, Math.min(languageCount, half, 4));
}

export function getGitAtlasPostCommitHookTimeoutMs() {
  return readPositiveInt(
    "git_atlas_post_commit_hook_timeout_ms",
    TUNABLE_DEFAULTS.git_atlas_post_commit_hook_timeout_ms,
  );
}

export function getFixScopeHandoffGuardMode() {
  return readEnum(
    "fix_scope_handoff_guard",
    FIX_SCOPE_HANDOFF_GUARD_VALUES,
    TUNABLE_DEFAULTS.fix_scope_handoff_guard,
  );
}

export function getWiFailureThreshold() {
  return readPositiveInt("posse_wi_failure_threshold", TUNABLE_DEFAULTS.posse_wi_failure_threshold);
}

export function getMaxFixChainDepth() {
  return readPositiveInt("posse_max_fix_chain_depth", TUNABLE_DEFAULTS.posse_max_fix_chain_depth);
}

export function getMaxReplans() {
  return readPositiveInt("posse_max_replans", TUNABLE_DEFAULTS.posse_max_replans);
}

export function getMaxFileRequestDepth() {
  return readNonNegativeInt("posse_max_file_request_depth", TUNABLE_DEFAULTS.posse_max_file_request_depth);
}

export function getDisplayMaxEvents() {
  return readPositiveInt("posse_display_max_events", TUNABLE_DEFAULTS.posse_display_max_events);
}

export function getDisplayEventRateLimitPerSec() {
  return readPositiveInt("posse_display_event_rate_limit_per_sec", TUNABLE_DEFAULTS.posse_display_event_rate_limit_per_sec);
}

export function getLogLevelName() {
  return readEnum("posse_log_level", LOG_LEVEL_VALUES, TUNABLE_DEFAULTS.posse_log_level);
}

export function getAtlasV2BootTimeoutMs() {
  return readPositiveInt("atlas_v2_boot_timeout_ms", TUNABLE_DEFAULTS.atlas_v2_boot_timeout_ms);
}

export function getAtlasHandoffPrefetchTimeoutMs() {
  return readPositiveInt("atlas_handoff_prefetch_timeout_ms", TUNABLE_DEFAULTS.atlas_handoff_prefetch_timeout_ms);
}

export function getAtlasParseMaxParallel(opts = {}) {
  return readPositiveInt("atlas_parse_max_parallel", computedAtlasParseParallel(opts));
}

export function getAtlasParsePerLangTandem() {
  return readBoolean("atlas_parse_per_lang_tandem", TUNABLE_DEFAULTS.atlas_parse_per_lang_tandem);
}

export function getAtlasParseFileProgressThrottleMs() {
  return readNonNegativeInt(
    "atlas_parse_file_progress_throttle_ms",
    TUNABLE_DEFAULTS.atlas_parse_file_progress_throttle_ms,
  );
}

export function getAtlasParseBandMaxRows() {
  return readPositiveInt("atlas_parse_band_max_rows", TUNABLE_DEFAULTS.atlas_parse_band_max_rows);
}

export function getAtlasParseOnnxBackgroundInitial() {
  return readBoolean("atlas_parse_onnx_background_initial", TUNABLE_DEFAULTS.atlas_parse_onnx_background_initial);
}

export function getAtlasParseOnnxBackgroundBatchSize() {
  return readPositiveInt(
    "atlas_parse_onnx_background_batch_size",
    TUNABLE_DEFAULTS.atlas_parse_onnx_background_batch_size,
  );
}

export function getAtlasEmbeddedTimeoutMs() {
  return readPositiveInt("atlas_embedded_timeout_ms", TUNABLE_DEFAULTS.atlas_embedded_timeout_ms);
}

export function getAtlasEmbeddedQueueWaitMs() {
  return readNonNegativeInt("atlas_embedded_queue_wait_ms", TUNABLE_DEFAULTS.atlas_embedded_queue_wait_ms);
}

export function getAtlasJobCacheTtlMs() {
  return readNonNegativeInt("atlas_job_cache_ttl_ms", TUNABLE_DEFAULTS.atlas_job_cache_ttl_ms);
}

export function getAtlasPrefetchCacheTtlMs() {
  return readNonNegativeInt("atlas_prefetch_cache_ttl_ms", TUNABLE_DEFAULTS.atlas_prefetch_cache_ttl_ms);
}

export function getAtlasCorruptionCooldownMs() {
  return readNonNegativeInt("atlas_corruption_cooldown_ms", TUNABLE_DEFAULTS.atlas_corruption_cooldown_ms);
}

/**
 * Whether native (Rust) binary invocation is enabled for a tool, via the
 * `posse_native_<name>` tunable. Git and ATLAS are hardwired on inside
 * BinaryManager and never reach this resolver; remote auth HTTP defaults on
 * when its binary is staged. Used by BinaryManager (env overrides take
 * precedence there). Unknown tool names return false.
 *
 * @param {string} name  A catalog binary name (e.g. "remote").
 * @returns {boolean}
 */
export function getNativeBinaryEnabled(name) {
  if (!VALID_BINARY_NAMES.has(name)) return false;
  const key = `posse_native_${name}`;
  return readBoolean(key, TUNABLE_DEFAULTS[key] ?? false);
}

// Exposed for tests that want to assert default values without round-tripping
// through getSetting().
export const __testTunableDefaults = TUNABLE_DEFAULTS;
