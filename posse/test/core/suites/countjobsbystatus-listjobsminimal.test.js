import {
  it,
  beforeEach,
  assert,
  path,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("countJobsByStatus + listJobsMinimal", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("countJobsByStatus returns grouped counts matching direct queries", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Counts", "desc");
    const q1 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Q1" });
    const q2 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Q2" });
    const f1 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "F1" });
    queueMod.updateJobStatus(f1.id, "failed");

    const counts = queueMod.countJobsByStatus();
    assert.equal(counts.queued, 2);
    assert.equal(counts.failed, 1);
    assert.equal(counts.succeeded || 0, 0);

    // hasJobs should agree with snapshot presence check
    assert.equal(queueMod.hasJobs(["queued"]), (counts.queued || 0) > 0);
    assert.equal(queueMod.hasJobs(["succeeded"]), (counts.succeeded || 0) > 0);
  });

  it("listJobsMinimal returns the column subset scheduler needs", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Minimal cols", "desc");
    const j = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Minimal",
      payload_json: JSON.stringify({ files_to_modify: ["a.js"] }),
    });

    const rows = queueMod.listJobsMinimal(["queued"]);
    assert.equal(rows.length, 1);
    const row = rows[0];
    // Required columns for _collectHeldMutationLocks + display
    assert.equal(row.id, j.id);
    assert.equal(row.work_item_id, wi.id);
    assert.equal(row.job_type, "dev");
    assert.equal(row.status, "queued");
    assert.ok(typeof row.payload_json === "string" && row.payload_json.includes("a.js"));
    assert.ok("priority" in row && "created_at" in row && "updated_at" in row);
  });

  it("findRunnableJobsBatch is bounded on a deep conflict-heavy queue", () => {
    // Guards against regressing to the pre-batch behavior where the scheduler
    // called findRunnableJob() up to 25 times per tick. A single batch fetch
    // on a 200-row queue must stay fast and capped at the requested limit.
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Deep queue", "desc");
    for (let i = 0; i < 200; i++) {
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: `J${i}`,
        payload_json: JSON.stringify({ files_to_modify: ["shared.js"] }),
      });
    }

    const start = Date.now();
    const batch = queueMod.findRunnableJobsBatch(25);
    const elapsedMs = Date.now() - start;

    assert.equal(batch.length, 25);
    // Generous cap: a single indexed LIMIT 25 should land well under 500ms
    // even on slow CI. Before batching, this path did 25 separate queries.
    assert.ok(elapsedMs < 500, `batch fetch took ${elapsedMs}ms on 200-job queue`);
  });

  it("listJobsMinimal accepts a single status or array filter", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Filter forms", "desc");
    queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "A" });
    const bJob = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "B" });
    queueMod.updateJobStatus(bJob.id, "leased");

    assert.equal(queueMod.listJobsMinimal("queued").length, 1);
    assert.equal(queueMod.listJobsMinimal(["queued", "leased"]).length, 2);
    assert.equal(queueMod.listJobsMinimal([]).length, 0);
    assert.equal(queueMod.listJobsMinimal().length, 2); // no filter = all
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: Tier Escalation (claude.js)
// ═════════════════════════════════════════════════════════════════════════════
