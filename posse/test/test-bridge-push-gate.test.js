// Push-offer gates: persistence as human_input jobs, gate-kind mapping,
// work-item status isolation, supersede semantics, and the git.push bridge
// command. Command logic is exercised through the deps seam (always runs);
// the real-git end-to-end variants probe for the native git daemon and skip
// where it is unavailable (it requires the posse-git heartbeat environment,
// which `node --test` sandboxes typically lack — same constraint as
// test-push-offer-unpushed.test.js).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  cancelOpenPushOfferGates,
  findOpenPushOfferJob,
  upsertPushOfferGate,
} from "../lib/domains/queue/functions/push-offer.js";
import {
  createWorkItem,
  getJob,
  refreshWorkItemStatus,
  getWorkItem,
  updateWorkItemStatus,
} from "../lib/domains/queue/functions/index.js";
import { isPushOfferJob } from "../lib/domains/queue/functions/common.js";
import { executeGitPushGate } from "../lib/domains/bridge/functions/git-push-gate.js";
import { answerHumanInput } from "../lib/domains/bridge/functions/human-input-answer.js";
import { normalizeGate, collectStateSnapshot } from "../lib/domains/bridge/functions/state-snapshot.js";
import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

function initGitFixture(root) {
  const remoteDir = path.join(root, "remote.git");
  fs.mkdirSync(remoteDir, { recursive: true });
  git(["init", "--bare", remoteDir], root);
  git(["init", "-b", "main", root], root);
  git(["config", "user.email", "test@posse.local"], root);
  git(["config", "user.name", "Posse Test"], root);
  git(["remote", "add", "origin", remoteDir], root);
  // The bare remote and posse runtime live inside the repo root in this
  // fixture — keep the tree clean for the pre-push gate.
  fs.writeFileSync(path.join(root, ".gitignore"), "remote.git/\n.posse/\n");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(["add", ".gitignore", "a.txt"], root);
  git(["commit", "-m", "initial"], root);
  git(["push", "-u", "origin", "main"], root);
  return { remoteDir };
}

function addUnpushedCommit(root, name) {
  fs.writeFileSync(path.join(root, name), `${name}\n`);
  git(["add", name], root);
  git(["commit", "-m", `Squash merge posse/${name} into main`], root);
}

function nativeGitAvailable(root) {
  try {
    const helpers = createGitWorkflowHelpers({ projectDir: root, targetBranch: "main" });
    helpers._collectPushOfferState(0);
    return true;
  } catch {
    return false;
  }
}

function pushOfferState(overrides = {}) {
  return {
    hasRemote: true,
    pushBranch: "main",
    effectiveRemote: "origin",
    targetBranch: "main",
    aheadCount: 2,
    mergedCount: 1,
    workingTreeStatus: "",
    unmergedWIs: [],
    ...overrides,
  };
}

function anchorWorkItem() {
  const wi = createWorkItem("anchor", "desc");
  updateWorkItemStatus(wi.id, "complete");
  return wi;
}

