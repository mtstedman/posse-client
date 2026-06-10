import {
  it,
  assert,
  suite,
  withQueueSettings,
  escalateTier,
} from "../support/core-harness.js";
import { __testGetMaxTurns, scrubClaudeChildEnv } from "../../../lib/domains/providers/functions/claude.js";

let db;

suite("Tier Escalation (claude)", () => {
  it("attempt 1 returns same tier", () => {
    assert.equal(escalateTier("cheap", 1), "cheap");
    assert.equal(escalateTier("standard", 1), "standard");
    assert.equal(escalateTier("strong", 1), "strong");
  });

  it("attempt 2 escalates one tier", () => {
    assert.equal(escalateTier("cheap", 2), "standard");
    assert.equal(escalateTier("standard", 2), "strong");
  });

  it("attempt 2 with strong stays strong", () => {
    assert.equal(escalateTier("strong", 2), "strong");
  });

  it("attempt 3+ always returns strong", () => {
    assert.equal(escalateTier("cheap", 3), "strong");
    assert.equal(escalateTier("standard", 3), "strong");
    assert.equal(escalateTier("cheap", 5), "strong");
  });

  it("unknown tier returns itself", () => {
    assert.equal(escalateTier("unknown", 1), "unknown");
    assert.equal(escalateTier("unknown", 3), "unknown");
  });

  it("rejects non-positive configured max turns", () => {
    withQueueSettings({ max_turns_dev: "7" }, () => {
      assert.throws(() => withQueueSettings({ max_turns_dev: "0" }, () => {}), /at least 1/);
      assert.equal(__testGetMaxTurns("dev", "standard", 3), 7);
    });
  });

  it("scrubs non-Claude provider secrets from child env", () => {
    const env = {
      ANTHROPIC_API_KEY: "anthropic-ok",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-ok",
      CODEX_API_KEY: "codex-secret",
      OPENAI_API_KEY: "openai-secret",
      XAI_API_KEY: "xai-secret",
      GITHUB_TOKEN: "github-secret",
    };

    assert.equal(scrubClaudeChildEnv(env), env);
    assert.equal(env.ANTHROPIC_API_KEY, "anthropic-ok");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "claude-ok");
    assert.equal("CODEX_API_KEY" in env, false);
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("XAI_API_KEY" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: JSON Extraction (claude.js)
// ═════════════════════════════════════════════════════════════════════════════
