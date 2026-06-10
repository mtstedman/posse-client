import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { setAccountSettingsPathForTests, closeAccountSettingsDb } from "../lib/domains/settings/functions/account-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbMod;
let queueMod;
let tunables;
let schedulerConfig;
let loggerMod;
let runtimeDir;
let runtimeDbPath;
let accountDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  closeAccountSettingsDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  try { fs.rmSync(accountDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("settings tunables", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tunables-"));
    runtimeDbPath = path.join(runtimeDir, ".posse", "db", "orchestrator.db");
    accountDbPath = path.join(runtimeDir, "account.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
    setAccountSettingsPathForTests(accountDbPath);

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    tunables = await import("../lib/domains/settings/functions/tunables.js");
    schedulerConfig = await import("../lib/domains/scheduler/functions/config.js");
    loggerMod = await import("../lib/shared/telemetry/functions/logging/logger.js");
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    closeAccountSettingsDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
    setAccountSettingsPathForTests(null);
  });

  it("returns documented defaults when no override is set", () => {
    assert.equal(tunables.getGitAtlasPostCommitHookTimeoutMs(), 600000);
    assert.equal(tunables.getFixScopeHandoffGuardMode(), "enforce");
    assert.equal(tunables.getWiFailureThreshold(), 5);
    assert.equal(tunables.getMaxFixChainDepth(), 2);
    assert.equal(tunables.getMaxReplans(), 3);
    assert.equal(tunables.getMaxFileRequestDepth(), 2);
    assert.equal(tunables.getDisplayMaxEvents(), 250);
    assert.equal(tunables.getDisplayEventRateLimitPerSec(), 300);
    assert.equal(tunables.getLogLevelName(), "info");
    assert.equal(tunables.getAtlasV2BootTimeoutMs(), 5400000);
    assert.equal(tunables.getAtlasHandoffPrefetchTimeoutMs(), 60000);
    assert.equal(tunables.getAtlasParseMaxParallel({ languages: 10, availableParallelism: 12 }), 4);
    assert.equal(tunables.getAtlasParseMaxParallel({ availableParallelism: 12 }), 4);
    assert.equal(tunables.getAtlasParseMaxParallel({ availableParallelism: 4 }), 2);
    const expectedDefaultParallel = Math.max(
      1,
      Math.min(
        Math.floor((typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length) / 2),
        4,
      ),
    );
    assert.equal(tunables.getAtlasParseMaxParallel(), expectedDefaultParallel);
    assert.equal(tunables.getAtlasParsePerLangTandem(), true);
    assert.equal(tunables.getAtlasParseFileProgressThrottleMs(), 100);
    assert.equal(tunables.getAtlasParseBandMaxRows(), 8);
    assert.equal(tunables.getAtlasParseOnnxBackgroundInitial(), true);
    assert.equal(tunables.getAtlasParseOnnxBackgroundBatchSize(), 128);
    assert.equal(tunables.getAtlasEmbeddedTimeoutMs(), 90000);
    assert.equal(tunables.getAtlasEmbeddedQueueWaitMs(), 90000);
    assert.equal(tunables.getAtlasJobCacheTtlMs(), 300000);
    assert.equal(tunables.getAtlasPrefetchCacheTtlMs(), 600000);
    assert.equal(tunables.getAtlasCorruptionCooldownMs(), 120000);
  });

  it("picks up admin overrides written via setSetting", () => {
    queueMod.setSetting("git_atlas_post_commit_hook_timeout_ms", "90000");
    queueMod.setSetting("fix_scope_handoff_guard", "enforce");
    queueMod.setSetting("posse_wi_failure_threshold", "7");
    queueMod.setSetting("posse_max_fix_chain_depth", "4");
    queueMod.setSetting("posse_max_replans", "1");
    queueMod.setSetting("posse_max_file_request_depth", "0");
    queueMod.setSetting("posse_display_max_events", "500");
    queueMod.setSetting("posse_display_event_rate_limit_per_sec", "100");
    queueMod.setSetting("posse_log_level", "debug");
    queueMod.setSetting("atlas_v2_boot_timeout_ms", "120000");
    queueMod.setSetting("atlas_handoff_prefetch_timeout_ms", "45000");
    queueMod.setSetting("atlas_parse_max_parallel", "2");
    queueMod.setSetting("atlas_parse_per_lang_tandem", "false");
    queueMod.setSetting("atlas_parse_file_progress_throttle_ms", "25");
    queueMod.setSetting("atlas_parse_band_max_rows", "4");
    queueMod.setSetting("atlas_parse_onnx_background_initial", "off");
    queueMod.setSetting("atlas_parse_onnx_background_batch_size", "64");
    queueMod.setSetting("atlas_embedded_timeout_ms", "45000");
    queueMod.setSetting("atlas_embedded_queue_wait_ms", "250");
    queueMod.setSetting("atlas_job_cache_ttl_ms", "1000");
    queueMod.setSetting("atlas_prefetch_cache_ttl_ms", "2000");
    queueMod.setSetting("atlas_corruption_cooldown_ms", "3000");

    assert.equal(tunables.getGitAtlasPostCommitHookTimeoutMs(), 90000);
    assert.equal(tunables.getFixScopeHandoffGuardMode(), "enforce");
    assert.equal(tunables.getWiFailureThreshold(), 7);
    assert.equal(tunables.getMaxFixChainDepth(), 4);
    assert.equal(tunables.getMaxReplans(), 1);
    assert.equal(tunables.getMaxFileRequestDepth(), 0);
    assert.equal(tunables.getDisplayMaxEvents(), 500);
    assert.equal(tunables.getDisplayEventRateLimitPerSec(), 100);
    assert.equal(tunables.getLogLevelName(), "debug");
    assert.equal(loggerMod.__testLogLevelValue(), 0);
    assert.equal(tunables.getAtlasV2BootTimeoutMs(), 120000);
    assert.equal(tunables.getAtlasHandoffPrefetchTimeoutMs(), 45000);
    assert.equal(tunables.getAtlasParseMaxParallel({ languages: 10, availableParallelism: 12 }), 2);
    assert.equal(tunables.getAtlasParsePerLangTandem(), false);
    assert.equal(tunables.getAtlasParseFileProgressThrottleMs(), 25);
    assert.equal(tunables.getAtlasParseBandMaxRows(), 4);
    assert.equal(tunables.getAtlasParseOnnxBackgroundInitial(), false);
    assert.equal(tunables.getAtlasParseOnnxBackgroundBatchSize(), 64);
    assert.equal(tunables.getAtlasEmbeddedTimeoutMs(), 45000);
    assert.equal(tunables.getAtlasEmbeddedQueueWaitMs(), 250);
    assert.equal(tunables.getAtlasJobCacheTtlMs(), 1000);
    assert.equal(tunables.getAtlasPrefetchCacheTtlMs(), 2000);
    assert.equal(tunables.getAtlasCorruptionCooldownMs(), 3000);
  });

  it("rejects invalid catalog overrides and keeps readers on defaults", () => {
    queueMod.setSetting("posse_wi_failure_threshold", "");
    assert.throws(() => queueMod.setSetting("posse_max_fix_chain_depth", "not a number"), /must be a number/);
    assert.throws(() => queueMod.setSetting("posse_max_replans", "-2"), /at least 1/);
    assert.throws(() => queueMod.setSetting("posse_display_max_events", "0"), /at least 10/);
    assert.throws(() => queueMod.setSetting("posse_log_level", "verbose"), /must be one of/);
    assert.throws(() => queueMod.setSetting("fix_scope_handoff_guard", "block"), /must be one of/);
    assert.throws(() => queueMod.setSetting("atlas_v2_boot_timeout_ms", "0"), /at least 1000/);
    assert.throws(() => queueMod.setSetting("atlas_handoff_prefetch_timeout_ms", "999"), /at least 1000/);
    assert.throws(() => queueMod.setSetting("atlas_parse_max_parallel", "0"), /at least 1/);
    assert.throws(() => queueMod.setSetting("atlas_parse_per_lang_tandem", "maybe"), /must be true or false/);
    assert.throws(() => queueMod.setSetting("atlas_parse_file_progress_throttle_ms", "-1"), /at least 0/);
    assert.throws(() => queueMod.setSetting("atlas_parse_band_max_rows", "0"), /at least 1/);
    assert.throws(() => queueMod.setSetting("atlas_parse_onnx_background_batch_size", "0"), /at least 1/);

    assert.equal(tunables.getWiFailureThreshold(), 5);
    assert.equal(tunables.getMaxFixChainDepth(), 2);
    assert.equal(tunables.getMaxReplans(), 3);
    assert.equal(tunables.getDisplayMaxEvents(), 250);
    assert.equal(tunables.getLogLevelName(), "info");
    assert.equal(tunables.getFixScopeHandoffGuardMode(), "enforce");
    assert.equal(tunables.getAtlasV2BootTimeoutMs(), 5400000);
    assert.equal(tunables.getAtlasHandoffPrefetchTimeoutMs(), 60000);
    assert.equal(tunables.getAtlasParseMaxParallel({ languages: 6, availableParallelism: 8 }), 4);
    assert.throws(() => queueMod.setSetting("atlas_parse_max_parallel", "abc"), /must be a number/);
    assert.equal(tunables.getAtlasParseMaxParallel({ languages: 3, availableParallelism: 8 }), 3);
    assert.equal(tunables.getAtlasParsePerLangTandem(), true);
    assert.equal(tunables.getAtlasParseFileProgressThrottleMs(), 100);
    assert.equal(tunables.getAtlasParseBandMaxRows(), 8);
    assert.equal(tunables.getAtlasParseOnnxBackgroundBatchSize(), 128);
  });

  it("accepts zero on non-negative-int readers", () => {
    queueMod.setSetting("posse_max_file_request_depth", "0");
    assert.equal(tunables.getMaxFileRequestDepth(), 0);
  });

  it("reads scheduler_max_active_worktrees from the settings catalog live", () => {
    assert.equal(schedulerConfig.readActiveWorktreeCap(), null);
    queueMod.setSetting("scheduler_max_active_worktrees", "2");
    assert.equal(schedulerConfig.readActiveWorktreeCap(), 2);
    queueMod.setSetting("scheduler_max_active_worktrees", "");
    assert.equal(schedulerConfig.readActiveWorktreeCap(), null);
  });

  it("reads scheduler timeout tunables live instead of freezing import-time values", () => {
    assert.equal(schedulerConfig.readHeadlessHumanTimeoutSec(), 600);
    assert.equal(schedulerConfig.readAtlasDriftCheckIntervalMs(), 600000);
    queueMod.setSetting("headless_human_timeout_sec", "42");
    queueMod.setSetting("atlas_drift_check_interval_ms", "120000");
    assert.equal(schedulerConfig.readHeadlessHumanTimeoutSec(), 42);
    assert.equal(schedulerConfig.readAtlasDriftCheckIntervalMs(), 120000);
  });

  it("exposes __testTunableDefaults that match the readers", () => {
    const defaults = tunables.__testTunableDefaults;
    assert.equal(defaults.git_atlas_post_commit_hook_timeout_ms, 600000);
    assert.equal(defaults.fix_scope_handoff_guard, "enforce");
    assert.equal(defaults.posse_wi_failure_threshold, 5);
    assert.equal(defaults.posse_max_fix_chain_depth, 2);
    assert.equal(defaults.posse_max_replans, 3);
    assert.equal(defaults.posse_max_file_request_depth, 2);
    assert.equal(defaults.posse_display_max_events, 250);
    assert.equal(defaults.posse_display_event_rate_limit_per_sec, 300);
    assert.equal(defaults.posse_log_level, "info");
    assert.equal(defaults.atlas_v2_boot_timeout_ms, 5400000);
    assert.equal(defaults.atlas_handoff_prefetch_timeout_ms, 60000);
    assert.equal(defaults.atlas_parse_per_lang_tandem, true);
    assert.equal(defaults.atlas_parse_file_progress_throttle_ms, 100);
    assert.equal(defaults.atlas_parse_band_max_rows, 8);
    assert.equal(defaults.atlas_parse_onnx_background_initial, true);
    assert.equal(defaults.atlas_parse_onnx_background_batch_size, 128);
    assert.equal(defaults.atlas_embedded_timeout_ms, 90000);
    assert.equal(defaults.atlas_embedded_queue_wait_ms, 90000);
    assert.equal(defaults.atlas_job_cache_ttl_ms, 300000);
    assert.equal(defaults.atlas_prefetch_cache_ttl_ms, 600000);
    assert.equal(defaults.atlas_corruption_cooldown_ms, 120000);
  });
});
