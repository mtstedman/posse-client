import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCurrentRoleContract } from "../lib/domains/worker/functions/role-contract-view.js";

describe("role contract view", () => {
  it("reconstructs a current-code contract for class-backed job types", () => {
    const preview = buildCurrentRoleContract({
      job: {
        id: 1,
        job_type: "research",
        work_item_id: 1,
        payload_json: "{}",
        title: "Research: preview",
      },
      providerName: "claude",
      projectDir: process.cwd(),
    });

    assert.equal(preview.role, "researcher");
    assert.equal(typeof preview.contract, "string");
  });

  it("returns an empty contract for unknown job types", () => {
    assert.deepEqual(buildCurrentRoleContract({
      job: { job_type: "human_input" },
      providerName: "claude",
    }), { role: null, contract: "" });
  });
});
