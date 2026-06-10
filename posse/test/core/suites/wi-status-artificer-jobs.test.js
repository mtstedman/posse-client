import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

suite("WI Status — Artificer Jobs", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("WI completes when all jobs (including artificer) succeed", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Artificer success", "desc");
    const dev = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Dev" });
    const art = queueMod.createJob({ work_item_id: wi.id, job_type: "artificer", title: "Artificer" });
    queueMod.updateJobStatus(dev.id, "succeeded");
    queueMod.updateJobStatus(art.id, "succeeded");

    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "complete");
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("WI fails when artificer dead-letters", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Artificer dead-letter", "desc");
    const dev = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Dev" });
    const art = queueMod.createJob({ work_item_id: wi.id, job_type: "artificer", title: "Artificer" });
    queueMod.updateJobStatus(dev.id, "succeeded");
    queueMod.updateJobStatus(art.id, "dead_letter");

    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "failed");
    assert.equal(queueMod.getWorkItem(wi.id).status, "failed");
  });
});
