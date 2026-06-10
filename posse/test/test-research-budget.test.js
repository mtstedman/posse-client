import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getResearchBudget,
  normalizeResearchBudget,
  researchBudgetToMaxTurnsOverride,
  researchBudgetToReasoningEffort,
} from "../lib/domains/worker/functions/helpers/role-utils.js";

describe("research budget helpers", () => {
  it("keeps payload budget ahead of work item metadata", () => {
    const workItem = {
      metadata_json: JSON.stringify({ deepthink_budget: "xhigh", deepthink: true }),
    };

    assert.equal(getResearchBudget(workItem, { deepthink_budget: "low" }), "low");
    assert.equal(getResearchBudget(workItem, { research_budget: "medium" }), "normal");
  });

  it("pins legacy deepthink to high and keeps xhigh explicit", () => {
    assert.equal(getResearchBudget(null, { deepthink: true }), "high");
    assert.equal(normalizeResearchBudget("ultrathink"), "xhigh");
    assert.equal(researchBudgetToReasoningEffort("xhigh"), "high");
  });

  it("maps xhigh to per-role max-turn overrides", () => {
    assert.equal(researchBudgetToMaxTurnsOverride("xhigh", "researcher"), 46);
    assert.equal(researchBudgetToMaxTurnsOverride("xhigh", "researcher", { roleMode: "child" }), 24);
    assert.equal(researchBudgetToMaxTurnsOverride("xhigh", "planner"), 18);
    assert.equal(researchBudgetToMaxTurnsOverride("high", "researcher"), null);
  });
});
