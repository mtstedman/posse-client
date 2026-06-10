import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { closeAccountSettingsDb, setAccountSettingsPathForTests } from "../lib/domains/settings/functions/account-settings.js";
import { stripAnsi } from "../lib/shared/format/functions/ansi.js";
import { listInputContextDirectories } from "../lib/domains/cli/functions/flags.js";
import { createWorkspaceSkipDirs, WORKSPACE_SKIP_DIRS } from "../lib/domains/runtime/functions/workspace-skip.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

const tempRoots = [];

function makeTempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(null);
  setRuntimePathOverridesForTests(null);
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("PR0 drift guardrails", () => {
  it("strips full CSI ANSI sequences, not only color codes", () => {
    assert.equal(stripAnsi(`a\x1b[38;5;208mhot\x1b[0m\x1b[2K`), "ahot");
  });

  it("defaults scheduler concurrency to the CLI/catalog value when unset", async () => {
    const root = makeTempRoot("posse-pr0-scheduler-");
    setAccountSettingsPathForTests(path.join(root, "account.db"));
    const { Scheduler } = await import("../lib/domains/scheduler/classes/Scheduler.js");

    const scheduler = new Scheduler({ ownerId: "test-default-concurrency", pollMs: 1, leaseSec: 1 });

    assert.equal(scheduler.concurrency, 3);
  });

  it("lists input contexts from the configured runtime resources directory", () => {
    const projectDir = makeTempRoot("posse-pr0-contexts-");
    const resourcesDir = path.join(projectDir, ".custom-resources");
    fs.mkdirSync(path.join(resourcesDir, "inputs", "alpha"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "resources", "inputs", "wrong"), { recursive: true });
    setRuntimePathOverridesForTests({ resourcesDir });

    const contexts = listInputContextDirectories(projectDir);

    assert.deepEqual(contexts, [
      { name: "alpha", relativeDir: ".custom-resources/inputs/alpha" },
    ]);
  });

  it("uses one workspace skip catalog for runtime prompt/tool scans", async () => {
    assert.equal(WORKSPACE_SKIP_DIRS.has(".posse"), true);
    assert.equal(WORKSPACE_SKIP_DIRS.has(".posse-worktrees"), true);
    assert.equal(WORKSPACE_SKIP_DIRS.has(".posse-test-suites"), true);
    assert.equal(createWorkspaceSkipDirs(["vendor"]).has("vendor"), true);

    const toolkitMod = await import("../lib/functions/toolkit/index.js");
    const briefMod = await import("../lib/functions/toolkit/brief.js");
    assert.equal(toolkitMod.DEFAULT_SKIP_DIRS.has(".posse"), true);
    assert.equal(toolkitMod.DEFAULT_SKIP_DIRS.has(".posse-test-suites"), true);

    const projectDir = makeTempRoot("posse-pr0-skip-");
    fs.mkdirSync(path.join(projectDir, ".posse", "resources", "inputs"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".posse", "resources", "inputs", "secret.md"), "runtime secret token\n", "utf-8");
    fs.writeFileSync(path.join(projectDir, "src", "app.md"), "runtime secret token\n", "utf-8");

    const pullBrief = briefMod.createPullBriefExecutor(toolkitMod.safePath);
    const scope = toolkitMod.buildScopePredicates(projectDir, {});
    const parsed = JSON.parse(pullBrief({
      mode: "tree_pull",
      query: "runtime secret token",
      max_files: 10,
    }, projectDir, scope));

    const paths = (parsed.files || []).map((entry) => entry.path);
    assert.equal(paths.some((entry) => entry.startsWith(".posse/")), false);
    assert.equal(paths.some((entry) => entry === "src/app.md"), true);
  });
});
