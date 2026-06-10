import {
  it,
  before,
  beforeEach,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
  getProviderName,
  parseFileRequest,
  splitFileRequestsByRisk,
  artifactsDir,
  contextDir,
  wiScopeId,
} from "../support/core-harness.js";
import { TERMINAL_JOB_STATUSES } from "../../../lib/catalog/job.js";

let db;

suite("Headless approval recovery", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("cancels approval-gated follow-up jobs instead of auto-unblocking them", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Headless approval", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
    });
    queueMod.updateJobStatus(origin.id, "succeeded");
    const approvalGate = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Approve files: dangerous.sh",
      parent_job_id: origin.id,
      payload_json: JSON.stringify({
        original_job_id: origin.id,
        questions: ["Approve dangerous file?"],
        file_requests: [{ path: "scripts/dangerous.sh", risk: "high" }],
      }),
    });
    queueMod.updateJobStatus(approvalGate.id, "waiting_on_human");
    const gatedDev = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Create files (approved): dangerous.sh",
    });
    queueMod.addDependency(gatedDev.id, origin.id, "hard");
    queueMod.addDependency(gatedDev.id, approvalGate.id, "hard");

    const payload = JSON.parse(queueMod.getJob(approvalGate.id).payload_json);
    const dependents = queueMod.getDependents(approvalGate.id);
    const isApprovalGate = Array.isArray(payload.file_requests) && payload.file_requests.length > 0;
    assert.equal(isApprovalGate, true);

    for (const dep of dependents) {
      const depJob = queueMod.getJob(dep.job_id);
      if (TERMINAL_JOB_STATUSES.includes(depJob.status)) continue;
      queueMod.updateJobStatus(depJob.id, "canceled");
    }
    queueMod.updateJobStatus(approvalGate.id, "failed");

    assert.equal(queueMod.getJob(approvalGate.id).status, "failed");
    assert.equal(queueMod.getJob(gatedDev.id).status, "canceled");
  });

  it("refreshes cross-WI dependents canceled by headless approval timeout", async () => {
    const { queueMod, dbMod, schedulerMod } = runtimeModules;
    const sourceWi = queueMod.createWorkItem("Headless source approval", "desc");
    const blockedWi = queueMod.createWorkItem("Blocked follow-up", "desc");
    const origin = queueMod.createJob({
      work_item_id: sourceWi.id,
      job_type: "dev",
      title: "Origin job",
    });
    queueMod.updateJobStatus(origin.id, "succeeded");
    const approvalGate = queueMod.createJob({
      work_item_id: sourceWi.id,
      job_type: "human_input",
      title: "Approve files: generated.js",
      parent_job_id: origin.id,
      payload_json: JSON.stringify({
        original_job_id: origin.id,
        questions: ["Approve generated file?"],
        file_requests: [{ path: "src/generated.js", risk: "high" }],
      }),
    });
    queueMod.updateJobStatus(approvalGate.id, "waiting_on_human");
    dbMod.getDb().prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`)
      .run("2000-01-01T00:00:00.000Z", approvalGate.id);
    const dependent = queueMod.createJob({
      work_item_id: blockedWi.id,
      job_type: "dev",
      title: "Cross-WI dependent",
    });
    queueMod.addDependency(dependent.id, approvalGate.id, "hard");

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-headless-timeout", pollMs: 5, hasDisplay: false });
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;
    const loop = scheduler.runLoop(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    scheduler.stop();
    await loop;

    assert.equal(queueMod.getJob(approvalGate.id).status, "failed");
    assert.equal(queueMod.getJob(dependent.id).status, "canceled");
    assert.equal(queueMod.getWorkItem(blockedWi.id).status, "canceled");
  });

  it("does not requeue parked human/review jobs on orphan recovery", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Parked review", "desc");
    const reviewJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Needs review",
    });
    queueMod.updateJobStatus(reviewJob.id, "waiting_on_review");

    const humanJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Review gate",
      parent_job_id: reviewJob.id,
    });
    queueMod.updateJobStatus(humanJob.id, "waiting_on_human");

    const requeued = queueMod.requeueOrphanedJobs();

    assert.equal(requeued, 0);
    assert.equal(queueMod.getJob(reviewJob.id).status, "waiting_on_review");
    assert.equal(queueMod.getJob(humanJob.id).status, "waiting_on_human");
  });

  it("logs non-human waiting_on_human jobs in headless mode without requeueing them", async () => {
    const { queueMod, schedulerMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Headless non-human wait", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Parked dev job",
    });
    queueMod.updateJobStatus(job.id, "waiting_on_human");
    dbMod.getDb().prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`)
      .run("2000-01-01T00:00:00.000Z", job.id);

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-headless-non-human", pollMs: 5, hasDisplay: false });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;
    const loop = scheduler.runLoop(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    scheduler.stop();
    await loop;

    assert.equal(queueMod.getJob(job.id).status, "waiting_on_human");
    const events = queueMod.getEvents(job.id, 20);
    assert.equal(events.filter((event) => event.event_type === "job.headless_non_human_waiting_on_human").length, 1);
  });

  it("audits dependency removals when a headless human gate times out", async () => {
    const { queueMod, schedulerMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Headless dependency audit", "desc");
    const humanJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Clarify requirement",
      payload_json: JSON.stringify({ questions: ["Clarify?"] }),
    });
    queueMod.updateJobStatus(humanJob.id, "waiting_on_human");
    dbMod.getDb().prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`)
      .run("2000-01-01T00:00:00.000Z", humanJob.id);
    const dependent = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Continue after clarification",
    });
    queueMod.addDependency(dependent.id, humanJob.id, "hard");

    const scheduler = new schedulerMod.Scheduler({ ownerId: "sched-headless-dep-audit", pollMs: 5, hasDisplay: false });
    scheduler.onEvent = () => {};
    assert.equal(queueMod.acquireSchedulerLock("main", scheduler.ownerId, 60), true);
    scheduler._running = true;
    const loop = scheduler.runLoop(async (job) => {
      queueMod.releaseLease(job.id, job._leaseToken, "succeeded");
      scheduler.stop();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    scheduler.stop();
    await loop;

    assert.equal(queueMod.getJob(humanJob.id).status, "failed");
    assert.equal(queueMod.getDependencies(dependent.id).some((dep) => dep.depends_on_job_id === humanJob.id), false);
    const events = queueMod.getEvents(dependent.id, 20);
    assert.equal(events.some((event) => event.event_type === "job.dependency_removed"), true);
  });

  it("does not requeue active jobs with fresh leases on orphan recovery", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Fresh lease", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Still running",
    });

    const lease = queueMod.acquireLease(job.id, "scheduler-live", 900);
    assert.ok(lease?.leaseToken);
    assert.equal(queueMod.updateJobStatus(job.id, "running", { leaseToken: lease.leaseToken }), true);

    const requeued = queueMod.requeueOrphanedJobs();
    const refreshed = queueMod.getJob(job.id);

    assert.equal(requeued, 0);
    assert.equal(refreshed.status, "running");
    assert.equal(refreshed.lease_token, lease.leaseToken);
  });

  it("preserves malformed assessment payloads when orphan recovery marks assess-only", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Malformed orphan payload", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Malformed force recovery",
      payload_json: JSON.stringify({ task_spec: "valid before corruption" }),
    });
    const lease = queueMod.acquireLease(job.id, "scheduler-prev", 900);
    assert.ok(lease?.leaseToken);
    assert.equal(queueMod.updateJobStatus(job.id, "awaiting_assessment", { leaseToken: lease.leaseToken }), true);
    db.exec(`DROP TRIGGER IF EXISTS posse_json_valid_jobs_payload_json_update`);
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run("{not-json", job.id);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }

    const requeued = queueMod.requeueOrphanedJobs({ force: true });
    const payload = JSON.parse(queueMod.getJob(job.id).payload_json);

    assert.equal(requeued, 1);
    assert.equal(payload._assess_only, 1);
    assert.equal(payload._legacy_invalid_payload_json, "{not-json");
  });

  it("preserves malformed assessment payloads when expired leases mark assess-only", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Malformed expired payload", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Malformed expired recovery",
      payload_json: JSON.stringify({ task_spec: "valid before corruption" }),
    });
    const lease = queueMod.acquireLease(job.id, "scheduler-prev", 900);
    assert.ok(lease?.leaseToken);
    assert.equal(queueMod.updateJobStatus(job.id, "awaiting_assessment", { leaseToken: lease.leaseToken }), true);
    db.exec(`DROP TRIGGER IF EXISTS posse_json_valid_jobs_payload_json_update`);
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`
        UPDATE jobs
        SET payload_json = ?,
            lease_expires_at = ?
        WHERE id = ?
      `).run("{still-not-json", "2000-01-01T00:00:00.000Z", job.id);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }

    const requeued = queueMod.requeueExpiredLeases();
    const payload = JSON.parse(queueMod.getJob(job.id).payload_json);

    assert.equal(requeued, 1);
    assert.equal(payload._assess_only, 1);
    assert.equal(payload._legacy_invalid_payload_json, "{still-not-json");
  });

  it("marks graceful-shutdown assessment requeues as assess-only", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Shutdown assessment payload", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Shutdown assessment recovery",
      payload_json: JSON.stringify({ task_spec: "assess the committed work" }),
    });
    const lease = queueMod.acquireLease(job.id, "scheduler-current", 900);
    assert.ok(lease?.leaseToken);
    assert.equal(queueMod.updateJobStatus(job.id, "awaiting_assessment", { leaseToken: lease.leaseToken }), true);
    db.prepare(`UPDATE jobs SET attempt_count = 2 WHERE id = ?`).run(job.id);

    assert.equal(queueMod.requeueForShutdown(job.id), true);
    const refreshed = queueMod.getJob(job.id);
    const payload = JSON.parse(refreshed.payload_json);

    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.attempt_count, 2);
    assert.equal(payload._assess_only, 1);
  });

  it("preserves malformed payloads when stall-resume flags are updated", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Malformed stall resume payload", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Malformed stall resume",
      payload_json: JSON.stringify({ task_spec: "valid before corruption" }),
    });
    db.exec(`DROP TRIGGER IF EXISTS posse_json_valid_jobs_payload_json_update`);

    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run("{stall-flag", job.id);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
    queueMod.flagStallResume(job.id);
    let payload = JSON.parse(queueMod.getJob(job.id).payload_json);
    assert.equal(payload._stall_resume, true);
    assert.equal(payload._legacy_invalid_payload_json, "{stall-flag");

    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run("{stall-clear", job.id);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
    queueMod.clearStallResume(job.id);
    payload = JSON.parse(queueMod.getJob(job.id).payload_json);
    assert.equal(Object.hasOwn(payload, "_stall_resume"), false);
    assert.equal(payload._legacy_invalid_payload_json, "{stall-clear");
  });

  it("force-requeues fresh-lease held jobs so Ctrl+C survivors resume on boot", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Ctrl+C resume", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Killed mid-run",
    });

    const lease = queueMod.acquireLease(job.id, "scheduler-prev", 900);
    assert.ok(lease?.leaseToken);
    queueMod.updateJobStatus(job.id, "running");

    const requeued = queueMod.requeueOrphanedJobs({ force: true });
    const refreshed = queueMod.getJob(job.id);

    assert.equal(requeued, 1);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.lease_token, null);
    assert.equal(refreshed.lease_owner, null);
  });

  it("requeues parked human_input jobs when an interactive display returns", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Resume human prompts", "desc");
    const reviewJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Needs input",
    });
    queueMod.updateJobStatus(reviewJob.id, "waiting_on_review");

    const humanJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Prompt user",
      parent_job_id: reviewJob.id,
      payload_json: JSON.stringify({ original_job_id: reviewJob.id, questions: ["Continue?"] }),
    });
    queueMod.updateJobStatus(humanJob.id, "waiting_on_human");

    const revived = queueMod.requeueWaitingHumanInputJobs();

    assert.deepEqual(revived, [{ job_id: humanJob.id, work_item_id: wi.id }]);
    assert.equal(queueMod.getJob(humanJob.id).status, "queued");
    assert.equal(queueMod.getJob(reviewJob.id).status, "waiting_on_review");
  });

  it("logs an event when a human_input attempt is skipped for a stale lease", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Stale human prompt", "desc");
    const humanJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Prompt user",
      payload_json: JSON.stringify({ questions: ["Continue?"] }),
    });

    const lease = queueMod.acquireLease(humanJob.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(humanJob.id);
    leasedJob._leaseToken = `${lease.leaseToken}-stale`;

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };
    await worker.execute(leasedJob);

    const events = queueMod.getEventsByWorkItem(wi.id, 20);
    const staleEvent = events.find(row => row.event_type === "job.attempt_skipped_stale_lease");
    assert.ok(staleEvent, "expected stale lease skip to be visible in events");
    assert.match(staleEvent.message, /human_input/);
    assert.ok(emitted.some(msg => msg.includes("[stale-lease]")));
  });

  it("keeps CI and package file requests behind a human gate in the worker follow-up path", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Sensitive file requests", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
      payload_json: JSON.stringify({ task_spec: "Create the requested project files." }),
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const requests = parseFileRequest([
      "FILE_REQUEST:",
      "- .github/workflows/ci.yml -- CI workflow",
      "- package.json -- package manifest",
      "- styles/theme.css -- static styling",
      "FILE_REQUEST_END",
    ].join("\n"));

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._spawnFileRequestFollowUp(origin, splitFileRequestsByRisk(requests), null);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const autoDev = jobs.find(j => j.job_type === "dev" && /^Create files \(auto\):/.test(j.title));
    const approvalGate = jobs.find(j => j.job_type === "human_input" && /^Approve files:/.test(j.title));
    const gatedDev = jobs.find(j => j.job_type === "dev" && /^Create files \(approved\):/.test(j.title));

    assert.ok(autoDev, "expected low-risk styling file to get an auto dev follow-up");
    assert.ok(approvalGate, "expected sensitive requests to create a human approval gate");
    assert.ok(gatedDev, "expected gated dev job for approved sensitive files");
    assert.deepEqual(JSON.parse(autoDev.payload_json).files_to_create, ["styles/theme.css"]);
    assert.deepEqual(JSON.parse(autoDev.payload_json).create_roots, []);
    assert.deepEqual(JSON.parse(gatedDev.payload_json).files_to_create, [".github/workflows/ci.yml", "package.json"]);
  });

  it("propagates artifact-mode fields into spawned file request follow-ups", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Artifact file requests", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Generate image artifact",
      payload_json: JSON.stringify({
        task_spec: "Create the requested image artifact support file.",
        task_mode: "image",
        output_root: ".posse/resources/wi-1/task-01",
        needs_image_generation: true,
      }),
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._spawnFileRequestFollowUp(origin, {
      autoApproved: [{ path: ".posse/resources/wi-1/task-01/manifest.json", risk: "low", reason: "artifact manifest" }],
      needsApproval: [],
    }, null);

    const followUp = queueMod.listJobsByWorkItem(wi.id)
      .find((job) => job.job_type === "dev" && /^Create files \(auto\):/.test(job.title));
    assert.ok(followUp, "expected an auto-approved file-create job");
    const payload = JSON.parse(followUp.payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.output_root, ".posse/resources/wi-1/task-01");
    assert.equal(payload.needs_image_generation, true);
  });

  it("completes file approval gates from a single approval answer", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("File approval gate", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._spawnFileRequestFollowUp(origin, {
      autoApproved: [],
      needsApproval: [{ path: "scripts/dangerous.sh", risk: "high", reason: "Needs an executable helper" }],
    }, null);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const approvalGate = jobs.find(j => j.job_type === "human_input");
    const gatedDev = jobs.find(j => j.job_type === "dev" && /^Create files \(approved\):/.test(j.title));
    const approvalPayload = JSON.parse(approvalGate.payload_json);
    assert.equal(approvalPayload.questions.length, 1);

    const lease = queueMod.acquireLease(approvalGate.id, "test-worker", 900);
    const leasedGate = queueMod.getJob(approvalGate.id);
    leasedGate._leaseToken = lease.leaseToken;

    const approvingWorker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: approvalPayload.questions[0], answer: "approve" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await approvingWorker.execute(leasedGate);

    assert.equal(queueMod.getJob(approvalGate.id).status, "succeeded");
    assert.equal(queueMod.getJob(gatedDev.id).status, "queued");
  });

  it("accepts plain-string human answers for file approval gates", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("File approval gate string answer", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._spawnFileRequestFollowUp(origin, {
      autoApproved: [],
      needsApproval: [{ path: "scripts/dangerous.sh", risk: "high", reason: "Needs an executable helper" }],
    }, null);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const approvalGate = jobs.find(j => j.job_type === "human_input");
    const gatedDev = jobs.find(j => j.job_type === "dev" && /^Create files \(approved\):/.test(j.title));

    const lease = queueMod.acquireLease(approvalGate.id, "test-worker", 900);
    const leasedGate = queueMod.getJob(approvalGate.id);
    leasedGate._leaseToken = lease.leaseToken;

    const approvingWorker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => ["approve"],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await approvingWorker.execute(leasedGate);

    assert.equal(queueMod.getJob(approvalGate.id).status, "succeeded");
    assert.equal(queueMod.getJob(gatedDev.id).status, "queued");
  });

  it("cancels gated file-creation jobs when approval is rejected", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("File approval rejection", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._spawnFileRequestFollowUp(origin, {
      autoApproved: [],
      needsApproval: [{ path: "scripts/dangerous.sh", risk: "high", reason: "Needs an executable helper" }],
    }, null);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const approvalGate = jobs.find(j => j.job_type === "human_input");
    const gatedDev = jobs.find(j => j.job_type === "dev" && /^Create files \(approved\):/.test(j.title));
    const approvalPayload = JSON.parse(approvalGate.payload_json);

    const lease = queueMod.acquireLease(approvalGate.id, "test-worker", 900);
    const leasedGate = queueMod.getJob(approvalGate.id);
    leasedGate._leaseToken = lease.leaseToken;

    const rejectingWorker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: approvalPayload.questions[0], answer: "reject" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await rejectingWorker.execute(leasedGate);

    assert.equal(queueMod.getJob(approvalGate.id).status, "failed");
    assert.equal(queueMod.getJob(gatedDev.id).status, "canceled");
  });

  it("resolves assessment parse-error reviews as pass instead of requeueing the original job", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Assessment review pass", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev job",
    });
    queueMod.updateJobStatus(original.id, "awaiting_assessment");

    const review = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Assessment unparseable: Original dev job",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "assessment_parse_error",
        questions: ["Should this pass or fail?"],
      }),
    });

    const lease = queueMod.acquireLease(review.id, "test-worker", 900);
    const leasedReview = queueMod.getJob(review.id);
    leasedReview._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Should this pass or fail?", answer: "pass" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await worker.execute(leasedReview);

    assert.equal(queueMod.getJob(review.id).status, "succeeded");
    assert.equal(queueMod.getJob(original.id).status, "succeeded");
  });

  it("resolves assessment parse-error reviews as fail instead of requeueing the original job", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Assessment review fail", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev job",
    });
    queueMod.updateJobStatus(original.id, "waiting_on_review");

    const review = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Assessment unparseable: Original dev job",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "assessment_parse_error",
        questions: ["Should this pass or fail?"],
      }),
    });

    const lease = queueMod.acquireLease(review.id, "test-worker", 900);
    const leasedReview = queueMod.getJob(review.id);
    leasedReview._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Should this pass or fail?", answer: "fail" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await worker.execute(leasedReview);

    assert.equal(queueMod.getJob(review.id).status, "succeeded");
    assert.equal(queueMod.getJob(original.id).status, "failed");
  });

  it("turns review-driven replan answers into actual replan jobs instead of requeueing the original job", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Assessment review replan", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev job",
    });
    queueMod.updateJobStatus(original.id, "waiting_on_review");

    const review = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Review needed: Original dev job",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "replan_limit",
        questions: ["Pass, fail, skip, or replan?"],
      }),
    });

    const lease = queueMod.acquireLease(review.id, "test-worker", 900);
    const leasedReview = queueMod.getJob(review.id);
    leasedReview._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Pass, fail, skip, or replan?", answer: "replan" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await worker.execute(leasedReview);

    assert.equal(queueMod.getJob(review.id).status, "succeeded");
    assert.equal(queueMod.getJob(original.id).status, "failed");
    const jobs = queueMod.listJobsByWorkItem(wi.id);
    assert.ok(jobs.some(j => j.job_type === "research" && /^Research \(replan\):/.test(j.title)));
    assert.equal(jobs.some(j => j.job_type === "plan" && /^Replan:/.test(j.title)), false);
  });

  it("forces an explicit human decision when assessment retry requests hit the retry cap", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Assessment retry cap", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original dev job",
    });
    queueMod.updateJobStatus(original.id, "waiting_on_review");
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: original.id,
      event_type: "job.review_retry_assessment",
      actor_type: "worker",
      message: "retry 1",
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: original.id,
      event_type: "job.review_retry_assessment",
      actor_type: "worker",
      message: "retry 2",
    });

    const review = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Review needed: Original dev job",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "assessment_transport_error",
        questions: ["Retry assessment, pass, fail, skip, or replan?"],
      }),
    });

    const lease = queueMod.acquireLease(review.id, "test-worker", 900);
    const leasedReview = queueMod.getJob(review.id);
    leasedReview._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Retry assessment, pass, fail, skip, or replan?", answer: "retry" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await worker.execute(leasedReview);

    assert.equal(queueMod.getJob(review.id).status, "succeeded");
    assert.equal(queueMod.getJob(original.id).status, "waiting_on_review");
    const followUps = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === original.id && job.id !== review.id);
    const forcedReview = followUps.find((job) => {
      try {
        return JSON.parse(job.payload_json || "{}").review_type === "assessment_retry_limit";
      } catch {
        return false;
      }
    });
    assert.ok(forcedReview, "expected a forced-resolution human review job");
    assert.equal(forcedReview.status, "queued");
  });

  it("turns dead-letter recovery retry answers into replacement jobs before unblocking dependents", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Dead-letter recovery retry", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Backend auth",
      payload_json: JSON.stringify({
        task_spec: "Implement backend auth",
        files_to_create: ["includes/config.local.php"],
        files_to_modify: ["api/index.php"],
      }),
    });
    queueMod.updateJobStatus(original.id, "dead_letter");

    const recovery = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Dead-letter recovery: Backend auth",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "dead_letter_recovery",
        questions: ["Retry?"],
      }),
    });

    const dependent = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Frontend auth",
    });
    queueMod.addDependency(dependent.id, recovery.id, "hard");

    const lease = queueMod.acquireLease(recovery.id, "test-worker", 900);
    const leasedRecovery = queueMod.getJob(recovery.id);
    leasedRecovery._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Retry?", answer: "rertry on codex" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });

    await worker.execute(leasedRecovery);

    assert.equal(queueMod.getJob(recovery.id).status, "succeeded");
    assert.equal(queueMod.getJob(original.id).status, "dead_letter");
    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const retry = jobs.find((job) => job.parent_job_id === original.id && job.title === "Retry: Backend auth");
    assert.ok(retry, "expected a replacement retry job");
    assert.equal(retry.provider, "codex");
    assert.equal(retry.status, "queued");
    const retryPayload = JSON.parse(retry.payload_json);
    assert.match(retryPayload.task_spec, /RECOVERY INSTRUCTIONS/);
    assert.match(retryPayload.task_spec, /rertry on codex/);
    const deps = queueMod.getDependencies(dependent.id);
    assert.deepEqual(deps.map((dep) => dep.depends_on_job_id), [retry.id]);
  });

  it("repairs promote source_dir and preserves upstream deps for dead-letter recovery retries", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-promote-recovery-"));
    try {
      const wi = queueMod.createWorkItem("Promote recovery retry", "desc");
      const artifactRoot = artifactsDir(wiScopeId(wi.id), projectDir).replace(/\\/g, "/");
      const outputRoot = `${artifactRoot}/task-01-generate-images-for-integrate-hero`;
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "cat-composite.png"), "png", "utf8");
      fs.mkdirSync(`${artifactRoot}/task-00-older-image`, { recursive: true });
      fs.writeFileSync(path.join(artifactRoot, "task-00-older-image", "cat-composite.png"), "old", "utf8");

      const upstream = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate images",
        status: "succeeded",
        payload_json: JSON.stringify({
          task_mode: "image",
          output_root: outputRoot,
          files_to_create: [`${outputRoot}/cat-composite.png`],
        }),
      });
      const original = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "promote",
        title: "Promote cat composite",
        status: "dead_letter",
        payload_json: JSON.stringify({
          source_dir: artifactRoot,
          mappings: [{ pattern: "cat-composite.png", dest: "htdocs/assets/img/cat-composite.png", destination_type: "file" }],
          files_to_create: ["htdocs/assets/img/cat-composite.png"],
          create_roots: ["htdocs/assets/img"],
        }),
      });
      queueMod.addDependency(original.id, upstream.id, "hard");

      const recovery = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "human_input",
        title: "Dead-letter recovery: Promote cat composite",
        parent_job_id: original.id,
        payload_json: JSON.stringify({
          original_job_id: original.id,
          review_type: "dead_letter_recovery",
          questions: ["Retry?"],
        }),
      });
      const dependent = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Wire promoted image",
      });
      queueMod.addDependency(dependent.id, recovery.id, "hard");

      const lease = queueMod.acquireLease(recovery.id, "test-worker", 900);
      const leasedRecovery = queueMod.getJob(recovery.id);
      leasedRecovery._leaseToken = lease.leaseToken;

      const worker = new workerMod.Worker({
        projectDir,
        silent: true,
        display: {
          askQuestions: async () => [{ question: "Retry?", answer: "retry" }],
          workerLine: () => {},
          addEvent: () => {},
          render: () => {},
        },
      });

      await worker.execute(leasedRecovery);

      const jobs = queueMod.listJobsByWorkItem(wi.id);
      const retry = jobs.find((job) => job.parent_job_id === original.id && job.title === "Retry: Promote cat composite");
      assert.ok(retry, "expected a replacement promote retry job");
      const retryPayload = JSON.parse(retry.payload_json);
      assert.equal(retryPayload.source_dir, outputRoot);
      assert.equal(retryPayload._dead_letter_recovery.promote_source_dir_repaired, true);
      assert.deepEqual(queueMod.getDependencies(retry.id).map((dep) => dep.depends_on_job_id), [upstream.id]);
      assert.deepEqual(queueMod.getDependencies(dependent.id).map((dep) => dep.depends_on_job_id), [retry.id]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses prior original promote deps when retrying a dead-lettered recovery retry", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-promote-reretry-"));
    try {
      const wi = queueMod.createWorkItem("Promote recovery retry chain", "desc");
      const artifactRoot = artifactsDir(wiScopeId(wi.id), projectDir).replace(/\\/g, "/");
      const outputRoot = `${artifactRoot}/task-01-generate-images-for-integrate-hero`;
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "cat-composite.png"), "png", "utf8");

      const upstream = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate images",
        status: "succeeded",
        payload_json: JSON.stringify({ task_mode: "image", output_root: outputRoot }),
      });
      const original = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "promote",
        title: "Promote cat composite",
        status: "dead_letter",
        payload_json: JSON.stringify({
          source_dir: artifactRoot,
          mappings: [{ pattern: "cat-composite.png", dest: "htdocs/assets/img/cat-composite.png", destination_type: "file" }],
        }),
      });
      queueMod.addDependency(original.id, upstream.id, "hard");
      const failedRetry = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "promote",
        title: "Retry: Promote cat composite",
        parent_job_id: original.id,
        status: "dead_letter",
        payload_json: JSON.stringify({
          source_dir: artifactRoot,
          mappings: [{ pattern: "cat-composite.png", dest: "htdocs/assets/img/cat-composite.png", destination_type: "file" }],
          _dead_letter_recovery: {
            original_job_id: original.id,
            recovery_job_id: 999,
            human_answer: "retry",
          },
        }),
      });

      const recovery = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "human_input",
        title: "Dead-letter recovery: Retry promote",
        parent_job_id: failedRetry.id,
        payload_json: JSON.stringify({
          original_job_id: failedRetry.id,
          review_type: "dead_letter_recovery",
          questions: ["Retry?"],
        }),
      });
      const dependent = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Wire promoted image" });
      queueMod.addDependency(dependent.id, recovery.id, "hard");

      const lease = queueMod.acquireLease(recovery.id, "test-worker", 900);
      const leasedRecovery = queueMod.getJob(recovery.id);
      leasedRecovery._leaseToken = lease.leaseToken;
      const worker = new workerMod.Worker({
        projectDir,
        silent: true,
        display: {
          askQuestions: async () => [{ question: "Retry?", answer: "retry" }],
          workerLine: () => {},
          addEvent: () => {},
          render: () => {},
        },
      });

      await worker.execute(leasedRecovery);

      const jobs = queueMod.listJobsByWorkItem(wi.id);
      const retry = jobs.find((job) => job.parent_job_id === failedRetry.id && job.title === "Retry: Retry: Promote cat composite");
      assert.ok(retry, "expected a replacement promote retry job");
      const retryPayload = JSON.parse(retry.payload_json);
      assert.equal(retryPayload.source_dir, outputRoot);
      assert.equal(retryPayload._dead_letter_recovery.prior_original_job_id, original.id);
      assert.deepEqual(queueMod.getDependencies(retry.id).map((dep) => dep.depends_on_job_id), [upstream.id]);
      assert.deepEqual(queueMod.getDependencies(dependent.id).map((dep) => dep.depends_on_job_id), [retry.id]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("injects planner routing context for artificer and promote decisions", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner routing context", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Planner routing context",
    });
    queueMod.updateJobStatus(researchJob.id, "succeeded");
    const structured = {
      key_files: ["lib/domains/artifacts/functions/index.js"],
      related_files: [],
      patterns: {},
      constraints: [],
      questions_for_human: false,
      questions: [],
    };
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: researchJob.id,
      attempt_id: null,
      artifact_type: "response",
      content_long: "# Research Brief\nImage work should become artifact tasks.\n\n```json\n" + JSON.stringify(structured, null, 2) + "\n```",
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Planner routing context",
    });

    let capturedPrompt = "";
    const worker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt) => {
      capturedPrompt = prompt;
      return {
        output: '```json\n[{"title":"Generate hero image","job_type":"artificer","task_mode":"image","task_spec":"Generate it","files_to_modify":[],"files_to_create":[],"create_roots":[".posse/resources/artifacts/wi-1"],"output_root":".posse/resources/artifacts/wi-1","success_criteria":["done"],"depends_on_index":[]}]\n```',
        stats: { numTurns: 1 },
      };
    });
    const previousArtificer = queueMod.getSetting("provider_artificer");
    try {
      queueMod.setSetting("provider_artificer", "openai");

      await dispatchWorker(worker, planJob, "standard", null);

      assert.match(capturedPrompt, /PIPELINE ROUTING CONTEXT/);
      assert.match(capturedPrompt, /Non-code deliverables belong to the ARTIFICER role/i);
      assert.match(
        capturedPrompt,
        new RegExp(`Admin-backed provider selections: planner=${getProviderName("planner")}, artificer=${getProviderName("artificer")}, dev=${getProviderName("dev")}`),
      );
      assert.match(capturedPrompt, /insert a .*promote.* job between the artificer task and the dev task/i);
    } finally {
      queueMod.setSetting("provider_artificer", previousArtificer);
      fs.rmSync(contextDir(`wi-${wi.id}`, projectDir), { recursive: true, force: true });
    }
  });

  it("does not spawn follow-up create jobs for invalid wildcard pseudo-path requests", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Ignore bogus file requests", "desc");
    const origin = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Origin job",
      payload_json: JSON.stringify({ task_spec: "test", files_to_modify: [], files_to_create: [] }),
    });
    queueMod.updateJobStatus(origin.id, "succeeded");

    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });
    worker._spawnFileRequestFollowUp(origin, {
      autoApproved: [{ path: "*.db-wal", risk: "mid", reason: "ignore glob" }],
      needsApproval: [{ path: ".db", risk: "high", reason: "bogus pseudo-dotfile" }],
    }, null);

    const jobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== origin.id);
    assert.equal(jobs.length, 0);
    assert.ok(queueMod.getEvents(origin.id, 5).some((event) => event.event_type === "job.file_request_sanitized_empty"));
  });

  it("quietly normalizes model_tier synonym aliases without plan-validate noise", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner alias tier", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: alias tier",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };

    worker.createJobsFromPlan(planJob, [{
      title: "Alias tier task",
      task_spec: "Do the thing",
      job_type: "dev",
      model_tier: "sonnet",
      files_to_modify: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    assert.ok(!emitted.some(msg => msg.includes('normalized model_tier "sonnet"')));
    const jobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id);
    assert.equal(jobs[0]?.model_tier, "standard");
  });

  it("maps model_tier premium alias to high-tier (strong) without warning noise", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner premium tier", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: premium tier",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };

    worker.createJobsFromPlan(planJob, [{
      title: "Premium tier task",
      task_spec: "Do the thing",
      job_type: "dev",
      model_tier: "premium",
      files_to_modify: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    assert.ok(!emitted.some(msg => msg.includes('normalized model_tier "premium"')));
    const jobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id);
    assert.equal(jobs[0]?.model_tier, "strong");
  });

  it("still warns when model_tier is invalid junk input", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner junk tier", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: junk tier",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };

    worker.createJobsFromPlan(planJob, [{
      title: "Junk tier task",
      task_spec: "Do the thing",
      job_type: "dev",
      model_tier: "trash-tier",
      files_to_modify: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    assert.ok(emitted.some(msg => msg.includes('normalized model_tier "trash-tier"')));
  });
});
