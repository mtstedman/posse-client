import {
  describe,
  it,
  after,
} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withTempRuntimeDb, withCapturedProcessSignals, createRunSessionBootTestDeps } from "./helpers/regression-test-harness.js";
import { Display } from "../lib/domains/ui/classes/display/Display.js";
import { Scheduler } from "../lib/domains/scheduler/classes/Scheduler.js";
import { Worker } from "../lib/domains/worker/classes/Worker.js";
import { bootScipLangPatchFromEvent, buildImageInjectionPayload, createTerminalOutputIntercept, handleWrapUpSignal, PROVIDER_AUTH_WARMUP_TIMEOUT_MS, RunSession, scopeScipEventToSourceLanguage } from "../lib/domains/cli/functions/run-session.js";
import { createBootPanel } from "../lib/domains/cli/functions/boot-panel.js";
import { getOnnxWarmState, setOnnxWarmState } from "../lib/domains/atlas/functions/v2/embeddings/onnx-warm-state.js";
import { ensureAtlasRepoIndexedOnBoot, getAtlasIntegrationConfig } from "../lib/domains/integrations/functions/atlas.js";
import { getDb } from "../lib/shared/storage/functions/index.js";
import { acquireLease, acquireSchedulerLock, createAgentCall, createJob, createWorkItem, getJob, getSchedulerLockInfo, incrementAndCreateAttempt, listJobsByWorkItem, logEvent, updateJobStatus, updateWorkItemStatus } from "../lib/domains/queue/functions/index.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../lib/domains/queue/functions/reviewable.js";
import { displayColumnWidth, stripAnsi } from "../lib/shared/format/functions/ansi.js";

async function waitForCondition(predicate, message, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

function forceStdoutTtyForBootPanel() {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      delete process.stdout.isTTY;
    }
  };
}

function forceStdinTtyForBootPanel() {
  const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const isRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
  const setRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const rawModes = [];
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdin, "isRaw", {
    configurable: true,
    writable: true,
    value: false,
  });
  Object.defineProperty(process.stdin, "setRawMode", {
    configurable: true,
    writable: true,
    value: (value) => {
      rawModes.push(value);
      process.stdin.isRaw = value;
      return process.stdin;
    },
  });
  return {
    rawModes,
    restore: () => {
      if (isTtyDescriptor) Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
      else delete process.stdin.isTTY;
      if (isRawDescriptor) Object.defineProperty(process.stdin, "isRaw", isRawDescriptor);
      else delete process.stdin.isRaw;
      if (setRawModeDescriptor) Object.defineProperty(process.stdin, "setRawMode", setRawModeDescriptor);
      else delete process.stdin.setRawMode;
    },
  };
}

function readyOnnxStatus() {
  return {
    status: "ready",
    cacheDir: "cache",
    modelName: "test-model",
    model: "test-model-id",
    dim: 384,
  };
}

