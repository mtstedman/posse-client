import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Delegation persistence", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("clears stale model_name when delegation switches provider without a model override", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Clear stale model", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Implement feature",
      provider: "grok",
      model_name: "grok-code-fast-1",
    });

    queueMod.applyDelegation(job.id, { provider: "codex", model: null });
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.provider, "codex");
    assert.equal(refreshed.model_name, null);
  });
});
