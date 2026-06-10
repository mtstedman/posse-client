import {
  it,
  before,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  now,
  withEnv,
  withQueueSettings,
  getProvider,
  parseErrorBackoff,
  setClaudeConfigDirForTests,
} from "../support/core-harness.js";

function createFakeInteractiveBackend(onWrite) {
  const writes = [];
  const backend = {
    name: "fake-pty",
    writes,
    spawn(command, args = [], opts = {}) {
      const handlers = new Set();
      let exitResolved = false;
      let resolveExit;
      const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      const emit = (text) => {
        queueMicrotask(() => {
          for (const handler of Array.from(handlers)) handler(String(text || ""));
        });
      };
      const exit = (event = {}) => {
        if (exitResolved) return;
        exitResolved = true;
        resolveExit({ exitCode: event.exitCode ?? 0, signal: event.signal ?? null });
      };
      return {
        command,
        args,
        opts,
        onData(callback) {
          handlers.add(callback);
          return () => handlers.delete(callback);
        },
        write(data) {
          writes.push(String(data || ""));
          onWrite?.({ data: String(data || ""), command, args, opts, emit, exit });
        },
        resize() {},
        kill() {
          exit({ exitCode: null, signal: "SIGTERM" });
        },
        exitPromise,
      };
    },
  };
  return backend;
}

function deterministicBootConfigFromArgs(args = []) {
  const configIndex = args.indexOf("--config-json");
  assert.ok(configIndex >= 0, "deterministic MCP args should include --config-json");
  return JSON.parse(Buffer.from(args[configIndex + 1], "base64").toString("utf8"));
}

function codexDeterministicBootConfig(resolved) {
  return deterministicBootConfigFromArgs(resolved?.serverConfig?.args || []);
}

function claudeDeterministicServer(payload) {
  return payload?.payload?.mcpServers?.["posse-gateway"] || null;
}

function claudeDeterministicBootConfig(payload) {
  return deterministicBootConfigFromArgs(claudeDeterministicServer(payload)?.args || []);
}

let db;