describe("RunSession boot lifecycle", () => {
  it("routes SCIP ingest events with stage=scip as intaking", () => {
    assert.equal(bootScipLangPatchFromEvent({
      kind: "atlas.scip.ingest.started",
      stage: "scip",
      current: 0,
      total: 76,
      percent: 0,
      text: "scip ingest php.scip: 76 documents",
    }).state, "intaking");

    assert.equal(bootScipLangPatchFromEvent({
      kind: "line",
      stage: "scip",
      text: "checking staged SCIP",
    }).state, "indexing");

    assert.equal(bootScipLangPatchFromEvent({
      kind: "atlas.scip.ingest.started",
      stage: "scip",
      current: 0,
      total: 0,
      percent: null,
      text: "preparing intake",
    }).state, "indexing");
  });

  it("scopes mixed TypeScript SCIP intake counts to source-language rows", () => {
    const event = {
      kind: "atlas.scip.ingest.progress",
      scheme: "scip-typescript",
      language: "typescript",
      source_languages: ["ts", "js"],
      source_language_current: { ts: 58, js: 12 },
      source_language_total: { ts: 58, js: 39 },
      current: 70,
      total: 97,
      percent: 72.16,
    };

    const tsPatch = bootScipLangPatchFromEvent(scopeScipEventToSourceLanguage(event, "ts"));
    assert.equal(tsPatch.current, 58);
    assert.equal(tsPatch.total, 58);
    assert.equal(tsPatch.percent, 100);

    const jsPatch = bootScipLangPatchFromEvent(scopeScipEventToSourceLanguage(event, "js"));
    assert.equal(jsPatch.current, 12);
    assert.equal(jsPatch.total, 39);
    assert.equal(Math.round(jsPatch.percent), 31);
  });

  it("renders scoped JavaScript SCIP rows without an indexer note", () => {
    const panel = createBootPanel({
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "", blue: "" },
      columns: () => 120,
    });
    panel.updateLang("js", "scip", {
      state: "intaking",
      current: 12,
      total: 39,
      percent: (12 / 39) * 100,
    });
    const rendered = panel.lines().map(stripAnsi).join("\n");
    assert.match(rendered, /js/);
    // The SCIP "intaking" phase renders in the grid's scip-parse column as a
    // percent (12/39 ≈ 31%); the generate column reads done.
    assert.match(rendered, /31%/);
    assert.doesNotMatch(rendered, /allowJs|via/);
  });

  it("renders SCIP generation progress percentages in the generate column", () => {
    const event = {
      kind: "line",
      stage: "scip.indexing",
      language: "typescript",
      source_languages: ["ts", "js"],
      current: 19,
      total: 100,
      percent: 19,
      text: "SCIP indexer output: 19/100 documents",
    };
    const panel = createBootPanel({
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "", blue: "" },
      columns: () => 120,
    });
    for (const lang of event.source_languages) {
      panel.updateLang(lang, "scip", bootScipLangPatchFromEvent(scopeScipEventToSourceLanguage(event, lang)));
    }
    const rendered = panel.lines().map(stripAnsi).join("\n");
    assert.match(rendered, /generate/);
    assert.match(rendered, /19%/);
    assert.doesNotMatch(rendered, /parse\s+.*19%/);
  });

  it("keeps SCIP generation percent when heartbeat events have no counts", () => {
    const panel = createBootPanel({
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "", blue: "" },
      columns: () => 120,
    });
    panel.updateLang("py", "scip", bootScipLangPatchFromEvent({
      kind: "line",
      stage: "scip.indexing",
      language: "python",
      current: 42,
      total: 100,
      percent: 42,
      text: "SCIP indexer generation: 42/100 documents",
    }));
    panel.updateLang("py", "scip", bootScipLangPatchFromEvent({
      kind: "heartbeat",
      stage: "scip.indexing",
      language: "python",
      detail: "staging SCIP index via scip-python",
      elapsedMs: 1000,
    }));

    const entry = Array.from(panel.languageEntries()).find(([lang]) => lang === "py")?.[1];
    assert.equal(entry?.scip?.percent, 42);
    const rendered = panel.lines().map(stripAnsi).join("\n");
    assert.match(rendered, /42%/);
  });

  it("keeps the atlas ledger header complete while embeddings are still encoding", () => {
    const panel = createBootPanel({
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "", blue: "" },
      columns: () => 120,
    });
    // Cache-hot ATLAS rows may not receive parse progress, but once the view
    // merge has completed the ledger inputs are necessarily present. Encoding
    // is an independent semantic tail and must not drag the ledger header down.
    panel.updateLang("py", "scip", { state: "done", percent: 100 });
    panel.updateLang("php", "scip", { state: "done", percent: 100 });
    panel.updateZip({ state: "done", percent: 100, detail: "merged" });
    panel.updateEncode({ state: "building", percent: 79, detail: "8320/10562 symbols" });

    const rendered = panel.lines().map(stripAnsi);
    const text = rendered.join("\n");
    const ledgerLine = rendered.find((line) => line.includes("atlas ledger"));
    const pyLine = rendered.find((line) => /\bpy\b/.test(line));

    assert.match(ledgerLine || "", /100%/);
    assert.match(text, /encode\s+.*79%/);
    assert.ok(pyLine?.includes("✓"), "implicit cache-hot atlas cell should render complete after merge starts");
  });

  it("renders the boot footer for actionable ONNX backgrounding", () => {
    const panel = createBootPanel({
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "", blue: "" },
      columns: () => 120,
    });
    panel.updateEncode({ state: "building", percent: 42, detail: "420/1000 symbols" });
    panel.setFooter("hit Enter to load ONNX in the background");

    const text = panel.lines().map((line) => stripAnsi(line)).join("\n");
    assert.match(text, /hit Enter to load ONNX in the background/);
  });

  it("uses an exact image.png deliverable contract for TUI image injection", () => {
    const payload = buildImageInjectionPayload({
      prompt: "blue glass icon",
      outputRoot: "C:\\tmp\\posse\\artifacts\\wi-7",
    });

    assert.equal(payload.output_root, "C:/tmp/posse/artifacts/wi-7");
    assert.deepEqual(payload.create_roots, ["C:/tmp/posse/artifacts/wi-7"]);
    assert.deepEqual(payload.files_to_create, ["C:/tmp/posse/artifacts/wi-7/image.png"]);
    assert.match(payload.task_spec, /Save it to: image\.png/);
    assert.doesNotMatch(payload.task_spec, /C:\/tmp\/posse\/artifacts\/wi-7\/image\.png/);
    assert.deepEqual(payload.success_criteria, [
      "C:/tmp/posse/artifacts/wi-7/image.png exists",
      "Image is a valid PNG/JPG/WebP",
    ]);
  });

  it("uses non-success exit codes for wrap-up signals", () => {
    const previousExitCode = process.exitCode;
    let stopped = false;
    let sharedStopped = false;
    let runtimeClosed = false;
    let exitCode = null;
    try {
      handleWrapUpSignal({
        signal: "SIGINT",
        display: { stop: () => { stopped = true; } },
        cleanupAtlasForSession: () => { sharedStopped = true; },
        closeRuntimeState: () => { runtimeClosed = true; },
        exit: (code) => { exitCode = code; },
      });

      assert.equal(stopped, true);
      assert.equal(sharedStopped, true);
      assert.equal(runtimeClosed, true);
      assert.equal(exitCode, 130);
      assert.equal(process.exitCode, 130);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("clears stale ONNX warm state at run start", async () => withCapturedProcessSignals(async () => {
    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot() { return false; }
      stop() {}
    }

    setOnnxWarmState({ phase: "ready", startedAt: 1, finishedAt: 2, error: null });
    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
    }));

    await session.run();

    assert.equal(getOnnxWarmState().phase, "idle");
  }));

  it("blocks scheduler boot when the startup dirty-tree guard fails", async () => {
    const events = [];

    class FakeScheduler {
      constructor() {
        events.push("scheduler.constructed");
        this.leaseSec = 60;
      }

      async boot() {
        events.push("scheduler.boot");
        return false;
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      updateWorkItemStatus: () => {
        events.push("work-item.running");
      },
      guardStartupDirtyTree: () => {
        events.push("guard");
        throw new Error("dirty startup tree");
      },
    }));

    await assert.rejects(() => session.run(), /dirty startup tree/);
    assert.deepEqual(events, ["guard"]);
  });

  it("runs startup worktree cleanup before scheduler boot acquires the lock", async () => {
    // The DAG requires Worktree Cleanup to complete BEFORE orphan recovery
    // (which is inside scheduler.boot). So startup cleanup runs in the
    // pre-scheduler chain — driven by the run-session orchestrator — not
    // inside the pre-loop hook the way the legacy boot did.
    const events = [];
    let bootOptions = null;
    let bootStarted = false;
    let providerAuthPrimeArgs = null;

    class FakeScheduler {
      constructor(opts) {
        events.push(["scheduler.constructed", opts]);
        this.leaseSec = 60;
      }

      async boot(opts) {
        bootOptions = opts;
        bootStarted = true;
        events.push(["scheduler.boot"]);
        await opts.onBeforeLoop();
        events.push(["scheduler.boot.after-hook"]);
        return false;
      }
    }

    const session = new RunSession({
      maybeAnnounceAutoMergeSetting: () => {},
      listJobs: () => [{
        id: 1,
        work_item_id: 1,
        status: "queued",
        job_type: "dev",
        payload_json: "{}",
      }],
      jobsNeedGitWorktree: () => true,
      processIterativeWrapUp: async () => ({ rerun: false }),
      listWorkItems: () => [],
      isReviewableWorkItem: () => false,
      cmdReview: async () => {},
      C: { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "" },
      CONCURRENCY: 1,
      getWorkItem: () => ({ id: 1, status: "planned", branch_name: "posse/wi-1" }),
      updateWorkItemStatus: () => events.push(["work-item.running"]),
      ensureRepoSetupConfirmed: async () => true,
      ensureGitReady: () => events.push(["git-ready"]),
      ensureBootDependenciesInWorker: async () => ({ ok: true, counts: { checked: 0, installed: 0, dry_run: 0, failed: 0, ready: 0 } }),
      formatBootDependencySync: () => "ready",
      NO_TUI: true,
      Scheduler: FakeScheduler,
      primeProviderUsageAuth: (opts) => {
        providerAuthPrimeArgs = opts;
        return { attempted: false, providers: [] };
      },
      PROJECT_DIR: process.cwd(),
      getConfiguredProviderUsageAsync: async () => [],
      startupWorktreeCleanup: async ({ signal, skipDirtyTreeGuard } = {}) => {
        // Inverse of the legacy contract: cleanup MUST run before
        // scheduler.boot fires so that orphan recovery sees a sane
        // worktree state. See the per-mock DAG.
        assert.equal(bootStarted, false, "startup cleanup must run before scheduler.boot acquires the lock");
        assert.equal(signal?.aborted, false);
        assert.equal(skipDirtyTreeGuard, true, "run-session already completed the startup dirty-tree guard");
        events.push(["startup-cleanup-start"]);
        await Promise.resolve();
        events.push(["startup-cleanup-done"]);
      },
      ensureAtlasCommitReindexHook: () => ({ attempted: false }),
      getAtlasIntegrationConfig: () => ({}),
      ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
      disableAtlasForRun: () => {},
      log: { warn: () => {} },
      Display: class {},
      STALL_TIMEOUT: 1,
      Worker: class {},
      AUTO_APPROVE: false,
      DRY_RUN: false,
    });

    await session.run();

    assert.equal(bootOptions?.onBeforeLoopFatal, true);
    assert.equal(typeof bootOptions?.onBeforeLoop, "function");
    assert.equal(providerAuthPrimeArgs?.timeoutMs, PROVIDER_AUTH_WARMUP_TIMEOUT_MS);
    assert.deepEqual(events.map(([name]) => name), [
      // Pre-scheduler DAG chain — order: git ready → dirty tree guard
      // (returns clean in default deps) → worktree cleanup → work-item
      // status flip → scheduler instantiation → scheduler.boot.
      "git-ready",
      "startup-cleanup-start",
      "startup-cleanup-done",
      "work-item.running",
      "scheduler.constructed",
      "scheduler.boot",
      "scheduler.boot.after-hook",
    ]);
  });

  it("releases the boot terminal intercept while repo setup can prompt", async () => {
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const originalWrite = process.stdout.write;
    let output = "";
    let promptVisibleDuringRepoSetup = false;
    process.stdout.write = function patchedWrite(chunk, encoding, callback) {
      output += Buffer.isBuffer(chunk)
        ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
        : String(chunk);
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") cb();
      return true;
    };

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot() {
        return false;
      }

      stop() {}
    }

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureRepoSetupConfirmed: async () => {
          process.stdout.write("VISIBLE REPO SETUP PROMPT");
          promptVisibleDuringRepoSetup = output.includes("VISIBLE REPO SETUP PROMPT");
          return true;
        },
        ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
      }));

      await session.run();
      assert.equal(promptVisibleDuringRepoSetup, true);
    } finally {
      process.stdout.write = originalWrite;
      restoreStdoutTty();
    }
  });

  it("keeps quiet repo setup inside the existing boot panel", async () => {
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const originalWrite = process.stdout.write;
    const writes = [];
    let writesAtRepoSetupStart = -1;
    process.stdout.write = function patchedWrite(chunk, encoding, callback) {
      writes.push(Buffer.isBuffer(chunk)
        ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
        : String(chunk));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") cb();
      return true;
    };

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot() {
        return false;
      }

      stop() {}
    }

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureRepoSetupConfirmed: async () => {
          writesAtRepoSetupStart = writes.length;
          return true;
        },
        ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
      }));

      await session.run();
    } finally {
      process.stdout.write = originalWrite;
      restoreStdoutTty();
    }

    assert.ok(writesAtRepoSetupStart > 0, "expected repo setup to run after the first boot render");
    assert.notEqual(
      writes[writesAtRepoSetupStart - 1],
      "\n",
      "quiet repo setup should not push the boot panel into scrollback",
    );
    const firstRenderAfterRepoSetup = writes
      .slice(writesAtRepoSetupStart)
      .find((chunk) => stripAnsi(chunk).includes("posse"));
    assert.ok(
      firstRenderAfterRepoSetup?.startsWith("\x1b["),
      `expected the next boot render to repaint in place, got ${JSON.stringify(firstRenderAfterRepoSetup)}`,
    );
  });

  it("does not let provider warmups block scheduler boot", async () => {
    const events = [];
    let authStarted = false;
    let usageStarted = false;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        events.push("scheduler.boot");
        await opts.onBeforeLoop();
        events.push("scheduler.boot.after-hook");
        return false;
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      jobsNeedGitWorktree: () => false,
      // Both warmup windows tiny so a hung prime soft-times-out immediately
      // instead of wedging boot (auth now uses its own warmup-timeout window).
      PROVIDER_USAGE_WARMUP_SOFT_TIMEOUT_MS: 5,
      PROVIDER_AUTH_WARMUP_TIMEOUT_MS: 5,
      primeProviderUsageAuthAsync: async () => {
        authStarted = true;
        await new Promise(() => {});
      },
      getConfiguredProviderUsageAsync: async () => {
        usageStarted = true;
        await new Promise(() => {});
      },
      ensureAtlasRepoIndexedOnBoot: async () => ({ attempted: false, skipped: "atlas_disabled" }),
    }));

    const startedAt = Date.now();
    await session.run();

    assert.equal(authStarted, true);
    assert.equal(usageStarted, true);
    assert.deepEqual(events, ["scheduler.boot", "scheduler.boot.after-hook"]);
    assert.ok(Date.now() - startedAt < 2500, "provider warmups should soft-timeout instead of blocking boot");
  });

  it("blocks scheduler boot when the remote prompt compiler is not ready", async () => {
    const events = [];

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        events.push("scheduler.boot");
        await opts.onBeforeLoop();
        events.push("scheduler.boot.after-hook");
        return false;
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      checkRemotePromptCompilerReadiness: async () => {
        events.push("remote-readiness");
        throw new Error("remote compiler down");
      },
    }));

    await assert.rejects(() => session.run(), /remote compiler down/);
    assert.deepEqual(events, ["scheduler.boot", "remote-readiness"]);
  });

  it("auto-merges pending-review blockers during scheduler idle when auto-merge is enabled", async () => {
    const events = [];
    let autoMergeArgs = null;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onIdle([{ id: 1, status: "queued" }]);
        await new Promise((resolve) => setImmediate(resolve));
        opts.onDone();
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      describePendingReviewLockBlockers: () => "Queued work is blocked by WI#42 pending review on htdocs/app.js.",
      autoMergePendingReviewBlockers: true,
      autoMergeCompletedWorkItems: async (args) => {
        autoMergeArgs = args;
        events.push("auto-merge");
        return 1;
      },
      wrapUp: async () => {
        events.push("wrap-up");
        return { rerun: false };
      },
    }));

    await session.run();

    assert.equal(autoMergeArgs?.reason, "pending-review blocker");
    assert.equal(autoMergeArgs?.runGc, false);
    assert.equal(autoMergeArgs?.display, null);
    assert.deepEqual(events, ["auto-merge", "wrap-up"]);
  });

  it("auto-merges completed work during scheduler idle when auto-merge is enabled", async () => {
    const events = [];
    let autoMergeArgs = null;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onIdle([{ id: 1, status: "queued" }]);
        await new Promise((resolve) => setImmediate(resolve));
        opts.onDone();
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      describePendingReviewLockBlockers: () => null,
      autoMergePendingReviewBlockers: true,
      autoMergeCompletedWorkItems: async (args) => {
        autoMergeArgs = args;
        events.push("auto-merge");
        return 1;
      },
      wrapUp: async () => {
        events.push("wrap-up");
        return { rerun: false };
      },
    }));

    await session.run();

    assert.equal(autoMergeArgs?.reason, "scheduler idle");
    assert.equal(autoMergeArgs?.runGc, false);
    assert.equal(autoMergeArgs?.display, null);
    assert.deepEqual(events, ["auto-merge", "wrap-up"]);
  });

  it("auto-merges completed work as soon as a job succeeds", async () => {
    const events = [];
    let autoMergeArgs = null;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onJobEnd({ id: 99 });
        await new Promise((resolve) => setImmediate(resolve));
        opts.onDone();
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      getJob: () => ({ id: 99, status: "succeeded" }),
      hasAutoMergeableCompletedWorkItems: () => true,
      autoMergePendingReviewBlockers: true,
      autoMergeCompletedWorkItems: async (args) => {
        autoMergeArgs = args;
        events.push("auto-merge");
        return 1;
      },
      wrapUp: async () => {
        events.push("wrap-up");
        return { rerun: false };
      },
    }));

    await session.run();

    assert.equal(autoMergeArgs?.reason, "job completion");
    assert.equal(autoMergeArgs?.runGc, false);
    assert.deepEqual(events, ["auto-merge", "wrap-up"]);
  });

  it("drains queued atlas_warm jobs at wrap-up, including chained follow-ups", async () => {
    const executed = [];
    // Wrap-up merges enqueue warm follow-ups after the scheduler loop exits;
    // the drain must run them — and re-poll for the jobs they chain (a merge
    // warm enqueues the scip restage) — before the conductor closes.
    const warmQueue = [{
      id: 11,
      work_item_id: null,
      status: "queued",
      job_type: "atlas_warm",
      title: "ATLAS warm: main incremental",
      payload_json: JSON.stringify({ purpose: "main-incremental" }),
    }];
    const devJob = {
      id: 1,
      work_item_id: 1,
      status: "queued",
      job_type: "dev",
      title: "Test job",
      payload_json: "{}",
    };
    let wrappedUp = false;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
        this.ownerId = "test-owner";
        this.leaseManager = {
          acquireWithLocks: (job) => ({ leaseToken: `lease-${job.id}` }),
        };
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onDone();
      }

      stop() {}
    }

    class FakeWorker {
      async execute(job) {
        executed.push({ id: job.id, purpose: JSON.parse(job.payload_json).purpose, lease: job._leaseToken });
        const idx = warmQueue.findIndex((w) => w.id === job.id);
        if (idx >= 0) warmQueue.splice(idx, 1);
        if (job.id === 11) {
          warmQueue.push({
            id: 12,
            work_item_id: null,
            status: "queued",
            job_type: "atlas_warm",
            title: "ATLAS warm: SCIP restage",
            payload_json: JSON.stringify({ purpose: "scip-restage" }),
          });
        }
      }
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      Worker: FakeWorker,
      // Before wrap-up the queue holds the dev job (so the run starts); the
      // warm follow-ups appear once wrap-up has run its merges.
      listJobs: () => (wrappedUp ? [...warmQueue] : [devJob]),
      wrapUp: async () => {
        wrappedUp = true;
        return { rerun: false };
      },
    }));

    await session.run();

    assert.deepEqual(executed, [
      { id: 11, purpose: "main-incremental", lease: "lease-11" },
      { id: 12, purpose: "scip-restage", lease: "lease-12" },
    ]);
    assert.equal(warmQueue.length, 0);
  });

  it("skips the wrap-up atlas drain when POSSE_WRAPUP_ATLAS_DRAIN is off", async () => {
    const executed = [];
    let wrappedUp = false;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
        this.ownerId = "test-owner";
        this.leaseManager = {
          acquireWithLocks: (job) => ({ leaseToken: `lease-${job.id}` }),
        };
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onDone();
      }

      stop() {}
    }

    class FakeWorker {
      async execute(job) {
        executed.push(job.id);
      }
    }

    const prior = process.env.POSSE_WRAPUP_ATLAS_DRAIN;
    process.env.POSSE_WRAPUP_ATLAS_DRAIN = "off";
    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        Worker: FakeWorker,
        listJobs: () => (wrappedUp
          ? [{ id: 21, status: "queued", job_type: "atlas_warm", title: "ATLAS warm", payload_json: "{}" }]
          : [{ id: 1, work_item_id: 1, status: "queued", job_type: "dev", title: "Test job", payload_json: "{}" }]),
        wrapUp: async () => {
          wrappedUp = true;
          return { rerun: false };
        },
      }));
      await session.run();
    } finally {
      if (prior === undefined) delete process.env.POSSE_WRAPUP_ATLAS_DRAIN;
      else process.env.POSSE_WRAPUP_ATLAS_DRAIN = prior;
    }

    assert.deepEqual(executed, []);
  });

  it("waits for job-completion auto-merge before wrap-up", async () => {
    const events = [];

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop(workerCallback, opts) {
        opts.onJobEnd({ id: 99 });
        opts.onDone();
      }

      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      getJob: () => ({ id: 99, status: "succeeded" }),
      hasAutoMergeableCompletedWorkItems: () => true,
      autoMergePendingReviewBlockers: true,
      autoMergeCompletedWorkItems: async () => {
        events.push("auto-merge-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("auto-merge-done");
        return 1;
      },
      wrapUp: async () => {
        events.push("wrap-up");
        return { rerun: false };
      },
    }));

    await session.run();

    assert.deepEqual(events, ["auto-merge-start", "auto-merge-done", "wrap-up"]);
  });

  it("auto-merges no-active completed work before opening review", async () => {
    const events = [];
    let autoMergeArgs = null;
    let reviewOpened = false;
    let pushedCount = 0;
    const reviewable = { id: 42, status: "complete", branch_name: "posse/wi-42", merge_state: "pending_review" };

    const session = new RunSession(createRunSessionBootTestDeps({
      listJobs: () => [],
      listWorkItems: () => (autoMergeArgs ? [] : [reviewable]),
      isReviewableWorkItem: () => true,
      cmdReview: async () => {
        reviewOpened = true;
      },
      autoMergeCompletedWorkItems: async (args) => {
        autoMergeArgs = args;
        events.push("auto-merge");
        return 1;
      },
      offerPush: async (count) => {
        pushedCount = count;
        events.push("push");
      },
    }));

    await session.run();

    assert.equal(autoMergeArgs?.reason, "run start");
    assert.equal(reviewOpened, false);
    assert.equal(pushedCount, 1);
    assert.deepEqual(events, ["auto-merge", "push"]);
  });

  it("handles SIGINT during scheduler boot before worker cleanup exists", async () => withCapturedProcessSignals(async (signals) => {
    const events = [];
    let bootOptions = null;
    let stopCalls = 0;
    let workerConstructed = false;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        bootOptions = opts;
        events.push("scheduler.boot");
        assert.equal(signals.count("SIGINT"), 1);
        signals.first("SIGINT")();
        events.push("scheduler.boot.after-sigint");
        return false;
      }

      stop() {
        stopCalls++;
        events.push("scheduler.stop");
      }

      async runLoop() {
        throw new Error("runLoop should not start after interrupted boot");
      }
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      Worker: class {
        constructor() {
          workerConstructed = true;
        }
      },
    }));

    await session.run();

    assert.equal(bootOptions?.onBeforeLoopFatal, true);
    assert.equal(stopCalls, 1);
    assert.equal(workerConstructed, false);
    assert.equal(signals.count("SIGINT"), 0);
    assert.deepEqual(events, [
      "scheduler.boot",
      "scheduler.boot.after-sigint",
      "scheduler.stop",
    ]);
  }));

  it("runs visible shutdown closeout work before ATLAS cleanup", async () => withCapturedProcessSignals(async (signals) => {
    const events = [];

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }

      async runLoop() {
        signals.first("SIGINT")();
        events.push("run-loop-returned");
      }

      stop() {
        events.push("scheduler.stop");
      }
    }

    class FakeWorker {
      execute() {}
      killAllJobs(reason) {
        events.push(`kill:${reason}`);
        return 0;
      }
      sweepActiveDirtyWorktrees(reason, opts = {}) {
        events.push(`sync-sweep:${reason}:${opts.worktreeLockWaitMs}`);
        throw new Error("shutdown should not run sync dirty sweep from signal handler");
      }
      async sweepActiveDirtyWorktreesAsync(reason, opts = {}) {
        events.push(`sweep-async:${reason}:${opts.worktreeLockWaitMs}`);
        return { swept: 0, snapshotted: 0 };
      }
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      jobsNeedGitWorktree: () => true,
      Scheduler: FakeScheduler,
      Worker: FakeWorker,
      startupWorktreeCleanup: async ({ signal } = {}) => {
        events.push(signal ? "worktree-clean:boot" : "worktree-clean:shutdown");
      },
      exitProcess: (code) => {
        events.push(`exit:${code}`);
      },
      wrapUp: async () => {
        throw new Error("wrap-up should be skipped during shutdown");
      },
    }));

    await session.run();

    assert.deepEqual(events, [
      "worktree-clean:boot",
      "kill:shutdown",
      "run-loop-returned",
      "scheduler.stop",
      "sweep-async:shutdown-signal:250",
      "worktree-clean:shutdown",
      "exit:0",
    ]);
  }));

  it("fits live boot monitor rows within the terminal width", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const columns = 72;

    class FakeScheduler {
      constructor() {
        this.leaseSec = 60;
      }

      async boot(opts) {
        await opts.onBeforeLoop();
        return false;
      }

      stop() {}
    }

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: columns,
      writable: true,
    });
    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        jobsNeedGitWorktree: () => true,
        primeProviderUsageAuthAsync: async () => ({
          attempted: true,
          ok: true,
          providers: [{ provider: "claude", attempted: true, ok: true }],
        }),
        getConfiguredProviderUsageAsync: async () => [],
        startupWorktreeCleanup: async () => {},
        ensureAtlasRepoIndexedOnBoot: async (opts) => {
          opts.onProgress({ kind: "start", elapsedMs: 0, stage: "index" });
          opts.onProgress({
            kind: "line",
            elapsedMs: 10,
            stage: "initializing",
            text: "checking ATLAS index with a long status line before SCIP staging begins",
          });
          opts.onProgress({
            kind: "heartbeat",
            elapsedMs: 5000,
            stage: "scip",
            detail: "checking staging SCIP index via scip-php with a long dependency scan detail",
          });
          opts.onProgress({ kind: "end", elapsedMs: 100, stage: "index", ok: true, status: 0 });
          return {
            attempted: true,
            ok: true,
            repoId: "repo-a",
            graphDbPath: "graph.lbug",
          };
        },
      }));

      await session.run();
    } finally {
      process.stdout.write = originalStdoutWrite;
      restoreStdoutTty();
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
        writable: true,
      });
    }

    // The polished boot panel renders a framed box with a "posse boot"
    // title row and grouped sections (scheduler / workspace / providers /
    // atlas) rather than the legacy three-line Boot/ATLAS/SCIP layout.
    // Filter to lines that look like panel rows — box-drawing chars or the
    // title — so unrelated test-runner output doesn't fail the width check.
    const liveRows = writes.flatMap((chunk) => String(chunk)
      .split(/\r|\n/)
      .map((part) => stripAnsi(part.replace(/\x1b\[K/g, "")).trimEnd())
      .filter((line) => /[╭╮╰╯│─]/.test(line) || line.includes("posse")));

    assert.ok(
      liveRows.some((line) => line.includes("posse") && /\bboot\b/.test(line)),
      `expected panel title row, got: ${JSON.stringify(liveRows.slice(0, 4))}`,
    );
    for (const row of liveRows) {
      assert.ok(
        displayColumnWidth(row) <= columns - 3,
        `expected boot monitor row to leave a wrapping gutter within ${columns - 3} columns: ${JSON.stringify(row)}`,
      );
    }
  }));

  it("buffers foreign stdout and stderr while the live boot panel owns the terminal", () => {
    const writes = [];
    const makeStream = (stream) => ({
      isTTY: true,
      write(chunk, ...args) {
        writes.push({ stream, chunk: String(chunk) });
        const callback = args.find((arg) => typeof arg === "function");
        if (callback) callback();
        return true;
      },
    });
    const stdout = makeStream("stdout");
    const stderr = makeStream("stderr");
    const intercept = createTerminalOutputIntercept({ stdout, stderr });

    intercept.install();
    stdout.write("foreign stdout during boot\n");
    stderr.write("foreign stderr during boot\n");

    assert.equal(intercept.active, true);
    assert.equal(intercept.bufferedCount, 2);
    assert.deepEqual(writes, []);

    intercept.writeStdout("panel frame\n");
    assert.deepEqual(writes, [{ stream: "stdout", chunk: "panel frame\n" }]);

    intercept.release();
    assert.deepEqual(writes, [
      { stream: "stdout", chunk: "panel frame\n" },
      { stream: "stdout", chunk: "foreign stdout during boot\n" },
      { stream: "stderr", chunk: "foreign stderr during boot\n" },
    ]);
    assert.equal(intercept.active, false);
    assert.equal(intercept.bufferedCount, 0);
  });

  it("lets Enter release the ONNX encode gate into the background", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const stdinTty = forceStdinTtyForBootPanel();
    let resolveAtlas = null;
    let runLoopStarted = false;
    let onnxWarmRun = null;

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }
      async runLoop(_workerCallback, opts) {
        runLoopStarted = true;
        opts.onDone();
      }
      stop() {}
    }

    class FakeOnnxThreadManager {
      run(workerUrl, opts = {}) {
        onnxWarmRun = { workerUrl, opts };
        opts.onProgress?.({ stage: "ready" });
        return Promise.resolve({ ok: true });
      }
    }

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 100,
      writable: true,
    });
    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureAtlasRepoIndexedOnBoot: async (opts) => {
          opts.onProgress({ kind: "start", elapsedMs: 0, stage: "index" });
          opts.onProgress({
            kind: "line",
            elapsedMs: 10,
            stage: "encoding",
            language: "ts",
            source_languages: ["ts"],
            progress_current: 10,
            progress_total: 100,
            percent: 10,
            text: "encoding symbols",
          });
          await new Promise((resolve) => { resolveAtlas = resolve; });
          return {
            attempted: true,
            ok: true,
            repoId: "repo-a",
            graphDbPath: "graph.lbug",
            result: { purpose: "main-full" },
          };
        },
        getAtlasIntegrationConfig: () => ({
          enabled: true,
          phases: ["dev"],
          bootSoftTimeoutMs: 50,
          // Opt-in wait mode: the default now auto-backgrounds at views-ready,
          // so the Enter escape hatch only renders when the operator asked to
          // block on embeddings.
          bootWaitEmbeddings: true,
        }),
        inspectLocalOnnxStatus: readyOnnxStatus,
        ThreadManager: FakeOnnxThreadManager,
      }));

      const runPromise = session.run();
      await waitForCondition(
        () => writes.join("").includes("hit Enter to load ONNX in the background"),
        "expected ONNX background footer to render",
        100,
      );
      assert.equal(runLoopStarted, false);

      process.stdin.emit("keypress", "\r", { name: "return" });
      await waitForCondition(
        () => runLoopStarted,
        "expected TUI/run loop to start before ATLAS boot promise resolves",
        100,
      );
      assert.deepEqual(stdinTty.rawModes.slice(0, 1), [true]);
      assert.equal(stdinTty.rawModes.at(-1), false);

      resolveAtlas?.({
        attempted: true,
        ok: true,
        repoId: "repo-a",
        graphDbPath: "graph.lbug",
        result: { purpose: "main-full" },
      });
      await runPromise;
      assert.equal(onnxWarmRun?.opts?.unref, true);
      assert.deepEqual(onnxWarmRun?.opts?.workerData, {
        cacheDir: "cache",
        modelName: "test-model",
        modelId: "test-model-id",
        dim: 384,
      });
    } finally {
      if (typeof resolveAtlas === "function") {
        resolveAtlas({
          attempted: true,
          ok: true,
          repoId: "repo-a",
          graphDbPath: "graph.lbug",
          result: { purpose: "main-full" },
        });
      }
      process.stdout.write = originalStdoutWrite;
      stdinTty.restore();
      restoreStdoutTty();
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
        writable: true,
      });
    }
  }));

  it("lets Enter release an ATLAS indexing soft-timeout into the background", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const stdinTty = forceStdinTtyForBootPanel();
    let resolveAtlas = null;
    let runLoopStarted = false;

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }
      async runLoop(_workerCallback, opts) {
        runLoopStarted = true;
        opts.onDone();
      }
      stop() {}
    }

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 100,
      writable: true,
    });
    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureAtlasRepoIndexedOnBoot: async (opts) => {
          opts.onProgress({ kind: "start", elapsedMs: 0, stage: "index" });
          opts.onProgress({
            kind: "line",
            elapsedMs: 10,
            stage: "indexing",
            language: "ts",
            source_languages: ["ts"],
            current: 1,
            total: 100,
            percent: 1,
            text: "indexing source files",
          });
          await new Promise((resolve) => { resolveAtlas = resolve; });
          return {
            attempted: true,
            ok: true,
            repoId: "repo-a",
            graphDbPath: "graph.lbug",
            result: { purpose: "main-full" },
          };
        },
        getAtlasIntegrationConfig: () => ({
          enabled: true,
          phases: ["dev"],
          bootSoftTimeoutMs: 25,
        }),
        inspectLocalOnnxStatus: () => ({ status: "not_configured" }),
      }));

      const runPromise = session.run();
      await waitForCondition(
        () => writes.join("").includes("hit Enter to continue with ATLAS in the background"),
        "expected ATLAS background footer to render before encoding starts",
        150,
      );
      assert.equal(runLoopStarted, false);

      process.stdin.emit("keypress", "\r", { name: "return" });
      await waitForCondition(
        () => runLoopStarted,
        "expected run loop to start after ATLAS indexing is backgrounded",
        150,
      );
      assert.deepEqual(stdinTty.rawModes.slice(0, 1), [true]);
      assert.equal(stdinTty.rawModes.at(-1), false);

      resolveAtlas?.();
      await runPromise;
    } finally {
      resolveAtlas?.();
      process.stdout.write = originalStdoutWrite;
      stdinTty.restore();
      restoreStdoutTty();
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
        writable: true,
      });
    }
  }));

  it("queues self-repair when backgrounded ONNX boot later rejects (opt-in wait mode)", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const stdinTty = forceStdinTtyForBootPanel();
    let rejectAtlas = null;
    let finishRunLoop = null;
    let runLoopStarted = false;
    const selfRepairCalls = [];

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }
      async runLoop(_workerCallback, opts) {
        runLoopStarted = true;
        await new Promise((resolve) => { finishRunLoop = resolve; });
        opts.onDone();
      }
      stop() {}
    }

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 100,
      writable: true,
    });
    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureAtlasRepoIndexedOnBoot: async (opts) => {
          opts.onProgress({ kind: "start", elapsedMs: 0, stage: "index" });
          opts.onProgress({
            kind: "line",
            elapsedMs: 10,
            stage: "encoding",
            language: "ts",
            source_languages: ["ts"],
            progress_current: 10,
            progress_total: 100,
            percent: 10,
            text: "encoding symbols",
          });
          await new Promise((_resolve, reject) => { rejectAtlas = reject; });
          return {
            attempted: true,
            ok: true,
            repoId: "repo-a",
            graphDbPath: "graph.lbug",
            result: { purpose: "main-full" },
          };
        },
        getAtlasIntegrationConfig: () => ({
          enabled: true,
          phases: ["dev"],
          bootSoftTimeoutMs: 50,
          bootWaitEmbeddings: true,
        }),
        inspectLocalOnnxStatus: () => ({ status: "not_configured" }),
        enqueueAtlasSelfRepair: (args) => {
          selfRepairCalls.push(args);
          return { ok: true, summary: "views ready", layers: [], actions: [] };
        },
      }));

      const runPromise = session.run();
      await waitForCondition(
        () => writes.join("").includes("hit Enter to load ONNX in the background"),
        "expected ONNX background footer to render",
        100,
      );
      process.stdin.emit("keypress", "\r", { name: "return" });
      await waitForCondition(
        () => runLoopStarted,
        "expected run loop to start before background rejection",
        100,
      );

      rejectAtlas?.(new Error("ATLAS v2 boot worker timed out after 5400000ms"));
      await waitForCondition(
        () => selfRepairCalls.some((call) => /boot_background_failed/.test(call?.reason || "")),
        "expected background boot failure to queue ATLAS self-repair",
        100,
      );
      finishRunLoop?.();
      await runPromise;
    } finally {
      finishRunLoop?.();
      if (typeof rejectAtlas === "function") {
        rejectAtlas(new Error("test cleanup"));
      }
      process.stdout.write = originalStdoutWrite;
      stdinTty.restore();
      restoreStdoutTty();
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
        writable: true,
      });
    }
  }));

  it("auto-backgrounds the boot gate at views-ready (encoding start) by default", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();
    const stdinTty = forceStdinTtyForBootPanel();
    let resolveAtlas = null;
    let finishRunLoop = null;
    let runLoopStarted = false;

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        return true;
      }
      async runLoop(_workerCallback, opts) {
        runLoopStarted = true;
        await new Promise((resolve) => { finishRunLoop = resolve; });
        opts.onDone();
      }
      stop() {}
    }

    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 100,
      writable: true,
    });
    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        ensureAtlasRepoIndexedOnBoot: async (opts) => {
          opts.onProgress({ kind: "start", elapsedMs: 0, stage: "index" });
          // Encoding events fire only after SCIP intake + view merge, so this
          // is the "SCIP + views ready" signal the default gate releases on.
          opts.onProgress({
            kind: "line",
            elapsedMs: 10,
            stage: "encoding",
            language: "ts",
            source_languages: ["ts"],
            progress_current: 10,
            progress_total: 100,
            percent: 10,
            text: "encoding symbols",
          });
          await new Promise((resolve) => { resolveAtlas = resolve; });
          return {
            attempted: true,
            ok: true,
            repoId: "repo-a",
            graphDbPath: "graph.lbug",
            result: { purpose: "main-full" },
          };
        },
        getAtlasIntegrationConfig: () => ({
          enabled: true,
          phases: ["dev"],
          bootSoftTimeoutMs: 50,
        }),
        inspectLocalOnnxStatus: () => ({ status: "not_configured" }),
      }));

      const runPromise = session.run();
      // No Enter keypress: views-ready must release the gate by itself while
      // the encode keeps running behind the TUI.
      await waitForCondition(
        () => runLoopStarted,
        "expected run loop to start without Enter once encoding (views-ready) began",
        150,
      );
      resolveAtlas?.();
      finishRunLoop?.();
      await runPromise;
    } finally {
      resolveAtlas?.();
      finishRunLoop?.();
      process.stdout.write = originalStdoutWrite;
      stdinTty.restore();
      restoreStdoutTty();
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
        writable: true,
      });
    }
  }));

  it("continues into the run loop when ATLAS boot times out", async () => withCapturedProcessSignals(async () => {
    const events = [];
    const selfRepairCalls = [];

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        events.push("booted");
        return true;
      }
      async runLoop(_workerCallback, opts) {
        events.push("runLoop");
        opts.onDone();
      }
      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      ensureAtlasRepoIndexedOnBoot: async () => ({
        attempted: true,
        ok: false,
        status: 1,
        repoId: "repo-a",
        graphDbPath: "graph.lbug",
        error: "ATLAS v2 boot worker timed out after 5400000ms",
      }),
      getAtlasIntegrationConfig: () => ({
        enabled: true,
        phases: ["dev"],
        bootSoftTimeoutMs: 0,
      }),
      enqueueAtlasSelfRepair: (args) => {
        selfRepairCalls.push(args);
        return { ok: true, summary: "views warming", layers: [], actions: [] };
      },
    }));

    await session.run();

    assert.deepEqual(events, ["booted", "runLoop"]);
    assert.ok(
      selfRepairCalls.some((call) => /boot_reindex_failed/.test(call?.reason || "")),
      "expected a failed boot reindex to queue ATLAS self-repair instead of disabling ATLAS",
    );
  }));

  it("continues into the run loop when ATLAS boot wait rejects", async () => withCapturedProcessSignals(async () => {
    const events = [];
    const selfRepairCalls = [];

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) {
        await opts.onBeforeLoop();
        events.push("booted");
        return true;
      }
      async runLoop(_workerCallback, opts) {
        events.push("runLoop");
        opts.onDone();
      }
      stop() {}
    }

    const session = new RunSession(createRunSessionBootTestDeps({
      Scheduler: FakeScheduler,
      ensureAtlasRepoIndexedOnBoot: async () => {
        throw new Error("ATLAS v2 boot worker timed out after 5400000ms");
      },
      getAtlasIntegrationConfig: () => ({
        enabled: true,
        phases: ["dev"],
        bootSoftTimeoutMs: 0,
      }),
      enqueueAtlasSelfRepair: (args) => {
        selfRepairCalls.push(args);
        return { ok: true, summary: "views warming", layers: [], actions: [] };
      },
    }));

    await session.run();

    assert.deepEqual(events, ["booted", "runLoop"]);
    assert.ok(
      selfRepairCalls.some((call) => /boot_wait_failed/.test(call?.reason || "")),
      "expected a rejected boot wait to queue ATLAS self-repair instead of disabling ATLAS",
    );
  }));

  it("folds image-capability provider rows into the base provider chip", async () => withCapturedProcessSignals(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const writes = [];
    const originalStdoutWrite = process.stdout.write;
    const restoreStdoutTty = forceStdoutTtyForBootPanel();

    class FakeScheduler {
      constructor() { this.leaseSec = 60; }
      async boot(opts) { await opts.onBeforeLoop(); return false; }
      stop() {}
    }

    process.stdout.write = (chunk, ...args) => {
      writes.push(String(chunk));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) callback();
      return true;
    };

    try {
      const session = new RunSession(createRunSessionBootTestDeps({
        Scheduler: FakeScheduler,
        jobsNeedGitWorktree: () => false,
        // grok appears twice (role row + image-capability row); copilot is
        // configured *only* for images, so its sole row carries the suffix.
        getProviderHealth: () => [
          { provider: "claude", status: "available" },
          { provider: "grok", status: "available" },
          { provider: "grok-images", status: "unavailable", detail: "no image model" },
          { provider: "copilot-images", status: "available" },
        ],
        primeProviderUsageAuthAsync: async () => ({ attempted: false, providers: [] }),
        getConfiguredProviderUsageAsync: async () => [],
      }));
      await session.run();
    } finally {
      process.stdout.write = originalStdoutWrite;
      restoreStdoutTty();
    }

    const text = writes.map((chunk) => stripAnsi(String(chunk).replace(/\x1b\[K/g, ""))).join("");
    // Base provider names show; the "-images" capability suffix never does.
    assert.ok(/\bgrok\b/.test(text), "expected a grok chip");
    assert.ok(/\bcopilot\b/.test(text), "image-only provider must still surface under its base name");
    assert.ok(!text.includes("grok-images"), "image-capability suffix must not render");
    assert.ok(!text.includes("copilot-images"), "image-capability suffix must not render");
    // The role row wins — grok stays available despite the image row failing.
    const providerLines = text.split("\n").filter((line) => /\bgrok\b/.test(line));
    assert.ok(providerLines.length > 0, "expected grok to appear on a rendered row");
  }));

  it("keeps long provider failure details from resizing the boot panel", () => {
    const C = { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "" };
    const panel = createBootPanel({ C, columns: () => 120 });
    // Measure the box BORDER width (spinner-free). The running row carries the
    // animated spinner glyph, which is East-Asian-ambiguous width: displayColumnWidth
    // counts it as 2 cols while the panel (and narrow-ambiguous terminals like
    // Windows Terminal) render it as 1. The border reflects the true box width
    // without that ambiguity.
    const boxWidth = (lines) => Math.max(...lines
      .filter((line) => /^[╭╰]/.test(stripAnsi(line)))
      .map((line) => displayColumnWidth(stripAnsi(line))));
    panel.updateStep("claude", { section: "providers", status: "running", detail: "OAuth" });
    const before = boxWidth(panel.lines());

    panel.updateStep("claude", {
      section: "providers",
      status: "failed",
      detail: "Claude OAuth warmup timed out after 10000ms while waiting for a very long local auth diagnostic to finish",
    });
    const afterLines = panel.lines();
    const after = boxWidth(afterLines);

    assert.equal(after, before);
    assert.ok(after <= 119);

    // The long failure detail must NOT appear in a checklist row — the rows
    // stay fixed-width `icon label elapsed`. It renders in the notes section
    // under the checklist divider instead, so the columns can't bounce.
    const stripped = afterLines.map((line) => stripAnsi(line));
    const claudeRow = stripped.find((row) => /✓|✗/.test(row) && row.includes("claude") && row.includes("│"));
    assert.ok(claudeRow, "expected a claude checklist row");
    assert.ok(!claudeRow.includes("timed out"), "failure detail must not render in the checklist row");
    assert.ok(
      stripped.some((row) => row.includes("claude") && row.includes("timed out")),
      "failure detail must render in the notes section",
    );
  });

  it("surfaces only errors/warnings in boot notes, filtering cascades and progress", () => {
    const C = { bold: "", reset: "", green: "", cyan: "", yellow: "", dim: "", red: "" };
    const panel = createBootPanel({ C, columns: () => 120 });
    panel.updateStep("git ready", { section: "workspace", status: "failed", detail: "not a git repo" });
    panel.updateStep("worktree cleanup", { section: "workspace", status: "failed", detail: "blocked: git not ready" });
    panel.updateStep("dependencies", { section: "workspace", status: "skipped", detail: "lockfile missing" });
    panel.updateStep("claude", { section: "providers", status: "deferred", detail: "auth in background" });
    panel.updateStep("usage", { section: "providers", status: "ok", detail: "all good" });

    const text = panel.lines().map((line) => stripAnsi(line)).join("\n");

    // Errors + warnings surface.
    assert.ok(text.includes("git ready · not a git repo"), "error should surface in notes");
    assert.ok(text.includes("dependencies · lockfile missing"), "warning (skip) should surface in notes");
    // Cascade and pure "what it's doing" status must not.
    assert.ok(!text.includes("not ready"), "cascade 'not ready' should be filtered");
    assert.ok(!text.includes("auth in background"), "deferred/background status must not surface");
    assert.ok(!text.includes("all good"), "ok progress detail must not surface");
  });

  it("releases scheduler lock when a fatal pre-loop hook fails", async () => withTempRuntimeDb(async () => {
    const scheduler = new Scheduler({ ownerId: "sched-preloop-fail", pollMs: 5, leaseSec: 60 });
    const booted = await scheduler.boot({
      onBeforeLoopFatal: true,
      onBeforeLoop: () => {
        throw new Error("startup cleanup failed");
      },
    });

    assert.equal(booted, false);
    assert.equal(getSchedulerLockInfo("main"), null);
  }));

  it("marks lock acquisition complete after stealing a stale lock", async () => withTempRuntimeDb(async () => {
    assert.equal(acquireSchedulerLock("main", "stale-scheduler", 120), true);
    getDb().prepare(`
      UPDATE scheduler_locks
      SET acquired_at = ?, expires_at = ?
      WHERE lock_name = 'main'
    `).run(
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() + 120_000).toISOString(),
    );
    const events = [];
    const scheduler = new Scheduler({ ownerId: "sched-steal", pollMs: 5, leaseSec: 60 });

    const booted = await scheduler.acquireBootLock({ onBootEvent: (event) => events.push(event) });
    scheduler.stop();

    assert.equal(booted, true);
    assert.equal(getSchedulerLockInfo("main"), null);
    assert.deepEqual(events.at(-1), {
      label: "lock acquired",
      section: "scheduler",
      status: "ok",
      detail: "held",
    });
  }));

  it("exits scheduler boot when pre-loop hooks request stop", async () => withTempRuntimeDb(async () => {
    const scheduler = new Scheduler({ ownerId: "sched-preloop-stop", pollMs: 5, leaseSec: 60 });
    const booted = await scheduler.boot({
      onBeforeLoop: () => {
        scheduler.stop();
      },
    });

    assert.equal(booted, false);
    assert.equal(getSchedulerLockInfo("main"), null);
  }));
});
