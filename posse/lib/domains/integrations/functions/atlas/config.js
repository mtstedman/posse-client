import { getSetting, getSettingsDataVersion } from "../../../queue/functions/index.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { getAtlasRouteDefinitionForRole, TOOL_ROLE_LIBRARY } from "../deterministic-mcp/tool-descriptors.js";
import { normalizeAbsolutePath } from "./shared.js";

// ATLAS value enums, validator Set forms, role order, server defaults, and
// provider→transport map all live in the catalogue. Imported for local use
// and re-exported so the rest of the ATLAS integration code can import them
// by their existing names.
import {
  ATLAS_AUTO_FEEDBACK_VALUES,
  ATLAS_BOOT_REINDEX_POLICY_VALUES,
  ATLAS_EMBEDDING_MODEL_OPTIONS,
  ATLAS_PHASE_VALUES,
  ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES,
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  ATLAS_SCIP_MODE_VALUES,
  ATLAS_SCIP_RESTAGE_POLICY_VALUES,
  ATLAS_TREE_COMPRESSION_MODE_VALUES,
  ATLAS_TRANSPORT_VALUES,
  ATLAS_V2_MODE_VALUES,
  VALID_ATLAS_AUTO_FEEDBACK_MODES,
  VALID_ATLAS_BOOT_REINDEX_POLICIES,
  VALID_ATLAS_EMBEDDING_MODEL_IDS,
  VALID_ATLAS_PHASES,
  VALID_ATLAS_SCIP_LANGUAGES,
  VALID_ATLAS_SCIP_MODES,
  VALID_ATLAS_SCIP_RESTAGE_POLICIES,
  VALID_ATLAS_TREE_COMPRESSION_MODES,
  VALID_ATLAS_TRANSPORTS,
  VALID_ATLAS_V2_MODES,
  ATLAS_ROLE_ORDER,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_SERVER_NAME,
  DEFAULT_ATLAS_EMBEDDING_MODEL_ID,
  PROVIDER_ATLAS_SUPPORT,
} from "../../../../catalog/atlas.js";
import { MODEL_TIERS } from "../../../../catalog/model.js";
import { normalizeAtlasV2Mode } from "../atlas-v2-mode.js";

export {
  ATLAS_AUTO_FEEDBACK_VALUES,
  ATLAS_BOOT_REINDEX_POLICY_VALUES,
  ATLAS_EMBEDDING_MODEL_OPTIONS,
  ATLAS_PHASE_VALUES,
  ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES,
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  ATLAS_SCIP_MODE_VALUES,
  ATLAS_SCIP_RESTAGE_POLICY_VALUES,
  ATLAS_TREE_COMPRESSION_MODE_VALUES,
  ATLAS_TRANSPORT_VALUES,
  ATLAS_V2_MODE_VALUES,
  VALID_ATLAS_AUTO_FEEDBACK_MODES,
  VALID_ATLAS_BOOT_REINDEX_POLICIES,
  VALID_ATLAS_EMBEDDING_MODEL_IDS,
  VALID_ATLAS_PHASES,
  VALID_ATLAS_SCIP_LANGUAGES,
  VALID_ATLAS_SCIP_MODES,
  VALID_ATLAS_SCIP_RESTAGE_POLICIES,
  VALID_ATLAS_TREE_COMPRESSION_MODES,
  VALID_ATLAS_TRANSPORTS,
  VALID_ATLAS_V2_MODES,
  ATLAS_ROLE_ORDER,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_SERVER_NAME,
  DEFAULT_ATLAS_EMBEDDING_MODEL_ID,
  PROVIDER_ATLAS_SUPPORT,
};

export const ATLAS_ROLE_ROUTES = TOOL_ROLE_LIBRARY.atlasRoutes;

// Private cache. Read/write through the accessor functions
// (`invalidateAtlasIntegrationConfigCache`, internal cache hits in
// `getAtlasIntegrationConfig`). Not exported because direct mutation by
// outside code would break cache invariants.
let ATLAS_CONFIG_CACHE = {
  envSig: null,
  settingsVersion: null,
  value: null,
};
/**
 * @param {any} [config]
 * @returns {any}
 */
export function cloneAtlasConfig(config = {}) {
  return {
    ...config,
    phases: [...(config.phases || [])],
    scipLanguages: [...(config.scipLanguages || [])],
    args: [...(config.args || [])],
  };
}

/**
 * @param {any} [config]
 * @param {any} [overrides]
 * @returns {any}
 */
export function withAtlasConfigOverrides(config = getAtlasIntegrationConfig(), overrides = {}) {
  return cloneAtlasConfig({
    ...(config || {}),
    ...(overrides || {}),
  });
}

export function invalidateAtlasIntegrationConfigCache() {
  ATLAS_CONFIG_CACHE = { envSig: null, settingsVersion: null, value: null };
}

// Private runtime-disable state. Read via `isAtlasRuntimeDisabled()` /
// `getAtlasRuntimeDisabledReason()`, written via `disableAtlasForRun()`, reset
// (tests only) via `__resetAtlasRuntimeDisabledForTests()`. Not exported so
// outside code cannot bypass the accessor invariants (cache invalidation,
// repo-key normalization).
let _atlasRuntimeDisabled = null;
let _atlasRuntimeDisabledByRepo = new Map();

export function normalizeAtlasRuntimeDisableRepoKey(repoKey = null) {
  const value = String(repoKey || "").trim();
  if (!value) return null;
  return value.replace(/\\/g, "/").toLowerCase();
}

export function disableAtlasForRun(reason = "unspecified", repoKey = null) {
  const entry = { reason: String(reason || "unspecified") };
  const normalizedRepoKey = normalizeAtlasRuntimeDisableRepoKey(repoKey);
  if (normalizedRepoKey) {
    _atlasRuntimeDisabledByRepo.set(normalizedRepoKey, entry);
  } else {
    _atlasRuntimeDisabled = entry;
  }
  invalidateAtlasIntegrationConfigCache();
}

