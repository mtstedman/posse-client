import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Repo, CommitScope, Worktree, SnapshotRef } from "../lib/domains/git/classes/index.js";
import { isGitReadOnlyArgs } from "../lib/domains/git/classes/Repo.js";
import { log } from "../lib/shared/telemetry/functions/logging/logger.js";
import { createWorkItem, setWorkItemBranch, updateWorkItemStatus } from "../lib/domains/queue/functions/index.js";
import { __testGitDiagnostics, gcWorktreesAsync, worktreeRoot } from "../lib/domains/git/functions/worktree.js";
import {
  __testReadLockMetadata,
  __testRemoveLockIfOwner,
  __testShouldReclaimWorktreeLock,
  acquireWorktreeLock,
  withWorktreeLock,
  worktreeLockPath,
} from "../lib/domains/git/functions/worktree-locks.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label = "condition") {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(5);
  }
}

function uniqueLockPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.lock`);
}

function writeLockFile(lockPath, metadata) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(metadata), "utf8");
  return fs.statSync(lockPath);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: "ignore" });
}

function deadPidCandidate() {
  for (const pid of [99_999_999, 9_999_999, 999_999, 99_999]) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === "ESRCH") return pid;
    }
  }
  return 99_999_999;
}

function fakeGitAsyncManagerWithHandlers(handlers, capture = {}) {
  return {
    shouldUse(name) {
      capture.shouldUse = name;
      return true;
    },
    binary(name) {
      capture.binary = name;
      return {
        runSync() {
          throw new Error("sync native git call was used");
        },
        async run(command, args, opts) {
          const envelope = JSON.parse(String(opts.input));
          const handler = handlers[command];
          assert.equal(typeof handler, "function", `missing fake handler for ${command}`);
          const data = await handler(envelope.payload, { command, args, opts, envelope });
          capture.calls = capture.calls || [];
          capture.calls.push({ command, payload: envelope.payload, opts });
          const json = { ok: true, data };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

function fakeGitSyncManagerWithHandlers(handlers, capture = {}) {
  return {
    shouldUse(name) {
      capture.shouldUse = name;
      return true;
    },
    binary(name) {
      capture.binary = name;
      return {
        run() {
          throw new Error("async native git call was used");
        },
        runSync(command, args, opts) {
          const envelope = JSON.parse(String(opts.input));
          const handler = handlers[command];
          assert.equal(typeof handler, "function", `missing fake handler for ${command}`);
          const data = handler(envelope.payload, { command, args, opts, envelope });
          capture.calls = capture.calls || [];
          capture.calls.push({ command, payload: envelope.payload, opts });
          const json = { ok: true, data };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

const NODE_GIT_PARITY_DISABLED = Object.freeze({ disabled: true });

describe("git domain class contract", () => {
  it("classifies git read-only argv structurally", () => {
    assert.equal(isGitReadOnlyArgs(["branch"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["branch", "--list", "posse/*"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["branch", "--merged", "main", "--list", "posse/*"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["branch", "-D", "posse/wi-1", "--list"], NODE_GIT_PARITY_DISABLED), false);
    assert.equal(isGitReadOnlyArgs(["branch", "posse/new-branch"], NODE_GIT_PARITY_DISABLED), false);

    assert.equal(isGitReadOnlyArgs(["config", "--get", "user.email"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["config", "--global", "--get", "user.email"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["config", "user.email", "new@example.test", "--get"], NODE_GIT_PARITY_DISABLED), false);
    assert.equal(isGitReadOnlyArgs(["config", "--unset", "user.email", "--get"], NODE_GIT_PARITY_DISABLED), false);

    assert.equal(isGitReadOnlyArgs(["-c", "core.quotePath=false", "diff", "--name-only"], NODE_GIT_PARITY_DISABLED), true);
    assert.equal(isGitReadOnlyArgs(["checkout", "main"], NODE_GIT_PARITY_DISABLED), false);
  });

  it("routes sync Repo read helpers through native git methods", () => {
    // Post-cutover the sync read helpers are native-only (no longer the injected
    // Node executor); verify they dispatch the right native method + payload.
    const capture = {};
    const manager = fakeGitSyncManagerWithHandlers({
      "git.currentHash": () => "abc123",
      "git.currentBranch": () => "feature/git-domain",
      "git.hasChanges": () => false,
      "git.isAncestor": () => true,
    }, capture);
    const repo = new Repo(".", { timeoutMs: 123 });

    assert.equal(Object.isFrozen(repo), true);
    assert.equal(repo.currentHash("HEAD", { manager }), "abc123");
    assert.equal(repo.currentBranch({ manager }), "feature/git-domain");
    assert.equal(repo.hasChanges([], { manager }), false);
    assert.equal(repo.isAncestor("base", "head", { manager }), true);
    assert.deepEqual(capture.calls.map((call) => call.command), [
      "git.currentHash",
      "git.currentBranch",
      "git.hasChanges",
      "git.isAncestor",
    ]);
    assert.deepEqual(capture.calls.map((call) => call.payload.cwd), [repo.cwd, repo.cwd, repo.cwd, repo.cwd]);
    assert.equal(capture.calls[0].payload.refName, "HEAD");
  });

  it("keeps generic mutating Repo.execAsync on the callback execFile, not execFileSync", async () => {
    // Regression guard: a name-shadowing bug once made the default execFileAsync
    // resolve to execFileSync, which causes every async git call to hang forever.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-repo-async-default-"));
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "T"], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "x"), "x");
      execFileSync("git", ["add", "x"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, stdio: "ignore" });

      const repo = new Repo(tmpDir);
      const addResult = await Promise.race([
        repo.execAsync(["add", "x"]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("execAsync hung (default execFileAsync is not the callback API)")), 3000)),
      ]);
      assert.equal(addResult, "");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes generic read-only Repo.execAsync through native git.exec", async () => {
    const capture = {};
    const controller = new AbortController();
    const manager = fakeGitAsyncManagerWithHandlers({
      "git.exec": () => ({ ok: true, status: 0, stdout: "M file.txt\n", stderr: "" }),
    }, capture);
    const repo = new Repo(".");

    assert.equal(
      await repo.execAsync(["status", "--porcelain"], {
        trim: false,
        signal: controller.signal,
        nativeParity: { manager },
      }),
      "M file.txt\n",
    );
    assert.deepEqual(capture.calls.map((call) => call.command), ["git.exec"]);
    assert.deepEqual(capture.calls[0].payload, {
      cwd: repo.cwd,
      args: ["status", "--porcelain"],
      input: null,
      trim: false,
      maxCaptureBytes: 1024 * 1024 * 16,
    });
    assert.equal(capture.calls[0].opts.signal, controller.signal);
  });

  it("preserves Repo.execAsync git failure details on native git.exec errors", async () => {
    const manager = fakeGitAsyncManagerWithHandlers({
      "git.exec": () => ({ ok: false, status: 128, stdout: "out", stderr: "fatal: no repo" }),
    });
    const repo = new Repo(".");

    await assert.rejects(
      () => repo.execAsync(["status", "--porcelain"], { nativeParity: { manager } }),
      (err) => {
        assert.equal(err.status, 128);
        assert.equal(err.code, 128);
        assert.equal(err.stdout, "out");
        assert.equal(err.stderr, "fatal: no repo");
        assert.match(err.message, /fatal: no repo/);
        return true;
      },
    );
  });

  it("routes async Repo helpers through native read methods", async () => {
    const capture = {};
    const manager = fakeGitAsyncManagerWithHandlers({
      "git.currentHash": () => "abc123",
      "git.currentBranch": () => "feature/async",
      "git.hasChanges": () => false,
      "git.isAncestor": () => true,
    }, capture);
    const repo = new Repo(".", { timeoutMs: 456 });

    assert.equal(await repo.currentHashAsync("HEAD", { nativeParity: { manager } }), "abc123");
    assert.equal(await repo.currentBranchAsync({ nativeParity: { manager } }), "feature/async");
    assert.equal(await repo.hasChangesAsync([], { nativeParity: { manager } }), false);
    assert.equal(await repo.isAncestorAsync("base", "head", { nativeParity: { manager } }), true);
    assert.deepEqual(capture.calls.map((call) => call.command), [
      "git.currentHash",
      "git.currentBranch",
      "git.hasChanges",
      "git.isAncestor",
    ]);
    assert.deepEqual(capture.calls.map((call) => call.payload.cwd), [
      repo.cwd,
      repo.cwd,
      repo.cwd,
      repo.cwd,
    ]);
  });

  it("logs unexpected git predicate failures while preserving fallback returns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-git-diagnostics-"));
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-git-diagnostics-nonrepo-"));
    const originalDebug = log.debug;
    const debugEntries = [];
    try {
      log.debug = (source, message, data) => {
        debugEntries.push({ source, message, data });
      };

      git(tmpDir, ["init", "-b", "main"]);
      git(tmpDir, ["config", "user.email", "t@t"]);
      git(tmpDir, ["config", "user.name", "T"]);
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "base\n", "utf8");
      git(tmpDir, ["add", "file.txt"]);
      git(tmpDir, ["commit", "-m", "base"]);
      git(tmpDir, ["switch", "-c", "topic"]);
      fs.writeFileSync(path.join(tmpDir, "topic.txt"), "topic\n", "utf8");
      git(tmpDir, ["add", "topic.txt"]);
      git(tmpDir, ["commit", "-m", "topic"]);
      git(tmpDir, ["switch", "main"]);
      fs.writeFileSync(path.join(tmpDir, "main.txt"), "main\n", "utf8");
      git(tmpDir, ["add", "main.txt"]);
      git(tmpDir, ["commit", "-m", "main"]);

      assert.equal(__testGitDiagnostics.branchIsAncestorOfTarget("topic", "main", tmpDir), false);
      assert.equal(debugEntries.length, 0);

      assert.equal(__testGitDiagnostics.branchIsAncestorOfTarget("missing-ref", "main", tmpDir), false);
      assert.equal(debugEntries.length, 1);
      assert.equal(debugEntries[0].source, "git");
      assert.match(debugEntries[0].message, /branch ancestor check failed/);
      assert.equal(debugEntries[0].data.branchName, "missing-ref");

      assert.equal(__testGitDiagnostics.gitTopLevel(nonRepoDir), path.resolve(nonRepoDir));
      assert.equal(debugEntries.length, 2);
      assert.match(debugEntries[1].message, /git top-level resolution failed/);
    } finally {
      log.debug = originalDebug;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });

  it("fails fast when sync Repo.exec would overlap an async git writer", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-repo-sync-gate-write-"));
    let releaseWriter = null;
    const execFileAsync = (bin, args, opts, done) => {
      releaseWriter = () => done(null, "", "");
      return { kill() {} };
    };
    const syncCalls = [];
    const writerRepo = new Repo(tmpDir, { execFileAsync, timeoutMs: 1000 });
    const syncRepo = new Repo(tmpDir, {
      execFile: (bin, args, opts) => {
        syncCalls.push({ bin, args, opts });
        return "";
      },
      timeoutMs: 1000,
    });
    const writer = writerRepo.execAsync(["add", "file.txt"]);
    try {
      await waitFor(() => releaseWriter, "async writer to own the git gate");
      assert.throws(
        () => syncRepo.exec(["status", "--porcelain"]),
        (err) => err?.code === "ASYNC_GATE_BUSY" && err?.mode === "non-blocking",
      );
      assert.deepEqual(syncCalls, []);
    } finally {
      if (releaseWriter) releaseWriter();
      await writer.catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails fast when sync Repo.exec would write during an async git reader", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-repo-sync-gate-read-"));
    let releaseReader = null;
    const manager = fakeGitAsyncManagerWithHandlers({
      "git.exec": () => new Promise((resolve) => {
        releaseReader = () => resolve({ ok: true, status: 0, stdout: "", stderr: "" });
      }),
    });
    const syncCalls = [];
    const readerRepo = new Repo(tmpDir, { timeoutMs: 1000 });
    const syncRepo = new Repo(tmpDir, {
      execFile: (bin, args, opts) => {
        syncCalls.push({ bin, args, opts });
        return "";
      },
      timeoutMs: 1000,
    });
    const reader = readerRepo.execAsync(["status", "--porcelain"], { nativeParity: { manager } });
    try {
      await waitFor(() => releaseReader, "async reader to own the git gate");
      assert.throws(
        () => syncRepo.exec(["add", "file.txt"]),
        (err) => err?.code === "ASYNC_GATE_BUSY" && err?.mode === "blocking",
      );
      assert.deepEqual(syncCalls, []);
    } finally {
      if (releaseReader) releaseReader();
      await reader.catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps Repo branch existence behind exec failures", () => {
    const execFile = () => {
      throw new Error("missing ref");
    };
    const repo = new Repo(".", { execFile });

    assert.equal(repo.branchExists("missing", NODE_GIT_PARITY_DISABLED), false);
  });

  it("keeps Worktree lifecycle commands behind Repo.exec", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-worktree-contract-"));
    const calls = [];
    const execFile = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("missing branch");
      return "";
    };
    const repo = new Repo(tmpDir, { execFile });
    const wtPath = path.join(tmpDir, "worktrees", "wi-1");
    const worktree = new Worktree(repo, wtPath, { branchName: "posse/wi-1" });

    assert.equal(Object.isFrozen(worktree), true);
    assert.equal(worktree.add(), wtPath);
    worktree.remove();

    assert.ok(calls.every((call) => call.bin === "git"));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["worktree", "add", "-b", "posse/wi-1", wtPath],
        ["worktree", "remove", wtPath, "--force"],
        ["worktree", "prune"],
        ["worktree", "prune"],
      ]
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retries Worktree.add without -b when the branch appears concurrently", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-worktree-race-contract-"));
    const calls = [];
    const execFile = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("missing branch");
      if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b") {
        const err = new Error("fatal: a branch named 'posse/wi-race' already exists");
        err.stderr = err.message;
        throw err;
      }
      return "";
    };
    const repo = new Repo(tmpDir, { execFile });
    const wtPath = path.join(tmpDir, "worktrees", "wi-race");
    const worktree = new Worktree(repo, wtPath, { branchName: "posse/wi-race" });

    assert.equal(worktree.add(), wtPath);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["worktree", "add", "-b", "posse/wi-race", wtPath],
        ["worktree", "add", wtPath, "posse/wi-race"],
      ]
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps async Worktree lifecycle commands behind native worktree methods", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-worktree-async-contract-"));
    try {
      const capture = {};
      const manager = fakeGitAsyncManagerWithHandlers({
        "git.worktree.add": (payload) => payload.wtPath,
        "git.worktree.remove": () => true,
        "git.worktree.prune": () => true,
      }, capture);
      const repo = new Repo(tmpDir);
      const wtPath = path.join(tmpDir, "worktrees", "wi-async");
      const worktree = new Worktree(repo, wtPath, { branchName: "posse/wi-async" });

      assert.equal(await worktree.addAsync({ nativeParity: { manager } }), wtPath);
      assert.equal(await worktree.removeAsync({ nativeParity: { manager } }), undefined);
      assert.equal(await worktree.pruneAsync({ nativeParity: { manager } }), "");

      assert.deepEqual(capture.calls.map((call) => call.command), [
        "git.worktree.add",
        "git.worktree.remove",
        "git.worktree.prune",
      ]);
      assert.deepEqual(capture.calls[0].payload, {
        mainCwd: repo.cwd,
        wtPath,
        branchName: "posse/wi-async",
        createBranch: null,
      });
      assert.deepEqual(capture.calls[1].payload, {
        mainCwd: repo.cwd,
        wtPath,
        force: true,
        prune: true,
        fallbackRemove: true,
      });
      assert.deepEqual(capture.calls[2].payload, { cwd: repo.cwd });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("delegates Worktree.addAsync branch-race fallback to native", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-worktree-race-async-contract-"));
    try {
      const capture = {};
      const manager = fakeGitAsyncManagerWithHandlers({
        "git.worktree.add": (payload) => payload.wtPath,
      }, capture);
      const repo = new Repo(tmpDir);
      const wtPath = path.join(tmpDir, "worktrees", "wi-race-async");
      const worktree = new Worktree(repo, wtPath, { branchName: "posse/wi-race-async" });

      assert.equal(await worktree.addAsync({ nativeParity: { manager } }), wtPath);
      assert.deepEqual(capture.calls.map((call) => call.command), ["git.worktree.add"]);
      assert.equal(capture.calls[0].payload.createBranch, null);
      assert.equal(capture.calls[0].payload.branchName, "posse/wi-race-async");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps SnapshotRef immutable, string-compatible, and validity-checkable", () => {
    const capture = {};
    const manager = fakeGitSyncManagerWithHandlers({ "git.snapshot.exists": () => true }, capture);
    const repo = new Repo(".");
    const ref = SnapshotRef.gitRef("refs/posse/snapshots/wi-1", {
      objectHash: "abc123",
      projectDir: repo.cwd,
      metadata: { reason: "test" },
    });

    assert.equal(Object.isFrozen(ref), true);
    assert.equal(Object.isFrozen(ref.metadata), true);
    assert.equal(`${ref}:file.txt`, "refs/posse/snapshots/wi-1:file.txt");
    assert.equal(JSON.stringify({ ref }), "{\"ref\":\"refs/posse/snapshots/wi-1\"}");
    assert.equal(ref.refName, "refs/posse/snapshots/wi-1");
    assert.equal(ref.snapshotPath, null);
    // exists() is native now (git.snapshot.exists), not the injected executor.
    assert.equal(ref.exists(repo, { manager }), true);
    assert.equal(capture.calls.at(-1).command, "git.snapshot.exists");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-snapshot-ref-"));
    const dirRef = SnapshotRef.directory(tmpDir);
    assert.equal(dirRef.snapshotPath, tmpDir);
    assert.equal(dirRef.refName, null);
    assert.equal(dirRef.exists(null, { manager }), true);
    assert.equal(dirRef.equals(SnapshotRef.directory(tmpDir)), true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes and freezes CommitScope payload-derived file and root scopes", () => {
    const scope = CommitScope.fromPayload({
      files_to_modify: ["src\\Feature.js", "./src/Feature.js"],
      files_to_create: ["docs/Plan.md"],
      files_to_delete: ["old.txt"],
      create_roots: [".", "assets/"],
      mappings: [
        { pattern: "*.png", dest: "public/images" },
        { pattern: "logo.svg", dest: "assets/logo.svg" },
      ],
    }, { nativeParity: NODE_GIT_PARITY_DISABLED });

    assert.equal(Object.isFrozen(scope), true);
    assert.equal(Object.isFrozen(scope.files), true);
    assert.equal(Object.isFrozen(scope.roots), true);
    assert.deepEqual(scope.files, [
      fold("src/Feature.js"),
      fold("docs/Plan.md"),
      "old.txt",
      "assets/logo.svg",
    ]);
    assert.deepEqual(scope.roots, ["*", "assets", "public/images"]);
    assert.equal(scope.hasScope(NODE_GIT_PARITY_DISABLED), true);
    assert.equal(scope.isWildcard(NODE_GIT_PARITY_DISABLED), true);
    assert.throws(() => scope.files.push("later.js"));
  });

  it("mirrors the scheduler write-lock conflict semantics", () => {
    const wildcard = CommitScope.wildcard({ nativeParity: NODE_GIT_PARITY_DISABLED });
    const assetsRoot = new CommitScope({ roots: ["assets"] });
    const nestedRoot = new CommitScope({ roots: ["assets/icons"] });
    const assetFile = new CommitScope({ files: ["assets/logo.svg"] });
    const otherFile = new CommitScope({ files: ["src/app.js"] });

    assert.equal(wildcard.conflictsWith(assetsRoot, NODE_GIT_PARITY_DISABLED), true);
    assert.equal(assetsRoot.conflictsWith(assetFile, NODE_GIT_PARITY_DISABLED), true);
    assert.equal(assetFile.conflictsWith(assetsRoot, NODE_GIT_PARITY_DISABLED), true);
    assert.equal(assetsRoot.conflictsWith(nestedRoot, NODE_GIT_PARITY_DISABLED), true);
    assert.equal(assetFile.conflictsWith(otherFile, NODE_GIT_PARITY_DISABLED), false);
    assert.equal(assetsRoot.containsFile("assets/icons/add.svg", NODE_GIT_PARITY_DISABLED), true);
  });

  it("exports stable JSON and lock row representations", () => {
    const cwd = path.resolve(".");
    const scope = new CommitScope({
      cwd,
      files: ["A.txt"],
      roots: ["dist"],
      unknown: true,
    });

    assert.deepEqual(scope.toJSON(), {
      files: [fold("A.txt")],
      roots: ["dist"],
      unknown: true,
    });
    assert.deepEqual(scope.toLockRows(NODE_GIT_PARITY_DISABLED), [
      { path: fold("A.txt"), lock_kind: "file" },
      { path: "dist", lock_kind: "root" },
    ]);
  });

  it("rejects string-form args so whitespace-splitting cannot reintroduce tainted-arg bugs", () => {
    const execFile = () => "ok\n";
    const repo = new Repo(".", { execFile });
    const stringArgs = "git rev-parse --show-toplevel";
    assert.throws(() => repo.exec(stringArgs), /argv array/);
    const checkoutArgs = "git checkout -- .";
    assert.throws(() => repo.exec(checkoutArgs), /argv array/);
    assert.equal(repo.exec(["rev-parse", "--show-toplevel"], { nativeParity: NODE_GIT_PARITY_DISABLED }), "ok");
  });

  it("does not reclaim a worktree lock held by another worker thread in the same process", async () => {
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const { once } = await import("node:events");
    const lockPath = path.join(os.tmpdir(), `posse-thread-lock-${Date.now()}-${Math.random().toString(16).slice(2)}.lock`);
    const moduleUrl = new URL("../lib/domains/git/functions/worktree-locks.js", import.meta.url).href;
    const worker = new NodeWorker(`
      import { parentPort, workerData } from "node:worker_threads";
      import { acquireWorktreeLockAsync } from ${JSON.stringify(moduleUrl)};
      const lock = await acquireWorktreeLockAsync(workerData.lockPath, { waitMs: 1000, staleMs: 120000 });
      parentPort.postMessage({ acquired: lock.acquired, ownerToken: lock.ownerToken, pid: process.pid });
      await new Promise((resolve) => parentPort.once("message", resolve));
      if (lock.acquired) await lock.releaseAsync();
    `, { eval: true, type: "module", workerData: { lockPath } });

    try {
      const [msg] = await once(worker, "message");
      assert.equal(msg.acquired, true);
      assert.ok(msg.ownerToken);

      const mainLock = acquireWorktreeLock(lockPath, { waitMs: 100, staleMs: 120000 });
      try {
        assert.equal(mainLock.acquired, false);
      } finally {
        if (mainLock.acquired) mainLock.release();
      }
      worker.postMessage("release");
      await once(worker, "exit");
    } finally {
      worker.terminate().catch(() => {});
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("does not let a stale owner release delete a newer worktree lock", async () => {
    const lockPath = path.join(os.tmpdir(), `posse-owner-lock-${Date.now()}-${Math.random().toString(16).slice(2)}.lock`);
    try {
      const first = acquireWorktreeLock(lockPath, { waitMs: 100 });
      assert.equal(first.acquired, true);
      fs.rmSync(lockPath, { force: true });

      const second = acquireWorktreeLock(lockPath, { waitMs: 100 });
      assert.equal(second.acquired, true);
      assert.notEqual(first.ownerToken, second.ownerToken);

      first.release();
      assert.equal(fs.existsSync(lockPath), true);
      second.release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("returns structured reclaim decisions for live, dead, missing, and malformed lock owners", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-lock-reclaim-contract-"));
    try {
      const livePath = path.join(dir, "live.lock");
      const liveStat = writeLockFile(livePath, {
        pid: process.pid,
        ownerToken: "live-owner",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      assert.equal(__testShouldReclaimWorktreeLock(livePath, { stat: liveStat, staleMs: 1 }), false);

      const deadPath = path.join(dir, "dead.lock");
      const deadStat = writeLockFile(deadPath, {
        pid: deadPidCandidate(),
        ownerToken: "dead-owner",
        createdAt: new Date().toISOString(),
      });
      const deadReclaim = __testShouldReclaimWorktreeLock(deadPath, { stat: deadStat, staleMs: 120_000 });
      assert.equal(deadReclaim.reclaim, true);
      assert.equal(deadReclaim.ownerToken, "dead-owner");
      assert.equal(deadReclaim.stat, deadStat);

      const missingPidPath = path.join(dir, "missing-pid.lock");
      const missingPidStat = writeLockFile(missingPidPath, {
        ownerToken: "missing-pid-owner",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const missingPidReclaim = __testShouldReclaimWorktreeLock(missingPidPath, { stat: missingPidStat, staleMs: 1 });
      assert.equal(missingPidReclaim.reclaim, true);
      assert.equal(missingPidReclaim.ownerToken, "missing-pid-owner");
      assert.equal(missingPidReclaim.stat, missingPidStat);

      const malformedPath = path.join(dir, "malformed.lock");
      fs.writeFileSync(malformedPath, "{not-json", "utf8");
      const oldDate = new Date(Date.now() - 60_000);
      fs.utimesSync(malformedPath, oldDate, oldDate);
      const malformedStat = fs.statSync(malformedPath);
      const malformedReclaim = __testShouldReclaimWorktreeLock(malformedPath, { stat: malformedStat, staleMs: 1 });
      assert.equal(malformedReclaim.reclaim, true);
      assert.equal(malformedReclaim.ownerToken, null);
      assert.equal(malformedReclaim.stat, malformedStat);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ages out stale worktree locks whose recycled pid still looks alive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-lock-recycled-pid-"));
    try {
      const ownerPid = deadPidCandidate();
      assert.notEqual(ownerPid, process.pid);

      const recentPath = path.join(dir, "recent-recycled.lock");
      const recentStat = writeLockFile(recentPath, {
        pid: ownerPid,
        ownerToken: "recent-recycled-owner",
        createdAt: new Date(Date.now() - 5_000).toISOString(),
      });
      assert.equal(
        __testShouldReclaimWorktreeLock(recentPath, {
          stat: recentStat,
          staleMs: 1_000,
          isProcessAliveFn: () => true,
        }),
        false,
      );

      const stalePath = path.join(dir, "stale-recycled.lock");
      const staleStat = writeLockFile(stalePath, {
        pid: ownerPid,
        ownerToken: "stale-recycled-owner",
        createdAt: new Date(Date.now() - 15_000).toISOString(),
      });
      const staleReclaim = __testShouldReclaimWorktreeLock(stalePath, {
        stat: staleStat,
        staleMs: 1_000,
        isProcessAliveFn: () => true,
      });
      assert.equal(staleReclaim.reclaim, true);
      assert.equal(staleReclaim.ownerToken, "stale-recycled-owner");
      assert.equal(staleReclaim.stat, staleStat);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startup GC skips worktree paths that disappear between readdir and stat", () => withTempRuntimeDb(async (runtimeRoot) => {
    const projectDir = path.join(runtimeRoot, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    git(projectDir, ["init", "-b", "main"]);
    git(projectDir, ["config", "user.email", "posse-test@example.com"]);
    git(projectDir, ["config", "user.name", "Posse Test"]);
    fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf8");
    git(projectDir, ["add", "tracked.txt"]);
    git(projectDir, ["commit", "-m", "init"]);

    const originalReaddir = fs.promises.readdir;
    const originalStat = fs.promises.stat;
    try {
      const wi = createWorkItem("startup gc raced stat", "desc");
      const branchName = `posse/wi-${wi.id}-after-raced-stat`;
      setWorkItemBranch(wi.id, branchName, "deadbeef");
      updateWorkItemStatus(wi.id, "complete");

      const root = worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED);
      const racedEntry = "wi-0-raced-stat";
      const racedDir = path.join(root, racedEntry);
      const wtDir = path.join(root, `wi-${wi.id}-after-raced-stat`);
      fs.mkdirSync(racedDir, { recursive: true });
      git(projectDir, ["worktree", "add", "-b", branchName, wtDir]);

      fs.promises.readdir = async function patchedReaddir(target, ...args) {
        if (path.resolve(String(target)) === path.resolve(root)) {
          return [racedEntry, path.basename(wtDir)];
        }
        return originalReaddir.call(this, target, ...args);
      };
      fs.promises.stat = async function patchedStat(target, ...args) {
        if (path.resolve(String(target)) === path.resolve(racedDir)) {
          fs.rmSync(racedDir, { recursive: true, force: true });
          const err = new Error("ENOENT: no such file or directory, stat");
          err.code = "ENOENT";
          throw err;
        }
        return originalStat.call(this, target, ...args);
      };

      await assert.doesNotReject(() => gcWorktreesAsync(projectDir));
      assert.equal(fs.existsSync(wtDir), false);
    } finally {
      fs.promises.readdir = originalReaddir;
      fs.promises.stat = originalStat;
    }
  }));

  it("refuses owner-token mismatches even when unowned stale lock removal is allowed", () => {
    const lockPath = uniqueLockPath("posse-lock-owner-token");
    try {
      const stat = writeLockFile(lockPath, {
        pid: deadPidCandidate(),
        ownerToken: "owner-a",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      assert.equal(__testRemoveLockIfOwner(lockPath, "owner-b", { allowUnowned: true, expectedStat: stat }), false);
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("writes owner metadata when acquiring a worktree lock and removes it on release", () => {
    const lockPath = uniqueLockPath("posse-lock-roundtrip");
    try {
      const lock = acquireWorktreeLock(lockPath, { waitMs: 100 });
      assert.equal(lock.acquired, true);
      const metadata = __testReadLockMetadata(lockPath);
      assert.equal(metadata.pid, process.pid);
      assert.equal(metadata.ownerToken, lock.ownerToken);

      assert.equal(lock.release(), true);
      assert.equal(lock.isReleased, true);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("releases a worktree lock when the protected callback throws", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-lock-wrapper-contract-"));
    const wtPath = path.join(projectDir, "worktree");
    fs.mkdirSync(wtPath, { recursive: true });
    const lockPath = worktreeLockPath(wtPath, projectDir, NODE_GIT_PARITY_DISABLED);
    try {
      assert.throws(
        () => withWorktreeLock(wtPath, projectDir, () => {
          throw new Error("inner failure");
        }, { waitMs: 100 }),
        /inner failure/
      );
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
