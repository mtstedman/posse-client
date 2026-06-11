import {
  describe,
  it,
  after,
} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";
import { Worker, leaseRenewalIntervalMs, renewJobLeaseOrAbort } from "../lib/domains/worker/classes/Worker.js";
import { handleExecuteAttemptError } from "../lib/domains/worker/functions/helpers/attempt-errors.js";
import { spawnDeadLetterRecoveryForDependents } from "../lib/domains/worker/functions/helpers/dead-letter.js";
import { finishNoWriteAttempt } from "../lib/domains/worker/functions/helpers/no-write-retry.js";
import { getDb } from "../lib/shared/storage/functions/index.js";
import { worktreePath } from "../lib/domains/git/functions/worktree.js";
import {
  acquireLease,
  addDependency,
  createJob,
  createWorkItem,
  getAttempts,
  getDependencies,
  getEvents,
  getEventsByWorkItem,
  getJob,
  incrementAndCreateAttempt,
  listJobsByWorkItem,
  logEvent,
  releaseLease,
  requeueExpiredLeases,
  updateJobStatus,
  completeAttempt,
  setAttemptCommitHash,
  setSetting,
  storeArtifact,
} from "../lib/domains/queue/functions/index.js";

function initGitRepo(projectDir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "example.js"), "export const value = 1;\n", "utf-8");
  execFileSync("git", ["add", "src/example.js"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
}

describe("Worker lease + retry recovery", () => {
  it("renews short leases before their expiration boundary", () => {
    assert.equal(leaseRenewalIntervalMs(1), 500);
    assert.equal(leaseRenewalIntervalMs(5), 2500);
    assert.ok(leaseRenewalIntervalMs(6) < 6000);
    assert.equal(leaseRenewalIntervalMs(900), 300000);
  });

  it("catches lease-renewal exceptions and aborts the job without throwing out of the timer", () => {
    const emitted = [];
    let cleared = false;
    let killed = null;
    const result = renewJobLeaseOrAbort({
      worker: {
        emit: (_jobId, message) => emitted.push(message),
        killJob: (_jobId, reason) => { killed = reason; },
      },
      job: { id: 7, work_item_id: 3 },
      leaseToken: "lease-token",
      leaseSec: 60,
      renewLeaseFn: () => {
        throw new Error("database is closed");
      },
      clearRenewal: () => { cleared = true; },
    });

    assert.equal(result, "error");
    assert.equal(cleared, true);
    assert.equal(killed, "lease_renew_failed");
    assert.match(emitted.join("\n"), /database is closed/);
  });

  it("tolerates transient SQLITE_BUSY lease-renewal errors before aborting", () => {
    const emitted = [];
    let cleared = false;
    let killed = null;
    const state = { transientErrors: 0 };
    const busy = Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
    const worker = {
      emit: (_jobId, message) => emitted.push(message),
      killJob: (_jobId, reason) => { killed = reason; },
    };

    const retrying = renewJobLeaseOrAbort({
      worker,
      job: { id: 8, work_item_id: 3 },
      leaseToken: "lease-token",
      leaseSec: 60,
      renewLeaseFn: () => { throw busy; },
      clearRenewal: () => { cleared = true; },
      state,
    });
    const renewed = renewJobLeaseOrAbort({
      worker,
      job: { id: 8, work_item_id: 3 },
      leaseToken: "lease-token",
      leaseSec: 60,
      renewLeaseFn: () => true,
      clearRenewal: () => { cleared = true; },
      state,
    });

    assert.equal(retrying, "retrying");
    assert.equal(renewed, "renewed");
    assert.equal(state.transientErrors, 0);
    assert.equal(cleared, false);
    assert.equal(killed, null);
    assert.match(emitted.join("\n"), /transient renewal error/);
  });

  it("reads the transient lease-renewal error budget from settings", () => withTempRuntimeDb(() => {
    setSetting("worker_lease_renew_max_transient_errors", "1");
    const emitted = [];
    let cleared = false;
    let killed = null;
    const state = { transientErrors: 0 };
    const busy = Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
    const worker = {
      emit: (_jobId, message) => emitted.push(message),
      killJob: (_jobId, reason) => { killed = reason; },
    };
    const base = {
      worker,
      job: { id: 18, work_item_id: 3 },
      leaseToken: "lease-token",
      leaseSec: 60,
      renewLeaseFn: () => { throw busy; },
      clearRenewal: () => { cleared = true; },
      state,
    };

    assert.equal(renewJobLeaseOrAbort(base), "retrying");
    assert.equal(renewJobLeaseOrAbort(base), "error");
    assert.equal(cleared, true);
    assert.equal(killed, "lease_renew_failed");
    assert.match(emitted.join("\n"), /transient renewal error \(1\/1\)/);
  }));

  it("reads the provider circuit TTL from settings", () => withTempRuntimeDb(() => {
    setSetting("worker_provider_circuit_ttl_ms", "1234");
    const worker = new Worker({ projectDir: process.cwd(), silent: true });
    worker._openProviderCircuit("codex", "test trip");
    assert.equal(worker._providerCircuitOpen.get("codex").ttlMs, 1234);
  }));

  it("clears expired lease tokens retained by parked jobs without unparking them", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("parked lease token sweep", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Parked with retained token",
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    // Simulate a crash between processVerdict() parking the job and the
    // worker's immediate lease release: parked status, token still set.
    updateJobStatus(job.id, "waiting_on_review", { leaseToken: lease.leaseToken });
    getDb().prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), job.id);

    requeueExpiredLeases();

    const refreshed = getJob(job.id);
    assert.equal(refreshed.status, "waiting_on_review");
    assert.equal(refreshed.lease_token, null);
    assert.equal(refreshed.lease_owner, null);
    assert.equal(refreshed.lease_expires_at, null);
  }));

  it("leaves unexpired parked lease tokens alone", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("parked lease token fresh", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Parked inside the release window",
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    updateJobStatus(job.id, "waiting_on_review", { leaseToken: lease.leaseToken });

    requeueExpiredLeases();

    const refreshed = getJob(job.id);
    assert.equal(refreshed.status, "waiting_on_review");
    assert.equal(refreshed.lease_token, lease.leaseToken);
  }));

  it("keeps assess-only payload flags when the assessor attempt cannot claim a stale lease", async () => withTempRuntimeDb(async (projectDir) => {
    const wi = createWorkItem("assess-only stale lease", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Assess-only artifact job",
      payload_json: JSON.stringify({
        task_mode: "content",
        _assess_only: 1,
        _assess_model_tier: "standard",
      }),
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const previousAttempt = incrementAndCreateAttempt(job.id, lease.leaseToken, "artificer", null, "medium");
    setAttemptCommitHash(previousAttempt.attempt.id, "abcdef1234567890");
    storeArtifact({
      work_item_id: wi.id,
      job_id: job.id,
      artifact_type: "response",
      content_long: "previous artifact output",
    });

    const leasedJob = getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;
    getDb().prepare(`UPDATE jobs SET lease_token = ? WHERE id = ?`).run("stolen-token", job.id);

    const worker = new Worker({ projectDir, silent: true });
    await worker.execute(leasedJob);

    const payload = JSON.parse(getJob(job.id).payload_json);
    assert.equal(payload._assess_only, 1);
    assert.equal(payload._assess_model_tier, "standard");
  }));

  it("retries repeated turn-budget exhaustion with adaptive tuning instead of dead-lettering early", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("turn budget retry", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Turn budget retry tuning",
      model_tier: "cheap",
      max_attempts: 3,
      payload_json: JSON.stringify({
        task_spec: "Implement scoped changes",
        files_to_modify: ["src/example.js"],
      }),
    });

    const lease = acquireLease(job.id, "test-worker", 900);
    const attempt1 = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    completeAttempt(attempt1.attempt.id, {
      status: "failed",
      duration_ms: 700,
      error_text: "claude exhausted turn budget (23/22)",
    });
    const attempt2 = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    completeAttempt(attempt2.attempt.id, {
      status: "failed",
      duration_ms: 850,
      error_text: "claude exhausted turn budget (23/22)",
    });

    const worker = new Worker({ projectDir, silent: true });
    worker.emit = () => {};
    worker._retryOrFail(getJob(job.id), lease.leaseToken, "claude exhausted turn budget (23/22)");

    const refreshed = getJob(job.id);
    const payload = JSON.parse(refreshed.payload_json || "{}");
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.model_tier, "standard");
    assert.equal(refreshed.reasoning_effort, "medium");
    assert.equal(payload.deepthink, true);
    assert.equal(payload.deepthink_budget, "high");
    assert.equal(payload._turn_budget_retry_count, 1);
    assert.ok(getEvents(job.id, 25).some((evt) => evt.event_type === "job.turn_budget_retry_tuned"));
  }));

  it("does not repeatedly morph turn-budget retries after the first budget bump", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("turn budget retry once", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Turn budget retry already tuned",
      model_tier: "standard",
      reasoning_effort: "medium",
      max_attempts: 3,
      payload_json: JSON.stringify({
        task_spec: "Implement scoped changes",
        files_to_modify: ["src/example.js"],
        deepthink: true,
        deepthink_budget: "high",
        _turn_budget_retry_count: 1,
      }),
    });

    const lease = acquireLease(job.id, "test-worker", 900);
    const attempt = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: 700,
      error_text: "claude exhausted turn budget (25/24)",
    });

    const worker = new Worker({ projectDir, silent: true });
    worker.emit = () => {};
    worker._retryOrFail(getJob(job.id), lease.leaseToken, "claude exhausted turn budget (25/24)");

    const refreshed = getJob(job.id);
    const payload = JSON.parse(refreshed.payload_json || "{}");
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.model_tier, "standard");
    assert.equal(refreshed.reasoning_effort, "medium");
    assert.equal(payload.deepthink, true);
    assert.equal(payload.deepthink_budget, "high");
    assert.equal(payload._turn_budget_retry_count, 1);
    assert.equal(getEvents(job.id, 25).some((evt) => evt.event_type === "job.turn_budget_retry_tuned"), false);
    assert.equal(getEvents(job.id, 25).some((evt) => evt.event_type === "job.turn_budget_retry_cap_reached"), true);
  }));

  it("requeues early no-write attempts without assessment or hard-failed attempt status", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("early no write retry", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "No writes yet",
      max_attempts: 3,
      payload_json: JSON.stringify({
        task_spec: "Implement scoped changes",
        files_to_modify: ["src/example.js"],
      }),
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const { attempt } = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    const worker = {
      emit: () => {},
      _releaseLease: (currentJob, token, status, opts) => releaseLease(currentJob.id, token, status, opts),
      _retryOrFail: () => { throw new Error("early no-write retry must not route through retryOrFail"); },
    };

    finishNoWriteAttempt(worker, {
      attempt,
      attemptCount: 1,
      job: getJob(job.id),
      leaseToken: lease.leaseToken,
      message: "Dev produced no file changes - nothing to assess",
      startTime: Date.now() - 10,
    });

    assert.equal(getJob(job.id).status, "queued");
    assert.equal(getAttempts(job.id).at(-1).status, "interrupted");
    assert.ok(getEvents(job.id, 10).some((evt) => evt.event_type === "job.noop_retry"));
    assert.equal(getEvents(job.id, 10).some((evt) => evt.event_type === "job.noop_failure"), false);
  }));

  it("records early tool-budget exhaustion as interrupted while preserving retry tuning", () => withTempRuntimeDb(async (projectDir) => {
    const wi = createWorkItem("early tool budget", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Tool budget retry",
      max_attempts: 3,
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const { attempt } = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    let retried = false;
    const worker = {
      projectDir,
      emit: () => {},
      _retryOrFail: () => { retried = true; },
    };

    await handleExecuteAttemptError(worker, {
      attempt,
      attemptCount: 1,
      err: new Error("tool calls exhausted before final answer"),
      job: getJob(job.id),
      leaseToken: lease.leaseToken,
      startTime: Date.now() - 10,
      wtPath: null,
    }, {
      isProviderError: () => false,
    });

    assert.equal(retried, true);
    assert.equal(getAttempts(job.id).at(-1).status, "interrupted");
    assert.ok(getEvents(job.id, 10).some((evt) => evt.message.includes("hit tool budget")));
  }));

  it("rewires dependents through recovery for identical-output dead letters", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("identical output recovery", "regression");
    const original = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Repeat same output",
    });
    const dependent = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Downstream task",
    });
    addDependency(dependent.id, original.id, "hard");
    const emitted = [];
    const worker = {
      emit: (_jobId, message) => emitted.push(message),
    };

    const result = spawnDeadLetterRecoveryForDependents(worker, original, { ...original, attempt_count: 2 }, {
      reasonText: "produced identical output on retry and could not escalate to a different model, so it was dead-lettered",
    });

    assert.equal(result.spawned, true);
    assert.equal(result.dependents.length, 1);
    const recovery = getJob(result.recoveryJob.id);
    assert.equal(recovery.job_type, "human_input");
    assert.equal(recovery.parent_job_id, original.id);
    const payload = JSON.parse(recovery.payload_json);
    assert.equal(payload.original_job_id, original.id);
    assert.equal(payload.review_type, "dead_letter_recovery");
    assert.match(payload.questions[0], /identical output/);
    assert.deepEqual(getDependencies(dependent.id).map((dep) => dep.depends_on_job_id), [recovery.id]);
    assert.ok(emitted.some((message) => message.includes("spawned human_input")));
  }));

  it("does not throw when retry handling races with external job deletion", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("deleted retry", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Deleted before retry",
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    const leasedJob = getJob(job.id);
    getDb().prepare("DELETE FROM jobs WHERE id = ?").run(job.id);

    const worker = new Worker({ projectDir, silent: true });
    const emitted = [];
    worker.emit = (_jobId, message) => emitted.push(message);

    assert.doesNotThrow(() => worker._retryOrFail(leasedJob, lease.leaseToken, "provider exploded"));
    assert.ok(emitted.some((message) => message.includes("disappeared before retry")));
  }));

  it("orders same-batch event snapshots by id after timestamp", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("event order", "regression");
    logEvent({
      work_item_id: wi.id,
      event_type: "job.note",
      actor_type: "system",
      message: "first",
    });
    logEvent({
      work_item_id: wi.id,
      event_type: "job.note",
      actor_type: "system",
      message: "second",
    });

    const events = getEventsByWorkItem(wi.id, 2);
    assert.deepEqual(events.map((event) => event.message), ["second", "first"]);
  }));

  it("parks final turn-budget failures with scoped dirty work for partial-work review", async () => withTempRuntimeDb(async (projectDir) => {
    initGitRepo(projectDir);
    const wi = createWorkItem("partial dirty final", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Leave partial work",
      max_attempts: 1,
      payload_json: JSON.stringify({
        task_spec: "Update example",
        files_to_modify: ["src/example.js"],
      }),
    });
    const lease = acquireLease(job.id, "test-worker", 900);
    updateJobStatus(job.id, "running", { leaseToken: lease.leaseToken });
    const attempt = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    fs.writeFileSync(path.join(projectDir, "src", "example.js"), "export const value = 2;\n", "utf-8");

    const worker = new Worker({ projectDir, silent: true });
    worker.emit = () => {};
    const handled = await worker._handlePartialWorkFailure({
      attempt: attempt.attempt,
      attemptCount: 1,
      err: new Error("claude exhausted turn budget (23/22)"),
      job: getJob(job.id),
      leaseToken: lease.leaseToken,
      output: "",
      startTime: Date.now(),
      wtPath: projectDir,
    });

    assert.equal(handled, true);
    assert.equal(getJob(job.id).status, "waiting_on_human");
    const recovery = listJobsByWorkItem(wi.id).find((row) => row.job_type === "human_input");
    assert.ok(recovery, "expected partial-work recovery prompt");
    assert.equal(JSON.parse(recovery.payload_json).review_type, "partial_work_recovery");
    assert.match(execFileSync("git", ["stash", "list"], { cwd: projectDir, encoding: "utf-8" }), /partial work turn extension job #/);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", "src/example.js"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");
    assert.equal(JSON.parse(getJob(job.id).payload_json)._stall_resume, true);
  }));

  it("turns partial-work extend answers into resumed jobs with a larger turn budget", async () => withTempRuntimeDb(async (projectDir) => {
    initGitRepo(projectDir);
    const wi = createWorkItem("partial extend", "regression");
    const original = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Resume partial work",
      max_attempts: 1,
      payload_json: JSON.stringify({
        task_spec: "Update example",
        files_to_modify: ["src/example.js"],
        _stall_resume: true,
      }),
    });
    getDb().prepare("UPDATE jobs SET status = 'waiting_on_human', attempt_count = 1 WHERE id = ?").run(original.id);
    const recovery = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Partial work: Resume partial work",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "partial_work_recovery",
        suggested_max_turns: 88,
        questions: ["Extend, commit, or revert?"],
      }),
    });
    const lease = acquireLease(recovery.id, "test-worker", 900);
    const leasedRecovery = getJob(recovery.id);
    leasedRecovery._leaseToken = lease.leaseToken;

    const worker = new Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Extend, commit, or revert?", answer: "extend the turn count and resume" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });
    await worker.execute(leasedRecovery);

    const refreshed = getJob(original.id);
    const payload = JSON.parse(refreshed.payload_json || "{}");
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.max_attempts, 2);
    assert.equal(refreshed.model_tier, "strong");
    assert.equal(payload._max_turns_override, 88);
    assert.equal(payload._partial_work_turn_extension_count, 1);
  }));

  it("commits partial-work recovery answers without re-saving the stall-resume flag", async () => withTempRuntimeDb(async (projectDir) => {
    initGitRepo(projectDir);
    const wi = createWorkItem("partial commit", "regression");
    const wtPath = worktreePath(projectDir, wi.id);
    execFileSync("git", ["worktree", "add", "-b", `wi-${wi.id}`, wtPath, "main"], { cwd: projectDir, stdio: "ignore" });

    const original = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Commit partial work",
      max_attempts: 1,
      payload_json: JSON.stringify({
        task_spec: "Update example",
        files_to_modify: ["src/example.js"],
        _stall_resume: true,
      }),
    });
    getDb().prepare("UPDATE jobs SET status = 'waiting_on_human', attempt_count = 1 WHERE id = ?").run(original.id);

    fs.writeFileSync(path.join(wtPath, "src", "example.js"), "export const value = 3;\n", "utf-8");
    execFileSync("git", [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      `posse: partial work turn extension job #${original.id}`,
      "--",
      "src/example.js",
    ], { cwd: wtPath, stdio: "ignore" });

    const recovery = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Partial work: Commit partial work",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "partial_work_recovery",
        suggested_max_turns: 88,
        questions: ["Extend, commit, or revert?"],
      }),
    });
    const lease = acquireLease(recovery.id, "test-worker", 900);
    const leasedRecovery = getJob(recovery.id);
    leasedRecovery._leaseToken = lease.leaseToken;

    const worker = new Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Extend, commit, or revert?", answer: "commit it and assess" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });
    await worker.execute(leasedRecovery);

    const refreshed = getJob(original.id);
    const payload = JSON.parse(refreshed.payload_json || "{}");
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.max_attempts, 2);
    assert.equal(payload._assess_only, true);
    assert.equal(payload._stall_resume, undefined);
    assert.match(payload._partial_work_recovery.commit_hash, /^[0-9a-f]{40}$/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wtPath, encoding: "utf-8" }).trim(), "");
    assert.equal(execFileSync("git", ["stash", "list"], { cwd: wtPath, encoding: "utf-8" }).includes(`job #${original.id}`), false);
    assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: wtPath, encoding: "utf-8" }), /posse: partial dev job/);
  }));

  it("spawns actionable stall-exhausted recovery prompts with an original job id", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("stall recovery prompt", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Stalling dev job",
      max_attempts: 1,
      payload_json: JSON.stringify({ task_spec: "Do the work" }),
    });

    const lease = acquireLease(job.id, "test-worker", 900);
    const attempt = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: 45_000,
      error_text: "stall timeout killed provider process",
    });

    const worker = new Worker({ projectDir, silent: true });
    worker.emit = () => {};
    worker._retryOrFail(getJob(job.id), lease.leaseToken, "stall timeout killed provider process", { stallExhausted: true });

    const recovery = listJobsByWorkItem(wi.id).find((row) => row.job_type === "human_input");
    assert.ok(recovery, "expected a stall recovery human_input job");
    const payload = JSON.parse(recovery.payload_json || "{}");
    assert.equal(payload.original_job_id, job.id);
    assert.equal(payload.review_type, "stall_exhausted_recovery");
  }));

  it("turns stall recovery retry answers into counted replacement jobs", async () => withTempRuntimeDb(async (projectDir) => {
    const wi = createWorkItem("stall recovery retry", "regression");
    const original = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Stalling dev job",
      status: "dead_letter",
      payload_json: JSON.stringify({ task_spec: "Do the work" }),
    });
    const recovery = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Stall recovery: Stalling dev job",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "stall_exhausted_recovery",
        questions: ["Retry?"],
      }),
    });

    const lease = acquireLease(recovery.id, "test-worker", 900);
    const leasedRecovery = getJob(recovery.id);
    leasedRecovery._leaseToken = lease.leaseToken;

    const worker = new Worker({
      projectDir,
      silent: true,
      display: {
        askQuestions: async () => [{ question: "Retry?", answer: "retry with a larger stall timeout" }],
        workerLine: () => {},
        addEvent: () => {},
        render: () => {},
      },
    });
    await worker.execute(leasedRecovery);

    const retry = listJobsByWorkItem(wi.id)
      .find((row) => row.parent_job_id === original.id && row.title === "Retry: Stalling dev job");
    assert.ok(retry, "expected a replacement retry job");
    const payload = JSON.parse(retry.payload_json || "{}");
    assert.equal(payload._dead_letter_recovery.recovery_type, "stall_exhausted_recovery");
    assert.equal(payload._dead_letter_recovery.stall_recovery_count, 1);
  }));

  it("caps cascading stall-exhausted recovery prompts after the guided retry", () => withTempRuntimeDb((projectDir) => {
    const wi = createWorkItem("stall recovery cap", "regression");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Retry: Stalling dev job",
      max_attempts: 1,
      payload_json: JSON.stringify({
        task_spec: "Do the work",
        _dead_letter_recovery: {
          original_job_id: 123,
          recovery_type: "stall_exhausted_recovery",
          stall_recovery_count: 1,
        },
      }),
    });

    const lease = acquireLease(job.id, "test-worker", 900);
    const attempt = incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", null, "medium");
    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: 45_000,
      error_text: "stall timeout killed provider process",
    });

    const worker = new Worker({ projectDir, silent: true });
    worker.emit = () => {};
    worker._retryOrFail(getJob(job.id), lease.leaseToken, "stall timeout killed provider process", { stallExhausted: true });

    const recoveryJobs = listJobsByWorkItem(wi.id).filter((row) => row.job_type === "human_input");
    assert.equal(recoveryJobs.length, 0);
    assert.ok(getEvents(job.id, 25).some((evt) => evt.event_type === "job.stall_recovery_cap_reached"));
  }));
});
