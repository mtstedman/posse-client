import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOOLEAN_SETTING_KEYS,
  DEFAULT_ACCOUNT_SETTING_ROWS,
  ENUM_SETTING_OPTIONS,
  MULTI_SETTING_KEYS,
  MULTI_SETTING_VALUES,
  NUMERIC_SETTING_RULES,
  PROVIDER_SETTING_KEYS,
  TUNING_SETTING_KEYS,
  ATLAS_PHASE_VALUES,
  toDisplaySettingKey,
  toStorageSettingKey,
} from "../lib/domains/settings/functions/admin-catalog.js";
import {
  SETTINGS_CATALOG,
  SETTINGS_DEFAULTS,
  isAdminVisibleCatalogKey,
  isCatalogKey,
  validateCatalogSettingValue,
} from "../lib/domains/settings/functions/catalog.js";
import { PROVIDER_ROLE_NAMES } from "../lib/domains/providers/functions/roles.js";
import { validateAdminSettingValue } from "../lib/domains/ui/classes/admin/settings-controller.js";
import { AccountSettings } from "../lib/domains/settings/classes/AccountSettings.js";
import * as tunables from "../lib/domains/settings/functions/tunables.js";

describe("admin settings catalog", () => {
  it("derives provider setting keys from the shared provider role list", () => {
    assert.deepEqual(
      [...PROVIDER_SETTING_KEYS],
      PROVIDER_ROLE_NAMES.map((role) => `provider_${role}`),
    );
  });

  it("keeps admin fallback defaults in the canonical settings catalog", () => {
    const catalogKeys = new Set(SETTINGS_CATALOG.map((entry) => entry.key));
    for (const row of DEFAULT_ACCOUNT_SETTING_ROWS) {
      assert.equal(catalogKeys.has(row.setting_key), true, `${row.setting_key} missing from SETTINGS_CATALOG`);
    }
  });

  it("defaults ATLAS to preferred, all phases, live funnel, and smart reindex", () => {
    assert.equal(SETTINGS_DEFAULTS.atlas_mode, "preferred");
    assert.equal(SETTINGS_DEFAULTS.atlas_v2, "on");
    assert.equal(SETTINGS_DEFAULTS.atlas_phases, "research,planning,assessment,dev");
    assert.equal(SETTINGS_DEFAULTS.atlas_live_funnel, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_live_index, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_live_buffers, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_tool_gate_enabled, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_parse_per_lang_tandem, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_parse_onnx_background_initial, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_tree_compression_mode, "ml");
    assert.equal(SETTINGS_DEFAULTS.atlas_tree_compression_model_tier, "standard");
    assert.equal(SETTINGS_DEFAULTS.atlas_tree_compression_max_seeds, "80");
    assert.equal(SETTINGS_DEFAULTS.atlas_tree_compression_model_max_seeds, "40");
    assert.equal(SETTINGS_DEFAULTS.atlas_embedding_threads, "2");
    assert.equal(SETTINGS_DEFAULTS.atlas_boot_reindex_policy, "smart");
    assert.equal(SETTINGS_DEFAULTS.atlas_reindex_on_commit, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_scip_restage_policy, "smart");
    assert.equal(SETTINGS_DEFAULTS.atlas_scip_mode, "on");
    assert.equal(SETTINGS_DEFAULTS.atlas_semantic_enabled, "true");
    assert.equal(SETTINGS_DEFAULTS.atlas_embedding_provider, "jina-v2-code");
    assert.equal(SETTINGS_DEFAULTS.atlas_drift_check, "true");
  });

  it("normalizes ATLAS tree compression config from admin-shaped keys", async () => {
    const { getAtlasIntegrationConfig } = await import("../lib/domains/integrations/functions/atlas/config.js");

    const defaults = getAtlasIntegrationConfig({});
    assert.equal(defaults.treeCompressionMode, "deterministic");
    assert.equal(defaults.treeCompressionMlEnabled, false);
    assert.equal(defaults.treeCompressionMaxSeeds, 80);
    assert.equal(defaults.treeCompressionModelMaxSeeds, 40);

    const config = getAtlasIntegrationConfig({
      atlas_tree_compression_mode: "ml",
      atlas_tree_compression_provider: "OpenAI",
      atlas_tree_compression_model_tier: "standard",
      atlas_tree_compression_max_seeds: "999",
      atlas_tree_compression_model_max_seeds: "0",
    });

    assert.equal(config.treeCompressionMode, "ml");
    assert.equal(config.treeCompressionMlEnabled, true);
    assert.equal(config.treeCompressionProvider, "openai");
    assert.equal(config.treeCompressionModelTier, "standard");
    assert.equal(config.treeCompressionMaxSeeds, 500);
    assert.equal(config.treeCompressionModelMaxSeeds, 1);
  });

  it("preserves explicit ATLAS tool-gate false settings during default migration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-settings-gate-default-"));
    const dbPath = path.join(dir, "account.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE account_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `);
      db.prepare(`INSERT INTO account_settings (setting_key, setting_value) VALUES (?, ?)`)
        .run("atlas_tool_gate_enabled", "false");
    } finally {
      db.close();
    }

    const settings = new AccountSettings({ dbPath });
    try {
      assert.equal(settings.get("atlas_tool_gate_enabled"), "false");
      settings.close();

      const reopened = new AccountSettings({ dbPath });
      try {
        assert.equal(reopened.get("atlas_tool_gate_enabled"), "false");
      } finally {
        reopened.close();
      }
    } finally {
      settings.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates empty legacy ATLAS tool-gate defaults once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-settings-gate-empty-default-"));
    const dbPath = path.join(dir, "account.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE account_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `);
      db.prepare(`INSERT INTO account_settings (setting_key, setting_value) VALUES (?, ?)`)
        .run("atlas_tool_gate_enabled", "");
    } finally {
      db.close();
    }

    const settings = new AccountSettings({ dbPath });
    try {
      assert.equal(settings.get("atlas_tool_gate_enabled"), "true");
      settings.set("atlas_tool_gate_enabled", "false");
      settings.close();

      const reopened = new AccountSettings({ dbPath });
      try {
        assert.equal(reopened.get("atlas_tool_gate_enabled"), "false");
      } finally {
        reopened.close();
      }
    } finally {
      settings.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates booleans, enums, numeric rules, and ATLAS phases through one catalog", () => {
    assert.equal(BOOLEAN_SETTING_KEYS.has("auto_merge_completed"), true);
    assert.ok(ENUM_SETTING_OPTIONS.codex_auth_mode.some((choice) => choice.value === "oauth"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_v2.some((choice) => choice.value === "v2"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_scip_mode.some((choice) => choice.value === "on"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_scip_restage_policy.some((choice) => choice.value === "smart"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_tree_compression_mode.some((choice) => choice.value === "ml"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_tree_compression_model_tier.some((choice) => choice.value === "cheap"));
    assert.ok(ENUM_SETTING_OPTIONS.atlas_memory_surface.some((choice) => choice.value === "auto"));
    assert.ok(ENUM_SETTING_OPTIONS.posse_kaizen_to_atlas.some((choice) => choice.value === "shadow"));
    assert.equal(MULTI_SETTING_KEYS.has("atlas_scip_languages"), true);
    assert.equal(MULTI_SETTING_VALUES.atlas_scip_languages.has("python"), true);
    assert.equal(NUMERIC_SETTING_RULES.atlas_scip_cold_index_timeout_ms.min, 1000);
    assert.equal(NUMERIC_SETTING_RULES.atlas_handoff_prefetch_timeout_ms.min, 1000);
    assert.equal(NUMERIC_SETTING_RULES.scheduler_concurrency.min, 1);
    assert.equal(NUMERIC_SETTING_RULES.worker_provider_circuit_ttl_ms.min, 1000);
    assert.equal(NUMERIC_SETTING_RULES.worker_lease_renew_max_transient_errors.min, 0);
    assert.equal(NUMERIC_SETTING_RULES.handoff_max_preload_total_bytes.min, 1);
    assert.equal(NUMERIC_SETTING_RULES.atlas_scip_max_age_hours.min, 0);
    assert.equal(NUMERIC_SETTING_RULES.atlas_parse_file_progress_throttle_ms.min, 0);
    assert.equal(NUMERIC_SETTING_RULES.atlas_parse_onnx_background_batch_size.min, 1);
    assert.equal(NUMERIC_SETTING_RULES.atlas_tree_compression_max_seeds.max, 500);
    assert.equal(NUMERIC_SETTING_RULES.atlas_tree_compression_model_max_seeds.max, 200);
    assert.equal(NUMERIC_SETTING_RULES.atlas_embedding_threads.min, 1);
    assert.equal(NUMERIC_SETTING_RULES.atlas_embedding_threads.max, 8);
    assert.equal(NUMERIC_SETTING_RULES.claude_usage_cache_ms.min, 1000);
    assert.equal(NUMERIC_SETTING_RULES.claude_limit_tokens_session.min, 0);
    assert.equal(NUMERIC_SETTING_RULES.openai_limit_tokens_week.integer, true);
    assert.equal(NUMERIC_SETTING_RULES.claude_observed_pct_session.max, 100);
    assert.equal(NUMERIC_SETTING_RULES.openai_observed_pct_week.max, 100);
    assert.equal(ATLAS_PHASE_VALUES.has("planning"), true);

    assert.deepEqual(validateAdminSettingValue("auto_merge_completed", "TRUE"), {
      ok: true,
      storageKey: "auto_merge_completed",
      value: "true",
    });
    assert.deepEqual(validateAdminSettingValue("codex_auth_mode", "api"), {
      ok: true,
      storageKey: "codex_auth_mode",
      value: "api",
    });
    assert.deepEqual(validateAdminSettingValue("atlas_v2", "v2"), {
      ok: true,
      storageKey: "atlas_v2",
      value: "v2",
    });
    assert.deepEqual(validateAdminSettingValue("atlas_scip_mode", "on"), {
      ok: true,
      storageKey: "atlas_scip_mode",
      value: "on",
    });
    assert.deepEqual(validateAdminSettingValue("atlas_scip_restage_policy", "smart"), {
      ok: true,
      storageKey: "atlas_scip_restage_policy",
      value: "smart",
    });
    assert.deepEqual(validateAdminSettingValue("atlas_memory_surface", "on"), {
      ok: true,
      storageKey: "atlas_memory_surface",
      value: "on",
    });
    assert.deepEqual(validateAdminSettingValue("posse_kaizen_to_atlas", "write"), {
      ok: true,
      storageKey: "posse_kaizen_to_atlas",
      value: "write",
    });
    assert.deepEqual(validateAdminSettingValue("scheduler_concurrency", "3"), {
      ok: true,
      storageKey: "scheduler_concurrency",
      value: "3",
    });
    assert.equal(validateAdminSettingValue("scheduler_concurrency", "0").ok, false);
    assert.deepEqual(validateAdminSettingValue("worker_lease_renew_max_transient_errors", "0"), {
      ok: true,
      storageKey: "worker_lease_renew_max_transient_errors",
      value: "0",
    });
    assert.equal(validateAdminSettingValue("worker_provider_circuit_ttl_ms", "999").ok, false);
    assert.deepEqual(validateAdminSettingValue("atlas_phases", "research,dev"), {
      ok: true,
      storageKey: "atlas_phases",
      value: "research,dev",
    });
    assert.equal(validateAdminSettingValue("atlas_phases", "unknown").ok, false);
    assert.deepEqual(validateAdminSettingValue("atlas_scip_languages", "TypeScript,Python"), {
      ok: true,
      storageKey: "atlas_scip_languages",
      value: "typescript,python",
    });
    assert.equal(validateAdminSettingValue("atlas_scip_languages", "ruby").ok, false);

    assert.deepEqual(validateAdminSettingValue("claude_limit_tokens_session", "10000"), {
      ok: true,
      storageKey: "claude_limit_tokens_session",
      value: "10000",
    });
    assert.equal(validateAdminSettingValue("claude_limit_tokens_session", "-1").ok, false);
    assert.equal(validateAdminSettingValue("openai_limit_tokens_week", "1.5").ok, false);
    assert.deepEqual(validateAdminSettingValue("openai_observed_pct_session", "12.5"), {
      ok: true,
      storageKey: "openai_observed_pct_session",
      value: "12.5",
    });
    assert.equal(validateAdminSettingValue("openai_observed_pct_session", "101").ok, false);
    assert.equal(validateAdminSettingValue("openai_observed_pct_session", "NaN").ok, false);

    assert.deepEqual(validateCatalogSettingValue("claude_limit_tokens_session", "10000"), {
      ok: true,
      key: "claude_limit_tokens_session",
      value: "10000",
    });
    assert.equal(validateCatalogSettingValue("claude_limit_tokens_session", "-1").ok, false);
    assert.equal(validateCatalogSettingValue("openai_limit_tokens_week", "1.5").ok, false);
    assert.deepEqual(validateCatalogSettingValue("openai_observed_pct_session", "12.5"), {
      ok: true,
      key: "openai_observed_pct_session",
      value: "12.5",
    });
    assert.equal(validateCatalogSettingValue("openai_observed_pct_session", "101").ok, false);
    assert.equal(validateCatalogSettingValue("openai_observed_pct_session", "NaN").ok, false);
    assert.deepEqual(validateCatalogSettingValue("grok_limit_tokens_session", "10000"), {
      ok: true,
      key: "grok_limit_tokens_session",
      value: "10000",
    });
    assert.equal(validateCatalogSettingValue("grok_limit_tokens_session", "-1").ok, false);
  });

  it("maps legacy max-turn display keys back to storage keys", () => {
    assert.equal(toDisplaySettingKey("max_turns_dev"), "base_turns_dev");
    assert.equal(toStorageSettingKey("base_turns_dev"), "max_turns_dev");
    assert.equal(isCatalogKey(toStorageSettingKey("base_turns_dev")), true);
  });

  it("classifies noisy runtime knobs as debug tuning settings", () => {
    for (const key of [
      "scheduler_poll_ms",
      "assessor_fallback_reads",
      "handoff_max_context_chars",
      "atlas_scip_index_timeout_ms",
      "atlas_handoff_prefetch_timeout_ms",
      "atlas_tree_compression_max_seeds",
      "atlas_tree_compression_model_max_seeds",
      "atlas_embedding_threads",
      "posse_display_event_rate_limit_per_sec",
    ]) {
      assert.equal(TUNING_SETTING_KEYS.has(key), true, `${key} should live in Debug / Tuning`);
    }
    assert.equal(TUNING_SETTING_KEYS.has("auto_merge_completed"), false);
    assert.equal(TUNING_SETTING_KEYS.has("scheduler_concurrency"), false);
  });

  it("keeps internal Atlas Parse knobs hidden from the admin editor and backed by readers", () => {
    const hiddenParseReaders = {
      atlas_parse_max_parallel: "getAtlasParseMaxParallel",
      atlas_parse_per_lang_tandem: "getAtlasParsePerLangTandem",
      atlas_parse_file_progress_throttle_ms: "getAtlasParseFileProgressThrottleMs",
      atlas_parse_band_max_rows: "getAtlasParseBandMaxRows",
      atlas_parse_onnx_background_initial: "getAtlasParseOnnxBackgroundInitial",
      atlas_parse_onnx_background_batch_size: "getAtlasParseOnnxBackgroundBatchSize",
    };

    for (const [key, reader] of Object.entries(hiddenParseReaders)) {
      assert.equal(isAdminVisibleCatalogKey(key), false, `${key} should stay hidden from the admin editor`);
      assert.equal(typeof tunables[reader], "function", `${key} missing ${reader}`);
    }
  });

});
