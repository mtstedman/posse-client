import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  __dirname,
  resetRuntimeDb,
  runtimeModules,
  disableAtlasForRun,
} from "./core/support/core-harness.js";
import { getRuntimeRoot } from "../lib/domains/runtime/functions/paths.js";
import { worktreePath } from "../lib/domains/git/functions/worktree.js";

function makeGitRepo(prefix) {
  const projectDir = fs.mkdtempSync(path.join(__dirname, prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
  fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
  return projectDir;
}

function worktreeLockPathForTest(projectDir, wtPath) {
  const resolved = path.resolve(wtPath);
  const lockKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(lockKey).digest("hex").slice(0, 16);
  const base = path.basename(resolved).slice(0, 40) || "worktree";
  return path.join(getRuntimeRoot(projectDir), "worktree-locks", `${base}-${hash}.lock`);
}

async function waitFor(promise, label, ms = 3000) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function removeTreeEventually(dir, attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === attempts || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(err?.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function runSetupInterruption(reason) {
  resetRuntimeDb();
  // The interruption path runs through worker.execute(), which gates dev jobs
  // behind ATLAS main freshness. Disable ATLAS so the job reaches the worktree
  // setup we want to interrupt (resetRuntimeDb above clears the kill switch).
  disableAtlasForRun("worktree setup interruption test");
  const { queueMod, workerMod } = runtimeModules;
  const projectDir = makeGitRepo(`tmp-async-worktree-${reason}-`);
  let lockPath = null;
  try {
    const wi = queueMod.createWorkItem(`Setup interruption ${reason}`, "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Touch tracked file",
      payload_json: JSON.stringify({
        task_mode: "code",
        files_to_modify: ["tracked.txt"],
        files_to_create: [],
        create_roots: [],
      }),
    });
    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const wtPath = worktreePath(projectDir, wi.id, wi.title);
    lockPath = worktreeLockPathForTest(projectDir, wtPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker._dispatch = async () => {
      throw new Error("setup unexpectedly reached execution");
    };

    const execution = worker.execute(leasedJob);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(worker.killJob(job.id, reason), true);
    await waitFor(execution, `worker setup interruption ${reason}`);

    return {
      job: queueMod.getJob(job.id),
      attempts: queueMod.getAttempts(job.id),
    };
  } finally {
    if (lockPath) fs.rmSync(lockPath, { force: true });
    await removeTreeEventually(projectDir);
  }
}

describe("worktree setup interruption", () => {
  it("records setup failures in job_attempts", async () => {
    resetRuntimeDb();
    const { setUpWorktreeForJob } = await import("../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-async-worktree-setup-fail-"));
    try {
      const wi = queueMod.createWorkItem("Setup failure attempts", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Touch tracked file",
        payload_json: JSON.stringify({
          task_mode: "code",
          files_to_modify: ["tracked.txt"],
          files_to_create: [],
          create_roots: [],
        }),
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      let retryMessage = null;
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: () => {},
        _retryOrFail: (_job, _leaseToken, message) => { retryMessage = String(message || ""); },
      };

      const result = await setUpWorktreeForJob(worker, leasedJob, lease.leaseToken);
      const refreshed = queueMod.getJob(job.id);
      const attempts = queueMod.getAttempts(job.id);

      assert.equal(result.ok, false);
      assert.match(retryMessage, /Git worktree setup failed/);
      assert.equal(refreshed.attempt_count, 1);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt_number, 1);
      assert.equal(attempts[0].worker_type, "system");
      assert.equal(attempts[0].model_name, "worktree-setup");
      assert.equal(attempts[0].status, "failed");
      assert.match(attempts[0].error_text, /Git worktree setup failed/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("cancels without consuming an attempt when killed during async setup", async () => {
    const result = await runSetupInterruption("user_canceled");

    assert.equal(result.job.status, "canceled");
    assert.equal(result.job.attempt_count, 0);
    assert.equal(result.job.lease_token, null);
    assert.deepEqual(result.attempts, []);
  });

  it("requeues without consuming an attempt when lease expires during async setup", async () => {
    const result = await runSetupInterruption("lease_expired");

    assert.equal(result.job.status, "queued");
    assert.equal(result.job.attempt_count, 0);
    assert.equal(result.job.lease_token, null);
    assert.deepEqual(result.attempts, []);
  });
});
