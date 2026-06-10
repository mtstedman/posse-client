import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  collectScopePaths,
  pathInScope,
  computeWorktreeStatus,
  computeWorktreeStatusAsync,
  commitInScopeChanges,
  discardWorktreeFiles,
  stashTargetBranchChanges,
} from "../lib/domains/cli/functions/worktree-status.js";
import { buildReviewReportData } from "../lib/domains/cli/functions/review-report.js";
import { setSetting } from "../lib/domains/queue/functions/settings.js";
import { closeAccountSettingsDb, setAccountSettingsPathForTests } from "../lib/domains/settings/functions/account-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let settingsDir = null;

beforeEach(() => {
  settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-wtstatus-settings-"));
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(path.join(settingsDir, "account.db"));
});

afterEach(() => {
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(null);
  cleanup(settingsDir);
  settingsDir = null;
});

function makeRepo(prefix) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
  fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "index.js"), "// base\n");
  execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
  return projectDir;
}

function makeWiWorktree(projectDir, wiId, branchName) {
  const root = path.join(projectDir, ".posse-worktrees");
  fs.mkdirSync(root, { recursive: true });
  const wtDir = path.join(root, `wi-${wiId}`);
  execFileSync("git", ["worktree", "add", "-b", branchName, wtDir, "main"], {
    cwd: projectDir, stdio: "ignore",
  });
  return wtDir;
}

function cleanup(projectDir) {
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe("scope classification", () => {
  it("pathInScope matches exact files and root prefixes", () => {
    const scope = { files: ["lib/foo.js"], roots: ["docs"] };
    assert.equal(pathInScope("lib/foo.js", scope), true);
    assert.equal(pathInScope("lib/bar.js", scope), false);
    assert.equal(pathInScope("docs/readme.md", scope), true);
    assert.equal(pathInScope("docs", scope), true);
    assert.equal(pathInScope("docs-other/x", scope), false);
  });

  it("collectScopePaths aggregates files_to_modify, files_to_create, create_roots across jobs", () => {
    const jobs = [
      { payload_json: JSON.stringify({ files_to_modify: ["a.js"], files_to_create: ["b.js"] }) },
      { payload_json: JSON.stringify({ files_to_modify: ["a.js", "c.js"], create_roots: ["pkg"] }) },
    ];
    const scope = collectScopePaths(jobs);
    assert.deepEqual(scope.files.sort(), ["a.js", "b.js", "c.js"]);
    assert.deepEqual(scope.modifyFiles.sort(), ["a.js", "c.js"]);
    assert.deepEqual(scope.createFiles, ["b.js"]);
    assert.deepEqual(scope.roots, ["pkg"]);
  });
});

describe("computeWorktreeStatus", () => {
  it("classifies in-scope vs out-of-scope vs untracked in the WI worktree", () => {
    const projectDir = makeRepo("tmp-wtstatus-classify-");
    try {
      const wtDir = makeWiWorktree(projectDir, 42, "posse/wi-42-test");

      // In-scope modification, out-of-scope modification, untracked stray file
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed\n");
      fs.writeFileSync(path.join(wtDir, "src", "index.js"), "// changed\n");
      fs.writeFileSync(path.join(wtDir, "stray.txt"), "new\n");

      const wi = { id: 42, branch_name: "posse/wi-42-test" };
      const jobs = [{ payload_json: JSON.stringify({ files_to_modify: ["tracked.txt"] }) }];

      const status = computeWorktreeStatus({ wi, jobs, projectDir, targetBranch: "main" });
      assert.equal(status.wtExists, true);
      assert.equal(status.wtDir, wtDir);
      assert.equal(status.sourceBranch, "posse/wi-42-test");
      assert.equal(status.sourceDir, wtDir);
      assert.equal(status.targetDir, projectDir);

      const byPath = Object.fromEntries(status.wtFiles.map((f) => [f.path, f]));
      assert.equal(byPath["tracked.txt"].inScope, true);
      assert.match(byPath["tracked.txt"].diff.summary, /^\+\d+\/-\d+$/);
      assert.equal(byPath["src/index.js"].inScope, false);
      assert.equal(byPath["src/index.js"].untracked, false);
      assert.equal(byPath["stray.txt"].inScope, false);
      assert.equal(byPath["stray.txt"].untracked, true);

      assert.equal(status.targetDirty, false);
    } finally {
      cleanup(projectDir);
    }
  });

  it("detects target-branch dirt independently of the WI worktree", () => {
    const projectDir = makeRepo("tmp-wtstatus-target-");
    try {
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "edited on target\n");
      const wi = { id: 1, branch_name: null };
      const status = computeWorktreeStatus({ wi, jobs: [], projectDir, targetBranch: "main" });
      assert.equal(status.targetDirty, true);
      assert.ok(status.targetFiles.length >= 1);
      assert.equal(status.wtExists, false);
      assert.equal(status.targetDir, projectDir);
      assert.equal(status.sourceBranch, null);
      assert.equal(status.sourceDir, null);
      const tracked = status.targetFiles.find((entry) => entry.path === "tracked.txt");
      assert.ok(tracked);
      assert.match(tracked.diff.summary, /^\+\d+\/-\d+$/);
    } finally {
      cleanup(projectDir);
    }
  });

  it("filters .posse/ runtime paths from both target and worktree listings", () => {
    const projectDir = makeRepo("tmp-wtstatus-runtime-");
    try {
      fs.mkdirSync(path.join(projectDir, ".posse"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".posse", "marker.txt"), "x");
      const wi = { id: 1, branch_name: null };
      const status = computeWorktreeStatus({ wi, jobs: [], projectDir, targetBranch: "main" });
      assert.equal(status.targetDirty, false, "runtime .posse/ paths should be filtered");
    } finally {
      cleanup(projectDir);
    }
  });
});

