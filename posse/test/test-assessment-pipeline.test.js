import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let runtimeDbDir;
let runtimeDbPath;
let runtimeAccountSettingsPath;
let originalEnv;
let runtimeModules;

function resetRuntimeDb() {
  runtimeModules.dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch { /* ignore */ }
  runtimeModules.dbMod.getDb();
}

function makeWorker(queueMod) {
  return {
    autoApprove: false,
    display: null,
    dryRun: false,
    projectDir: path.resolve(__dirname, ".."),
    silent: true,
    _abortControllers: new Map(),
    _cleanupWorktreeIfDone: () => {},
    emit: () => {},
    parsePayload: () => ({}),
    _releaseLease: (job, leaseToken, finalStatus, opts = {}) => queueMod.releaseLease(job.id, leaseToken, finalStatus, opts),
    _retryOrFail: () => {},
    _shouldSkipAssessment: () => false,
    _spawnFileRequestFollowUp: () => {},
    _spawnPlanAfterResearch: () => {},
    providerClient: {
      call: async () => ({ output: "" }),
    },
  };
}

function makeGitRepo(prefix) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
  fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
  return projectDir;
}

before(async () => {
  runtimeDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-db-"));
  runtimeDbPath = path.join(runtimeDbDir, "orchestrator.db");
  runtimeAccountSettingsPath = path.join(runtimeDbDir, "account-settings.db");
  originalEnv = {
    POSSE_ACCOUNT_DB_PATH: process.env.POSSE_ACCOUNT_DB_PATH,
  };
  process.env.POSSE_ACCOUNT_DB_PATH = runtimeAccountSettingsPath;

  const pathsMod = await import("../lib/domains/runtime/functions/paths.js");
  pathsMod.setRuntimePathOverrides({ dbPath: runtimeDbPath });

  const dbMod = await import("../lib/shared/storage/functions/index.js");
  const queueMod = await import("../lib/domains/queue/functions/index.js");
  const assessmentPipelineMod = await import("../lib/domains/worker/functions/helpers/assessment-pipeline.js");
  runtimeModules = { dbMod, queueMod, assessmentPipelineMod, pathsMod };
  resetRuntimeDb();
});

beforeEach(() => {
  resetRuntimeDb();
});

