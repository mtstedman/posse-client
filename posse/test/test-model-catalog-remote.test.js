// Remote model catalog: payload normalization, builtin∪remote merge
// semantics, stale-model runtime fallback, and CLI↔posse-remote curated-data
// drift. The store is seeded via setRemoteCatalogForTest so no settings DB or
// network is involved except where a temp account DB is explicitly attached.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  __resetRemoteModelCatalogStoreForTests,
  getRemotePricingMap,
  normalizeRemoteModelCatalog,
  setRemoteCatalogForTest,
} from "../lib/domains/providers/functions/model-catalog-store.js";
import {
  TEXT_MODEL_CHOICES_BY_PROVIDER,
  IMAGE_MODEL_CHOICES_BY_PROVIDER,
  getDefaultTierModel,
  getKnownTextModels,
  getMergedTextModels,
  getModelCatalogStatus,
  getTextModelOptions,
} from "../lib/domains/providers/functions/model-catalog.js";
import {
  __resetModelCatalogValidationForTests,
  resolveEffectiveTierModel,
  validateConfiguredModels,
} from "../lib/domains/providers/functions/model-catalog-validate.js";
import {
  setAccountSetting,
  setAccountSettingsDbPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

function rawCatalog(overrides = {}) {
  return {
    schema_version: 1,
    catalog_version: "2026.06.11-test",
    generated_at: "2026-06-11T00:00:00Z",
    providers: {
      claude: {
        tier_defaults: { strong: "claude-fable-5" },
        text_models: [
          { id: "claude-fable-5", tier: "strong", deprecated: false, pricing: { input_per_million_usd: 10, output_per_million_usd: 50, cached_input_per_million_usd: 1 } },
          { id: "claude-opus-4-20250514", deprecated: true, successor: "claude-opus-4-8" },
          { id: "claude-zeta-6", tier: "strong", aliases: ["zeta"] },
        ],
        image_models: [],
        listing: { source: "anthropic", checked_at: "2026-06-11T00:00:00Z", live: true },
      },
    },
    ...overrides,
  };
}

function seedStore(raw = rawCatalog()) {
  const normalized = normalizeRemoteModelCatalog(raw);
  assert.ok(normalized, "fixture catalog must normalize");
  setRemoteCatalogForTest(normalized);
  return normalized;
}

describe("remote model catalog", () => {
  beforeEach(() => {
    setRemoteCatalogForTest(null);
    __resetModelCatalogValidationForTests();
  });

  after(() => {
    setRemoteCatalogForTest(null);
    __resetModelCatalogValidationForTests();
  });

  describe("normalizeRemoteModelCatalog", () => {
    it("rejects unsupported schema versions and structural failures", () => {
      assert.equal(normalizeRemoteModelCatalog(null), null);
      assert.equal(normalizeRemoteModelCatalog({}), null);
      assert.equal(normalizeRemoteModelCatalog(rawCatalog({ schema_version: 2 })), null);
      assert.equal(normalizeRemoteModelCatalog(rawCatalog({ catalog_version: "" })), null);
      assert.equal(normalizeRemoteModelCatalog(rawCatalog({ providers: {} })), null);
    });

    it("ignores unknown fields and unknown providers", () => {
      const raw = rawCatalog();
      raw.future_field = { anything: true };
      raw.providers.claude.future = "yes";
      raw.providers.claude.text_models[0].brand_new_flag = 7;
      raw.providers["not-a-provider"] = { text_models: [{ id: "x" }] };
      const normalized = normalizeRemoteModelCatalog(raw);
      assert.ok(normalized);
      assert.deepEqual(Object.keys(normalized.providers), ["claude"]);
      assert.equal(normalized.providers.claude.textModels[0].id, "claude-fable-5");
      assert.equal("brand_new_flag" in normalized.providers.claude.textModels[0], false);
    });

    it("drops invalid ids, invalid pricing, and empty providers", () => {
      const raw = rawCatalog();
      raw.providers.claude.text_models.push(
        { id: "  " },
        { id: "bad id with spaces" },
        { id: "x".repeat(200) },
        { id: "claude-bad-pricing", pricing: { input_per_million_usd: -1, output_per_million_usd: 5 } },
        { id: "claude-huge-pricing", pricing: { input_per_million_usd: 99999, output_per_million_usd: 5 } },
      );
      const normalized = normalizeRemoteModelCatalog(raw);
      const ids = normalized.providers.claude.textModels.map((model) => model.id);
      assert.ok(!ids.some((id) => id.includes(" ")));
      assert.ok(!ids.some((id) => id.length > 128));
      const badPricing = normalized.providers.claude.textModels.find((model) => model.id === "claude-bad-pricing");
      assert.equal(badPricing.pricing, null);
      const hugePricing = normalized.providers.claude.textModels.find((model) => model.id === "claude-huge-pricing");
      assert.equal(hugePricing.pricing, null);

      // A provider whose text models all fail validation is dropped entirely.
      const emptied = rawCatalog();
      emptied.providers.claude.text_models = [{ id: "###" }];
      assert.equal(normalizeRemoteModelCatalog(emptied), null);
    });

    it("dedupes ids and caps the per-provider model count", () => {
      const raw = rawCatalog();
      raw.providers.claude.text_models = [
        { id: "claude-dup" },
        { id: "CLAUDE-DUP" },
        ...Array.from({ length: 300 }, (_, i) => ({ id: `claude-bulk-${i}` })),
      ];
      const normalized = normalizeRemoteModelCatalog(raw);
      const ids = normalized.providers.claude.textModels.map((model) => model.id);
      assert.equal(ids.filter((id) => id === "claude-dup").length, 1);
      assert.ok(ids.length <= 200);
    });
  });

  describe("merge semantics", () => {
    it("appends remote-only models after the builtin order and excludes deprecated", () => {
      seedStore();
      const merged = getMergedTextModels("claude");
      const builtin = TEXT_MODEL_CHOICES_BY_PROVIDER.claude;
      assert.deepEqual(merged.slice(0, 3), builtin.slice(0, 3));
      assert.ok(merged.includes("claude-zeta-6"));
      assert.ok(!merged.includes("claude-opus-4-20250514"), "remote deprecated flag removes builtin entry from selection");
      // Untouched providers keep their builtin lists.
      assert.deepEqual(getMergedTextModels("grok"), [...TEXT_MODEL_CHOICES_BY_PROVIDER.grok]);
    });

    it("known set includes deprecated models and aliases for membership checks", () => {
      seedStore();
      const known = getKnownTextModels("claude");
      assert.ok(known.has("claude-opus-4-20250514"));
      assert.ok(known.has("claude-zeta-6"));
      assert.ok(known.has("zeta"));
      assert.deepEqual(getModelCatalogStatus("claude", "claude-opus-4-20250514"), {
        known: true,
        deprecated: true,
        successor: "claude-opus-4-8",
      });
      assert.deepEqual(getModelCatalogStatus("claude", "never-existed"), {
        known: false,
        deprecated: false,
        successor: null,
      });
    });

    it("remote tier defaults override builtin only when the model exists", () => {
      assert.equal(getDefaultTierModel("claude", "strong"), "opus");
      seedStore();
      assert.equal(getDefaultTierModel("claude", "strong"), "claude-fable-5");
      const dangling = rawCatalog();
      dangling.providers.claude.tier_defaults = { strong: "claude-not-served" };
      seedStore(dangling);
      assert.equal(getDefaultTierModel("claude", "strong"), "opus");
    });

    it("keeps a deprecated configured value selectable, annotated; unknown strings stay unset", () => {
      seedStore();
      const options = getTextModelOptions("claude", { currentValue: "claude-opus-4-20250514" });
      const annotated = options.find((option) => option.value === "claude-opus-4-20250514");
      assert.ok(annotated);
      assert.match(annotated.label, /deprecated/);
      // Unknown user-typed strings are not surfaced as options — dropdowns
      // keep their pre-catalog "treat as unset" behavior.
      const missing = getTextModelOptions("claude", { currentValue: "user-typed-model" });
      assert.equal(missing.some((option) => option.value === "user-typed-model"), false);
    });

    it("builds the pricing map with alias keys", () => {
      seedStore();
      const map = getRemotePricingMap();
      assert.deepEqual(map.get("claude:claude-fable-5"), { input: 10, output: 50, cachedInput: 1 });
      assert.equal(map.has("claude:zeta"), false, "models without pricing contribute no keys");
    });
  });

  describe("resolveEffectiveTierModel", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-model-catalog-"));
      setAccountSettingsDbPathForTests(path.join(tmpDir, "account.db"));
      seedStore();
    });

    after(() => {
      setAccountSettingsDbPathForTests(null);
    });

    it("falls back for deprecated and missing models by default", () => {
      const deprecated = resolveEffectiveTierModel("claude", "strong", "claude-opus-4-20250514");
      assert.equal(deprecated.fellBack, true);
      assert.equal(deprecated.reason, "deprecated");
      assert.equal(deprecated.model, getDefaultTierModel("claude", "strong"));

      const missing = resolveEffectiveTierModel("claude", "strong", "made-up-model");
      assert.equal(missing.fellBack, true);
      assert.equal(missing.reason, "missing");

      const healthy = resolveEffectiveTierModel("claude", "standard", "sonnet");
      assert.equal(healthy.fellBack, false);
      assert.equal(healthy.model, "sonnet");
    });

    it("warn_only keeps the configured model; off skips validation entirely", () => {
      setAccountSetting("model_catalog_enforcement", "warn_only");
      const warned = resolveEffectiveTierModel("claude", "strong", "made-up-model");
      assert.equal(warned.fellBack, false);
      assert.equal(warned.model, "made-up-model");
      assert.equal(warned.reason, "missing");

      setAccountSetting("model_catalog_enforcement", "off");
      const off = resolveEffectiveTierModel("claude", "strong", "made-up-model");
      assert.equal(off.fellBack, false);
      assert.equal(off.reason, null);
      setAccountSetting("model_catalog_enforcement", "");
    });

    it("codex missing-from-catalog is warn-only; explicit deprecation falls back", () => {
      const codexCatalog = rawCatalog();
      codexCatalog.providers.codex = {
        tier_defaults: {},
        text_models: [
          { id: "gpt-5.4" },
          { id: "gpt-5.3-codex", deprecated: true },
        ],
        image_models: [],
        listing: { source: "curated", checked_at: null, live: false },
      };
      seedStore(codexCatalog);

      const missing = resolveEffectiveTierModel("codex", "standard", "gpt-9-codex-preview");
      assert.equal(missing.fellBack, false, "codex CLI probe is authoritative for unknown models");
      assert.equal(missing.reason, "missing");

      // standard tier: fallback (gpt-5.4) differs from the deprecated model.
      const deprecated = resolveEffectiveTierModel("codex", "standard", "gpt-5.3-codex");
      assert.equal(deprecated.fellBack, true);
      assert.equal(deprecated.reason, "deprecated");
      assert.equal(deprecated.model, "gpt-5.4");

      // cheap tier: the tier default IS the deprecated model — the guard
      // keeps the original rather than "falling back" onto itself.
      const selfDefault = resolveEffectiveTierModel("codex", "cheap", "gpt-5.3-codex");
      assert.equal(selfDefault.fellBack, false);
    });

    it("never falls back onto an unknown or identical fallback model", () => {
      const sparse = rawCatalog();
      sparse.providers.claude.tier_defaults = {};
      seedStore(sparse);
      // Builtin default for claude/strong is "opus" (known via builtin list) —
      // falling back from itself must keep the original.
      const selfFallback = resolveEffectiveTierModel("claude", "strong", getDefaultTierModel("claude", "strong"));
      assert.equal(selfFallback.fellBack, false);
    });

    it("validateConfiguredModels reports stale settings without rewriting them", () => {
      setAccountSetting("claude_model_strong", "claude-opus-4-20250514");
      setAccountSetting("grok_model_cheap", "grok-3-mini");
      const warnings = validateConfiguredModels();
      const stale = warnings.find((warning) => warning.key === "claude_model_strong");
      assert.ok(stale);
      assert.equal(stale.status, "deprecated");
      assert.equal(stale.successor, "claude-opus-4-8");
      assert.ok(!warnings.some((warning) => warning.key === "grok_model_cheap"));
    });
  });

  describe("CLI ↔ posse-remote curated drift", () => {
    it("keeps the Rust curated catalog in sync with the builtin CLI lists", (t) => {
      const rustCatalogPath = path.resolve(
        repoDir, "..", "..", "posse", "posse-remote", "rust", "catalog", "model_catalog.rs",
      );
      if (!fs.existsSync(rustCatalogPath)) {
        t.skip("posse-remote checkout not present; drift check runs where the sibling repo exists");
        return;
      }
      const source = fs.readFileSync(rustCatalogPath, "utf8");
      const segments = source.split(/provider:\s*"/).slice(1);
      const rustByProvider = {};
      for (const segment of segments) {
        const provider = segment.slice(0, segment.indexOf('"'));
        const text = [...segment.matchAll(/text_model\(\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
        const image = [...segment.matchAll(/image_model\(\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
        rustByProvider[provider] = { text, image };
      }
      for (const [provider, builtin] of Object.entries(TEXT_MODEL_CHOICES_BY_PROVIDER)) {
        assert.ok(rustByProvider[provider], `provider ${provider} missing from Rust curated catalog`);
        assert.deepEqual(
          rustByProvider[provider].text.slice().sort(),
          builtin.slice().sort(),
          `text model drift for ${provider} between CLI builtin list and posse-remote curated catalog`,
        );
      }
      for (const [provider, builtin] of Object.entries(IMAGE_MODEL_CHOICES_BY_PROVIDER)) {
        assert.deepEqual(
          (rustByProvider[provider]?.image || []).slice().sort(),
          builtin.slice().sort(),
          `image model drift for ${provider} between CLI builtin list and posse-remote curated catalog`,
        );
      }
    });
  });
});
