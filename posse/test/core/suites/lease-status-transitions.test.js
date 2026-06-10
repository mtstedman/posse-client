import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  futureTs,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Lease status transitions", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("keeps lease fields on waiting_on_review until explicitly released", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease waiting_on_review", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Needs review",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assert.equal(queueMod.updateJobStatus(job.id, "waiting_on_review", { leaseToken: lease.leaseToken }), true);
    const parked = queueMod.getJob(job.id);
    assert.equal(parked.status, "waiting_on_review");
    assert.equal(parked.lease_token, lease.leaseToken);

    const released = queueMod.releaseLease(job.id, lease.leaseToken, "waiting_on_review");
    assert.equal(released, true);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "waiting_on_review");
    assert.equal(refreshed.lease_token, null);
  });

  it("rejects status updates for lease-held jobs without the matching token", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease guarded status", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Requires token",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assert.equal(queueMod.updateJobStatus(job.id, "succeeded"), false);
    assert.equal(queueMod.updateJobStatus(job.id, "succeeded", { leaseToken: "wrong-token" }), false);

    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "leased");
    assert.equal(refreshed.lease_token, lease.leaseToken);
  });

  it("clears lease fields immediately for token-checked succeeded jobs", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease succeeded", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Passes",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assert.equal(queueMod.updateJobStatus(job.id, "succeeded", { leaseToken: lease.leaseToken }), true);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "succeeded");
    assert.equal(refreshed.lease_token, null);
  });

  it("allows explicit force status updates for admin cancellations", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease force cancel", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Force cancel",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assert.equal(queueMod.forceUpdateJobStatus(job.id, "canceled"), true);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "canceled");
    assert.equal(refreshed.lease_token, null);
  });

  it("does not write stale assessor verdict metadata when the lease token is rejected", () => {
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease guarded verdict", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Reject stale verdict",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assessorMod.processVerdict(job, {
      verdict: "pass",
      confidence: "high",
      reasons: ["looks good"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {}, leaseToken: "wrong-token" });

    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "leased");
    assert.equal(refreshed.lease_token, lease.leaseToken);
    assert.equal(refreshed.assessor_verdict, "not_assessed");
    assert.equal(refreshed.assessor_confidence, null);
    assert.equal(queueMod.getEvents(job.id, 20).some((e) => e.event_type === "job.assessed"), false);
  });

  it("does not requeue or mutate payload for stale internal assessment retry tokens", () => {
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease guarded retry", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Reject stale retry",
      model_tier: "cheap",
      payload_json: JSON.stringify({ task_spec: "return valid assessor JSON" }),
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    assessorMod.processVerdict(job, {
      verdict: "needs_review",
      confidence: "high",
      reasons: ["retry assessor with stronger model"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {}, leaseToken: "wrong-token" });

    const refreshed = queueMod.getJob(job.id);
    const payload = JSON.parse(refreshed.payload_json);
    assert.equal(refreshed.status, "leased");
    assert.equal(refreshed.lease_token, lease.leaseToken);
    assert.equal(refreshed.model_tier, "cheap");
    assert.equal(payload._assess_only, undefined);
    assert.equal(payload._assess_model_tier, undefined);
    assert.equal(refreshed.assessor_verdict, "not_assessed");
    const events = queueMod.getEvents(job.id, 20);
    assert.equal(events.some((e) => e.event_type === "job.assessed"), false);
    assert.equal(events.some((e) => e.event_type === "job.assessment_internal_retry"), false);
  });

  it("clears stale last_error when a leased job succeeds", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease success clears error", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Eventually succeeds",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);
    queueMod.setJobError(job.id, "stale retry warning");

    assert.equal(queueMod.releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "succeeded");
    assert.equal(refreshed.last_error, null);
  });

  it("clears stale last_error when a later attempt stores a result", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Result clears error", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Eventually writes result",
    });

    queueMod.setJobError(job.id, "stale blocked attempt");
    queueMod.setJobResult(job.id, { output_length: 10, attempt: 2 });

    const refreshed = queueMod.getJob(job.id);
    assert.deepEqual(JSON.parse(refreshed.result_json), { output_length: 10, attempt: 2 });
    assert.equal(refreshed.last_error, null);
  });

  it("treats expired matching lease tokens as invalid", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Lease expired", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Expired lease",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);

    db.prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`).run("2000-01-01T00:00:00.000Z", job.id);

    assert.equal(queueMod.isLeaseValid(job.id, lease.leaseToken), false);
    assert.equal(queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "developer"), null);
    assert.equal(queueMod.renewLease(job.id, lease.leaseToken, 900), false);
  });

  it("uses the lease clock for read-side validity checks", () => {
    const { queueMod, dbMod } = runtimeModules;
    const leaseNowMs = Date.parse("2030-01-01T00:00:00.000Z");
    queueMod.__testSetLeaseClockForTests({
      wallNowMs: () => leaseNowMs,
      monotonicNowMs: () => 0,
    });
    try {
      const wi = queueMod.createWorkItem("Lease clock read gates", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Expired by lease clock",
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      assert.ok(lease?.leaseToken);

      dbMod.getDb()
        .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
        .run("2029-12-31T23:59:59.000Z", job.id);

      assert.equal(queueMod.isLeaseValid(job.id, lease.leaseToken), false);
      assert.equal(queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "developer"), null);
    } finally {
      queueMod.__testSetLeaseClockForTests(null);
    }
  });

  it("releases and decrements attempts together for penalty-free requeues", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease no-penalty release", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "No-penalty release",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    assert.ok(lease?.leaseToken);
    queueMod.incrementAttemptCount(job.id);

    const released = queueMod.releaseLeaseWithoutAttemptPenalty(job.id, lease.leaseToken, "queued", {
      readyAt: futureTs(),
    });
    assert.equal(released, true);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.lease_token, null);
    assert.equal(refreshed.attempt_count, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: Deadlock Detection
// ═════════════════════════════════════════════════════════════════════════════