describe("commitInScopeChanges / discardWorktreeFiles / stashTargetBranchChanges", () => {
  it("commits only in-scope dirty files to the WI branch", () => {
    const projectDir = makeRepo("tmp-wtstatus-commit-");
    try {
      const wtDir = makeWiWorktree(projectDir, 7, "posse/wi-7-test");
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "scoped change\n");
      fs.writeFileSync(path.join(wtDir, "src", "index.js"), "// out of scope\n");
      execFileSync("git", ["add", "src/index.js"], { cwd: wtDir, stdio: "ignore" });

      const result = commitInScopeChanges({
        wtDir,
        scope: { files: ["tracked.txt"], roots: [] },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.paths, ["tracked.txt"]);

      // Review commits use the worker-side scoped commit path, so tracked
      // out-of-scope dirt is reverted before the commit is created.
      const after = computeWorktreeStatus({
        wi: { id: 7, branch_name: "posse/wi-7-test" },
        jobs: [{ payload_json: JSON.stringify({ files_to_modify: ["tracked.txt"] }) }],
        projectDir, targetBranch: "main",
      });
      const stillDirty = after.wtFiles.map((f) => f.path);
      assert.ok(!stillDirty.includes("tracked.txt"));
      assert.ok(!stillDirty.includes("src/index.js"));
      const restored = fs.readFileSync(path.join(wtDir, "src", "index.js"), "utf-8").replace(/\r\n/g, "\n");
      assert.equal(restored, "// base\n");
    } finally {
      cleanup(projectDir);
    }
  });

  it("runs secrets_scan when committing in-scope review changes", () => {
    const projectDir = makeRepo("tmp-wtstatus-commit-hook-");
    try {
      const wtDir = makeWiWorktree(projectDir, 8, "posse/wi-8-test");
      const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim();
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "API_KEY=\"abcdefghijklmnopqrstuvwxyz123456\"\n");

      const result = commitInScopeChanges({
        wtDir,
        scope: { files: ["tracked.txt"], roots: [] },
      });

      assert.equal(result.ok, false);
      assert.match(result.message, /SECRETS DETECTED/i);
      const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(after, before);
    } finally {
      cleanup(projectDir);
    }
  });

  it("runs post_dev_verify before creating review commits", () => {
    const projectDir = makeRepo("tmp-wtstatus-commit-verify-");
    try {
      const wtDir = makeWiWorktree(projectDir, 10, "posse/wi-10-test");
      const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim();
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "scoped change\n");
      const nodeCmd = `"${process.execPath}" -e "process.exit(7)"`;
      setSetting("pre_assess_cmd", nodeCmd);

      const result = commitInScopeChanges({
        wtDir,
        scope: { files: ["tracked.txt"], modifyFiles: ["tracked.txt"], roots: [] },
      });

      assert.equal(result.ok, false);
      assert.match(result.message, /Build\/lint verification failed/i);
      const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(after, before);
    } finally {
      cleanup(projectDir);
    }
  });

  it("commits configured create-file paths with non-ASCII names", () => {
    const projectDir = makeRepo("tmp-wtstatus-commit-unicode-");
    try {
      const wtDir = makeWiWorktree(projectDir, 11, "posse/wi-11-test");
      const fileName = "café.txt";
      fs.writeFileSync(path.join(wtDir, fileName), "bonjour\n");

      const result = commitInScopeChanges({
        wtDir,
        scope: { files: [fileName], createFiles: [fileName], roots: [] },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.paths, [fileName]);
      const listed = execFileSync("git", ["-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD"], {
        cwd: wtDir, encoding: "utf-8",
      }).trim().split("\n").filter(Boolean);
      assert.ok(listed.includes(fileName));
    } finally {
      cleanup(projectDir);
    }
  });

  it("discards selected untracked + tracked paths in the WI worktree", () => {
    const projectDir = makeRepo("tmp-wtstatus-discard-");
    try {
      const wtDir = makeWiWorktree(projectDir, 9, "posse/wi-9-test");
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "modified\n");
      fs.writeFileSync(path.join(wtDir, "stray.txt"), "untracked\n");

      const result = discardWorktreeFiles({ wtDir, paths: ["tracked.txt", "stray.txt"] });
      assert.equal(result.ok, true);

      const restored = fs.readFileSync(path.join(wtDir, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n");
      assert.equal(restored, "base\n");
      assert.equal(fs.existsSync(path.join(wtDir, "stray.txt")), false);
    } finally {
      cleanup(projectDir);
    }
  });

  it("stashes target-branch changes including untracked files", () => {
    const projectDir = makeRepo("tmp-wtstatus-stash-");
    try {
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "edit\n");
      fs.writeFileSync(path.join(projectDir, "new.txt"), "new\n");

      const result = stashTargetBranchChanges({ projectDir });
      assert.equal(result.ok, true);

      const after = computeWorktreeStatus({
        wi: { id: 1, branch_name: null },
        jobs: [], projectDir, targetBranch: "main",
      });
      assert.equal(after.targetDirty, false);
    } finally {
      cleanup(projectDir);
    }
  });
});

