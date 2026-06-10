import {
  it,
  slowIt,
  before,
  beforeEach,
  after,
  assert,
  path,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Scheduler", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("rejects runLoop before successful boot", async () => {
    const { schedulerMod } = runtimeModules;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-not-booted", pollMs: 5, leaseSec: 60 });

    await assert.rejects(
      () => scheduler.runLoop(async () => {}),
      /before successful boot/,
    );
  });

  it("runtime retention prunes old telemetry rows and leaves fresh rows", async () => {
    const { runRuntimeRetention } = await import("../../../lib/domains/ui/functions/admin/retention.js");
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Retention WI", "desc");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Retention job" });
    queueMod.updateJobStatus(job.id, "succeeded");
    const parkedJob = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Parked retention job" });
    queueMod.updateJobStatus(parkedJob.id, "waiting_on_human");
    const oldTs = "2026-01-01T00:00:00.000Z";
    const freshTs = "2026-05-10T00:00:00.000Z";
    const nowMs = Date.parse("2026-05-17T00:00:00.000Z");

    db.prepare(`INSERT INTO events (work_item_id, job_id, event_type, actor_type, message, created_at) VALUES (?, ?, ?, 'system', ?, ?)`)
      .run(wi.id, job.id, "retention.old", "old", oldTs);
    db.prepare(`INSERT INTO events (work_item_id, job_id, event_type, actor_type, message, created_at) VALUES (?, ?, ?, 'system', ?, ?)`)
      .run(wi.id, job.id, "retention.fresh", "fresh", freshTs);
    db.prepare(`INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, status, created_at, started_at) VALUES (?, ?, 'dev', 'standard', 'succeeded', ?, ?)`)
      .run(wi.id, job.id, oldTs, oldTs);
    db.prepare(`INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, status, created_at, started_at) VALUES (?, ?, 'dev', 'standard', 'succeeded', ?, ?)`)
      .run(wi.id, job.id, freshTs, freshTs);
    db.prepare(`INSERT INTO job_observations (work_item_id, job_id, observation_type, summary, created_at) VALUES (?, ?, 'retention', 'old', ?)`)
      .run(wi.id, job.id, oldTs);
    db.prepare(`INSERT INTO job_observations (work_item_id, job_id, observation_type, summary, created_at) VALUES (?, ?, 'retention', 'fresh', ?)`)
      .run(wi.id, job.id, freshTs);
    db.prepare(`INSERT INTO artifacts (work_item_id, job_id, artifact_type, content_long, created_at) VALUES (?, ?, 'response', 'old-terminal', ?)`)
      .run(wi.id, job.id, oldTs);
    db.prepare(`INSERT INTO artifacts (work_item_id, job_id, artifact_type, content_long, created_at) VALUES (?, ?, 'response', 'fresh-terminal', ?)`)
      .run(wi.id, job.id, freshTs);
    db.prepare(`INSERT INTO artifacts (work_item_id, job_id, artifact_type, content_long, created_at) VALUES (?, ?, 'response', 'old-parked', ?)`)
      .run(wi.id, parkedJob.id, oldTs);
    db.prepare(`INSERT INTO job_attempts (job_id, attempt_number, worker_type, status, started_at, finished_at) VALUES (?, 1, 'dev', 'succeeded', ?, ?)`)
      .run(job.id, oldTs, oldTs);
    db.prepare(`INSERT INTO job_attempts (job_id, attempt_number, worker_type, status, started_at, finished_at) VALUES (?, 2, 'dev', 'succeeded', ?, ?)`)
      .run(job.id, freshTs, freshTs);
    db.prepare(`INSERT INTO job_attempts (job_id, attempt_number, worker_type, status, started_at) VALUES (?, 1, 'dev', 'running', ?)`)
      .run(parkedJob.id, oldTs);
    db.prepare(`INSERT INTO run_insights (work_item_id, job_id, insight_type, summary, created_at) VALUES (?, ?, 'decision', 'old', ?)`)
      .run(wi.id, job.id, oldTs);
    db.prepare(`INSERT INTO run_insights (work_item_id, job_id, insight_type, summary, created_at) VALUES (?, ?, 'decision', 'fresh', ?)`)
      .run(wi.id, job.id, freshTs);
    const laneId = db.prepare(`INSERT INTO session_lanes (work_item_id, lane, provider, status, created_at, updated_at) VALUES (?, 'dev', 'claude', 'active', ?, ?)`)
      .run(wi.id, oldTs, oldTs).lastInsertRowid;
    const sessionId = db.prepare(`INSERT INTO job_sessions (lane_id, work_item_id, lane, provider, handle, created_at, last_used_at) VALUES (?, ?, 'dev', 'claude', 'session-old', ?, ?)`)
      .run(laneId, wi.id, oldTs, oldTs).lastInsertRowid;
    db.prepare(`
      INSERT INTO session_recycle_savings (
        job_id, work_item_id, lane_id, session_id, role, provider, hop_count,
        tokens_resume, tokens_fresh_estimate, tokens_saved, recorded_at
      ) VALUES (?, ?, ?, ?, 'dev', 'claude', 0, 10, 20, 10, ?)
    `).run(job.id, wi.id, laneId, sessionId, oldTs);
    db.prepare(`
      INSERT INTO session_recycle_savings (
        job_id, work_item_id, lane_id, session_id, role, provider, hop_count,
        tokens_resume, tokens_fresh_estimate, tokens_saved, recorded_at
      ) VALUES (?, ?, ?, ?, 'dev', 'claude', 0, 10, 20, 10, ?)
    `).run(job.id, wi.id, laneId, sessionId, freshTs);

    const result = runRuntimeRetention({ db, retentionDays: 30, nowMs, checkpoint: false });
    assert.equal(result.ok, true);
    assert.equal(result.totalDeleted, 7);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'retention.old'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'retention.fresh'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM agent_calls`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM job_observations`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM artifacts`).get().count, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM artifacts WHERE content_long = 'old-terminal'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM artifacts WHERE content_long = 'old-parked'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM job_attempts`).get().count, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM run_insights`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM session_recycle_savings`).get().count, 1);
  });

  it("hot-reloads scheduler tunables between ticks", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const previous = {
      pollMs: queueMod.getSetting("scheduler_poll_ms"),
      leaseSec: queueMod.getSetting("default_lease_seconds"),
      concurrency: queueMod.getSetting("scheduler_concurrency"),
    };
    try {
      queueMod.setSetting("scheduler_poll_ms", "41");
      queueMod.setSetting("default_lease_seconds", "71");
      queueMod.setSetting("scheduler_concurrency", "2");
      const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-hot-reload" });

      assert.equal(scheduler.pollMs, 41);
      assert.equal(scheduler.leaseSec, 71);
      assert.equal(scheduler.concurrency, 2);

      queueMod.setSetting("scheduler_poll_ms", "17");
      queueMod.setSetting("default_lease_seconds", "29");
      queueMod.setSetting("scheduler_concurrency", "4");
      assert.equal(scheduler.tick(), null);

      assert.equal(scheduler.pollMs, 17);
      assert.equal(scheduler.leaseSec, 29);
      assert.equal(scheduler.concurrency, 4);
    } finally {
      queueMod.setSetting("scheduler_poll_ms", previous.pollMs);
      queueMod.setSetting("default_lease_seconds", previous.leaseSec);
      queueMod.setSetting("scheduler_concurrency", previous.concurrency);
    }
  });

  it("does not keep a due ready_at cache at zero forever", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-ready-cache", pollMs: 5, leaseSec: 60 });
    scheduler._nextReadyAtCacheGeneration = queueMod.getQueueWakeGeneration();
    scheduler._nextReadyAtCacheMs = Date.now() - 1000;

    assert.equal(scheduler._nextQueuedReadyDelayMs(), null);
    assert.equal(scheduler._nextReadyAtCacheMs, Infinity);
  });

  it("requeues expired leases before leasing a job", () => {
    const { queueMod, schedulerMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scheduler WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Lease test",
    });

    const lease = queueMod.acquireLease(job.id, "worker", 60);
    const db = dbMod.getDb();
    db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", job.id);

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-expired", pollMs: 5, leaseSec: 60 });
    const leased = scheduler.tick();
    assert.ok(leased);
    assert.equal(leased.id, job.id);

    const updated = queueMod.getJob(job.id);
    assert.equal(updated.status, "leased");
    assert.equal(updated.lease_owner, "sched-expired");
    assert.notEqual(updated.lease_token, lease.leaseToken);
  });

  it("expires stale session leases during direct ticks", () => {
    const { dbMod, queueMod, schedulerMod } = runtimeModules;
    const rdb = dbMod.getDb();
    const wi = queueMod.createWorkItem("Session lease tick", "desc");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "lease owner" });
    const laneId = rdb.prepare(`
      INSERT INTO session_lanes (work_item_id, lane, provider, status, created_at, updated_at)
      VALUES (?, 'dev', 'openai', 'active', ?, ?)
    `).run(wi.id, now(), now()).lastInsertRowid;
    const sessionId = rdb.prepare(`
      INSERT INTO job_sessions (
        lane_id, work_item_id, lane, provider, handle, status,
        leased_by, lease_token, lease_expires_at, created_at, last_used_at
      ) VALUES (?, ?, 'dev', 'openai', 'resp-1', 'active', ?, 'lease-token', '2020-01-01T00:00:00.000Z', ?, ?)
    `).run(laneId, wi.id, job.id, now(), now()).lastInsertRowid;

    const scheduler = new schedulerMod.Scheduler({ ownerId: "session-reaper-test", pollMs: 5, leaseSec: 60 });
    scheduler.tick();

    const row = rdb.prepare(`SELECT leased_by, lease_token, lease_expires_at, status FROM job_sessions WHERE id = ?`).get(sessionId);
    assert.equal(row.status, "active");
    assert.equal(row.leased_by, null);
    assert.equal(row.lease_token, null);
    assert.equal(row.lease_expires_at, null);
  });

  it("runs deadlock detection during direct ticks", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Tick deadlock WI", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Failed dependency",
    });
    const blocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Blocked by failed dependency",
    });

    queueMod.updateJobStatus(failed.id, "failed");
    queueMod.addDependency(blocked.id, failed.id, "hard");

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-tick-deadlock", pollMs: 5, leaseSec: 60 });
    scheduler.onEvent = () => {};

    assert.equal(scheduler.tick(), null);
    assert.equal(queueMod.getJob(blocked.id).status, "canceled");
  });

  it("avoids double-leasing when two schedulers race", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scheduler WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Race test",
    });

    const schedulerA = new schedulerMod.Scheduler({ ownerId: "sched-a", pollMs: 5, leaseSec: 60 });
    const schedulerB = new schedulerMod.Scheduler({ ownerId: "sched-b", pollMs: 5, leaseSec: 60 });

    const leaseA = schedulerA.tick();
    const leaseB = schedulerB.tick();
    assert.ok(leaseA);
    assert.equal(leaseB, null);

    const updated = queueMod.getJob(job.id);
    assert.equal(updated.status, "leased");
    assert.equal(updated.lease_owner, "sched-a");
  });

  it("distinguishes scheduler lock contention from insert failures", () => {
    const { queueMod, dbMod } = runtimeModules;

    assert.equal(queueMod.acquireSchedulerLock("main", "scheduler-a", 60), true);
    assert.equal(queueMod.acquireSchedulerLock("main", "scheduler-b", 60), false);
    assert.equal(queueMod.getSchedulerLockInfo("main").owner_id, "scheduler-a");

    dbMod.getDb().exec(`
      CREATE TRIGGER scheduler_lock_insert_failure
      BEFORE INSERT ON scheduler_locks
      WHEN NEW.lock_name = 'fatal-lock'
      BEGIN
        SELECT RAISE(FAIL, 'synthetic scheduler lock insert failure');
      END;
    `);

    assert.throws(
      () => queueMod.acquireSchedulerLock("fatal-lock", "scheduler-c", 60),
      /synthetic scheduler lock insert failure/
    );
  });

  it("does not force-steal a scheduler lock with a fresh heartbeat", () => {
    const { queueMod } = runtimeModules;

    assert.equal(queueMod.acquireSchedulerLock("main", "scheduler-a", 60), true);
    assert.equal(queueMod.forceAcquireSchedulerLock("main", "scheduler-b", 60), false);

    const lockInfo = queueMod.getSchedulerLockInfo("main");
    assert.equal(lockInfo.owner_id, "scheduler-a");
  });

  it("force-steals stale scheduler locks and refreshes same-owner locks", () => {
    const { queueMod, dbMod } = runtimeModules;

    assert.equal(queueMod.acquireSchedulerLock("main", "scheduler-a", 60), true);
    dbMod.getDb().prepare(`
      UPDATE scheduler_locks
      SET acquired_at = ?
      WHERE lock_name = ?
    `).run("2000-01-01T00:00:00.000Z", "main");

    assert.equal(queueMod.forceAcquireSchedulerLock("main", "scheduler-b", 60), true);
    assert.equal(queueMod.getSchedulerLockInfo("main").owner_id, "scheduler-b");
    assert.equal(queueMod.forceAcquireSchedulerLock("main", "scheduler-b", 60), true);
    assert.equal(queueMod.getSchedulerLockInfo("main").owner_id, "scheduler-b");
  });

  it("force-steals scheduler locks with invalid heartbeat timestamps at boot", async () => {
    const { queueMod, dbMod, schedulerMod } = runtimeModules;

    assert.equal(queueMod.acquireSchedulerLock("main", "scheduler-a", 60), true);
    dbMod.getDb().prepare(`
      UPDATE scheduler_locks
      SET acquired_at = ?, expires_at = ?
      WHERE lock_name = ?
    `).run("not-a-date", "still-not-a-date", "main");

    const scheduler = new schedulerMod.Scheduler({ ownerId: "scheduler-b", pollMs: 5, leaseSec: 60 });
    const messages = [];
    scheduler.onEvent = (message) => { messages.push(String(message)); };

    try {
      assert.equal(await scheduler.acquireBootLock(), true);
      assert.equal(queueMod.getSchedulerLockInfo("main").owner_id, "scheduler-b");
      assert.ok(messages.some((message) => /decision=FORCE_STEAL/.test(message)));
      assert.equal(messages.some((message) => /NaN/.test(message)), false);
    } finally {
      scheduler.stop();
    }
  });

  it("wakes all pending scheduler sleeps on stop", async () => {
    const { schedulerMod } = runtimeModules;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-sleep-wake", pollMs: 1000, leaseSec: 60 });
    scheduler._running = true;
    let wakeCount = 0;
    const startedAt = Date.now();

    const sleeps = Promise.all([
      scheduler._interruptibleSleep(2000, { requireRunning: true }).then(() => { wakeCount += 1; }),
      scheduler._interruptibleSleep(5000, { requireRunning: true }).then(() => { wakeCount += 1; }),
    ]);
    scheduler.stop();
    await sleeps;

    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(wakeCount, 2);
    assert.equal(scheduler._sleepResolves.size, 0);
  });

  it("bumps the queue wake generation for scheduling state changes", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Wake generation WI", "desc");
    const before = queueMod.getQueueWakeGeneration();

    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Wake generation job",
    });
    const afterCreate = queueMod.getQueueWakeGeneration();
    assert.ok(afterCreate > before);

    assert.equal(queueMod.updateJobStatus(job.id, "succeeded"), true);
    const afterStatus = queueMod.getQueueWakeGeneration();
    assert.ok(afterStatus > afterCreate);
  });

  it("wakes a napping scheduler on queue state changes instead of waiting for repair poll", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Wake scheduler WI", "desc");
    const first = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Long first job",
    });
    const second = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Second job",
    });
    const scheduler = new schedulerMod.Scheduler({
      ownerId: "sched-queue-wake",
      pollMs: 5,
      repairPollMs: 2000,
      leaseSec: 60,
      concurrency: 1,
    });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    let releaseFirst;
    let firstStarted;
    let secondStarted;
    const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
    const secondStartedPromise = new Promise((resolve) => { secondStarted = resolve; });
    const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });

    const loop = scheduler.runLoop(async (job) => {
      if (job.id === first.id) {
        firstStarted();
        await firstMayFinish;
        queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
        return;
      }
      if (job.id === second.id) {
        secondStarted(Date.now());
        queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
        scheduler.stop();
      }
    });

    await firstStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const releasedAt = Date.now();
    releaseFirst();
    const secondStartedAt = await Promise.race([
      secondStartedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("scheduler did not wake before repair poll")), 500)),
    ]);
    scheduler.stop();
    await loop;

    assert.ok(secondStartedAt - releasedAt < 500);
    assert.equal(queueMod.getJob(second.id).status, "succeeded");
  });

  it("requeues a leased job when the worker callback rejects", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Worker rejection WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Rejecting job",
    });
    const scheduler = new schedulerMod.Scheduler({
      ownerId: "sched-worker-reject",
      pollMs: 5,
      repairPollMs: 2000,
      leaseSec: 60,
      concurrency: 1,
    });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    let ended;
    const endedPromise = new Promise((resolve) => { ended = resolve; });
    const loop = scheduler.runLoop(async () => {
      throw new Error("worker callback exploded");
    }, {
      onJobEnd: () => {
        scheduler.stop();
        ended();
      },
    });

    await endedPromise;
    await loop;

    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.lease_token, null);
    assert.equal(refreshed.attempt_count, 0);
    assert.ok(queueMod.getEvents(job.id, 20).some((event) => event.message.includes("released lease and requeued")));
  });

  it("keeps scheduler job and work-item lock lanes separate with cached write paths", async () => {
    const { createHeldQueueLockIndex } = await import("../../../lib/domains/scheduler/functions/held-locks.js");
    const job = {
      id: 101,
      work_item_id: 202,
      job_type: "dev",
      status: "queued",
      payload_json: JSON.stringify({ files_to_modify: ["src/app.js"] }),
      attempt_count: 0,
    };
    const unknown = {
      id: 102,
      work_item_id: 202,
      job_type: "dev",
      status: "queued",
      payload_json: JSON.stringify({}),
      attempt_count: 0,
    };
    const index = createHeldQueueLockIndex({
      loadActiveLocks: () => ({ work_items: [], jobs: [] }),
      loadJobs: () => [job, unknown],
    });

    assert.deepEqual(index.scopeForJob(job).files, ["src/app.js"]);
    assert.deepEqual(index.scopeForJob(unknown).createRoots, ["*"]);

    index.addLeasedJob({ ...job, status: "leased" });
    assert.deepEqual(index.counts(), { jobs: 1, workItems: 1, jobScopes: 2 });

    index.applyWake({ reason: "lease_released_succeeded", jobId: job.id });
    assert.deepEqual(index.counts(), { jobs: 0, workItems: 1, jobScopes: 1 });

    index.applyWake({
      reason: "work_item_lock_released:work_item_merged",
      workItemId: job.work_item_id,
      path: "src/app.js",
      lockKind: "file",
    });
    assert.deepEqual(index.counts(), { jobs: 0, workItems: 0, jobScopes: 1 });
  });

  it("rescans the DB when an aggregate requeue wake fires", async () => {
    const { createHeldQueueLockIndex } = await import("../../../lib/domains/scheduler/functions/held-locks.js");
    const initialJob = {
      id: 301,
      work_item_id: 401,
      job_type: "fix",
      status: "leased",
      payload_json: JSON.stringify({ files_to_modify: ["src/old.js"] }),
      attempt_count: 1,
    };
    const reappearingJob = {
      id: 302,
      work_item_id: 402,
      job_type: "fix",
      status: "queued",
      payload_json: JSON.stringify({ files_to_modify: ["src/new.js"] }),
      attempt_count: 1,
    };

    let jobsView = [initialJob];
    let locksView = {
      work_items: [],
      jobs: [{ job_id: initialJob.id, work_item_id: initialJob.work_item_id, path: "src/old.js", lock_kind: "file", job_type: "fix", job_status: "leased" }],
    };
    const index = createHeldQueueLockIndex({
      loadActiveLocks: () => locksView,
      loadJobs: () => jobsView,
    });

    assert.deepEqual(index.counts(), { jobs: 1, workItems: 0, jobScopes: 1 });

    // Simulate `requeueOrphanedJobs` running: the original job's locks are
    // released and a new repair-eligible job has appeared.
    jobsView = [reappearingJob];
    locksView = { work_items: [], jobs: [] };

    index.applyWake({ reason: "job_orphan_requeue" });

    assert.deepEqual(index.counts(), { jobs: 1, workItems: 0, jobScopes: 1 });
    const snap = index.snapshot();
    assert.ok([...snap.lockedFiles].includes("src/new.js"));
    assert.ok(![...snap.lockedFiles].includes("src/old.js"));
  });

  it("reinstates work-item locks when reconciling into a lock-holding status", async () => {
    const { createHeldQueueLockIndex } = await import("../../../lib/domains/scheduler/functions/held-locks.js");
    const queuedJob = {
      id: 501,
      work_item_id: 601,
      job_type: "dev",
      status: "queued",
      payload_json: JSON.stringify({ files_to_modify: ["src/feature.js"] }),
      attempt_count: 1,
    };
    const leasedJob = { ...queuedJob, status: "leased" };

    const index = createHeldQueueLockIndex({
      loadActiveLocks: () => ({ work_items: [], jobs: [] }),
      loadJobs: () => [queuedJob],
    });

    // Queued repair job already contributes job-tier locks but not WI locks.
    assert.equal(index.counts().jobs, 1);
    assert.equal(index.counts().workItems, 0);

    // Out-of-band transition to "leased" without going through addLeasedJob.
    index.applyWake({ reason: "job_status_leased", jobId: queuedJob.id }, { readJob: () => leasedJob });

    assert.equal(index.counts().jobs, 1);
    assert.equal(index.counts().workItems, 1, "WI lock should be reinstated for lock-holding status");
  });

  it("does not mutate the lock index when a transaction rolls back after notifying", async () => {
    const { dbMod, queueMod } = runtimeModules;
    const wakeups = await import("../../../lib/domains/queue/functions/wakeups.js");
    const common = await import("../../../lib/domains/queue/functions/common.js");

    const seen = [];
    const unsubscribe = wakeups.onQueueStateChanged((payload) => { seen.push(payload.reason); });
    try {
      const generationBefore = queueMod.getQueueWakeGeneration();
      assert.throws(() => {
        common.runImmediateTransaction(dbMod.getDb(), () => {
          wakeups.notifyQueueStateChanged({ reason: "test_should_be_discarded" });
          throw new Error("simulated rollback");
        });
      }, /simulated rollback/);
      const generationAfter = queueMod.getQueueWakeGeneration();

      // DB-side generation rolled back with the transaction; listener never fired.
      assert.equal(generationAfter, generationBefore);
      assert.equal(seen.includes("test_should_be_discarded"), false);
    } finally {
      unsubscribe();
    }
  });

  it("flushes queue wake listeners after cancel transaction commit", async () => {
    const { queueMod } = runtimeModules;
    const wakeups = await import("../../../lib/domains/queue/functions/wakeups.js");
    const wi = queueMod.createWorkItem("Cancel wake WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Cancel wake job",
    });

    const seen = [];
    const unsubscribe = wakeups.onQueueStateChanged((payload) => { seen.push(payload.reason); });
    try {
      assert.deepEqual(queueMod.cancelWorkItemJobs(wi.id), [job.id]);
      assert.equal(queueMod.getJob(job.id).status, "canceled");
      assert.equal(seen.includes("job_status_canceled"), true);
    } finally {
      unsubscribe();
    }
  });

  slowIt("starts scheduler lock renewal before pre-loop hooks run", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-boot-renew", pollMs: 5, leaseSec: 60 });
    let intervalDuringHook = false;
    let ownerDuringHook = null;

    const booted = await scheduler.boot({
      onBeforeLoop: () => {
        intervalDuringHook = !!scheduler._lockInterval;
        ownerDuringHook = queueMod.getSchedulerLockInfo("main")?.owner_id || null;
      },
      onBeforeLoopFatal: true,
    });

    assert.equal(booted, true);
    assert.equal(intervalDuringHook, true);
    assert.equal(ownerDuringHook, "sched-boot-renew");
    scheduler.stop();
  });

  it("logs scheduler lock starvation before renewing a delayed heartbeat", () => {
    const { queueMod, schedulerMod, dbMod } = runtimeModules;
    const scheduler = new schedulerMod.Scheduler({
      ownerId: "sched-lock-starved",
      pollMs: 5,
      leaseSec: 60,
      lockStarvationThresholdMs: 1,
    });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;
    scheduler._lastSchedulerLockRenewedAt = Date.now() - 60_000;

    assert.equal(scheduler._renewSchedulerLock(), true);

    // logEvent now batches inserts on a 100ms timer; drain pending
    // events before reading via raw SQL.
    queueMod.flushEventsNow();
    const event = dbMod.getDb().prepare(`
      SELECT * FROM events
      WHERE event_type = 'scheduler.lock_starved'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    assert.ok(event);
    assert.equal(event.actor_id, "sched-lock-starved");
    const detail = JSON.parse(event.event_json);
    assert.ok(detail.elapsed_ms >= 1);
    assert.equal(detail.threshold_ms, 1);
  });

  it("aborts active workers when the scheduler lock is stolen", async () => {
    const { queueMod, schedulerMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lock stolen WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Long worker",
    });
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-lock-old", pollMs: 5, leaseSec: 60, concurrency: 1 });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    let resolveWorker = null;
    let startedJob = null;
    const workerStopped = new Promise((resolve) => { resolveWorker = resolve; });
    const workerStarted = new Promise((resolve) => {
      startedJob = resolve;
    });
    const killed = [];
    const loop = scheduler.runLoop(async (leasedJob) => {
      assert.equal(queueMod.updateJobStatus(leasedJob.id, "running", { leaseToken: leasedJob._leaseToken }), true);
      startedJob(leasedJob);
      await workerStopped;
    }, {
      onKillJob: (jobId, reason) => {
        killed.push({ jobId, reason });
        resolveWorker();
      },
    });

    await workerStarted;
    dbMod.getDb().prepare(`
      UPDATE scheduler_locks
      SET acquired_at = ?
      WHERE lock_name = ?
    `).run("2000-01-01T00:00:00.000Z", "main");
    assert.equal(queueMod.forceAcquireSchedulerLock("main", "sched-lock-new", 60), true);
    assert.equal(scheduler._renewSchedulerLock(), false);
    await loop;

    assert.deepEqual(killed, [{ jobId: job.id, reason: "scheduler_lock_lost" }]);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "running");
    assert.equal(refreshed.lease_owner, scheduler.ownerId);
  });

  slowIt("logs best-effort scheduler callback failures", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Callback logging", "desc");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Callback failure test",
    });
    const logs = [];
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-callback-logs", pollMs: 5, leaseSec: 60 });
    const handler = (msg, color) => logs.push({ msg, color });
    scheduler.onEvent = handler;
    assert.equal(scheduler.onEvent, handler);

    await scheduler.start(async (job) => {
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
    }, {
      onJobStart: () => { throw new Error("start boom"); },
      onJobEnd: () => { throw new Error("end boom"); },
      onSlotStatus: () => { throw new Error("slot boom"); },
      onDone: () => { throw new Error("done boom"); },
    });

    assert.ok(logs.some((entry) => entry.msg.includes("onJobStart callback failed: start boom")));
    assert.ok(logs.some((entry) => entry.msg.includes("onJobEnd callback failed: end boom")));
    assert.ok(logs.some((entry) => entry.msg.includes("onSlotStatus callback failed: slot boom")));
    assert.ok(logs.some((entry) => entry.msg.includes("onDone callback failed: done boom")));
  });

  it("uses longer default runtime caps for planning and research roles", () => {
    const { schedulerMod } = runtimeModules;

    assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "dev" }), 1200);
    assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "plan" }), 1800);
    assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "preflight" }), 1800);
    assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "research" }), 2400);
  });

  it("hot-reloads runtime watchdog settings without a module reload", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const { resolveProviderStallTimeout } = await import("../../../lib/domains/providers/functions/helpers/stall-timeout.js");
    const previous = {
      stall: queueMod.getSetting("stall_timeout"),
      max: queueMod.getSetting("max_job_runtime_sec"),
    };
    try {
      queueMod.setSetting("stall_timeout", "7");
      queueMod.setSetting("max_job_runtime_sec", null);
      assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "dev" }), 14);
      assert.equal(resolveProviderStallTimeout(), 7);

      queueMod.setSetting("max_job_runtime_sec", "9");
      assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "research" }), 9);

      queueMod.setSetting("stall_timeout", "11");
      queueMod.setSetting("max_job_runtime_sec", null);
      assert.equal(schedulerMod.__testMaxJobRuntimeSecFor({ job_type: "plan" }), 33);
      assert.equal(resolveProviderStallTimeout(), 11);
    } finally {
      queueMod.setSetting("stall_timeout", previous.stall);
      queueMod.setSetting("max_job_runtime_sec", previous.max);
    }
  });

  it("blocks nested root conflicts", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const previousShadow = queueMod.getSetting("scheduler_shadow_conflict_metrics");
    queueMod.setSetting("scheduler_shadow_conflict_metrics", "true");
    try {
      const wiA = queueMod.createWorkItem("Scheduler root lock A", "desc");
      const wiB = queueMod.createWorkItem("Scheduler root lock B", "desc");

      const held = queueMod.createJob({
        work_item_id: wiA.id,
        job_type: "dev",
        title: "Held root lock",
        payload_json: JSON.stringify({
          files_to_modify: [],
          files_to_create: [],
          create_roots: ["assets"],
        }),
      });
      const candidate = queueMod.createJob({
        work_item_id: wiB.id,
        job_type: "dev",
        title: "Nested root candidate",
        payload_json: JSON.stringify({
          files_to_modify: [],
          files_to_create: [],
          create_roots: ["assets/icons"],
        }),
      });

      const heldLease = queueMod.acquireLeaseWithWriteLocks(held, "held-worker", 60);
      assert.ok(heldLease);

      const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-shadow", pollMs: 5, leaseSec: 60 });
      const leased = scheduler.tick();
      assert.equal(leased, null);
      const conflict = queueMod.findWriteLockConflict(candidate);
      assert.equal(conflict?.type, "work_item");
      assert.equal(conflict.lock.path, "assets");
      assert.equal(conflict.candidate.path, "assets/icons");
      const overlaps = schedulerMod.__testCollectStrictOnlyRootConflicts(
        { files: [], createRoots: ["assets/icons"] },
        new Set(["assets"]),
      );
      assert.ok(overlaps.length > 0);
    } finally {
      queueMod.setSetting("scheduler_shadow_conflict_metrics", previousShadow);
    }
  });

  it("cancels jobs with deadlocked hard deps but not soft deps", () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scheduler WI", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Failed dep",
    });
    const hardBlocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Hard dep",
    });
    const softBlocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Soft dep",
    });

    queueMod.updateJobStatus(failed.id, "failed");
    queueMod.addDependency(hardBlocked.id, failed.id, "hard");
    queueMod.addDependency(softBlocked.id, failed.id, "soft");

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-deadlock" });
    scheduler._cancelDeadlockedJobs();

    assert.equal(queueMod.getJob(hardBlocked.id).status, "canceled");
    assert.equal(queueMod.getJob(softBlocked.id).status, "queued");
  });

  it("rejects invalid terminal work-item transitions", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Terminal WI", "desc");
    queueMod.updateWorkItemStatus(wi.id, "complete");
    const changed = queueMod.updateWorkItemStatus(wi.id, "running");
    assert.equal(changed, false);
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("adds dependencies inside an existing transaction", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Nested dependency WI", "desc");
    const dep = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dependency",
    });
    const blocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Blocked",
    });

    dbMod.getDb().transaction(() => {
      assert.equal(queueMod.addDependency(blocked.id, dep.id, "hard"), true);
    })();

    const row = dbMod.getDb().prepare(`
      SELECT dependency_kind FROM job_dependencies
      WHERE job_id = ? AND depends_on_job_id = ?
    `).get(blocked.id, dep.id);
    assert.equal(row?.dependency_kind, "hard");
  });

  it("refreshes work-item status inside an existing transaction", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Nested refresh WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Completing job",
    });
    queueMod.updateJobStatus(job.id, "succeeded");

    const changed = dbMod.getDb().transaction(() => queueMod.refreshWorkItemStatus(wi.id))();

    assert.equal(changed, "complete");
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("treats a failed parent + succeeded fix child as complete", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Recovered via fix", "desc");
    const failedJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original task",
    });
    queueMod.updateJobStatus(failedJob.id, "failed");
    const fixJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Recovery fix",
      parent_job_id: failedJob.id,
    });
    queueMod.updateJobStatus(fixJob.id, "succeeded");

    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "complete");
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("does not reconcile running attempts when the job lease is still active", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Lease guard", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Leased running job",
    });
    const db = dbMod.getDb();
    const leaseToken = "lease-fresh-1";
    const futureLease = new Date(Date.now() + 60_000).toISOString().replace("Z", "").slice(0, 23) + "Z";
    db.prepare(`
      UPDATE jobs
      SET status = 'running',
          lease_token = ?,
          lease_owner = 'worker-1',
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(leaseToken, futureLease, futureLease, job.id);
    const attempt = queueMod.incrementAndCreateAttempt(job.id, leaseToken, "dev", null, "medium");
    assert.ok(attempt?.attempt?.id);
    const reconciled = queueMod.reconcileOrphanedAttempts();
    assert.equal(reconciled, 0);
    const refreshed = queueMod.getAttempts(job.id).find((entry) => entry.id === attempt.attempt.id);
    assert.equal(refreshed?.status, "running");
  });

  it("reconciles orphaned attempts against the lease clock and stamps finished_at consistently", () => {
    const { queueMod, dbMod } = runtimeModules;
    const leaseNowMs = Date.parse("2030-01-01T00:00:00.000Z");
    queueMod.__testSetLeaseClockForTests({
      wallNowMs: () => leaseNowMs,
      monotonicNowMs: () => 0,
    });

    try {
      const wi = queueMod.createWorkItem("Lease-clock reconcile", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Expired by lease clock",
      });
      const db = dbMod.getDb();
      const leaseToken = "lease-expired-by-lease-clock";
      const validLease = new Date(leaseNowMs + 60_000).toISOString();
      db.prepare(`
        UPDATE jobs
        SET status = 'running',
            lease_token = ?,
            lease_owner = 'worker-1',
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(leaseToken, validLease, validLease, job.id);
      const attempt = queueMod.incrementAndCreateAttempt(job.id, leaseToken, "dev", null, "medium");
      assert.ok(attempt?.attempt?.id);

      const expiredByLeaseClock = new Date(leaseNowMs - 1000).toISOString();
      db.prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`).run(expiredByLeaseClock, job.id);
      const reconciled = queueMod.reconcileOrphanedAttempts();
      assert.equal(reconciled, 1);
      const refreshed = queueMod.getAttempts(job.id).find((entry) => entry.id === attempt.attempt.id);
      assert.equal(refreshed?.status, "failed");
      assert.equal(refreshed?.finished_at, new Date(leaseNowMs).toISOString());
    } finally {
      queueMod.__testSetLeaseClockForTests(null);
    }
  });

  it("atomically cancels only currently deadlocked queued jobs", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Atomic deadlock cancel", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Failed dep",
    });
    const blocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Blocked job",
    });
    queueMod.updateJobStatus(failed.id, "failed");
    queueMod.addDependency(blocked.id, failed.id, "hard");
    const canceled = queueMod.cancelDeadlockedJobsAtomic("test-scheduler");
    assert.equal(canceled.canceled.length, 1);
    assert.equal(canceled.canceled[0].id, blocked.id);
    assert.equal(queueMod.getJob(blocked.id).status, "canceled");

    const wi2 = queueMod.createWorkItem("Recovered dependency", "desc");
    const dep2 = queueMod.createJob({
      work_item_id: wi2.id,
      job_type: "dev",
      title: "Dep2",
    });
    const blocked2 = queueMod.createJob({
      work_item_id: wi2.id,
      job_type: "dev",
      title: "Blocked2",
    });
    queueMod.updateJobStatus(dep2.id, "failed");
    queueMod.addDependency(blocked2.id, dep2.id, "hard");
    queueMod.updateJobStatus(dep2.id, "succeeded");
    const canceled2 = queueMod.cancelDeadlockedJobsAtomic("test-scheduler");
    assert.equal(canceled2.canceled.some((entry) => entry.id === blocked2.id), false);
    assert.equal(queueMod.getJob(blocked2.id).status, "queued");
  });

  it("deadlocks a queued job when any hard dependency is terminal-failed", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Mixed dependency deadlock", "desc");
    const succeeded = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Succeeded dep",
    });
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dead dep",
    });
    const blocked = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Blocked by mixed deps",
    });

    queueMod.updateJobStatus(succeeded.id, "succeeded");
    queueMod.updateJobStatus(failed.id, "dead_letter");
    queueMod.addDependency(blocked.id, succeeded.id, "hard");
    queueMod.addDependency(blocked.id, failed.id, "hard");

    const deadlocked = queueMod.findDeadlockedJobs();
    assert.equal(deadlocked.some((entry) => entry.id === blocked.id), true);

    const canceled = queueMod.cancelDeadlockedJobsAtomic("test-scheduler");
    assert.equal(canceled.canceled.some((entry) => entry.id === blocked.id), true);
    assert.equal(queueMod.getJob(blocked.id).status, "canceled");
  });

  it("cancels cascading deadlocked dependency chains in one atomic pass", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Cascading deadlock", "desc");
    const failed = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Failed root" });
    const layer1 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Layer 1" });
    const layer2 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Layer 2" });
    const layer3 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Layer 3" });

    queueMod.updateJobStatus(failed.id, "failed");
    queueMod.addDependency(layer1.id, failed.id, "hard");
    queueMod.addDependency(layer2.id, layer1.id, "hard");
    queueMod.addDependency(layer3.id, layer2.id, "hard");

    const canceled = queueMod.cancelDeadlockedJobsAtomic("test-scheduler");
    assert.deepEqual(canceled.canceled.map((job) => job.id).sort((a, b) => a - b), [layer1.id, layer2.id, layer3.id]);
    assert.equal(queueMod.getJob(layer1.id).status, "canceled");
    assert.equal(queueMod.getJob(layer2.id).status, "canceled");
    assert.equal(queueMod.getJob(layer3.id).status, "canceled");
  });

  it("blocks direct work-item completion while required jobs failed or dead-lettered", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Completion blocker", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Required failed job",
    });

    queueMod.updateJobStatus(failed.id, "dead_letter");

    const completed = queueMod.updateWorkItemStatus(wi.id, "complete");
    assert.equal(completed, false);
    assert.notEqual(queueMod.getWorkItem(wi.id).status, "complete");
    const blockers = queueMod.completionBlockersForWorkItem(wi.id);
    assert.deepEqual(blockers.map((entry) => entry.id), [failed.id]);
  });

  it("refreshes stale-running terminal dead-letter work items to failed", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Stale live terminal blocker", "desc");
    queueMod.updateWorkItemStatus(wi.id, "running");
    const plan = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan",
    });
    const dead = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: plan.id,
      job_type: "dev",
      title: "Required dead-letter job",
    });
    const human = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: dead.id,
      job_type: "human_input",
      title: "Blocked prompt",
    });
    const warm = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: dead.id,
      job_type: "atlas_warm",
      title: "ATLAS warm: refresh WI view",
    });

    queueMod.updateJobStatus(plan.id, "succeeded");
    queueMod.updateJobStatus(dead.id, "dead_letter");
    queueMod.updateJobStatus(human.id, "succeeded");
    queueMod.updateJobStatus(warm.id, "succeeded");

    assert.deepEqual(queueMod.completionBlockersForWorkItem(wi.id).map((entry) => entry.id), [dead.id]);
    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "failed");
    assert.equal(queueMod.getWorkItem(wi.id).status, "failed");
  });

  it("does not block completion on background ATLAS warm cleanup jobs", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Warm cleanup blocker", "desc");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "atlas_warm",
      title: "ATLAS warm: WI cleanup view disposal",
    });

    assert.deepEqual(queueMod.completionBlockersForWorkItem(wi.id), []);
    assert.equal(queueMod.updateWorkItemStatus(wi.id, "complete"), true);
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("marks work complete while queued ATLAS warm follow-ups remain in the background", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Warm follow-up", "desc");
    queueMod.setWorkItemBranch(wi.id, "posse/wi-warm-follow-up", "base");
    queueMod.updateWorkItemStatus(wi.id, "running");
    const plan = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan",
    });
    const dev = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: plan.id,
      job_type: "dev",
      title: "Dev",
    });
    const warm = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: dev.id,
      job_type: "atlas_warm",
      title: "ATLAS warm: refresh WI view after dev commit",
    });

    queueMod.updateJobStatus(plan.id, "succeeded");
    queueMod.updateJobStatus(dev.id, "succeeded");

    assert.equal(queueMod.getJob(warm.id).status, "queued");
    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "complete");
    const refreshed = queueMod.getWorkItem(wi.id);
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.merge_state, "pending_review");
  });

  it("reconciles stale active work items before auto-merge scans", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Stale warm follow-up", "desc");
    queueMod.setWorkItemBranch(wi.id, "posse/wi-stale-warm-follow-up", "base");
    queueMod.updateWorkItemStatus(wi.id, "running");
    const dev = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dev",
    });
    queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: dev.id,
      job_type: "atlas_warm",
      title: "ATLAS warm: refresh WI view after dev commit",
    });
    queueMod.updateJobStatus(dev.id, "succeeded");

    const changed = queueMod.refreshWorkItemStatuses(["running"]);

    assert.equal(changed, 1);
    const refreshed = queueMod.getWorkItem(wi.id);
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.merge_state, "pending_review");
  });

  it("does not report rejected refresh transitions as applied", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Rejected refresh transition", "desc");
    queueMod.updateWorkItemStatus(wi.id, "complete");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Late queued job",
    });

    const refreshed = queueMod.refreshWorkItemStatus(wi.id);

    assert.equal(refreshed, null);
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("releases work-item write locks when completed work has no branch to merge", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("No branch lock release", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Scoped write",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["no-branch-output.txt"],
        create_roots: [],
      },
    });

    const lease = queueMod.acquireLeaseWithWriteLocks(job, "sched-lock-release", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(queueMod.listActiveFileLocks().work_items.length, 1);

    assert.equal(queueMod.releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    queueMod.refreshWorkItemStatus(wi.id);

    const locks = queueMod.listActiveFileLocks();
    assert.equal(locks.jobs.length, 0);
    assert.equal(locks.work_items.length, 0);
  });

  it("retains completed branch locks until the work item merges", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Completed branch lock release", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Scoped write",
      payload_json: {
        files_to_modify: ["shared.txt"],
        files_to_create: [],
        create_roots: [],
      },
    });

    const lease = queueMod.acquireLeaseWithWriteLocks(job, "sched-reject-lock-release", 60);
    assert.ok(lease?.leaseToken);
    queueMod.setWorkItemBranch(wi.id, "posse/wi-rejected-lock-release", "base");
    assert.equal(queueMod.releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    queueMod.refreshWorkItemStatus(wi.id);
    assert.equal(queueMod.getWorkItem(wi.id).merge_state, "pending_review");

    const downstream = queueMod.createWorkItem("Downstream", "desc");
    const downstreamJob = queueMod.createJob({
      work_item_id: downstream.id,
      job_type: "dev",
      title: "Needs same file",
      payload_json: {
        files_to_modify: ["shared.txt"],
        files_to_create: [],
        create_roots: [],
      },
    });
    const pendingReviewConflict = queueMod.findWriteLockConflict(downstreamJob);
    assert.equal(pendingReviewConflict?.type, "work_item");
    const refreshed = queueMod.getWorkItem(wi.id);
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.merge_state, "pending_review");
    assert.equal(queueMod.listActiveFileLocks().work_items.some(lock => lock.work_item_id === wi.id), true);
    assert.equal(queueMod.acquireLeaseWithWriteLocks(downstreamJob, "sched-downstream", 60), null);

    queueMod.setMergeState(wi.id, "merged");
    assert.equal(queueMod.findWriteLockConflict(downstreamJob), null);
    const downstreamLease = queueMod.acquireLeaseWithWriteLocks(downstreamJob, "sched-downstream", 60);
    assert.ok(downstreamLease?.leaseToken);
  });

  it("reopens completed iterative WIs and releases old locks before the next pass", async () => {
    const { queueMod } = runtimeModules;
    const { spawnIterativeNextPass } = await import("../../../lib/domains/planning/functions/orchestration.js");
    const wi = queueMod.createWorkItem("Iterative lock release", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Scoped write",
      payload_json: {
        files_to_modify: ["htdocs/api/scans.php"],
        files_to_create: [],
        create_roots: [],
      },
    });

    const lease = queueMod.acquireLeaseWithWriteLocks(job, "sched-iterative-lock-release", 60);
    assert.ok(lease?.leaseToken);
    queueMod.setWorkItemBranch(wi.id, "posse/wi-iterative-lock-release", "base");
    assert.equal(queueMod.releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    queueMod.refreshWorkItemStatus(wi.id);
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
    assert.equal(queueMod.getWorkItem(wi.id).merge_state, "pending_review");
    assert.equal(queueMod.listActiveFileLocks().work_items.length, 1);

    const spawned = spawnIterativeNextPass(queueMod.getWorkItem(wi.id), {
      passCount: 0,
      maxPasses: 2,
      workflowMode: "bugfix",
      redTeamPlan: false,
      awaitingPlanJobId: null,
    }, {
      projectDir: process.cwd(),
    });

    const reopened = queueMod.getWorkItem(wi.id);
    const jobs = queueMod.listJobsByWorkItem(wi.id);
    assert.equal(reopened.status, "planning");
    assert.equal(reopened.merge_state, null);
    assert.equal(reopened.completed_at, null);
    assert.equal(queueMod.listActiveFileLocks().work_items.length, 0);
    assert.ok(jobs.some((row) => row.id === spawned.researchJobId && row.status === "queued" && row.model_tier === "strong"));
    assert.ok(jobs.some((row) => row.id === spawned.planJobId && row.status === "queued"));
  });

  it("allows same-work-item root locks when exact file scopes are disjoint", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Parallel inner WI locks", "desc");
    const shell = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Create admin shell",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["htdocs/admin.php"],
        create_roots: ["htdocs"],
      },
    });
    const app = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Create admin app",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["htdocs/assets/js/admin/admin-app.js"],
        create_roots: [],
      },
    });
    const metrics = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Create metrics tab",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["htdocs/assets/js/admin/admin-metrics.js"],
        create_roots: ["htdocs/assets/js/admin"],
      },
    });
    const overlap = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Touch admin shell too",
      payload_json: {
        files_to_modify: ["htdocs/admin.php"],
        files_to_create: [],
        create_roots: [],
      },
    });

    assert.ok(queueMod.acquireLeaseWithWriteLocks(shell, "sched-shell", 60)?.leaseToken);
    assert.equal(queueMod.findWriteLockConflict(app), null);
    assert.ok(queueMod.acquireLeaseWithWriteLocks(app, "sched-app", 60)?.leaseToken);
    assert.equal(queueMod.findWriteLockConflict(metrics), null);
    assert.ok(queueMod.acquireLeaseWithWriteLocks(metrics, "sched-metrics", 60)?.leaseToken);

    const conflict = queueMod.findWriteLockConflict(overlap);
    assert.equal(conflict?.type, "job");
    assert.equal(conflict.lock.path, "htdocs/admin.php");
  });

  slowIt("lets repair jobs run through inherited active locks while siblings wait", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair lock handoff", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original scoped edit",
      payload_json: {
        files_to_modify: ["shared.js"],
        files_to_create: [],
        create_roots: [],
      },
    });
    queueMod.updateJobStatus(failed.id, "failed");
    const sibling = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Sibling same file",
      payload_json: {
        files_to_modify: ["shared.js"],
        files_to_create: [],
        create_roots: [],
      },
    });
    const fix = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: failed.id,
      job_type: "fix",
      title: "Fix original edit",
      payload_json: {
        files_to_modify: ["shared.js"],
        files_to_create: [],
        create_roots: [],
      },
    });

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-repair-lock", pollMs: 5, leaseSec: 60, concurrency: 1 });
    const launched = [];
    await scheduler.start(async (job) => {
      launched.push(job.id);
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      scheduler.stop();
    });

    assert.deepEqual(launched, [fix.id]);
    assert.equal(queueMod.getJob(fix.id).status, "succeeded");
    assert.equal(queueMod.getJob(sibling.id).status, "queued");
  });

  it("cleans stale work-item locks left on branchless completed work", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Legacy branchless lock", "desc");
    queueMod.updateWorkItemStatus(wi.id, "complete");

    dbMod.getDb().prepare(`
      INSERT INTO work_item_file_locks (work_item_id, path, lock_kind, source_job_id, acquired_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(wi.id, "*", "root", null, "2026-01-01T00:00:00.000Z", "{}");

    const cleaned = queueMod.cleanupStaleFileLocks();
    assert.equal(cleaned.wi_locks_released, 1);
    assert.equal(queueMod.listActiveFileLocks().work_items.length, 0);
  });

  it("kills stuck ATLAS drift reindex children and suppresses repeat attempts after the failsafe", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("ATLAS drift failsafe", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Parked prompt",
    });
    queueMod.updateJobStatus(job.id, "waiting_on_human");

    let reconcileCalls = 0;
    let killCalls = 0;
    // No pid so terminateSchedulerChild's Windows taskkill branch is skipped
    // and the stub's kill() runs directly. The failsafe contract under test
    // is "the scheduler invokes child termination once" — which mechanism
    // (SIGTERM vs taskkill /T) is platform implementation detail.
    const child = {
      pid: null,
      kill() {
        killCalls++;
        return true;
      },
    };

    const scheduler = new schedulerMod.Scheduler({
      ownerId: "sched-atlas-failsafe",
      pollMs: 5,
      leaseSec: 60,
      concurrency: 1,
      atlasDriftCheckIntervalMs: 1,
      atlasDriftReindexFailsafeMs: 10,
      reconcileAtlasDriftIfIdle: () => {
        reconcileCalls++;
        return {
          attempted: true,
          head: "abcdef123456",
          lastIndexed: "123456abcdef",
          reindex: { child },
        };
      },
    });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    const loop = scheduler.runLoop(async () => {
      throw new Error("waiting_on_human job should not dispatch");
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    scheduler.stop();
    await loop;

    assert.equal(killCalls, 1);
    assert.equal(reconcileCalls, 1);
  });

  it("does not leave ATLAS drift reindex marked in-flight after synchronous failure", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("ATLAS drift sync failure", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Parked prompt",
    });
    queueMod.updateJobStatus(job.id, "waiting_on_human");

    let reconcileCalls = 0;
    const blockedMessages = [];
    const scheduler = new schedulerMod.Scheduler({
      ownerId: "sched-atlas-sync-fail",
      pollMs: 5,
      leaseSec: 60,
      concurrency: 1,
      atlasDriftCheckIntervalMs: 1,
      atlasDriftReindexFailsafeMs: 1000,
      reconcileAtlasDriftIfIdle: ({ onStatus }) => {
        reconcileCalls++;
        onStatus?.({ ok: false, error: "spawn failed", repoId: "repo-a" });
        return {
          attempted: true,
          ok: false,
          head: "abcdef123456",
          lastIndexed: "123456abcdef",
        };
      },
    });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    const loop = scheduler.runLoop(async () => {
      throw new Error("waiting_on_human job should not dispatch");
    }, {
      onSlotStatus: (status) => {
        for (const detail of status?.blockedLockDetails || []) {
          blockedMessages.push(detail.message);
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    scheduler.stop();
    await loop;

    assert.ok(reconcileCalls > 1);
    assert.equal(blockedMessages.includes("ATLAS drift reindex is running"), false);
  });

  slowIt("dispatches queued jobs up to concurrency", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scheduler WI", "desc");
    const wi2 = queueMod.createWorkItem("Scheduler WI 2", "desc");
    const jobA = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Job A",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["scheduler-a.txt"],
        create_roots: [],
      },
    });
    const jobB = queueMod.createJob({
      work_item_id: wi2.id,
      job_type: "dev",
      title: "Job B",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["scheduler-b.txt"],
        create_roots: [],
      },
    });

    let active = 0;
    let maxActive = 0;
    let doneCalled = false;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-conc", pollMs: 5, leaseSec: 60, concurrency: 2 });

    await scheduler.start(async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      queueMod.updateJobStatus(job.id, "running");
      await new Promise((resolve) => setTimeout(resolve, 15));
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      active -= 1;
    }, {
      onDone: () => { doneCalled = true; },
    });

    assert.ok(doneCalled);
    assert.equal(maxActive, 2);
    assert.equal(queueMod.getJob(jobA.id).status, "succeeded");
    assert.equal(queueMod.getJob(jobB.id).status, "succeeded");
  });

  slowIt("does not redispatch a requeued job while its original worker is still active", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scheduler requeue WI", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Requeue same job",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["scheduler-requeue.txt"],
        create_roots: [],
      },
    });

    let starts = 0;
    let active = 0;
    let maxActive = 0;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-requeue-active", pollMs: 5, leaseSec: 60, concurrency: 2 });

    await scheduler.start(async (leasedJob) => {
      starts++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (starts === 1) {
        assert.equal(queueMod.releaseLeaseWithoutAttemptPenalty(
          leasedJob.id,
          leasedJob._leaseToken,
          "queued",
          { readyAt: new Date().toISOString() },
        ), true);
        await new Promise((resolve) => setTimeout(resolve, 35));
      } else {
        assert.equal(queueMod.releaseLease(leasedJob.id, leasedJob._leaseToken, "succeeded"), true);
      }
      active--;
    });

    assert.equal(starts, 2);
    assert.equal(maxActive, 1);
    assert.equal(queueMod.getJob(job.id).status, "succeeded");
  });

  slowIt("runs at most one ATLAS warm job per branch at a time", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("ATLAS warm WI", "desc");
    const warmA = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "atlas_warm",
      title: "ATLAS warm A",
      priority: "high",
      model_tier: null,
      reasoning_effort: null,
      provider: null,
      payload_json: { purpose: "wi", work_item_id: wi.id, branch: `wi-${wi.id}` },
    });
    const warmB = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "atlas_warm",
      title: "ATLAS warm B",
      priority: "high",
      model_tier: null,
      reasoning_effort: null,
      provider: null,
      payload_json: { purpose: "wi", work_item_id: wi.id, branch: `wi-${wi.id}` },
    });

    let active = 0;
    let maxActive = 0;
    const seen = [];
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-atlas-warm-one-per-branch", pollMs: 5, leaseSec: 60, concurrency: 2 });

    await scheduler.start(async (job) => {
      seen.push(job.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      queueMod.updateJobStatus(job.id, "running");
      await new Promise((resolve) => setTimeout(resolve, 20));
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      active -= 1;
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(seen.sort((a, b) => a - b), [warmA.id, warmB.id].sort((a, b) => a - b));
    assert.equal(queueMod.getJob(warmA.id).status, "succeeded");
    assert.equal(queueMod.getJob(warmB.id).status, "succeeded");
  });

  slowIt("dispatches same-work-item disjoint scoped jobs up to concurrency", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Parallel WI", "desc");
    const jobs = [
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Create admin shell",
        payload_json: {
          files_to_modify: [],
          files_to_create: ["htdocs/admin.php"],
          create_roots: ["htdocs"],
        },
      }),
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Create admin app",
        payload_json: {
          files_to_modify: [],
          files_to_create: ["htdocs/assets/js/admin/admin-app.js"],
          create_roots: [],
        },
      }),
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Create admin metrics",
        payload_json: {
          files_to_modify: [],
          files_to_create: ["htdocs/assets/js/admin/admin-metrics.js"],
          create_roots: ["htdocs/assets/js/admin"],
        },
      }),
    ];

    let active = 0;
    let maxActive = 0;
    let doneCalled = false;
    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-inner-wi", pollMs: 5, leaseSec: 60, concurrency: 3 });

    await scheduler.start(async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      queueMod.updateJobStatus(job.id, "running");
      await new Promise((resolve) => setTimeout(resolve, 20));
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      active -= 1;
    }, {
      onDone: () => { doneCalled = true; },
    });

    assert.ok(doneCalled);
    assert.equal(maxActive, 3);
    for (const job of jobs) {
      assert.equal(queueMod.getJob(job.id).status, "succeeded");
    }
  });

  it("scans past a blocked runnable batch to launch disjoint work", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const heldWi = queueMod.createWorkItem("Held lock", "desc");
    const held = queueMod.createJob({
      work_item_id: heldWi.id,
      job_type: "dev",
      title: "Held shared file",
      payload_json: {
        files_to_modify: ["shared.txt"],
        files_to_create: [],
        create_roots: [],
      },
    });
    const heldLease = queueMod.acquireLeaseWithWriteLocks(held, "held-worker", 60);
    assert.ok(heldLease?.leaseToken);
    queueMod.updateJobStatus(held.id, "running");

    for (let i = 0; i < 25; i++) {
      const wi = queueMod.createWorkItem(`Blocked ${i}`, "desc");
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: `Blocked shared ${i}`,
        priority: "high",
        payload_json: {
          files_to_modify: ["shared.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
    }

    const freeWi = queueMod.createWorkItem("Free work", "desc");
    const free = queueMod.createJob({
      work_item_id: freeWi.id,
      job_type: "dev",
      title: "Free disjoint work",
      priority: "low",
      payload_json: {
        files_to_modify: [],
        files_to_create: ["free.txt"],
        create_roots: [],
      },
    });

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-lookahead", pollMs: 5, leaseSec: 60, concurrency: 1 });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    const launched = [];
    const loop = scheduler.runLoop(async (job) => {
      launched.push(job.id);
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      scheduler.stop();
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    scheduler.stop();
    await loop;

    assert.deepEqual(launched, [free.id]);
    assert.equal(queueMod.getJob(free.id).status, "succeeded");
  });

  it("surfaces human_input gates even when compute slots are saturated", async () => {
    const { queueMod, schedulerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Human gate fairness", "desc");
    const longCompute = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Long compute",
      priority: "urgent",
    });
    for (let i = 0; i < 30; i++) {
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: `Queued compute ${i}`,
        priority: "urgent",
      });
    }
    const human = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Human gate",
      priority: "low",
    });

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-human-fairness", pollMs: 5, leaseSec: 60, concurrency: 1 });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;

    let releaseCompute;
    const computeCanFinish = new Promise((resolve) => { releaseCompute = resolve; });
    const launched = [];
    const loop = scheduler.runLoop(async (job) => {
      launched.push(job.id);
      if (job.id === longCompute.id) {
        await computeCanFinish;
        queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
        return;
      }
      if (job.id === human.id) {
        queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
        releaseCompute();
        scheduler.stop();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseCompute();
    scheduler.stop();
    await loop;

    assert.equal(launched.includes(human.id), true);
    assert.equal(queueMod.getJob(human.id).status, "succeeded");
  });
});

// TEST: findRunnableJob query correctness
// ═════════════════════════════════════════════════════════════════════════════
