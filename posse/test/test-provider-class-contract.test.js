import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderRegistry } from "../lib/domains/providers/classes/ProviderRegistry.js";
import { ClaudeProvider } from "../lib/domains/providers/classes/ClaudeProvider.js";
import { CodexProvider } from "../lib/domains/providers/classes/CodexProvider.js";
import { OpenAIProvider } from "../lib/domains/providers/classes/OpenAIProvider.js";
import { GrokProvider } from "../lib/domains/providers/classes/GrokProvider.js";
import { ProviderRuntimeState } from "../lib/domains/providers/classes/ProviderRuntimeState.js";
import { ProviderUsageRuntimeCache } from "../lib/domains/providers/classes/ProviderUsageRuntimeCache.js";

describe("provider class contract", () => {
  it("registers canonical providers as BaseProvider subclasses", () => {
    const registry = new ProviderRegistry();
    const claude = registry.register("claude", {
      MODEL_TIERS: { standard: { model: "claude-standard" } },
      callProvider: async () => ({ output: "ok", stats: {} }),
    });
    const codex = registry.register("codex", {
      MODEL_TIERS: { standard: { model: "gpt-5.4" } },
      callProvider: async () => ({ output: "ok", stats: {} }),
    });
    const openai = registry.register("openai", {
      MODEL_TIERS: { standard: { model: "gpt-5.4-mini" } },
      capabilities: { images: true },
      callProvider: async () => ({ output: "ok", stats: {} }),
    });
    const grok = registry.register("grok", {
      MODEL_TIERS: { standard: { model: "grok-4-fast" } },
      capabilities: { images: true },
      callProvider: async () => ({ output: "ok", stats: {} }),
    });

    assert.equal(claude instanceof ClaudeProvider, true);
    assert.equal(codex instanceof CodexProvider, true);
    assert.equal(openai instanceof OpenAIProvider, true);
    assert.equal(grok instanceof GrokProvider, true);
    assert.equal(openai.hasCapability("images"), true);
    assert.equal(codex.hasCapability("sessionResume"), true);
    assert.equal(codex.getModelTierConfig("missing").model, "gpt-5.4");
  });

  it("keeps provider runtime state on class instances instead of provider modules", async () => {
    let now = 1_000;
    const state = new ProviderRuntimeState({ now: () => now });
    state.tripRateLimit("claude", 60, "quota");
    assert.deepEqual(state.getRateLimitState("claude"), {
      blocked: true,
      retryInSec: 60,
      reason: "quota",
    });
    state.tripRateLimit("claude", 10, "shorter");
    assert.equal(state.getRateLimitState("claude").reason, "quota");
    now += 61_000;
    assert.deepEqual(state.getRateLimitState("claude"), {
      blocked: false,
      retryInSec: 0,
      reason: "",
    });

    assert.equal(state.isUsageAuthPrimed(), false);
    state.markUsageAuthPrimed();
    assert.equal(state.isUsageAuthPrimed(), true);
    state.resetUsageAuthPrime();
    assert.equal(state.isUsageAuthPrimed(), false);
  });

  it("keeps provider usage footer cache state behind a runtime cache class", async () => {
    let now = 100;
    const cache = new ProviderUsageRuntimeCache({
      now: () => now,
      readSync: () => ({
        summaries: [{ provider: "openai" }],
        currentRunProviderUsage: [{ provider: "openai", usedTokens: 12 }],
      }),
      readAsync: async () => ({
        summaries: [{ provider: "claude" }],
        currentRunProviderUsage: [{ provider: "claude", usedTokens: 34 }],
      }),
    });

    assert.deepEqual(cache.refresh(), {
      at: 100,
      summaries: [{ provider: "openai" }],
      currentRunProviderUsage: [{ provider: "openai", usedTokens: 12 }],
    });
    now = 200;
    assert.equal(await cache.refreshIfChanged(), true);
    assert.deepEqual(cache.snapshot(), {
      at: 200,
      summaries: [{ provider: "claude" }],
      currentRunProviderUsage: [{ provider: "claude", usedTokens: 34 }],
    });
  });
});