describe("buildReviewReportData wiring", () => {
  it("attaches worktreeStatus when worktreeStatusFn is provided", () => {
    const wi = { id: 1, branch_name: null, title: "t", priority: 1 };
    const callArgs = [];
    const worktreeStatusFn = (args) => {
      callArgs.push(args);
      return {
        wtDir: null,
        wtExists: false,
        wtFiles: [],
        wtStashes: 0,
        sourceBranch: null,
        sourceDir: null,
        workItemId: 1,
        targetDir: __dirname,
        targetBranch: "main",
        targetDirty: false,
        targetFiles: [],
        scope: { files: [], roots: [] },
      };
    };
    const data = buildReviewReportData([wi], {
      projectDir: __dirname,
      targetBranch: "main",
      worktreeStatusFn,
    });
    assert.equal(callArgs.length, 1);
    assert.equal(callArgs[0].wi, wi);
    assert.equal(callArgs[0].targetBranch, "main");
    assert.ok(data[0].worktreeStatus);
    assert.equal(data[0].worktreeStatus.wtDir, null);
    assert.equal(data[0].worktreeStatus.targetDir, __dirname);
  });

  it("leaves worktreeStatus null when worktreeStatusFn is omitted", () => {
    const wi = { id: 2, branch_name: null, title: "t", priority: 1 };
    const data = buildReviewReportData([wi], { projectDir: __dirname });
    assert.equal(data[0].worktreeStatus, null);
  });

  it("marks final assessment blocked when review tree has unresolved dirt", () => {
    const wi = { id: 3, branch_name: "posse/wi-3", title: "t", priority: 1, status: "complete" };
    const data = buildReviewReportData([wi], {
      projectDir: __dirname,
      targetBranch: "main",
      worktreeStatusFn: () => ({
        wtDir: "/tmp/wi-3",
        wtExists: true,
        wtFiles: [{ path: "stray.txt", status: "??", inScope: false, untracked: true }],
        wtStashes: 0,
        sourceBranch: "posse/wi-3",
        sourceDir: "/tmp/wi-3",
        workItemId: 3,
        targetDir: __dirname,
        targetBranch: "main",
        targetDirty: false,
        targetFiles: [],
        scope: { files: [], roots: [] },
      }),
    });
    assert.equal(data[0].finalAssessment.status, "BLOCKED");
    assert.equal(data[0].finalAssessment.dirtyTree.status, "needs_user_resolution");
    assert.equal(data[0].finalAssessment.dirtyTree.ambiguousFiles[0].path, "stray.txt");
  });

  it("marks final assessment pass when review tree is clean", () => {
    const wi = { id: 4, branch_name: "posse/wi-4", title: "t", priority: 1, status: "complete" };
    const data = buildReviewReportData([wi], {
      projectDir: __dirname,
      targetBranch: "main",
      worktreeStatusFn: () => ({
        wtDir: "/tmp/wi-4",
        wtExists: true,
        wtFiles: [],
        wtStashes: 0,
        sourceBranch: "posse/wi-4",
        sourceDir: "/tmp/wi-4",
        workItemId: 4,
        targetDir: __dirname,
        targetBranch: "main",
        targetDirty: false,
        targetFiles: [],
        scope: { files: [], roots: [] },
      }),
    });
    assert.equal(data[0].finalAssessment.status, "PASS");
  });
});

describe("async worker protocol", () => {
  // Regression: the parent listener used to check `message.ok` while the
  // worker posts ThreadManager-style { type: "result" } frames, so every
  // async review git action rejected even on success — review reports got
  // worktreeStatus = null and the dirty-tree merge blocker was defeated.
  it("computeWorktreeStatusAsync resolves through the worker result protocol", async () => {
    const projectDir = makeRepo("posse-wtstatus-async-");
    try {
      const status = await computeWorktreeStatusAsync({
        wi: { id: 999, branch_name: null },
        jobs: [],
        projectDir,
        targetBranch: "main",
      });
      assert.equal(status.workItemId, 999);
      assert.equal(status.targetDir, projectDir);
      assert.equal(status.targetDirty, false);
    } finally {
      cleanup(projectDir);
    }
  });
});
