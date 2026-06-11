import {
  it,
  assert,
  fs,
  path,
  execFileSync,
  __dirname,
  suite,
  runtimeModules,
  now,
  handoff,
} from "../support/core-harness.js";
import { targetBranchNativeParity } from "../support/git-native-target-branch.js";

let db;
const NODE_GIT_PARITY_DISABLED = Object.freeze({ disabled: true });
const TARGET_BRANCH_NATIVE = targetBranchNativeParity();

suite("Rebase-on-lease (mergeTargetIntoWorktreeAsync)", () => {
  it("returns updated:false when the WI branch is already up-to-date with target", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-noop-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-1");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-1", wtDir], { cwd: projectDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main");
      assert.equal(result.ok, true);
      assert.equal(result.updated, false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses to treat the current WI branch as the merge target", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-current-target-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-current-target");
      const branchName = "custom/work-current-target";
      execFileSync("git", ["worktree", "add", "-b", branchName, wtDir], { cwd: projectDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, branchName);
      assert.equal(result.ok, false);
      assert.match(result.error, /current worktree branch/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("merges target into WI branch when target moved with no conflicts", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-clean-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-2");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-2", wtDir], { cwd: projectDir, stdio: "ignore" });

      // Advance main independently of the WI branch.
      fs.writeFileSync(path.join(projectDir, "other.txt"), "from-main\n", "utf-8");
      execFileSync("git", ["add", "other.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "new file on main"], { cwd: projectDir, stdio: "ignore" });

      // WI branch edits an unrelated file so the merge is clean.
      fs.writeFileSync(path.join(wtDir, "wi-work.txt"), "wi work\n", "utf-8");
      execFileSync("git", ["add", "wi-work.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi work"], { cwd: wtDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main");
      assert.equal(result.ok, true);
      assert.equal(result.updated, true);
      assert.ok(result.mergeCommit && result.mergeCommit.length >= 7);
      // File from main should now be present in the worktree.
      assert.equal(fs.readFileSync(path.join(wtDir, "other.txt"), "utf-8").replace(/\r\n/g, "\n"), "from-main\n");
      // Worktree is clean — no unmerged index entries.
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(porcelain, "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("aborts and reports conflicts when target and WI branch touch the same file", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-conflict-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-3");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-3", wtDir], { cwd: projectDir, stdio: "ignore" });

      // Both branches change the same line of shared.txt.
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits shared"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits shared"], { cwd: wtDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main");
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.conflicts));
      assert.ok(result.conflicts.some((c) => c === "shared.txt"));
      // Worktree should be back to a clean pre-merge state (no MERGE_HEAD).
      assert.equal(fs.existsSync(path.join(wtDir, ".git", "MERGE_HEAD")) || fs.existsSync(path.join(projectDir, ".git", "worktrees", "wi-3", "MERGE_HEAD")), false);
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(porcelain, "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns an error when target branch does not exist", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-missing-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-4");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-4", wtDir], { cwd: projectDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "nonexistent-branch");
      assert.equal(result.ok, false);
      assert.match(result.error, /not found/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch honors the target_branch setting", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-configured-"));
    let prev = null;
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["branch", "release/x"], { cwd: projectDir, stdio: "ignore" });
      prev = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", "release/x", { projectDir });
      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "release/x");
    } finally {
      queueMod.setSetting("target_branch", prev, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch falls back when configured target_branch no longer exists locally", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-configured-missing-"));
    let prev = null;
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      prev = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", "release/deleted", { projectDir });
      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "main");
    } finally {
      queueMod.setSetting("target_branch", prev, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch picks up target_branch setting changes after a cached lookup", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-cache-setting-"));
    let previous = null;
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["branch", "release/live"], { cwd: projectDir, stdio: "ignore" });
      previous = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", null, { projectDir });
      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "main");

      queueMod.setSetting("target_branch", "release/live", { projectDir });
      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "release/live");
    } finally {
      queueMod.setSetting("target_branch", previous, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch prefers the current project branch when main also exists", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-current-"));
    let previous = null;
    try {
      execFileSync("git", ["init", "-b", "master"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["branch", "main"], { cwd: projectDir, stdio: "ignore" });
      previous = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", null, { projectDir });

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "master");
    } finally {
      queueMod.setSetting("target_branch", previous, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch uses the only non-work branch when currently on a Posse work branch", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-work-branch-"));
    let previous = null;
    try {
      execFileSync("git", ["init", "-b", "release/live"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      previous = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", null, { projectDir });
      execFileSync("git", ["checkout", "-b", "posse/wi-12-demo"], { cwd: projectDir, stdio: "ignore" });

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "release/live");
    } finally {
      queueMod.setSetting("target_branch", previous, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch does not select a non-standard branch recorded on a WI", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-recorded-wi-branch-"));
    let previous = null;
    try {
      execFileSync("git", ["init", "-b", "release/live"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      previous = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", null, { projectDir });
      const wi = queueMod.createWorkItem("custom branch", "desc");
      const wiBranch = `custom/work-${wi.id}`;
      execFileSync("git", ["checkout", "-b", wiBranch], { cwd: projectDir, stdio: "ignore" });
      queueMod.setWorkItemBranch(wi.id, wiBranch, execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" }).trim());

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "release/live");
    } finally {
      queueMod.setSetting("target_branch", previous, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolveTargetBranch uses origin HEAD when a Posse work branch has multiple local branch candidates", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-origin-head-"));
    let previous = null;
    try {
      execFileSync("git", ["init", "-b", "release/live"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["branch", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["update-ref", "refs/remotes/origin/release/live", "release/live"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/live"], { cwd: projectDir, stdio: "ignore" });
      previous = queueMod.getSetting("target_branch", { projectDir });
      queueMod.setSetting("target_branch", null, { projectDir });
      execFileSync("git", ["checkout", "-b", "posse/wi-13-demo"], { cwd: projectDir, stdio: "ignore" });

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "release/live");
    } finally {
      queueMod.setSetting("target_branch", previous, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("target_branch settings are scoped to the resolved repo path", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectA = fs.mkdtempSync(path.join(__dirname, "tmp-target-repo-a-"));
    const projectB = fs.mkdtempSync(path.join(__dirname, "tmp-target-repo-b-"));
    try {
      for (const projectDir of [projectA, projectB]) {
        execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
        fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
        execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      }
      execFileSync("git", ["branch", "release/a"], { cwd: projectA, stdio: "ignore" });
      queueMod.setSetting("target_branch", "release/a", { projectDir: projectA });

      assert.equal(resolveTargetBranch(projectA, TARGET_BRANCH_NATIVE), "release/a");
      assert.equal(queueMod.getSetting("target_branch", { projectDir: projectB }), null);
      assert.equal(resolveTargetBranch(projectB, TARGET_BRANCH_NATIVE), "main");
    } finally {
      queueMod.setSetting("target_branch", null, { projectDir: projectA });
      queueMod.setSetting("target_branch", null, { projectDir: projectB });
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("does not warn when a configured target_branch is missing locally but exists on a remote", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-remote-configured-"));
    const remoteDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-remote-origin-"));
    const originalWarn = console.warn;
    const warnings = [];
    try {
      execFileSync("git", ["init", "--bare"], { cwd: remoteDir, stdio: "ignore" });
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "-b", "release/remote"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["push", "origin", "release/remote"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["branch", "-D", "release/remote"], { cwd: projectDir, stdio: "ignore" });

      queueMod.setSetting("target_branch", "release/remote", { projectDir });
      console.warn = (message) => warnings.push(String(message));

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "main");
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
      queueMod.setSetting("target_branch", null, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("warns only when a configured target_branch is missing locally and remotely", async () => {
    const { resolveTargetBranch } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-target-missing-configured-"));
    const originalWarn = console.warn;
    const warnings = [];
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "base.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      queueMod.setSetting("target_branch", "release/missing", { projectDir });
      console.warn = (message) => warnings.push(String(message));

      assert.equal(resolveTargetBranch(projectDir, TARGET_BRANCH_NATIVE), "main");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /not found locally or on a remote/);
    } finally {
      console.warn = originalWarn;
      queueMod.setSetting("target_branch", null, { projectDir });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("leaves MERGE_HEAD and markers in tree when leaveOnConflict is set", async () => {
    const { mergeTargetIntoWorktreeAsync, isMergeInProgress, listMergeConflicts, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-leave-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-5");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-5", wtDir], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits shared"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits shared"], { cwd: wtDir, stdio: "ignore" });

      const result = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main", { leaveOnConflict: true });
      assert.equal(result.ok, false);
      assert.equal(result.leftInTree, true);
      assert.ok(result.conflicts.includes("shared.txt"));

      // Merge state is still live in the worktree — handoff can pick it up.
      assert.equal(isMergeInProgress(wtDir, NODE_GIT_PARITY_DISABLED), true);
      assert.ok(listMergeConflicts(wtDir, NODE_GIT_PARITY_DISABLED).includes("shared.txt"));
      const contents = fs.readFileSync(path.join(wtDir, "shared.txt"), "utf-8");
      assert.match(contents, /<<<<<<</);
      assert.match(contents, />>>>>>>/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("short-circuits when a prior merge is still in progress", async () => {
    const { mergeTargetIntoWorktreeAsync, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-rebase-in-progress-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir, NODE_GIT_PARITY_DISABLED), "wi-6");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-6", wtDir], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      // First call leaves merge in progress.
      const first = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main", { leaveOnConflict: true });
      assert.equal(first.leftInTree, true);

      // Second call must not retry / abort — just report the existing state.
      const second = await mergeTargetIntoWorktreeAsync(wtDir, projectDir, "main", { leaveOnConflict: true });
      assert.equal(second.ok, false);
      assert.equal(second.alreadyInProgress, true);
      assert.ok(second.conflicts.includes("shared.txt"));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
