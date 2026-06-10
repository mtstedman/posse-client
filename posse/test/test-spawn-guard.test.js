import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertCanSpawnFromRole, canSpawnFromRole, spawnFromRole } from "../lib/domains/worker/functions/spawn-guard.js";

describe("spawn guard", () => {
  it("allows declared instance spawn pools", () => {
    const role = {
      getRole: () => "planner",
      canSpawn: (jobType, outcome) => outcome === "succeeded" && jobType === "dev",
    };

    const job = spawnFromRole(role, "succeeded", "dev", {
      work_item_id: 1,
      title: "Dev task",
    }, (payload) => ({ id: 1, ...payload }));

    assert.equal(job.job_type, "dev");
    assert.equal(job.title, "Dev task");
  });

  it("supports static role metadata and rejects undeclared spawns", () => {
    class ExampleRole {
      static role = "example";
      static spawnsOnSuccess = ["promote"];
      static spawnsOnFailure = ["human_input"];
    }

    assert.equal(canSpawnFromRole(ExampleRole, "succeeded", "promote"), true);
    assert.equal(canSpawnFromRole(ExampleRole, "failed", "human_input"), true);
    assert.throws(
      () => assertCanSpawnFromRole(ExampleRole, "failed", "dev"),
      /example cannot spawn dev after failed/,
    );
  });

  it("rejects mismatched payload job_type", () => {
    class ExampleRole {
      static role = "example";
      static spawnsOnSuccess = ["dev"];
    }

    assert.throws(
      () => spawnFromRole(ExampleRole, "succeeded", "dev", { job_type: "fix" }, (payload) => payload),
      /job_type mismatch/,
    );
  });

  it("rejects unknown spawn outcomes", () => {
    class ExampleRole {
      static role = "example";
      static spawnsOnFailure = ["human_input"];
    }

    assert.throws(
      () => canSpawnFromRole(ExampleRole, "stalled", "human_input"),
      /outcome must be "succeeded" or "failed"/,
    );
  });
});
