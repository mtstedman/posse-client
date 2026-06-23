// lib/display.js - Split-screen terminal UI with input handling
//
// Layout:
//   Top:     Progress bar (full width, glued)
//   Middle:  Workers + Queue (left) | Event log (right)
//   Bottom:  Input prompt / Questions / Kill menu / Hints (full width)
//
// Uses the alternate screen buffer so the TUI never pollutes scrollback.
// Supports raw stdin keypress input for questions, inject, kill commands.

import readline from "readline";
import { DisplayInputController } from "./input-controller.js";
import { DisplayApprovalRenderer } from "./approval-renderer.js";
import { DisplayFrameRenderer } from "./frame-renderer.js";
import { DisplayOverlayRenderer } from "./overlay-renderer.js";
import { DisplayStatusRenderer } from "./status-renderer.js";
import { DisplayBottomInputRenderer } from "./bottom-input-renderer.js";
import { DisplayLeftPanelRenderer } from "./left-panel-renderer.js";
import { DisplayRightPanelRenderer } from "./right-panel-renderer.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { statusColor } from "../../functions/display/status-palette.js";
import {
  STALE_CANCELABLE_JOB_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
} from "../../../queue/functions/common.js";
import {
  listWorkItems,
  listJobs,
} from "../../../queue/functions/index.js";
import {
  stripAnsi,
  formatConsoleArg,
  _sanitizeDisplayLine,
  _colorizeAssessorVerdictWords,
  _isNoisyStructuredStderr,
  _isLowSignalWorkerCompletionMarker,
  _isLowSignalStructuredMarker,
} from "../../functions/display/helpers/formatters.js";
import { roleBrandColor, roleBrandIcon, roleBrandLabel } from "../../functions/display/helpers/brand.js";
import { getCatalogRuntimeFallbackInt } from "../../../settings/functions/catalog.js";
import {
  getDisplayEventRateLimitPerSec,
  getDisplayMaxEvents,
} from "../../../settings/functions/tunables.js";
import {
  jobLabel,
  jobReportStatus,
  workItemDisplayStatus,
} from "../../functions/display/helpers/job-status.js";
import {
  PROVIDER_USAGE_REFRESH_MS,
  _refreshProviderUsageSummaryCacheIfChanged,
} from "../../functions/display/helpers/provider-usage.js";

export { jobLabel, jobReportStatus, workItemDisplayStatus };

export function computeRenderMinGap({ force = false, reason = "general", pendingInput = false } = {}) {
  if (force) return 16;
  if (pendingInput) return 24;
  if (reason === "stream") return 33;
  if (reason === "event") return 40;
  if (reason === "queue-snapshot") return 80;
  return 48;
}

const WORKER_BOOT_SLOW_MS = 15_000;
const WORKER_BOOT_STALLED_MS = 45_000;
const DEFAULT_DISPLAY_CONCURRENCY = getCatalogRuntimeFallbackInt("scheduler_concurrency", 3);
const PROVIDER_USAGE_REFRESH_TIMEOUT_MS = Math.min(15_000, Math.max(1_000, PROVIDER_USAGE_REFRESH_MS - 1_000));
const PROVIDER_USAGE_REFRESH_ERROR_MIN_MS = 60_000;

function rawInputKey(name, sequence, patch = {}) {
  return {
    name,
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
    ...patch,
  };
}

function decodeRawInputChunk(raw) {
  const text = String(raw || "");
  const events = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const rest = text.slice(i);
    if (ch === "\u0003") {
      events.push({ str: ch, key: rawInputKey("c", ch, { ctrl: true }) });
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      events.push({ str: ch, key: rawInputKey("return", ch) });
      continue;
    }
    if (ch === "\t") {
      events.push({ str: ch, key: rawInputKey("tab", ch) });
      continue;
    }
    if (ch === "\b" || ch === "\x7f") {
      events.push({ str: ch, key: rawInputKey("backspace", ch) });
      continue;
    }
    if (ch === "\x1b") {
      const known = [
        ["\x1b[A", "up", {}],
        ["\x1b[B", "down", {}],
        ["\x1b[C", "right", {}],
        ["\x1b[D", "left", {}],
        ["\x1bOA", "up", {}],
        ["\x1bOB", "down", {}],
        ["\x1bOC", "right", {}],
        ["\x1bOD", "left", {}],
        ["\x1b[Z", "tab", { shift: true }],
      ];
      const match = known.find(([seq]) => rest.startsWith(seq));
      if (match) {
        const [seq, name, patch] = match;
        events.push({ str: seq, key: rawInputKey(name, seq, patch) });
        i += seq.length - 1;
      } else {
        events.push({ str: ch, key: rawInputKey("escape", ch) });
      }
      continue;
    }
    if (ch >= " " && ch <= "~") {
      const lower = ch.toLowerCase();
      events.push({
        str: ch,
        key: rawInputKey(ch === " " ? "space" : lower, ch, {
          shift: ch !== lower,
        }),
      });
    }
  }
  return events;
}

function stableRowSignature(row) {
  if (!row || typeof row !== "object") return row == null ? null : String(row);
  const keys = Object.keys(row).sort();
  return keys.map((key) => [key, row[key] ?? null]);
}

function queueSnapshotSignature(snapshot) {
  return JSON.stringify({
    workItems: (Array.isArray(snapshot?.workItems) ? snapshot.workItems : []).map(stableRowSignature),
    jobs: (Array.isArray(snapshot?.jobs) ? snapshot.jobs : []).map(stableRowSignature),
  });
}

// ─── Display ────────────────────────────────────────────────────────────────

