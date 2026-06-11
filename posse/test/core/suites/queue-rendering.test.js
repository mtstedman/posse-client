import {
  it,
  before,
  beforeEach,
  after,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
  withAccountSettingsPath,
  writeAccountSettingsDb,
  withClaudeConfigDir,
  AdminTUI,
  Display,
  computeRenderMinGap,
  displayColumnWidth,
  fitDisplay,
  stripDisplayAnsi,
} from "../support/core-harness.js";
import { _buildQueueProviderUsageLines } from "../../../lib/domains/ui/functions/display/helpers/provider-usage.js";
import {
  POSSE_MASCOT_CELL_HEIGHT,
  POSSE_MASCOT_CELL_WIDTH,
  renderPosseMascotFrame,
} from "../../../lib/domains/ui/functions/display/helpers/mascot.js";

let db;

suite("Queue Rendering", () => {
  function plain(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, "");
  }

  function approvalReportItem(id) {
    return {
      wi: {
        id,
        title: `Review item ${id}`,
        status: "complete",
        priority: "normal",
        branch_name: `posse/wi-${id}`,
      },
      jobs: [],
      agentCalls: [],
      worktreeStatus: {
        targetDirty: false,
        targetFiles: [],
        wtDir: null,
        wtExists: false,
        wtFiles: [],
      },
    };
  }

  beforeEach(() => { resetRuntimeDb(); });

  it("keeps approval review on the current work item while deferred git work runs", () => {
    const display = new Display({ concurrency: 3 });
    display.requestRender = () => {};
    display._approvalData = [
      { wi: { id: 1 }, _isInfo: false },
      { wi: { id: 2 }, _isInfo: false },
    ];
    display._approvalIdx = 0;
    display._approvalTabScrolls = [0, 0, 0, 0];
    display.onApprovalAction = () => ({ deferAdvance: true });

    display._onApprovalKeypress("a", { name: "a" });

    assert.equal(display._approvalData[0]._decision, "approved");
    assert.equal(display._approvalIdx, 0);

    display._approvalActionBusy = true;
    display._approvalIdx = 1;
    display._onApprovalKeypress("a", { name: "a" });
    assert.equal(display._approvalData[1]._decision, undefined);

    display._approvalActionBusy = false;
    display._approvalIdx = 0;
    display._advanceApproval();
    assert.equal(display._approvalIdx, 1);
  });

  it("clamps stale approval selection when review data shrinks", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 100;
    display.rows = 24;
    display.requestRender = () => {};
    display._approvalData = [approvalReportItem(1)];
    display._approvalIdx = 4;
    display._approvalScroll = 99;
    display._approvalTabScrolls = [99, 0, 0, 0];
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => {
      actionSeen = { wiId, action };
      return true;
    };

    const originalWrite = process.stdout.write;
    const writes = [];
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      display._renderApproval();
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(display._approvalIdx, 0);
    assert.equal(display._approvalScroll, 0);
    assert.ok(plain(writes.join("")).includes("WI#1:"));

    display._approvalIdx = 4;
    display._onApprovalKeypress("a", { name: "a", sequence: "a" });
    assert.deepEqual(actionSeen, { wiId: 1, action: "approve" });
    assert.equal(display._approvalData[0]._decision, "approved");
  });

  it("resolves pending approval review when input is canceled", async () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const done = display.enterApprovalMode([{ wi: { id: 1 }, _isInfo: false }], 0);

    display.cancelAllQuestions();

    const resolved = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.deepEqual(resolved, { canceled: true });
    assert.equal(display._approvalDone, null);
  });

  it("abandons discard picker state when approval review is canceled", async () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const item = {
      wi: { id: 1 },
      _isInfo: false,
      worktreeStatus: { wtFiles: [{ path: "stray.txt", status: "??", inScope: false, untracked: true }] },
    };
    const done = display.enterApprovalMode([item], 0);
    display._startDiscardPicker(item, item.worktreeStatus.wtFiles);

    assert.ok(display._approvalPicker);
    display.cancelAllQuestions();

    const resolved = await done;
    assert.deepEqual(resolved, { canceled: true });
    assert.equal(display._approvalPicker, null);
  });

  it("surfaces approval action feedback before a decision is recorded", () => {
    const display = new Display({ concurrency: 0 });
    const lines = display._buildTabTasks({
      wi: {
        id: 12,
        title: "Review feedback",
        status: "complete",
        priority: "normal",
        branch_name: "posse/wi-12",
      },
      jobs: [],
      _mergeResult: "! Target branch is already clean",
      worktreeStatus: {
        targetBranch: "master",
        targetDirty: false,
        targetFiles: [],
        wtDir: null,
        wtExists: false,
        wtFiles: [],
      },
    }, 100).map(plain).join("\n");

    assert.ok(lines.includes("Action:"));
    assert.ok(lines.includes("Target branch is already clean"));
  });

  it("routes discard key to an explanatory no-op when nothing is discardable", () => {
    const display = new Display({ concurrency: 0 });
    let actionSeen = null;
    display.requestRender = () => {};
    display._approvalData = [{
      wi: { id: 12 },
      worktreeStatus: {
        wtFiles: [{ path: "src/app.js", status: " M", inScope: true }],
      },
    }];
    display._approvalIdx = 0;
    display._approvalTabScrolls = [0, 0, 0, 0];
    display.onApprovalAction = (wiId, action) => {
      actionSeen = { wiId, action };
      return { deferAdvance: true };
    };

    display._onApprovalKeypress("x", { name: "x" });

    assert.deepEqual(actionSeen, { wiId: 12, action: "discard_dirty" });
    assert.equal(display._approvalPicker, null);
  });

  it("accepts key-name-only review menu signals", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    display._approvalData = [
      { wi: { id: 12 }, _isInfo: false },
      { wi: { id: 13 }, _isInfo: false },
    ];
    display._approvalIdx = 0;
    display._approvalTabScrolls = [0, 0, 0, 0];
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => {
      actionSeen = { wiId, action };
      return true;
    };

    display._onApprovalKeypress("", { name: "a", sequence: "" });

    assert.deepEqual(actionSeen, { wiId: 12, action: "approve" });
    assert.equal(display._approvalData[0]._decision, "approved");
    assert.equal(display._approvalIdx, 1);
  });

  it("accepts key-name-only discard picker signals", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const item = {
      wi: { id: 12 },
      worktreeStatus: {
        wtFiles: [{ path: "scratch.txt", status: "??", inScope: false, untracked: true }],
      },
    };
    display._approvalData = [item];
    display._approvalIdx = 0;
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => { actionSeen = { wiId, action }; };
    display._startDiscardPicker(item, item.worktreeStatus.wtFiles);

    display._onApprovalPickerKeypress("", { name: "space", sequence: "" });
    display._onApprovalPickerKeypress("", { name: "enter", sequence: "" });

    assert.deepEqual(actionSeen, {
      wiId: 12,
      action: { kind: "discard_files", paths: ["scratch.txt"] },
    });
    assert.equal(display._approvalPicker, null);
  });

  it("discards the focused file when picker enter has no checked files", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const item = {
      wi: { id: 12 },
      worktreeStatus: {
        wtFiles: [{ path: "scratch.txt", status: "??", inScope: false, untracked: true }],
      },
    };
    display._approvalData = [item];
    display._approvalIdx = 0;
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => { actionSeen = { wiId, action }; };
    display._startDiscardPicker(item, item.worktreeStatus.wtFiles);

    display._onApprovalPickerKeypress("", { name: "enter", sequence: "" });

    assert.deepEqual(actionSeen, {
      wiId: 12,
      action: { kind: "discard_files", paths: ["scratch.txt"] },
    });
    assert.equal(display._approvalPicker, null);
  });

  it("uses x to open the discard picker without rebinding review tab digits", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const item = {
      wi: { id: 12 },
      worktreeStatus: {
        wtFiles: [
          { path: "first.txt", status: "M", inScope: false, untracked: false },
          { path: "second.txt", status: "??", inScope: false, untracked: true },
        ],
      },
    };
    display._approvalData = [item];
    display._approvalIdx = 0;
    display._approvalTab = 0;
    display._approvalTabScrolls = [0, 0, 0, 0];
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => { actionSeen = { wiId, action }; };

    display._onApprovalKeypress("2", { name: "2", sequence: "2" });

    assert.equal(display._approvalTab, 1);
    assert.equal(display._approvalPicker, null);

    display._onApprovalKeypress("x", { name: "x", sequence: "x" });
    display._onApprovalKeypress("j", { name: "j", sequence: "j" });
    display._onApprovalKeypress(" ", { name: "space", sequence: " " });
    display._onApprovalKeypress("", { name: "enter", sequence: "" });

    assert.deepEqual(actionSeen, {
      wiId: 12,
      action: { kind: "discard_files", paths: ["second.txt"] },
    });
    assert.equal(display._approvalPicker, null);
  });

  it("uses x to select target dirty files when no WI worktree exists", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    const item = {
      wi: { id: 12 },
      worktreeStatus: {
        wtDir: null,
        wtExists: false,
        wtFiles: [],
        targetFiles: [
          { path: "tsconfig.json", status: "??", untracked: true },
        ],
      },
    };
    display._approvalData = [item];
    display._approvalIdx = 0;
    display._approvalTabScrolls = [0, 0, 0, 0];
    let actionSeen = null;
    display.onApprovalAction = (wiId, action) => { actionSeen = { wiId, action }; };

    display._onApprovalKeypress("x", { name: "x", sequence: "x" });
    assert.ok(display._approvalPicker);
    assert.equal(display._approvalPicker.candidates[0].location, "target");

    display._onApprovalKeypress("", { name: "enter", sequence: "" });

    assert.deepEqual(actionSeen, {
      wiId: 12,
      action: {
        kind: "discard_files",
        paths: ["tsconfig.json"],
        files: [{ path: "tsconfig.json", location: "target" }],
        location: "target",
      },
    });
    assert.equal(display._approvalPicker, null);
  });

  it("keeps the blocking overlay stable across spinner ticks", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 90;
    display.rows = 24;
    display._blockingOverlay = { title: "Merging....", subtitle: "WI#7 - please wait" };

    display._spinIdx = 0;
    const first = display._applyBlockingOverlay("");
    display._spinIdx = 1;
    const second = display._applyBlockingOverlay("");

    assert.equal(second, first);
    assert.ok(plain(first).includes("! Merging...."));
  });

  it("does not advance background animation behind blocking overlays", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 90;
    display.rows = 24;
    display._started = true;
    display._blockingOverlay = {
      kind: "wrapup",
      title: "Review startup",
      subtitle: "Checking completed work before opening review.",
      startedAt: Date.now(),
      steps: [{ id: "review", label: "Load review queue", status: "running" }],
    };
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      display.render({ advanceAnimation: true });
      assert.equal(display._spinIdx, 0);

      display._blockingOverlay = null;
      display.render({ advanceAnimation: true });
      assert.equal(display._spinIdx, 1);
    } finally {
      display._started = false;
      process.stdout.write = originalWrite;
    }
  });

  it("freezes the backing frame while a blocking overlay is visible", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 90;
    display.rows = 24;
    display._started = true;
    display._blockingOverlay = {
      kind: "wrapup",
      title: "Run wrap-up",
      subtitle: "Still winding down.",
      startedAt: 1_000,
      steps: [{ id: "review", label: "Load review queue", status: "running" }],
    };
    const originalNow = Date.now;
    const originalWrite = process.stdout.write;
    const writes = [];
    Date.now = () => 2_000;
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      display.render();
      const frozen = display._blockingOverlayBaseFrame;
      display.events.push({ time: "12:00:00", text: "background event should not repaint under overlay" });
      display.render();

      assert.equal(display._blockingOverlayBaseFrame, frozen);
      assert.equal(writes.length, 1);
    } finally {
      display._started = false;
      Date.now = originalNow;
      process.stdout.write = originalWrite;
    }
  });

  it("renders a wrap-up overlay with heartbeat and checklist state", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 100;
    display.rows = 30;
    display._spinIdx = 1;
    display._blockingOverlay = {
      kind: "wrapup",
      title: "Review closeout",
      subtitle: "Finishing review work before returning to the queue.",
      startedAt: Date.now() - 2500,
      steps: [
        { id: "git", label: "Finish queued git work", status: "running" },
        { id: "report", label: "Save review report", status: "done", detail: "2 reports" },
        { id: "return", label: "Return to queue", status: "pending" },
      ],
    };

    const rendered = plain(display._applyBlockingOverlay(""));

    assert.ok(rendered.includes("Review closeout"));
    assert.ok(rendered.includes("heartbeat"));
    assert.ok(rendered.includes("Progress only - no choice needed here; Ctrl+C interrupts."));
    assert.ok(rendered.includes("Finish queued git work"));
    assert.ok(rendered.includes("Save review report - 2 reports"));
    assert.ok(rendered.includes("Return to queue"));
  });

  it("renders the wrap-up running step as cycling progress", () => {
    const display = new Display({ concurrency: 0 });
    display.cols = 100;
    display.rows = 30;
    const originalNow = Date.now;
    try {
      display._blockingOverlay = {
        kind: "wrapup",
        title: "Run wrap-up",
        subtitle: "Still winding down.",
        startedAt: 1_000_000,
        steps: [
          { id: "git", label: "Finish queued git work", status: "running" },
          { id: "report", label: "Save review report", status: "pending" },
        ],
      };

      Date.now = () => 1_000_000;
      display._spinIdx = 0;
      const first = display._applyBlockingOverlay("");
      Date.now = () => 1_000_250;
      display._spinIdx = 1;
      const second = display._applyBlockingOverlay("");

      assert.notEqual(second, first);
      assert.ok(plain(first).includes("heartbeat"));
      assert.ok(plain(first).includes("| Finish queued git work"));
      assert.ok(plain(second).includes("/ Finish queued git work"));
      assert.equal(plain(first).includes("> Finish queued git work"), false);
    } finally {
      Date.now = originalNow;
    }
  });

  it("ignores non-interrupt keys while a blocking overlay is visible", () => {
    const display = new Display({ concurrency: 0 });
    let renders = 0;
    let approvals = 0;
    display.requestRender = () => { renders++; };
    display._blockingOverlay = {
      kind: "wrapup",
      title: "Run wrap-up",
      subtitle: "Still winding down.",
      startedAt: Date.now(),
      steps: [{ id: "git", label: "Finish queued git work", status: "running" }],
    };
    display.onInject = () => {};
    display._onKeypress("i", { name: "i", sequence: "i" });

    assert.equal(display._inputMode, false);
    assert.equal(renders, 1);

    display._mode = "approval";
    display._approvalData = [{ wi: { id: 7 }, _isInfo: false }];
    display._approvalIdx = 0;
    display.onApprovalAction = () => { approvals++; };
    display._onKeypress("a", { name: "a", sequence: "a" });

    assert.equal(approvals, 0);
    assert.equal(display._approvalData[0]._decision, undefined);
  });

  it("keeps the overlay delta base when blocking overlay text changes", () => {
    const display = new Display({ concurrency: 0 });
    display._blockingOverlay = { title: "Long overlay title", subtitle: "Long subtitle" };
    display._lastFrameBase = "cached-base";
    display._blockingOverlayBaseFrame = "cached-overlay-base";

    display.setBlockingOverlay("Short", "");

    assert.equal(display._lastFrameBase, "cached-base");
    assert.equal(display._blockingOverlayBaseFrame, "cached-overlay-base");
  });

  it("refreshes dirty review state while using scheduler queue snapshots", () => {
    const display = new Display({ concurrency: 0 });
    const originalNow = Date.now;
    let nowMs = 10_000;
    const states = [
      { dirtyItems: [{ wiId: 1, issues: [{ type: "dirty", files: "a.txt" }] }] },
      { dirtyItems: [{ wiId: 2, issues: [{ type: "dirty", files: "b.txt" }] }] },
    ];
    let reads = 0;
    Date.now = () => nowMs;
    display.getDirtyState = () => states[Math.min(reads++, states.length - 1)];
    try {
      display.acceptQueueSnapshot({ generation: 1, workItems: [], jobs: [] });
      assert.equal(display._getQueueData().dirtyState.dirtyItems[0].wiId, 1);

      nowMs += 6000;
      display.acceptQueueSnapshot({ generation: 2, workItems: [], jobs: [] });
      assert.equal(display._getQueueData().dirtyState.dirtyItems[0].wiId, 2);
    } finally {
      Date.now = originalNow;
    }
  });

  it("skips repaints for duplicate scheduler queue snapshots", () => {
    const display = new Display({ concurrency: 0 });
    const renderReasons = [];
    display.requestRender = ({ reason = "general" } = {}) => {
      renderReasons.push(reason);
    };
    const snapshot = {
      generation: 7,
      workItems: [{ id: 1, status: "running", title: "Smooth handoff" }],
      jobs: [{ id: 2, work_item_id: 1, job_type: "dev", status: "leased", title: "Implement" }],
    };

    assert.equal(display.acceptQueueSnapshot(snapshot), true);
    assert.equal(display.acceptQueueSnapshot({ ...snapshot, at: Date.now() + 1 }), false);
    assert.deepEqual(renderReasons, ["queue-snapshot"]);

    assert.equal(display.acceptQueueSnapshot({
      ...snapshot,
      jobs: [{ ...snapshot.jobs[0], status: "succeeded" }],
    }), true);
    assert.deepEqual(renderReasons, ["queue-snapshot", "queue-snapshot"]);
  });

  it("kills the worker shown at the visible kill-menu number after stale entries disappear", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    display._inputMode = "kill";
    display._killJobIds = [101, 102, 103];
    display.workers.set(101, { role: "dev", activity: "first", startTime: Date.now() });
    display.workers.set(103, { role: "assessor", activity: "third", startTime: Date.now() });
    const killed = [];
    display.onKill = (jobId) => { killed.push(jobId); };

    display._onKeypress("2", { name: "2", sequence: "2" });

    assert.deepEqual(killed, [103]);
  });

  it("prunes lifecycle start dedupe keys when workers complete", () => {
    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};
    display.setWorker(77, {
      role: "dev",
      activity: "started",
      workItemId: 9,
      emitStart: false,
    });
    display.addEvent("[dev] WI#9 job #77: started");
    assert.equal(display._lifecycleStartedJobs.has("job:77"), true);

    display.removeWorker(77, "succeeded");

    assert.equal(display._lifecycleStartedJobs.has("job:77"), false);
  });

  it("approval tasks hide ATLAS warm work and preview dirty target files", () => {
    const display = new Display({ concurrency: 0 });
    const lines = display._buildTabTasks({
      wi: {
        id: 7,
        title: "Review dirty target",
        status: "complete",
        priority: "normal",
        branch_name: null,
      },
      jobs: [
        { id: 1, job_type: "dev", title: "Implement feature", status: "succeeded", model_tier: "cheap" },
        { id: 3, job_type: "research", title: "Research feature", status: "succeeded", model_tier: "cheap" },
        { id: 2, job_type: "atlas_warm", title: "ATLAS warm: background", status: "succeeded", model_tier: "cheap" },
      ],
      writeSteps: [{
        id: 1,
        type: "dev",
        title: "Implement feature",
        status: "succeeded",
        writes: { files: ["src/app.js"], commitHashes: ["abcdef1"], observations: [] },
      }],
      researchSteps: [{
        id: 3,
        type: "research",
        title: "Research feature",
        status: "succeeded",
        writes: { files: [], commitHashes: [], observations: [] },
      }],
      worktreeStatus: {
        wtDir: null,
        wtExists: false,
        wtFiles: [],
        wtStashes: 0,
        sourceBranch: null,
        sourceDir: null,
        targetBranch: "master",
        targetDir: "C:\\repo\\project",
        targetDirty: true,
        targetFiles: [
          { status: " M", path: "src/app.js", untracked: false, diff: { summary: "+2/-1" } },
          { status: "??", path: "notes/todo.md", untracked: true, diff: null },
        ],
        scope: { files: ["src/app.js"], roots: [] },
      },
      gitDiff: [],
      filesToModify: [],
      plannedWriteFiles: ["src/app.js"],
      filesActuallyWritten: ["src/app.js"],
      agentCalls: [],
      totalDuration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalCostUsd: 0,
    }, 132).map(plain).join("\n");

    assert.ok(lines.includes("2 passed"));
    assert.ok(lines.includes("Write Steps"));
    assert.ok(lines.includes("Research / Review Steps"));
    assert.ok(lines.includes("wrote 1: src/app.js"));
    assert.equal(lines.includes("atlas_warm"), false);
    assert.ok(lines.includes("Target:"));
    assert.ok(lines.includes("master dirty (2)"));
    assert.ok(lines.includes("Final Assessment: BLOCKED"));
    assert.ok(lines.includes("Blocking files (2):"));
    assert.ok(lines.includes("target untracked"));
    assert.ok(lines.includes("C:\\repo\\project"));
    assert.ok(lines.includes("src/app.js"));
    assert.ok(lines.includes("+2/-1"));
    assert.ok(lines.includes("git -C \"C:\\repo\\project\" diff HEAD -- <file>"));
  });

  it("approval details hide system and ATLAS maintenance events from the review log", () => {
    const display = new Display({ concurrency: 0 });
    const lines = display._buildTabDetails({
      wi: {
        id: 9,
        title: "Review event log",
        status: "complete",
        priority: "normal",
        branch_name: "posse/wi-9",
      },
      jobs: [
        { id: 11, job_type: "dev", title: "Implement event-visible change", status: "succeeded", model_tier: "cheap" },
        { id: 12, job_type: "atlas_warm", title: "ATLAS warm: background", status: "succeeded", model_tier: "cheap" },
      ],
      events: [
        { event_type: "atlas.indexed", actor_type: "atlas", message: "Indexed branch view", created_at: "2026-05-21T01:00:00.000Z" },
        { event_type: "work_item.approved", actor_type: "system", message: "Auto-approved by system", created_at: "2026-05-21T01:01:00.000Z" },
        { event_type: "job.completed", actor_type: "dev", message: "Implemented visible change", created_at: "2026-05-21T01:02:00.000Z" },
      ],
      reviewArtifacts: [],
      humanAnswers: [],
    }, 120).map(plain).join("\n");

    assert.ok(lines.includes("Implemented visible change"));
    assert.equal(lines.includes("Indexed branch view"), false);
    assert.equal(lines.includes("Auto-approved by system"), false);
    assert.equal(lines.includes("atlas_warm"), false);
  });

  it("keeps display event tunables fixed after construction", () => {
    runtimeModules.queueMod.setSetting("posse_display_max_events", "10");
    runtimeModules.queueMod.setSetting("posse_display_event_rate_limit_per_sec", "100");

    const display = new Display({ concurrency: 0 });
    display.requestRender = () => {};

    runtimeModules.queueMod.setSetting("posse_display_max_events", "20");
    runtimeModules.queueMod.setSetting("posse_display_event_rate_limit_per_sec", "200");
    for (let i = 0; i < 15; i++) display.addEvent(`event ${i}`);

    assert.equal(display.maxEvents, 10);
    assert.equal(display._eventRateLimitPerSec, 100);
    assert.equal(display.events.length, 10);
  });

  it("renders the western mascot as a bounded terminal lane", () => {
    const laneWidth = POSSE_MASCOT_CELL_WIDTH + 10;
    const rows = renderPosseMascotFrame({ tick: 8, laneWidth });

    assert.equal(rows.length, POSSE_MASCOT_CELL_HEIGHT);
    assert.ok(rows.some((line) => /[\u2801-\u28ff]/u.test(stripDisplayAnsi(line))));
    assert.deepEqual(rows.map((line) => displayColumnWidth(line)), [laneWidth, laneWidth, laneWidth]);
  });

  it("keeps the western mascot silhouette on one stable color", () => {
    const colors = {
      reset: "</>",
      dim: "<dust>",
      orange: "<horse>",
      yellow: "<yellow>",
      brightWhite: "<rider>",
      white: "<white>",
    };
    const rendered = [0, 3, 8, 18, 28].flatMap((tick) =>
      renderPosseMascotFrame({ tick, laneWidth: POSSE_MASCOT_CELL_WIDTH + 12, colors }) || []
    ).join("\n");

    assert.ok(rendered.includes("<horse>"));
    assert.equal(rendered.includes("<rider>"), false);
    assert.equal(rendered.includes("<white>"), false);
  });

  it("adds the western working mascot to the wide right-panel header", () => {
    const display = new Display({ concurrency: 0 });
    display._buildRunClockLine = () => null;
    display._spinIdx = 8;

    const header = display._buildRight(86, 8).slice(0, 3);
    const plainHeader = header.map((line) => stripDisplayAnsi(line)).join("\n");

    assert.ok(/[\u2801-\u28ff]/u.test(plainHeader));
    assert.deepEqual(header.map((line) => displayColumnWidth(line)), [86, 86, 86]);
  });

  it("keeps file-lock detail rows out of the worker pane", () => {
    const display = new Display({ concurrency: 3 });
    display._blockedByLock = 1;
    display._blockedByLockDetails = [{
      job_id: 201,
      work_item_id: 24,
      path: "htdocs/_partials/header.php",
      holder_type: "work_item",
      holder_id: 23,
      holder_merge_state: "pending_review",
      message: "#201 waits on htdocs/_partials/header.php; held by WI#23 pending review",
    }];

    const lines = display._buildLeft(100, 16).map(plain);

    assert.ok(lines.some((line) => line.includes("1 waiting on file lock")));
    assert.equal(lines.some((line) => line.includes("#201 waits on htdocs/_partials/header.php")), false);
  });

  it("shows terminal wrap-up state instead of no jobs yet after all jobs finish", () => {
    const display = new Display({ concurrency: 3 });
    display.setRunPhase("Merging WI#12 into main");
    display._getQueueData = () => ({
      workItems: [{
        id: 12,
        status: "complete",
        merge_state: "pending_review",
        branch_name: "posse/wi-12",
      }],
      jobs: [{
        id: 201,
        work_item_id: 12,
        job_type: "dev",
        title: "Done job",
        status: "succeeded",
        assessor_verdict: "pass",
      }],
    });

    const line = display._buildProgressBar(100).map(plain).join("\n");

    assert.equal(line.includes("No jobs yet"), false);
    assert.ok(line.includes("All jobs complete"));
    assert.ok(line.includes("Merging WI#12 into main"));
  });

  it("keeps dirty terminal work items visible as needing review", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 12,
        title: "Dirty terminal WI",
        status: "failed",
        branch_name: "posse/wi-12",
      }],
      jobs: [{
        id: 201,
        work_item_id: 12,
        job_type: "dev",
        title: "Dead lettered job",
        status: "dead_letter",
      }],
      dirtyState: {
        targetDirty: false,
        dirtyItems: [{
          wiId: 12,
          title: "Dirty terminal WI",
          branchName: "posse/wi-12",
          issues: [{
            type: "dirty",
            message: "1 uncommitted change(s) in worktree",
            files: " M src/app.js",
          }],
        }],
      },
    });

    const queue = display._buildQueue(90, 12).map(plain).join("\n");

    assert.ok(queue.includes("WI#12"));
    assert.ok(queue.includes("needs review"));
    assert.ok(queue.includes("1 dirty"));
  });

  it("does not label dirty work as needing human review while assessment is active", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 74,
        title: "Fix weak view_as validation",
        status: "running",
        branch_name: "posse/wi-74",
      }],
      jobs: [
        {
          id: 321,
          work_item_id: 74,
          job_type: "dev",
          title: "First validation fix",
          status: "succeeded",
        },
        {
          id: 322,
          work_item_id: 74,
          job_type: "dev",
          title: "Fix weak view_as validation",
          status: "awaiting_assessment",
        },
      ],
      dirtyState: {
        targetDirty: false,
        dirtyItems: [{
          wiId: 74,
          title: "Fix weak view_as validation",
          branchName: "posse/wi-74",
          issues: [{
            type: "stash",
            message: "1 stash in worktree",
          }],
        }],
      },
    });

    const queue = display._buildQueue(100, 12).map(plain).join("\n");

    assert.ok(queue.includes("WI#74"));
    assert.ok(queue.includes("1 assessing"));
    assert.ok(queue.includes("stash"));
    assert.equal(queue.includes("needs review"), false);
  });

  it("keeps similar clipped queued job titles distinguishable in the queue", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 74,
        title: "Fix weak view_as validation",
        status: "running",
        branch_name: "posse/wi-74",
      }],
      jobs: [
        {
          id: 321,
          work_item_id: 74,
          job_type: "dev",
          title: "Fix weak view_as validation in recordings and schedules",
          status: "queued",
        },
        {
          id: 322,
          work_item_id: 74,
          job_type: "dev",
          title: "Fix weak view_as validation and remove GET-handler inline duplicate",
          status: "queued",
        },
      ],
      dirtyState: null,
    });

    const queueLines = display._buildQueue(44, 8).map(plain);
    const first = queueLines.find((line) => line.includes("#321")) || "";
    const second = queueLines.find((line) => line.includes("#322")) || "";

    assert.ok(first.includes("recordings"), first);
    assert.ok(second.includes("remove"), second);
    assert.notEqual(first, second);
  });

  it("shows the distinguishing middle segment for same-prefix migration jobs", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 43,
        title: "Do a bug fix sweep",
        status: "running",
        branch_name: "posse/wi-43",
      }],
      jobs: [
        {
          id: 488,
          work_item_id: 43,
          job_type: "dev",
          title: "Migrate legacy fail_request() -> json_error() for brief/catalog/config/industries endpoints",
          status: "queued",
        },
        {
          id: 489,
          work_item_id: 43,
          job_type: "dev",
          title: "Migrate legacy fail_request() -> json_error() for leaderboard/metrics/signals endpoints",
          status: "queued",
        },
      ],
      dirtyState: null,
    });

    const queueLines = display._buildQueue(52, 8).map(plain);
    const first = queueLines.find((line) => line.includes("#488")) || "";
    const second = queueLines.find((line) => line.includes("#489")) || "";

    assert.ok(first.includes("brief"), first);
    assert.ok(second.includes("leaderboard"), second);
    assert.notEqual(first, second);
  });

  it("collapses background context jobs into a single health line", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 12,
        title: "Build the site",
        status: "running",
      }],
      jobs: [
        {
          id: 201,
          work_item_id: 12,
          job_type: "dev",
          title: "Build home page",
          status: "queued",
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: 300 + i,
          work_item_id: 12,
          job_type: "atlas_warm",
          title: "ATLAS warm: dev-leased fallback",
          status: i === 0 ? "running" : "queued",
          payload_json: JSON.stringify({
            purpose: "wi",
            work_item_id: 12,
            branch: "wi-12",
            _atlas_event_count: i === 1 ? 3 : 1,
          }),
        })),
      ],
    });

    const queue = display._buildQueue(90, 16).map(plain).join("\n");
    const progress = display._buildProgressBar(90).map(plain).join("\n");

    assert.ok(queue.includes("Context health"));
    assert.ok(queue.includes("Context prep"));
    assert.ok(queue.includes("1 running"));
    assert.ok(queue.includes("6 queued"));
    const queueLines = queue.split("\n");
    const healthIdx = queueLines.findIndex((line) => line.includes("Context health"));
    const warmIdx = queueLines.findIndex((line) => line.includes("Context prep"));
    const dividerIdx = queueLines.findIndex((line) => /^\s*\u2500+$/.test(line));
    const queueIdx = queueLines.findIndex((line) => line.trim() === "Queue");
    const wiIdx = queueLines.findIndex((line) => line.includes("WI#12"));
    assert.ok(healthIdx >= 0 && warmIdx > healthIdx);
    assert.ok(dividerIdx > warmIdx);
    assert.ok(queueIdx > dividerIdx);
    assert.ok(wiIdx > queueIdx);
    assert.equal(queue.includes("ATLAS warm: dev-leased fallback"), false);
    assert.equal(queue.includes("#300"), false);
    assert.ok(queue.includes("#201"));
    assert.equal(progress.includes("1/6"), false);
  });

  it("separates graph cleanup from active context prep debt", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [],
      jobs: [
        {
          id: 401,
          work_item_id: 40,
          job_type: "atlas_warm",
          title: "ATLAS warm: prepare WI view",
          status: "queued",
          payload_json: JSON.stringify({ purpose: "wi", work_item_id: 40, branch: "wi-40" }),
        },
        {
          id: 402,
          work_item_id: 41,
          job_type: "atlas_warm",
          title: "ATLAS warm: WI cleanup view disposal",
          status: "queued",
          payload_json: JSON.stringify({ purpose: "wi-cleanup", work_item_id: 41, branch: "wi-41" }),
        },
      ],
    });

    const queue = display._buildQueue(90, 12).map(plain).join("\n");
    const progress = display._buildProgressBar(90).map(plain).join("\n");

    assert.ok(queue.includes("Context health"));
    assert.ok(queue.includes("Context prep"));
    assert.ok(queue.includes("Cleanup"));
    assert.equal(queue.includes("ATLAS maintenance"), false);
    assert.equal(queue.includes("2 queued"), false);
    assert.ok(progress.includes("Context health"));
    assert.ok(progress.includes("Context prep"));
    assert.ok(progress.includes("Cleanup"));
  });

  it("shows nominal context health when no warm work is active", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 22,
        title: "Build dashboard",
        status: "running",
      }],
      jobs: [{
        id: 501,
        work_item_id: 22,
        job_type: "dev",
        title: "Build dashboard widgets",
        status: "queued",
      }],
    });

    const queueLines = display._buildQueue(90, 12).map(plain);
    const healthIdx = queueLines.findIndex((line) => line.includes("Context health"));
    const nominalIdx = queueLines.findIndex((line) => line.includes("Ready"));
    const dividerIdx = queueLines.findIndex((line) => /^\s*\u2500+$/.test(line));
    const queueIdx = queueLines.findIndex((line) => line.trim() === "Queue");
    const wiIdx = queueLines.findIndex((line) => line.includes("WI#22"));

    assert.ok(healthIdx >= 0);
    assert.ok(nominalIdx > healthIdx);
    assert.ok(dividerIdx > nominalIdx);
    assert.ok(queueIdx > dividerIdx);
    assert.ok(wiIdx > queueIdx);
  });

  it("shows scheduler file-lock details in the live tools report", () => {
    const display = new Display({ concurrency: 3 });
    display._blockedByLock = 1;
    display._blockedByLockDetails = [{
      job_id: 201,
      work_item_id: 24,
      path: "htdocs/_partials/header.php",
      holder_type: "work_item",
      holder_id: 23,
      holder_merge_state: "pending_review",
      message: "#201 waits on htdocs/_partials/header.php; held by WI#23 pending review",
    }];
    display.getToolData = () => ({
      jobs: [],
      recent: [],
      activeLocks: {
        work_items: [{
          work_item_id: 23,
          path: "htdocs/_partials/header.php",
          lock_kind: "file",
          source_job_id: 224,
          work_item_status: "complete",
          merge_state: "pending_review",
        }],
        jobs: [{
          job_id: 224,
          work_item_id: 23,
          path: "htdocs/run-results.php",
          lock_kind: "file",
          job_type: "dev",
          job_status: "running",
        }],
      },
    });

    display._toolsTab = 2;
    const lines = display._buildTools([], 120, 20).map(plain);

    const text = lines.join("\n");
    // Active locks grouped by WI: holder job + file path, nothing else.
    assert.ok(lines.some((line) => line.includes("Active locks") && line.includes("2 files") && line.includes("1 WI")));
    assert.ok(lines.some((line) => line.includes("WI #23") && line.includes("pending review")));
    assert.ok(lines.some((line) => line.includes("#224") && line.includes("htdocs/_partials/header.php")));
    assert.ok(lines.some((line) => line.includes("#224") && line.includes("htdocs/run-results.php")));
    // Active locks only: the waiting/blocking forecast is gone from this pane.
    assert.equal(lines.some((line) => line.includes("Current blocking locks")), false);
    assert.equal(lines.some((line) => line.includes("Waiting on")), false);
    // Redundant columns (role / status / kind, per-tier tables) are gone.
    assert.equal(lines.some((line) => line.includes("Job locks")), false);
    assert.equal(lines.some((line) => line.includes("WI locks")), false);
    assert.equal(/\bRole\b/.test(text), false);
    assert.equal(/\bKind\b/.test(text), false);
    assert.equal(/\bStatus\b/.test(text), false);
    assert.equal(text.includes("running"), false);
    assert.equal(lines.some((line) => line.includes("Global locks")), false);
    assert.equal(lines.some((line) => line.includes("Internal locks")), false);
  });

  it("does not show queued job reservations as active locks", () => {
    const display = new Display({ concurrency: 3 });
    display.getToolData = () => ({
      jobs: [],
      recent: [],
      activeLocks: {
        work_items: [],
        jobs: [
          {
            job_id: 273,
            work_item_id: 72,
            work_item_title: "Improve the UX",
            work_item_status: "running",
            path: "apps/web/public/cyberpunk",
            lock_kind: "root",
            job_type: "promote",
            job_status: "queued",
          },
          {
            job_id: 274,
            work_item_id: 72,
            work_item_title: "Improve the UX",
            work_item_status: "running",
            path: "apps/web/src/App.tsx",
            lock_kind: "file",
            job_type: "dev",
            job_status: "running",
          },
        ],
      },
    });

    display._toolsTab = 2;
    const lines = display._buildTools([], 120, 20).map(plain);

    assert.ok(lines.some((line) => line.includes("Active locks") && line.includes("1 file")));
    assert.ok(lines.some((line) => line.includes("WI #72") && line.includes("Improve the UX")));
    assert.ok(lines.some((line) => line.includes("#274") && line.includes("apps/web/src/App.tsx")));
    assert.equal(lines.some((line) => line.includes("#273")), false);
    assert.equal(lines.some((line) => line.includes("apps/web/public/cyberpunk")), false);
  });

  it("does not show queued WI reservations as active locks", () => {
    const display = new Display({ concurrency: 3 });
    display.getToolData = () => ({
      jobs: [],
      recent: [],
      activeLocks: {
        work_items: [
          {
            work_item_id: 72,
            work_item_title: "Improve the UX",
            work_item_status: "running",
            path: "apps/web/src/Future.tsx",
            lock_kind: "file",
            source_job_id: 273,
            source_job_status: "queued",
          },
          {
            work_item_id: 72,
            work_item_title: "Improve the UX",
            work_item_status: "running",
            path: "apps/web/src/Active.tsx",
            lock_kind: "file",
            source_job_id: 274,
            source_job_status: "running",
          },
        ],
        jobs: [],
      },
    });

    display._toolsTab = 2;
    const lines = display._buildTools([], 120, 20).map(plain);

    assert.ok(lines.some((line) => line.includes("Active locks") && line.includes("1 file")));
    assert.ok(lines.some((line) => line.includes("WI #72")));
    assert.ok(lines.some((line) => line.includes("#274") && line.includes("apps/web/src/Active.tsx")));
    assert.equal(lines.some((line) => line.includes("apps/web/src/Future.tsx")), false);
    assert.equal(lines.some((line) => line.includes("#273")), false);
  });

  it("collapses identical held locks in the live tools report", () => {
    const display = new Display({ concurrency: 3 });
    const wiLock = {
      work_item_id: 23,
      path: "src/shared.php",
      lock_kind: "file",
      source_job_id: 224,
      work_item_status: "running",
      merge_state: "running",
    };
    const jobLock = {
      job_id: 224,
      work_item_id: 23,
      path: "src/shared.php",
      lock_kind: "file",
      job_type: "dev",
      job_status: "running",
    };
    display.getToolData = () => ({
      jobs: [],
      recent: [],
      activeLocks: {
        work_items: [{ ...wiLock }, { ...wiLock }],
        jobs: [{ ...jobLock }, { ...jobLock }],
      },
    });

    display._toolsTab = 2;
    const lines = display._buildTools([], 120, 20).map(plain);

    // Same holder + same path across both lock tiers collapses to one row.
    assert.ok(lines.some((line) => line.includes("Active locks") && line.includes("1 file")));
    assert.ok(lines.some((line) => line.includes("WI #23")));
    const sharedRows = lines.filter((line) => line.includes("src/shared.php"));
    assert.equal(sharedRows.length, 1);
    assert.ok(sharedRows[0].includes("#224"));
  });

  it("keeps WI-only locks compact in the live tools report", () => {
    const display = new Display({ concurrency: 3 });
    display.getToolData = () => ({
      jobs: [],
      recent: [],
      activeLocks: {
        work_items: [
          {
            work_item_id: 42,
            work_item_title: "Do a bug fix sweep for any issues in the API or code base, then fix the bugs",
            path: "htdocs/api/industry-runs.php",
            lock_kind: "file",
            source_job_id: 458,
            work_item_status: "complete",
            merge_state: "pending_review",
          },
          {
            work_item_id: 42,
            work_item_title: "Do a bug fix sweep for any issues in the API or code base, then fix the bugs",
            path: "htdocs/api/scans.php",
            lock_kind: "file",
            source_job_id: 456,
            work_item_status: "complete",
            merge_state: "pending_review",
          },
        ],
        jobs: [],
      },
    });

    display._toolsTab = 2;
    const lines = display._buildTools([], 120, 20).map(plain);

    assert.ok(lines.some((line) => line.includes("Active locks") && line.includes("2 files")));
    assert.ok(lines.some((line) => line.includes("WI #42") && line.includes("pending review")));
    assert.ok(lines.some((line) => line.includes("Do a bug fix sweep")));
    assert.ok(lines.some((line) => line.includes("#458") && line.includes("htdocs/api/industry-runs.php")));
    assert.ok(lines.some((line) => line.includes("#456") && line.includes("htdocs/api/scans.php")));
    assert.equal(lines.some((line) => line.includes("Job locks")), false);
    assert.equal(lines.some((line) => line.includes("WI locks")), false);
    assert.equal(lines.some((line) => line.includes("Global locks")), false);
    assert.equal(lines.some((line) => line.includes("Internal locks")), false);
  });

  it("separates admin lock diagnostics into waiting, WI locks, and job locks by WI", () => {
    const { queueMod } = runtimeModules;
    const holderWi = queueMod.createWorkItem("Lock holder WI", "desc");
    const waitingWi = queueMod.createWorkItem("Waiting WI", "desc");
    const holder = queueMod.createJob({
      work_item_id: holderWi.id,
      job_type: "dev",
      title: "Edit shared file",
      payload_json: {
        task_mode: "code",
        files_to_modify: ["src/shared.js"],
      },
    });
    const waiting = queueMod.createJob({
      work_item_id: waitingWi.id,
      job_type: "dev",
      title: "Edit shared file too",
      payload_json: {
        task_mode: "code",
        files_to_modify: ["src/shared.js"],
      },
    });

    assert.ok(queueMod.acquireLeaseWithWriteLocks(holder, "sched", 60)?.leaseToken);

    // The dedicated admin Locks tab is gone (the live TUI tools report covers
    // it); the snapshot still feeds the non-interactive admin overview.
    const admin = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    const snapshot = admin._getAdminLockSnapshot();

    const waitRow = snapshot.waiting.find((row) => row.waiting.jobId === waiting.id);
    assert.ok(waitRow, "waiting job should be classified as blocked on a lock");
    assert.equal(waitRow.waiting.workItemId, waitingWi.id);
    assert.match(waitRow.waiting.scope, /src\/shared\.js/);
    // The lease takes both WI- and job-level locks; the conflict reports the
    // WI lock as the holder, while the job lock shows up in jobLocks.
    assert.match(waitRow.holder.label, new RegExp(`WI#${holderWi.id}`));
    assert.match(waitRow.holder.detail, /Lock holder WI/);
    assert.ok(snapshot.jobLocks.some((lock) => Number(lock.job_id) === holder.id));
  });

  it("shows web tool invocations in the live tools report", () => {
    const display = new Display({ concurrency: 3 });
    display.getToolData = () => ({
      jobs: [{
        job_id: 401,
        work_item_id: 51,
        job_type: "research",
        total: 2,
        tool_types: "tool.web_search,tool.web_fetch",
      }],
      recent: [
        {
          job_id: 401,
          work_item_id: 51,
          observation_type: "tool.web_search",
          summary: "WebSearch: Codex web search docs",
          created_at: "2026-04-12T11:00:01.000Z",
        },
        {
          job_id: 401,
          work_item_id: 51,
          observation_type: "tool.web_fetch",
          summary: "WebFetch: https://docs.example.test",
          created_at: "2026-04-12T11:00:02.000Z",
        },
      ],
      activeLocks: { work_items: [], jobs: [] },
    });

    display._toolsTab = 0;
    const toolLines = display._buildTools([], 120, 20).map(plain);
    assert.ok(toolLines.some((line) => line.includes("web_search") && line.includes("Codex web search docs")));
    assert.equal(toolLines.some((line) => line.includes("web_search") && line.includes("WebSearch:")), false);
    assert.ok(toolLines.some((line) => line.includes("web_fetch") && line.includes("https://docs.example.test")));
    assert.equal(toolLines.some((line) => line.includes("web_fetch") && line.includes("WebFetch:")), false);

    display._toolsTab = 1;
    const roleLines = display._buildTools([], 120, 20).map(plain);
    assert.ok(roleLines.some((line) => line.includes("research") && line.includes("web_search") && line.includes("web_fetch")));
  });

  it("omits repeated tool labels from recent invocation summaries", () => {
    const display = new Display({ concurrency: 3 });
    display.getToolData = () => ({
      jobs: [],
      recent: [
        {
          job_id: 453,
          work_item_id: 51,
          observation_type: "tool.search",
          summary: 'Search: "from src"',
          created_at: "2026-04-12T11:00:01.000Z",
        },
        {
          job_id: 453,
          work_item_id: 51,
          observation_type: "tool.chain_verdict",
          summary: "ChainReview: src/server.js pass",
          created_at: "2026-04-12T11:00:02.000Z",
        },
        {
          job_id: 453,
          work_item_id: 51,
          observation_type: "tool.atlas",
          summary: "ATLAS atlas.code.needWindow src/server.js",
          created_at: "2026-04-12T11:00:03.000Z",
        },
      ],
      activeLocks: { work_items: [], jobs: [] },
    });

    display._toolsTab = 0;
    const lines = display._buildTools([], 120, 20).map(plain);
    const searchLine = lines.find((line) => line.includes("search"));
    const chainLine = lines.find((line) => line.includes("chain_verdict"));
    const atlasLine = lines.find((line) => line.includes("code.needWindow"));

    assert.ok(searchLine?.includes('"from src"'));
    assert.equal(searchLine?.includes("Search:"), false);
    assert.ok(chainLine?.includes("src/server.js pass"));
    assert.equal(chainLine?.includes("ChainReview:"), false);
    assert.ok(atlasLine?.includes("atlas"));
    assert.ok(atlasLine?.includes("code.needWindow"));
    assert.equal(atlasLine?.includes("atlas.code.needWindow"), false);
    assert.equal(/\batlas\s+ATLAS\b/.test(atlasLine || ""), false);
    assert.equal(/atlas\s+atlas/i.test(atlasLine || ""), false);
  });

  it("groups blocked worker slot labels by scheduler holder type", () => {
    const display = new Display({ concurrency: 4 });
    display._blockedByLock = 3;
    display._blockedByLockDetails = [
      {
        job_id: 301,
        work_item_id: 41,
        path: "active_worktrees/2/2",
        holder_type: "worktree_cap",
      },
      {
        job_id: 302,
        work_item_id: 42,
        path: "*",
        holder_type: "active_worker",
      },
      {
        job_id: 303,
        work_item_id: 42,
        path: "*",
        holder_type: "worktree_serialization",
      },
    ];

    const lines = display._buildLeft(120, 18).map(plain);
    const blockedLine = lines.find((line) => line.includes("queued for worktree slot"));

    assert.ok(blockedLine);
    assert.ok(blockedLine.includes("1 queued for worktree slot"));
    assert.ok(blockedLine.includes("1 waiting on file lock"));
    assert.ok(blockedLine.includes("1 waiting on serialization"));
  });

  it("keeps sampled blocked-slot summaries from undercounting", () => {
    const display = new Display({ concurrency: 8 });
    display._blockedByLock = 6;
    display._blockedByLockDetails = [
      {
        job_id: 301,
        work_item_id: 41,
        path: "active_worktrees/2/2",
        holder_type: "worktree_cap",
      },
      {
        job_id: 302,
        work_item_id: 42,
        path: "src/app.js",
        holder_type: "active_worker",
      },
    ];

    const lines = display._buildLeft(120, 18).map(plain);
    const blockedLine = lines.find((line) => line.includes("queued for worktree slot"));

    assert.ok(blockedLine);
    assert.ok(blockedLine.includes("1 queued for worktree slot"));
    assert.ok(blockedLine.includes("1 waiting on file lock"));
    assert.ok(blockedLine.includes("4 more waiting"));
  });

  it("stores cost estimates when agent calls are completed", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Cost capture", "desc");
    const job = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Capture provider cost" });
    const call = queueMod.createAgentCall({
      work_item_id: wi.id,
      job_id: job.id,
      role: "researcher",
      model_tier: "standard",
      provider: "claude",
    });
    queueMod.completeAgentCall(call.id, {
      status: "succeeded",
      output_chars: 120,
      input_tokens: 220,
      output_tokens: 55,
      duration_ms: 2000,
      cost_estimate_usd: 0.1234,
    });

    const row = dbMod.getDb().prepare(`SELECT cost_estimate_usd FROM agent_calls WHERE id = ?`).get(call.id);
    assert.equal(row.cost_estimate_usd, 0.1234);
  });

  it("shows all queued jobs when the queue pane has room", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Queue expansion", "desc");
    for (let i = 1; i <= 5; i++) {
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: `Queued task ${i}`,
      });
    }

    const display = new Display({ concurrency: 3 });
    const lines = display._buildQueue(80, 12).map(plain);

    assert.ok(lines.some((line) => line.includes("Queued task 1")));
    assert.ok(lines.some((line) => line.includes("Queued task 5")));
    assert.equal(lines.some((line) => line.includes("hidden")), false);
  });

  it("compresses queued jobs only when the queue pane is tight", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Queue compression", "desc");
    for (let i = 1; i <= 5; i++) {
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: `Queued compact ${i}`,
      });
    }

    const display = new Display({ concurrency: 3 });
    const lines = display._buildQueue(80, 6).map(plain);

    assert.ok(lines.some((line) => line.includes("Queued compact 1")));
    assert.ok(lines.some((line) => line.includes("queued") && line.includes("hidden")));
  });

  it("caps queued job rows per WI so a large WI does not hide smaller WIs", () => {
    const { queueMod } = runtimeModules;
    const largeWi = queueMod.createWorkItem("Large queue", "desc");
    const smallWiA = queueMod.createWorkItem("Small queue A", "desc");
    const smallWiB = queueMod.createWorkItem("Small queue B", "desc");

    for (let i = 1; i <= 8; i++) {
      queueMod.createJob({
        work_item_id: largeWi.id,
        job_type: "dev",
        title: `Large queued task ${i}`,
      });
    }
    queueMod.createJob({
      work_item_id: smallWiA.id,
      job_type: "dev",
      title: "Small queued task A",
    });
    queueMod.createJob({
      work_item_id: smallWiB.id,
      job_type: "dev",
      title: "Small queued task B",
    });

    const display = new Display({ concurrency: 3 });
    const lines = display._buildQueue(90, 12).map(plain);
    const joined = lines.join("\n");

    assert.ok(joined.includes(`WI#${largeWi.id}`));
    assert.ok(joined.includes(`WI#${smallWiA.id}`));
    assert.ok(joined.includes(`WI#${smallWiB.id}`));
    assert.ok(joined.includes("Large queued task 1"));
    assert.ok(joined.includes("Small queued task A"));
    assert.ok(joined.includes("Small queued task B"));
    assert.ok(joined.includes("queued") && joined.includes("hidden"));
    assert.equal(joined.includes("Large queued task 8"), false);
  });

  it("summarizes visible and hidden queue job states separately", () => {
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [{
        id: 72,
        title: "Improve the queue state labels",
        status: "running",
      }],
      jobs: [
        { id: 271, work_item_id: 72, job_type: "dev", title: "Finished", status: "succeeded" },
        { id: 272, work_item_id: 72, job_type: "dev", title: "Currently running", status: "running" },
        { id: 273, work_item_id: 72, job_type: "dev", title: "Queued one", status: "queued" },
        { id: 274, work_item_id: 72, job_type: "dev", title: "Queued two", status: "queued" },
        { id: 275, work_item_id: 72, job_type: "dev", title: "Blocked on lock", status: "blocked" },
      ],
    });

    const queueLines = display._buildQueue(100, 5).map(plain);
    const queue = queueLines.join("\n");
    const wiLine = queueLines.find((line) => line.includes("WI#72")) || "";
    const activeLine = queueLines.find((line) => line.includes("#272")) || "";

    assert.ok(queue.includes("1 running"));
    assert.ok(queue.includes("2 queued"));
    assert.ok(queue.includes("1 blocked"));
    assert.ok(queue.includes("hidden"));
    assert.equal(wiLine.includes("Currently running"), false);
    assert.ok(activeLine.includes("Currently running"));
  });

  it("shows provider session budget usage in the post-task report when a provider cap exists", () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-report-usage-"));
    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    globalThis.__posseFetchClaudeOauthUsage = () => ({
      five_hour: {
        utilization: 10,
        resets_at: "2026-04-12T16:00:00.000Z",
      },
      seven_day: {
        utilization: 20,
        resets_at: "2026-04-18T00:00:00.000Z",
      },
    });

    const previousSessionLimit = runtimeModules.queueMod.getSetting("claude_limit_tokens_session");
    runtimeModules.queueMod.setSetting("claude_limit_tokens_session", "10000");
    try {
      const display = new Display({ concurrency: 3 });
      const lines = withClaudeConfigDir(claudeHome, () => display._buildTabTasks({
        wi: { id: 1, title: "Budget usage", status: "complete", priority: "normal", branch_name: "test" },
        jobs: [{
          id: 1,
          job_type: "dev",
          model_tier: "standard",
          title: "Implement feature",
          status: "succeeded",
          started_at: "2026-04-12T11:00:00.000Z",
          finished_at: "2026-04-12T11:01:00.000Z",
        }],
        agentCalls: [{
          provider: "claude",
          status: "succeeded",
          input_tokens: 200,
          output_tokens: 50,
        }],
        totalDuration: 60000,
        totalInputTokens: 200,
        totalOutputTokens: 50,
        gitDiff: [],
        filesToModify: [],
      }, 120).map(plain));

      assert.ok(lines.some((line) => line.includes("Claude: This task consumed 2.50% of the session token budget")));
      assert.ok(lines.some((line) => line.includes("(250 / 10.0K)")));
    } finally {
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      runtimeModules.queueMod.setSetting("claude_limit_tokens_session", previousSessionLimit);
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("renders tool-call and estimated-cost details in token report tab", () => {
    const display = new Display({ concurrency: 2 });
    const lines = display._buildTabTokens({
      wi: { id: 10, title: "Token report smoke" },
      totalDuration: 3500,
      totalInputTokens: 900,
      totalOutputTokens: 300,
      totalToolCalls: 5,
      totalCostUsd: 0.4321,
      toolUsageSummary: [
        { type: "read", count: 3 },
        { type: "search", count: 2 },
      ],
      agentCalls: [{
        role: "researcher",
        provider: "openai",
        model_name: "gpt-5.4",
        status: "succeeded",
        input_tokens: 900,
        output_tokens: 300,
        duration_ms: 3500,
        cost_estimate_usd: 0.4321,
      }],
    }, 120).map(plain);

    assert.ok(lines.some((line) => line.includes("tools") && line.includes("5")));
    assert.ok(lines.some((line) => line.includes("cost") && line.includes("$0.432")));
    assert.ok(lines.some((line) => line.includes("MODELS")));
    assert.ok(lines.some((line) => line.includes("ROLES")));
    assert.ok(lines.some((line) => line.includes("Cost")));
    assert.ok(lines.some((line) => line.includes("gpt-5.4") && line.includes("$0.432")));
    assert.ok(lines.some((line) => line.includes("researcher") && line.includes("$0.432")));
    assert.ok(lines.some((line) => line.includes("TOOLS")));
    assert.ok(lines.some((line) => line.includes("read")));
  });

  it("includes replayed web tool calls in agent-call tool logs", () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const wi = queueMod.createWorkItem("Web tool log", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research with web",
    });
    const startedAt = "2026-04-12T11:00:00.000Z";
    const finishedAt = "2026-04-12T11:00:10.000Z";
    const call = db.prepare(`
      INSERT INTO agent_calls (
        work_item_id, job_id, role, model_tier, provider, status,
        started_at, finished_at, created_at
      ) VALUES (?, ?, 'researcher', 'standard', 'claude', 'succeeded', ?, ?, ?)
    `).run(wi.id, job.id, startedAt, finishedAt, startedAt);
    const insertObservation = db.prepare(`
      INSERT INTO job_observations (
        work_item_id, job_id, observation_type, summary, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    insertObservation.run(wi.id, job.id, "tool.read_file", "Read file", "2026-04-12T11:00:05.000Z");
    insertObservation.run(wi.id, job.id, "tool.chain_read", "Chain read", "2026-04-12T11:00:06.000Z");
    insertObservation.run(wi.id, job.id, "tool.web_fetch", "WebFetch: https://docs.example.test", "2026-04-12T11:00:12.000Z");
    insertObservation.run(wi.id, job.id, "tool.read_file", "Late read", "2026-04-12T11:00:12.000Z");
    insertObservation.run(wi.id, job.id, "tool.web_search", "WebSearch: late web", "2026-04-12T11:00:30.000Z");

    const invocations = queueMod.getToolInvocationsForAgentCall(call.lastInsertRowid);
    assert.deepEqual(invocations.map((row) => row.observation_type), [
      "tool.read_file",
      "tool.web_fetch",
    ]);

    const rows = queueMod.getAgentCallsWithToolCountsByWorkItem(wi.id);
    const agentCall = rows.find((row) => row.id === call.lastInsertRowid);
    assert.equal(agentCall.tool_calls, 2);
  });

  it("shows current-run provider token usage at the bottom of the queue column", async () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");

    queueMod.setSetting("provider_dev", "openai");
    queueMod.setSetting("openai_limit_tokens_session", "10000");
    queueMod.setSetting("openai_limit_tokens_week", "20000");
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 1200, 300, "2026-04-12T10:30:00.000Z", "2026-04-12T10:30:00.000Z");

    const wi = queueMod.createWorkItem("Queue footer gauges", "desc");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Queued footer task",
    });

    try {
      const display = new Display({ concurrency: 3, runStartedAtIso: "2026-04-12T00:00:00.000Z" });
      display.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      display.stop();
      const lines = display._buildLeft(80, 24).map(plain);
      const footer = lines.join(" ");
      assert.ok(footer.includes("OPENAI"));
      assert.ok(footer.includes("1.5K tok"));
      assert.doesNotMatch(footer, /\[S\]/);
      assert.doesNotMatch(footer, /\[W\]/);
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      if (previousProviderDev == null) {
        queueMod.setSetting("provider_dev", null);
      } else {
        queueMod.setSetting("provider_dev", previousProviderDev);
      }
      if (previousSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
      }
    }
  });

  it("keeps current-run provider usage visible even when limits are not configured", async () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const previousSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousWeekLimit = queueMod.getSetting("openai_limit_tokens_week");

    queueMod.setSetting("provider_dev", "openai");
    queueMod.setSetting("openai_limit_tokens_session", null);

    queueMod.setSetting("openai_limit_tokens_week", null);
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "openai", "succeeded", 1200, 300, "2026-04-12T10:30:00.000Z", "2026-04-12T10:30:00.000Z");

    const wi = queueMod.createWorkItem("Queue footer unknown gauges", "desc");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Queued footer unknown task",
    });

    try {
      const display = new Display({ concurrency: 3, runStartedAtIso: "2026-04-12T00:00:00.000Z" });
      display.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      display.stop();
      const lines = display._buildLeft(80, 24).map(plain);
      const footer = lines.join(" ");
      assert.ok(footer.includes("OPENAI"));
      assert.ok(footer.includes("1.5K tok"));
      assert.doesNotMatch(footer, /\[S\]/);
      assert.doesNotMatch(footer, /\[W\]/);
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'openai'`).run();
      if (previousProviderDev == null) {
        queueMod.setSetting("provider_dev", null);
      } else {
        queueMod.setSetting("provider_dev", previousProviderDev);
      }
      if (previousSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousSessionLimit);
      }
      if (previousWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousWeekLimit);
      }
    }
  });

  it("keeps Claude current-run usage and account budget gauges visible when the cached week window is exhausted", async () => {
    const { queueMod, dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-footer-exhausted-"));
    const settingsPath = path.join(claudeHome, "account-settings.db");
    const nowMs = Date.parse("2026-04-13T21:10:00.000Z");

    fs.writeFileSync(path.join(claudeHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-oauth-token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }), "utf8");
    writeAccountSettingsDb(settingsPath, {
      claude_session_tokens: "150000",
      claude_session_max: "250000",
      claude_session_reset_at: "2026-04-14T02:00:00.000Z",
      claude_weekly_tokens: "250000",
      claude_weekly_max: "250000",
      claude_weekly_reset_at: "2026-04-15T23:00:00.797Z",
      claude_usage_subscription_type: "max",
      claude_usage_rate_limit_tier: "default_claude_max_20x",
      claude_usage_source: "anthropic-oauth-usage-api",
      claude_usage_last_updated: String(nowMs),
    });

    queueMod.setSetting("provider_dev", "claude");
    db.prepare(`DELETE FROM agent_calls WHERE provider = 'claude'`).run();
    db.prepare(`
      INSERT INTO agent_calls (
        role, model_tier, provider, status, input_tokens, output_tokens, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("dev", "standard", "claude", "succeeded", 12000, 414, "2026-04-13T21:00:00.000Z", "2026-04-13T21:00:00.000Z");
    const previousFetcher = globalThis.__posseFetchClaudeOauthUsage;
    const previousAsyncFetcher = globalThis.__posseFetchClaudeOauthUsageAsync;
    const usagePayload = () => ({
      five_hour: { utilization: 60, resets_at: "2026-04-14T02:00:00.000Z" },
      seven_day: { utilization: 100, resets_at: "2026-04-15T23:00:00.797Z" },
      subscription_type: "max",
      rate_limit_tier: "default_claude_max_20x",
    });
    globalThis.__posseFetchClaudeOauthUsage = usagePayload;
    globalThis.__posseFetchClaudeOauthUsageAsync = async () => usagePayload();
    const wi = queueMod.createWorkItem("Queue footer exhausted claude", "desc");
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Queued footer exhausted claude task",
    });

    try {
      const display = new Display({ concurrency: 3, runStartedAtIso: "2026-04-13T20:00:00.000Z" });
      await withAccountSettingsPath(settingsPath, () => withClaudeConfigDir(claudeHome, async () => {
        display.start();
        await new Promise((resolve) => setTimeout(resolve, 25));
        display.stop();
        const lines = display._buildLeft(80, 24).map(plain);
        const footer = lines.join(" ");
        assert.ok(footer.includes("CLAUDE"));
        assert.ok(footer.includes("12.4K tok"));
        assert.ok(footer.includes("[S]") && footer.includes("60%"));
        assert.ok(footer.includes("[W]") && footer.includes("100%"));
      }));
    } finally {
      db.prepare(`DELETE FROM agent_calls WHERE provider = 'claude'`).run();
      if (previousProviderDev == null) {
        queueMod.setSetting("provider_dev", null);
      } else {
        queueMod.setSetting("provider_dev", previousProviderDev);
      }
      globalThis.__posseFetchClaudeOauthUsage = previousFetcher;
      globalThis.__posseFetchClaudeOauthUsageAsync = previousAsyncFetcher;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("keeps Claude and Codex provider footer rows stable without budget snapshots", () => {
    const lines = _buildQueueProviderUsageLines(44, 8, [
      { provider: "claude", windows: [] },
      { provider: "codex", windows: [] },
    ], {
      nowMs: Date.parse("2026-04-13T21:10:00.000Z"),
      currentRunProviderUsage: [
        { provider: "claude", usedTokens: 3900000, costUsd: 12.34 },
        { provider: "codex", usedTokens: 2500000, costUsd: 7 },
      ],
      providerUsageOpts: { refresh: false },
    }).map(plain);

    assert.equal(lines.length, 8);
    assert.ok(lines[0].includes("CLAUDE"));
    assert.ok(lines[2].includes("[S]") && lines[2].includes("--%"));
    assert.ok(lines[3].includes("[W]") && lines[3].includes("--%"));
    assert.ok(lines[4].includes("CODEX"));
    assert.ok(lines[6].includes("[S]") && lines[6].includes("--%"));
    assert.ok(lines[7].includes("[W]") && lines[7].includes("--%"));
  });

  it("does not count recovered escalated jobs as failed in queue summaries", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Recovered queue", "desc");
    const failed = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original attempt",
    });
    const fix = queueMod.createJob({
      work_item_id: wi.id,
      parent_job_id: failed.id,
      job_type: "fix",
      title: "Escalated fix",
    });
    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Remaining queued work",
    });
    queueMod.updateJobStatus(failed.id, "failed");
    queueMod.updateJobStatus(fix.id, "succeeded");

    const display = new Display({ concurrency: 3 });
    const lines = display._buildQueue(80, 12).map(plain);

    assert.equal(lines.some((line) => line.includes("failed")), false);
    assert.ok(lines.some((line) => line.includes("2 done")));
    assert.ok(lines.some((line) => line.includes("Remaining queued work")));
  });

  it("shows live follow-up jobs even when the WI status is stale-terminal", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Iterative queue visibility", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Original pass",
    });
    queueMod.updateJobStatus(original.id, "succeeded");
    queueMod.setWorkItemBranch(wi.id, "posse/wi-iterative-visibility", "base");
    queueMod.refreshWorkItemStatus(wi.id);
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");

    const followUp = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (iterate 2): Iterative queue visibility",
    });
    queueMod.updateJobStatus(followUp.id, "running");

    const display = new Display({ concurrency: 3 });
    const queueLines = display._buildQueue(100, 12).map(plain);
    const progress = display._buildProgressBar(100).map(plain).join(" ");
    const wiLine = queueLines.find((line) => line.includes(`WI#${wi.id}`)) || "";
    const activeLine = queueLines.find((line) => line.includes(`#${followUp.id}`)) || "";

    assert.ok(queueLines.some((line) => line.includes(`WI#${wi.id}`)));
    assert.ok(queueLines.some((line) => line.includes("1 running")));
    assert.equal(wiLine.includes("iterate 2"), false);
    assert.ok(activeLine.includes("iterate 2"));
    assert.match(progress, /1\/2/);
    assert.ok(progress.includes("1 running"));
  });

  it("refreshes viewport dimensions during render even without a resize event", () => {
    const display = new Display({ concurrency: 3 });
    display._renderOnce = true;

    const originalCols = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const originalWrite = process.stdout.write;
    const writes = [];

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 91,
      writable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 33,
      writable: true,
    });
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };

    try {
      display.render();
      assert.equal(display.cols, 91);
      assert.equal(display.rows, 33);
      assert.ok(writes.length > 0);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalCols,
        writable: true,
      });
      Object.defineProperty(process.stdout, "rows", {
        configurable: true,
        value: originalRows,
        writable: true,
      });
      process.stdout.write = originalWrite;
    }
  });

  it("uses a gentler render throttle for background event bursts", () => {
    assert.equal(computeRenderMinGap({ reason: "event" }), 40);
    assert.equal(computeRenderMinGap({ reason: "stream" }), 33);
    assert.equal(computeRenderMinGap({ reason: "queue-snapshot" }), 80);
    assert.equal(computeRenderMinGap({ pendingInput: true }), 24);
    assert.equal(computeRenderMinGap({ force: true, reason: "event" }), 16);
  });

  it("fits wide display characters by terminal columns", () => {
    const cjk = stripDisplayAnsi(fitDisplay("漢字abc", 4));
    assert.equal(cjk, "漢… ");
    assert.equal(displayColumnWidth(cjk), 4);

    const emoji = stripDisplayAnsi(fitDisplay("a😀bc", 4));
    assert.equal(emoji, "a😀…");
    assert.equal(displayColumnWidth(emoji), 4);

    assert.equal(displayColumnWidth("✓ 15 Done"), 9);
    assert.equal(displayColumnWidth("✗ 2 failed"), 10);
  });

  it("lets forced renders preempt a pending background render", () => {
    const display = new Display({ concurrency: 3 });
    display._started = true;
    display._lastRenderAt = Date.now();

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const scheduled = [];
    let nextId = 1;

    global.setTimeout = (fn, delay, ...args) => {
      const handle = { id: nextId++, fn, delay, args, cleared: false };
      scheduled.push(handle);
      return handle;
    };
    global.clearTimeout = (handle) => {
      if (handle) handle.cleared = true;
    };

    try {
      display.requestRender({ reason: "event" });
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].delay <= 40, true);

      display.requestRender({ force: true });
      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[0].cleared, true);
      assert.equal(scheduled[1].delay <= 16, true);
      assert.equal(display._scheduledRenderReason, "force");
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  it("routes worker stream chatter through the slower background render cadence", () => {
    const display = new Display({ concurrency: 1 });
    display._started = true;
    display._lastRenderAt = Date.now();
    display.workers.set(1, { role: "artificer", activity: "producing", startTime: Date.now() });

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timers = [];
    global.setTimeout = (fn, delay) => {
      timers.push({ fn, delay });
      return { delay };
    };
    global.clearTimeout = () => {};

    try {
      display.workerLine(1, "[planner] some background tool chatter");
      assert.equal(display._scheduledRenderReason, "stream");
      assert.equal(timers.length, 1);
      assert.equal(timers[0].delay <= 33, true);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  it("emits one role-owned researcher start event per job", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(101, {
      role: "researcher",
      activity: "researching: Research the public contact info for every state",
      workItemId: 1,
    });
    display.setWorker(102, {
      role: "researcher",
      activity: "Do a bugfix sweep, fix any bugs you find",
      workItemId: 2,
    });
    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.filter((line) => line.includes("started")).length, 2);
    assert.ok(lines.some((line) => line.includes("[researcher] WI#1 job #101: started - Research the public contact info for every state")));
    assert.ok(lines.some((line) => line.includes("[researcher] WI#2 job #102: started - Do a bugfix sweep, fix any bugs you find")));
    assert.equal(lines.some((line) => line.includes("Job #")), false);
  });

  it("drops generic scheduler start lines before they reach the event log", () => {
    const display = new Display({ concurrency: 3 });

    display.addEvent("Job #563 started: WI#47 dev - Apply hero-banner modifier classes");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.length, 0);
  });

  it("tracks scheduler-owned worker slots without logging a developer start", () => {
    const display = new Display({ concurrency: 3 });

    display.setWorker(109, {
      role: "dev",
      activity: "Fix UTC/localtime mismatch",
      workItemId: 10,
      tier: "standard",
      effort: "medium",
      attempt: 1,
      emitStart: false,
    });

    assert.equal(display.workers.has(109), true);
    assert.equal(display.events.length, 0);

    display.setWorker(109, {
      role: "dev",
      activity: "executing job #109: Fix UTC/localtime mismatch",
      workItemId: 10,
      tier: "standard",
      effort: "medium",
      attempt: 1,
    });

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.filter((line) => line.includes("job #109: started")).length, 1);
    assert.ok(lines.some((line) => line.includes("[developer] WI#10 job #109: started - Fix UTC/localtime mismatch")));
  });

  it("suppresses raw researcher stream chatter while keeping structured events", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(102, {
      role: "researcher",
      activity: "State by state",
      workItemId: 1,
    });
    display.workerLine(102, "Good - the research branch has no research work yet, just a scaffold.");
    display.workerLine(102, "[researcher] WI#1 job #1: done");
    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.some((line) => line.includes("[researcher] State by state")), false);
    assert.equal(lines.some((line) => line.includes("Good - the research branch")), false);
    assert.ok(lines.some((line) => line.includes("[researcher] WI#1 job #1: done")));
  });

  it("deduplicates structured researcher start lines without a generic activity echo", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(103, {
      role: "researcher",
      activity: "Create some neon cyberpunk style images and integr",
      workItemId: 3,
    });
    display.workerLine(103, "[researcher] WI#3 job #103: Research: Create some neon cyberpunk style images and integr");
    const lines = display.events.map((e) => plain(e.text));

    assert.equal(lines.some((line) => line.includes("[researcher] Create some neon cyberpunk style images and integr")), false);
    assert.equal(lines.filter((line) => line.includes("Create some neon cyberpunk style images and integr")).length, 1);
    assert.ok(lines.some((line) => line.includes("[researcher] WI#3 job #103: started - Create some neon cyberpunk style images and integr")));
  });

  it("keeps structured developer start lines and emits a developer finish line", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(104, {
      role: "dev",
      activity: "executing job #42: Expand office_contacts schema",
      workItemId: 61,
      tier: "standard",
      effort: "medium",
      attempt: 1,
    });
    display.workerLine(104, "[dev] WI#61 job #104: Expand office_contacts schema (gpt-5-codex)");
    display.removeWorker(104, "succeeded");
    const lines = display.events.map((e) => plain(e.text));

    assert.ok(lines.some((line) => line.includes("[developer] WI#61 job #104: started - Expand office_contacts schema")));
    assert.equal(lines.some((line) => line.includes("[dev] WI#61 job #104: Expand office_contacts schema")), false);
    assert.ok(lines.some((line) => line.includes("[developer] WI#61 job #104: succeeded")));
  });

  it("keeps transient requeues out of the lifecycle event log", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(561, {
      role: "dev",
      activity: "Apply hero-banner modifier classes to scans",
      workItemId: 47,
      tier: "standard",
      effort: "low",
      attempt: 1,
    });

    display.workerLine(561, "[system] WI#47 worktree setup deferred during pre-worktree-mutation; 1 same-WI lock(s) active (#556)");
    display.workerLine(561, "[system] WI#47 worktree setup deferred behind same-WI work; retrying after active same-WI work releases");
    display.removeWorker(561, "queued");
    display.setWorker(561, {
      role: "dev",
      activity: "Apply hero-banner modifier classes to scans",
      workItemId: 47,
      tier: "standard",
      effort: "low",
      attempt: 2,
    });
    display.removeWorker(561, "succeeded");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.filter((line) => line.includes("Apply hero-banner modifier classes")).length, 1);
    assert.ok(lines.some((line) => line.includes("[developer] WI#47 job #561: started - Apply hero-banner modifier classes to scans")));
    assert.ok(lines.some((line) => line.includes("[developer] WI#47 job #561: succeeded")));
    assert.equal(lines.some((line) => line.includes("worktree setup deferred")), false);
    assert.equal(lines.some((line) => line.includes("queued")), false);
  });

  it("deduplicates direct role-owned start events for retried jobs", () => {
    const display = new Display({ concurrency: 3 });

    display.addEvent("[developer] WI#47 job #563: started - Apply hero-banner modifier classes");
    display.addEvent("[developer] WI#47 job #563: started - Apply hero-banner modifier classes");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.filter((line) => line.includes("job #563: started")).length, 1);
  });

  it("drops suppressed worker output counts when a non-assessor worker completes", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(204, {
      role: "dev",
      activity: "executing job #204: quiet task",
      workItemId: 72,
      tier: "standard",
      effort: "medium",
      attempt: 1,
    });

    display.workerLine(204, "[tool] some internal call");
    display.workerLine(204, "raw model commentary that the UI suppresses");
    display.removeWorker(204, "succeeded");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.some((line) => line.includes("suppressed output")), false);
    assert.ok(lines.some((line) => line.includes("[developer] WI#72 job #204: succeeded")));
  });

  it("keeps low-signal assessor success markers out of the event log", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(205, {
      role: "assessor",
      activity: "assessing: Review image promotion output",
      workItemId: 73,
    });

    display.workerLine(205, "[assessor] SUCCESS:  ");
    display.workerLine(205, "[assessor] completed:  ");
    display.workerLine(205, "SUCCESS:  ");
    display.workerLine(205, "completed: 2s | 0 lines");
    display.workerLine(205, "[tool] some internal call");
    display.workerLine(205, "[assessor] PASS: image promotion output is ready");
    display.removeWorker(205, "succeeded");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.some((line) => line.includes("[assessor] SUCCESS:")), false);
    assert.equal(lines.some((line) => line.includes("[assessor] completed:")), false);
    assert.equal(lines.some((line) => line.includes("suppressed output")), false);
    assert.equal(lines.some((line) => line.includes("[assessor] WI#73 job #205: succeeded")), false);
    assert.ok(lines.some((line) => line.includes("[assessor] PASS: image promotion output is ready")));
  });

  it("keeps low-signal planner success markers out of the event log", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(206, {
      role: "planner",
      activity: "planning: Route ATLAS cleanup",
      workItemId: 74,
    });

    display.workerLine(206, "[planner] SUCCESS:  ");
    display.workerLine(206, "SUCCESS:  ");
    display.workerLine(206, "[planner] completed:  ");
    display.workerLine(206, "completed: 2s | 0 lines");
    display.workerLine(206, "[planner] WI#74 job #206: selected ATLAS cleanup route");
    display.removeWorker(206, "succeeded");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.some((line) => line.includes("[planner] SUCCESS:")), false);
    assert.equal(lines.some((line) => line.includes("SUCCESS:")), false);
    assert.equal(lines.some((line) => line.includes("[planner] completed:")), false);
    assert.ok(lines.some((line) => line.includes("[planner] WI#74 job #206: selected ATLAS cleanup route")));
    assert.ok(lines.some((line) => line.includes("[planner] WI#74 job #206: succeeded")));
  });

  it("classifies assessor PASS lines as successful events", () => {
    const display = new Display({ concurrency: 3 });
    const classified = display._classifyEvent("[assessor] PASS WI#37 job #259: Fix purge endpoint: explicit scope=all guard and correct HTTP error");

    assert.equal(classified.glyph, "✓");
  });

  it("classifies assessor FAIL lines as failed events", () => {
    const display = new Display({ concurrency: 3 });
    const classified = display._classifyEvent("[assessor] FAIL WI#38 job #263: Generate corrected artifacts");

    assert.equal(classified.glyph, "✗");
  });

  it("does not mark normal job titles containing error as failed events", () => {
    const display = new Display({ concurrency: 3 });
    const classified = display._classifyEvent("[developer] WI#43 job #486: Harden provider RateLimited error messages across clients");

    assert.notEqual(classified.glyph, "✗");
  });

  it("still marks explicit error-status lines as failed events", () => {
    const display = new Display({ concurrency: 3 });
    const classified = display._classifyEvent("[worker] error: provider call crashed");

    assert.equal(classified.glyph, "✗");
  });

  it("shows a developer start line even when no structured dev event arrives", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(106, {
      role: "dev",
      activity: "WI#16 job #85: Generate streaming viewer mock with clarified panels",
      workItemId: 16,
      tier: "standard",
      effort: "medium",
      attempt: 1,
    });
    const lines = display.events.map((e) => plain(e.text));
    assert.ok(lines.some((line) => line.includes("[developer] WI#16 job #106: started - Generate streaming viewer mock with clarified panels")));
  });

  it("deduplicates developer title, structured start, and raw executing-job echoes", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(185, {
      role: "dev",
      activity: "Mirror front-page background layering on flow buildout",
      workItemId: 39,
      tier: "standard",
      effort: "medium",
      attempt: 1,
    });
    display.workerLine(185, "[developer] WI#39 job #185: Mirror front-page background layering on flow buildout");
    display.workerLine(185, "executing job #185: Mirror front-page background layering on flow buildout");

    const lines = display.events.map((e) => plain(e.text));
    assert.equal(lines.filter((line) => line.includes("Mirror front-page background layering on flow buildout")).length, 1);
    assert.ok(lines.some((line) => line.includes("[developer] WI#39 job #185: started - Mirror front-page background layering on flow buildout")));
  });

  it("shows a booting provider state before the first worker output arrives", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(107, {
      role: "researcher",
      activity: "Research: Dim the background image a bit",
      workItemId: 18,
      tier: "standard",
      effort: "medium",
      attempt: 1,
      provider: "codex",
      modelName: "gpt-5-codex",
    });
    const worker = display.workers.get(107);
    worker.startTime = Date.now() - 12_000;

    const lines = display._buildLeft(80, 12).map(plain);
    assert.ok(lines.some((line) => line.includes("booting provider")));
  });

  it("clears the booting provider state after the first worker output arrives", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(108, {
      role: "researcher",
      activity: "Research: Make the control cards more distinctive",
      workItemId: 19,
      tier: "standard",
      effort: "medium",
      attempt: 1,
      provider: "codex",
      modelName: "gpt-5-codex",
    });

    display.workerLine(108, "[tool] Codex internal command returned non-zero (exit 1); agent may continue");

    const worker = display.workers.get(108);
    assert.equal(worker.booting, false);
    const lines = display._buildLeft(80, 12).map(plain);
    assert.equal(lines.some((line) => line.includes("booting provider")), false);
  });

  it("passes structured artificer lines through without a duplicate role prefix", () => {
    const display = new Display({ concurrency: 3 });
    display.setWorker(105, {
      role: "artificer",
      activity: "producing job #105: Generate hero image set",
      workItemId: 4,
    });
    display.workerLine(105, "[artificer] WI#4 job #105: producing job #105: Generate hero image set");
    const lines = display.events.map((e) => plain(e.text));

    assert.equal(lines.filter((line) => line.includes("[artificer] WI#4 job #105")).length, 1);
    assert.equal(lines.some((line) => line.includes("[artificer] [artificer]")), false);
  });

  it("suppresses multiline structured stderr dumps so they cannot break the frame", () => {
    const display = new Display({ concurrency: 3 });
    display.workers.set(201, {
      role: "artificer",
      activity: "patching",
      startTime: Date.now(),
      tier: "standard",
      effort: "medium",
      attempt: 1,
      workItemId: 1,
    });

    display.workerLine(201, "[stderr] first line\nsecond line\nthird line");
    const lines = display.events.map((e) => plain(e.text));

    assert.equal(lines.some((line) => line.includes("first line")), false);
    assert.equal(lines.some((line) => /\n/.test(line)), false);
  });

  it("suppresses noisy structured stderr housekeeping while keeping the useful error", () => {
    const display = new Display({ concurrency: 3 });
    display.workers.set(202, {
      role: "artificer",
      activity: "patching",
      startTime: Date.now(),
      tier: "standard",
      effort: "medium",
      attempt: 1,
      workItemId: 1,
    });

    display.workerLine(202, "[stderr] function workshopSong() {");
    display.workerLine(202, "[stderr] Output:");
    display.workerLine(202, "[stderr] <stdin>:9: SyntaxWarning: \"\\s\" is an invalid escape sequence.");
    display.workerLine(202, "[stderr] Marker regex not found");
    display.workerLine(202, "[stderr] Wall time: 1.4 seconds");
    display.workerLine(202, "[stderr] Marker regex not found");

    const lines = display.events.map((e) => plain(e.text));

    assert.equal(lines.some((line) => line.includes("function workshopSong")), false);
    assert.equal(lines.some((line) => line.includes("Output:")), false);
    assert.equal(lines.some((line) => line.includes("SyntaxWarning")), false);
    assert.equal(lines.some((line) => line.includes("Wall time:")), false);
    assert.equal(lines.filter((line) => line.includes("Marker regex not found")).length, 1);
  });

  it("keeps the live input line visible for long question prompts", () => {
    const display = new Display({ concurrency: 3 });
    display.rows = 14;
    display._inputMode = "question";
    display._spinIdx = 0;
    display._inputBuf = "typed answer";
    display._activeQ = {
      jobId: 42,
      currentIdx: 0,
      questions: [
        Array.from({ length: 20 }, (_, i) => `Long prompt segment ${i + 1}`).join(" "),
      ],
      context: "Automatic escalation: very long context that would otherwise push the input off screen.",
    };

    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const lines = display._buildBottomInput(70).map(plain);

    assert.ok(lines.some((line) => line.includes("> typed answer")));
    assert.ok(lines.some((line) => line.includes("question clipped; showing beginning and end")));
  });

  it("shows blocked job context across multiple question prompt lines", () => {
    const display = new Display({ concurrency: 3 });
    display.rows = 30;
    display._inputMode = "question";
    display._spinIdx = 0;
    display._inputBuf = "";
    display._activeQ = {
      jobId: 570,
      currentIdx: 0,
      questions: ["Dev was blocked on job #556. What should be done?"],
      context: [
        "Task: Apply colgroup to top-10 weights table and remove inline th widths in index.php",
        "Block reason: The target markup was verified at `htdocs/index.php` lines 272-282 and matches the task instructions exactly. A writable edit path is required to complete this task.",
        "",
        "summary: Could not apply the requested colgroup/th width refactor because no writable file-edit tool was available.",
        "files_touched:",
        "  - htdocs/index.php: not modified - located exact lines 272-282",
      ].join("\n"),
    };

    const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, "");
    const lines = display._buildBottomInput(110).map(plain);

    assert.ok(lines.some((line) => line.includes("Context: Task: Apply colgroup")));
    assert.ok(lines.some((line) => line.includes("Block reason: The target markup")));
    assert.ok(lines.some((line) => line.includes("summary: Could not apply")));
    assert.ok(lines.some((line) => line.includes("htdocs/index.php: not modified")));
    assert.ok(lines.some((line) => line.includes("Dev was blocked on job #556")));
  });

  it("advertises and dispatches live review when pending work is reviewable", () => {
    const display = new Display({ concurrency: 3 });
    let reviewCount = 0;
    display.onReviewPending = () => { reviewCount++; };

    assert.ok(plain(display._buildHints()).includes("[r] review"));

    display._onKeypress("r", { name: "r", sequence: "r" });

    assert.equal(reviewCount, 1);
  });

  it("dispatches live review from key-name-only signals", () => {
    const display = new Display({ concurrency: 3 });
    let reviewCount = 0;
    display.onReviewPending = () => { reviewCount++; };

    display._onKeypress("", { name: "r", sequence: "" });

    assert.equal(reviewCount, 1);
  });

  it("resolves the picked question set without dropping other queued sets", async () => {
    const display = new Display({ concurrency: 3 });
    display.requestRender = () => {};
    let firstSettled = false;
    let secondAnswers = null;
    display.askQuestions(101, ["First job question?"], null, 1)
      .then(() => { firstSettled = true; }, () => { firstSettled = true; });
    display.askQuestions(202, ["Second job question?"], null, 2)
      .then((answers) => { secondAnswers = answers; });

    // askQuestions auto-activated set #1; digit-pick jumps to set #2.
    display._startAnsweringAt(1);
    assert.equal(display._activeQ.jobId, 202);

    display._inputBuf = "answer for second";
    display._submitAnswer();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(secondAnswers[0].answer, "answer for second");
    assert.equal(firstSettled, false);
    assert.equal(display._questionQueue.length, 1);
    assert.equal(display._questionQueue[0].jobId, 101);
    assert.equal(display._activeQ.jobId, 101);
  });

  it("nudge digit selection targets the rendered row, not the raw worker map", () => {
    const display = new Display({ concurrency: 3 });
    display.requestRender = () => {};
    display.onNudge = () => {};
    display.workers.set(11, { role: "preflight", activity: "booting", startTime: Date.now() });
    display.workers.set(22, { role: "dev", activity: "writing", startTime: Date.now() });

    display._onKeypress("n", { name: "n", sequence: "n" });
    assert.equal(display._inputMode, "nudge_select");
    assert.ok(plain(display._buildBottomInput(80).join("\n")).includes("[1-1] select"));

    display._onKeypress("1", { name: "1", sequence: "1" });
    assert.equal(display._inputMode, "nudge_text");
    assert.equal(display._nudgeJobId, 22);
  });

  it("does not replay pasted chunks already delivered as keypress events", async () => {
    const display = new Display({ concurrency: 3 });
    display._started = true;
    display.requestRender = () => {};
    const dispatched = [];
    display._onKeypress = (str) => { dispatched.push(str); };

    try {
      // Simulate readline having emitted one keypress per pasted character
      // before the raw data handler sees the whole chunk.
      display._lastKeypressAt = Date.now();
      display._lastKeypressSequence = "c";
      display._keypressSeqSinceData = "abc";
      display._scheduleRawInputFallback("abc");
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.deepEqual(dispatched, []);
    } finally {
      display._started = false;
      for (const timer of display._rawInputFallbackTimers) clearTimeout(timer);
      display._rawInputFallbackTimers.clear();
    }
  });

  it("falls back to raw stdin chunks when keypress events do not arrive", async () => {
    const display = new Display({ concurrency: 3 });
    display._started = true;
    display.requestRender = () => {};
    let reviewCount = 0;
    display.onReviewPending = () => { reviewCount++; };

    try {
      display._scheduleRawInputFallback("r");
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(reviewCount, 1);
    } finally {
      display._started = false;
      for (const timer of display._rawInputFallbackTimers) clearTimeout(timer);
      display._rawInputFallbackTimers.clear();
    }
  });

  it("keeps failed text submissions editable so the user can retry", () => {
    const display = new Display({ concurrency: 3 });
    display._inputMode = "inject";
    display._inputBuf = "make the reports clearer";
    display.onInject = () => { throw new Error("database busy"); };

    display._submitInject();

    assert.equal(display._inputMode, "inject");
    assert.equal(display._inputBuf, "make the reports clearer");
    assert.ok(display.events.map((e) => plain(e.text)).some((line) => line.includes("press Enter to retry")));

    let injected = "";
    display.onInject = (desc) => { injected = desc; };
    display._submitInject();
    assert.equal(injected, "make the reports clearer");
    assert.equal(display._inputMode, false);
  });

  it("keeps failed nudge submissions editable so the user can retry", () => {
    const display = new Display({ concurrency: 3 });
    display._inputMode = "nudge_text";
    display._nudgeJobId = 55;
    display._inputBuf = "try a smaller patch";
    display.onNudge = () => { throw new Error("worker unavailable"); };

    display._submitNudge();

    assert.equal(display._inputMode, "nudge_text");
    assert.equal(display._inputBuf, "try a smaller patch");
    assert.ok(display.events.map((e) => plain(e.text)).some((line) => line.includes("Nudge failed") && line.includes("retry")));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: WI Status — Artificer + Mixed States (extends existing)
// ═════════════════════════════════════════════════════════════════════════════
