import {
  it,
  beforeEach,
  assert,
  path,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("findRunnableJobsBatch", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("returns jobs in the same order as repeated findRunnableJob calls", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Batch ordering", "desc");
    const low    = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "L", priority: "low" });
    const high   = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "H", priority: "high" });
    const urgent = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "U", priority: "urgent" });
    const normal = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "N", priority: "normal" });

    // Iterative path: call findRunnableJob with increasing excludeJobIds,
    // mimicking the pre-batch scheduler loop behavior.
    const iterative = [];
    const exclude = [];
    for (let i = 0; i < 10; i++) {
      const j = queueMod.findRunnableJob({ excludeJobIds: exclude });
      if (!j) break;
      iterative.push(j.id);
      exclude.push(j.id);
    }

    const batch = queueMod.findRunnableJobsBatch(10).map((j) => j.id);
    assert.deepEqual(batch, iterative);
    // Sanity: priority order — urgent, high, normal, low
    assert.deepEqual(batch, [urgent.id, high.id, normal.id, low.id]);
  });

  it("prioritizes assess-only and fix jobs ahead of normal dev at the same priority", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair ordering", "desc");
    const normal = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Normal dev", priority: "normal" });
    const fix = queueMod.createJob({ work_item_id: wi.id, job_type: "fix", title: "Fix dev", priority: "normal" });
    const assessOnly = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess orphan",
      priority: "normal",
      payload_json: JSON.stringify({ _assess_only: 1 }),
    });
    const assessTrue = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess boolean",
      priority: "normal",
      payload_json: { _assess_only: true },
    });
    const assessString = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess string",
      priority: "normal",
      payload_json: { _assess_only: "1" },
    });

    const batch = queueMod.findRunnableJobsBatch(10).map((j) => j.id);
    assert.deepEqual(batch, [assessOnly.id, assessTrue.id, assessString.id, fix.id, normal.id]);
  });

  it("respects the limit argument", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Batch limit", "desc");
    for (let i = 0; i < 8; i++) {
      queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: `J${i}` });
    }
    assert.equal(queueMod.findRunnableJobsBatch(3).length, 3);
    assert.equal(queueMod.findRunnableJobsBatch(100).length, 8);
  });

  it("respects excludeJobIds and excludeWorkItemIds", () => {
    const { queueMod } = runtimeModules;
    const wiA = queueMod.createWorkItem("Batch exclude A", "desc");
    const wiB = queueMod.createWorkItem("Batch exclude B", "desc");
    const a1 = queueMod.createJob({ work_item_id: wiA.id, job_type: "dev", title: "A1" });
    const a2 = queueMod.createJob({ work_item_id: wiA.id, job_type: "dev", title: "A2" });
    const b1 = queueMod.createJob({ work_item_id: wiB.id, job_type: "dev", title: "B1" });

    const skipIds = queueMod.findRunnableJobsBatch(10, { excludeJobIds: [a1.id] }).map((j) => j.id);
    assert.ok(!skipIds.includes(a1.id));
    assert.ok(skipIds.includes(a2.id) && skipIds.includes(b1.id));

    const skipWis = queueMod.findRunnableJobsBatch(10, { excludeWorkItemIds: [wiA.id] }).map((j) => j.id);
    assert.deepEqual(skipWis, [b1.id]);
  });

  it("skips jobs with unmet hard deps and returns them once the dep succeeds", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Batch deps", "desc");
    const dep = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Dep" });
    const blocked = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Blocked" });
    queueMod.addDependency(blocked.id, dep.id, "hard");

    let batch = queueMod.findRunnableJobsBatch(10).map((j) => j.id);
    assert.deepEqual(batch, [dep.id]); // blocked is filtered out

    queueMod.updateJobStatus(dep.id, "succeeded");
    batch = queueMod.findRunnableJobsBatch(10).map((j) => j.id);
    assert.ok(batch.includes(blocked.id));
  });

  it("findRunnableJob wraps the batch query (returns same first row)", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Single wraps batch", "desc");
    queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "L", priority: "low" });
    const first = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "U", priority: "urgent" });
    queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "H", priority: "high" });

    const single = queueMod.findRunnableJob();
    const batchHead = queueMod.findRunnableJobsBatch(10)[0];
    assert.equal(single.id, batchHead.id);
    assert.equal(single.id, first.id);
  });
});
