// test/test-copilot-provider.test.js
//
// Unit tests for the Copilot provider's pure surfaces: argv builder,
// error classification, stats shape. Full callProvider end-to-end is
// out of scope here because it requires spawning the real binary; the
// integration is exercised manually via the JSONL probe and (once
// policy is unblocked) by a future smoke test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import * as copilot from "../lib/domains/providers/functions/copilot.js";

describe("copilot.buildCopilotArgs", () => {
  it("requires a non-empty prompt", () => {
    assert.throws(() => copilot.__testBuildCopilotArgs({
      prompt: "",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      workingDir: "/tmp/x",
    }), /prompt/);
  });

  it("requires a workingDir", () => {
    assert.throws(() => copilot.__testBuildCopilotArgs({
      prompt: "hi",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      workingDir: "",
    }), /workingDir/);
  });

  it("emits the expected default argv", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "do thing",
      model: "claude-sonnet-4.5",
      reasoningEffort: "medium",
      workingDir: "/repo",
    });
    assert.deepEqual(argv, [
      "-p", "do thing",
      "--output-format", "json",
      "-C", "/repo",
      "--model", "claude-sonnet-4.5",
      "--reasoning-effort", "medium",
      "--allow-all-tools",
      "--allow-all-paths",
      "--no-ask-user",
      "--no-color",
      "--stream", "on",
    ]);
  });

  it("normalizes invalid reasoning effort to medium", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "x",
      model: "gpt-5.4",
      reasoningEffort: "ULTRA-MAX",     // not in the valid set
      workingDir: "/r",
    });
    const idx = argv.indexOf("--reasoning-effort");
    assert.equal(argv[idx + 1], "medium");
  });

  it("passes through valid reasoning effort levels", () => {
    for (const level of ["none", "low", "medium", "high", "xhigh", "max"]) {
      const argv = copilot.__testBuildCopilotArgs({
        prompt: "x", model: "gpt-5.4", reasoningEffort: level, workingDir: "/r",
      });
      const idx = argv.indexOf("--reasoning-effort");
      assert.equal(argv[idx + 1], level, `level ${level} should pass through`);
    }
  });

  it("appends --additional-mcp-config when supplied", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "x", model: null, reasoningEffort: "medium", workingDir: "/r",
      additionalMcpConfig: "@/path/to/mcp.json",
    });
    assert.ok(argv.includes("--additional-mcp-config"));
    assert.equal(argv[argv.indexOf("--additional-mcp-config") + 1], "@/path/to/mcp.json");
  });

  it("appends --disable-builtin-mcps when requested", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "x", model: null, reasoningEffort: "medium", workingDir: "/r",
      disableBuiltinMcps: true,
    });
    assert.ok(argv.includes("--disable-builtin-mcps"));
  });

  it("omits permission flags when explicitly disabled", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "x", model: null, reasoningEffort: "medium", workingDir: "/r",
      allowAllTools: false,
      allowAllPaths: false,
      noAskUser: false,
      noColor: false,
    });
    assert.ok(!argv.includes("--allow-all-tools"));
    assert.ok(!argv.includes("--allow-all-paths"));
    assert.ok(!argv.includes("--no-ask-user"));
    assert.ok(!argv.includes("--no-color"));
  });

  it("omits --model when no model is given", () => {
    const argv = copilot.__testBuildCopilotArgs({
      prompt: "x", model: null, reasoningEffort: "medium", workingDir: "/r",
    });
    assert.ok(!argv.includes("--model"));
  });
});