export class Display {
  constructor({
    concurrency = DEFAULT_DISPLAY_CONCURRENCY,
    runStartedAtIso = null,
    providerUsageRefresh = _refreshProviderUsageSummaryCacheIfChanged,
  } = {}) {
    this.concurrency = concurrency;
    this.workers = new Map();   // jobId -> { role, activity, startTime, tier, attempt }
    this.events = [];           // { time, text } — main job/work-item log lane
    // System lane: git / ATLAS reindex chatter, kept out of the scrolling log
    // and pinned as a short tail at the bottom of the event pane so it can't
    // flood the work events. Bounded ring, independent of `maxEvents`.
    this._systemEvents = [];    // { time, text }
    this._maxSystemEvents = 50;
    this._systemLaneRows = 4;
    this._lifecycleStartedJobs = new Set();
    this.maxEvents = getDisplayMaxEvents();
    this._eventRateLimitPerSec = getDisplayEventRateLimitPerSec();
    this._interval = null;
    this._started = false;
    this._spinIdx = 0;
    this._lastFrame = "";
    this._lastFrameBase = "";
    this._lastFrameInput = "";
    this._blockingOverlayBaseFrame = "";
    this._blockingOverlayBaseKey = "";
    this._queueDataCache = { at: 0, workItems: [], jobs: [] };
    this._queueSnapshotSignature = null;
    this._dirtyStateCache = { at: 0, state: null };
    this._renderScheduled = false;
    this._renderTimer = null;
    this._scheduledRenderAt = 0;
    this._scheduledRenderReason = "general";
    this._lastRenderAt = 0;
    this._stdoutBackedUp = false;
    this._lastRenderErrorAt = 0;
    this._eventRate = { at: 0, count: 0, dropped: 0, flushTimer: null };
    this._lastSigintAt = 0;
    this._mode = "normal";      // "normal" | "approval"
    this._usingAlternateScreen = false;
    this._origConsoleLog = null;
    this._origConsoleError = null;
    this._consoleLogIntercept = null;
    this._consoleErrorIntercept = null;
    this._consoleInterceptState = null;
    this._lastKeypressAt = 0;
    this._lastKeypressSequence = "";
    this._keypressSeqSinceData = "";
    this._rawInputFallbackTimers = new Set();

    // ── Input / question state ──
    this._questionQueue = [];   // { id, jobId, questions, context, answers, currentIdx, resolve, reject }
    this._nextQId = 1;
    this._inputMode = false;    // "question" | "inject" | "kill" | false
    this._activeQ = null;       // the question-set currently being answered
    this._inputBuf = "";        // what the user has typed so far
    this._aborted = false;

    // ── Callbacks (set by orchestrator) ──
    this.onInject = null;       // (description: string) => void
    this.onKill = null;         // (jobId: number) => void
    this.onKillWI = null;       // (wiId: number) => void
    this.onSkipJob = null;      // (jobId: number) => void
    this.onAsk = null;          // (question: string) => void
    this.onNudge = null;        // (jobId: number, correction: string) => void
    this.onImage = null;        // (prompt: string) => void
    this.onReviewPending = null; // () => void
    this.onApprovalAction = null; // (wiId: number, action: string) => void
    this.getPipelineData = null;  // () => [{ wi, jobs, artifacts }] — for pipeline view
    this.getToolData = null;      // () => { jobs, recent, activeLocks } — for tool view
    this.getDirtyState = null;    // () => { targetDirty, dirtyItems } — for queue review flags

    // ── Right panel mode ──
    this._rightMode = "log";    // "log" | "pipeline" | "tools"
    this._pipelineScroll = 0;
    this._toolScroll = 0;
    this._toolsTab = 0;         // 0=tools, 1=roles, 2=locks
    this._toolsTabScrolls = [0, 0, 0];
    this._providerUsageRefreshTimer = null;
    this._lastProviderUsageRefreshErrorAt = 0;
    this._providerUsageRefresh = typeof providerUsageRefresh === "function"
      ? providerUsageRefresh
      : _refreshProviderUsageSummaryCacheIfChanged;
    this._runStartedAtIso = runStartedAtIso || new Date().toISOString();
    this._blockedByLock = 0;
    this._blockedByLockDetails = [];
    this._runPhaseMessage = null;
    this._blockingOverlay = null;
    this._inputController = new DisplayInputController();
    // DisplayInputController is intentionally used as a Display-state mixin:
    // wrapper methods below invoke controller methods with the Display as `this`.
    this._approvalRenderer = new DisplayApprovalRenderer();
    this._frameRenderer = new DisplayFrameRenderer();
    this._overlayRenderer = new DisplayOverlayRenderer();
    this._statusRenderer = new DisplayStatusRenderer();
    this._bottomInputRenderer = new DisplayBottomInputRenderer();
    this._leftPanelRenderer = new DisplayLeftPanelRenderer();
    this._rightPanelRenderer = new DisplayRightPanelRenderer();

    // ── Approval mode state ──
    this._approvalData = null;  // array of report objects
    this._approvalIdx = 0;      // which WI is selected
    this._approvalScroll = 0;   // scroll offset
    this._approvalDone = null;  // resolve fn for the promise
    this._approvalTab = 0;      // 0=Tasks, 1=Tokens, 2=Research, 3=Details
    this._approvalTabScrolls = [0, 0, 0, 0]; // per-tab scroll positions
    this._approvalPicker = null; // {itemId, candidates, selected:Set, cursor} when picking files to discard
    this._approvalMemoryPicker = null; // {itemId, memories, cursor, textEntry} while reviewing surfaced memories
    this._approvalActionBusy = false;
    this._approvalExitConfirm = false;
    this._approvalFlash = null;

    this.cols = process.stdout.columns || 120;
    this.rows = process.stdout.rows || 40;

    this._onResize = () => {
      this._refreshViewport();
      if (this._started) {
        this._lastFrame = "";
        this._lastFrameInput = "";
        this._resetBlockingOverlayBaseFrame();
        process.stdout.write("\x1b[2J");
        this.requestRender({ force: true });
      }
    };
    this._onProcessExit = () => {
      if (!this._started) return;
      try { this.stop(); } catch { /* best effort */ }
    };
  }

  _refreshViewport() {
    const nextCols = process.stdout.columns || 120;
    const nextRows = process.stdout.rows || 40;
    const changed = nextCols !== this.cols || nextRows !== this.rows;
    this.cols = nextCols;
    this.rows = nextRows;
    if (changed) {
      this._lastFrame = "";
      this._lastFrameInput = "";
      this._resetBlockingOverlayBaseFrame();
    }
    return changed;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._refreshViewport();
    this._runStartedAtIso ||= new Date().toISOString();
    process.stdout.on("resize", this._onResize);
    process.on("exit", this._onProcessExit);

    // Intercept console.log so stray output goes to event log instead of corrupting TUI.
    this._origConsoleLog = console.log;
    this._origConsoleError = console.error;
    const consoleInterceptState = {
      active: true,
      log: this._origConsoleLog,
      error: this._origConsoleError,
    };
    this._consoleInterceptState = consoleInterceptState;
    this._consoleLogIntercept = (...args) => {
      if (!consoleInterceptState.active) {
        try { return consoleInterceptState.log?.(...args); } catch { return undefined; }
      }
      const text = args.map(formatConsoleArg).join(" ");
      this.addEvent(text.replace(/^\s+/, ""));
    };
    this._consoleErrorIntercept = (...args) => {
      if (!consoleInterceptState.active) {
        try { return consoleInterceptState.error?.(...args); } catch { return undefined; }
      }
      const text = args.map(formatConsoleArg).join(" ");
      this.addEvent(`${C.red}${text.replace(/^\s+/, "")}${C.reset}`);
      try { consoleInterceptState.error?.(...args); } catch { /* preserve TUI even if stderr is closed */ }
    };
    console.log = this._consoleLogIntercept;
    console.error = this._consoleErrorIntercept;

    // Raw-mode stdin for keypress handling
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this._keypressHandler = (str, key) => {
        this._lastKeypressAt = Date.now();
        this._lastKeypressSequence = String(key?.sequence || str || "");
        this._keypressSeqSinceData += this._lastKeypressSequence;
        this._onKeypress(str, key);
      };
      process.stdin.on("keypress", this._keypressHandler);
      this._stdinDataHandler = (chunk) => {
        const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        if (raw.includes("\u0003")) {
          this._emitSigint();
          return;
        }
        this._scheduleRawInputFallback(raw);
      };
      process.stdin.on("data", this._stdinDataHandler);
    }

