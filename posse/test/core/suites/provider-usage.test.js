import {
  it,
  before,
  assert,
  fs,
  os,
  path,
  suite,
  runtimeModules,
  now,
  withAccountSettingsPath,
  writeAccountSettingsDb,
  withClaudeConfigDir,
  closeAccountSettingsDb,
  getProviderUsage,
  getProviderUsageAsync,
  inferProviderWindowLimit,
} from "../support/core-harness.js";

suite("Provider usage", () => {
  it("summarizes Claude session and weekly usage with configurable remaining tokens", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const nowMs = Date.parse("2026-04-12T12:00:00.000Z");
    queueMod.setSetting("claude_limit_tokens_session", "10000");
    queueMod.setSetting("claude_limit_tokens_week", "20000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => ({
      five_hour: { utilization: 20, resets_at: "2026-04-12T15:30:00.000Z" },
      seven_day: { utilization: 35, resets_at: "2026-04-17T12:00:00.000Z" },
      subscription_type: "max",
      rate_limit_tier: "default_claude_max_20x",
    });

    try {
      const summary = withClaudeConfigDir(claudeHome, () => getProviderUsage("claude", { nowMs }));
      assert.ok(summary);
      assert.equal(summary.source, "anthropic-oauth-usage-api");
      assert.equal(summary.subscriptionType, "max");
      assert.equal(summary.rateLimitTier, "default_claude_max_20x");

      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");

      assert.equal(session.usedTokens, 2000);
      assert.equal(session.limitTokens, 10000);
      assert.equal(session.remainingTokens, 8000);
      assert.equal(session.resetAt, "2026-04-12T15:30:00.000Z");

      assert.equal(week.usedTokens, 7000);
      assert.equal(week.limitTokens, 20000);
      assert.equal(week.remainingTokens, 13000);
      assert.equal(week.resetAt, "2026-04-17T12:00:00.000Z");
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("returns Claude usage windows even when no limits are configured", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const previousObservedSession = queueMod.getSetting("claude_observed_pct_session");
    const previousObservedWeek = queueMod.getSetting("claude_observed_pct_week");
    queueMod.setSetting("claude_limit_tokens_session", null);
    queueMod.setSetting("claude_limit_tokens_week", null);
    queueMod.setSetting("claude_observed_pct_session", null);
    queueMod.setSetting("claude_observed_pct_week", null);

    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-empty-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    writeAccountSettingsDb(settingsPath);
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => ({
      five_hour: { utilization: 10, resets_at: "2026-04-12T16:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-04-19T12:00:00.000Z" },
    });

    try {
      const summary = withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        () => getProviderUsage("claude", { nowMs: Date.parse("2026-04-12T12:00:00.000Z") }),
      ));
      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      assert.equal(session.usedTokens, null);
      assert.equal(session.limitTokens, null);
      assert.equal(session.remainingTokens, null);
      assert.equal(week.usedTokens, null);
      assert.equal(week.limitTokens, null);
      assert.equal(week.remainingTokens, null);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      queueMod.setSetting("claude_observed_pct_session", previousObservedSession);
      queueMod.setSetting("claude_observed_pct_week", previousObservedWeek);
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("prefers Claude OAuth account usage when local credentials include an access token", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-oauth-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    queueMod.setSetting("claude_limit_tokens_session", "10000");
    queueMod.setSetting("claude_limit_tokens_week", "20000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => ({
      five_hour: {
        utilization: 25,
        resets_at: "2026-04-12T15:00:00.000Z",
      },
      seven_day: {
        utilization: 60,
        resets_at: "2026-04-18T00:00:00.000Z",
      },
      seven_day_sonnet: {
        utilization: 10,
        resets_at: "2026-04-18T00:00:00.000Z",
      },
      extra_usage: {
        is_enabled: true,
        amount_used: 12.5,
        limit: 40,
      },
    });

    try {
      const summary = withClaudeConfigDir(claudeHome, () => getProviderUsage("claude", {
        nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
        forceRefresh: true,
      }));
      assert.equal(summary.source, "anthropic-oauth-usage-api");
      assert.equal(summary.subscriptionType, "max");
      assert.equal(summary.rateLimitTier, "default_claude_max_20x");

      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      const sonnet = summary.windows.find((window) => window.key === "week_sonnet");
      const extra = summary.windows.find((window) => window.key === "extra");

      assert.equal(session.utilizationPct, 25);
      assert.equal(session.usedTokens, 2500);
      assert.equal(session.remainingTokens, 7500);
      assert.equal(week.utilizationPct, 60);
      assert.equal(week.usedTokens, 12000);
      assert.equal(week.remainingTokens, 8000);
      assert.equal(sonnet.usageUnit, "percent");
      assert.equal(sonnet.limitTokens, null);
      assert.equal(extra.usageUnit, "currency");
      assert.equal(extra.usedAmount, 12.5);
      assert.equal(extra.limitAmount, 40);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("uses fresh cached Claude usage settings before calling the OAuth usage API again", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-settings-cache-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const nowMs = Date.parse("2026-04-13T21:10:00.000Z");
    writeAccountSettingsDb(settingsPath, {
      claude_session_tokens: "100",
      claude_session_max: "10000",
      claude_session_reset_at: "2026-04-14T02:00:00.000Z",
      claude_weekly_tokens: "500",
      claude_weekly_max: "20000",
      claude_weekly_reset_at: "2026-04-16T00:00:00.000Z",
      claude_usage_subscription_type: "max",
      claude_usage_rate_limit_tier: "default_claude_max_20x",
      claude_usage_source: "anthropic-oauth-usage-api",
      claude_usage_last_updated: String(nowMs),
    });

    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    let fetchCalls = 0;
    globalThis.__posseFetchClaudeOauthUsage = () => {
      fetchCalls += 1;
      return {
        five_hour: { utilization: 99, resets_at: "2099-01-01T00:00:00.000Z" },
        seven_day: { utilization: 99, resets_at: "2099-01-02T00:00:00.000Z" },
      };
    };

    try {
      const summary = withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        () => getProviderUsage("claude", { nowMs }),
      ));
      assert.equal(fetchCalls, 0);
      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      assert.equal(session.usedTokens, 100);
      assert.equal(session.limitTokens, 10000);
      assert.equal(week.usedTokens, 500);
      assert.equal(week.limitTokens, 20000);
      assert.equal(summary.cached, true);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      closeAccountSettingsDb();
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("respects Claude OAuth usage API backoff even when refresh is requested", async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-backoff-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const nowMs = Date.parse("2026-04-13T21:10:00.000Z");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsageAsync;
    let fetchCalls = 0;
    globalThis.__posseFetchClaudeOauthUsageAsync = async () => {
      fetchCalls += 1;
      throw new Error("Claude usage API returned 429: rate limit");
    };

    try {
      const first = await withClaudeConfigDir(
        claudeHome,
        async () => await getProviderUsageAsync("claude", { nowMs, forceRefresh: true }),
      );
      assert.equal(fetchCalls, 1);
      assert.equal(first.source, "anthropic-oauth-usage-api-rate-limited");

      globalThis.__posseFetchClaudeOauthUsageAsync = async () => {
        fetchCalls += 1;
        return {
          five_hour: { utilization: 20, resets_at: "2026-04-14T02:00:00.000Z" },
          seven_day: { utilization: 35, resets_at: "2026-04-16T00:00:00.000Z" },
        };
      };

      const cached = await withClaudeConfigDir(
        claudeHome,
        async () => await getProviderUsageAsync("claude", {
          nowMs: nowMs + 60_000,
          forceRefresh: true,
        }),
      );
      assert.equal(fetchCalls, 1);
      assert.equal(cached.source, "anthropic-oauth-usage-api-rate-limited");

      const forced = await withClaudeConfigDir(
        claudeHome,
        async () => await getProviderUsageAsync("claude", {
          nowMs: nowMs + 60_000,
          forceRefresh: true,
          ignoreBackoff: true,
        }),
      );
      assert.equal(fetchCalls, 2);
      assert.equal(forced.source, "anthropic-oauth-usage-api");
    } finally {
      globalThis.__posseFetchClaudeOauthUsageAsync = previousFetcher;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("ignores legacy Claude usage settings without an OAuth source marker", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-legacy-settings-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const nowMs = Date.parse("2026-04-13T21:10:00.000Z");
    writeAccountSettingsDb(settingsPath, {
      claude_session_tokens: "100",
      claude_session_max: "10000",
      claude_session_reset_at: "2026-04-14T02:00:00.000Z",
      claude_weekly_tokens: "500",
      claude_weekly_max: "20000",
      claude_weekly_reset_at: "2026-04-16T00:00:00.000Z",
      claude_usage_subscription_type: "max",
      claude_usage_rate_limit_tier: "default_claude_max_20x",
      claude_usage_last_updated: String(nowMs),
    });

    queueMod.setSetting("claude_limit_tokens_session", "10000");
    queueMod.setSetting("claude_limit_tokens_week", "20000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    let fetchCalls = 0;
    globalThis.__posseFetchClaudeOauthUsage = () => {
      fetchCalls += 1;
      return {
        five_hour: { utilization: 25, resets_at: "2026-04-14T02:00:00.000Z" },
        seven_day: { utilization: 60, resets_at: "2026-04-16T00:00:00.000Z" },
      };
    };

    try {
      const summary = withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        () => getProviderUsage("claude", { nowMs }),
      ));
      assert.equal(fetchCalls, 1);
      assert.equal(summary.source, "anthropic-oauth-usage-api");
      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      assert.equal(session.utilizationPct, 25);
      assert.equal(week.utilizationPct, 60);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("ignores deprecated Claude log usage settings when live OAuth usage is available", async () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-deprecated-settings-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const nowMs = Date.parse("2026-04-13T21:10:00.000Z");
    writeAccountSettingsDb(settingsPath, {
      claude_session_tokens: "100",
      claude_session_max: "10000",
      claude_session_reset_at: "2026-04-14T02:00:00.000Z",
      claude_weekly_tokens: "500",
      claude_weekly_max: "20000",
      claude_weekly_reset_at: "2026-04-16T00:00:00.000Z",
      claude_usage_subscription_type: "max",
      claude_usage_rate_limit_tier: "default_claude_max_20x",
      claude_usage_source: "claude-local-project-logs-deprecated",
      claude_usage_last_updated: String(nowMs),
    });

    queueMod.setSetting("claude_limit_tokens_session", "10000");
    queueMod.setSetting("claude_limit_tokens_week", "20000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsageAsync;
    let fetchCalls = 0;
    let seenTimeoutMs = null;
    globalThis.__posseFetchClaudeOauthUsageAsync = async ({ timeoutMs }) => {
      fetchCalls += 1;
      seenTimeoutMs = timeoutMs;
      return {
        five_hour: { utilization: 35, resets_at: "2026-04-14T02:00:00.000Z" },
        seven_day: { utilization: 55, resets_at: "2026-04-16T00:00:00.000Z" },
      };
    };

    try {
      const summary = await withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        async () => await getProviderUsageAsync("claude", { nowMs, timeoutMs: 1234 }),
      ));
      assert.equal(fetchCalls, 1);
      assert.equal(seenTimeoutMs, 1234);
      assert.equal(summary.source, "anthropic-oauth-usage-api");
      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      assert.equal(session.utilizationPct, 35);
      assert.equal(week.utilizationPct, 55);
    } finally {
      globalThis.__posseFetchClaudeOauthUsageAsync = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("does not use deprecated local Claude project logs by default when OAuth usage fetch fails", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-fallback-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    writeAccountSettingsDb(settingsPath);
    const projectDir = path.join(claudeHome, "projects", "demo-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "pro",
        rateLimitTier: "default",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    fs.writeFileSync(path.join(projectDir, "session.jsonl"), JSON.stringify({
      timestamp: "2026-04-12T11:00:00.000Z",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 0,
          output_tokens: 25,
        },
      },
    }), "utf8");

    queueMod.setSetting("claude_limit_tokens_session", "1000");
    queueMod.setSetting("claude_limit_tokens_week", "2000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => {
      throw new Error("network down");
    };

    try {
      const summary = withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        () => getProviderUsage("claude", {
          nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
          forceRefresh: true,
        }),
      ));
      assert.equal(summary.source, "anthropic-oauth-usage-api-unavailable");
      assert.deepEqual(summary.windows, []);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("does not use deprecated local Claude project logs even when legacy opt-in env is set", () => {
    const { queueMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-deprecated-optin-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    writeAccountSettingsDb(settingsPath);
    const projectDir = path.join(claudeHome, "projects", "demo-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "pro",
        rateLimitTier: "default",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    fs.writeFileSync(path.join(projectDir, "session.jsonl"), JSON.stringify({
      timestamp: "2026-04-12T11:00:00.000Z",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 0,
          output_tokens: 25,
        },
      },
    }), "utf8");

    queueMod.setSetting("claude_limit_tokens_session", "1000");
    queueMod.setSetting("claude_limit_tokens_week", "2000");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => {
      throw new Error("network down");
    };

    try {
      const summary = withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(
        claudeHome,
        () => getProviderUsage("claude", {
          nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
          forceRefresh: true,
        }),
      ));
      assert.equal(summary.source, "anthropic-oauth-usage-api-unavailable");
      assert.deepEqual(summary.windows, []);
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      if (previousSessionLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_session", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        const db = runtimeModules.dbMod.getDb();
        queueMod.setSetting("claude_limit_tokens_week", null);
      } else {
        queueMod.setSetting("claude_limit_tokens_week", previousWeekLimit);
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("ignores deprecated Claude local usage logs now that OAuth usage settings are canonical", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-deprecated-"));
    const projectDir = path.join(claudeHome, "projects", "demo-project", "subagents");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "agent.jsonl"), [
      JSON.stringify({
        timestamp: "2026-04-12T11:00:00.000Z",
        requestId: "req_nested_1",
        message: {
          id: "msg_nested_1",
          usage: {
            input_tokens: 250,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 25,
          },
        },
      }),
    ].join("\n"), "utf8");

    try {
      const summary = withClaudeConfigDir(claudeHome, () => getProviderUsage("claude", {
        nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
        forceRefresh: true,
      }));
      assert.equal(summary.provider, "claude");
      assert.equal(summary.source, "anthropic-oauth-usage-api-unconfigured");
      assert.deepEqual(summary.windows, []);
      assert.equal(withClaudeConfigDir(claudeHome, () => inferProviderWindowLimit("claude", "session", 25, {
        nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
        forceRefresh: true,
      })), null);
    } finally {
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("summarizes OpenAI session and weekly usage from agent calls", () => {
    const { queueMod, dbMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
    const db = dbMod.getDb();
    const nowMs = Date.parse("2026-04-12T12:00:00.000Z");

    queueMod.setSetting("openai_limit_tokens_session", null);


    queueMod.setSetting("openai_limit_tokens_week", null);
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 1200, 300, "2026-04-12T10:30:00.000Z", "2026-04-12T10:30:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 5000, 500, "2026-04-10T12:00:00.000Z", "2026-04-10T12:00:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 9000, 1000, "2026-04-01T12:00:00.000Z", "2026-04-01T12:00:00.000Z");

    queueMod.setSetting("openai_limit_tokens_session", "10000");
    queueMod.setSetting("openai_limit_tokens_week", "20000");

    try {
      const summary = getProviderUsage("openai", { nowMs });
      assert.ok(summary);
      assert.equal(summary.provider, "openai");
      assert.equal(summary.source, "posse-agent-calls");

      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");

      assert.equal(session.usedTokens, 1500);
      assert.equal(session.limitTokens, 10000);
      assert.equal(session.remainingTokens, 8500);
      assert.equal(session.resetAt, "2026-04-12T15:30:00.000Z");

      assert.equal(week.usedTokens, 7000);
      assert.equal(week.limitTokens, 20000);
      assert.equal(week.remainingTokens, 13000);
      assert.equal(week.resetAt, "2026-04-17T12:00:00.000Z");
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      if (previousSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
      }
    }
  });

  it("returns OpenAI usage windows even when no limits are configured", () => {
    const { queueMod, dbMod } = runtimeModules;
    const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
    const previousObservedSession = queueMod.getSetting("openai_observed_pct_session");
    const previousObservedWeek = queueMod.getSetting("openai_observed_pct_week");
    const db = dbMod.getDb();
    queueMod.setSetting("openai_limit_tokens_session", null);
    queueMod.setSetting("openai_limit_tokens_week", null);
    queueMod.setSetting("openai_observed_pct_session", null);
    queueMod.setSetting("openai_observed_pct_week", null);
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 100, 50, "2026-04-12T11:00:00.000Z", "2026-04-12T11:00:00.000Z");

    try {
      const summary = getProviderUsage("openai", { nowMs: Date.parse("2026-04-12T12:00:00.000Z") });
      const session = summary.windows.find((window) => window.key === "session");
      const week = summary.windows.find((window) => window.key === "week");
      assert.equal(session.usedTokens, 150);
      assert.equal(session.limitTokens, null);
      assert.equal(session.remainingTokens, null);
      assert.equal(week.usedTokens, 150);
      assert.equal(week.limitTokens, null);
      assert.equal(week.remainingTokens, null);
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
      queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
      queueMod.setSetting("openai_observed_pct_session", previousObservedSession);
      queueMod.setSetting("openai_observed_pct_week", previousObservedWeek);
    }
  });

  it("calculates OpenAI token limits from observed usage percentages on demand", () => {
    const { dbMod } = runtimeModules;
    const db = dbMod.getDb();
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 120, 30, "2026-04-12T11:00:00.000Z", "2026-04-12T11:00:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 300, 50, "2026-04-10T12:00:00.000Z", "2026-04-10T12:00:00.000Z");

    try {
      const session = inferProviderWindowLimit("openai", "session", 25, { nowMs: Date.parse("2026-04-12T12:00:00.000Z") });
      const week = inferProviderWindowLimit("openai", "week", 50, { nowMs: Date.parse("2026-04-12T12:00:00.000Z") });
      assert.equal(session.usedTokens, 150);
      assert.equal(session.limitTokens, 600);
      assert.equal(session.remainingTokens, 450);
      assert.equal(session.observedPct, 25);
      assert.equal(week.usedTokens, 500);
      assert.equal(week.limitTokens, 1000);
      assert.equal(week.remainingTokens, 500);
      assert.equal(week.observedPct, 50);
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    }
  });
});