export function isAtlasRuntimeDisabled(repoKey = null) {
  const normalizedRepoKey = normalizeAtlasRuntimeDisableRepoKey(repoKey);
  return _atlasRuntimeDisabled != null || (normalizedRepoKey ? _atlasRuntimeDisabledByRepo.has(normalizedRepoKey) : false);
}

export function getAtlasRuntimeDisabledReason(repoKey = null) {
  const normalizedRepoKey = normalizeAtlasRuntimeDisableRepoKey(repoKey);
  return _atlasRuntimeDisabled?.reason || (normalizedRepoKey ? _atlasRuntimeDisabledByRepo.get(normalizedRepoKey)?.reason : null) || null;
}

export function __resetAtlasRuntimeDisabledForTests() {
  _atlasRuntimeDisabled = null;
  _atlasRuntimeDisabledByRepo = new Map();
  invalidateAtlasIntegrationConfigCache();
}

export function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function parseLiveBuffersEnabled(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "deterministic-writes") return true;
  return parseBool(raw);
}

export function getAtlasModeState(rawMode, {
  telemetryOnly = false,
  abEnabled = false,
} = {}) {
  const modeInput = String(rawMode || "").trim().toLowerCase();
  if (modeInput === "shadow") {
    return {
      mode: "shadow",
      normalizedMode: "on",
      telemetryOnly: true,
      abEnabled: !!abEnabled,
      modeAlias: "shadow",
    };
  }
  if (modeInput === "split") {
    return {
      mode: "split",
      normalizedMode: "on",
      telemetryOnly: !!telemetryOnly,
      abEnabled: true,
      modeAlias: "split",
    };
  }
  if (modeInput === "preferred") {
    return {
      mode: "preferred",
      normalizedMode: "on",
      telemetryOnly: !!telemetryOnly,
      abEnabled: !!abEnabled,
      modeAlias: "preferred",
    };
  }
  if (modeInput === "on" || modeInput === "off" || modeInput === "required") {
    return {
      mode: modeInput,
      normalizedMode: modeInput,
      telemetryOnly: !!telemetryOnly,
      abEnabled: !!abEnabled,
      modeAlias: null,
    };
  }
  return {
    mode: "off",
    normalizedMode: "off",
    telemetryOnly: false,
    abEnabled: false,
    modeAlias: modeInput || null,
  };
}

export function readDbSetting(key) {
  try {
    const value = getSetting(key);
    return value == null || String(value).trim() === "" ? null : String(value).trim();
  } catch {
    return null;
  }
}

export function readDbSettingBool(key) {
  const value = readDbSetting(key);
  return value == null ? null : parseBool(value);
}

export function readSettingsDataVersion() {
  try {
    const version = getSettingsDataVersion();
    return Number.isFinite(Number(version)) ? Number(version) : null;
  } catch {
    return null;
  }
}

export function parseIntOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function provided(value) {
  return value !== null && value !== undefined;
}

function firstProvided(...values) {
  for (const value of values) {
    if (provided(value)) return value;
  }
  return null;
}

export function parseList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseArgString(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  const input = String(value || "").trim();
  if (!input) return [];
  const parts = [];
  let current = "";
  let quote = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) parts.push(current);
  return parts;
}

