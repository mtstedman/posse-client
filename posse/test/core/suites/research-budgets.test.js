import {
  it,
  assert,
  suite,
  getResearchBudget,
  isDeepthinkTask,
  researchBudgetToReasoningEffort,
} from "../support/core-harness.js";

let db;

suite("Research budgets", () => {
  it("normalizes budget payloads and preserves the deepthink shim", () => {
    const workItem = {
      metadata_json: JSON.stringify({ deepthink_budget: "xhigh" }),
    };

    assert.equal(getResearchBudget(workItem), "xhigh");
    assert.equal(isDeepthinkTask(workItem), true);
    assert.equal(researchBudgetToReasoningEffort("xhigh"), "high");
    assert.equal(getResearchBudget(null, { deepthink_budget: "low" }), "low");
    assert.equal(isDeepthinkTask(null, { deepthink_budget: "low" }), false);
    assert.equal(getResearchBudget(null, { deepthink: true }), "high");
    assert.equal(getResearchBudget(null, { research_budget: "medium" }), "normal");
  });
});
