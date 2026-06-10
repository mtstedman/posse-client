import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ResearchSession } from "../lib/domains/research/classes/ResearchSession.js";

describe("research session class contract", () => {
  it("derives routing and branch reconciliation", () => {
    const session = new ResearchSession({
      workItem: {
        id: 7,
        title: "Investigate auth and billing regressions",
        description: "Compare auth module, billing module, and queue processing behavior.",
      },
      intakeHints: { mode: "build" },
      projectMap: null,
    });
    const routing = session.routing();
    const branches = session.fanoutBranches();
    const reconcile = session.reconcile([
      { status: "succeeded" },
      { status: "failed" },
    ]);

    assert.equal(typeof routing.bucket, "string");
    assert.equal(Array.isArray(branches), true);
    assert.deepEqual(reconcile, {
      branchCount: 2,
      successCount: 1,
      failedCount: 1,
    });
  });
});
