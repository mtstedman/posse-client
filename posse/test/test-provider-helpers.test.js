import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  closeAccountSettingsDb,
  setAccountSettingsPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";

let accountSettingsPath;
let runtimeDir;
let getMaxTurnsForProvider;
let escalateModelTier;
let setSetting;
let appendBoundedCodexOutput;
let refreshCodexUsageSummary;
let setCodexUsageFetchers;
let resetCodexUsageState;
let getCodexInteractiveUsageUnavailableReason;

describe("provider helper consolidation", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-provider-helpers-"));
    accountSettingsPath = path.join(runtimeDir, "account-settings.db");
    setAccountSettingsPathForTests(accountSettingsPath);
    ({ getMaxTurnsForProvider, escalateModelTier } = await import("../lib/domains/providers/functions/helpers/turns.js"));
    ({ setSetting } = await import("../lib/domains/queue/functions/index.js"));
    ({
      refreshUsageSummary: refreshCodexUsageSummary,
      __testAppendBoundedCodexOutput: appendBoundedCodexOutput,
      __testSetCodexUsageFetchers: setCodexUsageFetchers,
      __testResetCodexUsageState: resetCodexUsageState,
      __testGetCodexInteractiveUsageUnavailableReason: getCodexInteractiveUsageUnavailableReason,
    } = await import("../lib/domains/providers/functions/codex.js"));
  });

  beforeEach(() => {
    closeAccountSettingsDb();
    try { fs.rmSync(accountSettingsPath, { force: true }); } catch {}
  });

  afterEach(() => {
    resetCodexUsageState?.();
  });

  after(() => {
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(null);
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  });

  it("preserves per-provider max-turn budgets behind one helper", () => {
    assert.equal(getMaxTurnsForProvider("claude", { role: "dev", modelTier: "standard", complexity: 3 }), 29);
    assert.equal(getMaxTurnsForProvider("claude", { role: "researcher", modelTier: "strong", deepthink: true }), 46);
    assert.equal(getMaxTurnsForProvider("openai", { role: "dev", modelTier: "standard", complexity: 3 }), 10);
    assert.equal(getMaxTurnsForProvider("grok", { role: "dev", modelTier: "strong", complexity: 3, deepthink: true }), 18);
    assert.equal(getMaxTurnsForProvider("codex", { role: "artificer", modelTier: "standard", complexity: 3 }), 14);
  });

  it("keeps provider-specific max-turn setting semantics", () => {
    setSetting("max_turns_dev", "7");
    assert.equal(getMaxTurnsForProvider("claude", { role: "dev", modelTier: "standard", complexity: 3 }), 7);
    assert.equal(getMaxTurnsForProvider("openai", { role: "dev", modelTier: "standard", complexity: 3 }), 7);

    assert.throws(() => setSetting("max_turns_dev", "0"), /at least 1/);
    assert.equal(getMaxTurnsForProvider("claude", { role: "dev", modelTier: "standard", complexity: 3 }), 7);
    assert.equal(getMaxTurnsForProvider("openai", { role: "dev", modelTier: "standard", complexity: 3 }), 7);
  });

  it("escalates model tiers from the shared tier order", () => {
    assert.equal(escalateModelTier("cheap", 1), "cheap");
    assert.equal(escalateModelTier("cheap", 2), "standard");
    assert.equal(escalateModelTier("standard", 2), "strong");
    assert.equal(escalateModelTier("cheap", 3), "strong");
    assert.equal(escalateModelTier("unknown", 3), "unknown");
  });

  it("skips past tiers that resolve to the same model when resolveModel is provided", () => {
    // Simulates the user's codex mapping: cheap == standard, strong differs.
    const codexLikeResolve = (tier) => {
      if (tier === "cheap") return "gpt-5.3-codex";
      if (tier === "standard") return "gpt-5.3-codex";
      if (tier === "strong") return "gpt-5.5";
      return null;
    };
    // attempt 1 is a no-op as before
    assert.equal(escalateModelTier("cheap", 1, { resolveModel: codexLikeResolve }), "cheap");
    // attempt 2 from cheap would normally land on standard (same model) —
    // model-aware escalation must skip ahead to strong.
    assert.equal(escalateModelTier("cheap", 2, { resolveModel: codexLikeResolve }), "strong");
    // attempt 3+ stays on strong regardless.
    assert.equal(escalateModelTier("cheap", 3, { resolveModel: codexLikeResolve }), "strong");
    // standard -> strong is already a real escalation, leave it alone.
    assert.equal(escalateModelTier("standard", 2, { resolveModel: codexLikeResolve }), "strong");
  });

  it("preserves claude-style escalation when every tier maps to a distinct model", () => {
    const claudeLikeResolve = (tier) => {
      if (tier === "cheap") return "claude-haiku-4-5";
      if (tier === "standard") return "claude-sonnet-4-6";
      if (tier === "strong") return "claude-opus-4-7";
      return null;
    };
    // Each step lands on the next distinct model.
    assert.equal(escalateModelTier("cheap", 2, { resolveModel: claudeLikeResolve }), "standard");
    assert.equal(escalateModelTier("standard", 2, { resolveModel: claudeLikeResolve }), "strong");
    assert.equal(escalateModelTier("cheap", 3, { resolveModel: claudeLikeResolve }), "strong");
  });

  it("falls back to the top tier when every tier resolves to the same model", () => {
    const collapsedResolve = () => "only-one-model";
    // No tier produces a different model — escalation can't help, return top.
    assert.equal(escalateModelTier("cheap", 2, { resolveModel: collapsedResolve }), "strong");
    assert.equal(escalateModelTier("standard", 2, { resolveModel: collapsedResolve }), "strong");
  });

  it("keeps only the tail of oversized Codex stream captures", () => {
    let captured = appendBoundedCodexOutput("abc", "def", 5);
    assert.equal(captured, "bcdef");
    captured = appendBoundedCodexOutput(captured, "gh", 5);
    assert.equal(captured, "defgh");
  });

  it("refreshes Codex usage through app-server by default", async () => {
    let interactiveCalls = 0;
    let appServerCalls = 0;
    setCodexUsageFetchers({
      interactive: async () => {
        interactiveCalls += 1;
        throw new Error("interactive usage should not be touched");
      },
      appServer: async () => {
        appServerCalls += 1;
        return {};
      },
    });

    const summary = await refreshCodexUsageSummary({
      nowMs: Date.parse("2026-05-31T23:55:20.000Z"),
      forceRefresh: true,
      ignoreBackoff: true,
    });

    assert.equal(interactiveCalls, 0);
    assert.equal(appServerCalls, 1);
    assert.equal(summary.provider, "codex");
    assert.equal(summary.source, "codex-app-server-rate-limits");
  });

  it("skips Codex interactive usage probes on Windows even when preferred", async () => {
    let interactiveCalls = 0;
    let appServerCalls = 0;
    setCodexUsageFetchers({
      interactive: async () => {
        interactiveCalls += 1;
        return "Credits: 1";
      },
      appServer: async () => {
        appServerCalls += 1;
        return {};
      },
    });

    const summary = await refreshCodexUsageSummary({
      nowMs: Date.parse("2026-05-31T23:55:21.000Z"),
      forceRefresh: true,
      ignoreBackoff: true,
      preferInteractive: true,
      platform: "win32",
    });

    assert.equal(interactiveCalls, 0);
    assert.equal(appServerCalls, 1);
    assert.equal(summary.source, "codex-app-server-rate-limits");
    assert.match(getCodexInteractiveUsageUnavailableReason(), /disabled on Windows/);
  });

  it("circuits Codex interactive usage probes after a probe failure", async () => {
    let interactiveCalls = 0;
    let appServerCalls = 0;
    setCodexUsageFetchers({
      interactive: async () => {
        interactiveCalls += 1;
        throw new Error("AttachConsole failed");
      },
      appServer: async () => {
        appServerCalls += 1;
        return {};
      },
    });

    for (let i = 0; i < 2; i++) {
      const summary = await refreshCodexUsageSummary({
        nowMs: Date.parse(`2026-05-31T23:55:2${i}.000Z`),
        forceRefresh: true,
        ignoreBackoff: true,
        preferInteractive: true,
        platform: "linux",
      });
      assert.equal(summary.source, "codex-app-server-rate-limits");
    }

    assert.equal(interactiveCalls, 1);
    assert.equal(appServerCalls, 2);
    assert.equal(getCodexInteractiveUsageUnavailableReason(), "AttachConsole failed");
  });
});
