import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-startup-guard-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "posse-test@example.com"]);
  git(dir, ["config", "user.name", "Posse Test"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n", "utf-8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function helpers(dir) {
  return createGitWorkflowHelpers({ projectDir: dir, targetBranch: "main" });
}

function status(dir) {
  return git(dir, ["status", "--porcelain", "--untracked-files=all"]);
}

describe("startup dirty tree guard", () => {
  it("blocks startup when target-tree work is dirty by default", () => {
    const dir = makeRepo();
    try {
      fs.appendFileSync(path.join(dir, "tracked.txt"), "dirty\n", "utf-8");

      assert.throws(
        () => helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" }),
        /Startup dirty tree guard blocked test boot/,
      );
      assert.match(status(dir), /tracked\.txt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits current work before startup when policy is commit", () => {
    const dir = makeRepo();
    try {
      fs.appendFileSync(path.join(dir, "tracked.txt"), "dirty\n", "utf-8");
      fs.writeFileSync(path.join(dir, "untracked.js"), "console.log('new');\n", "utf-8");

      const result = helpers(dir).guardStartupDirtyTree({
        reason: "test boot",
        policy: "commit",
        message: "chore: test startup guard",
      });

      assert.equal(result.ok, true);
      assert.equal(result.action, "committed");
      assert.equal(result.dirtyCount, 2);
      assert.equal(status(dir), "");
      assert.equal(git(dir, ["log", "-1", "--pretty=%s"]), "chore: test startup guard");
      assert.equal(fs.readFileSync(path.join(dir, "untracked.js"), "utf-8"), "console.log('new');\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits an untracked directory without requiring recursive status output", () => {
    const dir = makeRepo();
    try {
      fs.mkdirSync(path.join(dir, "generated", "nested"), { recursive: true });
      fs.writeFileSync(path.join(dir, "generated", "nested", "one.js"), "export const one = 1;\n", "utf-8");
      fs.writeFileSync(path.join(dir, "generated", "two.js"), "export const two = 2;\n", "utf-8");

      const result = helpers(dir).guardStartupDirtyTree({
        reason: "test boot",
        policy: "commit",
        message: "chore: commit generated dir",
      });

      assert.equal(result.ok, true);
      assert.equal(result.action, "committed");
      assert.equal(status(dir), "");
      assert.equal(git(dir, ["ls-files", "generated/nested/one.js", "generated/two.js"]), "generated/nested/one.js\ngenerated/two.js");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can run the startup guard in the git workflow worker", async () => {
    const dir = makeRepo();
    try {
      fs.appendFileSync(path.join(dir, "tracked.txt"), "dirty\n", "utf-8");
      const phases = [];

      await assert.rejects(
        helpers(dir).guardStartupDirtyTreeInWorker({
          reason: "test boot",
          policy: "block",
          onPhase: (event) => phases.push(event.detail),
        }),
        /Startup dirty tree guard blocked test boot/,
      );

      assert.ok(phases.includes("checking target tree"));
      assert.match(status(dir), /tracked\.txt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors abort signals in the async startup guard", async () => {
    const dir = makeRepo();
    try {
      fs.appendFileSync(path.join(dir, "tracked.txt"), "dirty\n", "utf-8");
      const controller = new AbortController();
      controller.abort(new Error("boot stopped"));

      await assert.rejects(
        helpers(dir).guardStartupDirtyTreeAsync({
          reason: "test boot",
          policy: "commit",
          signal: controller.signal,
        }),
        (err) => {
          assert.equal(err.name, "AbortError");
          assert.equal(err.message, "boot stopped");
          return true;
        },
      );
      assert.match(status(dir), /tracked\.txt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs git workflow tasks off the main thread", async () => {
    const dir = makeRepo();
    try {
      const result = await helpers(dir).gitDiffStatAsync("HEAD", "main", dir);
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps an orphaned scip infer-tsconfig placeholder before the guard", () => {
    const dir = makeRepo();
    try {
      // The `{}` placeholder scip-typescript leaves behind on an interrupted index.
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}", "utf-8");
      assert.match(status(dir), /tsconfig\.json/);

      const result = helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" });

      assert.deepEqual(result, { ok: true, dirty: false, policy: "block", action: "clean" });
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), false, "placeholder should be removed");
      assert.equal(status(dir), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps the inferred-allowJs tsconfig signature too", () => {
    const dir = makeRepo();
    try {
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { allowJs: true } }),
        "utf-8",
      );
      const result = helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" });
      assert.equal(result.action, "clean");
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps the generated allowJs+exclude tsconfig (current shape)", () => {
    const dir = makeRepo();
    try {
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { allowJs: true }, exclude: ["node_modules", "dist", "**/*.min.js"] }),
        "utf-8",
      );
      const result = helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" });
      assert.equal(result.action, "clean");
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps the generated infer-tsconfig placeholder before target merge", () => withTempRuntimeDb(() => {
    const dir = makeRepo();
    try {
      git(dir, ["checkout", "-b", "posse/wi-merge"]);
      fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n", "utf-8");
      git(dir, ["add", "feature.txt"]);
      git(dir, ["commit", "-m", "feature"]);
      git(dir, ["checkout", "main"]);
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { allowJs: true }, exclude: ["node_modules", "dist", "**/*.min.js"] }),
        "utf-8",
      );

      const result = helpers(dir).gitMergeToTarget("posse/wi-merge", dir, { wiId: 1 });

      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), false);
      assert.equal(git(dir, ["show", "main:feature.txt"]), "feature");
      assert.equal(status(dir), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("never deletes a user tsconfig that merely has allowJs among other options", () => {
    const dir = makeRepo();
    try {
      const real = JSON.stringify({ compilerOptions: { allowJs: true, strict: true } });
      fs.writeFileSync(path.join(dir, "tsconfig.json"), real, "utf-8");
      assert.throws(
        () => helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" }),
        /Startup dirty tree guard blocked/,
      );
      assert.equal(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf-8"), real);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never deletes a tracked tsconfig.json, even when empty", () => {
    const dir = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}", "utf-8");
      git(dir, ["add", "tsconfig.json"]);
      git(dir, ["commit", "-m", "add tsconfig"]);
      // Now dirty it so the guard would run its checks.
      fs.appendFileSync(path.join(dir, "tracked.txt"), "dirty\n", "utf-8");

      assert.throws(
        () => helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" }),
        /Startup dirty tree guard blocked/,
      );
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), true, "tracked tsconfig must survive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never deletes an untracked tsconfig.json with real content", () => {
    const dir = makeRepo();
    try {
      const real = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } });
      fs.writeFileSync(path.join(dir, "tsconfig.json"), real, "utf-8");

      assert.throws(
        () => helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" }),
        /Startup dirty tree guard blocked/,
      );
      assert.equal(fs.existsSync(path.join(dir, "tsconfig.json")), true, "real user tsconfig must survive");
      assert.equal(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf-8"), real);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores posse runtime-only dirt", () => {
    const dir = makeRepo();
    try {
      fs.mkdirSync(path.join(dir, ".posse", "db"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".posse", "db", "orchestrator.db"), "runtime\n", "utf-8");

      const result = helpers(dir).guardStartupDirtyTree({ reason: "test boot", policy: "block" });

      assert.deepEqual(result, { ok: true, dirty: false, policy: "block", action: "clean" });
      assert.match(status(dir), /\.posse\/db\/orchestrator\.db/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
