import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveTaskExecutionPolicy } from "../lib/domains/handoff/functions/helpers/execution-policy.js";

describe("execution policy risk-tag effort floor", () => {
  it("softens the critical-tag floor for a small, tested, low-planner-risk task", () => {
    // Modeled on wi-137 job 1034: doc-comment + MIME-string fix tagged
    // "security" with planner risk 2 — must not run at high effort.
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 2,
        risk_tags: ["security"],
        scope_confidence: "high",
        files_to_modify: ["www/includes/classes/Media/MediaUploadPolicy.php"],
        test_command: "php run-tests.php",
      },
    });
    assert.equal(policy.risk_floor_softened, true);
    assert.equal(policy.risk_score, 3);
    assert.notEqual(policy.dev.reasoning_effort, "high");
  });

  it("keeps the full floor when the planner itself scores the risk high", () => {
    // Modeled on wi-137 job 1033: the real IDOR fix.
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 4,
        risk_tags: ["auth", "security", "persistence"],
        scope_confidence: "high",
        files_to_modify: ["www/includes/classes/Flow/FlowManager.php"],
        test_command: "php run-tests.php",
      },
    });
    assert.equal(policy.risk_floor_softened, undefined);
    assert.equal(policy.dev.reasoning_effort, "high");
  });

  it("keeps the full floor when planner risk is 3+ even with contained scope", () => {
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 3,
        risk_tags: ["persistence", "schema"],
        scope_confidence: "medium",
        files_to_modify: ["www/livevane.com/api/flows/index.php"],
        test_command: "php run-tests.php",
      },
    });
    assert.equal(policy.risk_floor_softened, undefined);
    assert.equal(policy.risk_score >= 4, true);
    assert.equal(policy.dev.reasoning_effort, "high");
  });

  it("does not soften without a test command", () => {
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 2,
        risk_tags: ["security"],
        scope_confidence: "high",
        files_to_modify: ["src/one-file.js"],
      },
    });
    assert.equal(policy.risk_floor_softened, undefined);
    assert.equal(policy.dev.reasoning_effort, "high");
  });

  it("does not soften on low scope confidence", () => {
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 1,
        risk_tags: ["auth"],
        scope_confidence: "low",
        files_to_modify: ["src/one-file.js"],
        test_command: "npm test",
      },
    });
    assert.equal(policy.risk_floor_softened, undefined);
    assert.equal(policy.dev.reasoning_effort, "high");
  });

  it("preserves the cheap/low fast path for small low-risk tested tasks without tags", () => {
    const policy = resolveTaskExecutionPolicy({
      task: {
        planner_risk_score: 1,
        scope_confidence: "high",
        files_to_modify: ["src/one-file.js"],
        test_command: "npm test",
      },
    });
    assert.equal(policy.dev.model_tier, "cheap");
    assert.equal(policy.dev.reasoning_effort, "low");
  });
});