suite("Provider aliases", () => {
  it("loads native codex and grok providers", () => {
    assert.notEqual(getProvider("dev", "codex"), getProvider("dev", "openai"));
    assert.notEqual(getProvider("dev", "grok"), getProvider("dev", "openai"));
  });

  it("exposes the Codex CLI and Grok provider surfaces", () => {
    const codex = getProvider("dev", "codex");
    const grok = getProvider("dev", "grok");
    assert.equal(typeof codex.callProvider, "function");
    assert.equal(typeof codex.getClaudeInfo, "function");
    assert.equal(typeof codex.parseErrorBackoff, "function");
    assert.equal(typeof codex.getRateLimitState, "function");
    assert.equal(typeof grok.callProvider, "function");
    assert.equal(typeof grok.getClaudeInfo, "function");
    assert.equal(typeof grok.parseErrorBackoff, "function");
    assert.equal(typeof grok.getRateLimitState, "function");
  });

  it("gives explicit per-job model names precedence over provider defaults", async () => {
    const { selectExecutionModel } = await import("../../../lib/domains/providers/functions/helpers/model-selection.js");

    assert.equal(selectExecutionModel({
      jobModelName: "job-specific-model",
      globalModelOverride: "global-default-model",
      tierModel: "tier-model",
    }), "job-specific-model");
    assert.equal(selectExecutionModel({
      globalModelOverride: "global-default-model",
      tierModel: "tier-model",
    }), "global-default-model");
    assert.equal(selectExecutionModel({ tierModel: "tier-model" }), "tier-model");
  });

  it("treats atlas_v2=off as a hard disable even when atlas_mode is required", async () => {
    await withQueueSettings({
      atlas_mode: "required",
      atlas_v2: "off",
      atlas_phases: "research",
      atlas_live_funnel: "false",
      codex_auth_mode: "api",
    }, async () => {
      const { resolveAtlasExecutionAttachment } = await import("../../../lib/domains/integrations/functions/atlas.js");
      for (const providerName of ["claude", "codex", "openai", "grok"]) {
        const attachment = resolveAtlasExecutionAttachment({
          role: "researcher",
          providerName,
          cwd: process.cwd(),
        });
        assert.equal(attachment.active, false, `${providerName} should be inactive`);
        assert.equal(attachment.failClosed, false, `${providerName} should not fail closed when v2 is off`);
        assert.equal(attachment.method, "disabled");
      }
    });
  });

  it("reports circuit-breaker rate-limit state for OpenAI and Grok without undefined references", async () => {
    const openai = await import("../../../lib/domains/providers/functions/openai.js");
    const grok = await import("../../../lib/domains/providers/functions/grok.js");
    openai.tripRateLimit(1);
    grok.tripRateLimit(1);
    const openaiState = openai.getRateLimitState();
    const grokState = grok.getRateLimitState();
    assert.equal(openaiState.blocked, true);
    assert.equal(grokState.blocked, true);
    assert.ok(Number.isFinite(openaiState.retryInSec));
    assert.ok(Number.isFinite(grokState.retryInSec));
  });

  it("passes abort signals into OpenAI-compatible Responses calls", async () => {
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    const seen = [];
    const client = {
      responses: {
        create: async (requestOpts, requestOptions) => {
          seen.push({ requestOpts, requestOptions });
          return { output_text: "ok" };
        },
      },
    };

    const result = await openaiMod.__testCallAbortableResponsesCreate({
      client,
      requestOpts: { model: "gpt-test", input: "hello" },
      label: "unit",
      providerLabel: "OpenAI",
      stallMs: 1000,
    });

    assert.equal(result.output_text, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].requestOpts.model, "gpt-test");
    assert.ok(seen[0].requestOptions.signal instanceof AbortSignal);
    assert.equal(seen[0].requestOptions.signal.aborted, false);
  });

  it("aborts OpenAI-compatible Responses calls on stall timeout", async () => {
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    let receivedSignal = null;
    const client = {
      responses: {
        create: (_requestOpts, requestOptions) => {
          receivedSignal = requestOptions.signal;
          return new Promise(() => {});
        },
      },
    };

    await assert.rejects(
      () => openaiMod.__testCallAbortableResponsesCreate({
        client,
        requestOpts: { model: "gpt-test", input: "hello" },
        label: "unit stall",
        providerLabel: "OpenAI",
        stallMs: 5,
        baseStallSec: 0.005,
      }),
      (err) => err.stallKill === true && /OpenAI API stall/.test(err.message)
    );
    assert.equal(receivedSignal.aborted, true);
  });

  it("aborts OpenAI-compatible Responses calls on worker cancellation", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");
    const ac = new AbortController();
    let receivedSignal = null;
    const client = {
      responses: {
        create: (_requestOpts, requestOptions) => {
          receivedSignal = requestOptions.signal;
          return new Promise(() => {});
        },
      },
    };

    const pending = grokMod.__testCallAbortableResponsesCreate({
      client,
      requestOpts: { model: "grok-test", input: "hello" },
      label: "unit abort",
      providerLabel: "Grok",
      externalSignal: ac.signal,
      stallMs: 1000,
    });
    ac.abort();

    await assert.rejects(
      () => pending,
      (err) => err.name === "AbortError" && /Grok API aborted/.test(err.message)
    );
    assert.equal(receivedSignal.aborted, true);
  });

  it("skips duplicate or disabled pre-assess command execution", async () => {
    const assessment = await import("../../../lib/domains/worker/functions/helpers/assessment-pipeline.js");
    assert.equal(assessment.shouldRunPreAssessCommand({
      command: "npm test",
      wtPath: __dirname,
    }), true);
    assert.equal(assessment.shouldRunPreAssessCommand({
      command: "npm test",
      wtPath: __dirname,
      preAssessAlreadyVerified: true,
    }), false);
    assert.equal(assessment.shouldRunPreAssessCommand({
      command: "npm test",
      wtPath: __dirname,
      hooksSkipped: true,
    }), false);
  });

  it("resolves the Codex executable directly from PATH entries on Windows", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-test-"));
    const denyDir = path.join(root, "denybin");
    const exeDir = path.join(root, "openai", "bin");
    fs.mkdirSync(denyDir, { recursive: true });
    fs.mkdirSync(exeDir, { recursive: true });
    fs.writeFileSync(path.join(exeDir, "codex.exe"), "", "utf-8");

    try {
      const fakePath = [denyDir, exeDir].join(path.delimiter);
      const resolved = codex.__testResolveWindowsPathCommand("codex", fakePath);
      assert.equal(resolved, path.join(exeDir, "codex.exe"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects protected WindowsApps Codex resource binaries as CLI entrypoints", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    assert.equal(
      codex.__testIsProtectedWindowsAppCodexPath("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__abc\\app\\resources\\codex.exe"),
      true
    );
    assert.equal(
      codex.__testIsProtectedWindowsAppCodexPath("C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe"),
      false
    );
  });

  it("treats stale codex sandbox binaries as invalid when --version probe fails", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const ok = codex.__testIsExecutableCodexCli("C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe", () => ({ status: 0 }));
    const notOk = codex.__testIsExecutableCodexCli("C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe", () => ({ status: 1 }));
    const threw = codex.__testIsExecutableCodexCli("C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe", () => { throw new Error("ENOENT"); });
    assert.equal(ok, true);
    assert.equal(notOk, false);
    assert.equal(threw, false);
  });

  it("requires Codex CLI resume contract flags before selecting a binary", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const compatible = codex.__testCodexCliSupportsExecContract("C:\\codex.exe", (_cmd, args) => {
      if (args.includes("--version")) return { status: 0, stdout: "codex-cli 0.130.0" };
      return {
        status: 0,
        stdout: "--json --output-last-message --skip-git-repo-check --ignore-rules --config",
      };
    });
    const old = codex.__testCodexCliSupportsExecContract("C:\\codex.exe", (_cmd, args) => {
      if (args.includes("--version")) return { status: 0, stdout: "codex-cli 0.119.0-alpha.28" };
      return {
        status: 0,
        stdout: "--json --output-last-message --skip-git-repo-check --config",
      };
    });

    assert.equal(compatible, true);
    assert.equal(old, false);
  });

  it("spawns Codex .exe binaries directly on Windows without cmd.exe wrapping", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const launch = codex.__testBuildCodexSpawn(
        "C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe",
        ["exec", "-c", 'foo="bar"']
      );
      assert.equal(launch.command, "C:\\Users\\mason\\.codex\\.sandbox-bin\\codex.exe");
      assert.deepEqual(launch.args, ["exec", "-c", 'foo="bar"']);
      assert.equal(launch.windowsVerbatimArguments, false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("runs scripted terminal interactions through the shared interactive CLI wrapper", async () => {
    const { InteractiveCliSession, stripTerminalControls } = await import("../../../lib/domains/providers/functions/helpers/interactive-cli-session.js");
    const backend = createFakeInteractiveBackend(({ data, emit, exit }) => {
      if (data === "/status\r") emit("\x1b[32m5h limit: [====] 70% left (resets 23:01)\x1b[0m\r\n");
      if (data === "/quit\r") exit();
    });
    const session = new InteractiveCliSession({
      command: "codex",
      args: ["--no-alt-screen"],
      backend,
      timeoutMs: 1_000,
      quietMs: 10,
    });

    try {
      const transcript = await session.runScript([
        { sendLine: "/status" },
        { waitFor: (text) => /70% left/.test(stripTerminalControls(text)), timeoutMs: 1_000 },
        { sendLine: "/quit" },
      ]);
      assert.match(stripTerminalControls(transcript), /5h limit: \[====\] 70% left/);
      assert.deepEqual(backend.writes, ["/status\r", "/quit\r"]);
    } finally {
      await session.close({ gracefulMs: 1 });
    }
  });

  it("parses Codex interactive status output into usage windows", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const nowMs = Date.parse("2026-05-18T04:00:00-05:00");
    const parsed = codex.__testParseCodexStatusText(`
      Account: user@example.com (Pro Lite)
      Session: 019e38b7-ee71-75d2-bc7f-9b0983d1a168

      5h limit: [======    ] 70% left (resets 23:01)
      Weekly limit: [========  ] 80% left (resets 16:36 on 23 May)
      Credits: 1,487 credits

      GPT-5.3-Codex-Spark limit:
      5h limit: [==========] 100% left (resets 01:33 on 18 May)
      Weekly limit: [==========] 100% left (resets 20:33 on 24 May)
    `, nowMs);

    assert.equal(parsed.accountPlan, "Pro Lite");
    assert.equal(parsed.sessionId, "019e38b7-ee71-75d2-bc7f-9b0983d1a168");
    assert.equal(parsed.credits.balance, 1487);

    const session = parsed.windows.find((window) => window.key === "session");
    const week = parsed.windows.find((window) => window.key === "week");
    const sparkSession = parsed.windows.find((window) => window.key === "gpt-5-3-codex-spark_session");
    assert.equal(session.utilizationPct, 30);
    assert.equal(session.remainingPct, 70);
    assert.equal(week.utilizationPct, 20);
    assert.ok(Date.parse(week.resetAt) > nowMs);
    assert.equal(sparkSession.utilizationPct, 0);
  });

  it("normalizes Codex app-server rate-limit snapshots", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const summary = codex.__testNormalizeCodexRateLimitsResponse({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_735_689_720 },
        secondary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 1_735_693_200 },
        credits: { hasCredits: true, unlimited: false, balance: "1487" },
        planType: "pro",
      },
      rateLimitsByLimitId: {
        "gpt-5.3-codex-spark": {
          limitId: "gpt-5.3-codex-spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_735_696_800 },
        },
      },
    }, Date.parse("2026-05-18T09:00:00.000Z"));

    assert.equal(summary.provider, "codex");
    assert.equal(summary.source, "codex-app-server-rate-limits");
    assert.equal(summary.subscriptionType, "pro");
    assert.equal(summary.credits.balance, 1487);
    const session = summary.windows.find((window) => window.key === "session");
    const sparkSession = summary.windows.find((window) => window.key === "gpt-5-3-codex-spark_session");
    assert.equal(session.label, "Session (5h)");
    assert.equal(session.utilizationPct, 42);
    assert.equal(session.remainingPct, 58);
    assert.equal(sparkSession.label, "GPT-5.3-Codex-Spark Session (5h)");
  });

  it("can run Claude OAuth warmup through the shared interactive CLI wrapper", async () => {
    const claude = await import("../../../lib/domains/providers/functions/claude.js");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-warmup-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    const backend = createFakeInteractiveBackend(({ data, emit, exit }) => {
      if (/Reply with OK/.test(data)) emit("OK\r\n");
      if (data === "/exit\r") exit();
    });

    try {
      claude.__testSetClaudeResolution("claude", []);
      setClaudeConfigDirForTests(claudeHome);
      const result = await claude.warmOauthSessionAsync({
        preferInteractive: true,
        interactiveBackend: backend,
        timeoutMs: 1_000,
      });
      assert.equal(result.attempted, true);
      assert.equal(result.ok, true);
      assert.match(result.stdout, /\bOK\b/);
      assert.deepEqual(backend.writes, ["Reply with OK.\r", "/exit\r"]);
    } finally {
      setClaudeConfigDirForTests(null);
      claude.__testResetClaudeResolution();
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("can run Claude provider calls through the interactive CLI wrapper", async () => {
    const claude = await import("../../../lib/domains/providers/functions/claude.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-call-"));
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-home-"));
    let spawnedArgs = null;
    let emitted = false;
    let promptWrite = "";
    const backend = createFakeInteractiveBackend(({ data, args, emit, exit }) => {
      spawnedArgs = args;
      if (data === "/exit\r") {
        exit();
        return;
      }
      promptWrite += data;
      if (!emitted && promptWrite.includes("Use the PTY wrapper.")) {
        emitted = true;
        const sessionId = "fake-interactive-session";
        const projectLogDir = claude.__testGetClaudeProjectDirForCwd(tmpDir);
        const sessionsDir = path.join(claudeHome, "sessions");
        fs.mkdirSync(projectLogDir, { recursive: true });
        fs.mkdirSync(sessionsDir, { recursive: true });
        const logPath = path.join(projectLogDir, `${sessionId}.jsonl`);
        const nowIso = new Date().toISOString();
        const rows = [
          { type: "user", sessionId, timestamp: nowIso, message: { role: "user", content: "Use the PTY wrapper." } },
          { type: "assistant", sessionId, timestamp: nowIso, message: { role: "assistant", content: [{ type: "text", text: "interactive final answer" }], usage: { input_tokens: 12, output_tokens: 3 } } },
          { type: "system", subtype: "turn_duration", sessionId, timestamp: nowIso, durationMs: 42 },
        ];
        fs.writeFileSync(logPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
        fs.writeFileSync(path.join(sessionsDir, "4242.json"), JSON.stringify({
          pid: 4242,
          sessionId,
          cwd: tmpDir,
          kind: "interactive",
          entrypoint: "cli",
          status: "idle",
          updatedAt: Date.now(),
        }), "utf8");
        emit("interactive final answer\r\n");
      }
    });

    try {
      claude.__testSetClaudeResolution("claude", []);
      setClaudeConfigDirForTests(claudeHome);
      const result = await claude.callProvider("Use the PTY wrapper.", {
        role: "planner",
        cwd: tmpDir,
        projectDir: tmpDir,
        loaderCwd: tmpDir,
        skipRolePrompt: true,
        disableAtlas: true,
        silent: true,
        autoApprove: true,
        maxTurns: 1,
        executionMode: "interactive",
        interactiveBackend: backend,
        stallTimeout: 1,
      });

      assert.equal(result.output, "interactive final answer");
      assert.equal(result.stats.executionMode, "interactive");
      assert.equal(result.stats.usageEstimated, false);
      assert.equal(result.stats.inputTokens, 12);
      assert.equal(result.stats.outputTokens, 3);
      assert.ok(Array.isArray(spawnedArgs));
      assert.equal(spawnedArgs.includes("-p"), false);
      assert.equal(spawnedArgs.includes("--output-format"), false);
      assert.equal(spawnedArgs.includes("--dangerously-skip-permissions"), false);
      assert.ok(spawnedArgs.includes("--permission-mode"));
      assert.ok(spawnedArgs.includes("dontAsk"));
      assert.ok(promptWrite.includes("Use the PTY wrapper."));
      assert.equal(/POSSE_RESPONSE_(?:START|DONE)_/i.test(promptWrite), false);
      assert.ok(backend.writes.includes("/exit\r"));
    } finally {
      setClaudeConfigDirForTests(null);
      claude.__testResetClaudeResolution();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("captures Claude full-message tool_use blocks in provider stats", async () => {
    const claude = await import("../../../lib/domains/providers/functions/claude.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-tool-use-"));
    const fakeCli = path.join(tmpDir, "fake-claude.mjs");
    fs.writeFileSync(fakeCli, `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  console.log(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_web_fetch",
        name: "WebFetch",
        input: {
          url: "https://news.ycombinator.com/",
          prompt: "What is the top story title?"
        }
      }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  }));
  console.log(JSON.stringify({
    type: "result",
    result: "done",
    usage: { input_tokens: 12, output_tokens: 3 }
  }));
});
`, "utf8");

    try {
      claude.__testSetClaudeResolution(process.execPath, [fakeCli]);
      const result = await claude.callProvider("probe web tool parsing", {
        role: "researcher",
        cwd: tmpDir,
        projectDir: tmpDir,
        loaderCwd: tmpDir,
        skipRolePrompt: true,
        disableAtlas: true,
        silent: true,
        autoApprove: true,
        maxTurns: 1,
      });

      assert.equal(result.output, "done");
      assert.deepEqual(result.stats.toolUses, [{
        id: "toolu_web_fetch",
        tool: "WebFetch",
        input: {
          url: "https://news.ycombinator.com/",
          prompt: "What is the top story title?",
        },
      }]);
    } finally {
      claude.__testResetClaudeResolution();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats Codex usage-limit errors as rate-limited backoff", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const result = codex.parseErrorBackoff(new Error("You have reached your usage limit for now."));

    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "usage_limit");
    assert.equal(result.backoffSec, 15 * 60);
  });

  it("uses Codex exec flags supported by the installed CLI", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const args = codex.__testBuildCodexExecArgs({
      outputFile: "last-message.txt",
      workingDir: process.cwd(),
      allowWrite: false,
      modelToUse: "gpt-5-mini",
    });

    assert.equal(args.includes("--ask-for-approval"), false);
    const approvalIdx = args.findIndex((a, i) => a === "-c" && args[i + 1] === 'approval_policy="never"');
    assert.ok(approvalIdx !== -1, "expected -c approval_policy=\"never\" in args");
    const sandboxOverrideIdx = args.findIndex((a, i) => a === "-c" && args[i + 1] === 'sandbox_mode="read-only"');
    assert.ok(sandboxOverrideIdx !== -1, "expected -c sandbox_mode=\"read-only\" in args");
    assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.ok(args.includes("--ignore-rules"));
  });

  it("uses Codex exec resume without flags the resume subcommand cannot enforce", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const args = codex.__testBuildCodexExecArgs({
      outputFile: "last-message.txt",
      workingDir: process.cwd(),
      allowWrite: true,
      modelToUse: "gpt-5-mini",
      priorSessionHandle: "session-123",
    });

    assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
    assert.equal(args.includes("--cd"), false);
    assert.equal(args.includes("--sandbox"), false);
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.ok(args.includes("--ignore-rules"));
    assert.ok(args.includes("session-123"));
    assert.equal(args.at(-1), "-");
    const sandboxOverrideIdx = args.findIndex((a, i) => a === "-c" && args[i + 1] === 'sandbox_mode="workspace-write"');
    assert.ok(sandboxOverrideIdx !== -1, "resume must pin sandbox_mode through config");
  });

  it("treats sibling-prefixed Codex paths as outside the working directory", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const root = path.join(os.tmpdir(), "codex-sibling-prefix");
    const workingDir = path.join(root, "wi-123");
    const siblingDir = path.join(root, "wi-123-extra");
    const insideFile = path.join(workingDir, "src", "app.js");
    const siblingFile = path.join(siblingDir, "out.txt");
    const extraDirs = codex.__testCollectCodexExtraDirs({
      workingDir,
      scopedFiles: [insideFile, siblingFile],
      fsImpl: {
        existsSync: () => false,
        statSync: () => ({ isDirectory: () => false }),
      },
    });

    assert.deepEqual(extraDirs, [siblingDir]);
  });

  it("switches Codex sandbox mode with allowWrite for role handlers", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const readArgs = codex.__testBuildCodexExecArgs({
      outputFile: "read.txt",
      workingDir: process.cwd(),
      allowWrite: false,
      modelToUse: "gpt-5-mini",
    });
    const writeArgs = codex.__testBuildCodexExecArgs({
      outputFile: "write.txt",
      workingDir: process.cwd(),
      allowWrite: true,
      modelToUse: "gpt-5-mini",
    });

    assert.deepEqual(readArgs.slice(readArgs.indexOf("--sandbox"), readArgs.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.deepEqual(writeArgs.slice(writeArgs.indexOf("--sandbox"), writeArgs.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  });

  it("disables native Codex shell/unified_exec tools when strict MCP mode is on", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const off = codex.__testBuildCodexSystemToolLockdownOverrides({ disableSystemTools: false });
    assert.deepEqual(off, []);
    const on = codex.__testBuildCodexSystemToolLockdownOverrides({ disableSystemTools: true });
    assert.deepEqual(on, ["features.shell_tool=false", "features.unified_exec=false"]);
  });

  it("enables Codex web_search only for researcher and artificer when the toggle is on", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    for (const role of ["researcher", "artificer"]) {
      const resolved = codex.__testBuildCodexWebToolsOverrides({ role, webToolsEnabled: true });
      assert.equal(resolved.active, true);
      assert.deepEqual(resolved.configOverrides, ["tools.web_search=true"]);

      const args = codex.__testBuildCodexExecArgs({
        outputFile: "out.txt",
        workingDir: process.cwd(),
        allowWrite: false,
        modelToUse: "gpt-5.4",
        configOverrides: resolved.configOverrides,
      });
      const idx = args.findIndex((a, i) => a === "-c" && args[i + 1] === "tools.web_search=true");
      assert.ok(idx !== -1, `expected -c tools.web_search=true for ${role}`);
    }

    const synthResolved = codex.__testBuildCodexWebToolsOverrides({
      role: "researcher",
      roleMode: "synth",
      webToolsEnabled: true,
    });
    assert.equal(synthResolved.active, false);
    assert.deepEqual(synthResolved.configOverrides, []);

    for (const role of ["dev", "assessor", "planner", "delegator"]) {
      const resolved = codex.__testBuildCodexWebToolsOverrides({ role, webToolsEnabled: true });
      assert.equal(resolved.active, false, `${role} must not get web tools`);
      assert.deepEqual(resolved.configOverrides, []);
    }

    const offResolved = codex.__testBuildCodexWebToolsOverrides({ role: "researcher", webToolsEnabled: false });
    assert.equal(offResolved.active, false);
    assert.deepEqual(offResolved.configOverrides, []);
  });

  it("builds Codex close-path stats without touching finalOutput before initialization", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const stats = codex.__testBuildCloseStats({
      role: "dev",
      modelTier: "standard",
      reasoningEffort: "medium",
      modelName: "gpt-5-codex",
      totalInputTokens: 12,
      totalOutputTokens: 34,
      durationMs: 56,
      finalOutput: "",
      stdout: "stdout fallback",
      code: 1,
    });

    assert.equal(stats.outputChars, "stdout fallback".length);
    assert.equal(stats.exitCode, 1);
    assert.equal(stats.provider, "codex");
  });

  it("accumulates Codex explicit token deltas", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const acc = codex.__testCreateCodexUsageAccumulator();

    acc.add({ inputTokens: 10, outputTokens: 3, inputKind: "delta", outputKind: "delta" });
    acc.add({ inputTokens: 25, outputTokens: 7, inputKind: "delta", outputKind: "delta" });

    assert.deepEqual(acc.snapshot(), { inputTokens: 35, outputTokens: 10, longContextInputTokens: 25 });
  });

  it("deduplicates Codex usage events with stable event ids", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const acc = codex.__testCreateCodexUsageAccumulator();
    const eventKey = codex.__testCodexUsageEventDedupeKey({
      type: "usage_delta",
      event_id: "evt-1",
      usage: { input_tokens_delta: 10, output_tokens_delta: 2 },
    });

    acc.add({ inputTokens: 10, outputTokens: 2, inputKind: "delta", outputKind: "delta" }, { eventKey });
    acc.add({ inputTokens: 10, outputTokens: 2, inputKind: "delta", outputKind: "delta" }, { eventKey });
    acc.add({ inputTokens: 5, outputTokens: 1, inputKind: "delta", outputKind: "delta" }, { eventKey: "usage_delta:evt-2" });

    assert.equal(eventKey, "usage_delta:evt-1");
    assert.deepEqual(acc.snapshot(), { inputTokens: 15, outputTokens: 3, longContextInputTokens: 10 });
  });

  it("keeps latest Codex cumulative token totals", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const acc = codex.__testCreateCodexUsageAccumulator();

    acc.add({ inputTokens: 10, outputTokens: 3, inputKind: "cumulative", outputKind: "cumulative" });
    acc.add({ inputTokens: 25, outputTokens: 7, inputKind: "cumulative", outputKind: "cumulative" });

    assert.deepEqual(acc.snapshot(), { inputTokens: 25, outputTokens: 7, longContextInputTokens: 15 });
  });

  it("treats decreasing ambiguous Codex usage events as per-event token chunks", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const acc = codex.__testCreateCodexUsageAccumulator();

    acc.add({ inputTokens: 30, outputTokens: 8 });
    acc.add({ inputTokens: 5, outputTokens: 2 });

    assert.deepEqual(acc.snapshot(), { inputTokens: 35, outputTokens: 10, longContextInputTokens: 30 });
  });

  it("extracts Codex usage totals and deltas from common event shapes", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    assert.deepEqual(
      codex.__testExtractCodexUsageFromEvent({
        usage: { total_input_tokens: 123, total_output_tokens: 45 },
      }),
      { inputTokens: 123, outputTokens: 45, inputKind: "cumulative", outputKind: "cumulative" }
    );
    assert.deepEqual(
      codex.__testExtractCodexUsageFromEvent({
        token_usage: { input_tokens_delta: 12, output_tokens_delta: 4 },
      }),
      { inputTokens: 12, outputTokens: 4, inputKind: "delta", outputKind: "delta" }
    );
  });

  it("correlates Codex function-call MCP cancellations into provider tool replay", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const toolUses = [];

    codex.__testAppendCodexToolUseEvent(toolUses, {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__posse_gateway__atlas_symbol_search",
        call_id: "call_123",
        arguments: "{\"query\":\"workshop save\",\"limit\":5}",
      },
    });
    codex.__testAppendCodexToolUseEvent(toolUses, {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_123",
        output: "[{\"type\":\"text\",\"text\":\"user cancelled MCP tool call\"}]",
      },
    });

    assert.equal(toolUses.length, 1);
    assert.equal(toolUses[0].tool, "mcp__posse_gateway__atlas_symbol_search");
    assert.deepEqual(toolUses[0].input, { query: "workshop save", limit: 5 });
    assert.equal(toolUses[0].status, "cancelled");
    assert.equal(toolUses[0].error, "user cancelled MCP tool call");
  });

  it("extracts Codex built-in web-search events into provider tool replay", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const toolUse = codex.__testExtractCodexToolUse({
      type: "response_item",
      payload: {
        type: "web_search_call",
        id: "ws_123",
        action: { type: "search", query: "Codex web search docs" },
      },
    });

    assert.equal(toolUse.tool, "web_search");
    assert.deepEqual(toolUse.input, { query: "Codex web search docs" });
    assert.equal(toolUse.call_id, "ws_123");
  });

  it("treats Codex internal tool-router stderr as non-fatal UI noise", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const classified = codex.__testClassifyCodexStderrLine(
      '2026-04-12T09:17:09.164492Z ERROR codex_core::tools::router: error={"output":"","metadata":{"exit_code":1,"duration_seconds":0.7}}'
    );

    assert.equal(classified.kind, "tool_router_nonfatal");
    assert.match(classified.display || "", /agent may continue/i);
  });

  it("suppresses noisy Codex plugin and personality warnings from the live UI", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    assert.equal(
      codex.__testClassifyCodexStderrLine(
        "2026-04-12T09:15:45.742068Z  WARN codex_core::plugins::startup_sync: startup remote plugin sync failed"
      ).display,
      null
    );
    assert.equal(
      codex.__testClassifyCodexStderrLine(
        "2026-04-12T09:15:45.827637Z  WARN codex_protocol::openai_models: Model personality requested but model_messages is missing, falling back to base instructions."
      ).display,
      null
    );
  });

  it("injects Windows shell discipline for Codex jobs on PowerShell hosts", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const block = codex.__testBuildShellDisciplineBlock({ platform: "win32" });

    assert.match(block || "", /Deterministic MCP file tools are the default path/i);
    assert.match(block || "", /Canonical tool labels describe purpose only: read_file for file contents, list_files for directory traversal, search_files for content search/i);
    assert.match(block || "", /call that exact visible name, not apply_patch or a bare canonical label/i);
    assert.match(block || "", /Windows PowerShell, not bash/i);
    assert.match(block || "", /verify the file path with the manifest entry whose canonical label is read_file first/i);
    assert.match(block || "", /Do not assume repo-root-relative paths are valid/i);
    assert.match(block || "", /Do NOT use bash heredocs/i);
    assert.match(block || "", /Do NOT use bash chaining\/operators like &&/i);
    assert.match(block || "", /Do NOT use rg, grep, or findstr for routine repository search on Windows/i);
    assert.match(block || "", /@'[\s\S]*python -/i);

    const atlasFirstBlock = codex.__testBuildShellDisciplineBlock({
      platform: "win32",
      atlasAttachment: { active: true },
      atlasPrefetchStatus: "skipped",
    });
    assert.match(atlasFirstBlock || "", /ATLAS is active/i);
    assert.match(atlasFirstBlock || "", /Use ATLAS retrieval tools before deterministic file\/search tools/i);

    const atlasV2FirstBlock = codex.__testBuildShellDisciplineBlock({
      platform: "linux",
      atlasAttachment: { active: true, method: "atlas-v2" },
    });
    assert.match(atlasV2FirstBlock || "", /ATLASv2 is active/i);
    assert.match(atlasV2FirstBlock || "", /Use ATLASv2 retrieval tools before deterministic file\/search tools/i);
    assert.doesNotMatch(atlasV2FirstBlock || "", /ATLAS\/Iris/);

    const linuxBlock = codex.__testBuildShellDisciplineBlock({ platform: "linux" });
    assert.match(linuxBlock || "", /Deterministic MCP file tools are the default path/i);
    assert.doesNotMatch(linuxBlock || "", /Windows PowerShell, not bash/i);
  });

  it("adds role-specific deterministic tool guidance for Codex dev and assessor jobs", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    const devBlock = codex.__testBuildCodexRoleGuardBlock({ role: "dev", allowWrite: true });
    assert.match(devBlock || "", /Use the manifest entries whose canonical labels are write_file and edit_file for file changes/i);
    assert.match(devBlock || "", /do not report that no writable file-edit tool exists before trying the exact manifest write\/edit tool names/i);
    assert.match(devBlock || "", /manifest entries whose canonical labels are read_file, list_files, and search_files/i);
    assert.match(devBlock || "", /Do not use shell for ad-hoc repository discovery/i);

    const assessorBlock = codex.__testBuildCodexRoleGuardBlock({ role: "assessor", allowWrite: false });
    assert.match(assessorBlock || "", /Verify files with the manifest entries whose canonical labels are read_file, list_files, and search_files/i);
    assert.match(assessorBlock || "", /Use shell only for explicit verification commands/i);
  });

  it("normalizes unsupported OAuth Codex models to a verified ChatGPT-compatible model", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");

    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5-mini", "login"),
      "gpt-5.4"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5-codex", "login"),
      "gpt-5.4"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5.3-codex", "oauth"),
      "gpt-5.4"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5.4", "oauth"),
      "gpt-5.4"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5.4-mini", "oauth"),
      "gpt-5.4-mini"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5.5", "oauth"),
      "gpt-5.5"
    );
    assert.equal(
      codex.__testNormalizeModelForAuthMode("gpt-5-mini", "api_key"),
      "gpt-5-mini"
    );
  });

  it("enforces explicit Codex oauth mode without api fallback", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const oauthMissing = codex.__testResolveCodexAuthMode("oauth", false, true);
    assert.equal(oauthMissing.ok, false);
    assert.equal(oauthMissing.mode, "oauth");
    assert.match(oauthMissing.reason || "", /auth mode is oauth/i);

    const oauthOk = codex.__testResolveCodexAuthMode("oauth", true, true);
    assert.equal(oauthOk.ok, true);
    assert.equal(oauthOk.mode, "oauth");

    const autoMissingLoginWithApi = codex.__testResolveCodexAuthMode("auto", false, true);
    assert.equal(autoMissingLoginWithApi.ok, false);
    assert.equal(autoMissingLoginWithApi.mode, "oauth");
    assert.match(autoMissingLoginWithApi.reason || "", /API keys.*explicitly api/i);

    const autoOauthOk = codex.__testResolveCodexAuthMode("auto", true, true);
    assert.equal(autoOauthOk.ok, true);
    assert.equal(autoOauthOk.mode, "oauth");

    const apiMissing = codex.__testResolveCodexAuthMode("api", true, false);
    assert.equal(apiMissing.ok, false);
    assert.equal(apiMissing.mode, "api");
    assert.match(apiMissing.reason || "", /auth mode is api/i);
  });

  it("copies Codex spilled auth only for oauth mode and hardens spill files", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-codex-spill-"));
    const longOverride = `mcp_servers.posse_gateway.env.LONG="${"a".repeat(7000)}"`;
    try {
      const sourceHome = path.join(tmpRoot, "source-home");
      fs.mkdirSync(sourceHome, { recursive: true });
      fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"oauth-secret\"}\n", "utf-8");

      const apiRoute = codex.__testPrepareCodexConfigForSpawn([longOverride], {
        env: { CODEX_HOME: sourceHome },
        platform: "win32",
        tempParent: path.join(tmpRoot, "api-spills"),
        authMode: "api",
      });
      try {
        assert.equal(apiRoute.spilled, true);
        assert.deepEqual(apiRoute.configOverrides, []);
        assert.equal(fs.existsSync(path.join(apiRoute.codexHome, "config.toml")), true);
        assert.equal(fs.existsSync(path.join(apiRoute.codexHome, "auth.json")), false);
      } finally {
        apiRoute.cleanup();
      }

      const oauthRoute = codex.__testPrepareCodexConfigForSpawn([longOverride], {
        env: { CODEX_HOME: sourceHome },
        platform: "win32",
        tempParent: path.join(tmpRoot, "oauth-spills"),
        authMode: "oauth",
      });
      try {
        const configPath = path.join(oauthRoute.codexHome, "config.toml");
        const authPath = path.join(oauthRoute.codexHome, "auth.json");
        assert.equal(oauthRoute.spilled, true);
        assert.equal(fs.readFileSync(authPath, "utf-8"), "{\"token\":\"oauth-secret\"}\n");
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(oauthRoute.codexHome).mode & 0o777, 0o700);
          assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
          assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
        }
      } finally {
        oauthRoute.cleanup();
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("builds current Codex model candidates from settings, tiers, and known defaults", async () => {
    const { queueMod } = runtimeModules;
    const validator = await import("../../../lib/domains/providers/functions/helpers/codex-model-validator.js");
    queueMod.setSetting("codex_model_standard", "legacy-standard");
    queueMod.setSetting("codex_model_strong", "legacy-strong");

    const models = withEnv({
      CODEX_ORG_MODEL_CHEAP: "env-cheap",
      CODEX_ORG_MODEL_STANDARD: "env-standard",
      CODEX_ORG_MODEL_STRONG: "env-strong",
    }, () => validator.getCurrentCodexModels({ includeKnown: true }));

    assert.equal(models.includes("env-cheap"), false);
    assert.equal(models.includes("env-standard"), false);
    assert.equal(models.includes("env-strong"), false);
    assert.ok(models.includes("legacy-standard"));
    assert.ok(models.includes("legacy-strong"));
    assert.ok(models.includes("gpt-5.3-codex"));
    assert.ok(models.includes("gpt-5.4"));
    assert.ok(models.includes("gpt-5.4-mini"));
    assert.ok(models.includes("gpt-5.5"));
  });

  it("validates codex model candidates and reports pass/fail deterministically", async () => {
    const validator = await import("../../../lib/domains/providers/functions/helpers/codex-model-validator.js");
    const report = validator.validateCodexModels({
      models: ["gpt-5.3-codex", "gpt-5.4"],
      authMode: "oauth",
      probe: ({ model }) => {
        if (model === "gpt-5.3-codex") {
          return { ok: true, exitCode: 0, durationMs: 120, summary: "OK" };
        }
        return { ok: false, exitCode: 1, durationMs: 130, summary: "unsupported" };
      },
    });

    assert.deepEqual(report.passed, ["gpt-5.3-codex"]);
    assert.deepEqual(report.failed, ["gpt-5.4"]);
    assert.equal(report.results.length, 2);
    const rendered = validator.formatCodexModelValidationReport(report);
    assert.match(rendered, /\[PASS\] gpt-5\.3-codex/);
    assert.match(rendered, /\[FAIL\] gpt-5\.4/);
  });

  it("strips API keys in oauth validation mode but keeps them in api mode", async () => {
    const validator = await import("../../../lib/domains/providers/functions/helpers/codex-model-validator.js");
    const oauthEnv = validator.__testBuildValidationEnv("oauth", {
      CODEX_API_KEY: "secret",
      OPENAI_API_KEY: "secret2",
      KEEP_ME: "yes",
    });
    assert.equal("CODEX_API_KEY" in oauthEnv, false);
    assert.equal("OPENAI_API_KEY" in oauthEnv, false);
    assert.equal(oauthEnv.KEEP_ME, "yes");

    const apiEnv = validator.__testBuildValidationEnv("api", {
      CODEX_API_KEY: "secret",
      OPENAI_API_KEY: "secret2",
    });
    assert.equal(apiEnv.CODEX_API_KEY, "secret");
    assert.equal(apiEnv.OPENAI_API_KEY, "secret2");
  });

  it("classifies current OpenAI GPT-5 models as reasoning-capable", async () => {
    const openai = await import("../../../lib/domains/providers/functions/openai.js");

    assert.equal(openai.__testIsReasoningModelName("gpt-5.4"), true);
    assert.equal(openai.__testIsReasoningModelName("gpt-5-codex"), true);
    assert.equal(openai.__testIsReasoningModelName("o3-mini"), true);
    assert.equal(openai.__testIsReasoningModelName("o10-mini"), true);
    assert.equal(openai.__testIsReasoningModelName("gpt-4o"), false);
  });

  it("does not build a direct Claude ATLAS payload when v2 is disabled", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-atlas-disabled-"));
    const repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      const resolved = await withQueueSettings({
        atlas_mode: "on",
        atlas_v2: "off",
        atlas_phases: "research",
        atlas_live_funnel: "true",
        atlas_repo_id: "repo",
        atlas_repo_path: repoPath,
      }, () => claudeMod.__testBuildClaudeAtlasMcpConfigPayload("researcher", repoPath));

      assert.equal(resolved.attachment.active, false);
      assert.equal(resolved.attachment.backend, "atlas-v2");
      assert.equal(resolved.payload, null);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps Claude ATLAS v2 active without a direct ATLAS payload", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-atlas-v2-mcp-"));
    const repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      const resolved = await withQueueSettings({
        atlas_mode: "off",
        atlas_v2: "v2",
        atlas_phases: "research",
        atlas_live_funnel: "true",
        atlas_repo_id: "repo",
        atlas_repo_path: repoPath,
      }, () => withEnv({
        POSSE_ATLAS_MODE: null,
        POSSE_ATLAS_V2: null,
      }, () => claudeMod.__testBuildClaudeAtlasMcpConfigPayload("researcher", repoPath)));

      assert.equal(resolved.attachment.active, true);
      assert.equal(resolved.attachment.method, "atlas-v2");
      assert.equal(resolved.attachment.backend, "atlas-v2");
      assert.equal(resolved.attachment.transport, "mcp-gateway");
      assert.ok(resolved.attachment.tools.length >= 20);
      assert.equal(resolved.attachment.tools.includes("file.read"), false);
      assert.equal(resolved.attachment.tools.includes("info"), true);
      assert.equal(resolved.attachment.tools.includes("manual"), false);
      assert.equal(resolved.attachment.tools.includes("memory.query"), true);
      assert.equal(resolved.payload, null);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("treats gateway ATLAS attachments as provider-visible Atlas tools", async () => {
    const { hasProviderVisibleAtlasMcpTools } = await import("../../../lib/domains/providers/functions/helpers/atlas-mcp.js");

    assert.equal(hasProviderVisibleAtlasMcpTools({
      atlasAttachment: { active: true, transport: "mcp-gateway" },
      atlasPrefetchStatus: "ok_relevant",
    }), true);
    assert.equal(hasProviderVisibleAtlasMcpTools({
      atlasAttachment: { active: true, transport: "mcp-gateway" },
      atlasPrefetchStatus: "failed",
    }), false);
    assert.equal(hasProviderVisibleAtlasMcpTools({
      atlasAttachment: { active: true, transport: "none" },
      atlasPrefetchStatus: "ok_relevant",
    }), false);
  });

  it("does not build direct Codex ATLAS config overrides for native v2", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-codex-atlas-v2-"));
    const repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      const resolved = await withQueueSettings({
        atlas_mode: "off",
        atlas_v2: "on",
        atlas_phases: "research",
        atlas_live_funnel: "true",
        atlas_repo_id: "repo",
        atlas_repo_path: repoPath,
      }, () => codex.__testBuildCodexAtlasConfigOverrides("researcher", repoPath));

      assert.equal(resolved.attachment.active, true);
      assert.equal(resolved.attachment.transport, "mcp-gateway");
      assert.deepEqual(resolved.configOverrides, []);
      assert.equal(resolved.serverConfig, null);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("builds a shared execution contract block for Claude dev scope", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "dev",
      allowWrite: true,
      scopedFiles: ["htdocs/app.js"],
      createFiles: ["htdocs/new.js"],
      createRoots: ["assets/generated"],
      fallbackReads: 3,
    });
    const block = contractMod.renderExecutionContractBlock(contract);

    assert.match(block, /EXECUTION CONTRACT:/);
    assert.match(block, /Provider: claude/);
    assert.match(block, /Fallback read budget: 3/);
    assert.match(block, /read_file \[read\]/);
    assert.match(block, /edit_file \[write\]/);
    assert.match(block, /bash \[shell\]/);
  });

  it("keeps assessor on read-only deterministic and test tools in the shared contract", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const names = contractMod.__testGetBaseToolNamesForRole("assessor", false, {});

    assert.deepEqual(names, [
      "read_file",
      "list_files",
      "search_files",
      "git_history",
      "inspect_file",
      "hash_file",
      "run_scoped_checks",
      "create_test_suite",
      "create_test",
      "run_test",
      "run_test_suite",
      "bash",
    ]);
  });

  it("extends the shared execution contract with ATLAS tools for embedded providers", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const openai = await import("../../../lib/domains/providers/functions/openai.js");
    const grok = await import("../../../lib/domains/providers/functions/grok.js");
    const base = contractMod.buildExecutionContract({
      provider: "openai",
      role: "researcher",
      allowWrite: false,
    });
    const extended = contractMod.appendExecutionTools(base, ["symbol.search", "slice.build", "context"]);
    const block = contractMod.renderExecutionContractBlock(extended);

    assert.deepEqual(extended.tools.map((tool) => tool.name), ["chain_read", "chain_verdict", "list_files", "search_files", "git_history", "inspect_file", "hash_file", "symbol.search", "slice.build", "context"]);
    assert.match(block, /Name rule: call the exact Available tools name/i);
    assert.match(block, /atlas_symbol_search \(canonical: symbol\.search\) \[atlas\]/);
    assert.match(block, /atlas_slice_build \(canonical: slice\.build\) \[atlas\]/);
    assert.match(block, /atlas_context \(canonical: context\) \[atlas\]/);

    for (const provider of [openai, grok]) {
      const providerNames = provider.__testGetToolsForRole(extended)
        .map((tool) => tool?.function?.name || tool?.name)
        .filter(Boolean);
      assert.ok(providerNames.includes("atlas_symbol_search"));
      assert.equal(providerNames.includes("symbol.search"), false);
    }
  });

  it("renders MCP ATLAS execution contract names consistently for Claude and Codex", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    for (const provider of ["claude", "codex"]) {
      const base = contractMod.buildExecutionContract({
        provider,
        role: "researcher",
        allowWrite: false,
      });
      const extended = contractMod.appendExecutionTools(base, ["symbol.search", "context"]);
      const block = contractMod.renderExecutionContractBlock(extended);

      assert.match(block, /Name rule: call the exact Available tools name/i);
      assert.match(block, /atlas\.symbol\.search \(canonical: symbol\.search\) \[atlas\]/);
      assert.match(block, /atlas\.context \(canonical: context\) \[atlas\]/);
      assert.doesNotMatch(block, /atlas_symbol_search \[atlas\]/);
      assert.doesNotMatch(block, /atlas_context \[atlas\]/);
    }
  });

  it("adapts shared deterministic contracts to codex-native tool names", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const base = contractMod.buildExecutionContract({
      provider: "codex",
      role: "assessor",
      allowWrite: false,
    });
    const codexContract = contractMod.adaptExecutionContractForProvider(base, "codex");
    const names = codexContract.tools.map((tool) => tool.name);
    const block = contractMod.renderExecutionContractBlock(codexContract);

    assert.deepEqual(names, [
      "read_file",
      "list_files",
      "search_files",
      "git_history",
      "inspect_file",
      "hash_file",
      "run_scoped_checks",
      "create_test_suite",
      "create_test",
      "run_test",
      "run_test_suite",
      "bash",
    ]);
    assert.match(block, /read_file \[read\]/);
    assert.match(block, /list_files \[read\]/);
    assert.match(block, /search_files \[read\]/);
    assert.match(block, /bash \[shell\]/);
  });

  it("derives Claude CLI tool grants from the shared contract", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "dev",
      allowWrite: true,
      scopedFiles: ["htdocs/app.js"],
      createFiles: [],
      createRoots: ["assets/generated"],
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      scopedFiles: ["htdocs/app.js"],
      createFiles: [],
      createRoots: ["assets/generated"],
    });

    assert.equal(cli.tools, "Bash,Read,Write,Edit,Glob,Grep");
    assert.match(cli.allowedTools || "", /Write\(htdocs\/app\.js\)/);
    assert.match(cli.allowedTools || "", /Edit\(htdocs\/app\.js\)/);
    assert.match(cli.allowedTools || "", /Write\(assets\/generated\/\*\)/);
  });

  it("enables non-interactive Claude ATLAS tool use for researcher/planner roles", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const base = contractMod.buildExecutionContract({
      provider: "claude",
      role: "researcher",
      allowWrite: false,
    });
    const extended = contractMod.appendExecutionTools(base, ["symbol.search", "slice.build", "context"]);
    const cli = contractMod.buildClaudeCliToolConfig(extended, {
      autoApprove: false,
      scopedFiles: [],
      createFiles: [],
      createRoots: [],
      webToolsEnabled: false,
    });

    assert.equal(cli.tools, "Read,Glob,Grep");
    assert.doesNotMatch(cli.tools || "", /(?:^|,)Task(?:,|$)/);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("gates WebFetch/WebSearch to researcher and artificer when the toggle is on", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");

    // Dev never gets web tools, even when the toggle is on.
    const devContract = contractMod.buildExecutionContract({ provider: "claude", role: "dev", allowWrite: true });
    const devCli = contractMod.buildClaudeCliToolConfig(devContract, {
      autoApprove: false,
      scopedFiles: ["src/app.js"],
      webToolsEnabled: true,
    });
    assert.equal(devCli.tools, "Bash,Read,Write,Edit,Glob,Grep");
    assert.doesNotMatch(devCli.allowedTools || "", /WebFetch/);
    assert.doesNotMatch(devCli.allowedTools || "", /WebSearch/);

    // Artificer gets only web system tools; file/image work stays on deterministic MCP.
    const artificerContract = contractMod.buildExecutionContract({ provider: "claude", role: "artificer", allowWrite: true });
    const artificerCli = contractMod.buildClaudeCliToolConfig(artificerContract, {
      autoApprove: false,
      createRoots: ["resources/artifacts/wi-1"],
      webToolsEnabled: true,
    });
    assert.equal(artificerCli.tools, "WebFetch,WebSearch");
    assert.match(artificerCli.disallowedTools || "", /Read/);
    assert.match(artificerCli.disallowedTools || "", /Write/);
    assert.doesNotMatch(artificerCli.disallowedTools || "", /WebFetch/);

    // Planner gets no tools regardless of the toggle.
    const plannerContract = contractMod.buildExecutionContract({ provider: "claude", role: "planner", allowWrite: false });
    const plannerCli = contractMod.buildClaudeCliToolConfig(plannerContract, {
      autoApprove: false,
      webToolsEnabled: true,
    });
    assert.equal(plannerCli.tools, "");

    // Assessor does not get web tools.
    const assessorContract = contractMod.buildExecutionContract({ provider: "claude", role: "assessor", allowWrite: false });
    const assessorCli = contractMod.buildClaudeCliToolConfig(assessorContract, {
      autoApprove: false,
      webToolsEnabled: true,
    });
    assert.equal(assessorCli.tools, "Read,Glob,Grep,Bash");
    assert.doesNotMatch(assessorCli.allowedTools || "", /WebFetch/);

    const assessorStrict = contractMod.buildClaudeCliToolConfig(assessorContract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      webToolsEnabled: true,
    });
    assert.equal(assessorStrict.tools, null);
    assert.match(assessorStrict.disallowedTools || "", /WebFetch/);
    assert.match(assessorStrict.disallowedTools || "", /WebSearch/);

    // Researcher still gets web tools, but not Claude's native subagent tool.
    const researcherContract = contractMod.buildExecutionContract({ provider: "claude", role: "researcher", allowWrite: false });
    const researcherCli = contractMod.buildClaudeCliToolConfig(researcherContract, {
      autoApprove: false,
      webToolsEnabled: true,
    });
    assert.equal(researcherCli.tools, "WebFetch,WebSearch");
    assert.match(researcherCli.disallowedTools || "", /(?:^|,)Task(?:,|$)/);

    const synthResearcherContract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "researcher",
      roleMode: "synth",
      allowWrite: false,
    });
    const synthResearcherCli = contractMod.buildClaudeCliToolConfig(synthResearcherContract, {
      autoApprove: false,
      webToolsEnabled: true,
    });
    assert.equal(synthResearcherCli.tools, "");
    assert.doesNotMatch(synthResearcherCli.tools || "", /WebFetch|WebSearch/);

    // Dev under deterministic MCP must still disallow WebFetch/WebSearch.
    const devStrict = contractMod.buildClaudeCliToolConfig(devContract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      webToolsEnabled: true,
    });
    assert.match(devStrict.disallowedTools || "", /WebFetch/);
    assert.match(devStrict.disallowedTools || "", /WebSearch/);
  });

  it("omits WebFetch/WebSearch when the web_tools_enabled toggle is off", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const devContract = contractMod.buildExecutionContract({ provider: "claude", role: "dev", allowWrite: true });
    const devCli = contractMod.buildClaudeCliToolConfig(devContract, {
      autoApprove: false,
      scopedFiles: ["src/app.js"],
      webToolsEnabled: false,
    });
    assert.equal(devCli.tools, "Bash,Read,Write,Edit,Glob,Grep");
    assert.doesNotMatch(devCli.allowedTools || "", /WebFetch/);

    const researcherContract = contractMod.buildExecutionContract({ provider: "claude", role: "researcher", allowWrite: false });
    const researcherCli = contractMod.buildClaudeCliToolConfig(researcherContract, {
      autoApprove: false,
      webToolsEnabled: false,
    });
    assert.equal(researcherCli.tools, "");
  });

  it("builds deterministic MCP overrides for codex read-tool roles", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const resolved = codex.__testBuildCodexDeterministicReadConfigOverrides("assessor", process.cwd(), {
      scopedFiles: ["src/app.js"],
      createFiles: [],
      createRoots: [],
    });
    assert.equal(resolved.active, true);
    assert.ok((resolved.configOverrides || []).some((entry) => /mcp_servers\.posse_gateway/.test(entry)));
    const bootConfig = codexDeterministicBootConfig(resolved);
    assert.equal(bootConfig.cwd, process.cwd());
    assert.equal(bootConfig.providerName, "codex");
    assert.ok((resolved.contractTools || []).some((tool) => (
      tool.name === "read_file" && tool.surfaceName === "mcp__posse_gateway__tools_read_file" && tool.suite === "tools"
    )));

    let contract = contractMod.buildExecutionContract({
      provider: "codex",
      role: "assessor",
      allowWrite: false,
      includeBaseTools: false,
    });
    contract = contractMod.appendExecutionTools(contract, resolved.contractTools);
    contract = contractMod.adaptExecutionContractForProvider(contract, "codex");
    const block = contractMod.renderExecutionContractBlock(contract);

    assert.match(block, /Name rule: call the exact Available tools name/i);
    assert.match(block, /mcp__posse_gateway__tools_read_file \(canonical: read_file\) \[tools\/read\]/);
    assert.match(block, /mcp__posse_gateway__tools_run_scoped_checks \(canonical: run_scoped_checks\) \[tools\/shell\]/);
    assert.doesNotMatch(block, /  - read_file \[read\]/);
  });

  it("includes image and move tools in deterministic MCP for codex write roles", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const resolved = codex.__testBuildCodexDeterministicReadConfigOverrides("dev", process.cwd(), {
      scopedFiles: ["src/app.js"],
      createFiles: ["assets/out.png"],
      createRoots: ["assets/generated"],
    });
    assert.equal(resolved.active, true);
    assert.ok((resolved.tools || []).includes("write_file"));
    assert.ok((resolved.tools || []).includes("copy_file"));
    assert.ok((resolved.tools || []).includes("make_dir"));
    assert.ok((resolved.tools || []).includes("read_image_metadata"));
    assert.ok((resolved.tools || []).includes("clean_image"));
    assert.equal((resolved.tools || []).includes("resize_image"), false);
    assert.equal((resolved.tools || []).includes("optimize_image"), false);
    assert.equal((resolved.tools || []).includes("reencode_image"), false);
    assert.ok((resolved.tools || []).includes("move_file"));
    const bootConfig = codexDeterministicBootConfig(resolved);
    assert.equal(bootConfig.allowWrite, true);
    assert.equal(bootConfig.allowImageHelpers, true);
    assert.equal(bootConfig.allowImageGeneration, false);

    let contract = contractMod.buildExecutionContract({
      provider: "codex",
      role: "dev",
      allowWrite: true,
      includeBaseTools: false,
    });
    contract = contractMod.appendExecutionTools(contract, resolved.contractTools);
    contract = contractMod.adaptExecutionContractForProvider(contract, "codex");
    const block = contractMod.renderExecutionContractBlock(contract);

    assert.match(block, /mcp__posse_gateway__tools_read_file \(canonical: read_file\) \[tools\/read\]/);
    assert.match(block, /mcp__posse_gateway__tools_edit_file \(canonical: edit_file\) \[tools\/write\]/);
    assert.match(block, /mcp__posse_gateway__tools_write_file \(canonical: write_file\) \[tools\/write\]/);
    assert.match(block, /mcp__posse_gateway__tools_bash \(canonical: bash\) \[tools\/shell\]/);
    assert.doesNotMatch(block, /  - edit_file \[write\]/);
  });

  it("includes generate_image in deterministic MCP for codex artificer roles", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const resolved = withEnv({
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
      CODEX_API_KEY: "codex-secret",
      GITHUB_TOKEN: "github-secret",
    }, () => codex.__testBuildCodexDeterministicReadConfigOverrides("artificer", process.cwd(), {
        scopedFiles: ["src/app.js"],
        createFiles: ["assets/out.png"],
        createRoots: ["assets/generated"],
        needsImageGeneration: true,
      }));
    assert.equal(resolved.active, true);
    assert.ok((resolved.tools || []).includes("read_image_metadata"));
    assert.ok((resolved.tools || []).includes("clean_image"));
    assert.ok((resolved.tools || []).includes("generate_image"));
    const bootConfig = codexDeterministicBootConfig(resolved);
    assert.equal(bootConfig.allowImageHelpers, true);
    assert.equal(bootConfig.allowImageGeneration, true);
    assert.ok((resolved.configOverrides || []).some((entry) => /mcp_servers\.posse_gateway\.env\.OPENAI_API_KEY=\"openai-secret\"/.test(entry)));
    assert.ok((resolved.configOverrides || []).some((entry) => /mcp_servers\.posse_gateway\.env\.XAI_API_KEY=\"xai-secret\"/.test(entry)));
    assert.equal((resolved.configOverrides || []).some((entry) => /CODEX_API_KEY/.test(entry)), false);
    assert.equal((resolved.configOverrides || []).some((entry) => /GITHUB_TOKEN/.test(entry)), false);
  });

  it("passes provider and strict-mode env flags into codex deterministic MCP config", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const resolved = codex.__testBuildCodexDeterministicReadConfigOverrides("assessor", process.cwd(), {
      scopedFiles: ["src/app.js"],
      createFiles: [],
      createRoots: [],
      disableSystemTools: true,
    });
    assert.equal(resolved.active, true);
    const bootConfig = codexDeterministicBootConfig(resolved);
    assert.equal(bootConfig.providerName, "codex");
    assert.equal(bootConfig.disableSystemTools, true);
  });

  it("keeps generate_image disabled for codex artificer roles without image intent", async () => {
    const codex = await import("../../../lib/domains/providers/functions/codex.js");
    const resolved = withEnv({
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
    }, () => codex.__testBuildCodexDeterministicReadConfigOverrides("artificer", process.cwd(), {
        scopedFiles: ["src/app.js"],
        createFiles: ["assets/out.png"],
        createRoots: ["assets/generated"],
        needsImageGeneration: false,
      }));
    assert.equal(resolved.active, true);
    assert.ok((resolved.tools || []).includes("read_image_metadata"));
    assert.ok((resolved.tools || []).includes("clean_image"));
    assert.equal((resolved.tools || []).includes("generate_image"), false);
    const bootConfig = codexDeterministicBootConfig(resolved);
    assert.equal(bootConfig.allowImageHelpers, true);
    assert.equal(bootConfig.allowImageGeneration, false);
    assert.equal((resolved.configOverrides || []).some((entry) => /OPENAI_API_KEY/.test(entry)), false);
    assert.equal((resolved.configOverrides || []).some((entry) => /XAI_API_KEY/.test(entry)), false);
  });

  it("builds deterministic MCP payload for claude read-tool roles", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const payload = claudeMod.__testBuildClaudeDeterministicReadMcpConfigPayload("assessor", process.cwd(), {
      scopedFiles: ["src/app.js"],
      createFiles: [],
      createRoots: [],
    });
    assert.equal(payload.active, true);
    assert.ok(payload.payload?.mcpServers?.["posse-gateway"]);
    assert.equal(payload.payload.mcpServers["posse-gateway"].command, process.execPath);
    assert.ok((payload.contractTools || []).some((tool) => (
      tool.canonicalName === "read_file"
      && tool.mcpName === "tools.read_file"
      && tool.providerSurfaceName === "mcp__posse-gateway__tools_read_file"
      && tool.surfaceName === tool.providerSurfaceName
      && tool.suite === "tools"
    )));
  });

  it("includes image and move tools in deterministic MCP for claude write roles", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const payload = withEnv({
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
      CODEX_API_KEY: "codex-secret",
      GITHUB_TOKEN: "github-secret",
    }, () => claudeMod.__testBuildClaudeDeterministicReadMcpConfigPayload("artificer", process.cwd(), {
        scopedFiles: ["src/app.js"],
        createFiles: ["assets/out.png"],
        createRoots: ["assets/generated"],
        needsImageGeneration: true,
      }));
    assert.equal(payload.active, true);
    assert.ok((payload.tools || []).includes("write_file"));
    assert.ok((payload.tools || []).includes("copy_file"));
    assert.ok((payload.tools || []).includes("make_dir"));
    assert.ok((payload.tools || []).includes("move_file"));
    assert.ok((payload.tools || []).includes("read_image_metadata"));
    assert.ok((payload.tools || []).includes("clean_image"));
    assert.ok((payload.tools || []).includes("generate_image"));
    assert.ok((payload.contractTools || []).some((tool) => (
      tool.canonicalName === "generate_image"
      && tool.mcpName === "tools.generate_image"
      && tool.providerSurfaceName === "mcp__posse-gateway__tools_generate_image"
      && tool.surfaceName === tool.providerSurfaceName
      && tool.suite === "tools"
    )));
    assert.equal((payload.contractTools || []).some((tool) => (
      tool.canonicalName === "generate_image" && /tools\.generate_image/.test(tool.providerSurfaceName)
    )), false);
    const bootConfig = claudeDeterministicBootConfig(payload);
    const env = claudeDeterministicServer(payload)?.env || {};
    assert.equal(bootConfig.allowWrite, true);
    assert.equal(bootConfig.allowImageHelpers, true);
    assert.equal(bootConfig.allowImageGeneration, true);
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
    assert.equal(env.XAI_API_KEY, "xai-secret");
    assert.equal("CODEX_API_KEY" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
  });

  it("keeps image provider keys out of claude deterministic MCP when generate_image is disabled", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const payload = withEnv({
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
    }, () => claudeMod.__testBuildClaudeDeterministicReadMcpConfigPayload("artificer", process.cwd(), {
        scopedFiles: ["src/app.js"],
        createFiles: ["assets/out.png"],
        createRoots: ["assets/generated"],
        needsImageGeneration: false,
      }));
    const env = payload.payload?.mcpServers?.["posse-gateway"]?.env || {};
    const bootConfig = claudeDeterministicBootConfig(payload);
    assert.equal(payload.active, true);
    assert.equal((payload.tools || []).includes("generate_image"), false);
    assert.equal(bootConfig.allowImageGeneration, false);
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("XAI_API_KEY" in env, false);
  });

  it("disallows claude native read and bash tools when deterministic MCP is active for assessor", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "assessor",
      allowWrite: false,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
    });
    assert.match(cli.disallowedTools || "", /Read/);
    assert.match(cli.disallowedTools || "", /Glob/);
    assert.match(cli.disallowedTools || "", /Grep/);
    assert.match(cli.disallowedTools || "", /Bash/);
    assert.match(cli.disallowedTools || "", /Write/);
    assert.match(cli.disallowedTools || "", /Edit/);
    assert.match(cli.disallowedTools || "", /WebFetch/);
    assert.match(cli.disallowedTools || "", /WebSearch/);
    assert.match(cli.disallowedTools || "", /NotebookEdit/);
    assert.match(cli.disallowedTools || "", /Task/);
    assert.match(cli.disallowedTools || "", /TodoWrite/);
    assert.match(cli.disallowedTools || "", /ToolSearch/);
    assert.match(cli.disallowedTools || "", /AskUserQuestion/);
    assert.match(cli.disallowedTools || "", /EnterWorktree/);
    assert.equal(cli.tools, null);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("disallows claude Task tool for researcher in strict deterministic MCP mode", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "researcher",
      allowWrite: false,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      disableSystemTools: true,
    });
    assert.equal(cli.tools, null);
    assert.match(cli.disallowedTools || "", /(?:^|,)Task(?:,|$)/);
    assert.match(cli.disallowedTools || "", /TaskStop/);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("keeps researcher web-tool mode web-only and disallows native Task", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "researcher",
      allowWrite: false,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: false,
      disableSystemTools: false,
      webToolsEnabled: true,
    });
    assert.equal(cli.tools, "WebFetch,WebSearch");
    assert.match(cli.disallowedTools || "", /(?:^|,)Task(?:,|$)/);
  });

  it("disallows all claude native tools when deterministic MCP is active for dev", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "dev",
      allowWrite: true,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      scopedFiles: ["src/app.js"],
    });
    assert.equal(cli.tools, null);
    assert.match(cli.disallowedTools || "", /Write/);
    assert.match(cli.disallowedTools || "", /Edit/);
    assert.match(cli.disallowedTools || "", /Bash/);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("disallows claude native write and bash tools when deterministic MCP is active for artificer", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "artificer",
      allowWrite: true,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      createRoots: ["assets/generated"],
    });
    assert.equal(cli.tools, null);
    assert.match(cli.disallowedTools || "", /Write/);
    assert.match(cli.disallowedTools || "", /Bash/);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("supports strict deterministic MCP mode by disabling all claude native tools", async () => {
    const contractMod = await import("../../../lib/functions/tools/contract.js");
    const contract = contractMod.buildExecutionContract({
      provider: "claude",
      role: "dev",
      allowWrite: true,
    });
    const cli = contractMod.buildClaudeCliToolConfig(contract, {
      autoApprove: false,
      deterministicReadMcpActive: true,
      disableSystemTools: true,
    });
    assert.equal(cli.tools, null);
    assert.match(cli.disallowedTools || "", /Read,Glob,Grep,Write,Edit,Bash/);
    assert.match(cli.disallowedTools || "", /ToolSearch/);
    assert.match(cli.disallowedTools || "", /TaskStop/);
    assert.equal(cli.dangerouslySkipPermissions, true);
  });

  it("passes provider and strict-mode env flags into deterministic MCP config", async () => {
    const claudeMod = await import("../../../lib/domains/providers/functions/claude.js");
    const payload = claudeMod.__testBuildClaudeDeterministicReadMcpConfigPayload("assessor", process.cwd(), {
      scopedFiles: ["src/app.js"],
      createFiles: [],
      createRoots: [],
      disableSystemTools: true,
    });
    assert.equal(payload.active, true);
    const bootConfig = claudeDeterministicBootConfig(payload);
    assert.equal(bootConfig.providerName, "claude");
    assert.equal(bootConfig.disableSystemTools, true);
  });

  it("includes edit_file and bash in deterministic MCP tool names for dev role", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const tools = mcpMod.getDeterministicMcpToolNames("dev");
    assert.ok(tools.includes("edit_file"), "dev role should include edit_file");
    assert.ok(tools.includes("bash"), "dev role should include bash");
    assert.ok(tools.includes("write_file"), "dev role should include write_file");
    assert.ok(tools.includes("read_file"), "dev role should include read_file");
    assert.ok(tools.includes("git_history"), "dev role should include git_history");
  });

  it("includes bash but not write tools in deterministic MCP tool names for assessor role", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const tools = mcpMod.getDeterministicMcpToolNames("assessor");
    assert.ok(tools.includes("bash"), "assessor role should include bash");
    assert.ok(tools.includes("read_file"), "assessor role should include read_file");
    assert.ok(tools.includes("git_history"), "assessor role should include git_history");
    assert.equal(tools.includes("write_file"), false, "assessor role should not include write_file");
    assert.equal(tools.includes("edit_file"), false, "assessor role should not include edit_file");
  });

  it("includes bash in deterministic MCP tool names for artificer role", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const tools = mcpMod.getDeterministicMcpToolNames("artificer");
    assert.ok(tools.includes("bash"), "artificer role should include bash");
    assert.ok(tools.includes("write_file"), "artificer role should include write_file");
    assert.ok(tools.includes("edit_file"), "artificer role should include edit_file");
  });

  it("researcher gets chain_read/chain_verdict while planner gets read-only deterministic tools", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const researcherTools = mcpMod.getDeterministicMcpToolNames("researcher");
    assert.ok(researcherTools.includes("chain_read"), "researcher should include chain_read");
    assert.ok(researcherTools.includes("chain_verdict"), "researcher should include chain_verdict");
    assert.equal(researcherTools.includes("read_file"), false, "researcher should not include plain read_file");
    assert.equal(researcherTools.includes("bash"), false, "researcher should not include bash");
    assert.equal(researcherTools.includes("write_file"), false, "researcher should not include write_file");
    const plannerTools = mcpMod.getDeterministicMcpToolNames("planner");
    assert.ok(plannerTools.includes("read_file"), "planner should include read_file");
    assert.ok(plannerTools.includes("list_files"), "planner should include list_files");
    assert.ok(plannerTools.includes("search_files"), "planner should include search_files");
    assert.equal(plannerTools.includes("chain_read"), false, "planner should not include chain_read");
    assert.equal(plannerTools.includes("write_file"), false, "planner should not include write_file");
    assert.equal(plannerTools.includes("bash"), false, "planner should not include bash");
  });

});
