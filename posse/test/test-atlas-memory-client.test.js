import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAtlasMemoryClient } from "../lib/domains/integrations/functions/atlas-memory.js";

function makeMinimalEnabledConfig() {
  // Bypass settings DB: hand the memory client the minimum config it needs to
  // exercise repo resolution. requestedRepoPath/Id are left empty so the
  // resolver falls through to cwd-based git detection.
  return {
    enabled: true,
    requestedRepoPath: null,
    requestedRepoId: null,
  };
}

describe("getAtlasMemoryClient repo target", () => {
  it("resolves to the canonical repo target when invoked from a WI worktree cwd", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-memory-worktree-"));
    const repoDir = fs.realpathSync(tmpRoot);
    const worktreeDir = path.join(repoDir, ".posse-worktrees", "wi-99");

    const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: repoDir, encoding: "utf-8" });
    if (gitInit.status !== 0) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      return;
    }
    try {
      spawnSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      spawnSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "# repo\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-99-memory-target", worktreeDir], { cwd: repoDir, stdio: "ignore" });

      const config = makeMinimalEnabledConfig();
      const client = await getAtlasMemoryClient({ cwd: worktreeDir, config });

      // The runtime may or may not start in a test env; either way the client
      // must report the canonical repo target derived from the main repo path,
      // not the WI worktree path.
      assert.equal(client.repoId, path.basename(repoDir));
      assert.equal(client.repoPath, repoDir);
      assert.equal(client.repoSource, "cwd-linked-worktree");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns atlas_disabled without resolving when config.enabled is false", async () => {
    const client = await getAtlasMemoryClient({ cwd: process.cwd(), config: { enabled: false } });
    assert.equal(client.ok, false);
    assert.equal(client.skipped, "atlas_disabled");
    assert.equal(client.repoId, undefined);
  });
});
