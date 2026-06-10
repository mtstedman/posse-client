import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BaseProvider } from "../lib/domains/providers/classes/BaseProvider.js";
import { ProviderRegistry } from "../lib/domains/providers/classes/ProviderRegistry.js";
import { TrackedProviderClient } from "../lib/domains/worker/classes/TrackedProviderClient.js";
import { normalizeProviderUsage } from "../lib/domains/providers/functions/helpers/usage-normalization.js";
import { resolveCallCostEstimate } from "../lib/domains/worker/functions/execution/job-helpers.js";

describe("ProviderRegistry", () => {
  it("registers providers, resolves aliases, tracks load errors, and advances cursors", () => {
    const registry = new ProviderRegistry({ aliases: { "grok-images": "grok" } });
    const provider = registry.register("grok-images", {
      callProvider: async () => ({ output: "ok", stats: {} }),
    });

    assert.equal(registry.canonicalName("grok-images"), "grok");
    assert.equal(provider instanceof BaseProvider, true);
    assert.equal(registry.has("grok"), true);
    assert.equal(registry.get("grok-images"), provider);
    assert.equal(registry.get("missing"), null);
    assert.equal(registry.cursorNext("dev:claude,openai"), 0);
    assert.equal(registry.cursorNext("dev:claude,openai"), 1);
    registry.resetSelectionCursor();
    assert.equal(registry.cursorNext("dev:claude,openai"), 0);

    const err = new Error("optional provider missing");
    registry.setLoadError("grok-images", err);
    assert.equal(registry.getLoadError("grok"), err);
    registry.register("grok", { callProvider: async () => ({ output: "ok", stats: {} }) });
    assert.equal(registry.getLoadError("grok"), null);
  });

  it("rejects unknown provider modules instead of falling back to a generic adapter", () => {
    const registry = new ProviderRegistry();
    assert.throws(
      () => registry.register("experimental", { callProvider: async () => ({ output: "ok" }) }),
      /Unsupported provider "experimental"/,
    );
  });
});

describe("provider usage accounting", () => {
  it("normalizes OpenAI-style cached and reasoning token details without double-counting totals", () => {
    const usage = normalizeProviderUsage("openai", {
      input_tokens: 100,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 25 },
      output_tokens_details: { reasoning_tokens: 10 },
    });

    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.cachedInputTokens, 25);
    assert.equal(usage.reasoningOutputTokens, 10);
  });

  it("normalizes Claude cache creation/read tokens into persisted input totals", () => {
    const usage = normalizeProviderUsage("claude", {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 20,
    });

    assert.equal(usage.inputTokens, 175);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.cacheCreationInputTokens, 50);
    assert.equal(usage.cacheReadInputTokens, 25);
  });

  it("estimates call cost from normalized stats when providers do not report cost", () => {
    assert.equal(resolveCallCostEstimate({
      provider: "openai",
      modelName: "gpt-5",
      modelTier: "strong",
      inputTokens: 1_000_000,
      outputTokens: 0,
    }), 1.25);
  });
});

