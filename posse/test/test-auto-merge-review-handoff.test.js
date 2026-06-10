import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReviewSession } from "../lib/domains/cli/functions/review-session.js";

const C_STUB = {
  red: "", green: "", yellow: "", cyan: "", dim: "", bold: "", reset: "",
};

describe("ReviewSession._listMergeFailedAfterAutoMerge", () => {
  it("returns only complete/failed WIs with merge_state=merge_failed and a branch_name", () => {
    const work_items = [
      { id: 1, status: "complete", branch_name: "posse/wi-1", merge_state: "merge_failed", title: "A" },
      { id: 2, status: "complete", branch_name: "posse/wi-2", merge_state: "merged", title: "B" },
      { id: 3, status: "complete", branch_name: null, merge_state: "merge_failed", title: "C (no branch)" },
      { id: 4, status: "failed", branch_name: "posse/wi-4", merge_state: "merge_failed", title: "D" },
      { id: 5, status: "queued", branch_name: "posse/wi-5", merge_state: "merge_failed", title: "E (still queued)" },
      { id: 6, status: "complete", branch_name: "posse/wi-6", merge_state: "pending_review", title: "F" },
    ];
    const listWorkItems = (statuses) => {
      const allowed = new Set(Array.isArray(statuses) ? statuses : [statuses]);
      return work_items.filter((wi) => allowed.has(wi.status));
    };

    const session = new ReviewSession({ listWorkItems });
    const result = session._listMergeFailedAfterAutoMerge();
    assert.deepEqual(result.map((wi) => wi.id), [1, 4]);
  });

  it("returns empty array when listWorkItems throws", () => {
    const listWorkItems = () => { throw new Error("db down"); };
    const session = new ReviewSession({ listWorkItems });
    assert.deepEqual(session._listMergeFailedAfterAutoMerge(), []);
  });
});

describe("ReviewSession._announceDirtyTargetBeforeAutoMerge", () => {
  it("logs to console when target is dirty (no display)", () => {
    const calls = [];
    const origLog = console.log;
    console.log = (msg) => calls.push(String(msg));
    try {
      const session = new ReviewSession({
        C: C_STUB,
        PROJECT_DIR: "/tmp/x",
        TARGET_BRANCH: "main",
        worktreeStatusFn: () => ({
          targetDirty: true,
          targetFiles: [{ path: "a.txt", status: " M" }, { path: "b.txt", status: "??" }],
        }),
      });
      session._announceDirtyTargetBeforeAutoMerge();
    } finally {
      console.log = origLog;
    }
    assert.ok(calls.some((line) => line.includes("Target branch main has 2 uncommitted")), calls.join("\n"));
    assert.ok(calls.some((line) => line.includes("[t]")), "should mention the stash key");
  });

  it("emits a display event when target is dirty and a display is provided", () => {
    const events = [];
    const display = { addEvent: (msg) => events.push(msg) };
    const session = new ReviewSession({
      C: C_STUB,
      PROJECT_DIR: "/tmp/x",
      TARGET_BRANCH: "main",
      worktreeStatusFn: () => ({ targetDirty: true, targetFiles: [{ path: "a", status: " M" }] }),
    });
    session._announceDirtyTargetBeforeAutoMerge(display);
    assert.equal(events.length, 1);
    assert.match(events[0], /Target branch main has 1 uncommitted/);
  });

  it("is silent when target is clean", () => {
    const events = [];
    const display = { addEvent: (msg) => events.push(msg) };
    const session = new ReviewSession({
      C: C_STUB,
      PROJECT_DIR: "/tmp/x",
      TARGET_BRANCH: "main",
      worktreeStatusFn: () => ({ targetDirty: false, targetFiles: [] }),
    });
    session._announceDirtyTargetBeforeAutoMerge(display);
    assert.equal(events.length, 0);
  });

  it("is silent when worktreeStatusFn is not configured", () => {
    const events = [];
    const display = { addEvent: (msg) => events.push(msg) };
    const session = new ReviewSession({ C: C_STUB, PROJECT_DIR: "/tmp/x", TARGET_BRANCH: "main" });
    session._announceDirtyTargetBeforeAutoMerge(display);
    assert.equal(events.length, 0);
  });

  it("swallows worktreeStatusFn errors", () => {
    const events = [];
    const display = { addEvent: (msg) => events.push(msg) };
    const session = new ReviewSession({
      C: C_STUB,
      PROJECT_DIR: "/tmp/x",
      TARGET_BRANCH: "main",
      worktreeStatusFn: () => { throw new Error("git crashed"); },
    });
    session._announceDirtyTargetBeforeAutoMerge(display);
    assert.equal(events.length, 0);
  });
});
