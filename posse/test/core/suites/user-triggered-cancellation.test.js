import {
  it,
  before,
  beforeEach,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  stubWorkerRole,
  makeWorker,
} from "../support/core-harness.js";

let db;

suite("User-triggered cancellation", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("cancels a killed running job instead of requeueing it", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Cancelable job", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Cancelable job",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    stubWorkerRole(worker, "research", async () => {
      throw Object.assign(new Error("aborted"), { _killReason: "user_canceled" });
    });

    await worker.execute(leasedJob);

    const refreshed = queueMod.getJob(job.id);
    const attempts = queueMod.getAttempts(job.id);
    assert.equal(refreshed.status, "canceled");
    assert.equal(attempts.at(-1)?.status, "canceled");
    assert.equal(refreshed.lease_token, null);
  });

  it("does not mark a canceled job canceled when lease release fails", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Cancelable stale lease", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Cancelable stale lease",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    stubWorkerRole(worker, "research", async () => {
      throw Object.assign(new Error("aborted"), { _killReason: "user_canceled" });
    });
    worker._releaseLease = () => false;

    await worker.execute(leasedJob);

    const refreshed = queueMod.getJob(job.id);
    assert.notEqual(refreshed.status, "canceled");
    assert.equal(refreshed.lease_token, lease.leaseToken);
  });

  it("requeues nudged jobs without consuming an attempt", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Nudge retry", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Nudge retry",
    });
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: job.id,
      artifact_type: "nudge",
      content_long: "Use the migration path instead.",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    stubWorkerRole(worker, "research", async () => {
      throw Object.assign(new Error("aborted"), { _killReason: "user_nudge" });
    });

    await worker.execute(leasedJob);

    const refreshed = queueMod.getJob(job.id);
    const attempts = queueMod.getAttempts(job.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.attempt_count, 0);
    assert.equal(refreshed.lease_token, null);
    assert.equal(attempts.at(-1)?.status, "interrupted");
    assert.match(attempts.at(-1)?.error_text || "", /nudged by user/i);
  });

  it("does not refund attempts when a nudged job loses its lease before requeue", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Nudge stale lease", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Nudge stale lease",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
      releaseLeaseWithoutAttemptPenalty: () => false,
    });

    stubWorkerRole(worker, "research", async () => {
      throw Object.assign(new Error("aborted"), { _killReason: "user_nudge" });
    });

    await worker.execute(leasedJob);

    assert.equal(queueMod.getJob(job.id).attempt_count, 1);
  });

  it("does not mark a successful plan job succeeded when lease release fails", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Plan stale lease", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: stale lease success",
      provider: "codex",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async () => ({
      output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"files_to_create":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
      stats: {},
    }));
    worker._releaseLease = () => false;

    await worker.execute(leasedJob);

    const refreshed = queueMod.getJob(job.id);
    assert.notEqual(refreshed.status, "succeeded");
    assert.equal(refreshed.lease_token, lease.leaseToken);
  });
});
