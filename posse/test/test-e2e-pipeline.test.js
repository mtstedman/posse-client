// test/test-e2e-pipeline.test.js
//
// End-to-end smoke test: drive a single trivial work item through
// research → plan → dev → assess using stubbed role bodies, exercising
// the worker's job dispatch, lease lifecycle, dependency chaining, and
// status transitions in one continuous flow.
//
// Per-phase unit tests exist; this is the integration glue test.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { setAccountSettingsPathForTests, closeAccountSettingsDb } from "../lib/domains/settings/functions/account-settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let runtimeDir;
let runtimeDbPath;
let runtimeAccountSettingsPath;
let runtimeModules;
let testProjectDir;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeTestProject(parentDir) {
  const projectDir = fs.mkdtempSync(path.join(parentDir, "project-"));
  git(["init", "--initial-branch=main"], projectDir);
  git(["config", "user.email", "e2e@test.local"], projectDir);
  git(["config", "user.name", "E2E Test"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# E2E test project\n");
  fs.writeFileSync(path.join(projectDir, "src.txt"), "initial content\n");
  git(["add", "."], projectDir);
  git(["commit", "-m", "initial"], projectDir);
  return projectDir;
}

function resetRuntimeDb() {
  runtimeModules.dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch { /* ignore */ }
  runtimeModules.dbMod.getDb();
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
  const lease = queueMod.acquireLease(jobId, "e2e-worker", 900);
  assert.ok(lease, `lease should succeed for job #${jobId}`);
  const job = queueMod.getJob(jobId);
  job._leaseToken = lease.leaseToken;
  await worker.execute(job);
}

before(async () => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-e2e-pipeline-"));
  runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
  runtimeAccountSettingsPath = path.join(runtimeDir, "account-settings.db");
  setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
  setAccountSettingsPathForTests(runtimeAccountSettingsPath);

  const dbMod = await import("../lib/shared/storage/functions/index.js");
  const queueMod = await import("../lib/domains/queue/functions/index.js");
  const workerMod = await import("../lib/domains/worker/classes/Worker.js");
  runtimeModules = { dbMod, queueMod, workerMod };
  resetRuntimeDb();
});

beforeEach(() => {
  resetRuntimeDb();
  // Fresh git repo per test so worktrees stay isolated.
  testProjectDir = makeTestProject(runtimeDir);
});

after(() => {
  if (runtimeModules?.dbMod) runtimeModules.dbMod.closeDb();
  closeAccountSettingsDb();
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  setRuntimePathOverridesForTests(null);
  setAccountSettingsPathForTests(null);
});

// Canned providerClient.call: dev/fix/research/plan are stubbed at the role
// level via stubWorkerRole. Inline assessment, however, calls
// providerClient.call directly (worker.js:1400), so we route any "assessor"
// role call here to a deterministic PASS verdict. Other roles get an empty
// success — they shouldn't be hitting the provider at all in this test.
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
          reasons: [`Stubbed assessor providerClient — ${assessVerdict}`],
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

describe("end-to-end pipeline (research → plan → dev → assess)", () => {
  it("drives a single WI through all four phases to complete", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = testProjectDir;

    const wi = queueMod.createWorkItem("E2E smoke: small refactor", "trivial repo edit");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: E2E smoke",
    });

    const providerClient = makeStubProviderClient({ assessVerdict: "pass" });
    const worker = new workerMod.Worker({ projectDir, silent: true, providerClient });

    // Roles: each stub returns the canned successful output the downstream
    // worker code expects to parse / persist for that job type.
    stubWorkerRole(worker, "research", async () => {
      return [
        "RESEARCH BRIEF",
        "==============",
        "Goal: trivial change to verify pipeline glue.",
        "",
        "```json",
        JSON.stringify({
          key_files: [],
          related_files: [],
          functions: [],
          human_questions: [],
        }),
        "```",
      ].join("\n");
    });

    let plannerCallCount = 0;
    stubWorkerRole(worker, "plan", async (planJob) => {
      plannerCallCount++;
      worker.createJobsFromPlan(planJob, [
        {
          title: "E2E smoke dev task",
          job_type: "dev",
          task_mode: "code",
          task_spec: "Stubbed dev — touches src.txt.",
          files_to_modify: ["src.txt"],
          files_to_create: [],
          success_criteria: ["dev role stub completed"],
          depends_on_index: [],
        },
      ]);
      return JSON.stringify([{
        title: "E2E smoke dev task",
        job_type: "dev",
        task_mode: "code",
      }]);
    });

    stubWorkerRole(worker, "dev", async (devJob) => {
      // Make a real file change in the worktree so the worker's no-op guard
      // is satisfied. The post-execution path will commit it.
      const wt = devJob._worktreePath;
      assert.ok(wt, "dev job should have a worktree path attached");
      fs.writeFileSync(path.join(wt, "src.txt"), "edited by stub\n");
      return [
        "--- DEV LOG START ---",
        "task_id: e2e-smoke",
        "status: COMPLETE",
        "summary: stubbed dev edit acknowledged",
        "files_touched: src.txt",
        "criteria_check: ok",
        "--- DEV LOG END ---",
      ].join("\n");
    });

    stubWorkerRole(worker, "assess", async () => {
      return [
        "Assessment complete.",
        "```json",
        JSON.stringify({
          verdict: "pass",
          confidence: "high",
          reasons: ["Stubbed assessor — pipeline smoke test"],
          spawn_jobs: [],
          human_questions: [],
        }),
        "```",
      ].join("\n");
    });

    // Drive the runnable queue. Cap iterations to avoid runaway loops if a
    // future regression introduces a cycle.
    const MAX_ITERATIONS = 20;
    const jobsExecuted = [];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const next = queueMod.findRunnableJob();
      if (!next) break;
      // Skip non-stubbed job types (delegate, etc.) by short-circuiting them
      // — multi-provider isn't configured so delegate shouldn't appear, but
      // guard defensively.
      if (next.job_type === "delegate") {
        queueMod.updateJobStatus(next.id, "succeeded");
        continue;
      }
      jobsExecuted.push({ id: next.id, type: next.job_type });
      await leaseAndExecute(worker, queueMod, next.id);
    }

    // Verify the chain ran every phase.
    const types = jobsExecuted.map((j) => j.type);
    const allJobsSnap = queueMod.listJobsByWorkItem(wi.id);
    const snap = allJobsSnap.map((j) => `#${j.id}(${j.job_type}=${j.status})`).join(", ");
    assert.ok(types.includes("research"), `research phase ran (saw: ${types.join(", ")}) jobs: ${snap}`);
    assert.ok(types.includes("plan"), `plan phase ran (saw: ${types.join(", ")}) jobs: ${snap}`);
    assert.ok(types.includes("dev"), `dev phase ran (saw: ${types.join(", ")}) jobs: ${snap}`);
    assert.equal(plannerCallCount, 1);

    // Final job statuses: every job should be terminal-success or assessing-passed.
    const allJobs = queueMod.listJobsByWorkItem(wi.id);
    assert.ok(allJobs.length >= 3, `expected at least research+plan+dev, got ${allJobs.length}`);
    const failed = allJobs.filter((j) =>
      j.status === "failed" || j.status === "dead_letter" || j.status === "canceled"
    );
    assert.equal(failed.length, 0,
      `no jobs should fail; got: ${failed.map((j) => `#${j.id}(${j.job_type}=${j.status})`).join(", ")}`,
    );

    // Research, plan, and dev should be terminal-success.
    const research = allJobs.find((j) => j.id === researchJob.id);
    assert.equal(research.status, "succeeded");
    const plan = allJobs.find((j) => j.job_type === "plan");
    assert.equal(plan.status, "succeeded");
    const dev = allJobs.find((j) => j.job_type === "dev");
    assert.ok(dev, "dev job should have been spawned by the planner");
    assert.equal(dev.status, "succeeded", `dev should be succeeded; jobs: ${snap}`);

    // Assessor was invoked via providerClient.call (inline assessment path).
    const assessorCalls = providerClient.calls.filter((c) => c.role === "assessor");
    assert.ok(assessorCalls.length >= 1, "inline assessor providerClient.call should fire");

    // Attempts: every executed job recorded at least one attempt row.
    for (const { id } of jobsExecuted) {
      const attempts = queueMod.getAttempts(id);
      assert.ok(attempts.length >= 1, `job #${id} should have at least one attempt`);
      assert.equal(attempts.at(-1).status, "succeeded",
        `job #${id} last attempt should be succeeded; got ${attempts.at(-1).status}`);
    }
  });

  it("propagates assessor fail through the chain", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = testProjectDir;

    const wi = queueMod.createWorkItem("E2E fail: dev rejected by assessor", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research",
    });

    const providerClient = makeStubProviderClient({ assessVerdict: "fail" });
    const worker = new workerMod.Worker({ projectDir, silent: true, providerClient });

    stubWorkerRole(worker, "research", async () => "brief\n```json\n{}\n```\n");
    stubWorkerRole(worker, "plan", async (planJob) => {
      worker.createJobsFromPlan(planJob, [{
        title: "Failing dev task",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Will be rejected.",
        files_to_modify: ["src.txt"],
        files_to_create: [],
        success_criteria: ["never met"],
        depends_on_index: [],
      }]);
      return "[]";
    });
    stubWorkerRole(worker, "dev", async (devJob) => {
      const wt = devJob._worktreePath;
      if (wt) fs.writeFileSync(path.join(wt, "src.txt"), "stubbed dev edit\n");
      return [
        "--- DEV LOG START ---",
        "status: PARTIAL",
        "summary: incomplete",
        "--- DEV LOG END ---",
      ].join("\n");
    });

    stubWorkerRole(worker, "fix", async () => [
      "--- DEV LOG START ---",
      "status: PARTIAL",
      "summary: fix attempt also fell short",
      "--- DEV LOG END ---",
    ].join("\n"));

    const MAX_ITERATIONS = 30;
    let researchRan = false;
    let devRan = false;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const next = queueMod.findRunnableJob();
      if (!next) break;
      if (next.job_type === "delegate") {
        queueMod.updateJobStatus(next.id, "succeeded");
        continue;
      }
      if (next.job_type === "research") researchRan = true;
      if (next.job_type === "dev") devRan = true;
      await leaseAndExecute(worker, queueMod, next.id);
    }

    assert.ok(researchRan, "research phase should run");
    assert.ok(devRan, "dev phase should run");
    // Inline assessment fires from providerClient.call(role: "assessor").
    const assessorInvocations = providerClient.calls.filter((c) => c.role === "assessor");
    assert.ok(assessorInvocations.length >= 1,
      `assessor should have been invoked at least once; got ${providerClient.calls.length} provider calls (roles: ${providerClient.calls.map((c) => c.role).join(", ")})`,
    );

    // The research job itself should still be succeeded — the failure is downstream.
    const research = queueMod.getJob(researchJob.id);
    assert.equal(research.status, "succeeded");
  });
});
