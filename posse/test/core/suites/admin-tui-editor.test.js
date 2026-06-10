import {
  it,
  beforeEach,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  runtimeDbPath,
  runtimeAccountSettingsPath,
  now,
  createJob,
  resetRuntimeDb,
  withEnv,
  closeAccountSettingsDb,
  setRuntimePathOverridesForTests,
  AdminTUI,
  canUseAdminTui,
  purgeRuntimeLogs,
} from "../support/core-harness.js";

let db;

suite("Admin image model cycling", () => {
  beforeEach(() => {
    resetRuntimeDb();
    closeAccountSettingsDb();
    const accountDb = runtimeAccountSettingsPath;
    if (accountDb) {
      for (const file of [
        accountDb,
        accountDb.replace(/\.db$/i, ".json"),
        `${accountDb}-shm`,
        `${accountDb}-wal`,
        `${accountDb}-journal`,
      ]) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  it("ignores legacy JSON files and keeps account DB settings authoritative", () => {
    const { queueMod } = runtimeModules;
    const legacyJson = runtimeAccountSettingsPath.replace(/\.db$/i, ".json");

    queueMod.setSetting("atlas_mode", "required");
    queueMod.setSetting("atlas_phases", "dev");
    queueMod.setSetting("codex_auth_mode", "oauth");
    closeAccountSettingsDb();

    fs.writeFileSync(legacyJson, JSON.stringify({
      atlas_mode: "off",
      atlas_phases: "research,planning",
      codex_auth_mode: "api",
    }, null, 2) + "\n", "utf-8");
    closeAccountSettingsDb();

    assert.equal(queueMod.getSetting("atlas_mode"), "required");
    assert.equal(queueMod.getSetting("atlas_phases"), "dev");
    assert.equal(queueMod.getSetting("codex_auth_mode"), "oauth");
    assert.equal(fs.existsSync(legacyJson), true);
  });

  it("detects when interactive admin mode is unavailable", () => {
    assert.equal(canUseAdminTui({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }), false);

    assert.equal(canUseAdminTui({
      stdin: { isTTY: true, setRawMode() {} },
      stdout: { isTTY: false },
    }), false);

    assert.equal(canUseAdminTui({
      stdin: { isTTY: true, setRawMode() {} },
      stdout: { isTTY: true },
    }), true);
  });

  it("renders a non-interactive admin snapshot", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const output = tui.renderSnapshot({ reason: "test fallback" });

    assert.match(output, /POSSE ADMIN \(non-interactive snapshot\)/);
    assert.match(output, /Reason: test fallback/);
    assert.match(output, /Overview/);
    assert.match(output, /Settings/);
    assert.match(output, /Tip: run `node orchestrator\.js admin`/);
  });


  it("purges disk logs and resets ATLAS report telemetry", () => {
    const { dbMod, queueMod } = runtimeModules;
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-runtime-"));
    const logDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const wi = queueMod.createWorkItem("ATLAS telemetry purge", "desc");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Use ATLAS" });
    const db = dbMod.getDb();
    const callId = db.prepare(
      "INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, provider, status, atlas_method, atlas_prefetch_status, started_at, created_at) VALUES (?, ?, 'researcher', 'standard', 'openai', 'succeeded', 'ab_atlas', 'ok', ?, ?)"
    ).run(wi.id, job.id, "2026-04-26T10:00:00.000Z", "2026-04-26T10:00:00.000Z").lastInsertRowid;
    db.prepare(
      "INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, provider, status, started_at, created_at) VALUES (?, ?, 'planner', 'standard', 'openai', 'succeeded', ?, ?)"
    ).run(wi.id, job.id, "2026-04-26T10:01:00.000Z", "2026-04-26T10:01:00.000Z");
    db.prepare("INSERT INTO job_observations (work_item_id, job_id, observation_type, summary) VALUES (?, ?, 'tool.atlas.prefetch', 'ATLAS slice.build')").run(wi.id, job.id);
    db.prepare("INSERT INTO job_observations (work_item_id, job_id, observation_type, summary) VALUES (?, ?, 'tool.read_file', 'Read file')").run(wi.id, job.id);
    db.prepare("INSERT INTO events (work_item_id, job_id, event_type, actor_type, message) VALUES (?, ?, 'work_item.test', 'system', 'history row')").run(wi.id, job.id);
    db.prepare("UPDATE work_items SET status = 'complete' WHERE id = ?").run(wi.id);
    fs.writeFileSync(path.join(logDir, "prompts-2026-04-26.log"), "{}\n", "utf8");
    fs.writeFileSync(path.join(logDir, "outputs-2026-04-26.log"), "{}\n", "utf8");

    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath, runtimeRoot, logDir });
    try {
      const result = purgeRuntimeLogs({ projectDir: path.resolve(__dirname, "..") });
      assert.equal(result.files, 2);
      assert.equal(result.atlasAgentCalls, 1);
      assert.equal(result.atlasObservations, 1);
      assert.equal(result.historyWorkItems, 1);
      assert.equal(result.dbAgentCalls, 2);
      assert.equal(result.dbObservations, 2);
      assert.equal(result.dbEvents, 2);
    } finally {
      setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
    }

    assert.deepEqual(fs.readdirSync(logDir), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE id = ?").get(wi.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_calls WHERE id = ?").get(callId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE observation_type LIKE 'tool.atlas%'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE observation_type = 'tool.read_file'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE work_item_id = ?").get(wi.id).count, 0);
    const workItemLines = new AdminTUI({ projectDir: path.resolve(__dirname, "..") })
      ._buildWorkItemsTab(120)
      .map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(workItemLines.some((line) => line.includes("No work items yet.")));
    const reportLines = new AdminTUI({ projectDir: path.resolve(__dirname, "..") })
      ._buildAtlasReport(120)
      .map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(reportLines.some((line) => line.includes("No ATLAS telemetry has been recorded yet.")));
    assert.equal(reportLines.some((line) => line.includes("baseline")), false);
    assert.equal(reportLines.some((line) => line.includes("ATLAS telemetry purge")), false);

    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("refuses to purge log directories outside the runtime root", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-runtime-"));
    const outsideLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-admin-outside-logs-"));
    const sentinel = path.join(outsideLogDir, "sentinel.log");
    fs.writeFileSync(sentinel, "keep", "utf8");

    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath, runtimeRoot, logDir: outsideLogDir });
    try {
      assert.throws(
        () => purgeRuntimeLogs({ projectDir: path.resolve(__dirname, "..") }),
        /outside runtime root/
      );
      assert.equal(fs.existsSync(sentinel), true);
    } finally {
      setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(outsideLogDir, { recursive: true, force: true });
    }
  });

  it("renders provider usage bars with used versus available tokens", () => {
    withEnv({ OPENAI_API_KEY: "test-key" }, () => {
      const { queueMod, dbMod } = runtimeModules;
      const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
      const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
      const previousObservedSession = queueMod.getSetting("openai_observed_pct_session");
      const previousObservedWeek = queueMod.getSetting("openai_observed_pct_week");
      const previousClaudeSessionTokens = queueMod.getSetting("claude_session_tokens");
      const previousClaudeSessionMax = queueMod.getSetting("claude_session_max");
      const previousClaudeSessionReset = queueMod.getSetting("claude_session_reset_at");
      const previousClaudeWeeklyTokens = queueMod.getSetting("claude_weekly_tokens");
      const previousClaudeWeeklyMax = queueMod.getSetting("claude_weekly_max");
      const previousClaudeWeeklyReset = queueMod.getSetting("claude_weekly_reset_at");
      const previousClaudeSubscription = queueMod.getSetting("claude_usage_subscription_type");
      const previousClaudeRateLimitTier = queueMod.getSetting("claude_usage_rate_limit_tier");
      const previousClaudeUsageSource = queueMod.getSetting("claude_usage_source");
      const previousClaudeUsageUpdated = queueMod.getSetting("claude_usage_last_updated");
      const db = dbMod.getDb();
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      queueMod.setSetting("openai_limit_tokens_session", "10000");
      queueMod.setSetting("openai_limit_tokens_week", "20000");
      queueMod.setSetting("openai_observed_pct_session", null);
      queueMod.setSetting("openai_observed_pct_week", null);
      const nowMs = Date.now();
      queueMod.setSetting("claude_session_tokens", "150000");
      queueMod.setSetting("claude_session_max", "250000");
      queueMod.setSetting("claude_session_reset_at", new Date(nowMs + (5 * 60 * 60 * 1000)).toISOString());
      queueMod.setSetting("claude_weekly_tokens", "300000");
      queueMod.setSetting("claude_weekly_max", "1000000");
      queueMod.setSetting("claude_weekly_reset_at", new Date(nowMs + (7 * 24 * 60 * 60 * 1000)).toISOString());
      queueMod.setSetting("claude_usage_subscription_type", "max");
      queueMod.setSetting("claude_usage_rate_limit_tier", "default_claude_max_20x");
      queueMod.setSetting("claude_usage_source", "anthropic-oauth-usage-api");
      queueMod.setSetting("claude_usage_last_updated", String(nowMs));
      db.prepare(`
        INSERT INTO agent_calls (
          role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("dev", "standard", "openai", "succeeded", 1200, 300, "2026-04-12T10:30:00.000Z", "2026-04-12T10:30:00.000Z");

      try {
        const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
        const output = tui.renderSnapshot({ reason: "provider bars" });
        const plainOutput = output.replace(/\x1b\[[0-9;]*m/g, "");

        assert.match(plainOutput, /Provider usage/);
        assert.match(plainOutput, /- Tokens: 1\.5K \(1\.2K in \+ 300 out\)/i);
        assert.match(plainOutput, /- claude \(max \/ default_claude_max_20x\)/i);
        assert.match(plainOutput, /Session \(5h\):/i);
        assert.match(plainOutput, /Week \(7d\):/i);
        assert.match(plainOutput, /remaining/i);
      } finally {
        db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
        queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
        queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
        queueMod.setSetting("openai_observed_pct_session", previousObservedSession);
        queueMod.setSetting("openai_observed_pct_week", previousObservedWeek);
        queueMod.setSetting("claude_session_tokens", previousClaudeSessionTokens);
        queueMod.setSetting("claude_session_max", previousClaudeSessionMax);
        queueMod.setSetting("claude_session_reset_at", previousClaudeSessionReset);
        queueMod.setSetting("claude_weekly_tokens", previousClaudeWeeklyTokens);
        queueMod.setSetting("claude_weekly_max", previousClaudeWeeklyMax);
        queueMod.setSetting("claude_weekly_reset_at", previousClaudeWeeklyReset);
        queueMod.setSetting("claude_usage_subscription_type", previousClaudeSubscription);
        queueMod.setSetting("claude_usage_rate_limit_tier", previousClaudeRateLimitTier);
        queueMod.setSetting("claude_usage_source", previousClaudeUsageSource);
        queueMod.setSetting("claude_usage_last_updated", previousClaudeUsageUpdated);
      }
    });
  });

  it("accepts raw-data fallback input for tab navigation", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    tui._dispatchInput("", { name: "tab", sequence: "\t" });
    tui._dispatchInput("3", { name: "3", sequence: "3" });

    assert.equal(tui._tab, 2);
  });

  it("supports q as a direct quit hotkey", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    let exited = false;
    tui._exit = () => { exited = true; };
    tui._render = () => {};

    tui._onKeypress("q", { name: "q", sequence: "q" });

    assert.equal(exited, true);
  });

  it("handles Ctrl+C through TUI cleanup without exiting the process", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    let exited = false;
    let exitCalled = false;
    const originalExit = process.exit;
    process.exit = ((code) => {
      exitCalled = true;
      throw new Error(`unexpected process.exit(${code})`);
    });
    try {
      tui._exit = () => { exited = true; };
      tui._render = () => {};

      tui._onKeypress("", { ctrl: true, name: "c", sequence: "\u0003" });
    } finally {
      process.exit = originalExit;
    }

    assert.equal(exited, true);
    assert.equal(exitCalled, false);
  });

  it("runs TUI cleanup from the process-exit safety handler", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    let cleanupCalls = 0;
    tui._done = () => {};
    tui._exitOnce = () => { cleanupCalls++; };

    tui._onProcessExit();

    assert.equal(cleanupCalls, 1);
  });

  it("cancels a pending render timer during TUI cleanup", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const timer = { id: "render" };
    let cleared = null;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalWrite = process.stdout.write;
    global.setTimeout = () => timer;
    global.clearTimeout = (handle) => { cleared = handle; };
    process.stdout.write = () => true;
    try {
      tui._done = () => {};
      tui._keypressHandler = () => {};
      tui._stdinDataHandler = () => {};
      tui._resizeHandler = () => {};

      tui.requestRender({ force: true });
      assert.equal(tui._renderTimer, timer);

      tui._exit();
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      process.stdout.write = originalWrite;
    }

    assert.equal(cleared, timer);
    assert.equal(tui._renderTimer, null);
    assert.equal(tui._renderScheduled, false);
  });

  it("only exposes provider model settings when that provider is selectable", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      const entries = tui._getModelSettingEntries();
      assert.ok(entries.some((entry) => entry.setting_key === "openai_model_standard"));
      assert.equal(entries.some((entry) => entry.setting_key === "grok_model_standard"), false);
    });
  });

  it("exposes provider-role settings for multi-provider selection", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      const entries = tui._getEditableSettings();
      const providerDev = entries.find((entry) => entry.setting_key === "provider_dev");
      const providerArtificer = entries.find((entry) => entry.setting_key === "provider_artificer");
      const delegationMode = entries.find((entry) => entry.setting_key === "delegation_mode");
      assert.ok(providerDev);
      assert.ok(providerArtificer);
      assert.ok(delegationMode);
      assert.match(providerDev.description || "", /Comma-separated providers/i);
      assert.match(delegationMode.description || "", /Delegation engine mode/i);
    });
  });

  it("normalizes provider selections to selectable providers only", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      assert.equal(tui._normalizeProviderList("grok, openai, openai, invalid"), "openai");
      assert.equal(tui._normalizeProviderList(""), "claude");
    });
  });

  it("does not duplicate provider settings between db rows and provider controls", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    runtimeModules.queueMod.setSetting("provider_artificer", "claude,codex");

    const entries = tui._getEditableSettings().filter((entry) => entry.setting_key === "provider_artificer");

    assert.equal(entries.length, 1);
    assert.equal(entries[0].setting_value, "claude,codex");

    runtimeModules.queueMod.setSetting("provider_artificer", "claude");
  });

  it("renders full comma-separated provider values in the provider controls", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 120;
    runtimeModules.queueMod.setSetting("provider_artificer", "claude,codex");

    const lines = tui._buildSettings(118);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const providerLine = lines.find((line) => plain(line).includes("provider_artificer"));

    assert.ok(providerLine);
    assert.match(plain(providerLine), /claude,codex/);

    runtimeModules.queueMod.setSetting("provider_artificer", "claude");
  });

  it("does not emit mojibake separator glyphs in settings tables", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 120;

    const lines = tui._buildSettings(118);
    const plain = lines.map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ""));

    assert.equal(plain.some((line) => line.includes("─")), false);
  });

  it("shows scheduler_concurrency as an editable admin setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 130;

    runtimeModules.queueMod.setSetting("scheduler_concurrency", "5");
    const lines = tui._buildSettings(128);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const concurrencyLine = lines.find((line) => plain(line).includes("scheduler_concurrency"));

    assert.ok(concurrencyLine);
    assert.match(plain(concurrencyLine), /scheduler_concurrency\s+5/);
    assert.ok(lines.some((line) => plain(line).includes("Default number of worker slots")));

    runtimeModules.queueMod.setSetting("scheduler_concurrency", "3");
  });

  it("shows assessor_fallback_reads as an editable admin setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 130;

    runtimeModules.queueMod.setSetting("assessor_fallback_reads", "5");
    const lines = tui._buildSettings(128);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const budgetLine = lines.find((line) => plain(line).includes("assessor_fallback_reads"));

    assert.ok(budgetLine);
    assert.match(plain(budgetLine), /assessor_fallback_reads\s+5/);
    assert.ok(lines.some((line) => plain(line).includes("Extra assessor fallback file reads")));

    runtimeModules.queueMod.setSetting("assessor_fallback_reads", "0");
  });

  it("keeps everyday settings separate from debug tuning rows in interactive settings", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 150;
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");

    tui._settingsPane = "core";
    const coreLines = tui._buildSettings(148).map(plain);
    assert.ok(coreLines.some((line) => line.includes("[Core]")));
    assert.ok(coreLines.some((line) => line.includes("auto_merge_completed")));
    assert.ok(coreLines.some((line) => line.includes("scheduler_concurrency")));
    assert.equal(coreLines.some((line) => line.includes("assessor_fallback_reads")), false);
    assert.equal(coreLines.some((line) => line.includes("scheduler_poll_ms")), false);

    tui._settingsPane = "tuning";
    tui._settingsIndex = 0;
    const tuningLines = tui._buildSettings(148).map(plain);
    assert.ok(tuningLines.some((line) => line.includes("[Debug / Tuning]")));
    assert.ok(tuningLines.some((line) => line.includes("assessor_fallback_reads")));
    assert.ok(tuningLines.some((line) => line.includes("scheduler_poll_ms")));
    assert.equal(tuningLines.some((line) => line.includes("auto_merge_completed")), false);
  });

  it("shows codex_auth_mode as an editable admin setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    // Width >=200 ensures the uniform-width row layout doesn't truncate
    // long catalog descriptions like codex_auth_mode (~100 chars).
    tui.cols = 200;

    runtimeModules.queueMod.setSetting("codex_auth_mode", "oauth");
    const lines = tui._buildSettings(198);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const modeLine = lines.find((line) => plain(line).includes("codex_auth_mode"));

    assert.ok(modeLine);
    assert.match(plain(modeLine), /codex_auth_mode\s+oauth/);
    assert.ok(lines.some((line) => plain(line).includes("oauth/auto never fall back to API keys")));

    runtimeModules.queueMod.setSetting("codex_auth_mode", "oauth");
  });

  it("hides internal and unknown settings from editable admin rows", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 160;

    runtimeModules.queueMod.setSetting("codex_cli_path", "C:/Users/mason/AppData/Local/Codex/codex.exe");
    runtimeModules.queueMod.setSetting("atlas_shared_runtime_port", "3939");
    runtimeModules.queueMod.setSetting("codex_location", "C:/Users/mason/AppData/Local/Codex");
    const lines = tui._buildSettings(158);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");

    assert.equal(lines.some((line) => plain(line).includes("codex_cli_path")), false);
    assert.equal(lines.some((line) => plain(line).includes("atlas_shared_runtime_port")), false);
    assert.equal(lines.some((line) => plain(line).includes("codex_location")), false);

    runtimeModules.queueMod.setSetting("codex_cli_path", "");
    runtimeModules.queueMod.setSetting("atlas_shared_runtime_port", "");
    runtimeModules.queueMod.setSetting("codex_location", "");
  });

  it("shows atlas_v2 as the editable ATLAS mode setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    // Width >=180 keeps the uniform-width row format from truncating the
    // ATLAS descriptions.
    tui.cols = 200;

    runtimeModules.queueMod.setSetting("atlas_mode", "preferred");
    runtimeModules.queueMod.setSetting("atlas_v2", "v2");
    runtimeModules.queueMod.setSetting("atlas_scip_mode", "on");
    runtimeModules.queueMod.setSetting("atlas_scip_languages", "typescript,python");
    const lines = tui._buildSettings(198);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const atlasLine = lines.find((line) => plain(line).includes("atlas_mode"));
    const atlasV2Line = lines.find((line) => plain(line).includes("atlas_v2"));
    const atlasScipLine = lines.find((line) => plain(line).includes("atlas_scip_mode"));
    const atlasScipLanguagesLine = lines.find((line) => plain(line).includes("atlas_scip_languages"));

    assert.equal(atlasLine, undefined);
    assert.ok(atlasV2Line);
    assert.ok(atlasScipLine);
    assert.ok(atlasScipLanguagesLine);
    assert.match(plain(atlasV2Line), /atlas_v2\s+v2/);
    assert.match(plain(atlasScipLine), /atlas_scip_mode\s+on/);
    assert.match(plain(atlasScipLanguagesLine), /atlas_scip_languages\s+typescript,python/);
    assert.equal(lines.some((line) => plain(line).includes("ATLAS integration mode for compatible providers")), false);
    assert.equal(lines.some((line) => plain(line).includes("(off, shadow, preferred, required, split)")), false);
    assert.ok(lines.some((line) => plain(line).includes("ATLAS v2 backend mode")));

    runtimeModules.queueMod.setSetting("atlas_mode", "off");
    runtimeModules.queueMod.setSetting("atlas_v2", "on");
    runtimeModules.queueMod.setSetting("atlas_scip_mode", "on");
    runtimeModules.queueMod.setSetting("atlas_scip_languages", "typescript,python,php,go,rust");
  });

  it("shows research_fanout as an editable admin setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    // Width >=180 keeps the uniform-width row format from truncating the
    // research_fanout description.
    tui.cols = 200;

    runtimeModules.queueMod.setSetting("research_fanout", "shadow");
    const lines = tui._buildSettings(198);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const fanoutLine = lines.find((line) => plain(line).includes("research_fanout"));

    assert.ok(fanoutLine);
    assert.match(plain(fanoutLine), /research_fanout\s+shadow/);
    assert.ok(lines.some((line) => plain(line).includes("Research fanout mode for preflight fanout-clear decisions")));
    assert.ok(lines.some((line) => plain(line).includes("(off, shadow, on)")));

    runtimeModules.queueMod.setSetting("research_fanout", "off");
  });

  it("hides internal Claude usage tracker keys from the admin settings tab", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 140;

    runtimeModules.queueMod.setSetting("claude_usage_last_updated", String(Date.now()));
    runtimeModules.queueMod.setSetting("claude_usage_source", "anthropic-oauth-usage-api");
    const lines = tui._buildSettings(138);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");

    assert.equal(lines.some((line) => plain(line).includes("claude_usage_last_updated")), false);
    assert.equal(lines.some((line) => plain(line).includes("claude_usage_source")), false);
    assert.equal(lines.some((line) => plain(line).includes("Provider Usage Limits")), false);
  });

  it("renders ATLAS report summaries grouped by method, provider, and work item", () => {
    const { dbMod } = runtimeModules;
    const db = dbMod.getDb();

    const wi = runtimeModules.queueMod.createWorkItem("ATLAS report test", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "ATLAS run",
    });
    const attemptOne = db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_number, worker_type, status)
      VALUES (?, 1, 'researcher', 'succeeded')
    `).run(job.id).lastInsertRowid;
    const attemptTwo = db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_number, worker_type, status)
      VALUES (?, 2, 'researcher', 'succeeded')
    `).run(job.id).lastInsertRowid;
    const attemptOverlap = db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_number, worker_type, status)
      VALUES (?, 3, 'researcher', 'succeeded')
    `).run(job.id).lastInsertRowid;
    db.prepare(`UPDATE jobs SET assessor_verdict = 'pass' WHERE id = ?`).run(job.id);

    db.prepare(`
      INSERT INTO agent_calls (
        work_item_id, job_id, attempt_id, role, model_tier, provider, status,
        input_tokens, output_tokens, duration_ms, atlas_method, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wi.id, job.id, attemptOne, "researcher", "standard", "openai", "succeeded", 100, 20, 1200, "ab_atlas", "2026-04-10T10:00:00.000Z", "2026-04-10T10:00:02.000Z", "2026-04-10T10:00:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (
        work_item_id, job_id, attempt_id, role, model_tier, provider, status,
        input_tokens, output_tokens, duration_ms, atlas_method, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wi.id, job.id, attemptTwo, "researcher", "standard", "openai", "succeeded", 60, 10, 900, "ab_control", "2026-04-10T10:05:00.000Z", "2026-04-10T10:05:02.000Z", "2026-04-10T10:05:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (
        work_item_id, job_id, attempt_id, role, model_tier, provider, status,
        input_tokens, output_tokens, duration_ms, atlas_method, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wi.id, job.id, attemptOverlap, "researcher", "standard", "openai", "succeeded", 20, 5, 800, "overlap_noise", "2026-04-10T10:00:00.000Z", "2026-04-10T10:00:03.000Z", "2026-04-10T10:00:00.000Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas', 'ATLAS context ok', ?, ?)
    `).run(wi.id, job.id, attemptOne, JSON.stringify({
      kind: "atlas",
      token_usage: { atlas_tokens: 75, raw_equivalent: 300, saved_tokens: 225 },
    }), "2026-04-10T10:00:01.000Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas', 'ATLAS context overhead', ?, ?)
    `).run(wi.id, job.id, attemptTwo, JSON.stringify({
      kind: "atlas",
      token_usage: { atlas_tokens: 140, raw_equivalent: 100, saved_tokens: -40 },
    }), "2026-04-10T10:05:01.000Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas.prefetch', 'ATLAS malformed token usage', ?, ?)
    `).run(wi.id, job.id, attemptOne, JSON.stringify({
      kind: "atlas",
      token_usage: { atlas_tokens: 648, raw_equivalent: 0, saved_tokens: -648 },
    }), "2026-04-10T10:00:01.250Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas', 'ATLAS symbol.search cancelled', ?, ?)
    `).run(wi.id, job.id, attemptOne, JSON.stringify({
      kind: "atlas",
      origin: "agent",
      action: "symbol.search",
      status: "cancelled",
      ok: false,
      error: "user cancelled MCP tool call",
      duration_ms: 50,
    }), "2026-04-10T10:00:01.500Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas.prefetch', 'ATLAS slice.build empty', ?, ?)
    `).run(wi.id, job.id, attemptOne, JSON.stringify({
      kind: "atlas",
      origin: "prefetch",
      action: "slice.build",
      ok: true,
      empty: true,
      duration_ms: 25,
      result_chars: 0,
    }), "2026-04-10T10:00:01.750Z");
    db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, ?, 'tool.atlas.prefetch', 'ATLAS prefetch fallback', ?, ?)
    `).run(wi.id, job.id, attemptOne, JSON.stringify({
      kind: "atlas",
      origin: "prefetch",
      ok: false,
      fallback: "deterministic_tools",
      failure_classification: "ATLAS unavailable",
      error: "spawn ENOENT",
    }), "2026-04-10T10:00:01.875Z");

    try {
      const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
      const report = tui._queryAtlasReportRows();
      const measuredSavingsCalls = report.tokenSavings.reduce((sum, row) => sum + (row.measured_calls || 0), 0);
      assert.equal(measuredSavingsCalls, 2);
      assert.equal(report.tokenSavings.some((row) => row.atlas_method === "overlap_noise"), false);

      const lines = tui._buildAtlasReport(138);
      const plain = lines.map((line) => String(line).replace(/\x1b\[[0-9;]*m/g, ""));

      assert.ok(plain.some((line) => line.includes("ATLAS A/B REPORT")));
      assert.ok(plain.some((line) => line.includes("Method Summary")));
      assert.ok(plain.some((line) => line.includes("ab_atlas")));
      assert.ok(plain.some((line) => line.includes("ab_control")));
      assert.ok(plain.some((line) => line.includes("Tool Token Savings")));
      assert.ok(plain.some((line) => line.includes("ab_atlas") && line.includes("+225") && line.includes("75%")));
      assert.ok(plain.some((line) => line.includes("ab_control") && line.includes("-40") && line.includes("-40%")));
      assert.ok(plain.some((line) => line.includes("ATLAS Tool Reliability")));
      assert.ok(plain.some((line) => line.includes("symbol.search") && line.includes("agent") && line.includes("100%") && line.includes("1")));
      assert.ok(plain.some((line) => line.includes("slice.build") && line.includes("prefetch") && line.includes("1")));
      assert.ok(plain.some((line) => line.includes("prefetch.fallback") && line.includes("prefetch") && line.includes("1")));
      assert.ok(plain.some((line) => line.includes("Assessor Outcome Signals")));
      assert.ok(plain.some((line) => line.includes("ab_atlas") && line.includes("1/1 100%")));
      assert.ok(plain.some((line) => line.includes("Provider Breakdown")));
      assert.ok(plain.some((line) => line.includes("openai")));
      assert.ok(plain.some((line) => line.includes("Work Item Breakdown")));
      assert.ok(plain.some((line) => line.includes(`WI#${wi.id}`)));
      assert.ok(plain.some((line) => line.includes("ATLAS report test")));
    } finally {
      db.prepare(`DELETE FROM work_items WHERE id = ?`).run(wi.id);
    }
  });

  it("uses fixed embedded ATLAS lock backoff bounds rather than env knobs", () => {
    const embeddedSource = fs.readFileSync(path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "atlas-embedded.js"), "utf8");
    assert.doesNotMatch(embeddedSource, /process\.env\.POSSE_ATLAS_LOCK_BACKOFF_BASE_MS/);
    assert.doesNotMatch(embeddedSource, /process\.env\.POSSE_ATLAS_LOCK_BACKOFF_MAX_MS/);
    assert.match(embeddedSource, /__testGetAtlasLockBackoff/);
  });

  it("hides advanced ATLAS bootstrap path settings from editable admin rows", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.cols = 160;

    runtimeModules.queueMod.setSetting("atlas_install_path", "C:/development/claude/tools/atlas-v2");
    runtimeModules.queueMod.setSetting("atlas_node_path", "C:/nvm4w/nodejs/node.exe");
    const lines = tui._buildSettings(158);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const installLine = lines.find((line) => plain(line).includes("atlas_install_path"));
    const nodeLine = lines.find((line) => plain(line).includes("atlas_node_path"));

    assert.equal(installLine, undefined);
    assert.equal(nodeLine, undefined);

    runtimeModules.queueMod.setSetting("atlas_install_path", "");
    runtimeModules.queueMod.setSetting("atlas_node_path", "");
  });

  it("applies a non-zero assessor fallback-read baseline when no setting is stored", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousBase = queueMod.getSetting("assessor_fallback_reads");
    const previousStep = queueMod.getSetting("assessor_fallback_reads_retry_step");
    try {
      queueMod.setSetting("assessor_fallback_reads", "");
      queueMod.setSetting("assessor_fallback_reads_retry_step", "");
      assert.equal(workerMod.__testAssessmentRetryFallbackReads("cheap", 0), 4);
      assert.equal(workerMod.__testAssessmentRetryFallbackReads("standard", 1), 4 + 2 + 2);
      assert.equal(workerMod.__testAssessmentRetryFallbackReads("strong", 2), 4 + 4 + 4);
    } finally {
      queueMod.setSetting("assessor_fallback_reads", previousBase);
      queueMod.setSetting("assessor_fallback_reads_retry_step", previousStep);
    }
  });

  it("uses the global account default for atlas_v2 when unset", () => {
    runtimeModules.queueMod.setSetting("atlas_v2", null);
    assert.equal(runtimeModules.queueMod.getSetting("atlas_v2"), "on");
  });

  it("falls back to default persisted ATLAS boot settings when account values are missing", () => {
    runtimeModules.queueMod.setSetting("atlas_install_path", "");
    runtimeModules.queueMod.setSetting("atlas_node_path", "");
    runtimeModules.queueMod.setSetting("atlas_phases", "");
    runtimeModules.queueMod.setSetting("atlas_live_funnel", "");
    runtimeModules.queueMod.setSetting("atlas_boot_reindex_policy", "");
    runtimeModules.queueMod.setSetting("atlas_reindex_on_commit", "");
    runtimeModules.queueMod.setSetting("assessor_fallback_reads_retry_step", "");
    runtimeModules.queueMod.setSetting("assessor_internal_retry_limit", "");

    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const snapshot = tui._getSettingsSnapshot();
    const byKey = Object.fromEntries(snapshot.dbSettings.map((row) => [row.setting_key, row.setting_value]));
    assert.equal(byKey.atlas_install_path, undefined);
    assert.equal(byKey.atlas_node_path, undefined);
    assert.equal(byKey.atlas_phases, "research,planning,assessment,dev");
    assert.equal(byKey.atlas_live_funnel, "true");
    assert.equal(byKey.atlas_boot_reindex_policy, "smart");
    assert.equal(byKey.atlas_reindex_on_commit, "true");
    assert.equal(byKey.assessor_fallback_reads_retry_step, "2");
    assert.equal(byKey.assessor_internal_retry_limit, "2");
  });

  it("starts ATLAS v2 mode editing as a selector instead of free-form text", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    runtimeModules.queueMod.setSetting("atlas_v2", "on");
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "atlas_v2");
    assert.ok(tui._settingsIndex >= 0);

    tui._startEdit();

    assert.equal(tui._editing, "editModel");
    assert.equal(tui._editStorageKey, "atlas_v2");
    assert.ok(tui._editModelChoices.some((choice) => choice.value === "on"));
    assert.ok(tui._editModelChoices.some((choice) => choice.value === "required"));
  });

  it("starts ATLAS phases editing as a multi-select with the stored values pre-checked", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    runtimeModules.queueMod.setSetting("atlas_phases", "research,assessment");
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "atlas_phases");
    assert.ok(tui._settingsIndex >= 0);

    tui._startEdit();

    assert.equal(tui._editing, "editPhases");
    assert.equal(tui._editStorageKey, "atlas_phases");
    const byValue = Object.fromEntries(tui._editPhaseChoices.map((c) => [c.value, c.enabled]));
    assert.equal(byValue.research, true);
    assert.equal(byValue.planning, false);
    assert.equal(byValue.assessment, true);
    assert.equal(byValue.dev, false);
  });

  it("starts delegation mode editing as a selector instead of free-form text", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    runtimeModules.queueMod.setSetting("delegation_mode", "js");
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "delegation_mode");
    assert.ok(tui._settingsIndex >= 0);

    tui._startEdit();

    assert.equal(tui._editing, "editModel");
    assert.equal(tui._editStorageKey, "delegation_mode");
    assert.ok(tui._editModelChoices.some((choice) => choice.value === "js"));
    assert.ok(tui._editModelChoices.some((choice) => choice.value === "ml"));
  });

  it("shows DB provider overrides as the effective runtime source", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    // Width >=180 keeps the uniform-width row from truncating the provider
    // description (which ends with the source tag like "(global)").
    tui.cols = 200;

    withEnv({ POSSE_PROVIDER_ARTIFICER: "openai" }, () => {
      runtimeModules.queueMod.setSetting("provider_artificer", "claude,codex");

      const lines = tui._buildSettings(198);
      const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
      const providerLine = lines.find((line) => plain(line).includes("provider_artificer"));

      assert.ok(providerLine);
      assert.match(plain(providerLine), /provider_artificer\s+claude,codex/i);
      assert.match(plain(providerLine), /global/i);

      runtimeModules.queueMod.setSetting("provider_artificer", "claude");
    });
  });

  it("starts editing the currently selected settings row without a second selection step", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    const first = tui._getEditableSettings()[tui._settingsIndex];
    tui._startEdit();

    assert.equal(tui._editing, "editValue");
    assert.equal(tui._editKey, first.setting_key);
    assert.equal(tui._editBuf, first.setting_value);
  });

  it("starts editing the actually highlighted later-row setting", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: null,
      CODEX_API_KEY: null,
    }, () => {
      const entries = tui._getEditableSettings();
      const targetIndex = entries.findIndex((entry) => entry.setting_key === "provider_artificer");
      assert.ok(targetIndex >= 0);

      tui._settingsIndex = targetIndex;
      tui._startEdit();

      assert.equal(tui._editing, "editProviders");
      assert.equal(tui._editKey, "provider_artificer");
      assert.ok(Array.isArray(tui._editProviderChoices));
      assert.ok(tui._editProviderChoices.length > 0);
    });
  });

  it("starts editing the selected settings row on Enter", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("", { name: "return" });

    assert.equal(tui._editing, "editValue");
    assert.ok(tui._editKey);
  });

  it("opens provider rows in toggle-edit mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: "xai-test",
      CODEX_API_KEY: "codex-test",
    }, () => {
      const entries = tui._getEditableSettings();
      tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "provider_artificer");
      tui._startEdit();

      assert.equal(tui._editing, "editProviders");
      assert.equal(tui._editKey, "provider_artificer");
      assert.ok(tui._editProviderChoices.some((choice) => choice.provider === "claude"));
    });
  });

  it("opens auto_merge_completed in boolean selector mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "auto_merge_completed");
    assert.ok(tui._settingsIndex >= 0);

    tui._startEdit();

    assert.equal(tui._editing, "editBoolean");
    assert.equal(tui._editKey, "auto_merge_completed");
    assert.deepEqual(tui._editBooleanChoices, ["true", "false"]);
  });

  it("starts editing the selected settings row on enter-named key events", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("", { name: "enter" });

    assert.equal(tui._editing, "editValue");
    assert.ok(tui._editKey);
  });

  it("starts editing the selected settings row on raw carriage-return input", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("\r", {});

    assert.equal(tui._editing, "editValue");
    assert.ok(tui._editKey);
  });

  it("starts editing the selected settings row when hotkeys arrive through key.name", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("", { name: "e" });

    assert.equal(tui._editing, "editValue");
    assert.ok(tui._editKey);
  });

  it("starts editing the selected settings row when typing a printable character", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("9", { name: "9" });

    assert.equal(tui._editing, "editValue");
    assert.equal(tui._editBuf, "9");
    assert.ok(tui._editKey);
  });

  it("starts editing when printable input arrives through key.sequence", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);

    tui._onKeypress("", { name: "x", sequence: "x" });

    assert.equal(tui._editing, "editValue");
    assert.equal(tui._editBuf, "x");
    assert.ok(tui._editKey);
  });

  it("persists edited settings on Enter from edit mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);
    tui._startEdit();
    const selectedKey = tui._editKey;
    const original = runtimeModules.queueMod.getSetting(selectedKey);
    tui._editBuf = "17";
    tui._onEditKeypress("", { name: "return" });

    assert.equal(runtimeModules.queueMod.getSetting(selectedKey), "17");

    if (original == null) {
      runtimeModules.queueMod.setSetting(selectedKey, "500");
    } else {
      runtimeModules.queueMod.setSetting(selectedKey, original);
    }
  });

  it("installs selected SCIP language dependencies after saving the language selector", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const original = runtimeModules.queueMod.getSetting("atlas_scip_languages");
    let installedValue = null;
    tui._settingsController._installScipLanguageDependencies = function installScipLanguageDependencies(value) {
      assert.equal(this, tui);
      installedValue = value;
    };

    const ok = tui._saveSettingValue("atlas_scip_languages", "typescript,python");

    assert.equal(ok, true);
    assert.equal(installedValue, "typescript,python");
    assert.equal(runtimeModules.queueMod.getSetting("atlas_scip_languages"), "typescript,python");
    runtimeModules.queueMod.setSetting("atlas_scip_languages", original ?? "typescript,python,php,go,rust");
  });

  it("renders a visible SCIP dependency install alert while installers run", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._scipDependencyInstall = {
      active: true,
      languagesLabel: "typescript,python",
      message: "installing Node SCIP indexers for typescript, python",
      pendingLabel: null,
      results: [],
      ok: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const lines = tui._buildScipDependencyInstallNavLines().map(plain);

    assert.match(lines.join("\n"), /Installing SCIP dependencies/);
    assert.match(lines.join("\n"), /typescript,python/);
    assert.match(lines.join("\n"), /installing Node SCIP indexers/);
  });

  it("updates SCIP dependency alert state from the async installer worker", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const handlers = new Map();
    let workerValue = null;
    let spinnerStarted = false;
    let spinnerStopped = false;
    let dismissScheduled = false;
    tui.requestRender = () => {};
    tui._startScipDependencySpinner = () => { spinnerStarted = true; };
    tui._stopScipDependencySpinner = () => { spinnerStopped = true; };
    tui._scheduleScipDependencyAlertDismiss = () => { dismissScheduled = true; };
    tui._startScipLanguageDependencyWorker = (value) => {
      workerValue = value;
      return {
        on(event, handler) {
          handlers.set(event, handler);
          return this;
        },
      };
    };

    tui._runScipLanguageDependencyInstallAsync("typescript");
    handlers.get("message")({ type: "progress", message: "installing Node SCIP indexers for typescript" });
    handlers.get("message")({
      type: "done",
      result: {
        ok: true,
        results: [{ language: "typescript", ok: true, message: "installed SCIP Node indexers" }],
      },
    });

    assert.equal(workerValue, "typescript");
    assert.equal(spinnerStarted, true);
    assert.equal(spinnerStopped, true);
    assert.equal(dismissScheduled, true);
    assert.equal(tui._scipDependencyInstall.active, false);
    assert.equal(tui._scipDependencyInstall.ok, true);
    assert.match(tui._scipDependencyInstall.events.join("\n"), /installed SCIP Node indexers/);
  });

  it("strips terminal controls from SCIP dependency install alert text", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const handlers = new Map();
    tui.requestRender = () => {};
    tui._startScipDependencySpinner = () => {};
    tui._stopScipDependencySpinner = () => {};
    tui._scheduleScipDependencyAlertDismiss = () => {};
    tui._startScipLanguageDependencyWorker = () => ({
      on(event, handler) {
        handlers.set(event, handler);
        return this;
      },
    });

    tui._runScipLanguageDependencyInstallAsync("typescript\x1b[2J");
    handlers.get("message")({ type: "progress", message: "installing\x1b[?1049h" });
    handlers.get("message")({
      type: "done",
      result: {
        ok: false,
        message: "done\x1b]0;owned\x07",
        results: [{ language: "node\x1b[2J", ok: false, message: "failed\x1b[?25l" }],
      },
    });

    const rendered = tui._buildScipDependencyInstallNavLines().join("\n");
    assert.doesNotMatch(rendered, /\x1b\[2J|\x1b\[\?1049h|\x1b\]0;|\x1b\[\?25l|\x07/);
    assert.match(rendered, /typescript/);
    assert.match(rendered, /done/);
    assert.match(rendered, /failed/);
  });

  it("keeps admin numeric setting edits in edit mode when the value is invalid", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);
    const original = runtimeModules.queueMod.getSetting("assessor_fallback_reads");
    tui._startEdit();
    tui._editBuf = "abc";
    tui._onEditKeypress("", { name: "return" });

    assert.equal(tui._editing, "editValue");
    assert.match(tui._editError, /must be a number/);
    assert.equal(runtimeModules.queueMod.getSetting("assessor_fallback_reads"), original);
  });

  it("cancels admin edit mode when tabbing to another section", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    tui._tab = 2;
    tui._editing = "editValue";
    tui._editKey = "assessor_fallback_reads";
    tui._editStorageKey = "assessor_fallback_reads";
    tui._editBuf = "17";

    tui._onKeypress("", { name: "tab" });

    assert.equal(tui._editing, false);
    assert.equal(tui._editKey, "");
    assert.equal(tui._tab, 3);
  });

  it("saves provider toggle selections without relying on text input", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    withEnv({
      OPENAI_API_KEY: "openai-test",
      XAI_API_KEY: null,
      CODEX_API_KEY: "codex-test",
    }, () => {
      const entries = tui._getEditableSettings();
      tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "provider_artificer");
      const original = runtimeModules.queueMod.getSetting("provider_artificer");
      tui._startEdit();

      for (const choice of tui._editProviderChoices) {
        choice.enabled = choice.provider === "claude" || choice.provider === "codex";
      }
      tui._onEditKeypress("", { name: "return" });

      assert.equal(runtimeModules.queueMod.getSetting("provider_artificer"), "claude,codex");

      runtimeModules.queueMod.setSetting("provider_artificer", original ?? "claude");
    });
  });

  it("persists edited settings on enter-named key events from edit mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);
    tui._startEdit();
    const selectedKey = tui._editKey;
    const original = runtimeModules.queueMod.getSetting(selectedKey);
    tui._editBuf = "23";
    tui._onEditKeypress("", { name: "enter" });

    assert.equal(runtimeModules.queueMod.getSetting(selectedKey), "23");

    if (original == null) {
      runtimeModules.queueMod.setSetting(selectedKey, "500");
    } else {
      runtimeModules.queueMod.setSetting(selectedKey, original);
    }
  });

  it("persists edited settings on raw carriage-return input from edit mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "assessor_fallback_reads");
    assert.ok(tui._settingsIndex >= 0);
    tui._startEdit();
    const selectedKey = tui._editKey;
    const original = runtimeModules.queueMod.getSetting(selectedKey);
    tui._editBuf = "29";
    tui._onEditKeypress("\r", {});

    assert.equal(runtimeModules.queueMod.getSetting(selectedKey), "29");

    if (original == null) {
      runtimeModules.queueMod.setSetting(selectedKey, "500");
    } else {
      runtimeModules.queueMod.setSetting(selectedKey, original);
    }
  });

  it("persists boolean settings from selector mode", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};

    const entries = tui._getEditableSettings();
    tui._settingsIndex = entries.findIndex((entry) => entry.setting_key === "auto_merge_completed");
    assert.ok(tui._settingsIndex >= 0);

    const original = runtimeModules.queueMod.getSetting("auto_merge_completed");
    tui._startEdit();
    tui._editBooleanIndex = 0;
    tui._onEditKeypress("", { name: "return" });
    assert.equal(runtimeModules.queueMod.getSetting("auto_merge_completed"), "true");

    runtimeModules.queueMod.setSetting("auto_merge_completed", original ?? "false");
  });

  it("clips long admin edit input so the latest typed text stays visible", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._editing = "editValue";
    tui._editKey = "scheduler_poll_ms";
    tui._editBuf = "0123456789abcdefghijklmnopqrstuvwxyz";

    const lines = tui._buildEditValueNavLines(40);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");

    assert.ok(plain(lines[0]).includes("uvwxyz"));
    assert.ok(plain(lines[0]).includes("…"));
    assert.ok(lines.some((line) => plain(line).includes("latest typing stays visible")));
  });

  it("does not force the admin edit input text to white", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._editing = "editValue";
    tui._editKey = "scheduler_poll_ms";
    tui._editBuf = "visible text";

    const lines = tui._buildEditValueNavLines(60);

    assert.equal(lines[0].includes("\x1b[37m"), false);
  });

  it("positions the real cursor at the end of the visible admin edit input", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._editing = "editValue";
    tui._editKey = "scheduler_poll_ms";
    tui._editBuf = "0123456789abcdefghijklmnopqrstuvwxyz";

    const fullW = 38;
    const navStartRow = 12;
    const pos = tui._getEditValueCursorPosition(fullW, navStartRow);
    const lines = tui._buildEditValueNavLines(fullW);
    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const firstLine = plain(lines[0]);
    const visiblePrefix = " Editing scheduler_poll_ms: ";
    const visibleValue = firstLine.slice(visiblePrefix.length, firstLine.indexOf("  [Enter] Save"));

    assert.equal(pos.row, navStartRow);
    assert.equal(pos.col, 2 + visiblePrefix.length + visibleValue.length);
  });

  it("keeps the admin edit banner inside the visible frame height", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui.rows = 12;
    tui.cols = 80;
    tui._tab = 2;
    tui._editing = "editValue";
    tui._editKey = "scheduler_poll_ms";
    tui._editBuf = "12345";
    tui._stdoutBackedUp = false;

    let rendered = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      rendered += String(chunk);
      return true;
    };

    try {
      tui._render();
    } finally {
      process.stdout.write = originalWrite;
    }

    const matches = [...rendered.matchAll(/\x1b\[(\d+);(\d+)H/g)];
    const rows = matches
      .map((m) => Number.parseInt(m[1], 10))
      .filter((row) => row <= tui.rows);
    assert.ok(rows.length > 0);
    assert.equal(Math.max(...rows) <= tui.rows, true);
  });

  it("moves the selected settings row with arrow navigation helpers", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._settingsRowMap = new Map([
      ["default_max_attempts", 5],
      ["default_lease_seconds", 6],
    ]);
    tui.rows = 20;
    tui._scroll = 0;

    tui._moveSettingsSelection(1);

    assert.equal(tui._settingsIndex, 1);
  });
});
