import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SpawnPolicy } from "../lib/shared/policies/classes/SpawnPolicy.js";
import { RetryPolicy } from "../lib/shared/policies/classes/RetryPolicy.js";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

describe("policies class contract", () => {
  it("keeps policy classes in lib/shared/policies/classes", () => {
    const expected = [
      path.join(repoDir, "lib", "shared", "policies", "classes", "SpawnPolicy.js"),
      path.join(repoDir, "lib", "shared", "policies", "classes", "RetryPolicy.js"),
    ];
    for (const file of expected) {
      assert.equal(fs.existsSync(file), true, `missing class file: ${file}`);
    }
  });

  it("resolves spawn policies by role and supports role-class names", () => {
    const planner = SpawnPolicy.for("PlannerRole");
    const dev = SpawnPolicy.for("dev");
    assert.equal(planner.canSpawn("delegate", "succeeded"), true);
    assert.equal(planner.canSpawn("human_input", "failed"), true);
    assert.equal(dev.canSpawn("promote", "succeeded"), false);
    assert.match(planner.describe(), /planner/);
  });

  it("computes retry/backoff behavior deterministically", () => {
    const policy = new RetryPolicy({
      maxAttempts: 4,
      baseBackoffSec: 10,
      capBackoffSec: 40,
    });
    assert.equal(policy.shouldRetry(1), true);
    assert.equal(policy.shouldRetry(4), false);
    assert.equal(policy.backoffFor(1), 10);
    assert.equal(policy.backoffFor(2), 20);
    assert.equal(policy.backoffFor(4), 40);
    assert.equal(policy.escalateTier("cheap", 2), "standard");
    assert.equal(policy.escalateTier("standard", 3), "strong");
  });
});

