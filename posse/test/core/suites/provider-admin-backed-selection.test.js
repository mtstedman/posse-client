import {
  it,
  beforeEach,
  assert,
  fs,
  os,
  path,
  suite,
  runtimeModules,
  now,
  resetRuntimeDb,
  withEnv,
  getAvailableProviders,
  getProviderBackoff,
  getProviderMap,
  getProviderName,
  getProviderRateLimitState,
  getProviderAtlasMap,
  getProviderAtlasSupport,
  getProviderTierInfo,
  isMultiProvider,
  isProviderReady,
  isProviderSelectable,
  needsDelegation,
  providerSupportsAtlas,
  selectProviderName,
  tierModelName,
  getAtlasIntegrationConfig,
} from "../support/core-harness.js";

let db;

suite("Provider admin-backed selection", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("drops the legacy per-repo queue_settings table on DB reopen", () => {
    const { dbMod } = runtimeModules;
    const db = dbMod.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.prepare(`INSERT OR REPLACE INTO queue_settings (setting_key, setting_value) VALUES (?, ?)`)
      .run("provider_dev", "codex");
    db.prepare(`INSERT OR REPLACE INTO queue_settings (setting_key, setting_value) VALUES (?, ?)`)
      .run("codex_model_standard", "gpt-5.2-codex");
    dbMod.closeDb();
    const reopened = dbMod.getDb();
    const row = reopened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_settings'`).get();
    assert.equal(row, undefined);
  });

  it("resolves provider names from global account settings", () => {
    const { queueMod } = runtimeModules;
    queueMod.setSetting("provider_dev", "grok,codex");
    assert.equal(getProviderName("dev"), "grok");
  });

  it("ignores legacy provider_global rows in runtime provider routing", () => {
    const { queueMod } = runtimeModules;
    try {
      queueMod.setSetting("provider_global", "openai");
      queueMod.setSetting("provider_dev", "codex");
      queueMod.setSetting("provider_assessor", null);

      assert.equal(getProviderName("dev"), "codex");
      assert.deepEqual(getAvailableProviders("dev"), ["codex"]);
      assert.equal(getProviderName("assessor"), "claude");
    } finally {
      queueMod.setSetting("provider_global", null);
    }
  });

  it("ignores legacy provider env overrides at runtime", () => {
    const { queueMod } = runtimeModules;
    withEnv({ POSSE_PROVIDER_ASSESSOR: "openai,claude" }, () => {
      queueMod.setSetting("provider_assessor", "claude");
      assert.equal(getProviderName("assessor"), "claude");
      assert.deepEqual(getAvailableProviders("assessor"), ["claude"]);
    });
  });

  it("falls back to claude when no provider setting is saved", () => {
    const { queueMod } = runtimeModules;
    withEnv({ POSSE_PROVIDER: "grok", POSSE_PROVIDER_DEV: "codex" }, () => {
      queueMod.setSetting("provider_dev", null);
      assert.equal(getProviderName("dev"), "claude");
      assert.deepEqual(getAvailableProviders("dev"), ["claude"]);
    });
  });

  it("round-robins provider selection across configured role providers", () => {
    const { queueMod } = runtimeModules;
    withEnv({ OPENAI_API_KEY: "test-openai-key", XAI_API_KEY: "test-xai-key" }, () => {
      queueMod.setSetting("provider_dev", "openai,grok");
      const first = selectProviderName("dev");
      const second = selectProviderName("dev");
      assert.notEqual(first, second);
      assert.ok(["openai", "grok"].includes(first));
      assert.ok(["openai", "grok"].includes(second));
    });
  });

  it("skips rate-limited providers when a ready alternate exists", async () => {
    const { queueMod } = runtimeModules;
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    await withEnv({ OPENAI_API_KEY: "test-openai-key", XAI_API_KEY: "test-xai-key" }, async () => {
      queueMod.setSetting("provider_dev", "openai,grok");
      try {
        openaiMod.tripRateLimit(1, "test-rate-limit");
        assert.equal(selectProviderName("dev"), "grok");
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    });
  });

  it("does not reset role round-robin when provider availability changes", async () => {
    const { queueMod } = runtimeModules;
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    const { providerRegistry } = await import("../../../lib/domains/providers/functions/provider.js");
    await withEnv({ OPENAI_API_KEY: "test-openai-key", XAI_API_KEY: "test-xai-key" }, async () => {
      queueMod.setSetting("provider_dev", "openai,grok");
      providerRegistry.resetSelectionCursor();
      try {
        assert.equal(selectProviderName("dev"), "openai");
        assert.equal(selectProviderName("dev"), "grok");
        openaiMod.tripRateLimit(1, "test-rate-limit");
        assert.equal(selectProviderName("dev"), "grok");
        openaiMod.tripRateLimit(0);
        assert.equal(selectProviderName("dev"), "grok");
      } finally {
        openaiMod.tripRateLimit(0);
        providerRegistry.resetSelectionCursor();
      }
    });
  });

  it("reports multi-provider delegation status and provider map", () => {
    const { queueMod } = runtimeModules;
    queueMod.setSetting("provider_dev", "claude,codex");
    queueMod.setSetting("provider_assessor", "claude");
    assert.equal(isMultiProvider("dev"), true);
    assert.equal(needsDelegation(), true);
    const map = getProviderMap();
    assert.deepEqual(map.dev, ["claude", "codex"]);
    assert.deepEqual(map.assessor, ["claude"]);
  });

  it("resolves tier model names from global account settings", () => {
    const { queueMod } = runtimeModules;
    queueMod.setSetting("openai_model_standard", "gpt-test-standard");
    queueMod.setSetting("grok_model_strong", "grok-test-strong");
    queueMod.setSetting("codex_model_cheap", "gpt-test-cheap");

    assert.equal(getProviderTierInfo("openai", "standard").model, "gpt-test-standard");
    assert.equal(getProviderTierInfo("grok", "strong").model, "grok-test-strong");
    assert.equal(getProviderTierInfo("codex", "cheap").model, "gpt-test-cheap");
  });

  it("treats provider model tier settings as live runtime settings", () => {
    const { queueMod } = runtimeModules;

    queueMod.setSetting("openai_model_standard", "gpt-live-first");
    assert.equal(getProviderTierInfo("openai", "standard").model, "gpt-live-first");

    queueMod.setSetting("openai_model_standard", "gpt-live-second");
    assert.equal(getProviderTierInfo("openai", "standard").model, "gpt-live-second");
  });

  it("returns raw provider model ids for tier model names", () => {
    const { queueMod } = runtimeModules;
    // Model tier names live in the global account settings DB, which is shared
    // across the whole aggregate core run. Clear the claude standard override so
    // a leaked value from an earlier suite cannot mask the provider-tier default.
    const previousClaudeStandard = queueMod.getSetting("claude_model_standard");
    queueMod.setSetting("claude_model_standard", null);
    try {
      queueMod.setSetting("openai_model_standard", "gpt-test-standard");

      assert.equal(tierModelName("standard", { providerName: "openai" }), "gpt-test-standard");
      assert.equal(tierModelName("standard", { providerName: "claude" }), "sonnet");
    } finally {
      queueMod.setSetting("claude_model_standard", previousClaudeStandard);
    }
  });

  it("uses provider-specific defaults instead of Claude names for blank tier configs", async () => {
    const { providerRegistry } = await import("../../../lib/domains/providers/functions/provider.js");
    const originalOpenAi = providerRegistry.get("openai");
    providerRegistry.register("openai", {
      MODEL_TIERS: { standard: { model: "" } },
      getModelTierConfig: () => ({ model: "" }),
      callProvider: async () => ({ output: "", stats: {} }),
    });
    try {
      assert.equal(tierModelName("standard", { providerName: "openai" }), "gpt-4.1");
    } finally {
      if (originalOpenAi) providerRegistry.providers.set("openai", originalOpenAi);
    }
  });

  it("only marks keyed providers selectable in admin-facing checks", () => {
    withEnv({
      OPENAI_API_KEY: null,
      XAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      assert.equal(isProviderSelectable("openai"), false);
      assert.equal(isProviderSelectable("grok"), false);
    });
  });

  it("marks Codex unavailable without credentials even if the module loads", () => {
    withEnv({
      OPENAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      const codexAuthPath = path.join(os.homedir(), ".codex", "auth.json");
      const originalExistsSync = fs.existsSync;
      fs.existsSync = (candidate) => {
        if (path.resolve(String(candidate)) === path.resolve(codexAuthPath)) return false;
        return originalExistsSync(candidate);
      };
      try {
        const ready = isProviderReady("codex");
        assert.equal(ready.ready, false);
        assert.match(ready.reason || "", /auth mode is oauth/i);
        assert.match(ready.reason || "", /API-key auth is disabled unless codex_auth_mode is explicitly api/i);
      } finally {
        fs.existsSync = originalExistsSync;
      }
    });
  });

  it("exposes provider backoff and rate-limit state through provider adapters", () => {
    const backoff = getProviderBackoff("claude", new Error("429 rate_limit exceeded"));
    assert.equal(typeof backoff.backoffSec, "number");
    assert.equal(typeof backoff.isRateLimit, "boolean");
    assert.equal(typeof backoff.source, "string");

    const state = getProviderRateLimitState("claude");
    assert.equal(typeof state.blocked, "boolean");
    assert.equal(typeof state.retryInSec, "number");
    assert.equal(typeof state.reason, "string");
  });

  it("persists long provider rate-limit cooldowns beyond process-local breaker state", async () => {
    const { queueMod } = runtimeModules;
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    try {
      queueMod.setSetting("openai_rate_limit_state", null);
      const err = new Error("rate limit");
      err.status = 429;
      err.headers = { "retry-after": "120" };

      const backoff = getProviderBackoff("openai", err);
      assert.equal(backoff.isRateLimit, true);
      assert.equal(backoff.backoffSec, 120);

      openaiMod.tripRateLimit(0);
      const state = getProviderRateLimitState("openai");
      assert.equal(state.blocked, true);
      assert.equal(state.reason, "retry-after");
      assert.ok(state.retryInSec > 0);
    } finally {
      queueMod.setSetting("openai_rate_limit_state", null);
      openaiMod.tripRateLimit(0);
    }
  });

  it("exposes provider ATLAS transport support through the shared provider contract", () => {
    const claudeAtlas = getProviderAtlasSupport("claude");
    const openaiAtlas = getProviderAtlasSupport("openai");
    const codexAtlas = getProviderAtlasSupport("codex");
    const supportMap = getProviderAtlasMap();

    assert.equal(claudeAtlas.transport, "mcp-gateway");
    assert.equal(openaiAtlas.transport, "embedded");
    assert.equal(codexAtlas.transport, "mcp-gateway");
    assert.equal(providerSupportsAtlas("claude"), true);
    assert.equal(providerSupportsAtlas("codex"), true);
    assert.equal(supportMap.grok.transport, "embedded");
  });

  it("marks provider ATLAS support active only when ATLAS mode is enabled", () => {
    const disabled = getProviderAtlasSupport("claude", {
      config: getAtlasIntegrationConfig({ POSSE_ATLAS_V2: "off" }),
    });
    const enabled = getProviderAtlasSupport("openai", {
      config: getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "preferred",
        POSSE_ATLAS_PHASES: "research",
      }),
    });

    assert.equal(disabled.supported, true);
    assert.equal(disabled.configured, false);
    assert.equal(disabled.active, false);

    assert.equal(enabled.supported, true);
    assert.equal(enabled.configured, true);
    assert.equal(enabled.active, true);
    assert.equal(enabled.mode, "preferred");
  });

  it("builds an ATLAS support map with provider-specific transports", () => {
    const supportMap = getProviderAtlasMap({
      config: getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "shadow",
        POSSE_ATLAS_PHASES: "research,planning",
      }),
    });

    assert.deepEqual(
      Object.fromEntries(Object.entries(supportMap).map(([key, value]) => [key, value.transport])),
      {
        claude: "mcp-gateway",
        openai: "embedded",
        grok: "embedded",
        codex: "mcp-gateway",
        copilot: "none",
      }
    );
    assert.equal(supportMap.claude.active, true);
    assert.equal(supportMap.codex.active, true);
  });
});
