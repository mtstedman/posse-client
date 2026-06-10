import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolvePushBranch } from "../lib/domains/git/functions/utils.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function initRepo(branch = "main") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-push-branch-"));
  git(dir, ["init", "-b", branch]);
  git(dir, ["config", "user.email", "posse-test@example.com"]);
  git(dir, ["config", "user.name", "Posse Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function fakeResolvePushBranchManager(result, capture = {}) {
  return {
    shouldUse(name) {
      capture.shouldUse = name;
      return true;
    },
    binary(name) {
      capture.binary = name;
      return {
        runSync(command, args, opts) {
          const envelope = JSON.parse(String(opts.input));
          capture.command = command;
          capture.args = args;
          capture.payload = envelope.payload;
          const json = { ok: true, data: result };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

describe("resolvePushBranch", () => {
  it("uses the configured target branch when it exists locally", () => {
    const repo = initRepo("main");
    try {
      const capture = {};
      const result = resolvePushBranch(repo, "main", {
        nativeParity: {
          manager: fakeResolvePushBranchManager(
            { branch: "main", fallback: false, missingBranch: null, reason: "target" },
            capture,
          ),
        },
      });
      assert.equal(result.branch, "main");
      assert.equal(result.fallback, false);
      assert.equal(result.reason, "target");
      assert.equal(capture.command, "git.resolvePushBranch");
      assert.deepEqual(capture.payload, { cwd: repo, targetBranch: "main", currentBranch: "", remote: "origin" });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to local main instead of pushing a missing master ref", () => {
    const repo = initRepo("main");
    try {
      const capture = {};
      const result = resolvePushBranch(repo, "master", {
        nativeParity: {
          manager: fakeResolvePushBranchManager(
            { branch: "main", fallback: true, missingBranch: "master", reason: "main" },
            capture,
          ),
        },
      });
      assert.equal(result.branch, "main");
      assert.equal(result.fallback, true);
      assert.equal(result.missingBranch, "master");
      assert.equal(capture.command, "git.resolvePushBranch");
      assert.deepEqual(capture.payload, { cwd: repo, targetBranch: "master", currentBranch: "", remote: "origin" });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to the current branch only after default branch candidates fail", () => {
    const repo = initRepo("feature/current");
    try {
      const capture = {};
      const result = resolvePushBranch(repo, "master", {
        currentBranch: "feature/current",
        nativeParity: {
          manager: fakeResolvePushBranchManager(
            { branch: "feature/current", fallback: true, missingBranch: "master", reason: "current" },
            capture,
          ),
        },
      });
      assert.equal(result.branch, "feature/current");
      assert.equal(result.fallback, true);
      assert.equal(result.reason, "current");
      assert.equal(capture.command, "git.resolvePushBranch");
      assert.deepEqual(capture.payload, {
        cwd: repo,
        targetBranch: "master",
        currentBranch: "feature/current",
        remote: "origin",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
