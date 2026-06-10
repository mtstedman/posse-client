import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectInsightAnchors,
  enrichDecisionAnchorsWithAtlas2Slice,
  evaluateInsightPromotion,
  triggerInsightPromotion,
  __test as promotionTest,
} from "../lib/domains/worker/functions/helpers/insight-promotion.js";
import {
  __test as insightsStep0Test,
} from "../lib/domains/handoff/functions/helpers/insights-step0.js";
import { getInsightById, storeInsight } from "../lib/domains/queue/functions/index.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

async function waitFor(predicate, label = "condition") {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("insight promotion gates", () => {
  it("rejects canned action strings before they become durable memories", () => {
    const result = evaluateInsightPromotion({
      insight: {
        insight_type: "pattern",
        summary: "generic",
        detail: "generic",
        action: "Use the prior failure/success path as a caution note, but validate against the current task before applying it.",
        file_paths: JSON.stringify(["lib/a.js"]),
      },
    });
    assert.equal(result.promote, false);
    assert.equal(result.reason, "canned_action");
  });

  it("promotes anchored human guidance as durable memory content", () => {
    const result = evaluateInsightPromotion({
      workItemStatus: "complete",
      insight: {
        insight_type: "human_override",
        summary: "Human guidance",
        detail: "Q: How handle scans?\nA: Prefer fire-and-forget orchestration for background scans.",
        action: "Follow this human guidance when it applies to the current task or files.",
        confidence: "high",
        file_paths: null,
      },
    });
    assert.equal(result.promote, true);
    assert.equal(result.gate, "human_anchored_guidance");
    assert.match(result.futureAction, /fire-and-forget/);
    assert.equal(result.confidence, 0.85);
  });

  it("rejects unanchored non-human insights", () => {
    const result = evaluateInsightPromotion({
      insight: {
        insight_type: "failure",
        summary: "failed",
        detail: "same error repeated",
        action: "Retry only after confirming TypeError details in the log.",
        confidence: "high",
        file_paths: null,
      },
    });
    assert.equal(result.promote, false);
    assert.equal(result.reason, "unanchored");
  });

  it("promotes clean success only when it has concrete scope and verification signal", () => {
    const result = evaluateInsightPromotion({
      workItemStatus: "complete",
      insight: {
        insight_type: "pattern",
        insight_kind: "success_pattern",
        summary: "clean success",
        detail: "Test command: npm test -- handoff\nScope: lib/handoff.js",
        action: "When changing this scope, use the recorded verification path: npm test -- handoff",
        confidence: "medium",
        source: "clean_success",
        file_paths: JSON.stringify(["lib/handoff.js"]),
      },
    });
    assert.equal(result.promote, true);
    assert.equal(result.gate, "successful_pattern");
    assert.equal(result.memoryType, "pattern");
  });

  it("extracts symbol and file anchors from ATLAS slice cards", () => {
    const anchors = collectInsightAnchors({
      insight: { file_paths: JSON.stringify(["lib/a.js"]) },
      payload: {
        atlas_slice_candidates: {
          cards: [{ symbolId: "sym:1", file: "lib/b.js" }],
        },
      },
    });
    assert.deepEqual(anchors.symbolIds, ["sym:1"]);
    assert.deepEqual(anchors.fileRelPaths.sort(), ["lib/a.js", "lib/b.js"]);
  });

  it("defaults promotion writes to shadow mode", () => {
    assert.equal(promotionTest.promotionMode({ settingReader: () => null }), "shadow");
    assert.equal(promotionTest.promotionMode({ settingReader: () => "write" }), "write");
    assert.equal(promotionTest.promotionMode({ settingReader: () => "off" }), "off");
  });

  it("rejects promotable-but-generic future actions", () => {
    const result = evaluateInsightPromotion({
      insight: {
        insight_type: "failure",
        summary: "same structural issue repeated",
        detail: "same error repeated across attempts",
        action: "Use the safer path next time.",
        confidence: "high",
        file_paths: JSON.stringify(["lib/a.js"]),
      },
    });
    assert.equal(result.promote, false);
    assert.equal(result.reason, "generic_future_action");
  });

  it("reports no_promotion_gate for anchored but weak insight types", () => {
    const result = evaluateInsightPromotion({
      insight: {
        insight_type: "note",
        summary: "FYI only",
        detail: "lib/a.js had incidental discussion",
        action: "Check lib/a.js before changing Widget.render.",
        confidence: "medium",
        file_paths: JSON.stringify(["lib/a.js"]),
      },
    });
    assert.equal(result.promote, false);
    assert.equal(result.reason, "no_promotion_gate");
  });

  it("keeps already-processed insight promotions idempotent", () => {
    assert.equal(promotionTest.shouldSkipExistingPromotion({ promotion_status: "promoted" }), true);
    assert.equal(promotionTest.shouldSkipExistingPromotion({ promotion_status: "shadow" }), true);
    assert.equal(promotionTest.shouldSkipExistingPromotion({ promotion_status: "pending" }), false);
    assert.equal(promotionTest.shouldSkipExistingPromotion({ promotion_status: "pending", promotion_reason: "successful_pattern" }), true);
  });

  it("claims write-mode promotion once before storing ATLAS memory", async () => withTempRuntimeDb(async () => {
    const id = storeInsight({
      insight_type: "pattern",
      insight_kind: "success_pattern",
      summary: "Reliable scoped verification",
      detail: "Test command: npm test -- handoff\nScope: lib/handoff.js",
      action: "When changing lib/handoff.js, run npm test -- handoff before handing off.",
      confidence: "high",
      source: "clean_success",
      file_paths: ["lib/handoff.js"],
    });
    assert.ok(id);

    let storeCalls = 0;
    const memoryClient = {
      ok: true,
      call: async (action) => {
        if (action === "memory.query") return { content: [{ text: JSON.stringify({ memories: [] }) }] };
        if (action === "memory.store") {
          storeCalls += 1;
          return { content: [{ text: JSON.stringify({ memoryId: `mem-${storeCalls}` }) }] };
        }
        throw new Error(`unexpected action ${action}`);
      },
    };
    const args = {
      insight: getInsightById(id),
      workItemStatus: "complete",
      settingReader: () => "write",
      insightFetcher: getInsightById,
      memoryClient,
      atlasToolRunner: async () => ({ ok: false, error: "not needed" }),
    };

    const first = triggerInsightPromotion(args);
    const second = triggerInsightPromotion(args);

    assert.equal(first.mode, "write");
    assert.equal(second.skipped, "already_processed");
    await waitFor(() => getInsightById(id)?.promotion_status === "promoted", "promotion completion");

    const row = getInsightById(id);
    assert.equal(storeCalls, 1);
    assert.equal(row.promotion_status, "promoted");
    assert.equal(row.promoted_memory_id, "mem-1");
  }));

  it("enriches file-only promotion anchors with ATLAS2 slice symbol ids", async () => {
    let observed = null;
    const decision = await enrichDecisionAnchorsWithAtlas2Slice({
      promote: true,
      futureAction: "Check lib/a.js before changing Widget.render.",
      anchors: {
        fileRelPaths: ["lib/a.js"],
        symbolIds: [],
      },
    }, {
      cwd: process.cwd(),
      payload: { task_spec: "Update Widget render path" },
      atlasToolRunner: async (action, args, opts) => {
        observed = { action, args, opts };
        return JSON.stringify({
          ok: true,
          action: "slice.build",
          data: {
            cards: [{ symbolId: "abc123:Widget.render", repo_rel_path: "lib/a.js" }],
          },
        });
      },
    });

    assert.equal(observed.action, "slice.build");
    assert.deepEqual(observed.args.editedFiles, ["lib/a.js"]);
    assert.equal(observed.opts.origin, "kaizen-promotion");
    assert.deepEqual(decision.anchors.symbolIds, ["abc123:Widget.render"]);
  });

  it("keeps ATLAS memory surfacing off by default until a promotion exists", () => {
    assert.equal(insightsStep0Test.memorySurfaceEnabled({ hasPromotedMemories: false, settingReader: () => null }), false);
    assert.equal(insightsStep0Test.memorySurfaceEnabled({ hasPromotedMemories: true, settingReader: () => null }), true);
    assert.equal(insightsStep0Test.memorySurfaceEnabled({ hasPromotedMemories: false, settingReader: () => "on" }), true);
    assert.equal(insightsStep0Test.memorySurfaceEnabled({ hasPromotedMemories: true, settingReader: () => "off" }), false);
  });

  it("uses file paths as ATLAS memory.surface fallback and drops stale memories", () => {
    assert.deepEqual(insightsStep0Test.memorySurfaceArgs({
      symbolIds: [],
      fileRelPaths: ["lib/a.js"],
      limit: 9,
    }), {
      fileRelPaths: ["lib/a.js"],
      limit: 5,
    });
    const fresh = insightsStep0Test.normalizeSurfaceMemory({ memoryId: "fresh", title: "Fresh", stale: false });
    const stale = insightsStep0Test.normalizeSurfaceMemory({ memoryId: "stale", title: "Stale", stale: true });
    assert.deepEqual(insightsStep0Test.nonStaleSurfaceMemories([fresh, stale]).map((memory) => memory.memory_id), ["fresh"]);
  });
});