describe("TrackedProviderClient", () => {
  function makeHarness({
    primaryCall,
    fallbackCall = async () => ({
      output: "fallback ok",
      stats: { outputChars: 11, inputTokens: 3, outputTokens: 4, durationMs: 9, exitCode: 0, modelName: "fallback-model" },
    }),
    extraProviders = {},
    availableProviders = null,
    isProviderError = () => false,
    rateLimitState = { blocked: false, retryInSec: 0, reason: "" },
    ambientContext = { attempt_id: 42 },
    workerOverrides = {},
    depsOverrides = {},
    resolveCallCostEstimate = undefined,
  } = {}) {
    const agentCalls = [];
    const completions = [];
    const prompts = [];
    const outputs = [];
    const observations = [];
    const toolObservations = [];
    const contexts = [];
    const updates = [];
    const emitted = [];
    const providers = {
      primary: {
        MODEL_TIERS: { standard: { model: "primary-model" } },
        getModelTierConfig: () => ({ model: "primary-model" }),
        call: primaryCall || (async (_prompt, opts) => {
          opts.recordFinalPrompt("final primary prompt");
          return {
            output: "primary ok",
            stats: { outputChars: 10, inputTokens: 1, outputTokens: 2, durationMs: 7, exitCode: 0, modelName: "primary-model" },
          };
        }),
      },
      fallback: {
        MODEL_TIERS: { standard: { model: "fallback-model" } },
        getModelTierConfig: () => ({ model: "fallback-model" }),
        call: fallbackCall,
      },
      ...extraProviders,
    };
    const worker = {
      projectDir: null,
      display: null,
      stallTimeout: null,
      _abortControllers: new Map(),
      _killReasons: new Map(),
      emit: (jobId, message) => emitted.push({ jobId, message }),
      ...workerOverrides,
    };
    const deps = {
      createAgentCall: (entry) => {
        const call = { id: agentCalls.length + 1, ...entry };
        agentCalls.push(call);
        return call;
      },
      completeAgentCall: (id, entry) => completions.push({ id, ...entry }),
      updateJobProvider: (...args) => updates.push(args),
      getAvailableProviders: () => availableProviders || ["primary", "fallback"],
      getProvider: (_role, name) => providers[name],
      getProviderRateLimitState: (name) => (
        typeof rateLimitState === "function" ? rateLimitState(name) : rateLimitState
      ),
      selectProviderName: () => "primary",
      filterProviderToolUseReplay: (tools) => tools,
      getObservationContext: () => ambientContext,
      recordObservation: (entry) => observations.push(entry),
      recordToolUseObservations: (entry) => toolObservations.push(entry),
      runWithObservationContext: async (ctx, fn) => {
        contexts.push(ctx);
        return await fn();
      },
      recordPrompt: (entry) => prompts.push(entry),
      recordOutput: (entry) => outputs.push(entry),
      resolveAtlasExecutionAttachment: () => ({ method: "fallback-atlas" }),
      provisionAgentLoader: () => null,
      provisionSessionLaneLoader: () => null,
      assertLoaderClean: () => {},
      resolvePrimaryExecutionModelName: (_jobModelName, _opts, tierConfig) => tierConfig.model,
      sanitizeExecutionHintsForRole: (_role, opts) => opts,
      selectFallbackProvider: (pool, current) => pool.find((name) => name !== current) || null,
      ...depsOverrides,
    };
    const client = new TrackedProviderClient({
      worker,
      deps,
      isProviderError,
      ...(resolveCallCostEstimate ? { resolveCallCostEstimate } : {}),
    });
    return { client, worker, agentCalls, completions, prompts, outputs, observations, toolObservations, contexts, updates, emitted };
  }

  it("records a successful provider call through injected dependencies", async () => {
    const harness = makeHarness();
    const result = await harness.client.call("prompt", {
      role: "dev",
      modelTier: "standard",
      activity: "build",
      attemptCount: 2,
    }, {
      job_id: 10,
      work_item_id: 20,
    });

    assert.equal(result.output, "primary ok");
    assert.equal(harness.agentCalls.length, 1);
    assert.equal(harness.agentCalls[0].provider, "primary");
    assert.equal(harness.completions[0].status, "succeeded");
    assert.equal(harness.prompts[0].prompt, "final primary prompt");
    assert.equal(harness.outputs[0].status, "succeeded");
    assert.deepEqual(harness.contexts[0], { work_item_id: 20, job_id: 10, attempt_id: 42, role: "dev" });
  });

  it("passes normalized accounting context and preserves zero-token stats", async () => {
    const costInputs = [];
    const harness = makeHarness({
      primaryCall: async () => ({
        output: "zero-token ok",
        stats: { outputChars: 13, inputTokens: 0, outputTokens: 0, durationMs: 5, exitCode: 0, modelName: "primary-model" },
      }),
      resolveCallCostEstimate: (stats) => {
        costInputs.push(stats);
        return 0.123;
      },
    });

    await harness.client.call("prompt", {
      role: "dev",
      modelTier: "standard",
    }, {
      job_id: 101,
      work_item_id: 202,
    });

    assert.equal(harness.completions[0].input_tokens, 0);
    assert.equal(harness.completions[0].output_tokens, 0);
    assert.equal(harness.completions[0].cost_estimate_usd, 0.123);
    assert.equal(costInputs[0].provider, "primary");
    assert.equal(costInputs[0].modelTier, "standard");
    assert.equal(costInputs[0].modelName, "primary-model");
  });

  it("records primary failure and successful fallback without a real database", async () => {
    const harness = makeHarness({
      isProviderError: () => true,
      primaryCall: async (_prompt, opts) => {
        opts.recordFinalPrompt("final primary prompt");
        const err = new Error("rate limit");
        err.stats = { outputChars: 3, inputTokens: 1, outputTokens: 0, durationMs: 5, exitCode: 1, modelName: "primary-model", output: "bad" };
        throw err;
      },
      fallbackCall: async (_prompt, opts) => {
        opts.recordFinalPrompt("final fallback prompt");
        return {
          output: "fallback ok",
          stats: { outputChars: 11, inputTokens: 2, outputTokens: 3, durationMs: 8, exitCode: 0, modelName: "fallback-model" },
        };
      },
    });

    const result = await harness.client.call("prompt", {
      role: "dev",
      modelTier: "standard",
      activity: "build",
      atlasMethod: "primary-atlas",
    }, {
      job_id: 11,
      work_item_id: 22,
    });

    assert.equal(result.output, "fallback ok");
    assert.deepEqual(harness.agentCalls.map((entry) => entry.provider), ["primary", "fallback"]);
    assert.deepEqual(harness.completions.map((entry) => entry.status), ["failed", "succeeded"]);
    assert.deepEqual(harness.prompts.map((entry) => entry.prompt), ["final primary prompt", "final fallback prompt"]);
    assert.deepEqual(harness.outputs.map((entry) => entry.status), ["failed", "succeeded"]);
    assert.deepEqual(harness.updates, [[11, "fallback", "fallback-model"]]);
    assert.ok(harness.observations.some((entry) => entry.observation_type === "provider.fallback" && entry.attempt_id === 42));
    assert.ok(harness.observations.some((entry) => entry.observation_type === "atlas.fallback.rebind" && entry.attempt_id === 42));
    assert.ok(harness.contexts.some((entry) => entry.role === "dev" && entry.attempt_id === 42));
    assert.ok(harness.emitted.some((entry) => entry.message.includes("fallback")));
  });

  it("preserves the ambient role in fallback observation context", async () => {
    const harness = makeHarness({
      ambientContext: { attempt_id: 42, role: "assessor" },
      isProviderError: () => true,
      primaryCall: async () => {
        const err = new Error("primary failed");
        err.stats = { outputChars: 1, inputTokens: 1, outputTokens: 0, durationMs: 4, exitCode: 1, modelName: "primary-model" };
        throw err;
      },
    });

    const result = await harness.client.call("prompt", { modelTier: "standard" }, { job_id: 12, work_item_id: 24 });

    assert.equal(result.output, "fallback ok");
    assert.ok(harness.contexts.some((entry) => entry.role === "assessor" && entry.attempt_id === 42));
  });

  it("uses a fallback prompt builder without exposing it to providers", async () => {
    let fallbackPromptSeen = null;
    const harness = makeHarness({
      isProviderError: () => true,
      primaryCall: async (_prompt, opts) => {
        assert.equal(opts.buildFallbackPrompt, undefined);
        const err = new Error("primary failed");
        err.stats = { outputChars: 1, inputTokens: 1, outputTokens: 0, durationMs: 4, exitCode: 1, modelName: "primary-model" };
        throw err;
      },
      fallbackCall: async (prompt, opts) => {
        assert.equal(opts.buildFallbackPrompt, undefined);
        fallbackPromptSeen = prompt;
        opts.recordFinalPrompt(prompt);
        return {
          output: "fallback ok",
          stats: { outputChars: 11, inputTokens: 2, outputTokens: 3, durationMs: 8, exitCode: 0, modelName: "fallback-model" },
        };
      },
    });

    const result = await harness.client.call("primary contract\n\nstable context", {
      role: "dev",
      modelTier: "standard",
      buildFallbackPrompt: ({ providerName, previousProviderName }) => (
        `${previousProviderName}->${providerName} contract\n\nstable context`
      ),
    }, {
      job_id: 16,
      work_item_id: 32,
    });

    assert.equal(result.output, "fallback ok");
    assert.equal(fallbackPromptSeen, "primary->fallback contract\n\nstable context");
    assert.equal(harness.prompts.at(-1).prompt, "primary->fallback contract\n\nstable context");
  });

  it("fails before creating an agent call when the selected provider is rate-limited", async () => {
    const harness = makeHarness({
      rateLimitState: { blocked: true, retryInSec: 90, reason: "quota" },
    });

    await assert.rejects(
      () => harness.client.call("prompt", { role: "dev", modelTier: "standard" }, { job_id: 13, work_item_id: 26 }),
      (err) => {
        assert.equal(err._rateLimitPreFlight, true);
        assert.match(err.message, /primary rate-limited \(quota\)/);
        return true;
      },
    );
    assert.equal(harness.agentCalls.length, 0);
  });

  it("routes rate-limit preflight failures through the fallback prompt builder", async () => {
    let fallbackPromptSeen = null;
    const harness = makeHarness({
      rateLimitState: (name) => (
        name === "primary"
          ? { blocked: true, retryInSec: 90, reason: "quota" }
          : { blocked: false, retryInSec: 0, reason: "" }
      ),
      fallbackCall: async (prompt, opts) => {
        assert.equal(opts.buildFallbackPrompt, undefined);
        fallbackPromptSeen = prompt;
        opts.recordFinalPrompt(prompt);
        return {
          output: "fallback ok",
          stats: { outputChars: 11, inputTokens: 2, outputTokens: 3, durationMs: 8, exitCode: 0, modelName: "fallback-model" },
        };
      },
    });

    const result = await harness.client.call("primary contract\n\nstable context", {
      role: "dev",
      modelTier: "standard",
      buildFallbackPrompt: ({ providerName, previousProviderName }) => (
        `${previousProviderName}->${providerName} contract\n\nstable context`
      ),
    }, {
      job_id: 17,
      work_item_id: 34,
    });

    assert.equal(result.output, "fallback ok");
    assert.equal(fallbackPromptSeen, "primary->fallback contract\n\nstable context");
    assert.deepEqual(harness.agentCalls.map((entry) => entry.provider), ["fallback"]);
    assert.deepEqual(harness.updates, [[17, "fallback", "fallback-model"]]);
    assert.ok(harness.observations.some((entry) => entry.detail?.reason === "rate_limit_preflight"));
  });

  it("can use an untried provider when preflight fallback also fails", async () => {
    let tertiaryPromptSeen = null;
    const harness = makeHarness({
      availableProviders: ["primary", "fallback", "tertiary"],
      rateLimitState: (name) => (
        name === "primary"
          ? { blocked: true, retryInSec: 90, reason: "quota" }
          : { blocked: false, retryInSec: 0, reason: "" }
      ),
      isProviderError: () => true,
      fallbackCall: async (_prompt, opts) => {
        opts.recordFinalPrompt("final fallback prompt");
        const err = new Error("fallback API error");
        err.stats = { outputChars: 3, inputTokens: 1, outputTokens: 0, durationMs: 5, exitCode: 1, modelName: "fallback-model", output: "bad" };
        throw err;
      },
      extraProviders: {
        tertiary: {
          MODEL_TIERS: { standard: { model: "tertiary-model" } },
          getModelTierConfig: () => ({ model: "tertiary-model" }),
          call: async (prompt, opts) => {
            tertiaryPromptSeen = prompt;
            opts.recordFinalPrompt(prompt);
            return {
              output: "tertiary ok",
              stats: { outputChars: 11, inputTokens: 2, outputTokens: 3, durationMs: 8, exitCode: 0, modelName: "tertiary-model" },
            };
          },
        },
      },
    });

    const result = await harness.client.call("primary contract\n\nstable context", {
      role: "dev",
      modelTier: "standard",
      buildFallbackPrompt: ({ providerName, previousProviderName }) => (
        `${previousProviderName}->${providerName} contract\n\nstable context`
      ),
    }, {
      job_id: 18,
      work_item_id: 36,
    });

    assert.equal(result.output, "tertiary ok");
    assert.equal(tertiaryPromptSeen, "fallback->tertiary contract\n\nstable context");
    assert.deepEqual(harness.agentCalls.map((entry) => entry.provider), ["fallback", "tertiary"]);
    assert.deepEqual(harness.updates, [[18, "tertiary", "tertiary-model"]]);
    assert.ok(harness.observations.some((entry) => entry.detail?.reason === "rate_limit_preflight"));
    assert.ok(harness.observations.some((entry) => entry.summary === "fallback -> tertiary"));
  });

  it("uses the stable session loader cwd for Claude recycle lanes", async () => {
    const projectDir = "C:\\repo\\spirit";
    const sessionKey = {
      workItemId: 40,
      lane: "dev",
      provider: "claude",
      skillKey: "",
    };
    const loaderCalls = [];
    let providerOpts = null;
    const claudeProvider = {
      MODEL_TIERS: { standard: { model: "claude-sonnet-4-6" } },
      getModelTierConfig: () => ({ model: "claude-sonnet-4-6" }),
      call: async (_prompt, opts) => {
        providerOpts = opts;
        return {
          output: "claude ok",
          stats: {
            sessionHandle: "claude-session-1",
            outputChars: 9,
            inputTokens: 4,
            outputTokens: 2,
            durationMs: 6,
            exitCode: 0,
            modelName: "claude-sonnet-4-6",
          },
        };
      },
    };
    const harness = makeHarness({
      workerOverrides: { projectDir },
      depsOverrides: {
        selectProviderName: () => "claude",
        getAvailableProviders: () => ["claude"],
        getProvider: () => claudeProvider,
        provisionAgentLoader: (_projectDir, jobId) => {
          loaderCalls.push({ kind: "job", projectDir: _projectDir, jobId });
          return "per-job-loader";
        },
        provisionSessionLaneLoader: (_projectDir, key) => {
          loaderCalls.push({ kind: "session", projectDir: _projectDir, key });
          return "session-lane-loader";
        },
        assertLoaderClean: (loaderPath) => loaderCalls.push({ kind: "clean", loaderPath }),
      },
    });
    harness.client._prepareSessionReuse = (prompt, opts) => ({
      prompt,
      opts: {
        ...opts,
        recyclingMode: "fresh",
        _sessionRecycle: {
          decision: { key: sessionKey },
        },
      },
      decision: { key: sessionKey },
    });

    const result = await harness.client.call("prompt", {
      role: "dev",
      modelTier: "standard",
      activity: "build",
    }, {
      job_id: 20,
      work_item_id: 40,
    });

    assert.equal(result.output, "claude ok");
    assert.equal(providerOpts.loaderCwd, "session-lane-loader");
    assert.equal(providerOpts.mcpCwd, projectDir);
    assert.deepEqual(
      loaderCalls.filter((entry) => entry.kind === "session"),
      [{ kind: "session", projectDir, key: sessionKey }],
    );
    assert.deepEqual(loaderCalls.filter((entry) => entry.kind === "job"), []);
    assert.deepEqual(
      loaderCalls.filter((entry) => entry.kind === "clean"),
      [{ kind: "clean", loaderPath: "session-lane-loader" }],
    );
  });

  it("records fallback failure and throws the original provider error", async () => {
    const primaryErr = new Error("primary unavailable");
    primaryErr.stats = { outputChars: 2, inputTokens: 1, outputTokens: 0, durationMs: 5, exitCode: 1, modelName: "primary-model", output: "p" };
    const fallbackErr = new Error("fallback unavailable");
    fallbackErr.stats = { outputChars: 3, inputTokens: 2, outputTokens: 0, durationMs: 6, exitCode: 2, modelName: "fallback-model", output: "f" };
    const harness = makeHarness({
      isProviderError: () => true,
      primaryCall: async () => { throw primaryErr; },
      fallbackCall: async () => { throw fallbackErr; },
    });

    await assert.rejects(
      () => harness.client.call("prompt", { role: "dev", modelTier: "standard" }, { job_id: 14, work_item_id: 28 }),
      primaryErr,
    );
    assert.deepEqual(harness.agentCalls.map((entry) => entry.provider), ["primary", "fallback"]);
    assert.deepEqual(harness.completions.map((entry) => entry.status), ["failed", "failed"]);
    assert.deepEqual(harness.outputs.map((entry) => entry.status), ["failed", "failed"]);
    assert.deepEqual(harness.updates, []);
    assert.ok(harness.emitted.some((entry) => entry.message.includes("also failed")));
  });

  it("annotates thrown provider errors with kill reasons", async () => {
    const providerErr = new Error("killed");
    providerErr.stats = { outputChars: 0, inputTokens: 1, outputTokens: 0, durationMs: 1, exitCode: null };
    const killReasons = new Map([[15, "runtime_exceeded"]]);
    const harness = makeHarness({
      primaryCall: async () => { throw providerErr; },
      workerOverrides: { _killReasons: killReasons },
    });

    await assert.rejects(
      () => harness.client.call("prompt", { role: "dev", modelTier: "standard" }, { job_id: 15, work_item_id: 30 }),
      (err) => {
        assert.equal(err._killReason, "runtime_exceeded");
        return true;
      },
    );
    assert.equal(killReasons.has(15), false);
  });
});
