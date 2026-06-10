import {
  it,
  before,
  beforeEach,
  assert,
  fs,
  os,
  path,
  execFileSync,
  __dirname,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
  buildCleanupInventory,
  cleanupInventoryIsEmpty,
  cleanupInventorySummary,
  buildCleanupItemIndex,
  cleanupDeterministicFallback,
  applyCleanupAction,
  discardCleanupSnapshot,
  discardCleanupWorktree,
} from "../support/core-harness.js";

let db;

suite("Cleanup triage", () => {
  const buildInventory = buildCleanupInventory;
  const inventoryIsEmpty = cleanupInventoryIsEmpty;
  const inventorySummary = cleanupInventorySummary;
  const buildItemIndex = buildCleanupItemIndex;
  const deterministicFallback = cleanupDeterministicFallback;
  const applyAction = applyCleanupAction;
  const discardSnapshot = discardCleanupSnapshot;
  const discardWorktree = discardCleanupWorktree;

  beforeEach(() => { resetRuntimeDb(); });

  function makeScratchRepo() {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "root\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    return repoDir;
  }

  function cleanupBranchExists(repoDir, branchName) {
    const raw = execFileSync("git", ["branch", "--list", branchName], { cwd: repoDir, encoding: "utf-8" }).trim();
    return raw.length > 0;
  }

  function seedSnapshot(repoDir, { wiId, ageMs = 1000, reason = "test" }) {
    const root = path.join(repoDir, ".posse", "recovered-worktrees");
    const id = `wi-${wiId}-${reason}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "status.txt"), "dirty\n");
    fs.writeFileSync(path.join(dir, "diff.patch"), "");
    fs.writeFileSync(path.join(dir, "files", "leftover.txt"), "payload\n");
    const capturedAt = new Date(Date.now() - ageMs).toISOString();
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      work_item_id: wiId,
      reason,
      branch_name: `posse/wi-${wiId}`,
      captured_at: capturedAt,
      tracked_dirty: ["a.txt"],
      untracked: ["b.txt"],
    }));
    return { id, dir };
  }

  it("refuses destructive branch cleanup while a work item has active jobs", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Active cleanup guard", "desc");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "running cleanup guard" });
    queueMod.updateJobStatus(job.id, "running");

    assert.throws(() => applyAction({
      kind: "branch",
      action: "discard",
      projectDir: path.resolve(__dirname, ".."),
      payload: {
        wiId: wi.id,
        wiStatus: "running",
        name: `posse/wi-${wi.id}-cleanup-guard`,
      },
    }), /WI#\d+ is running|active job/i);
  });

  it("survey inventories snapshots, branches, worktrees, main-tree dirt, and stashes", () => {
    const repoDir = makeScratchRepo();
    try {
      // Create stash first — -u pulls in untracked files, so we seed snapshots
      // and orphan worktree dirs AFTER stashing.
      fs.writeFileSync(path.join(repoDir, "stashed.txt"), "stashable\n");
      execFileSync("git", ["add", "stashed.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["stash", "push", "-u", "-m", "posse: legacy-stash"], { cwd: repoDir, stdio: "ignore" });

      seedSnapshot(repoDir, { wiId: 7, ageMs: 10 * 24 * 3600 * 1000 });
      execFileSync("git", ["branch", "posse/wi-7-test"], { cwd: repoDir, stdio: "ignore" });

      fs.mkdirSync(path.join(repoDir, ".posse-worktrees"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".posse-worktrees", "wi-999-orphan"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".posse-worktrees", "wi-999-orphan", ".git"), "gitdir: /missing/posse-test-worktree\n");

      fs.writeFileSync(path.join(repoDir, "dirty.txt"), "uncommitted\n");

      const inv = buildInventory(repoDir, "main");
      assert.equal(inv.snapshots.length, 1);
      assert.equal(inv.snapshots[0].wiId, 7);
      assert.ok(inv.snapshots[0].ageMs >= 10 * 24 * 3600 * 1000 - 1000);

      assert.equal(inv.branches.length, 1);
      assert.equal(inv.branches[0].name, "posse/wi-7-test");

      assert.equal(inv.worktrees.length, 1);
      assert.equal(inv.worktrees[0].wiId, 999);
      assert.equal(inv.worktrees[0].wiMissing, true);
      assert.equal(inv.worktrees[0].statusUnknown, true);
      assert.equal(inv.worktrees[0].hasChanges, true);

      assert.equal(inv.mainTreeDirt.dirty, true);
      assert.ok(inv.mainTreeDirt.fileCount >= 1);

      assert.equal(inv.stashes.length, 1);
      assert.match(inv.stashes[0].label, /posse: legacy-stash/);

      assert.equal(inventoryIsEmpty(inv), false);
      const summary = inventorySummary(inv);
      assert.equal(summary.snapshots, 1);
      assert.equal(summary.branches, 1);
      assert.equal(summary.stashes, 1);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("deterministic fallback classifies old snapshots as safe-discard and orphan worktrees", () => {
    const items = [
      { key: "snapshot:old", kind: "snapshot", payload: { id: "old", path: "/x", ageMs: 30 * 24 * 3600 * 1000, ageHuman: "30d", reason: "t", branchName: null, wiId: null, trackedCount: 0, untrackedCount: 0, sizeBytes: 0 } },
      { key: "snapshot:new", kind: "snapshot", payload: { id: "new", path: "/y", ageMs: 60 * 60 * 1000, ageHuman: "1h", reason: "t", branchName: null, wiId: null, trackedCount: 0, untrackedCount: 0, sizeBytes: 0 } },
      { key: "worktree:orphan-clean", kind: "worktree", payload: { path: "/a", wiId: 1, wiStatus: null, wiMissing: true, wiTerminal: false, hasChanges: false, ageMs: 1000, ageHuman: "1s" } },
      { key: "worktree:orphan-dirty", kind: "worktree", payload: { path: "/b", wiId: 2, wiStatus: null, wiMissing: true, wiTerminal: false, hasChanges: true, ageMs: 1000, ageHuman: "1s" } },
      { key: "worktree:unknown", kind: "worktree", payload: { path: "/c", wiId: 4, wiStatus: null, wiMissing: true, wiTerminal: false, hasChanges: false, statusUnknown: true, ageMs: 1000, ageHuman: "1s" } },
      { key: "branch:merged", kind: "branch", payload: { name: "posse/wi-3", wiId: 3, wiStatus: "complete", mergeState: "merged", mergedToTarget: true, lastCommitAt: null, ageMs: null, ageHuman: null } },
    ];
    const cls = deterministicFallback(items);
    assert.equal(cls["snapshot:old"].tier, "safe-discard");
    assert.equal(cls["snapshot:new"].tier, "investigate");
    assert.equal(cls["worktree:orphan-clean"].tier, "safe-discard");
    assert.equal(cls["worktree:orphan-dirty"].tier, "restore-suggested");
    assert.equal(cls["worktree:unknown"].tier, "investigate");
    assert.equal(cls["branch:merged"].tier, "safe-discard");
  });

  it("buildItemIndex emits unique keys across all kinds", () => {
    const inv = {
      projectDir: ".", targetBranch: "main", capturedAt: "",
      snapshots: [{ id: "a", path: "", ageMs: 0, ageHuman: "", reason: "", branchName: null, wiId: null, trackedCount: 0, untrackedCount: 0, sizeBytes: 0 }],
      branches: [{ name: "posse/wi-1", wiId: 1, wiStatus: null, mergeState: null, mergedToTarget: false, lastCommitAt: null, ageMs: null, ageHuman: null }],
      worktrees: [{ path: "/w", wiId: 1, wiStatus: null, wiMissing: true, wiTerminal: false, hasChanges: false, ageMs: null, ageHuman: null }],
      mainTreeDirt: { dirty: true, fileCount: 1, files: ["x"] },
      stashes: [{ ref: "stash@{0}", label: "posse: x", posseLabeled: true }],
    };
    const items = buildItemIndex(inv);
    assert.equal(items.length, 5);
    const keys = new Set(items.map((i) => i.key));
    assert.equal(keys.size, 5);
  });

  it("discardSnapshot removes the directory on disk", () => {
    const repoDir = makeScratchRepo();
    try {
      const { dir } = seedSnapshot(repoDir, { wiId: 42 });
      assert.equal(fs.existsSync(dir), true);
      const result = discardSnapshot({ id: "x", path: dir, reason: "test", wiId: 42 }, repoDir);
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(dir), false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("applyAction routes snapshot:discard via the unified entry point", () => {
    const repoDir = makeScratchRepo();
    try {
      const { dir } = seedSnapshot(repoDir, { wiId: 100 });
      const result = applyAction({
        kind: "snapshot",
        payload: { id: "x", path: dir, reason: "test", wiId: 100 },
        action: "discard",
        projectDir: repoDir,
      });
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(dir), false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("refuses to discard forged git snapshot refs outside the snapshot namespace", () => {
    const repoDir = makeScratchRepo();
    try {
      execFileSync("git", ["branch", "do-not-delete"], { cwd: repoDir, stdio: "ignore" });
      assert.equal(cleanupBranchExists(repoDir, "do-not-delete"), true);

      assert.throws(() => applyAction({
        kind: "snapshot",
        payload: {
          id: "forged",
          storageType: "git-ref",
          refName: "refs/heads/do-not-delete",
          reason: "forged",
        },
        action: "discard",
        projectDir: repoDir,
      }), /outside snapshot namespace/i);

      assert.equal(cleanupBranchExists(repoDir, "do-not-delete"), true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("refuses to discard directory snapshots outside the managed recovery root", () => {
    const repoDir = makeScratchRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-snapshot-outside-"));
    try {
      assert.throws(() => {
        discardSnapshot({ id: "x", path: outsideDir, reason: "test", wiId: 101 }, repoDir);
      }, /outside managed recovery root/i);
      assert.equal(fs.existsSync(outsideDir), true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("refuses to apply directory snapshot diffs outside the managed recovery root", () => {
    const repoDir = makeScratchRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-diff-outside-"));
    try {
      fs.writeFileSync(path.join(repoDir, "README.md"), "owned\n", "utf-8");
      const patch = execFileSync("git", ["diff", "--", "README.md"], { cwd: repoDir, encoding: "utf-8" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "root\n", "utf-8");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" }).trim(), "");

      fs.writeFileSync(path.join(outsideDir, "manifest.json"), JSON.stringify({}));
      fs.writeFileSync(path.join(outsideDir, "staged.patch"), "");
      fs.writeFileSync(path.join(outsideDir, "diff.patch"), patch);

      assert.throws(() => applyAction({
        kind: "snapshot",
        payload: {
          id: "forged-diff",
          storageType: "directory",
          path: outsideDir,
          reason: "forged",
        },
        action: "apply-diff",
        projectDir: repoDir,
      }), /outside managed recovery root/i);

      assert.equal(fs.readFileSync(path.join(repoDir, "README.md"), "utf-8"), "root\n");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" }).trim(), "");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("guards directory snapshot restore sources and targets", () => {
    const repoDir = makeScratchRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-restore-outside-"));
    try {
      const { dir } = seedSnapshot(repoDir, { wiId: 101 });
      const restoreDir = path.join(repoDir, ".posse", "restored-snapshots");
      fs.mkdirSync(restoreDir, { recursive: true });

      assert.throws(() => applyAction({
        kind: "snapshot",
        payload: { id: "../escape", storageType: "directory", path: dir, reason: "test", wiId: 101 },
        action: "restore",
        projectDir: repoDir,
        restoreDir,
      }), /restore target outside/i);
      assert.equal(fs.existsSync(path.join(repoDir, ".posse", "escape")), false);

      assert.throws(() => applyAction({
        kind: "snapshot",
        payload: { id: "outside", storageType: "directory", path: outsideDir, reason: "test", wiId: 102 },
        action: "restore",
        projectDir: repoDir,
        restoreDir,
      }), /outside managed recovery root/i);
      assert.equal(fs.existsSync(path.join(restoreDir, "outside")), false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("refuses raw worktree removal outside the managed worktree root", () => {
    const repoDir = makeScratchRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cleanup-outside-"));
    try {
      assert.throws(() => {
        discardWorktree({ path: outsideDir, wiId: 123, wiStatus: null, hasChanges: false }, repoDir);
      }, /refusing to remove worktree outside/i);
      assert.equal(fs.existsSync(outsideDir), true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("applyAction preserves branch tips before discarding unmerged branches", () => {
    const repoDir = makeScratchRepo();
    try {
      const branchName = "posse/wi-101-cleanup-discard";
      execFileSync("git", ["checkout", "-b", branchName], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n", "utf-8");
      execFileSync("git", ["add", "feature.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

      const result = applyAction({
        kind: "branch",
        payload: { name: branchName, wiId: 101, mergedToTarget: false, targetBranch: "main" },
        action: "discard",
        projectDir: repoDir,
      });

      assert.equal(result.ok, true);
      assert.ok(result.snapshotRef);
      assert.equal(cleanupBranchExists(repoDir, branchName), false);
      assert.equal(execFileSync("git", ["show", `${result.snapshotRef}:feature.txt`], { cwd: repoDir, encoding: "utf-8" }), "feature\n");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("cleanup restore creates a recovery branch for branch-tip snapshots", () => {
    const repoDir = makeScratchRepo();
    try {
      const branchName = "posse/wi-102-branch-snapshot";
      execFileSync("git", ["checkout", "-b", branchName], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n", "utf-8");
      execFileSync("git", ["add", "feature.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir, stdio: "ignore" });
      const branchHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

      const refName = "refs/posse/snapshots/wi-102-cleanup-branch-ref-test";
      execFileSync("git", ["update-ref", refName, branchHash], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["notes", "--ref=refs/notes/posse-snapshots", "add", "-f", "-m", JSON.stringify({
        storage: "branch-ref",
        ref_name: refName,
        object_hash: branchHash,
        branch_name: branchName,
        work_item_id: 102,
        reason: "cleanup-branch-discard",
        captured_at: new Date().toISOString(),
        head_sha: branchHash,
      }), branchHash], { cwd: repoDir, stdio: "ignore" });

      const inv = buildInventory(repoDir, "main");
      const snapshot = inv.snapshots.find((item) => item.refName === refName);
      assert.equal(snapshot.storageType, "branch-ref");

      const result = applyAction({
        kind: "snapshot",
        payload: snapshot,
        action: "restore",
        projectDir: repoDir,
      });

      assert.equal(result.ok, true);
      assert.match(result.branch, /^posse\/recovery\//);
      assert.equal(execFileSync("git", ["show", `${result.branch}:feature.txt`], { cwd: repoDir, encoding: "utf-8" }), "feature\n");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("applyAction returns skipped result for unsupported combinations", () => {
    const result = applyAction({
      kind: "main_tree",
      payload: { dirty: true, fileCount: 1, files: [] },
      action: "discard",
      projectDir: ".",
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  });
});
