import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  freshDb,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Dependency rewiring", () => {
  beforeEach(() => { db = freshDb(); });

  it("rewires a dependent to every spawned replacement in one transaction", () => {
    resetRuntimeDb();
    const queue = runtimeModules.queueMod;
    const wi = queue.createWorkItem("Transactional dependency rewrite", "desc");
    const failed = queue.createJob({ work_item_id: wi.id, title: "Failed", job_type: "dev" });
    const downstream = queue.createJob({ work_item_id: wi.id, title: "Downstream", job_type: "assess" });
    const fixOne = queue.createJob({ work_item_id: wi.id, title: "Fix one", job_type: "fix" });
    const fixTwo = queue.createJob({ work_item_id: wi.id, title: "Fix two", job_type: "fix" });
    queue.addDependency(downstream.id, failed.id, "hard");

    assert.equal(queue.rewireDependencyChain(downstream.id, failed.id, [fixOne.id, fixTwo.id], "hard"), true);

    const deps = queue.getDependencies(downstream.id)
      .map((dep) => dep.depends_on_job_id)
      .sort((a, b) => a - b);
    assert.deepEqual(deps, [fixOne.id, fixTwo.id].sort((a, b) => a - b));
    assert.equal(deps.includes(failed.id), false);
  });

  it("skips cycle-inducing replacements while keeping valid replacements", () => {
    resetRuntimeDb();
    const queue = runtimeModules.queueMod;
    const wi = queue.createWorkItem("Partial dependency rewrite", "desc");
    const failed = queue.createJob({ work_item_id: wi.id, title: "Failed", job_type: "dev" });
    const downstream = queue.createJob({ work_item_id: wi.id, title: "Downstream", job_type: "assess" });
    const validFix = queue.createJob({ work_item_id: wi.id, title: "Valid fix", job_type: "fix" });
    const cyclicFix = queue.createJob({ work_item_id: wi.id, title: "Cyclic fix", job_type: "fix" });
    queue.addDependency(downstream.id, failed.id, "hard");
    queue.addDependency(cyclicFix.id, downstream.id, "hard");

    const result = queue.rewireDependencyChain(
      downstream.id,
      failed.id,
      [validFix.id, cyclicFix.id],
      "hard",
      { returnDetails: true },
    );

    assert.equal(result.rewired, true);
    assert.deepEqual(result.inserted, [validFix.id]);
    assert.deepEqual(result.skipped, [{ id: cyclicFix.id, reason: "cycle" }]);
    const deps = queue.getDependencies(downstream.id).map((dep) => dep.depends_on_job_id);
    assert.deepEqual(deps, [validFix.id]);
    assert.equal(deps.includes(failed.id), false);
    assert.ok(queue.getEvents(downstream.id).some((event) => event.event_type === "job.dependency_cycle"));
  });

  it("leaves the old dependency intact when every replacement is refused", () => {
    resetRuntimeDb();
    const queue = runtimeModules.queueMod;
    const wi = queue.createWorkItem("Refused dependency rewrite", "desc");
    const failed = queue.createJob({ work_item_id: wi.id, title: "Failed", job_type: "dev" });
    const downstream = queue.createJob({ work_item_id: wi.id, title: "Downstream", job_type: "assess" });
    const cyclicFix = queue.createJob({ work_item_id: wi.id, title: "Cyclic fix", job_type: "fix" });
    queue.addDependency(downstream.id, failed.id, "hard");
    queue.addDependency(cyclicFix.id, downstream.id, "hard");

    const result = queue.rewireDependencyChain(
      downstream.id,
      failed.id,
      [cyclicFix.id],
      "hard",
      { returnDetails: true },
    );

    assert.equal(result.rewired, false);
    assert.deepEqual(result.inserted, []);
    assert.deepEqual(result.skipped, [{ id: cyclicFix.id, reason: "cycle" }]);
    const deps = queue.getDependencies(downstream.id).map((dep) => dep.depends_on_job_id);
    assert.deepEqual(deps, [failed.id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: refreshWorkItemStatus state machine
// ═════════════════════════════════════════════════════════════════════════════