export function stableHash(input) {
  const text = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export const ATLAS_ARM_SCORE = (arm) => {
  if (!arm.calls) return 0;
  const firstPassRate = arm.firstPass / arm.calls;
  const retryRate = arm.retries / arm.calls;
  const avgTokens = arm.tokenCost / arm.calls;
  const avgDuration = arm.durationMs / arm.calls;
  const normalizedTokenPenalty = Math.min(0.2, avgTokens / 200000);
  const normalizedDurationPenalty = Math.min(0.2, avgDuration / 600000);
  return firstPassRate - (retryRate * 0.35) - normalizedTokenPenalty - normalizedDurationPenalty;
};

export function _queryAtlasAdaptiveArms(db, { role, provider, days, limit }) {
  const where = [
    "ac.atlas_method IN ('ab_atlas', 'atlas', 'ab_control', 'baseline')",
    "ac.created_at >= datetime('now', ?)",
  ];
  const params = [`-${days} days`];
  if (role && role !== "*") {
    where.push("ac.role = ?");
    params.push(String(role || ""));
  }
  if (provider && provider !== "*") {
    where.push("COALESCE(ac.provider, 'claude') = ?");
    params.push(String(provider || ""));
  }
  params.push(limit);

  const rows = db.prepare(`
    SELECT
      ac.atlas_method as atlas_method,
      COALESCE(ac.status, 'failed') as status,
      COALESCE(ja.attempt_number, 1) as attempt_number,
      COALESCE(ac.input_tokens, 0) + COALESCE(ac.output_tokens, 0) as token_cost,
      COALESCE(ac.duration_ms, 0) as duration_ms
    FROM agent_calls ac
    LEFT JOIN job_attempts ja ON ja.id = ac.attempt_id
    WHERE ${where.join("\n      AND ")}
    ORDER BY ac.created_at DESC
    LIMIT ?
  `).all(...params);

  const initArm = () => ({ calls: 0, firstPass: 0, retries: 0, tokenCost: 0, durationMs: 0 });
  const atlasArm = initArm();
  const controlArm = initArm();
  for (const row of rows) {
    const method = String(row.atlas_method || "baseline");
    const isAtlas = method === "ab_atlas" || method === "atlas";
    const arm = isAtlas ? atlasArm : controlArm;
    arm.calls += 1;
    arm.tokenCost += Number(row.token_cost || 0);
    arm.durationMs += Number(row.duration_ms || 0);
    const succeeded = String(row.status || "") === "succeeded";
    const firstPass = succeeded && Number(row.attempt_number || 1) <= 1;
    if (firstPass) arm.firstPass += 1;
    if (!firstPass || Number(row.attempt_number || 1) > 1) arm.retries += 1;
  }
  return { atlasArm, controlArm };
}

export function loadAdaptiveSplitTarget({ role, provider }) {
  let db;
  try {
    db = getDb();
  } catch (error) {
    return {
      targetPercent: 50,
      sampleSize: 0,
      scoreDelta: 0,
      reason: "db_unavailable",
      error: String(error?.message || error || "unknown"),
    };
  }

  let atlasArm, controlArm;
  try {
    ({ atlasArm, controlArm } = _queryAtlasAdaptiveArms(db, { role, provider, days: 30, limit: 600 }));
  } catch {
    return { targetPercent: 50, sampleSize: 0, scoreDelta: 0, reason: "query_failed" };
  }

  // Require a reasonable sample per arm before moving off the 50/50 baseline.
  // Below this the confidence weighting alone can't contain oscillation from
  // small-sample noise.
  const minSamplesPerArm = 20;
  if (atlasArm.calls < minSamplesPerArm || controlArm.calls < minSamplesPerArm) {
    return {
      targetPercent: 50,
      sampleSize: atlasArm.calls + controlArm.calls,
      scoreDelta: 0,
      reason: "insufficient_samples",
    };
  }

  const atlasScore = ATLAS_ARM_SCORE(atlasArm);
  const controlScore = ATLAS_ARM_SCORE(controlArm);
  const scoreDelta = atlasScore - controlScore;
  const sampleSize = atlasArm.calls + controlArm.calls;

  // Dead-band: small deltas stay at 50/50 to prevent oscillation around noise.
  // Outside the dead-band, pick a raw target, then confidence-weight the step
  // away from 50 based on sample size. With few samples the adjustment is
  // partial; with many it converges on the full signal. This gives us natural
  // hysteresis without needing persistent state between boots.
  let rawTarget = 50;
  if (scoreDelta >= 0.08) rawTarget = 80;
  else if (scoreDelta >= 0.04) rawTarget = 65;
  else if (scoreDelta <= -0.08) rawTarget = 20;
  else if (scoreDelta <= -0.04) rawTarget = 35;

  // Plan 6: Drift detection. If the ATLAS arm's 5-day score has dropped
  // noticeably below the 30-day baseline, force treatment low regardless
  // of what the 30-day scoreDelta says. Without this a silent regression
  // (ATLAS returning wrong-but-plausible answers) takes 2–3 weeks to surface
  // through retry counts in the 30-day window.
  let driftDelta = null;
  let shortWindowAtlasScore = null;
  let driftDetected = false;
  try {
    const short = _queryAtlasAdaptiveArms(db, { role, provider, days: 5, limit: 200 });
    const minShortSamples = 30;
    if (short.atlasArm.calls >= minShortSamples) {
      shortWindowAtlasScore = ATLAS_ARM_SCORE(short.atlasArm);
      driftDelta = shortWindowAtlasScore - atlasScore;
      if (driftDelta <= -0.05) {
        driftDetected = true;
        // Cap raw target at 20% — this effectively hides ATLAS until the next
        // reindex or data window resets the baseline.
        rawTarget = Math.min(rawTarget, 20);
      }
    }
  } catch {
    // Best effort — drift check failures should never block the return.
  }

  const confidence = Math.min(1, sampleSize / 400);
  const blended = 50 + (rawTarget - 50) * confidence;
  const targetPercent = Math.round(Math.max(15, Math.min(85, blended)));

  return {
    targetPercent,
    sampleSize,
    scoreDelta,
    shortWindowAtlasScore,
    driftDelta,
    reason: driftDetected ? "drift_detected" : "adaptive",
  };
}

export function resolveSplitAssignment({ role, provider, repo, adaptiveTarget = null, assignmentUnit = null }) {
  // Use repoId only (not repoPath) so that relocating or renaming the
  // on-disk checkout does not flip treatment assignment. When repoId is
  // missing we fall back to a stable literal rather than the path so the
  // hash bucket stays fixed across the session.
  const repoKey = repo?.repoId || "default";
  const unit = String(assignmentUnit || "").trim().slice(0, 256);
  // When a work-item assignment unit is supplied, intentionally do not include
  // role/provider. The whole researcher -> planner -> dev chain should stay in
  // one arm so split-mode measures a coherent workflow, not individual jobs.
  const key = unit
    ? `${repoKey}:${unit}`
    : `${provider}:${role}:${repoKey}`;
  const targetPercent = Number.isFinite(Number(adaptiveTarget?.targetPercent))
    ? Math.max(0, Math.min(100, Number(adaptiveTarget.targetPercent)))
    : 50;
  const bucket = stableHash(key) % 100;
  return {
    key,
    bucket,
    targetPercent,
    treatment: bucket < targetPercent,
    method: bucket < targetPercent ? "ab_atlas" : "ab_control",
    assignment: unit || null,
    assignmentScope: unit.startsWith("wi:") ? "work_item" : (unit ? "unit" : "repo_role_provider"),
    adaptive: adaptiveTarget || null,
  };
}

export function resolveAtlasAssignmentUnit({ workItemId = null, fallback = null } = {}) {
  const wi = String(workItemId ?? "").trim();
  if (wi) return `wi:${wi.slice(0, 128)}`;
  const legacy = String(fallback ?? "").trim();
  return legacy ? legacy.slice(0, 256) : null;
}

export function getAtlasProviderSupport(providerName, {
  config = getAtlasIntegrationConfig(),
} = {}) {
  const canonicalName = String(providerName || "claude").trim().toLowerCase() || "claude";
  const support = PROVIDER_ATLAS_SUPPORT[canonicalName] || {
    transport: "none",
    rationale: "No ATLAS transport is defined for this provider.",
  };
  const supported = support.transport !== "none";
  return {
    provider: canonicalName,
    transport: support.transport,
    supported,
    configured: config.enabled,
    active: supported && config.enabled,
    rationale: support.rationale,
    mode: config.mode,
  };
}

export function getAtlasIntegrationConfig(env = null, { repoKey = null } = {}) {
  // Runtime kill switch (set by disableAtlasForRun() after a failed reindex)
  // short-circuits to a fully disabled config. Bypasses cache/env entirely
  // so callers can't accidentally see a stale enabled config.
  const disabledReason = getAtlasRuntimeDisabledReason(repoKey);
  if (disabledReason) {
    return cloneAtlasConfig({
      enabled: false,
      mode: "off",
      normalizedMode: "off",
      telemetryOnly: false,
      abEnabled: false,
      modeAlias: null,
      phases: [],
      scipMode: "off",
      scipLanguages: [],
      scipRestagePolicy: "missing",
      scipColdIndexTimeoutMs: 600000,
      scipMaxAgeHours: ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
      requestedRepoPath: null,
      requestedRepoId: null,
      requestedGraphDbPath: null,
      liveFunnel: false,
      autoFeedbackMode: "off",
      liveIndexEnabled: false,
      liveBuffersEnabled: false,
      treeCompressionMode: "off",
      treeCompressionProvider: null,
      treeCompressionModelTier: "cheap",
      treeCompressionMaxSeeds: 80,
      treeCompressionModelMaxSeeds: 40,
      treeCompressionMlEnabled: false,
      atlasEmbeddingModelId: DEFAULT_ATLAS_EMBEDDING_MODEL_ID,
      viewLayerMerge: false,
      viewWaitMs: 2500,
      autoRefreshStale: true,
      atlasVersion: "v2",
      atlasV2Enabled: false,
      atlasV2Mode: "off",
      transport: "v2",
      installPath: null,
      command: null,
      args: [],
      serverUrl: null,
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      serverName: DEFAULT_SERVER_NAME,
      bootReindexPolicy: "smart",
      reindexOnCommit: false,
      bootTimeoutMs: 5400000,
      embeddedTimeoutMs: 30000,
      queueWaitMs: 30000,
      jobCacheTtlMs: 300000,
      prefetchCacheTtlMs: 600000,
      prefetchEntrypointRank: false,
      surveyEdgeCap: 0,
      corruptionCooldownMs: 120000,
      jobCacheEnabled: false,
      driftCheckEnabled: false,
      runtimeDisabled: true,
      runtimeDisabledReason: disabledReason,
    });
  }

  const useLiveSettings = env == null;
  const useExplicitConfigObject = !useLiveSettings;
  const explicitValue = (...keys) => {
    if (!useExplicitConfigObject || !env || typeof env !== "object") return null;
    for (const configKey of keys) {
      if (Object.prototype.hasOwnProperty.call(env, configKey)) return env[configKey];
    }
    return null;
  };

  // Live runtime config comes from DB-backed settings only. Custom env-shaped
  // objects are not consulted; tests and benchmark scripts can pass a
  // config-shaped object with the camelCase / setting-key fields above.
  if (useLiveSettings) {
    const settingsVersion = readSettingsDataVersion();
    if (
      ATLAS_CONFIG_CACHE.value
      && ATLAS_CONFIG_CACHE.envSig === "settings"
      && ATLAS_CONFIG_CACHE.settingsVersion === settingsVersion
    ) {
      return cloneAtlasConfig(ATLAS_CONFIG_CACHE.value);
    }
  }

  const dbAtlasV2Mode = useLiveSettings ? readDbSetting("atlas_v2") : null;
  const dbScipMode = useLiveSettings ? readDbSetting("atlas_scip_mode") : null;
  const dbScipLanguages = useLiveSettings ? readDbSetting("atlas_scip_languages") : null;
  const dbScipIndexCommand = useLiveSettings ? readDbSetting("atlas_scip_index_command") : null;
  const dbScipIndexArgs = useLiveSettings ? readDbSetting("atlas_scip_index_args") : null;
  const dbScipIndexTimeoutMs = useLiveSettings ? readDbSetting("atlas_scip_index_timeout_ms") : null;
  const dbScipColdIndexTimeoutMs = useLiveSettings ? readDbSetting("atlas_scip_cold_index_timeout_ms") : null;
  const dbScipRestagePolicy = useLiveSettings ? readDbSetting("atlas_scip_restage_policy") : null;
  const dbScipMaxAgeHours = useLiveSettings ? readDbSetting("atlas_scip_max_age_hours") : null;
  const dbPhases = useLiveSettings ? readDbSetting("atlas_phases") : null;
  const dbLiveFunnel = useLiveSettings ? readDbSettingBool("atlas_live_funnel") : null;
  const dbAutoFeedback = useLiveSettings ? readDbSetting("atlas_auto_feedback") : null;
  const dbLiveIndex = useLiveSettings ? readDbSettingBool("atlas_live_index") : null;
  const dbLiveBuffers = useLiveSettings ? readDbSettingBool("atlas_live_buffers") : null;
  const dbTreeCompressionMode = useLiveSettings ? readDbSetting("atlas_tree_compression_mode") : null;
  const dbTreeCompressionProvider = useLiveSettings ? readDbSetting("atlas_tree_compression_provider") : null;
  const dbTreeCompressionModelTier = useLiveSettings ? readDbSetting("atlas_tree_compression_model_tier") : null;
  const dbTreeCompressionMaxSeeds = useLiveSettings ? readDbSetting("atlas_tree_compression_max_seeds") : null;
  const dbTreeCompressionModelMaxSeeds = useLiveSettings ? readDbSetting("atlas_tree_compression_model_max_seeds") : null;
  const dbEmbeddingModelId = useLiveSettings ? readDbSetting("atlas_embedding_model_id") : null;
  const dbViewWaitMs = useLiveSettings ? readDbSetting("atlas_v2_view_wait_ms") : null;
  const dbAutoRefreshStale = useLiveSettings ? readDbSettingBool("atlas_v2_auto_refresh_stale") : null;
  const dbServerUrl = useLiveSettings ? readDbSetting("atlas_url") : null;
  const dbHost = useLiveSettings ? readDbSetting("atlas_host") : null;
  const dbPort = useLiveSettings ? readDbSetting("atlas_port") : null;
  const dbServerName = useLiveSettings ? readDbSetting("atlas_server_name") : null;
  const dbBootReindexPolicy = useLiveSettings ? readDbSetting("atlas_boot_reindex_policy") : null;
  const dbReindexOnCommit = useLiveSettings ? readDbSettingBool("atlas_reindex_on_commit") : null;
  const dbBootTimeoutMs = useLiveSettings ? readDbSetting("atlas_v2_boot_timeout_ms") : null;
  const dbBootSoftTimeoutMs = useLiveSettings ? readDbSetting("atlas_v2_boot_soft_timeout_ms") : null;
  const dbEmbeddedTimeoutMs = useLiveSettings ? readDbSetting("atlas_embedded_timeout_ms") : null;
  const dbEmbeddedQueueWaitMs = useLiveSettings ? readDbSetting("atlas_embedded_queue_wait_ms") : null;
  const dbJobCacheTtlMs = useLiveSettings ? readDbSetting("atlas_job_cache_ttl_ms") : null;
  const dbPrefetchCacheTtlMs = useLiveSettings ? readDbSetting("atlas_prefetch_cache_ttl_ms") : null;
  const dbPrefetchEntrypointRank = useLiveSettings ? readDbSettingBool("atlas_prefetch_entrypoint_rank") : null;
  const dbSurveyEdgeCap = useLiveSettings ? readDbSetting("atlas_survey_edge_cap") : null;
  const dbCorruptionCooldownMs = useLiveSettings ? readDbSetting("atlas_corruption_cooldown_ms") : null;
  const dbJobCache = useLiveSettings ? readDbSettingBool("atlas_job_cache") : null;
  const dbDriftCheck = useLiveSettings ? readDbSettingBool("atlas_drift_check") : null;
  const dbDriftCheckIntervalMs = useLiveSettings ? readDbSetting("atlas_drift_check_interval_ms") : null;
  const rawAtlasV2Mode = String(firstProvided(explicitValue("atlasV2Mode", "atlas_v2", "POSSE_ATLAS_V2"), dbAtlasV2Mode, "")).trim().toLowerCase();
  const atlasV2Mode = normalizeAtlasV2Mode(rawAtlasV2Mode);
  const rawScipMode = String(firstProvided(explicitValue("scipMode", "atlas_scip_mode", "POSSE_ATLAS_SCIP_MODE"), dbScipMode, "")).trim().toLowerCase();
  const scipMode = rawScipMode === "consume"
    ? "on"
    : (VALID_ATLAS_SCIP_MODES.has(rawScipMode) ? rawScipMode : "off");
  const rawScipLanguageList = parseList(firstProvided(explicitValue("scipLanguages", "atlas_scip_languages", "POSSE_ATLAS_SCIP_LANGUAGES"), dbScipLanguages, ""))
    .map((value) => value.toLowerCase());
  const scipLanguages = rawScipLanguageList
    .filter((value) => VALID_ATLAS_SCIP_LANGUAGES.has(value))
    .filter((value, index) => rawScipLanguageList.indexOf(value) === index);
  const scipIndexCommand = String(firstProvided(explicitValue("scipIndexCommand", "atlas_scip_index_command", "POSSE_ATLAS_SCIP_INDEX_COMMAND"), dbScipIndexCommand, "")).trim() || null;
  const scipIndexArgs = parseArgString(firstProvided(explicitValue("scipIndexArgs", "atlas_scip_index_args", "POSSE_ATLAS_SCIP_INDEX_ARGS"), dbScipIndexArgs, ""));
  const scipIndexTimeoutMs = parseIntOrNull(firstProvided(explicitValue("scipIndexTimeoutMs", "atlas_scip_index_timeout_ms", "POSSE_ATLAS_SCIP_INDEX_TIMEOUT_MS"), dbScipIndexTimeoutMs)) ?? 120000;
  const scipColdIndexTimeoutMs = Math.max(
    scipIndexTimeoutMs,
    parseIntOrNull(firstProvided(
      explicitValue("scipColdIndexTimeoutMs", "atlas_scip_cold_index_timeout_ms", "POSSE_ATLAS_SCIP_COLD_INDEX_TIMEOUT_MS"),
      dbScipColdIndexTimeoutMs,
    )) ?? 600000,
  );
  const rawScipRestagePolicy = String(firstProvided(explicitValue("scipRestagePolicy", "atlas_scip_restage_policy", "POSSE_ATLAS_SCIP_RESTAGE_POLICY"), dbScipRestagePolicy, "smart")).trim().toLowerCase();
  const scipRestagePolicy = VALID_ATLAS_SCIP_RESTAGE_POLICIES.has(rawScipRestagePolicy) ? rawScipRestagePolicy : "smart";
  const scipMaxAgeHours = parseIntOrNull(firstProvided(explicitValue("scipMaxAgeHours", "atlas_scip_max_age_hours", "POSSE_ATLAS_SCIP_MAX_AGE_HOURS"), dbScipMaxAgeHours)) ?? ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT;
  const explicitTelemetryOnly = explicitValue("telemetryOnly");
  const explicitAbEnabled = explicitValue("abEnabled");
  const atlasV2Enabled = atlasV2Mode !== "off";
  const modeState = getAtlasModeState(atlasV2Enabled ? (atlasV2Mode === "required" ? "required" : "on") : "off", {
    telemetryOnly: provided(explicitTelemetryOnly) && String(explicitTelemetryOnly).trim() !== "" ? parseBool(explicitTelemetryOnly) : false,
    abEnabled: provided(explicitAbEnabled) && String(explicitAbEnabled).trim() !== "" ? parseBool(explicitAbEnabled) : false,
  });
  const rawPhaseList = parseList(firstProvided(explicitValue("phases", "atlas_phases", "POSSE_ATLAS_PHASES"), dbPhases, ATLAS_PHASE_VALUES.join(","))).map((value) => value.toLowerCase());
  const phases = rawPhaseList
    .filter((value) => VALID_ATLAS_PHASES.has(value))
    .filter((value, index) => rawPhaseList.indexOf(value) === index);
  // Repo target is local runtime state, not an account-global setting. Live
  // runs resolve it from cwd; explicit config objects keep tests/smoke helpers
  // able to target synthetic repos without persisting cross-repo drift.
  const requestedRepoPath = normalizeAbsolutePath(explicitValue("requestedRepoPath", "repoPath", "POSSE_ATLAS_REPO_PATH"));
  const requestedRepoId = String(firstProvided(explicitValue("requestedRepoId", "repoId", "POSSE_ATLAS_REPO_ID"), "")).trim() || null;
  const requestedGraphDbPath = normalizeAbsolutePath(explicitValue("requestedGraphDbPath", "graphDbPath", "POSSE_ATLAS_GRAPH_DB_PATH"));
  const explicitLiveFunnel = explicitValue("liveFunnel", "atlas_live_funnel", "POSSE_ATLAS_LIVE_FUNNEL");
  const liveFunnel = provided(explicitLiveFunnel) && String(explicitLiveFunnel).trim() !== ""
    ? parseBool(explicitLiveFunnel)
    : (dbLiveFunnel != null ? dbLiveFunnel : true);
  const rawAutoFeedback = String(firstProvided(explicitValue("autoFeedbackMode", "atlas_auto_feedback", "POSSE_ATLAS_AUTO_FEEDBACK"), dbAutoFeedback, "")).trim().toLowerCase();
  const autoFeedbackMode = VALID_ATLAS_AUTO_FEEDBACK_MODES.has(rawAutoFeedback) ? rawAutoFeedback : "write";
  const explicitLiveIndex = explicitValue("liveIndexEnabled", "atlas_live_index", "POSSE_ATLAS_LIVE_INDEX");
  const liveIndexEnabled = provided(explicitLiveIndex) && String(explicitLiveIndex).trim() !== ""
    ? parseBool(explicitLiveIndex)
    : (dbLiveIndex !== false);
  const explicitLiveBuffers = explicitValue("liveBuffersEnabled", "atlas_live_buffers", "POSSE_ATLAS_LIVE_BUFFERS");
  const liveBuffersEnabled = provided(explicitLiveBuffers) && String(explicitLiveBuffers).trim() !== ""
    ? parseLiveBuffersEnabled(explicitLiveBuffers)
    : (dbLiveBuffers !== false);
  const rawTreeCompressionMode = String(firstProvided(
    explicitValue("treeCompressionMode", "atlasTreeCompressionMode", "atlas_tree_compression_mode"),
    dbTreeCompressionMode,
    "deterministic",
  )).trim().toLowerCase();
  const treeCompressionMode = VALID_ATLAS_TREE_COMPRESSION_MODES.has(rawTreeCompressionMode)
    ? rawTreeCompressionMode
    : "deterministic";
  const treeCompressionProvider = String(firstProvided(
    explicitValue("treeCompressionProvider", "atlasTreeCompressionProvider", "atlas_tree_compression_provider"),
    dbTreeCompressionProvider,
    "",
  )).trim().toLowerCase() || null;
  const rawTreeCompressionModelTier = String(firstProvided(
    explicitValue("treeCompressionModelTier", "atlasTreeCompressionModelTier", "atlas_tree_compression_model_tier"),
    dbTreeCompressionModelTier,
    "cheap",
  )).trim().toLowerCase();
  const treeCompressionModelTier = MODEL_TIERS.includes(rawTreeCompressionModelTier)
    ? rawTreeCompressionModelTier
    : "cheap";
  const treeCompressionMaxSeeds = Math.max(1, Math.min(500, parseIntOrNull(firstProvided(
    explicitValue("treeCompressionMaxSeeds", "atlasTreeCompressionMaxSeeds", "atlas_tree_compression_max_seeds"),
    dbTreeCompressionMaxSeeds,
  )) ?? 80));
  const treeCompressionModelMaxSeeds = Math.max(1, Math.min(200, parseIntOrNull(firstProvided(
    explicitValue("treeCompressionModelMaxSeeds", "atlasTreeCompressionModelMaxSeeds", "atlas_tree_compression_model_max_seeds"),
    dbTreeCompressionModelMaxSeeds,
  )) ?? 40));
  const rawEmbeddingModelId = String(firstProvided(
    explicitValue("atlasEmbeddingModelId", "embeddingModelId", "atlas_embedding_model_id"),
    dbEmbeddingModelId,
    DEFAULT_ATLAS_EMBEDDING_MODEL_ID,
  )).trim().toLowerCase();
  const atlasEmbeddingModelId = VALID_ATLAS_EMBEDDING_MODEL_IDS.has(rawEmbeddingModelId)
    ? rawEmbeddingModelId
    : DEFAULT_ATLAS_EMBEDDING_MODEL_ID;
  const dbViewLayerMerge = useLiveSettings ? readDbSetting("atlas_view_layer_merge") : null;
  const viewLayerMerge = String(firstProvided(explicitValue("viewLayerMerge", "atlasViewLayerMerge", "atlas_view_layer_merge"), dbViewLayerMerge, "on")).trim().toLowerCase() === "on";
  const viewWaitMs = parseIntOrNull(firstProvided(explicitValue("viewWaitMs", "atlas_v2_view_wait_ms"), dbViewWaitMs)) ?? 2500;
  const explicitAutoRefreshStale = explicitValue("autoRefreshStale", "atlas_v2_auto_refresh_stale");
  const autoRefreshStale = provided(explicitAutoRefreshStale) && String(explicitAutoRefreshStale).trim() !== ""
    ? parseBool(explicitAutoRefreshStale)
    : (dbAutoRefreshStale !== false);
  const serverUrl = String(firstProvided(explicitValue("serverUrl", "atlas_url", "POSSE_ATLAS_URL"), dbServerUrl, "")).trim() || null;
  const host = String(firstProvided(explicitValue("host", "atlas_host", "POSSE_ATLAS_HOST"), dbHost, "")).trim() || DEFAULT_HTTP_HOST;
  const port = parseIntOrNull(firstProvided(explicitValue("port", "atlas_port", "POSSE_ATLAS_PORT"), dbPort)) ?? DEFAULT_HTTP_PORT;
  const serverName = String(firstProvided(explicitValue("serverName", "atlas_server_name", "POSSE_ATLAS_SERVER_NAME"), dbServerName, "")).trim() || DEFAULT_SERVER_NAME;
  const rawBootReindexPolicy = String(firstProvided(explicitValue("bootReindexPolicy", "atlas_boot_reindex_policy", "POSSE_ATLAS_BOOT_REINDEX_POLICY"), dbBootReindexPolicy, "")).trim().toLowerCase();
  const bootReindexPolicy = VALID_ATLAS_BOOT_REINDEX_POLICIES.has(rawBootReindexPolicy) ? rawBootReindexPolicy : "smart";
  const explicitReindexOnCommit = explicitValue("reindexOnCommit", "atlas_reindex_on_commit", "POSSE_ATLAS_REINDEX_ON_COMMIT");
  const reindexOnCommit = provided(explicitReindexOnCommit) && String(explicitReindexOnCommit).trim() !== ""
    ? parseBool(explicitReindexOnCommit)
    : (dbReindexOnCommit != null ? dbReindexOnCommit : true);
  const bootTimeoutMs = parseIntOrNull(firstProvided(explicitValue("bootTimeoutMs", "atlas_v2_boot_timeout_ms", "POSSE_ATLAS_V2_BOOT_TIMEOUT_MS"), dbBootTimeoutMs)) ?? 5400000;
  const bootSoftTimeoutMs = parseIntOrNull(firstProvided(explicitValue("bootSoftTimeoutMs", "atlas_v2_boot_soft_timeout_ms", "POSSE_ATLAS_V2_BOOT_SOFT_TIMEOUT_MS"), dbBootSoftTimeoutMs)) ?? 15000;
  const embeddedTimeoutMs = parseIntOrNull(firstProvided(explicitValue("embeddedTimeoutMs", "atlas_embedded_timeout_ms", "POSSE_ATLAS_EMBEDDED_TIMEOUT_MS"), dbEmbeddedTimeoutMs)) ?? 30000;
  const queueWaitMs = parseIntOrNull(firstProvided(explicitValue("queueWaitMs", "atlas_embedded_queue_wait_ms", "POSSE_ATLAS_EMBEDDED_QUEUE_WAIT_MS"), dbEmbeddedQueueWaitMs)) ?? 30000;
  const jobCacheTtlMs = parseIntOrNull(firstProvided(explicitValue("jobCacheTtlMs", "atlas_job_cache_ttl_ms", "POSSE_ATLAS_JOB_CACHE_TTL_MS"), dbJobCacheTtlMs)) ?? 300000;
  const prefetchCacheTtlMs = parseIntOrNull(firstProvided(explicitValue("prefetchCacheTtlMs", "atlas_prefetch_cache_ttl_ms", "POSSE_ATLAS_PREFETCH_CACHE_TTL_MS"), dbPrefetchCacheTtlMs)) ?? 600000;
  const explicitPrefetchEntrypointRank = explicitValue("prefetchEntrypointRank", "atlas_prefetch_entrypoint_rank");
  const prefetchEntrypointRank = provided(explicitPrefetchEntrypointRank) && String(explicitPrefetchEntrypointRank).trim() !== ""
    ? parseBool(explicitPrefetchEntrypointRank)
    : (dbPrefetchEntrypointRank === true);
  const surveyEdgeCap = Math.max(0, parseIntOrNull(firstProvided(
    explicitValue("surveyEdgeCap", "atlas_survey_edge_cap"),
    dbSurveyEdgeCap,
  )) ?? 0);
  const corruptionCooldownMs = parseIntOrNull(firstProvided(explicitValue("corruptionCooldownMs", "atlas_corruption_cooldown_ms", "POSSE_ATLAS_CORRUPTION_COOLDOWN_MS"), dbCorruptionCooldownMs)) ?? 120000;
  const explicitJobCache = explicitValue("jobCacheEnabled", "atlas_job_cache", "POSSE_ATLAS_JOB_CACHE");
  const jobCacheEnabled = provided(explicitJobCache) && String(explicitJobCache).trim() !== ""
    ? parseBool(explicitJobCache)
    : (dbJobCache !== false);
  const explicitDriftCheck = explicitValue("driftCheckEnabled", "atlas_drift_check", "POSSE_ATLAS_DRIFT_CHECK");
  const driftCheckEnabled = provided(explicitDriftCheck) && String(explicitDriftCheck).trim() !== ""
    ? parseBool(explicitDriftCheck)
    : (dbDriftCheck === true);
  const driftCheckIntervalMs = parseIntOrNull(firstProvided(explicitValue("driftCheckIntervalMs", "atlas_drift_check_interval_ms", "POSSE_ATLAS_DRIFT_CHECK_INTERVAL_MS"), dbDriftCheckIntervalMs));

  const resolved = {
    enabled: atlasV2Enabled && modeState.normalizedMode !== "off",
    mode: modeState.mode,
    normalizedMode: modeState.normalizedMode,
    atlasVersion: "v2",
    atlasV2Enabled,
    atlasV2Mode,
    scipMode,
    scipLanguages: scipLanguages.length > 0 ? scipLanguages : [...ATLAS_SCIP_DEFAULT_LANGUAGE_VALUES],
    scipIndexCommand,
    scipIndexArgs,
    scipIndexTimeoutMs,
    scipColdIndexTimeoutMs,
    scipRestagePolicy,
    scipMaxAgeHours,
    telemetryOnly: modeState.telemetryOnly,
    abEnabled: modeState.abEnabled,
    modeAlias: modeState.modeAlias,
    phases,
    requestedRepoPath,
    requestedRepoId,
    requestedGraphDbPath,
    liveFunnel,
    autoFeedbackMode,
    liveIndexEnabled,
    liveBuffersEnabled,
    treeCompressionMode,
    treeCompressionProvider,
    treeCompressionModelTier,
    treeCompressionMaxSeeds,
    treeCompressionModelMaxSeeds,
    treeCompressionMlEnabled: treeCompressionMode === "ml",
    atlasEmbeddingModelId,
    viewLayerMerge,
    viewWaitMs,
    autoRefreshStale,
    transport: "v2",
    installPath: null,
    command: null,
    args: [],
    serverUrl,
    host,
    port,
    serverName,
    bootReindexPolicy,
    reindexOnCommit,
    bootTimeoutMs,
    bootSoftTimeoutMs,
    embeddedTimeoutMs,
    queueWaitMs,
    jobCacheTtlMs,
    prefetchCacheTtlMs,
    prefetchEntrypointRank,
    surveyEdgeCap,
    corruptionCooldownMs,
    jobCacheEnabled,
    driftCheckEnabled,
    driftCheckIntervalMs,
  };
  if (useLiveSettings) {
    ATLAS_CONFIG_CACHE = {
      envSig: "settings",
      settingsVersion: readSettingsDataVersion(),
      value: cloneAtlasConfig(resolved),
    };
  }
  return cloneAtlasConfig(resolved);
}

export const ATLAS_BOOT_SETTING_MAP = Object.freeze({
  POSSE_ATLAS_V2: "atlasV2Mode",
  POSSE_ATLAS_SCIP_MODE: "scipMode",
  POSSE_ATLAS_SCIP_LANGUAGES: "scipLanguages",
  POSSE_ATLAS_SCIP_COLD_INDEX_TIMEOUT_MS: "scipColdIndexTimeoutMs",
  POSSE_ATLAS_SCIP_RESTAGE_POLICY: "scipRestagePolicy",
  POSSE_ATLAS_SCIP_MAX_AGE_HOURS: "scipMaxAgeHours",
  POSSE_ATLAS_BOOT_REINDEX_POLICY: "bootReindexPolicy",
  POSSE_ATLAS_REINDEX_ON_COMMIT: "reindexOnCommit",
});

function stringifyAtlasBootValue(envKey, value) {
  void envKey;
  let text = "";
  if (Array.isArray(value)) text = value.join(",");
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value != null) text = String(value);
  return text;
}

