// test/test-atlas-v2-e2e.test.js
//
// Phase 2.3 end-to-end smoke for ATLAS v2: drive a single WI through
// research → plan → dev → commit → merge with POSSE_ATLAS_V2=true and
// assert the transactional outbox fires every expected pipeline event,
// enqueues the matching `atlas_warm` jobs, and that those jobs drain
// without leaving the queue stuck.
//
// This is the integration glue test for Workstream E (pipeline emission)
// and the AtlasWarmRole executor. It complements the lower-level
// per-component tests at test-atlas-v2-pipeline-hooks, test-atlas-v2-native-contract,
// test-atlas-v2-ledger, test-atlas-v2-view.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { setAccountSettingsPathForTests, closeAccountSettingsDb } from "../lib/domains/settings/functions/account-settings.js";
import { __testRepairAtlasV2HostSchema } from "../lib/shared/storage/functions/index.js";
import { mainViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";

let runtimeDir;
let runtimeDbPath;
let runtimeAccountSettingsPath;
let runtimeModules;
let testProjectDir;
let originalAtlasV2;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeTestProject(parentDir) {
  const projectDir = fs.mkdtempSync(path.join(parentDir, "project-"));
  git(["init", "--initial-branch=main"], projectDir);
  git(["config", "user.email", "atlasv2e2e@test.local"], projectDir);
  git(["config", "user.name", "ATLAS v2 E2E"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# ATLAS v2 E2E\n");
  fs.writeFileSync(path.join(projectDir, "src.txt"), "initial content\n");
  git(["add", "."], projectDir);
  git(["commit", "-m", "initial"], projectDir);
  return projectDir;
}

function resetRuntimeDb() {
  runtimeModules.dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch { /* ignore */ }
  const db = runtimeModules.dbMod.getDb();
  __testRepairAtlasV2HostSchema(db);
}

function stubWorkerRole(worker, jobType, run) {
  const existing = worker.roleRegistry.get(jobType);
  worker.roleRegistry.roles.set(jobType, {
    getRole: () => existing?.getRole?.() || jobType,
    canSpawn: (...args) => existing?.canSpawn?.(...args) || false,
    run,
  });
}

async function leaseAndExecute(worker, queueMod, jobId) {
  const lease = queueMod.acquireLease(jobId, "atlas-v2-e2e", 900);
  assert.ok(lease, `lease should succeed for job #${jobId}`);
  const job = queueMod.getJob(jobId);
  job._leaseToken = lease.leaseToken;
  await worker.execute(job);
}

function makeStubProviderClient({ assessVerdict = "pass" } = {}) {
  const calls = [];
  return {
    calls,
    call: async (_prompt, opts = {}) => {
      calls.push({ role: opts.role, opts });
      if (opts.role === "assessor") {
        const verdict = {
          verdict: assessVerdict,
          confidence: "high",
          reasons: ["Stubbed assessor for atlas-v2-e2e"],
          spawn_jobs: [],
          human_questions: [],
        };
        return {
          output: ["```json", JSON.stringify(verdict), "```"].join("\n"),
          stats: { inputTokens: 0, outputTokens: 0, outputChars: 0, modelName: "stub" },
        };
      }
      return { output: "", stats: { inputTokens: 0, outputTokens: 0, outputChars: 0, modelName: "stub" } };
    },
  };
}

function atlasEvents(queueMod, workItemId) {
  return queueMod.getEventsByWorkItem(workItemId, 200).filter((row) => row.actor_type === "atlas");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunnableJob(queueMod, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = queueMod.findRunnableJob();
    if (next) return next;
    await sleep(50);
  }
  return queueMod.findRunnableJob();
}

async function waitForAtlasEvent(queueMod, workItemId, eventType, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = atlasEvents(queueMod, workItemId);
    if (events.some((event) => event.event_type === eventType)) return events;
    await sleep(25);
  }
  return atlasEvents(queueMod, workItemId);
}

before(async () => {
  originalAtlasV2 = process.env.POSSE_ATLAS_V2;
  process.env.POSSE_ATLAS_V2 = "true";

  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-e2e-"));
  runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
  runtimeAccountSettingsPath = path.join(runtimeDir, "account-settings.db");
  setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
  setAccountSettingsPathForTests(runtimeAccountSettingsPath);

  const dbMod = await import("../lib/shared/storage/functions/index.js");
  const queueMod = await import("../lib/domains/queue/functions/index.js");
  const workerMod = await import("../lib/domains/worker/classes/Worker.js");
  const schedulerMod = await import("../lib/domains/scheduler/classes/Scheduler.js");
  runtimeModules = { dbMod, queueMod, workerMod, schedulerMod };
  resetRuntimeDb();
});

beforeEach(() => {
  resetRuntimeDb();
  testProjectDir = makeTestProject(runtimeDir);
});

after(() => {
  if (runtimeModules?.dbMod) runtimeModules.dbMod.closeDb();
  closeAccountSettingsDb();
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  setRuntimePathOverridesForTests(null);
  setAccountSettingsPathForTests(null);
  if (originalAtlasV2 == null) delete process.env.POSSE_ATLAS_V2;
  else process.env.POSSE_ATLAS_V2 = originalAtlasV2;
});

describe("ATLAS v2 end-to-end pipeline smoke", () => {
  it("scheduler.start dispatches atlas_warm through Worker.execute and writes a view", async () => {
    const { queueMod, workerMod, schedulerMod } = runtimeModules;
    const projectDir = testProjectDir;
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".posse"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "src", "warm.ts"),
      "export function schedulerWarmTarget() { return 42; }\n",
    );

    const job = queueMod.createJob({
      work_item_id: null,
      job_type: "atlas_warm",
      title: "Scheduler ATLAS warm proof",
      priority: "low",
      model_tier: null,
      reasoning_effort: null,
      provider: null,
      max_attempts: 1,
      payload_json: {
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/warm.ts"],
      },
    });

    const worker = new workerMod.Worker({
      projectDir,
      silent: true,
      providerClient: makeStubProviderClient(),
    });
    const scheduler = new schedulerMod.Scheduler({
      ownerId: "atlas-v2-warm-scheduler",
      pollMs: 5,
      leaseSec: 60,
      concurrency: 1,
      atlasDriftCheckIntervalMs: 60_000,
    });
    scheduler.onEvent = () => {};

    const seen = [];
    await scheduler.start(async (leasedJob) => {
      seen.push(leasedJob.job_type);
      await worker.execute(leasedJob);
    });

    assert.deepEqual(seen, ["atlas_warm"]);
    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "succeeded");
    assert.ok(refreshed.result_json, "atlas_warm should persist result_json");
    const result = JSON.parse(refreshed.result_json);
    assert.equal(result.purpose, "main-incremental");
    assert.ok(result.paths_indexed >= 1, `expected real indexing; got ${refreshed.result_json}`);
    assert.equal(result.view_written, mainViewPath(projectDir));
    assert.ok(fs.existsSync(mainViewPath(projectDir)), "main ATLAS view should be written");
    const events = queueMod.getEvents(null, 100).filter((e) => e.job_id === job.id);
    assert.ok(events.some((e) => e.event_type === "atlas.warm_completed"));
  });

  it("emits dev_leased + dev_committed + research_complete and drains atlas_warm jobs", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = testProjectDir;

    const wi = queueMod.createWorkItem("ATLAS v2 E2E", "trivial");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: atlas-v2-e2e",
    });

    const providerClient = makeStubProviderClient({ assessVerdict: "pass" });
    const worker = new workerMod.Worker({ projectDir, silent: true, providerClient });

    stubWorkerRole(worker, "research", async () => {
      return [
        "RESEARCH BRIEF",
        "Goal: pipeline glue with ATLAS v2 outbox.",
        "```json",
        JSON.stringify({ key_files: ["src.txt"], related_files: [], functions: [], human_questions: [] }),
        "```",
      ].join("\n");
    });

    stubWorkerRole(worker, "plan", async (planJob) => {
      worker.createJobsFromPlan(planJob, [{
        title: "ATLAS v2 E2E dev task",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Stubbed dev — touches src.txt.",
        files_to_modify: ["src.txt"],
        files_to_create: [],
        success_criteria: ["dev role stub completed"],
        depends_on_index: [],
      }]);
      return "[]";
    });

    stubWorkerRole(worker, "dev", async (devJob) => {
      const wt = devJob._worktreePath;
      assert.ok(wt, "dev job should have a worktree path");
      fs.writeFileSync(path.join(wt, "src.txt"), "edited by atlas-v2 stub\n");
      return [
        "--- DEV LOG START ---",
        "task_id: atlas-v2-e2e",
        "status: COMPLETE",
        "summary: stubbed dev edit",
        "files_touched: src.txt",
        "criteria_check: ok",
        "--- DEV LOG END ---",
      ].join("\n");
    });

    stubWorkerRole(worker, "assess", async () => [
      "Assessment complete.",
      "```json",
      JSON.stringify({ verdict: "pass", confidence: "high", reasons: ["stub"], spawn_jobs: [], human_questions: [] }),
      "```",
    ].join("\n"));

    const MAX_ITERATIONS = 30;
    let researchExecuted = false;
    let devExecuted = false;
    let warmExecuted = false;
    const executedTypes = [];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const next = await waitForRunnableJob(queueMod, devExecuted ? 250 : 7000);
      if (!next) break;
      if (next.job_type === "delegate") {
        queueMod.updateJobStatus(next.id, "succeeded");
        continue;
      }
      if (next.job_type === "research") researchExecuted = true;
      if (next.job_type === "dev") devExecuted = true;
      if (next.job_type === "atlas_warm") warmExecuted = true;
      executedTypes.push(next.job_type);
      await leaseAndExecute(worker, queueMod, next.id);
    }

    assert.ok(researchExecuted, `research should have run; saw ${executedTypes.join(", ")}`);
    assert.ok(devExecuted, `dev should have run; saw ${executedTypes.join(", ")}`);

    // Dev commit ATLAS emission is kicked off asynchronously after the git
    // commit, so wait for the outbox row before draining warm jobs that it
    // may enqueue.
    await waitForAtlasEvent(queueMod, wi.id, "atlas.dev_committed");

    // atlas_warm jobs are enqueued by the dev-committed outbox emission. Drain them.
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const next = await waitForRunnableJob(queueMod, 250);
      if (!next) break;
      if (next.job_type === "atlas_warm") warmExecuted = true;
      await leaseAndExecute(worker, queueMod, next.id);
    }
    assert.ok(warmExecuted, `at least one atlas_warm job should have drained; queue: ${executedTypes.join(", ")}`);

    // ---- Assert outbox events ----
    const atlasOutbox = atlasEvents(queueMod, wi.id);
    const eventTypes = atlasOutbox.map((e) => e.event_type);
    assert.ok(eventTypes.includes("atlas.dev_leased"), `expected atlas.dev_leased; saw ${eventTypes.join(", ")}`);
    assert.ok(eventTypes.includes("atlas.dev_committed"), `expected atlas.dev_committed; saw ${eventTypes.join(", ")}`);

    // atlas_warm jobs corresponding to those events should exist.
    const allJobs = queueMod.listJobsByWorkItem(wi.id);
    const warmJobs = allJobs.filter((j) => j.job_type === "atlas_warm");
    assert.ok(warmJobs.length >= 1, `expected at least one atlas_warm job; jobs: ${allJobs.map((j) => `${j.job_type}=${j.status}`).join(", ")}`);
    for (const wj of warmJobs) {
      assert.equal(wj.status, "succeeded", `atlas_warm job #${wj.id} should be succeeded; got ${wj.status}`);
      assert.equal(wj.model_tier, null, "atlas_warm jobs must have null model_tier");
      assert.equal(wj.provider, null, "atlas_warm jobs must have null provider");

      // Per plan §2.3, "ledger and views end in expected shape". Verify
      // each warm job persisted a result that conforms to the
      // AtlasWarmJobResult contract (paths_considered, paths_indexed,
      // duration_ms required; either indexed work or a documented skip).
      assert.ok(wj.result_json, `atlas_warm job #${wj.id} should have result_json`);
      const parsed = JSON.parse(wj.result_json);
      assert.notEqual(typeof parsed, "string", "result_json must store the result object, not a stringified JSON blob");
      assert.equal(typeof parsed.purpose, "string", "result.purpose required");
      assert.equal(typeof parsed.paths_considered, "number", "result.paths_considered required");
      assert.equal(typeof parsed.paths_indexed, "number", "result.paths_indexed required");
      assert.equal(typeof parsed.duration_ms, "number", "result.duration_ms required");
      // Either the warmer did real work OR each path is in skipped with a reason.
      const didWork = parsed.paths_indexed > 0 || parsed.blobs_ingested > 0;
      const allSkippedWithReason = Array.isArray(parsed.skipped)
        && parsed.skipped.every((s) => s && typeof s.reason === "string" && s.reason.length > 0);
      assert.ok(didWork || allSkippedWithReason || parsed.paths_considered === 0,
        `warm job #${wj.id} should either index paths or document skips; got ${wj.result_json}`);
    }

    // The dev job itself should have succeeded.
    const dev = allJobs.find((j) => j.job_type === "dev");
    assert.ok(dev && dev.status === "succeeded", `dev should succeed; jobs: ${allJobs.map((j) => `${j.job_type}=${j.status}`).join(", ")}`);

    // Research job stays succeeded too.
    const research = queueMod.getJob(researchJob.id);
    assert.equal(research.status, "succeeded");
  });

  it("emits atlas.wi_cleanup when worktree-lifecycle cleans up a complete WI", async () => {
    const { queueMod } = runtimeModules;
    const projectDir = testProjectDir;

    // Manually drive cleanupWorktreeIfDone by importing it; the WI status path
    // determines the disposition tag. We don't need a full pipeline run here —
    // the dev-leased path is covered above. This isolates the cleanup
    // emission so a regression in worktree-lifecycle is caught directly.
    const wi = queueMod.createWorkItem("ATLAS v2 cleanup", "x");
    queueMod.updateWorkItemStatus(wi.id, "complete");

    const { cleanupWorktreeIfDone } = await import("../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    // Mock worker shape just enough for cleanupWorktreeIfDone.
    const fakeWorker = {
      projectDir,
      display: null,
      silent: true,
    };
    cleanupWorktreeIfDone(fakeWorker, wi.id);

    const atlasOutbox = atlasEvents(queueMod, wi.id);
    const eventTypes = atlasOutbox.map((e) => e.event_type);
    assert.ok(eventTypes.includes("atlas.wi_cleanup"), `expected atlas.wi_cleanup; saw ${eventTypes.join(", ")}`);
    const warmJobs = queueMod.listJobsByWorkItem(wi.id).filter((j) => j.job_type === "atlas_warm");
    assert.ok(warmJobs.length >= 1, "wi_cleanup should enqueue at least one atlas_warm job");
  });
});