describe("push-offer gates", () => {
  it("persists as a push-kind gate without disturbing work-item status", () => withTempRuntimeDb(() => {
    const wi = anchorWorkItem();

    const created = upsertPushOfferGate(pushOfferState(), { createdBy: "test" });
    assert.equal(created.ok, true);
    const job = getJob(created.jobId);
    assert.equal(job.status, "waiting_on_human");
    assert.equal(isPushOfferJob(job), true);

    const gate = normalizeGate(job);
    assert.equal(gate.kind, "push");
    assert.equal(gate.payload.ahead_count, 2);
    assert.equal(gate.payload.push_branch, "main");

    // The open gate appears in snapshots…
    const snapshot = collectStateSnapshot({ headEventId: 0 });
    assert.ok(snapshot.open_gates.some((g) => g.job_id === created.jobId && g.kind === "push"));

    // …but does NOT drag the completed work item back to waiting_on_human.
    refreshWorkItemStatus(wi.id);
    assert.equal(getWorkItem(wi.id).status, "complete");
  }));

  it("supersedes the previous offer (singleton) and cancels at run boot", () => withTempRuntimeDb(() => {
    anchorWorkItem();
    const first = upsertPushOfferGate(pushOfferState({ aheadCount: 1 }), { createdBy: "test" });
    const second = upsertPushOfferGate(pushOfferState({ aheadCount: 3 }), { createdBy: "test" });
    assert.notEqual(first.jobId, second.jobId);
    assert.equal(getJob(first.jobId).status, "canceled");
    assert.equal(findOpenPushOfferJob().id, second.jobId);

    const canceled = cancelOpenPushOfferGates("superseded_by_new_run");
    assert.equal(canceled, 1);
    assert.equal(findOpenPushOfferJob(), null);
    assert.equal(getJob(second.jobId).status, "canceled");
  }));

  it("skips gate creation when there is nothing to push or no work item", () => withTempRuntimeDb(() => {
    assert.equal(upsertPushOfferGate(pushOfferState()).reason, "no_work_item");
    anchorWorkItem();
    assert.equal(
      upsertPushOfferGate(pushOfferState({ aheadCount: 0, mergedCount: 0 })).reason,
      "nothing_to_push",
    );
    assert.equal(
      upsertPushOfferGate(pushOfferState({ hasRemote: false })).reason,
      "no_push_target",
    );
  }));

  it("git.push command logic: push, stale-close, decline, ask-block, failure-keeps-open", () => withTempRuntimeDb(async (root) => {
    anchorWorkItem();
    const created = upsertPushOfferGate(pushOfferState(), { createdBy: "test" });

    // ask must not answer push gates.
    const asked = await answerHumanInput(created.jobId, { answer: "yes" }, { projectDir: root });
    assert.equal(asked.ok, false);
    assert.equal(asked.reason, "use_git_push");

    // Failure keeps the gate open and surfaces redacted output.
    const failed = await executeGitPushGate(created.jobId, {}, { projectDir: root }, {
      collectState: () => pushOfferState({ aheadCount: 2 }),
      push: () => ({ ok: false, reason: "gate_failed", output: "tests failed\ntoken=sk-abc123secretvalue" }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "gate_failed");
    assert.ok(!String(failed.message || "").includes("sk-abc123secretvalue"), "git output must be redacted");
    assert.equal(getJob(created.jobId).status, "waiting_on_human", "failed push keeps the gate open");

    // Success closes the gate with the push result.
    const pushedArgs = [];
    const ok = await executeGitPushGate(created.jobId, {}, { projectDir: root }, {
      collectState: () => pushOfferState({ aheadCount: 2 }),
      push: (args) => {
        pushedArgs.push(args);
        return { ok: true, effectiveRemote: args.effectiveRemote, pushBranch: args.pushBranch };
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.pushed, true);
    assert.deepEqual(pushedArgs[0], { effectiveRemote: "origin", pushBranch: "main", mergedCount: 1 });
    assert.equal(getJob(created.jobId).status, "succeeded");

    // Stale offer (someone pushed manually) closes as already-up-to-date.
    const stale = upsertPushOfferGate(pushOfferState({ aheadCount: 1 }), { createdBy: "test" });
    const upToDate = await executeGitPushGate(stale.jobId, {}, { projectDir: root }, {
      collectState: () => pushOfferState({ aheadCount: 0 }),
      push: () => { throw new Error("must not push when up to date"); },
    });
    assert.equal(upToDate.ok, true);
    assert.equal(upToDate.already_up_to_date, true);
    assert.equal(getJob(stale.jobId).status, "succeeded");

    // Decline cancels; answering a closed gate fails cleanly.
    const declineGate = upsertPushOfferGate(pushOfferState({ aheadCount: 1 }), { createdBy: "test" });
    const declined = await executeGitPushGate(declineGate.jobId, { decline: true }, { projectDir: root });
    assert.equal(declined.ok, true);
    assert.equal(declined.declined, true);
    assert.equal(getJob(declineGate.jobId).status, "canceled");
    const closed = await executeGitPushGate(declineGate.jobId, {}, { projectDir: root });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, "gate_closed");

    // Unknown job id.
    const missing = await executeGitPushGate(999999, {}, { projectDir: root });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "no_such_gate");
  }));

  it("git.push pushes real commits when the native git daemon is available", (t) => withTempRuntimeDb(async (root) => {
    const { remoteDir } = initGitFixture(root);
    if (!nativeGitAvailable(root)) {
      t.skip("posse-git native daemon unavailable in this test environment");
      return;
    }
    addUnpushedCommit(root, "wi-1.txt");
    addUnpushedCommit(root, "wi-2.txt");
    anchorWorkItem();
    const created = upsertPushOfferGate(pushOfferState(), { createdBy: "test" });

    const result = await executeGitPushGate(created.jobId, {}, { projectDir: root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.pushed, true);
    assert.equal(getJob(created.jobId).status, "succeeded");
    assert.equal(git(["rev-list", "--count", "main"], remoteDir), "3");
  }));

  it("offerPush persists the gate and returns without prompting on non-TTY stdin", (t) => withTempRuntimeDb(async (root) => {
    initGitFixture(root);
    if (!nativeGitAvailable(root)) {
      t.skip("posse-git native daemon unavailable in this test environment");
      return;
    }
    addUnpushedCommit(root, "wi-5.txt");
    anchorWorkItem();

    // node --test runs with a non-TTY stdin, which is exactly the headless
    // case that used to hang forever on the readline prompt.
    assert.ok(!process.stdin.isTTY, "test harness stdin must be non-TTY for this regression test");
    const helpers = createGitWorkflowHelpers({ projectDir: root, targetBranch: "main" });
    await helpers.offerPush(0);

    const gate = findOpenPushOfferJob();
    assert.ok(gate, "offerPush must persist a push gate for the phone");
    assert.equal(normalizeGate(gate).kind, "push");
  }));
});
