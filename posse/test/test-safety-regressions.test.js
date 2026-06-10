import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { ThreadManager } from "../lib/shared/concurrency/classes/ThreadManager.js";
import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";
import { artifactsDir, cleanupArtifactDirs, ensureArtifactDirs, inputsDir, workspaceDir } from "../lib/domains/artifacts/functions/index.js";
import { gitCommitAllAsync } from "../lib/domains/git/functions/commit-scope.js";
import { sanitizeWorkerExecArgv } from "../lib/domains/runtime/functions/worker-exec-argv.js";
import { createWorkItem, getEventsByWorkItem, getWorkItem, setWorkItemBranch } from "../lib/domains/queue/functions/index.js";
import { removeTempTree, withTempRuntimeDb } from "./helpers/regression-test-harness.js";

const workerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-safety-workers-"));

after(() => {
  removeTempTree(workerTmp);
});

function writeWorker(name, source) {
  const file = path.join(workerTmp, name);
  fs.writeFileSync(file, source, "utf-8");
  return pathToFileURL(file);
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

function branchExists(repoDir, branchName) {
  return execFileSync("git", ["branch", "--list", branchName], { cwd: repoDir, encoding: "utf-8" }).trim().length > 0;
}

function withTemporaryExecArgv(args, fn) {
  const originalLength = process.execArgv.length;
  process.execArgv.push(...args);
  const cleanup = () => {
    process.execArgv.splice(originalLength);
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

describe("safety regressions", () => {
  it("sanitizes entrypoint-only Node flags for worker threads", async () => {
    assert.deepEqual(
      sanitizeWorkerExecArgv([
        "--input-type",
        "module",
        "--trace-warnings",
        "--input-type=commonjs",
        "-e",
        "console.log(1)",
        "-i",
        "--conditions=dev",
      ]),
      ["--trace-warnings", "--conditions=dev"],
    );

    const workerUrl = writeWorker("exec-argv-worker.mjs", `
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({ type: "result", result: process.execArgv });
    `);
    const manager = new ThreadManager();
    const result = await withTemporaryExecArgv(["--input-type=module"], () =>
      manager.run(workerUrl, { label: "exec argv worker" })
    );

    assert.equal(result.some((arg) => String(arg).startsWith("--input-type")), false);
  });

  it("starts the async commit worker when the parent was launched with --input-type", async () => {
    const projectDir = makeGitRepo("posse-commit-worker-exec-argv-");
    try {
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "changed\n", "utf-8");
      const result = await withTemporaryExecArgv(["--input-type=module"], () =>
        gitCommitAllAsync("commit under sanitized execArgv", projectDir, {
          modifyFiles: ["tracked.txt"],
          createFiles: [],
          deleteFiles: [],
          createRoots: [],
        }, { projectDir })
      );

      assert.ok(result?.hash);
    } finally {
      removeTempTree(projectDir);
    }
  });

  it("refuses to remove external worktrees checked out on a WI branch", () => withTempRuntimeDb(() => {
    const projectDir = makeGitRepo("posse-cleanup-external-worktree-");
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-external-worktree-"));
    const externalWorktree = path.join(externalRoot, "external");
    try {
      const wi = createWorkItem("External worktree cleanup", "desc");
      const branchName = `posse/wi-${wi.id}-external`;
      setWorkItemBranch(wi.id, branchName, null);
      execFileSync("git", ["worktree", "add", "-b", branchName, externalWorktree], { cwd: projectDir, stdio: "ignore" });

      const helpers = createGitWorkflowHelpers({ projectDir, targetBranch: "main" });
      const ok = helpers.cleanupWiBranch(getWorkItem(wi.id));

      assert.equal(ok, false);
      assert.equal(fs.existsSync(externalWorktree), true);
      assert.equal(branchExists(projectDir, branchName), true);
      assert.equal(getWorkItem(wi.id).branch_name, branchName);
      assert.ok(getEventsByWorkItem(wi.id, 10).some((event) =>
        event.event_type === "worktree.cleanup_failed"
        && /Skipped external worktree cleanup/.test(event.message || "")
      ));
    } finally {
      try { execFileSync("git", ["worktree", "remove", "--force", externalWorktree], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "prune"], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      removeTempTree(projectDir);
      removeTempTree(externalRoot);
    }
  }));

  it("rejects artifact scope IDs that would escape category roots", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-artifact-scope-safety-"));
    const escapedOldPath = path.join(projectDir, ".posse", "resources", "evil");
    try {
      fs.mkdirSync(escapedOldPath, { recursive: true });
      fs.writeFileSync(path.join(escapedOldPath, "sentinel.txt"), "keep\n", "utf-8");

      for (const scopeId of ["../evil", "..\\evil", path.resolve(projectDir, "absolute-scope"), ".", "..", "bad\0scope"]) {
        assert.throws(() => inputsDir(scopeId, projectDir), /Invalid artifact scope ID/);
        assert.throws(() => workspaceDir(scopeId, projectDir), /Invalid artifact scope ID/);
        assert.throws(() => artifactsDir(scopeId, projectDir), /Invalid artifact scope ID/);
        assert.throws(() => ensureArtifactDirs(scopeId, "image", projectDir), /Invalid artifact scope ID/);
        assert.throws(() => cleanupArtifactDirs(scopeId, projectDir, { keepArtifacts: false }), /Invalid artifact scope ID/);
      }

      assert.equal(fs.existsSync(path.join(escapedOldPath, "sentinel.txt")), true);
    } finally {
      removeTempTree(projectDir);
    }
  });
});
