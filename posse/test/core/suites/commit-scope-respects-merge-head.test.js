import {
  it,
  assert,
  fs,
  path,
  execFileSync,
  __dirname,
  suite,
  gitCommitAll,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Commit scope respects MERGE_HEAD", () => {
  it("blocks unscoped git add fallback for code or unknown task modes", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-unscoped-code-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "task.txt"), "task\n", "utf-8");

      assert.throws(() => {
        gitCommitAll("unscoped code", projectDir, {}, { taskMode: "code" });
      }, /Unscoped git add -A blocked/i);
      assert.throws(() => {
        gitCommitAll("unscoped unknown", projectDir, {}, { taskMode: "future_mode" });
      }, /Unscoped git add -A blocked/i);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks root-wide create_roots for scoped code commits", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-root-create-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "wide.txt"), "wide\n", "utf-8");

      assert.throws(() => {
        gitCommitAll("root create scope", projectDir, {
          modifyFiles: [],
          createFiles: [],
          deleteFiles: [],
          createRoots: ["."],
        }, { taskMode: "code" });
      }, /Unsafe create_roots scope blocked/i);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("allows unscoped git add fallback for allowlisted artifact task modes", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-unscoped-artifact-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "report.md"), "# Report\n", "utf-8");

      const result = gitCommitAll("unscoped report", projectDir, {}, { taskMode: "report" });

      assert.ok(result.hash);
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }).trim();
      assert.equal(porcelain, "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("bypasses scope enforcement when a merge is in progress", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-merge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "task.txt"), "task-base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "task.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-9");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-9", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "task.txt"), "task-wi\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "task.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      // Dev "resolves" the conflict by writing a clean version of shared.txt.
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "merged resolution\n", "utf-8");

      // Commit with a narrow scope that does NOT include shared.txt. Scope
      // enforcement would normally revert it — but the merge bypass should
      // let the full set commit as-is and complete the merge.
      const result = gitCommitAll("complete merge + task work", wtDir, {
        modifyFiles: ["task.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, { projectDir, wiId: 9, branchName: "posse/wi-9" });

      assert.ok(result.hash);
      // After commit: no pending merge, no conflict markers remaining.
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "worktrees", "wi-9", "MERGE_HEAD")), false);
      const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(porcelain, "");
      const finalShared = fs.readFileSync(path.join(wtDir, "shared.txt"), "utf-8").replace(/\r\n/g, "\n");
      assert.equal(finalShared, "merged resolution\n");
      // Commit should have two parents (merge commit).
      const parents = execFileSync("git", ["log", "-1", "--pretty=%P"], { cwd: wtDir, encoding: "utf-8" }).trim().split(/\s+/);
      assert.equal(parents.length, 2, `expected merge commit with 2 parents, got: ${parents.join(" ")}`);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("refuses to commit when staged content still contains conflict markers", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-markers-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-11");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-11", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      // Dev "resolves" sloppily — leaves conflict markers in the file.
      fs.writeFileSync(
        path.join(wtDir, "shared.txt"),
        "<<<<<<< HEAD\nwi change\n=======\nmain change\n>>>>>>> main\n",
        "utf-8",
      );

      assert.throws(() => {
        gitCommitAll("complete merge", wtDir, {
          modifyFiles: ["shared.txt"],
          createFiles: [],
          deleteFiles: [],
          createRoots: [],
        }, { projectDir, wiId: 11, branchName: "posse/wi-11" });
      }, /conflict markers/i);

      // Merge should still be pending so the dev/fix cycle can retry.
      assert.equal(fs.existsSync(path.join(projectDir, ".git", "worktrees", "wi-11", "MERGE_HEAD")), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves MERGE_HEAD when secrets scan blocks a merge commit", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-secrets-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-13");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-13", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });
      fs.writeFileSync(
        path.join(wtDir, "shared.txt"),
        "SECRET_KEY=abcdefghijklmnopqrstuvwxyz123456\n",
        "utf-8",
      );

      assert.throws(() => {
        gitCommitAll("complete merge with secret", wtDir, {
          modifyFiles: ["shared.txt"],
          createFiles: [],
          deleteFiles: [],
          createRoots: [],
        }, { projectDir, wiId: 13, branchName: "posse/wi-13" });
      }, /secrets detected/i);

      assert.equal(fs.existsSync(path.join(projectDir, ".git", "worktrees", "wi-13", "MERGE_HEAD")), true);
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: wtDir, encoding: "utf-8" }).trim();
      assert.equal(staged, "shared.txt");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("quarantines edits outside scope and merge diff during scoped merge commits", async () => {
    const { gitCommitAll } = await import("../../../lib/domains/git/functions/commit-scope.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-commit-scope-audit-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "task.txt"), "task-base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "stray.txt"), "stray-base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "task.txt", "stray.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-12");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-12", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      fs.writeFileSync(path.join(wtDir, "task.txt"), "task-wi\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "task.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      fs.writeFileSync(path.join(wtDir, "shared.txt"), "merged resolution\n", "utf-8");
      // Dev also edits stray.txt — which is neither in scope nor brought in by merge.
      fs.writeFileSync(path.join(wtDir, "stray.txt"), "stray-tampered\n", "utf-8");

      const result = gitCommitAll("complete merge + task + stray", wtDir, {
        modifyFiles: ["task.txt"],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
      }, { projectDir, wiId: 12, branchName: "posse/wi-12" });

      assert.ok(result.hash);
      assert.equal(result.mergeCompleted, true);
      assert.equal(result.mergeAuditFailed, false);
      assert.equal(result.mergeAuditError, null);
      assert.ok(Array.isArray(result.outOfScopeMergeFiles));
      assert.ok(
        result.outOfScopeMergeFiles.includes("stray.txt"),
        `expected stray.txt in audit, got: ${JSON.stringify(result.outOfScopeMergeFiles)}`,
      );
      assert.ok(
        result.quarantinedOutOfScopeMergeFiles.includes("stray.txt"),
        `expected stray.txt to be quarantined, got: ${JSON.stringify(result.quarantinedOutOfScopeMergeFiles)}`,
      );
      // task.txt is in scope, shared.txt is brought in by merge — neither should flag.
      assert.equal(result.outOfScopeMergeFiles.includes("task.txt"), false);
      assert.equal(result.outOfScopeMergeFiles.includes("shared.txt"), false);
      const committedStray = execFileSync("git", ["show", "HEAD:stray.txt"], { cwd: wtDir, encoding: "utf-8" });
      assert.equal(committedStray, "stray-base\n");
      const worktreeStray = fs.readFileSync(path.join(wtDir, "stray.txt"), "utf-8");
      assert.equal(worktreeStray, "stray-tampered\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("detectPendingMerge returns paths relative to the worktree cwd", async () => {
    const { detectPendingMerge } = await import("../../../lib/domains/handoff/functions/index.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-relative-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.mkdirSync(path.join(projectDir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "sub", "nested.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "sub/nested.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-13");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-13", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "sub", "nested.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "sub/nested.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "sub", "nested.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "sub/nested.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      // Call detectPendingMerge from a nested cwd — paths should be relative to it.
      const nested = path.join(wtDir, "sub");
      const pending = detectPendingMerge(nested);
      assert.ok(pending);
      assert.ok(pending.conflicts.includes("nested.txt"), `expected path relative to ${nested}, got ${JSON.stringify(pending.conflicts)}`);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

});
