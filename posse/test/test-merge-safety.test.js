import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import { closeDb } from "../lib/shared/storage/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import {
  createWorkItem,
  getWorkItem,
  setSetting,
  setWorkItemBranch,
  updateWorkItemStatus,
} from "../lib/domains/queue/functions/index.js";
import { preserveDirtyWorktreeSnapshot, snapshotAndResetDirtyWorktreeAsync, worktreePath, worktreeRoot } from "../lib/domains/git/functions/worktree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const orchestratorPath = path.join(projectRoot, "orchestrator.js");

function git(cwd, args, opts = {}) {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: opts.stdio || ["pipe", "pipe", "pipe"],
    timeout: opts.timeout || 60_000,
  });
  return out == null ? "" : String(out).trim();
}

function fakeNativeResetManager() {
  return {
    shouldUse(name) {
      return name === "git";
    },
    binary(name) {
      assert.equal(name, "git");
      return {
        async run(command, args, opts) {
          assert.deepEqual(args, []);
          const envelope = JSON.parse(String(opts.input || "{}"));
          let data;
          if (command === "git.worktree.resetDirty") {
            const wtPath = envelope.payload?.wtPath;
            const cleanIgnored = Boolean(envelope.payload?.cleanIgnored);
            git(wtPath, ["reset", "--hard", "HEAD"], { stdio: "ignore" });
            git(wtPath, ["clean", cleanIgnored ? "-fdx" : "-fd"], { stdio: "ignore" });
            const postZ = execFileSync("git", ["status", "--porcelain", "-z"], {
              cwd: wtPath,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
            });
            const remainingPaths = String(postZ || "")
              .split("\0")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => line.length >= 4 ? line.slice(3).trim() : line);
            data = {
              clean: remainingPaths.length === 0,
              postResetPorcelain: String(postZ || "").replace(/\0/g, "\n").trim(),
              remainingPaths,
            };
          } else if (command === "git.snapshot.writeNote") {
            const { projectDir, objectHash, note } = envelope.payload || {};
            git(projectDir, ["notes", "--ref=refs/notes/posse-snapshots", "add", "-f", "-m", JSON.stringify(note), objectHash], { stdio: "ignore" });
            data = true;
          } else {
            throw new Error(`unexpected native git command ${command}`);
          }
          const json = { ok: true, data };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

function nonRuntimeGitStatus(projectDir) {
  return git(projectDir, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const file = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, "").replace(/\\/g, "/") : "";
      if (file === ".posse" || file.startsWith(".posse/")) return false;
      if (line.startsWith("?? ") && file === ".gitignore") {
        try {
          const content = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8").replace(/\r\n/g, "\n");
          return !(content.includes("# Posse runtime (auto-added)") && content.includes(".posse/"));
        } catch {
          return true;
        }
      }
      return true;
    })
    .join("\n");
}

function branchExists(projectDir, branchName) {
  return git(projectDir, ["branch", "--list", branchName]) !== "";
}

function snapshotRefsMatching(projectDir, substring) {
  let raw = "";
  try {
    raw = git(projectDir, ["for-each-ref", "--format=%(refname)", "refs/posse/snapshots"]);
  } catch {
    return [];
  }
  return raw.split("\n").map((line) => line.trim()).filter((line) => line && line.includes(substring));
}

function initRepo(projectDir) {
  git(projectDir, ["init", "-b", "main"], { stdio: "ignore" });
  git(projectDir, ["config", "user.email", "posse-test@example.com"], { stdio: "ignore" });
  git(projectDir, ["config", "user.name", "Posse Test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
  git(projectDir, ["add", "base.txt"], { stdio: "ignore" });
  git(projectDir, ["commit", "-m", "init"], { stdio: "ignore" });
}

function withProjectRuntime(projectDir, fn) {
  closeDb();
  setRuntimePathOverridesForTests({
    dbPath: path.join(projectDir, ".posse", "db", "orchestrator.db"),
  });
  try {
    return fn();
  } finally {
    closeDb();
    setRuntimePathOverridesForTests(null);
  }
}

function createWorkItemForBranch(projectDir, branchName, status) {
  return withProjectRuntime(projectDir, () => {
    const wi = createWorkItem(`Merge ${branchName}`, "desc");
    setWorkItemBranch(wi.id, branchName, git(projectDir, ["rev-parse", "main"]));
    updateWorkItemStatus(wi.id, status);
    return wi.id;
  });
}

function createCompletedWorkItemForBranch(projectDir, branchName) {
  return createWorkItemForBranch(projectDir, branchName, "complete");
}

function readWorkItem(projectDir, wiId) {
  return withProjectRuntime(projectDir, () => getWorkItem(wiId));
}

function runOrchestratorCommand(projectDir, args, { input = "", env = {} } = {}) {
  return spawnSync(process.execPath, [orchestratorPath, ...args], {
    cwd: projectDir,
    input,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

function runMergeCommand(projectDir, wiId, env = {}) {
  return runOrchestratorCommand(projectDir, ["merge", String(wiId), "--no-tui"], { input: "y\n", env });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("merge safety", () => {
  it("rejects unknown CLI flags before running a command", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-unknown-flag-"));
    try {
      initRepo(projectDir);

      const result = runOrchestratorCommand(projectDir, ["queue", "--auto-approev"]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Unknown flag: --auto-approev/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses to merge when the current worktree has WIP", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-wip-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-merge"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-merge");

      git(projectDir, ["checkout", "-b", "user-work", "main"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "local.txt"), "local wip\n", "utf-8");

      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Merge refused: target worktree has 1 uncommitted change/);
      assert.equal(git(projectDir, ["branch", "--show-current"]), "user-work");
      assert.equal(fs.readFileSync(path.join(projectDir, "local.txt"), "utf-8").replace(/\r\n/g, "\n"), "local wip\n");
      assert.match(git(projectDir, ["status", "--porcelain"]), /\?\? local\.txt/);
      assert.throws(() => git(projectDir, ["show", "main:feature.txt"]));
      assert.equal(git(projectDir, ["ls-tree", "-r", "--name-only", "main"]).includes("local.txt"), false);
      assert.equal(branchExists(projectDir, "posse/wi-merge"), true);
      assert.equal(readWorkItem(projectDir, wiId).branch_name, "posse/wi-merge");
      assert.equal(readWorkItem(projectDir, wiId).merge_state, "merge_failed");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses to merge when the source WI worktree has uncommitted tracked changes", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-source-dirty-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-source-dirty"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-source-dirty");
      const wtDir = worktreePath(projectDir, wiId);
      git(projectDir, ["worktree", "add", wtDir, "posse/wi-source-dirty"], { stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "feature.txt"), "edited but never committed\n", "utf-8");

      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Merge refused: WI#\d+ worktree has 1 unresolved dirty file/);
      assert.throws(() => git(projectDir, ["show", "main:feature.txt"]));
      assert.equal(fs.readFileSync(path.join(wtDir, "feature.txt"), "utf-8"), "edited but never committed\n");
      assert.match(git(wtDir, ["status", "--porcelain"]), /M feature\.txt/);
      assert.equal(readWorkItem(projectDir, wiId).merge_state, "merge_failed");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("snapshots untracked leftovers and merges when the source WI worktree has no tracked changes", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-source-untracked-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-source-untracked"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-source-untracked");
      const wtDir = worktreePath(projectDir, wiId);
      git(projectDir, ["worktree", "add", wtDir, "posse/wi-source-untracked"], { stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tsconfig.json"), "{}\n", "utf-8");

      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(projectDir, ["show", "main:feature.txt"]), "feature");
      assert.equal(git(projectDir, ["ls-tree", "-r", "--name-only", "main"]).includes("tsconfig.json"), false);
      assert.equal(branchExists(projectDir, "posse/wi-source-untracked"), false);
      assert.equal(readWorkItem(projectDir, wiId).merge_state, "merged");

      const snapshots = snapshotRefsMatching(projectDir, "untracked-leftovers");
      assert.ok(snapshots.length > 0, "expected untracked leftovers to be snapshotted before merging");
      const latest = snapshots.sort().at(-1);
      assert.equal(git(projectDir, ["show", `${latest}^3:tsconfig.json`]), "{}");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("snapshots and scopes checkout-blocking runtime ignore files before merging", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-runtime-overwrite-"));
    try {
      initRepo(projectDir);

      git(projectDir, ["checkout", "-b", "user-work", "main"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, ".gitignore"), "target ignore\n", "utf-8");
      git(projectDir, ["add", ".gitignore"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "track gitignore"], { stdio: "ignore" });

      git(projectDir, ["checkout", "-b", "posse/wi-runtime-overwrite"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-runtime-overwrite");

      git(projectDir, ["checkout", "user-work"], { stdio: "ignore" });
      fs.mkdirSync(path.join(projectDir, ".posse"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".posse", "other.txt"), "keep me\n", "utf-8");
      fs.writeFileSync(
        path.join(projectDir, ".gitignore"),
        "# Posse runtime (auto-added)\n.posse/\n",
        "utf-8"
      );

      // Pin the merge target so the scenario does not depend on
      // resolveTargetBranch's current-branch fallback (which would pick
      // 'user-work' here and merge the WI into the wrong branch).
      withProjectRuntime(projectDir, () => setSetting("target_branch", "main", { projectDir }));
      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(projectDir, ["show", "main:feature.txt"]), "feature");
      assert.equal(git(projectDir, ["show", "main:.gitignore"]), "target ignore");
      assert.equal(fs.readFileSync(path.join(projectDir, ".posse", "other.txt"), "utf-8"), "keep me\n");

      const snapshots = snapshotRefsMatching(projectDir, "target-checkout-overwrite-main");
      assert.ok(snapshots.length > 0, "expected checkout-blocking runtime file to be snapshotted");
      const latest = snapshots.sort().at(-1);
      assert.equal(git(projectDir, ["show", `${latest}^3:.gitignore`]), "# Posse runtime (auto-added)\n.posse/");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("honors target_branch as the merge target", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-setting-target-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "release/env"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "release.txt"), "release\n", "utf-8");
      git(projectDir, ["add", "release.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "release branch"], { stdio: "ignore" });

      git(projectDir, ["checkout", "-b", "posse/wi-env-target"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-env-target");
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      withProjectRuntime(projectDir, () => setSetting("target_branch", "release/env", { projectDir }));
      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(projectDir, ["show", "release/env:feature.txt"]), "feature");
      assert.throws(() => git(projectDir, ["show", "main:feature.txt"]));
      assert.equal(branchExists(projectDir, "posse/wi-env-target"), false);
      assert.equal(readWorkItem(projectDir, wiId).branch_name, null);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("treats an already-integrated squash branch as merged and cleans SQUASH_MSG", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-already-integrated-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-integrated"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });
      git(projectDir, ["merge", "--squash", "posse/wi-integrated"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "manual squash"], { stdio: "ignore" });

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-integrated");
      const result = runMergeCommand(projectDir, wiId);

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "SQUASH_MSG")), false);
      assert.equal(nonRuntimeGitStatus(projectDir), "");
      assert.equal(readWorkItem(projectDir, wiId).merge_state, "merged");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("recovers when a slow post-commit hook returns after the squash commit lands", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-slow-hook-recover-"));
    let hookInstalled = false;
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-timeout-recover"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, ".git", "hooks", "post-commit"), "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
      hookInstalled = true;

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-timeout-recover");
      const result = runMergeCommand(projectDir, wiId);

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(projectDir, ["show", "main:feature.txt"]), "feature");
      assert.equal(git(projectDir, ["show", "-s", "--format=%s", "HEAD"]), "Squash merge posse/wi-timeout-recover into main");
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "SQUASH_MSG")), false);
      assert.equal(nonRuntimeGitStatus(projectDir), "");
      assert.equal(branchExists(projectDir, "posse/wi-timeout-recover"), false);
      assert.equal(readWorkItem(projectDir, wiId).merge_state, "merged");
    } finally {
      if (hookInstalled) sleepMs(2200);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not merge a WI branch before the work item is complete", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-incomplete-"));
    try {
      initRepo(projectDir);
      git(projectDir, ["checkout", "-b", "posse/wi-incomplete"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      const wiId = createWorkItemForBranch(projectDir, "posse/wi-incomplete", "running");
      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /only complete work items can be merged/);
      assert.equal(branchExists(projectDir, "posse/wi-incomplete"), true);
      assert.throws(() => git(projectDir, ["show", "main:feature.txt"]));
      assert.equal(readWorkItem(projectDir, wiId).branch_name, "posse/wi-incomplete");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("previews stale worktree pruning without removing directories in dry-run mode", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-prune-dry-run-"));
    try {
      initRepo(projectDir);
      const orphanDir = path.join(worktreeRoot(projectDir), "wi-999-orphan");
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, "note.txt"), "orphan\n", "utf-8");

      const result = runOrchestratorCommand(projectDir, ["prune", "--dry-run", "--no-tui"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Dry-run: would prune 1 worktree/);
      assert.equal(fs.existsSync(orphanDir), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("announces when auto-merge is enabled by the persistent setting", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-auto-merge-setting-"));
    try {
      initRepo(projectDir);
      withProjectRuntime(projectDir, () => setSetting("auto_merge_completed", "true"));

      const result = runOrchestratorCommand(projectDir, ["run", "--no-tui"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Auto-merge is enabled by admin setting auto_merge_completed=true/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("cleans stale stash-apply conflict residue without dropping the user's stash", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-merge-stash-"));
    try {
      initRepo(projectDir);
      fs.writeFileSync(path.join(projectDir, "conflict.txt"), "base\n", "utf-8");
      git(projectDir, ["add", "conflict.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "add conflict base"], { stdio: "ignore" });

      git(projectDir, ["checkout", "-b", "posse/wi-stale"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n", "utf-8");
      git(projectDir, ["add", "feature.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "feature"], { stdio: "ignore" });
      git(projectDir, ["checkout", "main"], { stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "conflict.txt"), "stashed\n", "utf-8");
      git(projectDir, ["stash", "push", "-m", "user stash"], { stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "conflict.txt"), "main change\n", "utf-8");
      git(projectDir, ["add", "conflict.txt"], { stdio: "ignore" });
      git(projectDir, ["commit", "-m", "main conflict change"], { stdio: "ignore" });
      assert.throws(() => git(projectDir, ["stash", "apply", "stash@{0}"], { stdio: ["pipe", "pipe", "pipe"] }));
      assert.match(git(projectDir, ["diff", "--name-only", "--diff-filter=U"]), /conflict\.txt/);
      assert.match(git(projectDir, ["stash", "list"]), /user stash/);

      const wiId = createCompletedWorkItemForBranch(projectDir, "posse/wi-stale");
      const result = runMergeCommand(projectDir, wiId);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(projectDir, ["diff", "--name-only", "--diff-filter=U"]), "");
      assert.match(git(projectDir, ["stash", "list"]), /user stash/);
      assert.equal(git(projectDir, ["show", "main:feature.txt"]), "feature");
      assert.equal(branchExists(projectDir, "posse/wi-stale"), false);
      assert.equal(readWorkItem(projectDir, wiId).branch_name, null);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("dirty snapshot dedupe", () => {
  it("does not dedupe snapshots when an untracked file keeps the same name but changes content", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-snapshot-dedupe-"));
    try {
      initRepo(projectDir);
      const draftPath = path.join(projectDir, "draft.txt");
      fs.writeFileSync(draftPath, "first\n", "utf-8");
      const firstRef = preserveDirtyWorktreeSnapshot(projectDir, projectDir, {
        reason: "untracked-dedupe",
        wiId: 123,
      });

      fs.writeFileSync(draftPath, "second\n", "utf-8");
      const secondRef = preserveDirtyWorktreeSnapshot(projectDir, projectDir, {
        reason: "untracked-dedupe",
        wiId: 123,
      });

      assert.ok(firstRef);
      assert.ok(secondRef);
      assert.notEqual(String(secondRef), String(firstRef));
      assert.equal(git(projectDir, ["show", `${firstRef}^3:draft.txt`]), "first");
      assert.equal(git(projectDir, ["show", `${secondRef}^3:draft.txt`]), "second");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("dedupes identical async dirty snapshots", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-snapshot-async-dedupe-"));
    try {
      initRepo(projectDir);
      const draftPath = path.join(projectDir, "draft.txt");
      fs.writeFileSync(draftPath, "same\n", "utf-8");
      const firstRef = await snapshotAndResetDirtyWorktreeAsync(projectDir, projectDir, {
        reason: "async-untracked-dedupe",
        wiId: 124,
        nativeParity: { manager: fakeNativeResetManager() },
      });

      fs.writeFileSync(draftPath, "same\n", "utf-8");
      const secondRef = await snapshotAndResetDirtyWorktreeAsync(projectDir, projectDir, {
        reason: "async-untracked-dedupe",
        wiId: 124,
        nativeParity: { manager: fakeNativeResetManager() },
      });

      assert.ok(firstRef);
      assert.ok(secondRef);
      assert.equal(String(secondRef), String(firstRef));
      assert.equal(secondRef.metadata.reused, true);
      assert.equal(git(projectDir, ["show", `${firstRef}^3:draft.txt`]), "same");
      assert.equal(git(projectDir, ["status", "--porcelain"]), "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