function shouldProjectAtlasBootValue(env, key) {
  return env[key] == null || String(env[key]).trim() === "";
}

export function buildAtlasBootEnv(baseEnv = {}) {
  const out = { ...baseEnv };
  const config = getAtlasIntegrationConfig();
  for (const [envKey, configKey] of Object.entries(ATLAS_BOOT_SETTING_MAP)) {
    if (!shouldProjectAtlasBootValue(out, envKey)) continue;
    const value = stringifyAtlasBootValue(envKey, config?.[configKey]);
    if (value === "") continue;
    out[envKey] = value;
  }
  return out;
}

export function applyAtlasBootEnv(targetEnv = {}) {
  const bootEnv = buildAtlasBootEnv(targetEnv);
  for (const [key, value] of Object.entries(bootEnv)) {
    targetEnv[key] = value;
  }
  return targetEnv;
}

export function getAtlasRouteForRole(role, { config = getAtlasIntegrationConfig() } = {}) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const route = getAtlasRouteDefinitionForRole(normalizedRole);
  const phaseEnabled = route.phase ? config.phases.includes(route.phase) : false;
  const shouldAdvertise = config.enabled && phaseEnabled;
  const telemetryOnly = config.telemetryOnly === true || config.mode === "shadow";
  // Shadow mode resolves everything (server, repo, logging) but never advertises
  // tools to the agent — it is observability-only. Force active=false regardless
  // of liveFunnel so operators can enable shadow without flipping the funnel.
  const active = telemetryOnly
    ? false
    : shouldAdvertise && config.liveFunnel;

  return {
    role: normalizedRole || "unknown",
    phase: route.phase,
    tools: [...route.tools],
    internalTools: [...(route.internalTools || route.tools)],
    rationale: route.rationale,
    shouldAdvertise,
    active,
    liveFunnel: config.liveFunnel,
    mode: config.mode,
  };
}

globalThis.__POSSE_INVALIDATE_ATLAS_CONFIG_CACHE = invalidateAtlasIntegrationConfigCache;
