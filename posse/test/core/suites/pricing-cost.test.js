import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Pricing + cost", () => {
  beforeEach(() => resetRuntimeDb());

  it("resolves exact default pricing for known provider+model pairs", async () => {
    const { resolvePricing, invalidatePricingCache } = await import("../../../lib/domains/billing/functions/pricing.js");
    invalidatePricingCache();
    const claude = resolvePricing({ provider: "claude", modelName: "sonnet", modelTier: "standard" });
    assert.equal(claude.inputPerM, 3.0);
    assert.equal(claude.outputPerM, 15.0);
    assert.ok(claude.source.startsWith("default:"));

    const codex = resolvePricing({ provider: "codex", modelName: "gpt-5.4", modelTier: "strong" });
    assert.equal(codex.inputPerM, 2.5);
    assert.equal(codex.outputPerM, 15.0);

    const copilot = resolvePricing({ provider: "copilot", modelName: "gpt-5.4", modelTier: "standard" });
    assert.equal(copilot.inputPerM, 2.5);
    assert.equal(copilot.cachedInputPerM, 0.25);
    assert.equal(copilot.outputPerM, 15.0);
  });

  it("falls back to family match then tier default then none", async () => {
    const { resolvePricing, invalidatePricingCache } = await import("../../../lib/domains/billing/functions/pricing.js");
    invalidatePricingCache();
    // Family: claude-sonnet-4-5-20260101 → strips date + tier words → sonnet
    const fam = resolvePricing({ provider: "claude", modelName: "claude-sonnet-4-5-20260101", modelTier: "standard" });
    assert.equal(fam.inputPerM, 3.0);
    assert.equal(fam.outputPerM, 15.0);

    const currentOpus = resolvePricing({ provider: "claude", modelName: "claude-opus-4-7[1m]", modelTier: "strong" });
    assert.equal(currentOpus.inputPerM, 5.0);
    assert.equal(currentOpus.outputPerM, 25.0);

    const legacyOpus = resolvePricing({ provider: "claude", modelName: "claude-opus-4-20250514", modelTier: "strong" });
    assert.equal(legacyOpus.inputPerM, 15.0);
    assert.equal(legacyOpus.outputPerM, 75.0);

    // Unknown model but known tier → tier default.
    const tier = resolvePricing({ provider: "openai", modelName: "completely-unknown", modelTier: "strong" });
    assert.equal(tier.inputPerM, 2.5);
    assert.equal(tier.source.startsWith("tier:"), true);

    // Unknown provider and model → source: none, no throw.
    const none = resolvePricing({ provider: "fictitious", modelName: "nope" });
    assert.equal(none.source, "none");
    assert.equal(none.inputPerM, 0);
  });

  it("does not use bare-tier pricing for model names that merely contain a tier word", async () => {
    const { setPricing, resolvePricing, invalidatePricingCache } = await import("../../../lib/domains/billing/functions/pricing.js");
    invalidatePricingCache();
    setPricing({ provider: "acme", modelName: "sonnet", inputPerM: 99, outputPerM: 199, modelTier: "standard" });
    const got = resolvePricing({ provider: "acme", modelName: "mysonnetclone" });
    assert.equal(got.source, "none");
  });

  it("db override takes precedence over defaults", async () => {
    const { setPricing, resolvePricing, invalidatePricingCache } = await import("../../../lib/domains/billing/functions/pricing.js");
    invalidatePricingCache();
    setPricing({ provider: "claude", modelName: "sonnet", inputPerM: 99, outputPerM: 199, modelTier: "standard" });
    const got = resolvePricing({ provider: "claude", modelName: "sonnet" });
    assert.equal(got.inputPerM, 99);
    assert.equal(got.outputPerM, 199);
    assert.equal(got.source, "db");
  });

  it("estimateCallCost prefers a non-negative knownCostUsd over recompute", async () => {
    const { estimateCallCost } = await import("../../../lib/domains/billing/functions/pricing.js");
    const r = estimateCallCost({
      provider: "claude", modelName: "sonnet", modelTier: "standard",
      inputTokens: 1_000_000, outputTokens: 1_000_000, knownCostUsd: 7.77,
    });
    assert.equal(r.costUsd, 7.77);
    assert.equal(r.source, "known");

    // 0 can be provider-reported for free-tier or credit-covered calls.
    const r0 = estimateCallCost({
      provider: "claude", modelName: "sonnet", modelTier: "standard",
      inputTokens: 1_000_000, outputTokens: 1_000_000, knownCostUsd: 0,
    });
    assert.equal(r0.costUsd, 0);
    assert.equal(r0.source, "known");
  });

  it("applies OpenAI long-context premium for large GPT-5.4 calls", async () => {
    const { estimateCallCost } = await import("../../../lib/domains/billing/functions/pricing.js");
    const r = estimateCallCost({
      provider: "codex", modelName: "gpt-5.4", modelTier: "strong",
      inputTokens: 1_000_000, outputTokens: 10_000,
    });
    // gpt-5.4 long context: 2x input + 1.5x output above 272k input.
    assert.ok(Math.abs(r.costUsd - 5.225) < 1e-9);
    assert.match(r.source, /long_context/);

    const mini = estimateCallCost({
      provider: "openai", modelName: "gpt-5.4-mini", modelTier: "cheap",
      inputTokens: 1_000_000, outputTokens: 10_000,
    });
    assert.ok(Math.abs(mini.costUsd - 0.795) < 1e-9);
    assert.doesNotMatch(mini.source, /long_context/);
  });

  it("uses per-request input size for OpenAI long-context premiums when provided", async () => {
    const { estimateCallCost } = await import("../../../lib/domains/billing/functions/pricing.js");
    const summedToolRun = estimateCallCost({
      provider: "openai",
      modelName: "gpt-5.4",
      modelTier: "strong",
      inputTokens: 300_000,
      longContextInputTokens: 30_000,
      outputTokens: 10_000,
    });
    assert.ok(Math.abs(summedToolRun.costUsd - 0.9) < 1e-9);
    assert.doesNotMatch(summedToolRun.source, /long_context/);

    const singleLargeRequest = estimateCallCost({
      provider: "openai",
      modelName: "gpt-5.4",
      modelTier: "strong",
      inputTokens: 300_000,
      longContextInputTokens: 300_000,
      outputTokens: 10_000,
    });
    assert.ok(Math.abs(singleLargeRequest.costUsd - 1.725) < 1e-9);
    assert.match(singleLargeRequest.source, /long_context/);
  });

  it("discounts persisted OpenAI cached input tokens when estimating cost", async () => {
    const { estimateCallCost } = await import("../../../lib/domains/billing/functions/pricing.js");
    const r = estimateCallCost({
      provider: "openai",
      modelName: "gpt-5",
      modelTier: "strong",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 10_000,
    });
    // gpt-5: 200k uncached at $1.25/M, 800k cached at $0.125/M, 10k output at $10/M.
    assert.ok(Math.abs(r.costUsd - 0.45) < 1e-9);

    const claude = estimateCallCost({
      provider: "claude",
      modelName: "sonnet",
      modelTier: "standard",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 10_000,
    });
    // sonnet: 200k uncached at $3/M, 800k cached at $0.30/M, 10k output at $15/M.
    assert.ok(Math.abs(claude.costUsd - 0.99) < 1e-9);
  });

  it("workItemCost and aggregateCost roll up tokens and USD per group", async () => {
    const { workItemCost, aggregateCost } = await import("../../../lib/domains/billing/functions/cost.js");
    const { queueMod, dbMod } = runtimeModules;
    const rdb = dbMod.getDb();
    const wi = queueMod.createWorkItem("Cost agg", "sum up");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "dev" });

    // Two calls: one claude/sonnet with 100k/10k tokens, one codex/gpt-5.4 with 50k/5k.
    rdb.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, model_name, provider,
        input_tokens, output_tokens, status, duration_ms)
      VALUES (?, ?, 'dev', 'standard', 'sonnet', 'claude', 100000, 10000, 'succeeded', 1000)
    `).run(wi.id, job.id);
    rdb.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, model_name, provider,
        input_tokens, output_tokens, status, duration_ms)
      VALUES (?, ?, 'dev', 'strong', 'gpt-5.4', 'codex', 50000, 5000, 'succeeded', 1000)
    `).run(wi.id, job.id);

    const total = workItemCost(wi.id);
    // sonnet: 100k*3/M + 10k*15/M = 0.30 + 0.15 = 0.45
    // gpt-5.4: 50k*2.5/M + 5k*15/M = 0.125 + 0.075 = 0.20
    assert.ok(Math.abs(total.totalCostUsd - 0.65) < 1e-9);
    assert.equal(total.inputTokens, 150000);
    assert.equal(total.outputTokens, 15000);
    assert.equal(total.callCount, 2);
    assert.equal(total.unknownCostCalls, 0);

    const byProvider = aggregateCost({ groupBy: "provider", wiId: wi.id });
    const byProviderKeys = byProvider.groups.map((g) => g.key).sort();
    assert.deepEqual(byProviderKeys, ["claude", "codex"]);
    const codexRow = byProvider.groups.find((g) => g.key === "codex");
    assert.ok(Math.abs(codexRow.costUsd - 0.20) < 1e-9);
  });

  it("topWorkItemCosts reports a complete grand total beyond the displayed top list", async () => {
    const { topWorkItemCosts, aggregateCost } = await import("../../../lib/domains/billing/functions/cost.js");
    const { queueMod, dbMod } = runtimeModules;
    const rdb = dbMod.getDb();

    for (let i = 0; i < 45; i += 1) {
      const wi = queueMod.createWorkItem(`Top cost ${i}`, "cost report total");
      rdb.prepare(`
        INSERT INTO agent_calls (work_item_id, role, model_tier, model_name, provider,
          input_tokens, output_tokens, cost_estimate_usd, status)
        VALUES (?, 'dev', 'standard', 'sonnet', 'claude', 0, 0, 1, 'succeeded')
      `).run(wi.id);
    }

    const top = topWorkItemCosts({ limit: 20 });
    const aggregate = aggregateCost({ groupBy: "wi" });
    assert.equal(top.workItems.length, 20);
    assert.equal(top.truncated, true);
    assert.equal(top.totalCostUsd, 45);
    assert.equal(top.totalCostUsd, aggregate.totalCostUsd);
  });

  it("unknown-provider calls count as unknownCostCalls, not NaN", async () => {
    const { workItemCost } = await import("../../../lib/domains/billing/functions/cost.js");
    const { queueMod, dbMod } = runtimeModules;
    const rdb = dbMod.getDb();
    const wi = queueMod.createWorkItem("Unknown", "no pricing for this");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "dev" });
    rdb.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, model_name, provider,
        input_tokens, output_tokens, status, duration_ms)
      VALUES (?, ?, 'dev', 'standard', 'zzz', 'mystery', 1000, 1000, 'succeeded', 500)
    `).run(wi.id, job.id);

    const total = workItemCost(wi.id);
    assert.equal(total.totalCostUsd, 0);
    assert.equal(total.unknownCostCalls, 1);
    assert.equal(Number.isFinite(total.totalCostUsd), true);
  });

  it("timeline WI totals include tokens and cost from orphan (no attempt_id) calls", async () => {
    const { buildTimeline } = await import("../../../lib/domains/observability/functions/timeline/index.js");
    const { queueMod, dbMod } = runtimeModules;
    const rdb = dbMod.getDb();
    const wi = queueMod.createWorkItem("Orphan totals", "calls without attempt_id");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "dev" });
    // attempt_id left null on purpose — matches real-world data from adapters.
    rdb.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, model_name, provider,
        input_tokens, output_tokens, status, duration_ms)
      VALUES (?, ?, 'dev', 'strong', 'gpt-5.4', 'codex', 1000000, 10000, 'succeeded', 1000)
    `).run(wi.id, job.id);

    const data = buildTimeline(wi.id);
    assert.equal(data.summary.agentCallCount, 1);
    // Long-context gpt-5.4: 1M * $5/M + 10k * $22.50/M = $5 + $0.225
    assert.ok(Math.abs(data.summary.totalCostUsd - 5.225) < 1e-9);
    assert.equal(data.summary.totalInputTokens, 1000000);
    assert.equal(data.summary.totalOutputTokens, 10000);
  });
});
