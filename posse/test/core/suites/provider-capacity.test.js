import {
  it,
  assert,
  suite,
  runtimeModules,
  withEnv,
  getConfiguredProviderUsage,
  getProviderCapacityState,
} from "../support/core-harness.js";

let db;

suite("Provider capacity", () => {
  it("marks providers blocked when a usage window is exhausted", () => {
    withEnv({ OPENAI_API_KEY: "test-key" }, () => {
      const { queueMod, dbMod } = runtimeModules;
      const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
      const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
      const db = dbMod.getDb();
      queueMod.setSetting("openai_limit_tokens_session", null);

      queueMod.setSetting("openai_limit_tokens_week", null);
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      db.prepare(`
        INSERT INTO agent_calls (
          role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("dev", "standard", "openai", "succeeded", 900, 100, "2026-04-12T11:00:00.000Z", "2026-04-12T11:00:00.000Z");
      queueMod.setSetting("openai_limit_tokens_session", "1000");

      try {
        const state = getProviderCapacityState("openai", { nowMs: Date.parse("2026-04-12T12:00:00.000Z") });
        assert.equal(state.blocked, true);
        assert.equal(state.source, "usage_limit");
        assert.match(state.reason || "", /session \(5h\) token cap exhausted/i);
        assert.equal(state.retryInSec, 4 * 60 * 60);
      } finally {
        db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
        if (previousSessionLimit == null) {
          queueMod.setSetting("openai_limit_tokens_session", null);
        } else {
          queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
        }
        if (previousWeekLimit != null) queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
      }
    });
  });

  it("includes the effective default provider in configured usage summaries", () => {
    const summaries = getConfiguredProviderUsage();
    assert.ok(Array.isArray(summaries));
    assert.ok(summaries.some((summary) => summary?.provider === "claude"));
  });
});
