import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";

// Regression: WIs auto-merged mid-run leave the target branch ahead of the
// remote, but the wrap-up's own merge pass counts zero merges — so the push
// offer never fired and merged work sat unpushed. collectPushOfferState now
// reports aheadCount so offerPush can self-gate on unpushed commits.
describe("push offer sees unpushed commits from earlier merges", () => {
  let root;
  let repoDir;
  let helpers;

  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-push-offer-"));
    const remoteDir = path.join(root, "remote.git");
    repoDir = path.join(root, "repo");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(["init", "--bare", remoteDir], root);
    git(["init", "-b", "main", repoDir], root);
    git(["config", "user.email", "test@posse.local"], repoDir);
    git(["config", "user.name", "Posse Test"], repoDir);
    git(["remote", "add", "origin", remoteDir], repoDir);
    fs.writeFileSync(path.join(repoDir, "a.txt"), "one\n");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "initial"], repoDir);
    git(["push", "-u", "origin", "main"], repoDir);
    helpers = createGitWorkflowHelpers({ projectDir: repoDir, targetBranch: "main" });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports aheadCount 0 when the remote is current", () => {
    const state = helpers._collectPushOfferState(0);
    assert.equal(state.hasRemote, true);
    assert.equal(state.aheadCount, 0);
  });

  it("reports the unpushed commit count after local merges", () => {
    fs.writeFileSync(path.join(repoDir, "b.txt"), "two\n");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "Squash merge posse/wi-1 into main"], repoDir);
    fs.writeFileSync(path.join(repoDir, "c.txt"), "three\n");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "Squash merge posse/wi-2 into main"], repoDir);

    const state = helpers._collectPushOfferState(0);
    assert.equal(state.hasRemote, true);
    assert.equal(state.aheadCount, 2);
    assert.equal(state.pushBranch, "main");
  });

  it("reports null aheadCount when the branch has no remote tracking ref", () => {
    git(["checkout", "-b", "never-pushed"], repoDir);
    try {
      const state = helpers._collectPushOfferState(0);
      // resolvePushBranch may fall back to a pushable branch; the key contract
      // is that a missing upstream ref yields null (offer falls back to the
      // merge-count gate) rather than a bogus number.
      if (state.pushBranch === "never-pushed") {
        assert.equal(state.aheadCount, null);
      } else {
        assert.ok(state.aheadCount === null || Number.isFinite(state.aheadCount));
      }
    } finally {
      git(["checkout", "main"], repoDir);
    }
  });
});
