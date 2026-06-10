import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "node:child_process";
import {
  POSSE_RUNTIME_IGNORE_HEADER,
  buildPosseRuntimeIgnoreEntries,
  ensurePosseGitInfoExclude,
  ensurePosseRuntimeIgnores,
} from "../lib/domains/runtime/functions/ignore.js";

function readTrimmedLines(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countLine(lines, wanted) {
  return lines.filter((line) => line === wanted).length;
}

describe("runtime ignore rules", () => {
  it("builds project-root relative runtime patterns", () => {
    const projectDir = path.join(os.tmpdir(), "posse-ignore-project", "apps", "demo");
    const entries = buildPosseRuntimeIgnoreEntries(projectDir, { anchorDir: projectDir });

    assert.ok(entries.includes(POSSE_RUNTIME_IGNORE_HEADER));
    assert.ok(entries.includes(".posse/"));
    assert.ok(entries.includes(".posse-worktrees/"));
    assert.ok(entries.includes(".posse-test-suites/"));
    assert.ok(entries.includes("db/"));
    assert.ok(entries.includes("resources/"));
    assert.ok(entries.includes("logs/"));
    assert.ok(entries.includes("*.db"));
    assert.ok(entries.includes("*.db-wal"));
    assert.ok(entries.includes("*.sqlite-wal"));
    assert.ok(entries.includes("*.sqlite3"));
    assert.ok(entries.includes("__pycache__/"));
    assert.ok(entries.includes("*.py[cod]"));
    assert.ok(entries.includes(".pytest_cache/"));
  });

  it("updates nested project .gitignore and repo-relative git info exclude idempotently", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-ignore-"));
    const projectDir = path.join(repoDir, "apps", "demo");
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });

      ensurePosseRuntimeIgnores(projectDir);
      ensurePosseRuntimeIgnores(projectDir);

      const gitignoreLines = readTrimmedLines(path.join(projectDir, ".gitignore"));
      assert.ok(gitignoreLines.includes(POSSE_RUNTIME_IGNORE_HEADER));
      assert.ok(gitignoreLines.includes(".posse/"));
      assert.ok(gitignoreLines.includes(".posse-worktrees/"));
      assert.ok(gitignoreLines.includes(".posse-test-suites/"));
      assert.ok(gitignoreLines.includes("db/"));
      assert.ok(gitignoreLines.includes("resources/"));
      assert.ok(gitignoreLines.includes("logs/"));
      assert.ok(gitignoreLines.includes("__pycache__/"));
      assert.ok(gitignoreLines.includes("*.py[cod]"));
      assert.ok(gitignoreLines.includes(".pytest_cache/"));
      assert.equal(countLine(gitignoreLines, ".posse/"), 1);
      assert.equal(countLine(gitignoreLines, "__pycache__/"), 1);
      assert.equal(countLine(gitignoreLines, "*.db-wal"), 1);

      const excludeLines = readTrimmedLines(path.join(repoDir, ".git", "info", "exclude"));
      assert.ok(excludeLines.includes("apps/demo/.posse/"));
      assert.ok(excludeLines.includes("apps/demo/.posse-worktrees/"));
      assert.ok(excludeLines.includes("apps/demo/.posse-test-suites/"));
      assert.ok(excludeLines.includes("apps/demo/db/"));
      assert.ok(excludeLines.includes("apps/demo/resources/"));
      assert.ok(excludeLines.includes("apps/demo/logs/"));
      assert.ok(excludeLines.includes("__pycache__/"));
      assert.ok(excludeLines.includes("*.py[cod]"));
      assert.equal(countLine(excludeLines, "apps/demo/.posse/"), 1);
      assert.equal(countLine(excludeLines, "__pycache__/"), 1);
      assert.equal(countLine(excludeLines, "*.db-wal"), 1);
      assert.equal(excludeLines.some((line) => line.includes(repoDir.replace(/\\/g, "/"))), false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not mutate an existing managed .gitignore block during routine runs", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-ignore-managed-"));
    const projectDir = path.join(repoDir, "apps", "demo");
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });

      const initialGitignore = [
        "node_modules/",
        "",
        POSSE_RUNTIME_IGNORE_HEADER,
        ".posse/",
        ".posse-worktrees/",
        "db/",
        "resources/",
        "logs/",
        "*.db",
        "*.db-shm",
        "*.db-wal",
      ].join("\n");
      fs.writeFileSync(path.join(projectDir, ".gitignore"), `${initialGitignore}\n`, "utf-8");

      ensurePosseRuntimeIgnores(projectDir);

      const afterGitignore = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8");
      assert.equal(afterGitignore, `${initialGitignore}\n`);

      const excludeLines = readTrimmedLines(path.join(repoDir, ".git", "info", "exclude"));
      assert.ok(excludeLines.includes("apps/demo/.posse/"));
      assert.ok(excludeLines.includes("apps/demo/.posse-test-suites/"));
      assert.ok(excludeLines.includes("*.sqlite3-wal"));
      assert.ok(excludeLines.includes("__pycache__/"));
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("updates git info exclude from a nested worktree project path", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-runtime-worktree-"));
    const projectDir = path.join(repoDir, "apps", "demo");
    const wtDir = path.join(repoDir, ".posse-worktrees", "wi-1");
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "README.md"), "hello\n", "utf-8");
      execFileSync("git", ["add", "apps/demo/README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      execFileSync("git", ["worktree", "add", "-b", "posse/wi-1", wtDir], { cwd: repoDir, stdio: "ignore" });
      ensurePosseGitInfoExclude(path.join(wtDir, "apps", "demo"));

      const excludeLines = readTrimmedLines(path.join(repoDir, ".git", "info", "exclude"));
      assert.ok(excludeLines.includes("apps/demo/.posse/"));
      assert.ok(excludeLines.includes("apps/demo/.posse-worktrees/"));
      assert.ok(excludeLines.includes("apps/demo/.posse-test-suites/"));
      assert.equal(excludeLines.some((line) => line.includes(wtDir.replace(/\\/g, "/"))), false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
