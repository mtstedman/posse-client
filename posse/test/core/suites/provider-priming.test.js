import {
  it,
  assert,
  fs,
  os,
  path,
  suite,
  withClaudeConfigDir,
  __testResetProviderUsageAuthPrime,
  getConfiguredProviderUsage,
  primeProviderUsageAuth,
  primeProviderUsageAuthAsync,
  warmOauthSession,
} from "../support/core-harness.js";

suite("Provider priming (OAuth warmup)", () => {
  it("warms Claude OAuth session at most once per boot via provider priming", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-warmup-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousWarmup = globalThis.__posseWarmClaudeOauthSession;
    let warmupCalls = 0;
    globalThis.__posseWarmClaudeOauthSession = () => {
      warmupCalls += 1;
      return { status: 0, stdout: "OK\n", stderr: "", error: null };
    };

    try {
      __testResetProviderUsageAuthPrime();
      const first = withClaudeConfigDir(claudeHome, () => primeProviderUsageAuth());
      const second = withClaudeConfigDir(claudeHome, () => primeProviderUsageAuth());
      assert.equal(first.attempted, true);
      assert.equal(first.ok, true);
      assert.equal(second.attempted, false);
      assert.equal(second.skipped, "already-primed");
      assert.equal(warmupCalls, 1);
    } finally {
      globalThis.__posseWarmClaudeOauthSession = previousWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
      __testResetProviderUsageAuthPrime();
    }
  });

  it("uses the async Claude OAuth warmup path when provider priming is async", async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-async-warmup-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousSyncWarmup = globalThis.__posseWarmClaudeOauthSession;
    const previousAsyncWarmup = globalThis.__posseWarmClaudeOauthSessionAsync;
    let asyncCalls = 0;
    globalThis.__posseWarmClaudeOauthSession = () => {
      throw new Error("async priming should not use spawnSync warmup");
    };
    globalThis.__posseWarmClaudeOauthSessionAsync = async () => {
      asyncCalls += 1;
      return { status: 0, stdout: "OK\n", stderr: "", error: null };
    };

    try {
      __testResetProviderUsageAuthPrime();
      const result = await withClaudeConfigDir(claudeHome, () => primeProviderUsageAuthAsync({ force: true }));
      assert.equal(result.attempted, true);
      assert.equal(result.ok, true);
      assert.equal(asyncCalls, 1);
    } finally {
      globalThis.__posseWarmClaudeOauthSession = previousSyncWarmup;
      globalThis.__posseWarmClaudeOauthSessionAsync = previousAsyncWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
      __testResetProviderUsageAuthPrime();
    }
  });

  it("retries provider auth priming after an attempted warmup failure", async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-retry-after-fail-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousAsyncWarmup = globalThis.__posseWarmClaudeOauthSessionAsync;
    let asyncCalls = 0;
    globalThis.__posseWarmClaudeOauthSessionAsync = async () => {
      asyncCalls += 1;
      if (asyncCalls === 1) {
        return {
          status: null,
          signal: "SIGTERM",
          error: new Error("Claude OAuth warmup timed out"),
          stdout: "",
          stderr: "",
        };
      }
      return { status: 0, stdout: "OK\n", stderr: "", error: null };
    };

    try {
      __testResetProviderUsageAuthPrime();
      const first = await withClaudeConfigDir(claudeHome, () => primeProviderUsageAuthAsync({ force: true }));
      const second = await withClaudeConfigDir(claudeHome, () => primeProviderUsageAuthAsync());
      const third = await withClaudeConfigDir(claudeHome, () => primeProviderUsageAuthAsync());

      assert.equal(first.attempted, true);
      assert.equal(first.ok, false);
      assert.equal(first.providers[0].ok, false);
      assert.equal(second.attempted, true);
      assert.equal(second.ok, true);
      assert.equal(third.attempted, false);
      assert.equal(third.skipped, "already-primed");
      assert.equal(asyncCalls, 2);
    } finally {
      globalThis.__posseWarmClaudeOauthSessionAsync = previousAsyncWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
      __testResetProviderUsageAuthPrime();
    }
  });

  it("does not warm Claude OAuth while rendering configured usage by default", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-usage-no-warmup-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousWarmup = globalThis.__posseWarmClaudeOauthSession;
    let warmupCalls = 0;
    let seenTimeoutMs = null;
    globalThis.__posseWarmClaudeOauthSession = ({ resolvedTimeoutMs }) => {
      warmupCalls += 1;
      seenTimeoutMs = resolvedTimeoutMs;
      return { status: 0, stdout: "OK\n", stderr: "", error: null };
    };

    try {
      __testResetProviderUsageAuthPrime();
      const summaries = withClaudeConfigDir(claudeHome, () => getConfiguredProviderUsage());
      assert.ok(Array.isArray(summaries));
      assert.equal(warmupCalls, 0);

      withClaudeConfigDir(claudeHome, () => getConfiguredProviderUsage({
        primeAuth: true,
        primeAuthTimeoutMs: 1000,
      }));
      assert.equal(warmupCalls, 1);
      assert.equal(seenTimeoutMs, 1000);
    } finally {
      globalThis.__posseWarmClaudeOauthSession = previousWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
      __testResetProviderUsageAuthPrime();
    }
  });

  it("skips Claude OAuth warmup when no OAuth token is configured", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-warmup-skip-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({}), "utf8");
    try {
      const result = withClaudeConfigDir(claudeHome, () => warmOauthSession());
      assert.equal(result.attempted, false);
      assert.equal(result.skipped, "oauth-unconfigured");
    } finally {
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("labels Claude OAuth warmup invalid_client failures", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-warmup-invalid-client-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousWarmup = globalThis.__posseWarmClaudeOauthSession;
    globalThis.__posseWarmClaudeOauthSession = () => ({
      status: 1,
      stdout: "",
      stderr: "Failed to initialize Claude agent\nOAuth error: invalid_client",
      error: null,
    });

    try {
      const result = withClaudeConfigDir(claudeHome, () => warmOauthSession());
      assert.equal(result.attempted, true);
      assert.equal(result.ok, false);
      assert.equal(result.classification, "invalid_client");
      assert.equal(result.retryable, false);
      assert.match(result.detail, /invalid_client/);

      __testResetProviderUsageAuthPrime();
      const primed = withClaudeConfigDir(claudeHome, () => primeProviderUsageAuth({ force: true }));
      assert.equal(primed.ok, false);
      assert.equal(primed.providers[0].provider, "claude");
      assert.equal(primed.providers[0].classification, "invalid_client");
    } finally {
      globalThis.__posseWarmClaudeOauthSession = previousWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
      __testResetProviderUsageAuthPrime();
    }
  });

  it("labels Claude OAuth warmup local contention as retryable", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-oauth-warmup-contention-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");

    const previousWarmup = globalThis.__posseWarmClaudeOauthSession;
    globalThis.__posseWarmClaudeOauthSession = () => ({
      status: 1,
      stdout: "",
      stderr: "Another Claude process is already running; local session lock is busy",
      error: null,
    });

    try {
      const result = withClaudeConfigDir(claudeHome, () => warmOauthSession());
      assert.equal(result.attempted, true);
      assert.equal(result.ok, false);
      assert.equal(result.classification, "local_contention");
      assert.equal(result.retryable, true);
      assert.match(result.detail, /already running|lock is busy/i);
    } finally {
      globalThis.__posseWarmClaudeOauthSession = previousWarmup;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