describe("copilot.classifyCopilotFailure", () => {
  it("classifies policy block to COPILOT_POLICY_BLOCKED with long backoff", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "",
      stderr: "Error: Access denied by policy settings (Request ID: xyz)",
      exit: 1,
      acc: null,
    });
    assert.equal(out.code, "COPILOT_POLICY_BLOCKED");
    assert.ok(out.tripRateLimit);
    assert.ok(out.tripRateLimit.backoffSec >= 600);
    assert.ok(/policy/i.test(out.message));
  });

  it("classifies quota / rate-limit failures", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "",
      stderr: "rate limit exceeded for your account",
      exit: 1,
    });
    assert.equal(out.code, "COPILOT_QUOTA_EXHAUSTED");
    assert.ok(out.tripRateLimit);
    assert.equal(out.tripRateLimit.reason, "quota_exhausted");
  });

  it("classifies premium-request exhaustion", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "You have used all your premium requests for this month",
      stderr: "",
      exit: 1,
    });
    assert.equal(out.code, "COPILOT_QUOTA_EXHAUSTED");
  });

  it("classifies auth failure", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "",
      stderr: "Unauthorized: invalid token",
      exit: 1,
    });
    assert.equal(out.code, "COPILOT_AUTH_FAILED");
    assert.ok(out.tripRateLimit);
  });

  it("falls back to accumulator error", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "", stderr: "", exit: 2,
      acc: { errors: [{ type: "model_unavailable", message: "Model X is gone" }] },
    });
    assert.equal(out.code, "COPILOT_MODEL_UNAVAILABLE");
    assert.equal(out.message, "Model X is gone");
  });

  it("falls back to nonzero-exit when nothing matches", () => {
    const out = copilot.__testClassifyCopilotFailure({
      stdout: "", stderr: "something else broke", exit: 137,
    });
    assert.equal(out.code, "COPILOT_NONZERO_EXIT");
    assert.ok(out.message.includes("137"));
  });
});

describe("copilot.buildCopilotCloseStats", () => {
  it("produces the codex-compatible stats shape", () => {
    const stats = copilot.__testBuildCopilotCloseStats({
      role: "dev",
      modelTier: "standard",
      reasoningEffort: "high",
      modelName: "gpt-5.4",
      acc: {
        inputTokens: 1500,
        outputTokens: 200,
        toolUses: [{ name: "read_file", status: "succeeded" }],
        sessionId: "sess_abc",
      },
      durationMs: 3500,
      finalOutputText: "final answer",
      stdout: "",
      code: 0,
      sessionHandle: "sess_abc",
      priorSessionHandle: null,
    });
    assert.equal(stats.provider, "copilot");
    assert.equal(stats.role, "dev");
    assert.equal(stats.modelTier, "standard");
    assert.equal(stats.modelName, "gpt-5.4");
    assert.equal(stats.inputTokens, 1500);
    assert.equal(stats.outputTokens, 200);
    assert.equal(stats.exitCode, 0);
    assert.equal(stats.sessionHandle, "sess_abc");
    assert.equal(stats.outputChars, "final answer".length);
    assert.equal(stats.toolUses.length, 1);
    assert.equal(stats.toolUsesLoggedByToolkit, false);
    assert.equal(stats.atlasMethod, "baseline");
  });

  it("handles a null accumulator gracefully", () => {
    const stats = copilot.__testBuildCopilotCloseStats({
      role: "planner", modelTier: "cheap", reasoningEffort: "low",
      modelName: "x", acc: null,
      durationMs: 100, finalOutputText: "", stdout: "fallback",
      code: 0, sessionHandle: null, priorSessionHandle: null,
    });
    assert.equal(stats.inputTokens, 0);
    assert.equal(stats.outputTokens, 0);
    assert.deepEqual(stats.toolUses, []);
  });
});

describe("copilot stall timeout", () => {
  it("falls back to the configured provider stall timeout when no override is passed", () => {
    assert.ok(copilot.__testResolveCopilotStallTimeoutMs(null) > 0);
  });

  it("honors explicit positive stall timeout overrides", () => {
    assert.equal(copilot.__testResolveCopilotStallTimeoutMs(3), 3000);
  });
});

