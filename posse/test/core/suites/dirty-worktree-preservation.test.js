import {
  it,
  before,
  beforeEach,
  after,
  assert,
  fs,
  os,
  path,
  execFileSync,
  spawnSync,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  disableAtlasForRun,
  withEnv,
  gitCommitAll,
} from "../support/core-harness.js";
import {
  __testGitCommitTimeoutBudget,
  gitCommitAllAsync,
} from "../../../lib/domains/git/functions/commit-scope.js";

let db;

suite("Dirty worktree preservation", () => {
  beforeEach(() => {
    resetRuntimeDb();
    disableAtlasForRun("dirty-worktree-preservation tests");
  });

  function listSnapshotRefsMatching(repoDir, substring) {
    let raw = "";
    try {
      raw = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/posse/snapshots"], { cwd: repoDir, encoding: "utf-8" });
    } catch {
      return [];
    }
    return raw.split("\n").map((s) => s.trim()).filter((s) => s && s.includes(substring));
  }

  function branchExists(repoDir, branchName) {
    const raw = execFileSync("git", ["branch", "--list", branchName], { cwd: repoDir, encoding: "utf-8" }).trim();
    return raw.length > 0;
  }

  function readSnapshotManifest(repoDir, refName) {
    const objectHash = execFileSync("git", ["rev-parse", refName], { cwd: repoDir, encoding: "utf-8" }).trim();
    const noteRaw = execFileSync("git", ["notes", "--ref=refs/notes/posse-snapshots", "show", objectHash], { cwd: repoDir, encoding: "utf-8" });
    return { objectHash, note: JSON.parse(noteRaw) };
  }

  function readSnapshotFile(repoDir, refName, filePath) {
    try {
      return execFileSync("git", ["show", `${refName}:${filePath}`], { cwd: repoDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return execFileSync("git", ["show", `${refName}^3:${filePath}`], { cwd: repoDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    }
  }

  function makeGitRepo(prefix) {
    const projectDir = fs.mkdtempSync(path.join(__dirname, prefix));
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
    fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
    return projectDir;
  }

  function fakeSnapshotNativeManager() {
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
            const payload = envelope.payload || {};
            let data;
            if (command === "git.snapshot.writeNote") {
              execFileSync("git", [
                "notes",
                "--ref=refs/notes/posse-snapshots",
                "add",
                "-f",
                "-m",
                JSON.stringify(payload.note),
                payload.objectHash,
              ], { cwd: payload.projectDir, stdio: "ignore" });
              data = true;
            } else if (command === "git.snapshot.listRefs") {
              let raw = "";
              try {
                raw = execFileSync("git", [
                  "for-each-ref",
                  "--format=%(refname)|%(objectname)|%(creatordate:unix)",
                  "refs/posse/snapshots",
                ], { cwd: payload.projectDir, encoding: "utf-8" });
              } catch {
                raw = "";
              }
              data = raw
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [refName, objectHash, createdUnix] = line.split("|");
                  let note = null;
                  try {
                    note = JSON.parse(execFileSync("git", [
                      "notes",
                      "--ref=refs/notes/posse-snapshots",
                      "show",
                      objectHash,
                    ], { cwd: payload.projectDir, encoding: "utf-8" }));
                  } catch {
                    note = null;
                  }
                  const noteMs = note?.captured_at ? Date.parse(note.captured_at) : NaN;
                  const fallbackMs = Number(createdUnix) * 1000;
                  return {
                    refName,
                    objectHash,
                    createdMs: Number.isFinite(noteMs) && noteMs > 0
                      ? noteMs
                      : (Number.isFinite(fallbackMs) ? fallbackMs : 0),
                  };
                })
                .sort((a, b) => a.createdMs - b.createdMs);
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

  it("replaces a canonical worktree that is checked out on the wrong branch", async () => {
    const { gitWorktreeAdd, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = makeGitRepo("tmp-worktree-wrong-branch-");
    try {
      const wtDir = path.join(worktreeRoot(projectDir), "wi-44");
      const expectedBranch = "posse/wi-44-expected";
      const wrongBranch = "posse/wi-44-wrong";
      execFileSync("git", ["branch", expectedBranch], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["worktree", "add", "-b", wrongBranch, wtDir], { cwd: projectDir, stdio: "ignore" });
      assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: wtDir, encoding: "utf-8" }).trim(), wrongBranch);

      let mismatch = null;
      gitWorktreeAdd(wtDir, expectedBranch, projectDir, {
        wiId: 44,
        onBranchMismatch: (info) => { mismatch = info; },
      });

      assert.deepEqual({ expected: mismatch?.expected, actual: mismatch?.actual }, { expected: expectedBranch, actual: wrongBranch });
      assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: wtDir, encoding: "utf-8" }).trim(), expectedBranch);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refreshes a reused worktree when its branch ref has advanced", async () => {
    const { gitWorktreeAdd, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = makeGitRepo("tmp-worktree-stale-head-");
    try {
      const wtDir = path.join(worktreeRoot(projectDir), "wi-45");
      const branchName = "posse/wi-45-stale";
      execFileSync("git", ["branch", branchName], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["worktree", "add", wtDir, branchName], { cwd: projectDir, stdio: "ignore" });
      assert.equal(fs.readFileSync(path.join(wtDir, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"), "base\n");

      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "advanced\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "advance main"], { cwd: projectDir, stdio: "ignore" });
      const advancedHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      execFileSync("git", ["update-ref", `refs/heads/${branchName}`, advancedHash], { cwd: projectDir, stdio: "ignore" });

      gitWorktreeAdd(wtDir, branchName, projectDir, { wiId: 45 });

      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim(), advancedHash);
      assert.equal(fs.readFileSync(path.join(wtDir, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"), "advanced\n");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: wtDir, encoding: "utf-8" }).trim(), "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("clears stale active-worktree sentinels even when the job id differs", async () => {
    const {
      clearActiveWorktreeSentinel,
      readActiveWorktreeSentinel,
      writeActiveWorktreeSentinel,
    } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-stale-sentinel-"));
    try {
      writeActiveWorktreeSentinel(tmpDir, { pid: 99999999, jobId: 123, wiId: 1 });
      assert.ok(readActiveWorktreeSentinel(tmpDir));
      assert.equal(clearActiveWorktreeSentinel(tmpDir, { jobId: 456 }), true);
      assert.equal(readActiveWorktreeSentinel(tmpDir), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recreates a missing DB-backed WI branch and refreshes its merge base", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-missing-branch-");
    try {
      const expectedBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      const wi = queueMod.createWorkItem("Missing branch recreate", "desc");
      const branchName = `posse/wi-${wi.id}-missing`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
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
      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, job, "lease-token");
      const refreshed = queueMod.getWorkItem(wi.id);

      assert.equal(result.ok, true);
      assert.equal(result.branchName, branchName);
      assert.equal(refreshed.branch_name, branchName);
      assert.equal(refreshed.merge_base_hash, expectedBase);
      assert.match(execFileSync("git", ["branch", "--show-current"], { cwd: result.wtPath, encoding: "utf-8" }).trim(), new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(events.some((message) => message.includes("recreated missing branch")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("tolerates reused-worktree untracked residuals outside the current job scope", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { EVENT_TYPES } = await import("../../../lib/catalog/event.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-untracked-residual-");
    try {
      const wi = queueMod.createWorkItem("Residual setup guard", "desc");
      const branchName = `posse/wi-${wi.id}-residual`;
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      queueMod.setWorkItemBranch(wi.id, branchName, base);
      execFileSync("git", ["branch", branchName], { cwd: projectDir, stdio: "ignore" });
      const wtDir = path.join(worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", wtDir, branchName], { cwd: projectDir, stdio: "ignore" });
      fs.mkdirSync(path.join(wtDir, "coverage"), { recursive: true });
      fs.writeFileSync(path.join(wtDir, "coverage", "report.txt"), "generated\n", "utf-8");

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
      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, job, "lease-token");

      assert.equal(result.ok, true, JSON.stringify({ result, events }));
      assert.equal(fs.readFileSync(path.join(wtDir, "coverage", "report.txt"), "utf-8"), "generated\n");
      assert.deepEqual(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: wtDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean), ["?? coverage/report.txt"]);
      assert.equal(listSnapshotRefsMatching(projectDir, "reused-dirty-worktree").length, 0);
      assert.equal(listSnapshotRefsMatching(projectDir, `dirty-worktree-setup-wi-${wi.id}-job-${job.id}`).length, 0);
      assert.equal(events.some((message) => message.includes("out-of-scope untracked residual")), true);
      assert.equal(queueMod.getEvents(null, 100).some((event) =>
        event.work_item_id === wi.id
        && event.job_id === job.id
        && event.event_type === EVENT_TYPES.WORKTREE_UNTRACKED_RESIDUAL_TOLERATED
      ), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("defers setup before mutating a shared worktree when a same-WI sibling is live", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-live-sibling-");
    try {
      const wi = queueMod.createWorkItem("Live sibling setup guard", "desc");
      const expectedBranch = `posse/wi-${wi.id}-expected`;
      const wrongBranch = `posse/wi-${wi.id}-wrong`;
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      queueMod.setWorkItemBranch(wi.id, expectedBranch, base);
      execFileSync("git", ["branch", expectedBranch], { cwd: projectDir, stdio: "ignore" });
      const wtDir = path.join(worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", wrongBranch, wtDir], { cwd: projectDir, stdio: "ignore" });

      const sibling = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "active sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["sibling.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const current = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "current sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["current.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const siblingLease = queueMod.acquireLeaseWithWriteLocks(sibling, "sibling-worker", 60);
      assert.ok(siblingLease?.leaseToken);
      const currentLease = queueMod.acquireLeaseWithWriteLocks(queueMod.getJob(current.id), "current-worker", 60);
      assert.ok(currentLease?.leaseToken);

      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _releaseWithoutAttemptPenalty: (job, leaseToken, status, opts) =>
          queueMod.releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, status, opts),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, queueMod.getJob(current.id), currentLease.leaseToken);

      assert.equal(result.ok, false);
      assert.equal(queueMod.getJob(current.id).status, "queued");
      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: wtDir, encoding: "utf-8" }).trim(), wrongBranch);
      assert.ok(events.some((message) => message.includes("worktree setup deferred")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("allows clean disjoint same-WI siblings to set up concurrently", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-concurrent-clean-");
    let wtDir = null;
    try {
      fs.writeFileSync(path.join(projectDir, "sibling.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "current.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "sibling.txt", "current.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add scoped files"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("Concurrent setup clean", "desc");
      const branchName = `posse/wi-${wi.id}-concurrent-clean`;
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      queueMod.setWorkItemBranch(wi.id, branchName, base);
      execFileSync("git", ["branch", branchName], { cwd: projectDir, stdio: "ignore" });
      wtDir = path.join(worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", wtDir, branchName], { cwd: projectDir, stdio: "ignore" });

      const sibling = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "active sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["sibling.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const current = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "current sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["current.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const siblingLease = queueMod.acquireLeaseWithWriteLocks(sibling, "sibling-worker", 60);
      assert.ok(siblingLease?.leaseToken);
      const currentLease = queueMod.acquireLeaseWithWriteLocks(queueMod.getJob(current.id), "current-worker", 60);
      assert.ok(currentLease?.leaseToken);

      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _releaseWithoutAttemptPenalty: (job, leaseToken, status, opts) =>
          queueMod.releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, status, opts),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, queueMod.getJob(current.id), currentLease.leaseToken);

      assert.equal(result.ok, true);
      assert.equal(queueMod.getJob(current.id).status, "leased");
      assert.equal(events.some((message) => message.includes("worktree setup deferred")), false);
    } finally {
      if (wtDir) {
        try { execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      }
      try { execFileSync("git", ["worktree", "prune"], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("allows disjoint same-WI setup when dirt is owned by a live sibling lock", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-concurrent-sibling-dirty-");
    let wtDir = null;
    try {
      fs.writeFileSync(path.join(projectDir, "sibling.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "current.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "sibling.txt", "current.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add scoped files"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("Concurrent setup sibling dirt", "desc");
      const branchName = `posse/wi-${wi.id}-concurrent-sibling-dirty`;
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      queueMod.setWorkItemBranch(wi.id, branchName, base);
      execFileSync("git", ["branch", branchName], { cwd: projectDir, stdio: "ignore" });
      wtDir = path.join(worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", wtDir, branchName], { cwd: projectDir, stdio: "ignore" });

      const sibling = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "active sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["sibling.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const current = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "current sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["current.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const siblingLease = queueMod.acquireLeaseWithWriteLocks(sibling, "sibling-worker", 60);
      assert.ok(siblingLease?.leaseToken);
      const currentLease = queueMod.acquireLeaseWithWriteLocks(queueMod.getJob(current.id), "current-worker", 60);
      assert.ok(currentLease?.leaseToken);
      fs.writeFileSync(path.join(wtDir, "sibling.txt"), "sibling edit\n", "utf-8");

      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _releaseWithoutAttemptPenalty: (job, leaseToken, status, opts) =>
          queueMod.releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, status, opts),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, queueMod.getJob(current.id), currentLease.leaseToken);

      assert.equal(result.ok, true);
      assert.equal(queueMod.getJob(current.id).status, "leased");
      assert.equal(fs.readFileSync(path.join(wtDir, "sibling.txt"), "utf-8"), "sibling edit\n");
      assert.ok(events.some((message) => message.includes("sibling-owned dirty path")));
      assert.equal(events.some((message) => message.includes("worktree setup deferred")), false);
    } finally {
      if (wtDir) {
        try { execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      }
      try { execFileSync("git", ["worktree", "prune"], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("lets the lowest-id same-WI sibling clean unowned blocking dirt without touching sibling-owned edits", async () => {
    const { setUpWorktreeForJob } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-worktree-concurrent-blocking-dirty-");
    let wtDir = null;
    try {
      fs.writeFileSync(path.join(projectDir, "current.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "sibling.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "leftover.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "current.txt", "sibling.txt", "leftover.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add scoped files"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("Concurrent setup blocking dirt", "desc");
      const branchName = `posse/wi-${wi.id}-concurrent-blocking-dirty`;
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      queueMod.setWorkItemBranch(wi.id, branchName, base);
      execFileSync("git", ["branch", branchName], { cwd: projectDir, stdio: "ignore" });
      wtDir = path.join(worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", wtDir, branchName], { cwd: projectDir, stdio: "ignore" });

      const current = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "current winner",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["current.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const sibling = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "active sibling",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["sibling.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      assert.ok(Number(current.id) < Number(sibling.id));
      const currentLease = queueMod.acquireLeaseWithWriteLocks(current, "current-worker", 60);
      assert.ok(currentLease?.leaseToken);
      const siblingLease = queueMod.acquireLeaseWithWriteLocks(queueMod.getJob(sibling.id), "sibling-worker", 60);
      assert.ok(siblingLease?.leaseToken);

      fs.writeFileSync(path.join(wtDir, "leftover.txt"), "stale leftover\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "sibling.txt"), "sibling edit\n", "utf-8");

      const events = [];
      const worker = {
        projectDir,
        silent: true,
        parsePayload: (j) => JSON.parse(j.payload_json || "{}"),
        emit: (_jobId, message) => events.push(String(message)),
        _releaseWithoutAttemptPenalty: (job, leaseToken, status, opts) =>
          queueMod.releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, status, opts),
        _retryOrFail: () => { throw new Error("unexpected retry"); },
      };

      const result = await setUpWorktreeForJob(worker, queueMod.getJob(current.id), currentLease.leaseToken);

      assert.equal(result.ok, true);
      assert.equal(fs.readFileSync(path.join(wtDir, "leftover.txt"), "utf-8").replace(/\r\n/g, "\n"), "base\n");
      assert.equal(fs.readFileSync(path.join(wtDir, "sibling.txt"), "utf-8").replace(/\r\n/g, "\n"), "sibling edit\n");
      assert.ok(events.some((message) => message.includes("targeted setup cleanup reset")));
      assert.equal(events.some((message) => message.includes("worktree setup deferred")), false);
    } finally {
      if (wtDir) {
        try { execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      }
      try { execFileSync("git", ["worktree", "prune"], { cwd: projectDir, stdio: "ignore" }); } catch { /* ignore */ }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves tracked and untracked dirty worktree files before cleanup", () => {
    const { workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const scratchDir = fs.mkdtempSync(path.join(projectDir, "tmp-dirty-worktree-"));
    try {
      execFileSync("git", ["init"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: scratchDir, stdio: "ignore" });
      fs.writeFileSync(path.join(scratchDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir, stdio: "ignore" });

      fs.writeFileSync(path.join(scratchDir, "tracked.txt"), "changed\n", "utf-8");
      fs.mkdirSync(path.join(scratchDir, "notes"), { recursive: true });
      fs.writeFileSync(path.join(scratchDir, "notes", "draft.md"), "draft\n", "utf-8");

      const refName = workerMod.__testPreserveDirtyWorktreeSnapshot(scratchDir, scratchDir, {
        reason: "unit-test",
        branchName: "posse/test-branch",
        wiId: 42,
      });

      assert.ok(refName);
      assert.ok(String(refName).startsWith("refs/posse/snapshots/"));

      const { note } = readSnapshotManifest(scratchDir, refName);
      assert.equal(note.storage, "git-ref");
      assert.equal(typeof note.status, "string");
      assert.equal(typeof note.diff_patch, "string");
      assert.ok(note.tracked_dirty.includes("tracked.txt"));
      assert.ok(note.untracked.includes("notes/draft.md"));

      assert.equal(readSnapshotFile(scratchDir, refName, "tracked.txt"), "changed\n");
      assert.equal(readSnapshotFile(scratchDir, refName, "notes/draft.md"), "draft\n");
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("commits in-scope edits while leaving out-of-scope untracked residuals for cleanup", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-scope-snapshot-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "rogue.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "allowed.txt", "rogue.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "allowed-change\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "rogue.txt"), "rogue-change\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "rogue-new.txt"), "rogue-untracked\n", "utf-8");

      const result = gitCommitAll("scope snapshot test", projectDir, {
        modifyFiles: ["allowed.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 77,
        branchName: "posse/test-scope",
        snapshotReason: "scope-enforcement-test",
      });

      assert.ok(result?.hash);
      assert.deepEqual(result.createdOutOfScope, ["rogue-new.txt"]);
      const normalizeNl = (text) => String(text).replace(/\r\n/g, "\n");
      assert.equal(normalizeNl(fs.readFileSync(path.join(projectDir, "allowed.txt"), "utf-8")), "allowed-change\n");
      assert.equal(normalizeNl(fs.readFileSync(path.join(projectDir, "rogue.txt"), "utf-8")), "base\n");
      assert.equal(normalizeNl(execFileSync("git", ["show", "HEAD:allowed.txt"], { cwd: projectDir, encoding: "utf-8" })), "allowed-change\n");
      assert.equal(normalizeNl(execFileSync("git", ["show", "HEAD:rogue.txt"], { cwd: projectDir, encoding: "utf-8" })), "base\n");
      // Untracked out-of-scope files are tolerated during active work and
      // left for terminal cleanup, but they must not be silently staged.
      assert.equal(fs.existsSync(path.join(projectDir, "rogue-new.txt")), true);
      const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.equal(stagedFiles.includes("rogue-new.txt"), false);
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(porcelain, ["?? rogue-new.txt"]);

      const snapshotRefs = listSnapshotRefsMatching(projectDir, "scope-enforcement-test");
      assert.ok(snapshotRefs.length > 0);

      const latestRef = snapshotRefs.sort().at(-1);
      const { note } = readSnapshotManifest(projectDir, latestRef);
      assert.equal(note.reason, "scope-enforcement-test");
      assert.ok(note.tracked_dirty.includes("rogue.txt"));
      assert.ok(note.untracked.includes("rogue-new.txt"));
      assert.equal(normalizeNl(readSnapshotFile(projectDir, latestRef, "rogue.txt")), "rogue-change\n");
      assert.equal(normalizeNl(readSnapshotFile(projectDir, latestRef, "rogue-new.txt")), "rogue-untracked\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns out-of-scope untracked residuals from the async commit worker", async () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-async-scope-error-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "allowed.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "allowed-change\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "rogue-new.txt"), "rogue-untracked\n", "utf-8");

      const result = await gitCommitAllAsync("async scope residual", projectDir, {
        modifyFiles: ["allowed.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 88,
        branchName: "posse/test-async-scope",
        snapshotReason: "async-scope-residual-test",
      });

      assert.ok(result?.hash);
      assert.deepEqual(result.createdOutOfScope, ["rogue-new.txt"]);
      assert.equal(fs.existsSync(path.join(projectDir, "rogue-new.txt")), true);
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(porcelain, ["?? rogue-new.txt"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves async git commit stderr from hooks", async () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-async-hook-stderr-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "allowed.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const hookPath = path.join(projectDir, ".git", "hooks", "pre-commit");
      fs.writeFileSync(hookPath, "#!/bin/sh\necho precommit-boom >&2\nexit 1\n", "utf-8");
      try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows may not need chmod for Git hooks */ }
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "allowed-change\n", "utf-8");

      let thrown;
      try {
        await gitCommitAllAsync("async hook stderr", projectDir, {
          modifyFiles: ["allowed.txt"],
          createFiles: [],
          deleteFiles: [],
          createRoots: [],
        }, {
          projectDir,
          wiId: 89,
          branchName: "posse/test-async-hook",
          snapshotReason: "async-hook-stderr-test",
        });
      } catch (err) {
        thrown = err;
      }

      assert.match(thrown?.stderr || "", /precommit-boom/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("derives the git commit process cap from fixed core and hook budgets", () => {
    const budget = __testGitCommitTimeoutBudget();

    assert.equal(budget.coreTimeoutMs, 60_000);
    assert.equal(budget.postCommitHookTimeoutMs, 600_000);
    assert.equal(budget.hookGraceMs, 30_000);
    assert.equal(budget.processTimeoutMs, 690_000);
    assert.equal(budget.legacyProcessTimeoutMs, null);
  });

  it("leaves active sibling-locked dirty files unstaged while committing scoped work", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-sibling-lock-scope-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "sibling.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "allowed.txt", "sibling.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "allowed-change\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "sibling.txt"), "sibling-change\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "sibling-new.txt"), "sibling-new\n", "utf-8");
      execFileSync("git", ["add", "sibling.txt"], { cwd: projectDir, stdio: "ignore" });

      const result = gitCommitAll("scoped commit with sibling dirt", projectDir, {
        modifyFiles: ["allowed.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 101,
        jobId: 201,
        branchName: "posse/test-sibling-locks",
        snapshotReason: "sibling-lock-scope-test",
        activeFileLocks: {
          jobs: [
            { job_id: 202, work_item_id: 101, path: "sibling.txt", lock_kind: "file" },
            { job_id: 203, work_item_id: 101, path: "sibling-new.txt", lock_kind: "file" },
          ],
        },
      });

      const committedFiles = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(committedFiles, ["allowed.txt"]);
      assert.equal(fs.readFileSync(path.join(projectDir, "sibling.txt"), "utf-8").replace(/\r\n/g, "\n"), "sibling-change\n");
      assert.equal(fs.existsSync(path.join(projectDir, "sibling-new.txt")), true);
      assert.deepEqual(result.siblingDirtySkipped.map((entry) => entry.file), ["sibling.txt"]);
      assert.deepEqual(result.siblingUntrackedSkipped.map((entry) => entry.file), ["sibling-new.txt"]);
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" });
      assert.match(status, /M sibling\.txt/);
      assert.match(status, /\?\? sibling-new\.txt/);
      const stagedAfter = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: projectDir, encoding: "utf-8" }).trim();
      assert.equal(stagedAfter, "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not stage sibling-owned files just because they are under create_roots", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-sibling-create-root-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "README.md"), "base\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.mkdirSync(path.join(projectDir, "root"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "root", "current.md"), "current\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "root", "sibling.md"), "sibling\n", "utf-8");

      const result = gitCommitAll("scoped create root with sibling dirt", projectDir, {
        modifyFiles: [],
        createFiles: ["root/current.md"],
        deleteFiles: [],
        createRoots: ["root"],
      }, {
        projectDir,
        wiId: 102,
        jobId: 204,
        branchName: "posse/test-sibling-create-root",
        snapshotReason: "sibling-create-root-test",
        activeFileLocks: {
          jobs: [
            { job_id: 205, work_item_id: 102, path: "root/sibling.md", lock_kind: "file" },
          ],
        },
      });

      const committedFiles = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(committedFiles, ["root/current.md"]);
      assert.equal(fs.existsSync(path.join(projectDir, "root", "sibling.md")), true);
      assert.deepEqual(result.siblingStagingSkipped.map((entry) => entry.file), ["root/sibling.md"]);
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" });
      assert.match(status, /\?\? root\/sibling\.md/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not prune snapshot refs solely because the pointed commit is old when note captured_at is fresh", async () => {
    const { pruneRecoveredWorktreeSnapshots, pruneRecoveredWorktreeSnapshotsAsync } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-snapshot-retention-note-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: projectDir,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
        },
      });

      const oldHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      const refName = "refs/posse/snapshots/wi-1-retention-unit";
      execFileSync("git", ["update-ref", refName, oldHash], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["notes", "--ref=refs/notes/posse-snapshots", "add", "-f", "-m", JSON.stringify({
        captured_at: new Date().toISOString(),
        reason: "retention-unit",
      }), oldHash], { cwd: projectDir, stdio: "ignore" });

      const { queueMod } = runtimeModules;
      const previousRetention = queueMod.getSetting("snapshot_retention_days");
      const previousMaxRefs = queueMod.getSetting("snapshot_max_refs");
      const previousMaxBytes = queueMod.getSetting("snapshot_max_bytes");
      try {
        queueMod.setSetting("snapshot_retention_days", "1");
        queueMod.setSetting("snapshot_max_refs", "5000");
        queueMod.setSetting("snapshot_max_bytes", "2147483647");
        pruneRecoveredWorktreeSnapshots(projectDir, () => {});
        await pruneRecoveredWorktreeSnapshotsAsync(projectDir, () => {});
      } finally {
        queueMod.setSetting("snapshot_retention_days", previousRetention);
        queueMod.setSetting("snapshot_max_refs", previousMaxRefs);
        queueMod.setSetting("snapshot_max_bytes", previousMaxBytes);
      }

      const remaining = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/posse/snapshots"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      assert.ok(remaining.includes(refName));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("aborts in-progress rebase residue during dirty worktree reset", async () => {
    const { snapshotAndResetDirtyWorktree } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-reset-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "-b", "feature"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "feature\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: projectDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "main"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "main\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main"], { cwd: projectDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "feature"], { cwd: projectDir, stdio: "ignore" });
      const rebase = spawnSync("git", ["rebase", "main"], { cwd: projectDir, encoding: "utf-8" });
      assert.notEqual(rebase.status, 0);

      snapshotAndResetDirtyWorktree(projectDir, projectDir, {
        reason: "unit-rebase-residue",
        branchName: "feature",
        wiId: 88,
      });

      const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim();
      assert.equal(status, "");
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "rebase-merge")), false);
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "rebase-apply")), false);
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "CHERRY_PICK_HEAD")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips stale modifyFiles paths instead of failing with a pathspec error", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-scope-stale-modify-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.mkdirSync(path.join(projectDir, "htdocs"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "htdocs", "index.php"), "<?php echo 'base';\n", "utf-8");
      execFileSync("git", ["add", "htdocs/index.php"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      fs.writeFileSync(path.join(projectDir, "htdocs", "index.php"), "<?php echo 'changed';\n", "utf-8");

      const result = gitCommitAll("scope stale modify", projectDir, {
        modifyFiles: ["web/index.php"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 12,
        branchName: "posse/test-stale-modify",
      });

      assert.equal(result.hash, headBefore);
      assert.deepEqual(result.skippedStaleModifyFiles, ["web/index.php"]);
      assert.deepEqual(result.gitAddWarnings, []);
      assert.deepEqual(result.reverted, ["htdocs/index.php"]);
      assert.equal(result.scopeCleanedNoOp, true);
      const restoredContent = fs.readFileSync(path.join(projectDir, "htdocs", "index.php"), "utf-8").replace(/\r\n/g, "\n");
      assert.equal(restoredContent, "<?php echo 'base';\n");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses a scoped commit when branch HEAD moves after scope enforcement", () => {
    const projectDir = makeGitRepo("tmp-commit-head-moved-");
    try {
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "changed\n", "utf-8");
      assert.throws(() => gitCommitAll("head moved guard", projectDir, {
        modifyFiles: ["tracked.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        branchName: "main",
        taskMode: "code",
        beforeCommitHook: () => {
          const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
          const tree = execFileSync("git", ["rev-parse", `${head}^{tree}`], { cwd: projectDir, encoding: "utf-8" }).trim();
          const moved = execFileSync("git", ["commit-tree", tree, "-p", head, "-m", "external move"], { cwd: projectDir, encoding: "utf-8" }).trim();
          execFileSync("git", ["update-ref", "refs/heads/main", moved], { cwd: projectDir, stdio: "ignore" });
          return { ok: true };
        },
      }), /Branch HEAD moved/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("commits valid scoped edits even when sibling modifyFiles entries are stale", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-scope-stale-plus-valid-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.mkdirSync(path.join(projectDir, "htdocs"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "htdocs", "index.php"), "<?php echo 'base';\n", "utf-8");
      execFileSync("git", ["add", "htdocs/index.php"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      fs.writeFileSync(path.join(projectDir, "htdocs", "index.php"), "<?php echo 'changed';\n", "utf-8");

      const result = gitCommitAll("scope stale plus valid", projectDir, {
        modifyFiles: ["web/index.php", "htdocs/index.php"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 12,
        branchName: "posse/test-stale-plus-valid",
      });

      assert.notEqual(result.hash, headBefore);
      assert.deepEqual(result.skippedStaleModifyFiles, ["web/index.php"]);
      assert.deepEqual(result.reverted, []);
      assert.equal(result.scopeCleanedNoOp, false);
      assert.equal(execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim(), "htdocs/index.php");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips ignored files declared in createFiles instead of failing the commit", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-scope-ignored-create-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, ".gitignore"), "config.local.php\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "app.php"), "<?php echo 'base';\n", "utf-8");
      execFileSync("git", ["add", ".gitignore", "app.php"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "app.php"), "<?php echo 'changed';\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "config.local.php"), "<?php return ['secret' => true];\n", "utf-8");

      const result = gitCommitAll("scope ignored create", projectDir, {
        modifyFiles: ["app.php"],
        createFiles: ["config.local.php"],
        deleteFiles: [],
        createRoots: [],
      }, {
        projectDir,
        wiId: 13,
        branchName: "posse/test-ignored-create",
      });

      assert.ok(result.skippedIgnoredCreateFiles.includes("config.local.php"));
      assert.deepEqual(result.gitAddWarnings, []);
      const committedFiles = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: projectDir, encoding: "utf-8" })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(committedFiles, ["app.php"]);
      assert.equal(fs.existsSync(path.join(projectDir, "config.local.php")), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("snapshots conflicted stall stash state before dropping the stash", () => {
    const { workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-stall-snapshot-"));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-stall-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "stash-change\n", "utf-8");
      execFileSync("git", ["stash", "push", "--include-untracked", "-m", "posse: stalled partials job #123"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "head-change\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "head update"], { cwd: projectDir, stdio: "ignore" });

      const worker = new workerMod.Worker({ projectDir, silent: true });
      const result = worker.applyStallStash({ id: 123, work_item_id: 44 }, projectDir);

      assert.equal(result, null);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");
      assert.equal(fs.readFileSync(path.join(projectDir, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"), "head-change\n");
      assert.equal(execFileSync("git", ["stash", "list"], { cwd: projectDir, encoding: "utf-8" }).trim(), "");

      const recoveryRoots = [
        path.join(runtimeDir, "recovered-worktrees"),
        path.join(projectDir, ".posse", "recovered-worktrees"),
      ];
      const snapshots = recoveryRoots.flatMap((root) =>
        fs.existsSync(root)
          ? fs.readdirSync(root)
            .filter((name) => name.includes("stall-stash-conflict-job-123"))
            .map((name) => path.join(root, name))
          : []
      );
      assert.ok(snapshots.length > 0);
      const latest = snapshots.sort().at(-1);
      const manifest = JSON.parse(fs.readFileSync(path.join(latest, "manifest.json"), "utf-8"));
      assert.equal(manifest.reason, "stall-stash-conflict-job-123");
      assert.ok(Array.isArray(manifest.tracked_dirty));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("stashes untracked files alongside tracked edits during recovery", () => {
    const { workerMod } = runtimeModules;
    const scratchDir = fs.mkdtempSync(path.join(__dirname, "tmp-stash-untracked-"));
    try {
      execFileSync("git", ["init"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: scratchDir, stdio: "ignore" });
      fs.writeFileSync(path.join(scratchDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir, stdio: "ignore" });

      fs.writeFileSync(path.join(scratchDir, "tracked.txt"), "changed\n", "utf-8");
      fs.writeFileSync(path.join(scratchDir, "draft.txt"), "draft\n", "utf-8");

      workerMod.__testGitStash("posse: test stash", scratchDir);

      const status = execFileSync("git", ["status", "--porcelain"], { cwd: scratchDir, encoding: "utf-8" }).trim();
      const stashShow = execFileSync("git", ["stash", "show", "--include-untracked", "--name-only", "stash@{0}"], { cwd: scratchDir, encoding: "utf-8" });

      assert.equal(status, "");
      assert.match(stashShow, /tracked\.txt/);
      assert.match(stashShow, /draft\.txt/);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("snapshots a dirty terminal worktree before removing it", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-terminal-worktree-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("terminal-cleanup", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", `posse/wi-${wi.id}-terminal-cleanup`, wtDir], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "draft\n", "utf-8");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const worker = new workerMod.Worker({ projectDir, silent: true });
      // _cleanupWorktreeIfDone delegates to the async module helper and
      // returns the promise; awaiting it is required, otherwise the
      // assertions below race the removal.
      await worker._cleanupWorktreeIfDone(wi.id);

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-terminal-worktree-cleanup`);

      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(snapshotRefs.length > 0);
      const latestRef = snapshotRefs.sort().at(-1);
      assert.equal(readSnapshotFile(projectDir, latestRef, "tracked.txt"), "changed\n");
      assert.equal(readSnapshotFile(projectDir, latestRef, "draft.txt"), "draft\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps a terminal worktree on disk when cleanup cannot verify a snapshot or clean state", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-terminal-corrupt-kept-");
    try {
      const wi = queueMod.createWorkItem("terminal corrupt kept", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /definitely/missing/worktree/gitdir\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "do not remove\n", "utf-8");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const worker = new workerMod.Worker({ projectDir, silent: true });
      await worker._cleanupWorktreeIfDone(wi.id);

      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(fs.readFileSync(path.join(wtDir, "draft.txt"), "utf-8"), "do not remove\n");
      assert.equal(queueMod.getEvents(null, 100).some((event) =>
        event.work_item_id === wi.id
        && event.event_type === "worktree.cleanup_failed"
        && /leaving worktree on disk|removal skipped/i.test(event.message || "")
      ), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("startup GC keeps a terminal worktree on disk when snapshot verification fails", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const { createGitWorkflowHelpers } = await import("../../../lib/domains/cli/functions/git-workflows.js");
    const projectDir = makeGitRepo("tmp-startup-gc-corrupt-kept-");
    try {
      const wi = queueMod.createWorkItem("startup corrupt kept", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /definitely/missing/worktree/gitdir\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "still here\n", "utf-8");
      queueMod.updateWorkItemStatus(wi.id, "complete");
      const helpers = createGitWorkflowHelpers({
        projectDir,
        targetBranch: "main",
      });

      helpers._snapshotAndRemoveWorktreeOnly({ id: wi.id, branch_name: null }, "test-snapshot-failure");

      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(fs.readFileSync(path.join(wtDir, "draft.txt"), "utf-8"), "still here\n");
      assert.equal(queueMod.getEvents(null, 100).some((event) =>
        event.work_item_id === wi.id
        && event.event_type === "worktree.cleanup_failed"
      ), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("setup-failure cleanup snapshots dirty worktrees before removal", async () => {
    const { safeSnapshotAndRemoveWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = makeGitRepo("tmp-setup-failure-safe-remove-");
    try {
      const wtDir = path.join(worktreeRoot(projectDir), "wi-55");
      const branchName = "posse/wi-55-setup-failure";
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "partial setup state\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "generated.txt"), "generated before failure\n", "utf-8");

      const result = await safeSnapshotAndRemoveWorktreeAsync(wtDir, projectDir, {
        reason: "setup-failure-worktree-cleanup",
        branchName,
        wiId: 55,
      });

      const snapshotRefs = listSnapshotRefsMatching(projectDir, "wi-55-setup-failure-worktree-cleanup");
      assert.equal(result.removed, true);
      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(snapshotRefs.length > 0);
      const latestRef = snapshotRefs.sort().at(-1);
      assert.equal(readSnapshotFile(projectDir, latestRef, "tracked.txt"), "partial setup state\n");
      assert.equal(readSnapshotFile(projectDir, latestRef, "generated.txt"), "generated before failure\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("safe worktree removal is idempotent after another cleanup wins the race", async () => {
    const { safeSnapshotAndRemoveWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = makeGitRepo("tmp-safe-remove-idempotent-");
    try {
      const wtDir = path.join(worktreeRoot(projectDir), "wi-56");
      const branchName = "posse/wi-56-idempotent";
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });

      const first = await safeSnapshotAndRemoveWorktreeAsync(wtDir, projectDir, {
        reason: "test-idempotent-remove",
        branchName,
        wiId: 56,
      });
      const second = await safeSnapshotAndRemoveWorktreeAsync(wtDir, projectDir, {
        reason: "test-idempotent-remove",
        branchName,
        wiId: 56,
      });

      assert.equal(first.removed, true);
      assert.equal(second.existed, false);
      assert.equal(second.removed, true);
      assert.equal(fs.existsSync(wtDir), false);
      const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectDir, encoding: "utf-8" });
      assert.equal(worktreeList.includes(wtDir.replace(/\\/g, "/")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("startup GC preserves corrupt terminal worktree contents before removal", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-gc-corrupt-terminal-preserve-");
    try {
      const wi = queueMod.createWorkItem("gc corrupt terminal preserve", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /definitely/missing/worktree/gitdir\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "preserve me\n", "utf-8");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const rootEntries = fs.readdirSync(workerMod.worktreeRoot(projectDir));
      const recoveryDir = rootEntries
        .filter((entry) => entry.startsWith(`.recovered-corrupt-wi-${wi.id}-`))
        .map((entry) => path.join(workerMod.worktreeRoot(projectDir), entry))
        .find((entryPath) => fs.existsSync(path.join(entryPath, "draft.txt")));
      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(recoveryDir);
      assert.equal(fs.readFileSync(path.join(recoveryDir, "draft.txt"), "utf-8"), "preserve me\n");
      assert.ok(messages.some(msg => /preserved corrupt terminal worktree/i.test(msg)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("startup GC records skipped symlinks during corrupt worktree preservation", (t) => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-gc-corrupt-symlink-preserve-");
    try {
      const wi = queueMod.createWorkItem("gc corrupt symlink preserve", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /definitely/missing/worktree/gitdir\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "preserve me\n", "utf-8");
      try {
        fs.symlinkSync("draft.txt", path.join(wtDir, "draft-link.txt"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }
      queueMod.updateWorkItemStatus(wi.id, "complete");

      workerMod.gcWorktrees(projectDir, () => {});

      const rootEntries = fs.readdirSync(workerMod.worktreeRoot(projectDir));
      const recoveryDir = rootEntries
        .filter((entry) => entry.startsWith(`.recovered-corrupt-wi-${wi.id}-`))
        .map((entry) => path.join(workerMod.worktreeRoot(projectDir), entry))
        .find((entryPath) => fs.existsSync(path.join(entryPath, "draft.txt")));
      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(recoveryDir);
      assert.equal(fs.existsSync(path.join(recoveryDir, "draft-link.txt")), false);
      const info = JSON.parse(fs.readFileSync(path.join(recoveryDir, ".posse-recovery-info.json"), "utf-8"));
      assert.equal(info.skipped_symlink_count, 1);
      assert.deepEqual(info.skipped_symlinks.map((entry) => entry.path), ["draft-link.txt"]);
      assert.equal(info.skipped_symlinks[0].target, "draft.txt");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("async startup GC preserves corrupt inactive worktree contents before removal", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-gc-corrupt-inactive-preserve-");
    try {
      const wi = queueMod.createWorkItem("gc corrupt inactive preserve", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /definitely/missing/worktree/gitdir\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "async preserve me\n", "utf-8");
      queueMod.updateWorkItemStatus(wi.id, "running");

      const messages = [];
      await workerMod.gcWorktreesAsync(projectDir, (msg) => messages.push(msg));

      const rootEntries = fs.readdirSync(workerMod.worktreeRoot(projectDir));
      const recoveryDir = rootEntries
        .filter((entry) => entry.startsWith(`.recovered-corrupt-wi-${wi.id}-`))
        .map((entry) => path.join(workerMod.worktreeRoot(projectDir), entry))
        .find((entryPath) => fs.existsSync(path.join(entryPath, "draft.txt")));
      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(recoveryDir);
      assert.equal(fs.readFileSync(path.join(recoveryDir, "draft.txt"), "utf-8"), "async preserve me\n");
      assert.ok(messages.some(msg => /preserved corrupt inactive worktree/i.test(msg)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("defers terminal cleanup while a same-WI sibling job is still live", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-terminal-live-sibling-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("terminal-cleanup-live-sibling", "desc");
      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      const branchName = `posse/wi-${wi.id}-terminal-live-sibling`;
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      queueMod.setWorkItemBranch(wi.id, branchName, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim());
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "sibling-active\n", "utf-8");

      const sibling = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "still active",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["tracked.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });
      const siblingLease = queueMod.acquireLeaseWithWriteLocks(sibling, "sibling-worker", 60);
      assert.ok(siblingLease?.leaseToken);
      assert.equal(queueMod.updateWorkItemStatus(wi.id, "canceled"), true);

      const worker = new workerMod.Worker({ projectDir, silent: true });
      await worker._cleanupWorktreeIfDone(wi.id);

      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(fs.readFileSync(path.join(wtDir, "tracked.txt"), "utf-8"), "sibling-active\n");
      assert.equal(queueMod.getEvents(null, 100).some((event) =>
        event.work_item_id === wi.id
        && event.event_type === "worktree.dirty_cleanup_deferred"
      ), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("snapshots dirty terminal worktrees during startup GC before removal", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-startup-gc-terminal-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("startup-gc-terminal", "desc");
      const branchName = `posse/wi-${wi.id}-startup-gc-terminal`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}-startup-gc-terminal`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "draft\n", "utf-8");

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-terminal-worktree`);
      const branchStillExists = execFileSync("git", ["branch", "--list", branchName], { cwd: projectDir, encoding: "utf-8" }).trim();

      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(messages.some(msg => /preserved terminal dirty worktree/i.test(msg)));
      assert.ok(snapshotRefs.length > 0);
      assert.match(branchStillExists, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(queueMod.getWorkItem(wi.id).branch_name, branchName);
      const latestRef = snapshotRefs.sort().at(-1);
      assert.equal(readSnapshotFile(projectDir, latestRef, "tracked.txt"), "changed\n");
      assert.equal(readSnapshotFile(projectDir, latestRef, "draft.txt"), "draft\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips terminal startup GC while a job still holds the worktree bench", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-terminal-held-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-terminal-held", "desc");
      const branchName = `posse/wi-${wi.id}-terminal-held`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "canceled");
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Still unwinding",
        status: "running",
      });

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed while canceling\n", "utf-8");

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-terminal-worktree`);
      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(snapshotRefs.length, 0);
      assert.equal(branchExists(projectDir, branchName), true);
      assert.ok(messages.some(msg => /skipping terminal worktree cleanup/i.test(msg)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("snapshots dirty terminal worktrees during async startup GC before removal", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-async-terminal-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-async-terminal", "desc");
      const branchName = `posse/wi-${wi.id}-startup-gc-async-terminal`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}-startup-gc-async-terminal`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "draft\n", "utf-8");

      const messages = [];
      await workerMod.gcWorktreesAsync(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-terminal-worktree`);
      const branchStillExists = execFileSync("git", ["branch", "--list", branchName], { cwd: projectDir, encoding: "utf-8" }).trim();

      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(messages.some(msg => /preserved terminal dirty worktree/i.test(msg)));
      assert.ok(snapshotRefs.length > 0);
      assert.match(branchStillExists, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(readSnapshotFile(projectDir, snapshotRefs.sort().at(-1), "tracked.txt"), "changed\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips async terminal startup GC while a job still holds the worktree bench", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-async-terminal-held-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-async-terminal-held", "desc");
      const branchName = `posse/wi-${wi.id}-async-terminal-held`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "complete");
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Still assessing",
        status: "awaiting_assessment",
      });

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed while completing\n", "utf-8");

      const messages = [];
      await workerMod.gcWorktreesAsync(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-terminal-worktree`);
      assert.equal(fs.existsSync(wtDir), true);
      assert.equal(snapshotRefs.length, 0);
      assert.equal(branchExists(projectDir, branchName), true);
      assert.ok(messages.some(msg => /skipping terminal worktree cleanup/i.test(msg)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("async snapshot ref listing uses snapshot note timestamps", async () => {
    const {
      listSnapshotRefsAsync,
      writeSnapshotNoteAsync,
    } = await import("../../../lib/domains/git/functions/worktree-snapshots.js");
    const projectDir = makeGitRepo("tmp-snapshot-refs-async-notes-");
    try {
      const objectHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim();
      const refName = "refs/posse/snapshots/wi-1-async-note-batch-test";
      const capturedAt = "2024-01-02T03:04:05.000Z";
      const manager = fakeSnapshotNativeManager();
      execFileSync("git", ["update-ref", refName, objectHash], { cwd: projectDir, stdio: "ignore" });
      assert.equal(await writeSnapshotNoteAsync(projectDir, objectHash, { captured_at: capturedAt }, { manager }), true);

      const refs = await listSnapshotRefsAsync(projectDir, { manager });
      const row = refs.find((ref) => ref.refName === refName);
      assert.ok(row);
      assert.equal(row.objectHash, objectHash);
      assert.equal(row.createdMs, Date.parse(capturedAt));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports async startup GC timing for held worktree checks", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-timing-held-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-timing-held", "desc");
      const branchName = `posse/wi-${wi.id}-timing-held`;
      queueMod.setWorkItemBranch(wi.id, branchName, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim());
      queueMod.updateWorkItemStatus(wi.id, "running");
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Still holding bench",
        status: "running",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["tracked.txt"],
          files_to_create: [],
          create_roots: [],
        },
      });

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });

      const messages = [];
      await workerMod.gcWorktreesAsync(projectDir, (msg) => messages.push(msg), { timingSlowMs: 0 });

      assert.equal(fs.existsSync(wtDir), true);
      assert.ok(messages.some(msg => msg.includes(`GC timing: WI#${wi.id} bench hold lookup took`)));
      assert.ok(messages.some(msg => msg.includes(`GC timing: held WI#${wi.id} dirty check took`)));
      assert.ok(messages.some(msg => /^GC timing: total /.test(msg)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves canceled terminal branch tips before deleting branches during startup GC", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-canceled-branch-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-canceled-branch", "desc");
      const branchName = `posse/wi-${wi.id}-canceled-cleanup`;
      queueMod.setWorkItemBranch(wi.id, branchName, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim());
      queueMod.updateWorkItemStatus(wi.id, "canceled");

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "feature.txt"), "feature\n", "utf-8");
      execFileSync("git", ["add", "feature.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: wtDir, stdio: "ignore" });

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-canceled-branch-posse-wi-${wi.id}-canceled-cleanup`);
      assert.equal(fs.existsSync(wtDir), false);
      assert.equal(branchExists(projectDir, branchName), false);
      assert.equal(queueMod.getWorkItem(wi.id).branch_name, null);
      assert.ok(messages.some(msg => /deleted branch.*tip saved/i.test(msg)));
      assert.ok(snapshotRefs.length > 0);
      assert.equal(readSnapshotFile(projectDir, snapshotRefs.sort().at(-1), "feature.txt"), "feature\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves squash-merged branch tips before deleting stale merged branches during startup GC", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = makeGitRepo("tmp-startup-gc-merged-branch-");
    try {
      const wi = queueMod.createWorkItem("startup-gc-merged-branch", "desc");
      const branchName = `posse/wi-${wi.id}-merged-cleanup`;
      queueMod.setWorkItemBranch(wi.id, branchName, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim());
      queueMod.setMergeState(wi.id, "merged");
      queueMod.updateWorkItemStatus(wi.id, "complete");

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "feature.txt"), "feature\n", "utf-8");
      execFileSync("git", ["add", "feature.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: wtDir, stdio: "ignore" });

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-merged-branch-posse-wi-${wi.id}-merged-cleanup`);
      const refreshed = queueMod.getWorkItem(wi.id);
      assert.equal(fs.existsSync(wtDir), false);
      assert.equal(branchExists(projectDir, branchName), false);
      assert.equal(refreshed.branch_name, null);
      assert.equal(refreshed.merge_state, "merged");
      assert.ok(messages.some(msg => /deleted branch.*tip saved/i.test(msg)));
      assert.ok(snapshotRefs.length > 0);
      assert.equal(readSnapshotFile(projectDir, snapshotRefs.sort().at(-1), "feature.txt"), "feature\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("removes inactive nonterminal worktrees during startup GC but retains branch pointers pending review", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-startup-gc-inactive-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("startup-gc-inactive", "desc");
      const branchName = `posse/wi-${wi.id}-startup-gc-inactive`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "running");

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}-startup-gc-inactive`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "tracked.txt"), "changed\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "draft.txt"), "draft\n", "utf-8");

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));

      const snapshotRefs = listSnapshotRefsMatching(projectDir, `wi-${wi.id}-startup-gc-inactive-worktree`);
      const branchStillExists = execFileSync("git", ["branch", "--list", branchName], { cwd: projectDir, encoding: "utf-8" }).trim();

      assert.equal(fs.existsSync(wtDir), false);
      assert.ok(messages.some(msg => /preserved inactive dirty worktree/i.test(msg)));
      assert.equal(messages.some(msg => /removed inactive worktree.*deleted stale branch/i.test(msg)), false);
      assert.ok(snapshotRefs.length > 0);
      assert.match(branchStillExists, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(queueMod.getWorkItem(wi.id).branch_name, branchName);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps queued nonterminal worktrees so checkout state can resume after boot", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-startup-gc-queued-"));
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "tracked.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("startup-gc-queued", "desc");
      const branchName = `posse/wi-${wi.id}-startup-gc-queued`;
      queueMod.setWorkItemBranch(wi.id, branchName, "deadbeef");
      queueMod.updateWorkItemStatus(wi.id, "running");
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Queued code change",
        status: "queued",
      });

      const wtDir = path.join(workerMod.worktreeRoot(projectDir), `wi-${wi.id}-startup-gc-queued`);
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });

      const messages = [];
      workerMod.gcWorktrees(projectDir, (msg) => messages.push(msg));
      const branchStillExists = execFileSync("git", ["branch", "--list", branchName], { cwd: projectDir, encoding: "utf-8" }).trim();

      assert.equal(fs.existsSync(wtDir), true);
      assert.match(branchStillExists, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(queueMod.getWorkItem(wi.id).branch_name, branchName);
      assert.equal(messages.some(msg => /removed inactive worktree/i.test(msg)), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
