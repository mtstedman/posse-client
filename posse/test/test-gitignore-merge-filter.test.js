// test/test-gitignore-merge-filter.test.js
//
// Regression test for the auto-merge loop bug: a tracked-and-modified
// .gitignore whose diff is purely posse-runtime additions should NOT
// block auto-merge with "target worktree has 1 uncommitted change(s)".

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `posse-gitignore-${prefix}-`));
}

function initRepo(dir, initialIgnore) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "posse-test@example.com"]);
  git(dir, ["config", "user.name", "Posse Test"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), initialIgnore, "utf-8");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf-8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

function porcelain(dir) {
  return git(dir, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
}

function helpers(dir) {
  return createGitWorkflowHelpers({ projectDir: dir, targetBranch: "main" });
}

describe("isRuntimePorcelainLine: tracked-and-modified .gitignore", () => {
  let tmp;
  before(() => {
    tmp = makeTmp("modified");
  });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("filters a modified .gitignore whose diff is only posse-runtime additions", () => {
    initRepo(tmp, "node_modules/\n*.log\n");
    fs.appendFileSync(
      path.join(tmp, ".gitignore"),
      "\n# Posse runtime (auto-added)\nlogs/\n*.db-shm\n*.db-wal\n.posse/\n",
      "utf-8",
    );
    const lines = porcelain(tmp);
    const gitignoreLine = lines.find((l) => l.endsWith(".gitignore"));
    assert.ok(gitignoreLine, "expected .gitignore to appear in porcelain output");

    const h = helpers(tmp);
    assert.equal(h._isRuntimePorcelainLine(gitignoreLine), true);
  });

  it("treats a target branch with only posse-runtime .gitignore additions as clean", () => {
    const t = makeTmp("startup-clean");
    try {
      initRepo(t, "node_modules/\n*.log\n");
      fs.appendFileSync(
        path.join(t, ".gitignore"),
        "\n# Posse runtime (auto-added)\nlogs/\n*.db-shm\n*.db-wal\n.posse/\n",
        "utf-8",
      );
      const h = helpers(t);
      assert.equal(h.ensureCleanTargetBranch("startup cleanup", { fatalOnFailure: true }), true);
      assert.match(fs.readFileSync(path.join(t, ".gitignore"), "utf-8"), /Posse runtime/);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("does NOT filter a modified .gitignore that adds non-runtime patterns", () => {
    const t = makeTmp("real-edit");
    try {
      initRepo(t, "node_modules/\n");
      // Real user edit — adds an unrelated pattern.
      fs.appendFileSync(path.join(t, ".gitignore"), "secrets.env\n", "utf-8");
      const lines = porcelain(t);
      const gitignoreLine = lines.find((l) => l.endsWith(".gitignore"));
      assert.ok(gitignoreLine);
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine(gitignoreLine), false);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("does NOT filter a modified .gitignore that mixes runtime additions with a real change", () => {
    const t = makeTmp("mixed");
    try {
      initRepo(t, "node_modules/\n");
      fs.appendFileSync(
        path.join(t, ".gitignore"),
        "\n# Posse runtime (auto-added)\n.posse/\nlogs/\nsecrets.env\n",
        "utf-8",
      );
      const lines = porcelain(t);
      const gitignoreLine = lines.find((l) => l.endsWith(".gitignore"));
      assert.ok(gitignoreLine);
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine(gitignoreLine), false);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("does NOT filter a modified .gitignore that REMOVES an existing line", () => {
    const t = makeTmp("removal");
    try {
      initRepo(t, "node_modules/\ndelete-me/\n");
      // Remove "delete-me/" — that's a real user edit, must block merge.
      fs.writeFileSync(path.join(t, ".gitignore"), "node_modules/\n", "utf-8");
      const lines = porcelain(t);
      const gitignoreLine = lines.find((l) => l.endsWith(".gitignore"));
      assert.ok(gitignoreLine);
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine(gitignoreLine), false);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("still filters an UNTRACKED .gitignore that posse just created (legacy path)", () => {
    const t = makeTmp("untracked");
    try {
      git(t, ["init", "-b", "main"]);
      git(t, ["config", "user.email", "posse-test@example.com"]);
      git(t, ["config", "user.name", "Posse Test"]);
      fs.writeFileSync(path.join(t, "README.md"), "# test\n", "utf-8");
      git(t, ["add", "README.md"]);
      git(t, ["commit", "-m", "init"]);
      // Posse creates .gitignore in a previously-untracked repo.
      fs.writeFileSync(
        path.join(t, ".gitignore"),
        "# Posse runtime (auto-added)\n.posse/\n",
        "utf-8",
      );
      const lines = porcelain(t);
      const gitignoreLine = lines.find((l) => l.endsWith(".gitignore"));
      assert.ok(gitignoreLine);
      assert.ok(gitignoreLine.startsWith("??"), `expected untracked; got ${gitignoreLine}`);
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine(gitignoreLine), true);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("does NOT filter .posse/* paths via the .gitignore branch (they should hit the .posse rule earlier)", () => {
    const t = makeTmp("posse-dir");
    try {
      initRepo(t, "node_modules/\n");
      // Simulate an untracked .posse directory entry.
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine("?? .posse/"), true);
      assert.equal(h._isRuntimePorcelainLine("?? .posse/db/orchestrator.db"), true);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("does NOT filter unrelated tracked files even with the same porcelain shape", () => {
    const t = makeTmp("unrelated");
    try {
      initRepo(t, "node_modules/\n");
      fs.writeFileSync(path.join(t, "README.md"), "# changed\n", "utf-8");
      const lines = porcelain(t);
      const readmeLine = lines.find((l) => l.endsWith("README.md"));
      assert.ok(readmeLine);
      const h = helpers(t);
      assert.equal(h._isRuntimePorcelainLine(readmeLine), false);
    } finally {
      try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
    }
  });

  it("resolves target branch lazily for long-lived workflow helpers", () => {
    let branch = "main";
    const h = createGitWorkflowHelpers({
      projectDir: tmp,
      getTargetBranch: () => branch,
    });
    assert.equal(h._currentTargetBranch(), "main");
    branch = "master";
    assert.equal(h._currentTargetBranch(), "master");
  });
});