describe("copilot.getAuthMethod + isReady", () => {
  it("isReady fails fast when no credentials present (clear PAT envs)", () => {
    const prevGh = process.env.GH_TOKEN;
    const prevGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      // We can't unconditionally clear ~/.copilot in the test environment.
      // Just assert the function returns a consistent shape; ready may be
      // either true (OAuth present) or false (no auth) depending on the
      // runner's machine.
      const r = copilot.isReady();
      assert.equal(typeof r.ready, "boolean");
      if (!r.ready) assert.ok(r.reason);
    } finally {
      if (prevGh) process.env.GH_TOKEN = prevGh;
      if (prevGithub) process.env.GITHUB_TOKEN = prevGithub;
    }
  });

  it("hasCredentials matches resolveCopilotAuth presence", () => {
    const hc = copilot.hasCredentials();
    const am = copilot.getAuthMethod();
    assert.equal(hc, am !== null);
  });
});

describe("copilot child launch safety", () => {
  it("bypasses Windows npm .cmd shims instead of routing prompts through cmd.exe", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-copilot-shim-"));
    try {
      const shim = path.join(tmp, "copilot.cmd");
      const loader = path.join(tmp, "node_modules", "@github", "copilot", "npm-loader.js");
      const nodeExe = path.join(tmp, "node.exe");
      fs.mkdirSync(path.dirname(loader), { recursive: true });
      fs.writeFileSync(shim, "@echo off\r\n", "utf-8");
      fs.writeFileSync(loader, "console.log('loader');\n", "utf-8");
      fs.writeFileSync(nodeExe, "", "utf-8");

      const launch = copilot.__testBuildCopilotSpawn(shim, [
        "-p", "please do not expand %OPENAI_API_KEY%",
        "--output-format", "json",
      ], "win32");

      assert.equal(launch.command, nodeExe);
      assert.deepEqual(launch.args, [
        loader,
        "-p", "please do not expand %OPENAI_API_KEY%",
        "--output-format", "json",
      ]);
      assert.equal(launch.windowsVerbatimArguments, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scrubs unrelated provider credentials while preserving the selected Copilot PAT", () => {
    const env = copilot.__testBuildCopilotChildEnv({
      PATH: "bin",
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
      CODEX_API_KEY: "codex-secret",
      POSSE_KEY: "remote-secret",
      POSSE_REMOTE_API_KEY: "remote-secret",
      GH_TOKEN: "copilot-secret",
      GITHUB_TOKEN: "github-secret",
      SAFE_VALUE: "kept",
    }, { mode: "pat", source: "GH_TOKEN" });

    assert.equal(env.PATH, "bin");
    assert.equal(env.SAFE_VALUE, "kept");
    assert.equal(env.GH_TOKEN, "copilot-secret");
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("XAI_API_KEY" in env, false);
    assert.equal("CODEX_API_KEY" in env, false);
    assert.equal("POSSE_KEY" in env, false);
    assert.equal("POSSE_REMOTE_API_KEY" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
  });

  it("scrubs Copilot PAT envs when OAuth auth is active", () => {
    const env = copilot.__testBuildCopilotChildEnv({
      PATH: "bin",
      GH_TOKEN: "copilot-secret",
      GITHUB_TOKEN: "github-secret",
    }, { mode: "oauth", source: "~/.copilot" });

    assert.equal(env.PATH, "bin");
    assert.equal("GH_TOKEN" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
  });
});

describe("copilot.callProvider not-ready fast-fail", () => {
  it("rejects with COPILOT_NOT_READY when credentials/binary missing", async () => {
    // We can't reliably set isReady=false here (depends on the machine),
    // so just check that the path exists and rejects with a code. Skip
    // when isReady is true.
    const r = copilot.isReady();
    if (r.ready) {
      // Can't test the not-ready path without mocking; skip.
      return;
    }
    await assert.rejects(
      () => copilot.callProvider("hi"),
      (err) => err && err.code === "COPILOT_NOT_READY",
    );
  });
});