after(() => {
  if (runtimeModules?.dbMod) runtimeModules.dbMod.closeDb();
  if (runtimeModules?.pathsMod) runtimeModules.pathsMod.setRuntimePathOverrides(null);
  try { fs.rmSync(runtimeDbDir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (originalEnv?.POSSE_ACCOUNT_DB_PATH == null) delete process.env.POSSE_ACCOUNT_DB_PATH;
  else process.env.POSSE_ACCOUNT_DB_PATH = originalEnv.POSSE_ACCOUNT_DB_PATH;
});

describe("assessment pipeline helper", () => {
  it("marks non-assessable jobs succeeded via the extracted helper", async () => {
    const { queueMod, assessmentPipelineMod } = runtimeModules;
    const worker = makeWorker(queueMod);

    const wi = queueMod.createWorkItem("Assessment helper success", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: helper success",
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "planner");

    await assessmentPipelineMod.runPostExecutionAssessment(worker, {
      attempt,
      committedHash: null,
      filesCommitted: [],
      filesReverted: [],
      hasFileChanges: false,
      job,
      leaseToken: lease.leaseToken,
      output: "ok",
      pendingFileRequests: null,
      preManifestState: null,
      satisfiedNoop: false,
      startTime: Date.now() - 25,
      wtPath: null,
    }, {
      assessmentRetryFallbackReads: () => 0,
      isAssessorParseRetryBudgetExceeded: () => ({ cap: 0, exceeded: false, spent: 0 }),
      isProviderError: () => false,
      logBadInputFailure: () => {},
      shouldFastPassArtifactAssessment: () => false,
      shouldOverrideArtifactMissingFail: () => false,
      shortJobTitle: (currentJob) => String(currentJob?.title || ""),
      syncAssessorWorkerDisplay: () => {},
    });

    const freshJob = queueMod.getJob(job.id);
    assert.equal(freshJob.status, "succeeded");
    const attempts = queueMod.getAttempts(job.id);
    assert.equal(attempts.at(-1)?.status, "succeeded");
  });

  it("still spawns file-request follow-up on skip-assessment success path", async () => {
    const { queueMod, assessmentPipelineMod } = runtimeModules;
    const worker = makeWorker(queueMod);
    let spawned = false;
    worker._spawnFileRequestFollowUp = () => {
      spawned = true;
    };

    const wi = queueMod.createWorkItem("Assessment helper follow-up", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dev: helper follow-up",
      payload_json: JSON.stringify({ files_to_modify: ["src/app.js"] }),
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");

    await assessmentPipelineMod.runPostExecutionAssessment(worker, {
      attempt,
      committedHash: null,
      filesCommitted: [],
      filesReverted: [],
      hasFileChanges: false,
      job,
      leaseToken: lease.leaseToken,
      output: "ok",
      pendingFileRequests: {
        autoApproved: [{ path: "src/new-file.js", reason: "needed", risk: "mid" }],
        needsApproval: [],
      },
      preManifestState: null,
      satisfiedNoop: true,
      startTime: Date.now() - 25,
      wtPath: null,
    }, {
      assessmentRetryFallbackReads: () => 0,
      isAssessorParseRetryBudgetExceeded: () => ({ cap: 0, exceeded: false, spent: 0 }),
      isProviderError: () => false,
      logBadInputFailure: () => {},
      shouldFastPassArtifactAssessment: () => false,
      shouldOverrideArtifactMissingFail: () => false,
      shortJobTitle: (currentJob) => String(currentJob?.title || ""),
      syncAssessorWorkerDisplay: () => {},
    });

    const freshJob = queueMod.getJob(job.id);
    assert.equal(freshJob.status, "succeeded");
    assert.equal(spawned, true);
  });

  it("reports and snapshots pre-assess hook dirt before assessment", async () => {
    const { queueMod, assessmentPipelineMod } = runtimeModules;
    const projectDir = makeGitRepo("posse-pre-assess-dirty-");
    const hookScript = path.join(runtimeDbDir, `pre-assess-dirty-${Date.now()}.cjs`);
    try {
      fs.writeFileSync(
        hookScript,
        "require('fs').writeFileSync('preassess.out', 'hook output\\n');\n",
        "utf-8",
      );
      queueMod.setSetting("pre_assess_cmd", `"${process.execPath}" "${hookScript}"`);
      const worker = makeWorker(queueMod);
      worker.projectDir = projectDir;
      let retryMessage = null;
      let providerCalled = false;
      worker._retryOrFail = (_job, _leaseToken, message) => {
        retryMessage = message;
      };
      worker.providerClient.call = async () => {
        providerCalled = true;
        return { output: "" };
      };

      const wi = queueMod.createWorkItem("Pre-assess dirty", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Dev: pre-assess dirty",
        payload_json: JSON.stringify({ files_to_modify: ["tracked.txt"] }),
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");

      await assessmentPipelineMod.runPostExecutionAssessment(worker, {
        attempt,
        committedHash: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim(),
        filesCommitted: ["tracked.txt"],
        filesReverted: [],
        hasFileChanges: true,
        job,
        leaseToken: lease.leaseToken,
        output: "ok",
        pendingFileRequests: null,
        preManifestState: null,
        satisfiedNoop: false,
        startTime: Date.now() - 25,
        wtPath: projectDir,
      }, {
        assessmentRetryFallbackReads: () => 0,
        isAssessorParseRetryBudgetExceeded: () => ({ cap: 0, exceeded: false, spent: 0 }),
        isProviderError: () => false,
        logBadInputFailure: () => {},
        shouldFastPassArtifactAssessment: () => false,
        shouldOverrideArtifactMissingFail: () => false,
        shortJobTitle: (currentJob) => String(currentJob?.title || ""),
        syncAssessorWorkerDisplay: () => {},
      });

      const event = queueMod.getEvents(null, 100).find((entry) =>
        entry.work_item_id === wi.id
        && entry.job_id === job.id
        && entry.event_type === "worktree.pre_assess_dirty"
      );
      const attempts = queueMod.getAttempts(job.id);
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim();
      assert.ok(event);
      assert.match(retryMessage, /Pre-assessment hook left worktree dirty/);
      assert.equal(providerCalled, false);
      assert.equal(attempts.at(-1)?.status, "failed");
      assert.equal(fs.existsSync(path.join(projectDir, "preassess.out")), false);
      assert.equal(status, "");
      const detail = JSON.parse(event.event_json);
      assert.ok(detail.changed_paths.includes("preassess.out"));
      assert.ok(detail.snapshot_dir);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      try { fs.rmSync(hookScript, { force: true }); } catch { /* ignore */ }
    }
  });

  it("uses remote prompt contracts for post-execution assessor calls while keeping diff evidence local", async () => {
    const { queueMod, assessmentPipelineMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-assess-remote-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "app.js"), "export const marker = 'SECRET_RAW_SOURCE';\n", "utf-8");

      const wi = queueMod.createWorkItem("Remote assessor prompt", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Dev: remote assessor prompt",
        provider: "claude",
        payload_json: JSON.stringify({
          task_spec: "Verify the app marker change.",
          files_to_modify: ["src/app.js"],
        }),
      });

      let remoteInstructions = "";
      const remoteComposer = {
        composePrompt: async (_packet, instructions) => {
          remoteInstructions = instructions;
          return {
            prompt: "REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER",
            systemPrompt: "POSSE REMOTE PROMPT POLICY (2026.05.v1)\nROLE: assessor",
            stableContext: "STABLE EXECUTION CONTEXT\nsource_policy: no_raw_source",
            userPrompt: "REMOTE USER",
            latencyMs: 3,
            metadata: { prompt_version: "test" },
            response: {
              system_prompt: "POSSE REMOTE PROMPT POLICY (2026.05.v1)\nROLE: assessor",
              stable_context: "STABLE EXECUTION CONTEXT\nsource_policy: no_raw_source",
              user_prompt: "REMOTE USER",
            },
          };
        },
      };

      let providerPrompt = "";
      let providerOpts = null;
      const verdict = await assessmentPipelineMod.assessResult(job, "--- DEV LOG START ---\nstatus: COMPLETE\n--- DEV LOG END ---", {
        cwd: projectDir,
        assessmentContext: {
          task_mode: "code",
          allowed_files: ["src/app.js"],
          files_committed: ["src/app.js"],
          scoped_git_diff: "diff --git a/src/app.js b/src/app.js\n+SECRET_DIFF_EVIDENCE\n",
        },
        remoteComposer,
        trackedCall: async (prompt, opts) => {
          providerPrompt = prompt;
          providerOpts = opts;
          return {
            output: "```json\n{\"verdict\":\"pass\",\"confidence\":\"high\",\"reasons\":[],\"spawn_jobs\":[],\"human_questions\":[],\"suggestions\":[]}\n```",
          };
        },
      });

      assert.equal(verdict.verdict, "pass");
      assert.match(remoteInstructions, /local client will append local-only assessment evidence/i);
      assert.doesNotMatch(remoteInstructions, /SECRET_DIFF_EVIDENCE/);
      assert.doesNotMatch(remoteInstructions, /SECRET_RAW_SOURCE/);
      assert.match(providerPrompt, /^REMOTE USER/);
      assert.match(providerPrompt, /LOCAL ASSESSMENT EVIDENCE/);
      assert.match(providerPrompt, /SECRET_DIFF_EVIDENCE/);
      assert.match(providerPrompt, /SECRET_RAW_SOURCE/);
      assert.match(providerOpts.remoteSystemPrompt, /POSSE REMOTE PROMPT POLICY/);
      assert.match(providerOpts.stableContext, /source_policy: no_raw_source/);
      assert.equal(providerOpts.skipRolePrompt, true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