    // Enter alternate screen buffer, hide cursor, clear. Non-TTY stdout (for
    // example `posse run > log.txt`) should not receive terminal escapes.
    this._usingAlternateScreen = !!process.stdout.isTTY;
    if (this._usingAlternateScreen) {
      process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    }
    this._providerUsageRefreshTimer = setInterval(async () => {
      await this._refreshProviderUsageForDisplay();
    }, PROVIDER_USAGE_REFRESH_MS);
    this._interval = setInterval(() => this.requestRender({ advanceAnimation: true }), 120);
    this.requestRender({ force: true });
    setTimeout(async () => {
      if (!this._started) return;
      await this._refreshProviderUsageForDisplay();
    }, 0);
  }

  async _refreshProviderUsageForDisplay() {
    let timeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`provider usage refresh timed out after ${PROVIDER_USAGE_REFRESH_TIMEOUT_MS}ms`));
      }, PROVIDER_USAGE_REFRESH_TIMEOUT_MS);
      timeout.unref?.();
    });
    try {
      const changed = await Promise.race([
        this._providerUsageRefresh({ runStartedAtIso: this._runStartedAtIso }),
        timeoutPromise,
      ]);
      if (changed && this._started) this.requestRender({ reason: "event" });
    } catch (err) {
      this._recordProviderUsageRefreshError(err);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  _recordProviderUsageRefreshError(err) {
    const now = Date.now();
    if (now - this._lastProviderUsageRefreshErrorAt < PROVIDER_USAGE_REFRESH_ERROR_MIN_MS) return;
    this._lastProviderUsageRefreshErrorAt = now;
    const message = String(err?.message || err || "unknown provider usage refresh error").split("\n")[0].slice(0, 140);
    this.addEvent(`${C.dim}provider usage refresh unavailable: ${message}${C.reset}`, { reason: "event" });
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (this._providerUsageRefreshTimer) { clearInterval(this._providerUsageRefreshTimer); this._providerUsageRefreshTimer = null; }
    this._renderScheduled = false;
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._scheduledRenderAt = 0;
    this._scheduledRenderReason = "general";
    if (this._eventRate.flushTimer) {
      clearTimeout(this._eventRate.flushTimer);
      this._eventRate.flushTimer = null;
    }
    this._lifecycleStartedJobs.clear();
    for (const timer of this._rawInputFallbackTimers) clearTimeout(timer);
    this._rawInputFallbackTimers.clear();
    this._cancelApprovalMode();
    process.stdout.off("resize", this._onResize);
    process.off("exit", this._onProcessExit);

    // Tear down raw input
    if (process.stdin.isTTY && this._keypressHandler) {
      process.stdin.off("keypress", this._keypressHandler);
      if (this._stdinDataHandler) process.stdin.off("data", this._stdinDataHandler);
      try { process.stdin.setRawMode(false); } catch { /* may already be closed */ }
      process.stdin.pause();
      this._keypressHandler = null;
      this._stdinDataHandler = null;
    }

    // Restore console only if no later wrapper has replaced our interceptor.
    // If a later wrapper captured our function, the interceptor falls through
    // to the original sink after stop() instead of swallowing output.
    const origLog = this._origConsoleLog;
    const origError = this._origConsoleError;
    if (this._consoleInterceptState) this._consoleInterceptState.active = false;
    if (origLog && console.log === this._consoleLogIntercept) console.log = origLog;
    if (origError && console.error === this._consoleErrorIntercept) console.error = origError;
    this._consoleInterceptState = null;
    this._origConsoleLog = null;
    this._origConsoleError = null;

    // Leave alternate screen buffer, show cursor
    if (this._usingAlternateScreen) {
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      this._usingAlternateScreen = false;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  _scheduleRawInputFallback(raw) {
    const sequence = String(raw || "");
    if (!sequence) return;
    const now = Date.now();
    // readline emits this chunk's keypress events before our data handler
    // runs, so the accumulator already holds them here. Consume it per chunk;
    // a chunk is "handled" when the keypress sequences seen since the last
    // chunk reproduce it (a paste is one chunk but many keypress events).
    const seenForChunk = this._keypressSeqSinceData;
    this._keypressSeqSinceData = "";
    const coveredByKeypress = (seen) =>
      seen === sequence
      || this._lastKeypressSequence === sequence
      || (seen.length > 0 && seen.length >= sequence.length);
    if (coveredByKeypress(seenForChunk) && now - this._lastKeypressAt < 50) {
      return;
    }
    const timer = setTimeout(() => {
      this._rawInputFallbackTimers.delete(timer);
      // Late keypress events (e.g. readline's escape-sequence timeout) land in
      // the fresh accumulator, so include it in the recheck.
      const handledByKeypress =
        coveredByKeypress(seenForChunk + this._keypressSeqSinceData)
        && Date.now() - this._lastKeypressAt < 80;
      if (handledByKeypress || !this._started) return;
      for (const event of decodeRawInputChunk(sequence)) {
        this._onKeypress(event.str, event.key);
      }
    }, 20);
    this._rawInputFallbackTimers.add(timer);
    timer.unref?.();
  }

  _emitSigint() {
    const now = Date.now();
    if (now - this._lastSigintAt < 250) return;
    this._lastSigintAt = now;
    this.cancelAllQuestions();
    process.emit("SIGINT");
  }

  addEvent(text, { reason = "event" } = {}) {
    if (this._shouldSuppressEventLogLine(text)) return;
    const now = Date.now();
    if (now - this._eventRate.at > 1000) {
      this._flushDroppedEvents();
      this._eventRate.at = now;
      this._eventRate.count = 0;
    }
    this._eventRate.count++;
    if (this._eventRate.count > this._eventRateLimitPerSec) {
      this._eventRate.dropped++;
      if (!this._eventRate.flushTimer) {
        this._eventRate.flushTimer = setTimeout(() => {
          this._eventRate.flushTimer = null;
          this._flushDroppedEvents();
          this.requestRender({ reason });
        }, 80);
      }
      return;
    }
    this._appendEvent(text);
    this.requestRender({ reason });
  }

  _shouldSuppressEventLogLine(text) {
    const plainText = stripAnsi(String(text || "")).trim();
    if (!plainText) return false;
    if (/^Job #\d+ started:/i.test(plainText)) return true;
    if (/^\[scheduler\]\s+(?:Dispatch paused|Resuming dispatch|Dispatch resumed):\s+ATLAS indexing\b/i.test(plainText)) return true;
    if (this._isLowSignalPromoteEvent(plainText)) return true;
    const lifecycleStartKey = this._lifecycleStartEventKey(plainText);
    if (lifecycleStartKey) {
      if (this._lifecycleStartedJobs.has(lifecycleStartKey)) return true;
      this._lifecycleStartedJobs.add(lifecycleStartKey);
    }
    return false;
  }

  // [promote] lifecycle lines are pure plumbing and are dropped outright unless
  // they carry a failure/warning. [system] lines are NOT dropped here — they are
  // routed to the pinned "system" tail by _eventLane so worktree/GC/commit/ATLAS
  // plumbing stays visible (just out of the main log).
  _isLowSignalPromoteEvent(plainText) {
    const text = String(plainText || "").trim();
    if (!/^\[promote\](?:\s|$)/i.test(text)) return false;
    return !/\b(?:fail(?:ed|ure)?|error|warn(?:ing)?|blocked|conflict|stale|lost|missing|denied|unauthorized|timeout|interrupted|aborted|cancell?ed)\b/i.test(text);
  }

  _lifecycleStartEventKey(plainText) {
    const match = String(plainText || "").match(
      /^\[(?:developer|dev|researcher|research|planner|assessor|delegator|artificer|human|system)\]\s+(?:WI#\d+\s+)?job\s+#(\d+):\s*started\b/i,
    );
    if (!match) return null;
    return `job:${Number(match[1])}`;
  }

  _visibleKillJobIds() {
    const jobIds = Array.isArray(this._killJobIds) ? this._killJobIds : [...this.workers.keys()];
    const visible = jobIds.filter((jobId) => this.workers.has(jobId));
    if (Array.isArray(this._killJobIds)) this._killJobIds = visible;
    return visible;
  }

  _visibleNudgeJobIds() {
    const jobIds = Array.isArray(this._nudgeJobIds)
      ? this._nudgeJobIds
      : this._getNudgeWorkers().map(([jobId]) => jobId);
    const visible = jobIds.filter((jobId) => this.workers.has(jobId));
    if (Array.isArray(this._nudgeJobIds)) this._nudgeJobIds = visible;
    return visible;
  }

  setRunPhase(message = null) {
    const next = String(message || "").trim() || null;
    if (this._runPhaseMessage === next) return;
    this._runPhaseMessage = next;
    this.requestRender({ reason: "event" });
  }

  setBlockingOverlay(title = null, subtitle = null) {
    const cleanTitle = String(title || "").trim();
    const cleanSubtitle = String(subtitle || "").trim();
    const next = cleanTitle ? { title: cleanTitle, subtitle: cleanSubtitle } : null;
    const currentKey = this._blockingOverlay ? `${this._blockingOverlay.title}\n${this._blockingOverlay.subtitle || ""}` : "";
    const nextKey = next ? `${next.title}\n${next.subtitle || ""}` : "";
    if (currentKey === nextKey) return;
    if (!next || !this._blockingOverlay) this._resetBlockingOverlayBaseFrame();
    this._blockingOverlay = next;
    this.requestRender({ force: true });
  }

  setWrapUpOverlay({ title = "Wrapping up", subtitle = "", steps = [] } = {}) {
    const normalizedSteps = (Array.isArray(steps) ? steps : [])
      .map((step, idx) => ({
        id: step?.id ?? `step-${idx}`,
        label: String(step?.label || `Step ${idx + 1}`),
        status: step?.status || "pending",
        detail: step?.detail ? String(step.detail) : "",
      }));
    if (!this._blockingOverlay) this._resetBlockingOverlayBaseFrame();
    this._blockingOverlay = {
      kind: "wrapup",
      title: String(title || "Wrapping up"),
      subtitle: String(subtitle || ""),
      steps: normalizedSteps,
      startedAt: Date.now(),
    };
    this.requestRender({ force: true });
  }

  updateWrapUpOverlayStep(id, patch = {}) {
    if (!this._blockingOverlay || this._blockingOverlay.kind !== "wrapup") return;
    const targetId = String(id);
    const step = this._blockingOverlay.steps.find((item) => String(item.id) === targetId);
    if (!step) return;
    if (patch.status) step.status = patch.status;
    if (Object.hasOwn(patch, "detail")) step.detail = patch.detail ? String(patch.detail) : "";
    if (patch.label) step.label = String(patch.label);
    this.requestRender({ force: true });
  }

  clearWrapUpOverlay() {
    if (!this._blockingOverlay || this._blockingOverlay.kind !== "wrapup") return;
    this._blockingOverlay = null;
    this._resetBlockingOverlayBaseFrame();
    this.requestRender({ force: true });
  }
  _resetBlockingOverlayBaseFrame(...args) {
    return this._overlayRenderer._resetBlockingOverlayBaseFrame.call(this, ...args);
  }
  _baseFrameForBlockingOverlay(...args) {
    return this._overlayRenderer._baseFrameForBlockingOverlay.call(this, ...args);
  }
  _applyBlockingOverlay(...args) {
    return this._overlayRenderer._applyBlockingOverlay.call(this, ...args);
  }
  _wrapUpStepIcon(...args) {
    return this._overlayRenderer._wrapUpStepIcon.call(this, ...args);
  }
  _applyWrapUpOverlay(...args) {
    return this._overlayRenderer._applyWrapUpOverlay.call(this, ...args);
  }

  _normalizeAtlasEventText(text) {
    const clean = stripAnsi(String(text ?? "")).trim();
    if (!clean) return text;
    let normalized = clean;
    normalized = normalized.replace(/^\[system\]\s+((?:\[atlas(?:[^\]]*)?\]|ATLAS\b|SCIP\s*:).*)$/i, "$1");
    normalized = normalized.replace(/^\[atlas-warm(?:\s+([^\]]+))?\]\s*(.*)$/i, (_match, stage, body) => {
      const stageText = stage ? ` ${String(stage).trim()}` : "";
      const suffix = body ? ` ${String(body).trim()}` : "";
      return `[atlas] warm${stageText}:${suffix}`;
    });
    return normalized === clean ? text : normalized;
  }

  _appendEvent(text) {
    const time = new Date().toTimeString().slice(0, 8);
    const displayText = this._normalizeAtlasEventText(text);
    const lane = this._eventLane(displayText);
    if (lane === "system") {
      const plain = stripAnsi(String(displayText ?? "")).trim();
      const styled = `${C.dim}${_sanitizeDisplayLine(plain)}${C.reset}`;
      this._systemEvents.push({ time, text: styled });
      if (this._systemEvents.length > this._maxSystemEvents) {
        this._systemEvents.splice(0, this._systemEvents.length - this._maxSystemEvents);
      }
      return;
    }
    const styled = _sanitizeDisplayLine(_colorizeAssessorVerdictWords(displayText));
    this.events.push({ time, text: styled });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  // Route background plumbing — worktree/GC lifecycle, git status chatter, and
  // ATLAS reindex chatter — to the pinned "system" tail instead of the scrolling
  // job log. Anything carrying a failure/warning keyword is promoted back to the
  // main log so an error can never hide in a 2-line tail.
  _eventLane(text) {
    const clean = stripAnsi(String(text || "")).trim();
    const isSystem = /^\[(?:system|git|atlas(?:[^\]]*)?)\]/i.test(clean)
      || /^atlas\s+(?:indexing|boot check|background reindex)\b/i.test(clean)
      || /^scip\s*:/i.test(clean)
      || /^atlas\b.*\breindex\b/i.test(clean)
      || /^atlas background reindex\b/i.test(clean);
    if (!isSystem) return "log";
    const alertText = this._eventLaneAlertText(clean);
    if (/\b(?:fail(?:ed|ure)?|error|conflict|stale|blocked|lost|missing|denied|unauthorized|timeout|interrupted|abort(?:ed)?|cancell?ed|warn(?:ing)?)\b/i.test(alertText)) {
      return "log";
    }
    return "system";
  }

  _eventLaneAlertText(clean) {
    const text = String(clean || "");
    if (!/(?:^\[atlas(?:[^\]]*)?\]|\batlas\b|\bscip\b)/i.test(text)) return text;
    return text
      .replace(/\b0\s+(?:fail(?:ed|ure)?|errors?|conflicts?|blocked|lost|denied|unauthorized|timeouts?|interrupted|aborted|cancel(?:led|ed)?|warnings?)\b/gi, "")
      .replace(/\bstaging\s+\d+\s+missing\s+SCIP\s+index(?:es)?\b/gi, "")
      .replace(/\b\d+\s+missing\s+SCIP\s+index(?:es)?\b/gi, "");
  }

  _flushDroppedEvents() {
    const dropped = this._eventRate.dropped;
    if (!dropped) return;
    this._eventRate.dropped = 0;
    this._appendEvent(`${C.dim}... ${dropped} log events suppressed to keep input responsive${C.reset}`);
  }

  _workerActivityLabel(activity, { jobId = null, workItemId = null } = {}) {
    let text = stripAnsi(String(activity || "")).trim();
    if (!text) return "";
    if (workItemId != null && jobId != null) {
      text = text.replace(new RegExp(`^WI#${workItemId}\\s+job\\s+#${jobId}:\\s*`, "i"), "");
    }
    text = text.replace(/^WI#\d+\s+job\s+#\d+:\s*/i, "");
    if (jobId != null) {
      text = text.replace(new RegExp(`^(?:executing|running|starting)\\s+job\\s+#${jobId}:\\s*`, "i"), "");
    }
    text = text.replace(/^(?:executing|running|starting|producing)\s+job\s+#\d+:\s*/i, "");
    text = text.replace(/^(?:researching|planning|assessing|producing|executing|delegating):\s*/i, "");
    text = text.replace(/^(?:Research|Plan|Ask|Fix|Assess|Dev|Developer|Artificer):\s*/i, "");
    return text.trim();
  }

  _emitWorkerStart(jobId, worker) {
    if (!worker || worker.lifecycleStartEmitted) return;
    const scopedPrefix = worker.workItemId != null
      ? `${this._roleTagLong(worker.role)} WI#${worker.workItemId} job #${jobId}: `
      : `${this._roleTagLong(worker.role)} job #${jobId}: `;
    const activity = this._workerActivityLabel(worker.activity, {
      jobId,
      workItemId: worker.workItemId,
    });
    const activityTag = activity ? ` ${C.dim}- ${activity.slice(0, 90)}${C.reset}` : "";
    this.addEvent(`${scopedPrefix}${C.cyan}started${C.reset}${activityTag}`, { reason: "stream" });
    worker.lifecycleStartEmitted = true;
  }

  setWorker(jobId, {
    role,
    activity,
    tier = "standard",
    effort = "medium",
    attempt = 1,
    workItemId = null,
    provider = null,
    modelName = null,
    emitStart = true,
  }) {
    const existing = this.workers.get(jobId);
    const worker = {
      ...existing,
      role,
      activity,
      startTime: existing?.startTime || Date.now(),
      tier,
      effort,
      attempt,
      workItemId,
      provider,
      modelName,
      booting: existing?.booting ?? true,
      setupPhase: existing?.setupPhase || null,
      firstProviderActivityAt: existing?.firstProviderActivityAt || null,
      lastProviderActivityAt: existing?.lastProviderActivityAt || null,
      lifecycleStartEmitted: existing?.lifecycleStartEmitted || false,
    };
    this.workers.set(jobId, worker);
    if (emitStart) this._emitWorkerStart(jobId, worker);
  }

  updateWorkerActivity(jobId, activity) {
    const w = this.workers.get(jobId);
    if (w) {
      w.activity = activity;
      w.lastProviderActivityAt = Date.now();
    }
  }

  updateWorkerSetupPhase(jobId, phaseEvent = {}) {
    const w = this.workers.get(jobId);
    if (!w) return;
    if (phaseEvent?.state === "started") {
      w.setupPhase = {
        phase: phaseEvent.phase || null,
        label: phaseEvent.label || "setup",
        startedAt: Date.now(),
      };
    } else if (phaseEvent?.state === "finished" && w.setupPhase?.phase === phaseEvent.phase) {
      w.setupPhase = null;
    }
    this.requestRender({ reason: "event" });
  }

  updateWorkerTier(jobId, tier, attempt, provider = undefined, modelName = undefined) {
    const w = this.workers.get(jobId);
    if (w) {
      w.tier = tier;
      if (attempt != null) w.attempt = attempt;
      if (provider !== undefined) w.provider = provider;
      if (modelName !== undefined) w.modelName = modelName;
    }
  }

  removeWorker(jobId, status = "done") {
    const w = this.workers.get(jobId);
    if (w) {
      // Assessor verdict lines are already the completion message, so avoid
      // adding a second generic footer for that role.
      const quietRequeue = String(status || "").toLowerCase() === "queued";
      const suppressGenericCompletion = w.role === "assessor" || quietRequeue;

      this._flushWorkerSuppressed(jobId);
      if (!suppressGenericCompletion) {
        const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(1);
        const color = statusColor(status, C);
        const scopedPrefix = w.workItemId != null
          ? `${this._roleTagLong(w.role)} WI#${w.workItemId} job #${jobId}: `
          : `${this._roleTagLong(w.role)} `;
        this.addEvent(`${scopedPrefix}${color}${status}${C.reset} ${C.dim}(${elapsed}s)${C.reset}`, { reason: "stream" });
      }
      void this._refreshProviderUsageForDisplay();
    }
    this.workers.delete(jobId);
    if (String(status || "").toLowerCase() !== "queued") {
      this._lifecycleStartedJobs.delete(`job:${Number(jobId)}`);
    }
  }

  _flushWorkerSuppressed(jobId) {
    if (!this._workerSuppress) return;
    this._workerSuppress.delete(jobId);
  }

  _normalizeWorkerStartTitle(text, { jobId = null, workItemId = null } = {}) {
    return this._workerActivityLabel(text, { jobId, workItemId })
      .replace(/\s+(?:\([^)]{1,80}\)\s*)+$/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  _isRedundantStructuredStartEvent(jobId, clean) {
    const w = this.workers.get(jobId);
    if (!w) {
      return false;
    }
    const match = clean.match(/^\[([^\]]+)\]\s+(?:WI#(\d+)\s+)?job\s+#(\d+):\s*(.+)$/i);
    if (!match) return false;
    const [, rawRole, rawWiId, rawJobId, body] = match;
    if (Number(rawJobId) !== Number(jobId)) return false;
    if (w.workItemId != null && rawWiId != null && Number(rawWiId) !== Number(w.workItemId)) return false;

    const role = String(w.role || "").toLowerCase();
    const roleLabels = new Set([
      role,
      roleBrandLabel(role, role),
      ...(role === "dev" ? ["dev", "developer"] : []),
      ...(role === "researcher" ? ["research", "researcher"] : []),
    ].filter(Boolean));
    if (!roleLabels.has(String(rawRole || "").trim().toLowerCase())) return false;

    const bodyText = String(body || "").trim();
    if (!bodyText) return false;
    if (/^(started|succeeded|failed|done|completed|pass|fail|needs\s+review|blocked|selected|assessing|warning|error|retrying|continuing|loaded|first\s+attempt|attempt\s+\d+)/i.test(bodyText)) {
      return false;
    }

    const bodyTitle = this._normalizeWorkerStartTitle(bodyText, {
      jobId,
      workItemId: w.workItemId,
    });
    const activityTitle = this._normalizeWorkerStartTitle(w.activity, {
      jobId,
      workItemId: w.workItemId,
    });
    if (!bodyTitle || !activityTitle) return false;
    if (bodyTitle === activityTitle) return true;
    const minLength = Math.min(bodyTitle.length, activityTitle.length);
    return minLength >= 14 && (bodyTitle.includes(activityTitle) || activityTitle.includes(bodyTitle));
  }

  _isNoisyStructuredWorkerEvent(clean) {
    const text = String(clean || "").trim();
    if (/^\[system\].*\b(?:worktree setup deferred|dirty worktree cleanup deferred)\b.*\bsame-WI\b/i.test(text)) {
      return true;
    }
    if (/^\[system\].*\bretrying after active same-WI work releases\b/i.test(text)) {
      return true;
    }
    return false;
  }

  _markWorkerProviderActivity(jobId) {
    const w = this.workers.get(jobId);
    if (!w) return;
    const now = Date.now();
    w.lastProviderActivityAt = now;
    if (w.booting) {
      w.booting = false;
      w.firstProviderActivityAt = now;
    }
  }

  _describeWorkerBootState(w) {
    const elapsedMs = Math.max(0, Date.now() - (w?.startTime || Date.now()));
    const secs = Math.floor(elapsedMs / 1000);
    if (w?.setupPhase?.label) {
      const phaseElapsedMs = Math.max(0, Date.now() - (w.setupPhase.startedAt || Date.now()));
      const phaseSecs = Math.floor(phaseElapsedMs / 1000);
      return `${C.cyan}${w.setupPhase.label}${C.reset} ${C.dim}${phaseSecs}s${C.reset}`;
    }
    if (elapsedMs >= WORKER_BOOT_STALLED_MS) {
      return `${C.yellow}waiting for first output${C.reset} ${C.dim}${secs}s${C.reset}`;
    }
    if (elapsedMs >= WORKER_BOOT_SLOW_MS) {
      return `${C.cyan}starting provider${C.reset} ${C.dim}${secs}s${C.reset}`;
    }
    return `${C.dim}booting provider${C.reset} ${C.dim}${secs}s${C.reset}`;
  }

  workerLine(jobId, line) {
    const w = this.workers.get(jobId);
    const tag = w ? this._roleTagLong(w.role) : `${C.dim}[?]${C.reset}`;

    // Pass through system/structured messages unfiltered (no tag — they already have a prefix)
    const clean = stripAnsi(this._normalizeAtlasEventText(line)).trim();
    if (clean) this._markWorkerProviderActivity(jobId);
    const isStructured = clean.startsWith("[") && /^\[(git|planner|assessor|researcher|delegator|dev|developer|artificer|human|pre-assess|auto-approve|plan-validate|dry-run|idempotency|skip-assess|stale-lease|stderr|worker|escalation|merge|atlas(?:[^\]]*)?|system|mcp)\]/.test(clean);
    const isStructuredStderr = /^\[stderr\]/.test(clean);
    if (this._isNoisyStructuredWorkerEvent(clean)) {
      return;
    }
    if (_isLowSignalStructuredMarker(clean)) {
      return;
    }
    if (_isLowSignalWorkerCompletionMarker(clean, w?.role)) {
      return;
    }
    if (isStructured && !isStructuredStderr) {
      if (this._isRedundantStructuredStartEvent(jobId, clean)) {
        return;
      }
      const structuredLine = /^\[git\]/.test(clean)
        ? `${C.dim}${clean}${C.reset}`
        : line;
      this.addEvent(structuredLine, { reason: "stream" });
      return;
    }

    // Initialize per-worker suppression tracking
    if (!this._workerSuppress) this._workerSuppress = new Map();
    let ws = this._workerSuppress.get(jobId);
    if (!ws) { ws = { suppressed: 0, lastShown: 0, lastStderrLine: null }; this._workerSuppress.set(jobId, ws); }

    // Skip empty or whitespace-only lines
    if (!clean) { ws.suppressed++; return; }

    // Tool chatter can flood the log and make the right pane jump around
    // without adding much value compared to the final verdict/result lines.
    if (/^\[tool\]/i.test(clean)) {
      ws.suppressed++;
      return;
    }
    if (
      /tool call\(s\)/i.test(clean) ||
      /^\s*--\s*turn\s+\d+\/\d+:/i.test(clean) ||
      /^\s*\[fallback read\b/i.test(clean) ||
      /^\s*\[tool\]\s/i.test(clean) ||
      /^\s*\[done\]\s/i.test(clean) ||
      /^\s*\[cap\]\s/i.test(clean)
    ) {
      ws.suppressed++;
      return;
    }

    if (isStructuredStderr) {
      if (_isNoisyStructuredStderr(clean) || clean === ws.lastStderrLine) {
        ws.suppressed++;
        return;
      }
      ws.lastStderrLine = clean;
    } else {
      ws.lastStderrLine = null;
    }

    // Skip JSON blobs — but NOT inside dev log markers (that's real output)
    const isDevLog = clean.includes("DEV LOG START") || clean.includes("DEV LOG END")
      || clean.includes("ARTIFICER LOG START") || clean.includes("ARTIFICER LOG END")
      || clean.includes("MISSING_CONTEXT") || clean.includes("BLOCKED")
      || clean.includes("FILE_REQUEST");
    if (!isDevLog) {
      if ((clean.startsWith("{") || clean.startsWith("[")) && clean.length > 40) {
        ws.suppressed++;
        return;
      }
      if (/^\s*"[^"]+"\s*:/.test(clean)) {
        ws.suppressed++;
        return;
      }
      if (/^\s*[}\]],?\s*$/.test(clean)) {
        ws.suppressed++;
        return;
      }
    }

    // Skip raw code/indented dumps (4+ leading spaces and long)
    if (/^\s{4,}/.test(clean) && clean.length > 40) {
      ws.suppressed++;
      return;
    }

    // Skip very long lines (likely raw output dumps)
    if (clean.length > 500) {
      ws.suppressed++;
      return;
    }

    // Skip dev log markers and raw artifact dumps
    if (/^---\s*(DEV LOG|RESEARCH|PLAN|OUTPUT)/.test(clean)) {
      ws.suppressed++;
      return;
    }

    if (w && w.role === "dev" && /^executing job #\d+:/i.test(clean)) {
      ws.suppressed++;
      return;
    }

    // For dev and researcher roles, suppress raw LLM commentary —
    // the UI already emits structured start/done/summary events.
    if (w && (w.role === "dev" || w.role === "researcher")) {
      ws.suppressed++;
      return;
    }

    ws.suppressed = 0;

    // Strip leading role name to avoid double-naming (e.g., "[researcher] researcher found..." → "[researcher] found...")
    let displayClean = clean;
    if (w) {
      const roleNames = { researcher: "researcher", planner: "planner", dev: "developer", assessor: "assessor", delegator: "delegator" };
      const rn = roleNames[w.role];
      if (rn && displayClean.toLowerCase().startsWith(rn)) {
        displayClean = displayClean.slice(rn.length).replace(/^[\s:]+/, "");
      }
    }

    // Show the line (let the panel's fit() handle truncation to actual width)
    this.addEvent(`${tag} ${displayClean}`, { reason: "stream" });
  }

  _roleTag(role) {
    const c = roleBrandColor(role);
    return `${c}[${roleBrandIcon(role, role)}]${C.reset}`;
  }

  /** Full role name tag for the right-panel event log */
  _roleTagLong(role) {
    const c = roleBrandColor(role);
    return `${c}[${roleBrandLabel(role, role)}]${C.reset}`;
  }

  // ── Question API ──────────────────────────────────────────────────────

  askQuestions(jobId, questions, context, workItemId = null) {
    return new Promise((resolve, reject) => {
      if (this._aborted) {
        reject(new Error("Display aborted"));
        return;
      }

      const entry = {
        id: this._nextQId++,
        jobId,
        workItemId,
        questions,
        context,
        answers: [],
        currentIdx: 0,
        resolve,
        reject,
      };

      this._questionQueue.push(entry);
      const wiTag = workItemId ? `WI#${workItemId} ` : "";
      this.addEvent(`${C.yellow}\u26a0 ${wiTag}${questions.length} question(s) need your input (job #${jobId})${C.reset}`);

      if (!this._inputMode) {
        this._startAnswering();
      }
    });
  }

  cancelAllQuestions() {
    this._aborted = true;
    this._inputMode = false;
    this._activeQ = null;
    this._inputBuf = "";
    this._cancelApprovalMode();

    for (const q of this._questionQueue) {
      q.reject(new Error("Shutdown \u2014 questions canceled"));
    }
    this._questionQueue = [];
  }

  _cancelApprovalMode() {
    const done = this._approvalDone;
    this._resetApprovalState();
    if (!done) return false;
    try { done({ canceled: true }); } catch { /* resolver should not throw */ }
    return true;
  }

  _resetApprovalState({ mode = "normal" } = {}) {
    this._mode = mode;
    this._approvalData = null;
    this._approvalIdx = 0;
    this._approvalScroll = 0;
    this._approvalDone = null;
    this._approvalTab = 0;
    this._approvalTabScrolls = [0, 0, 0, 0];
    this._approvalPicker = null;
    this._approvalMemoryPicker = null;
    this._approvalActionBusy = false;
    this._approvalExitConfirm = false;
    this._approvalFlash = null;
  }

  get hasQuestions() {
    return this._questionQueue.length > 0;
  }

  // ── Approval Mode ─────────────────────────────────────────────────────

  /**
   * Enter approval mode with a full-screen report.
   * reportData: array of { wi, jobs, agentCalls, gitDiff, totalDuration, totalPrompt, totalOutput }
   * Returns a promise that resolves with { canceled } — canceled is true when
   * the session was torn down (shutdown or a newer approval session) rather
   * than reviewed to completion.
   */
  _normalizeApprovalViewState() {
    const data = Array.isArray(this._approvalData) ? this._approvalData : [];
    const tabCount = 4;
    const toNonNegativeInt = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };

    if (!Array.isArray(this._approvalTabScrolls)) {
      this._approvalTabScrolls = [0, 0, 0, 0];
    } else {
      this._approvalTabScrolls = Array.from(
        { length: tabCount },
        (_, i) => toNonNegativeInt(this._approvalTabScrolls[i]),
      );
    }
    const tab = Number(this._approvalTab);
    this._approvalTab = Number.isFinite(tab)
      ? Math.min(Math.max(Math.trunc(tab), 0), tabCount - 1)
      : 0;

    if (data.length === 0) {
      this._approvalIdx = 0;
      this._approvalScroll = 0;
      this._approvalTabScrolls[this._approvalTab] = 0;
      return null;
    }

    const rawIdx = Number(this._approvalIdx);
    const currentIdx = Number.isFinite(rawIdx) ? Math.trunc(rawIdx) : 0;
    const nextIdx = Math.min(Math.max(currentIdx, 0), data.length - 1);
    if (nextIdx !== currentIdx) {
      this._approvalScroll = 0;
      this._approvalTabScrolls = [0, 0, 0, 0];
    } else {
      this._approvalScroll = toNonNegativeInt(this._approvalScroll);
    }
    this._approvalIdx = nextIdx;
    this._approvalTabScrolls[this._approvalTab] = this._approvalScroll;
    return data[this._approvalIdx];
  }

  enterApprovalMode(reportData, initialIdx = 0) {
    return new Promise((resolve) => {
      // Re-entry guard: settle any still-pending approval promise (resolving
      // it { canceled: true }) so overwriting _approvalDone can never strand
      // an earlier session's awaiter.
      this._cancelApprovalMode();
      const data = Array.isArray(reportData) ? reportData : [];
      if (data.length === 0) {
        this._resetApprovalState();
        resolve({ canceled: false });
        this.requestRender({ force: true });
        return;
      }
      this._mode = "approval";
      this._approvalData = data;
      this._approvalIdx = initialIdx >= 0 && initialIdx < data.length ? initialIdx : 0;
      this._approvalScroll = 0;
      this._approvalTab = 0;
      this._approvalTabScrolls = [0, 0, 0, 0];
      this._approvalPicker = null;
      this._approvalMemoryPicker = null;
      this._approvalActionBusy = false;
      this._approvalExitConfirm = false;
      this._approvalFlash = null;
      this._approvalDone = resolve;
      this.requestRender({ force: true });
    });
  }

  // ── Input Handling ──────────────────────────────────────────────────────

  /** Auto-start question mode if questions arrived while in another input mode */
  _drainQuestions(...args) {
    return this._inputController._drainQuestions.call(this, ...args);
  }

  _startAnswering(...args) {
    return this._inputController._startAnswering.call(this, ...args);
  }

  _startAnsweringAt(...args) {
    return this._inputController._startAnsweringAt.call(this, ...args);
  }

  _startInject(...args) {
    return this._inputController._startInject.call(this, ...args);
  }

  /**
   * Accept a queue snapshot pushed from the scheduler. This is the
   * authoritative source for {workItems, jobs} when populated, so renders
   * never have to re-query the DB. Generation-stamped so older snapshots
   * arriving out of order are ignored.
   */
  acceptQueueSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    const generation = Number(snapshot.generation ?? 0);
    if (
      this._queueDataCache.generation != null
      && generation > 0
      && generation < this._queueDataCache.generation
    ) {
      // Stale snapshot - keep the newer one we already have.
      return false;
    }

    const signature = queueSnapshotSignature(snapshot);
    const sameGeneration =
      this._queueDataCache.generation != null
      && generation === this._queueDataCache.generation;
    const sameVisibleRows = signature === this._queueSnapshotSignature;
    if (sameGeneration && sameVisibleRows) {
      this._queueDataCache.at = Date.now();
      return false;
    }

    this._queueSnapshotSignature = signature;
    this._queueDataCache = {
      at: Date.now(),
      generation,
      workItems: Array.isArray(snapshot.workItems) ? snapshot.workItems : [],
      jobs: Array.isArray(snapshot.jobs) ? snapshot.jobs : [],
      dirtyState: null,
      source: "snapshot",
    };
    // A new snapshot frequently means new events worth showing — nudge
    // the renderer so the user sees the change without waiting for the
    // next tick.
    this.requestRender?.({ reason: "queue-snapshot" });
    return true;
  }

  _getQueueData({ maxAgeMs = 1000 } = {}) {
    const now = Date.now();
    // Prefer the scheduler-pushed snapshot when it's available — renders
    // become a pure read with zero DB churn. Fall back to a direct query
    // only when no snapshot has arrived yet (e.g. unit tests that
    // construct a Display outside a Scheduler).
    if (this._queueDataCache.source === "snapshot" && this._queueDataCache.workItems != null) {
      this._queueDataCache.dirtyState = this._getQueueDirtyState(now);
      return this._queueDataCache;
    }
    if (now - this._queueDataCache.at <= maxAgeMs && this._queueDataCache.workItems != null) {
      return this._queueDataCache;
    }
    const workItems = listWorkItems();
    const jobs = listJobs();
    const dirtyState = this._getQueueDirtyState(now);
    this._queueDataCache = { at: now, workItems, jobs, dirtyState, source: "query" };
    return this._queueDataCache;
  }

  _getQueueDirtyState(now = Date.now()) {
    if (typeof this.getDirtyState !== "function") return null;
    if (now - this._dirtyStateCache.at <= 5000) return this._dirtyStateCache.state;
    try {
      const state = this.getDirtyState();
      if (state && typeof state.then === "function") return this._dirtyStateCache.state;
      this._dirtyStateCache = { at: now, state: state || null };
    } catch {
      this._dirtyStateCache = { at: now, state: null };
    }
    return this._dirtyStateCache.state;
  }

  acceptDirtyStateSnapshot(state = null) {
    this._dirtyStateCache = { at: Date.now(), state: state || null };
    this.requestRender?.({ reason: "queue-snapshot" });
  }

  requestRender({ advanceAnimation = false, force = false, reason = "general" } = {}) {
    if (!this._started && !this._renderOnce) return;
    if (advanceAnimation) this._pendingAdvanceAnimation = true;
    if (this._stdoutBackedUp) return;

    const now = Date.now();
    const minGap = computeRenderMinGap({
      force,
      reason,
      pendingInput: !!this._inputMode || this._questionQueue.length > 0,
    });
    const delay = Math.max(0, minGap - (now - this._lastRenderAt));
    const targetAt = now + delay;

    if (this._renderScheduled) {
      const shouldPreempt =
        targetAt + 5 < this._scheduledRenderAt
        || (force && this._scheduledRenderReason !== "force");
      if (!shouldPreempt) return;
      if (this._renderTimer) clearTimeout(this._renderTimer);
    } else {
      this._renderScheduled = true;
    }

    this._scheduledRenderAt = targetAt;
    this._scheduledRenderReason = force ? "force" : reason;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._renderScheduled = false;
      this._scheduledRenderAt = 0;
      this._scheduledRenderReason = "general";
      if (this._stdoutBackedUp) return;
      const shouldAdvance = !!this._pendingAdvanceAnimation;
      this._pendingAdvanceAnimation = false;
      try {
        this.render({ advanceAnimation: shouldAdvance });
      } catch (err) {
        this._recordRenderError(err);
      }
    }, delay);
  }

  _recordRenderError(err) {
    const now = Date.now();
    if (now - this._lastRenderErrorAt < 5000) return;
    this._lastRenderErrorAt = now;
    const message = String(err?.message || err || "unknown render error").slice(0, 160);
    this._appendEvent(`${C.red}render error:${C.reset} ${message}`);
  }

  _getNudgeWorkers(...args) {
    return this._inputController._getNudgeWorkers.call(this, ...args);
  }

  _submitAnswer(...args) {
    return this._inputController._submitAnswer.call(this, ...args);
  }

  _skipQuestion(...args) {
    return this._inputController._skipQuestion.call(this, ...args);
  }

  _removeQuestionSet(...args) {
    return this._inputController._removeQuestionSet.call(this, ...args);
  }

  _submitInject(...args) {
    return this._inputController._submitInject.call(this, ...args);
  }

  _startAsk(...args) {
    return this._inputController._startAsk.call(this, ...args);
  }

  _submitAsk(...args) {
    return this._inputController._submitAsk.call(this, ...args);
  }

  _startImage(...args) {
    return this._inputController._startImage.call(this, ...args);
  }

  _submitImage(...args) {
    return this._inputController._submitImage.call(this, ...args);
  }

  _cancelBufferedInput(...args) {
    return this._inputController._cancelBufferedInput.call(this, ...args);
  }

  _handleBufferedInputKeypress(...args) {
    return this._inputController._handleBufferedInputKeypress.call(this, ...args);
  }

  _submitNudge(...args) {
    return this._inputController._submitNudge.call(this, ...args);
  }

  _onKeypress(...args) {
    return this._inputController._onKeypress.call(this, ...args);
  }

  // ── Approval Mode Keypress ────────────────────────────────────────────

  _onApprovalKeypress(...args) {
    return this._inputController._onApprovalKeypress.call(this, ...args);
  }

  _onApprovalPickerKeypress(...args) {
    return this._inputController._onApprovalPickerKeypress.call(this, ...args);
  }

  _startDiscardPicker(...args) {
    return this._inputController._startDiscardPicker.call(this, ...args);
  }

  _advanceApproval(...args) {
    return this._inputController._advanceApproval.call(this, ...args);
  }
  render(...args) {
    return this._frameRenderer.render.call(this, ...args);
  }
  _buildContextStatusBar(...args) {
    return this._statusRenderer._buildContextStatusBar.call(this, ...args);
  }
  _buildProgressBar(...args) {
    return this._statusRenderer._buildProgressBar.call(this, ...args);
  }
  _buildBottomInput(...args) {
    return this._bottomInputRenderer._buildBottomInput.call(this, ...args);
  }
  _buildHints(...args) {
    return this._bottomInputRenderer._buildHints.call(this, ...args);
  }
  _buildRunClockLine(...args) {
    return this._statusRenderer._buildRunClockLine.call(this, ...args);
  }
  _blockedLockSummaryLabels(...args) {
    return this._leftPanelRenderer._blockedLockSummaryLabels.call(this, ...args);
  }
  _buildLeft(...args) {
    return this._leftPanelRenderer._buildLeft.call(this, ...args);
  }
  _buildAtlasReadinessLines(...args) {
    return this._leftPanelRenderer._buildAtlasReadinessLines.call(this, ...args);
  }
  _buildQueue(...args) {
    return this._leftPanelRenderer._buildQueue.call(this, ...args);
  }

  /** Get active (non-terminal, non-canceled) work items for the Kill WI menu */
  _getActiveWorkItems() {
    try {
      const TERMINAL = new Set(TERMINAL_WORK_ITEM_STATUSES);
      // Read from the pushed snapshot to avoid an extra DB query each
      // time the kill menu reopens. _getQueueData() falls back to a
      // direct query only when no snapshot has arrived.
      const { workItems } = this._getQueueData();
      return (workItems || []).filter(wi => !TERMINAL.has(wi.status));
    } catch { return []; }
  }

  /** Get skippable jobs: queued, blocked, or waiting — not running/terminal */
  _getSkippableJobs() {
    try {
      const SKIPPABLE = new Set(STALE_CANCELABLE_JOB_STATUSES);
      const { jobs } = this._getQueueData();
      return (jobs || []).filter(j => SKIPPABLE.has(j.status));
    } catch { return []; }
  }
  _jobIcon(...args) {
    return this._leftPanelRenderer._jobIcon.call(this, ...args);
  }
  _jobRunningTag(...args) {
    return this._leftPanelRenderer._jobRunningTag.call(this, ...args);
  }
  _jobStatusTag(...args) {
    return this._leftPanelRenderer._jobStatusTag.call(this, ...args);
  }
  _atlasWarmStatusTag(...args) {
    return this._leftPanelRenderer._atlasWarmStatusTag.call(this, ...args);
  }
  _withPosseMascot(...args) {
    return this._rightPanelRenderer._withPosseMascot.call(this, ...args);
  }
  _dirtyReviewIssuesByWi(...args) {
    return this._leftPanelRenderer._dirtyReviewIssuesByWi.call(this, ...args);
  }
  _buildRight(...args) {
    return this._rightPanelRenderer._buildRight.call(this, ...args);
  }
  _classifyEvent(...args) {
    return this._rightPanelRenderer._classifyEvent.call(this, ...args);
  }
  _buildPipeline(...args) {
    return this._rightPanelRenderer._buildPipeline.call(this, ...args);
  }
  _buildTools(...args) {
    return this._rightPanelRenderer._buildTools.call(this, ...args);
  }
  _buildActiveLockLines(...args) {
    return this._rightPanelRenderer._buildActiveLockLines.call(this, ...args);
  }
  _activeLockWiState(...args) {
    return this._rightPanelRenderer._activeLockWiState.call(this, ...args);
  }
  _lockTableCell(...args) {
    return this._rightPanelRenderer._lockTableCell.call(this, ...args);
  }
  _compareMaybeNumber(...args) {
    return this._rightPanelRenderer._compareMaybeNumber.call(this, ...args);
  }
  _compareLockText(...args) {
    return this._rightPanelRenderer._compareLockText.call(this, ...args);
  }
  _isDisplayActiveJobLock(...args) {
    return this._rightPanelRenderer._isDisplayActiveJobLock.call(this, ...args);
  }
  _isDisplayActiveWorkItemLock(...args) {
    return this._rightPanelRenderer._isDisplayActiveWorkItemLock.call(this, ...args);
  }

  // ── Approval Report Rendering ─────────────────────────────────────────

  _renderApproval(...args) {
    return this._approvalRenderer._renderApproval.call(this, ...args);
  }

  // ── Helper: word-wrap text lines to fit within width ──

  _wrapText(...args) {
    return this._approvalRenderer._wrapText.call(this, ...args);
  }

  // ── Tab 1: Task Completion + Files Touched ──────────────────────────

  _buildTabTasks(...args) {
    return this._approvalRenderer._buildTabTasks.call(this, ...args);
  }

  // ── Tab 2: Token Usage Report ───────────────────────────────────────

  _buildTabTokens(...args) {
    return this._approvalRenderer._buildTabTokens.call(this, ...args);
  }

  // ── Tab 3: Research Summary ─────────────────────────────────────────

  _buildTabResearch(...args) {
    return this._approvalRenderer._buildTabResearch.call(this, ...args);
  }

  // ── Tab 4: Details ──────────────────────────────────────────────────

  _buildTabDetails(...args) {
    return this._approvalRenderer._buildTabDetails.call(this, ...args);
  }

  // ── Discard-files picker overlay ────────────────────────────────────

  _renderDiscardPickerOverlay(...args) {
    return this._approvalRenderer._renderDiscardPickerOverlay.call(this, ...args);
  }
}
