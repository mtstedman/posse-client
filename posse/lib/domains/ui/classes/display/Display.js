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
import { C } from "../../../providers/functions/claude.js";
import {
  statusColor,
  statusIcon as paletteStatusIcon,
} from "../../functions/display/status-palette.js";
import { tierModelName } from "../../../providers/functions/provider.js";
import {
  FAILED_JOB_STATUSES,
  STALE_CANCELABLE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
} from "../../../queue/functions/common.js";
import {
  listWorkItems,
  listJobs,
} from "../../../queue/functions/index.js";
import {
  displayColumnWidth,
  stripAnsi,
  fit,
  formatConsoleArg,
  _fmtTokens,
  _fmtUsd,
  _wrapQuestionBodyLines,
  _sanitizeDisplayLine,
  _colorizeAssessorVerdictWords,
  _isNoisyStructuredStderr,
  _isLowSignalWorkerCompletionMarker,
  _isLowSignalStructuredMarker,
} from "../../functions/display/helpers/formatters.js";
import { formatDuration } from "../../../../shared/format/functions/units.js";
import { roleBrandColor, roleBrandIcon, roleBrandLabel, readinessGauge, brandRule } from "../../functions/display/helpers/brand.js";
import { getWarmReadiness } from "../../../atlas/functions/v2/warm-progress.js";
import { getCatalogRuntimeFallbackInt } from "../../../settings/functions/catalog.js";
import {
  getDisplayEventRateLimitPerSec,
  getDisplayMaxEvents,
} from "../../../settings/functions/tunables.js";
import {
  JOB_TYPE_ABBR,
  JOB_TYPE_COLORS_KEY,
  jobLabel,
  jobReportStatus,
  jobDisplayStatus,
  jobIsDisplayFailure,
  jobIsDisplaySuccess,
  jobIsBackgroundAtlasWarm,
  workItemDisplayStatus,
  computeJobProgressStats,
} from "../../functions/display/helpers/job-status.js";
import {
  PROVIDER_USAGE_REFRESH_MS,
  getProviderUsageSummaryCache,
  _refreshProviderUsageSummaryCacheIfChanged,
  _taskProviderBudgetLines,
  _buildQueueProviderUsageLines,
} from "../../functions/display/helpers/provider-usage.js";
import { renderPosseMascotFrame } from "../../functions/display/helpers/mascot.js";
import { estimateCallCost } from "../../../billing/functions/pricing.js";
import { describeAtlasWarmJob } from "../../../atlas/functions/v2/process-indicators.js";
import { getOnnxWarmState, syntheticOnnxLoadPercent } from "../../../atlas/functions/v2/embeddings/onnx-warm-state.js";
import { canonicalAtlasActionName } from "../../../../functions/tools/mcp-surface.js";

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

const JOB_FAILURE_STATUSES = new Set(FAILED_JOB_STATUSES);
const ATLAS_WARM_FAMILY_ORDER = ["reindex", "scip", "warm", "replay", "cleanup"];
const ATLAS_WARM_FAMILY_LABELS = {
  reindex: "Code map",
  scip: "SCIP restage",
  warm: "Context prep",
  replay: "Merge replay",
  cleanup: "Cleanup",
};
const CONTEXT_HEALTH_LABEL = "Context health";
const POSSE_HEADER_WIDTH = 45;
const POSSE_HEADER_MASCOT_GAP = 2;

function atlasWarmFamily(info) {
  const purpose = String(info?.purpose || "");
  if (purpose === "main-incremental" || purpose === "main-full") return "reindex";
  if (purpose === "scip-restage") return "scip";
  if (purpose === "main-merge") return "replay";
  if (purpose === "wi-cleanup") return "cleanup";
  return "warm";
}

function atlasWarmQueueGroups(jobs = []) {
  const groups = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const info = describeAtlasWarmJob(job);
    const family = atlasWarmFamily(info);
    const eventCount = Math.max(1, Number(info.eventCount || 1));
    if (!groups.has(family)) {
      groups.set(family, {
        family,
        label: ATLAS_WARM_FAMILY_LABELS[family] || "Context prep",
        jobs: [],
        active: 0,
        activeEvents: 0,
        queued: 0,
        queuedEvents: 0,
      });
    }
    const group = groups.get(family);
    group.jobs.push(job);
    if (job?.status === "running" || job?.status === "leased") {
      group.active++;
      group.activeEvents += eventCount;
    }
    if (job?.status === "queued" || job?.status === "blocked") {
      group.queued++;
      group.queuedEvents += eventCount;
    }
  }
  return [...groups.values()].sort((a, b) =>
    ATLAS_WARM_FAMILY_ORDER.indexOf(a.family) - ATLAS_WARM_FAMILY_ORDER.indexOf(b.family));
}

function atlasWarmQueuedEventCount(group) {
  const coalescedBehindRunning = Math.max(0, Number(group.activeEvents || 0) - Number(group.active || 0));
  return Number(group.queuedEvents || 0) + coalescedBehindRunning;
}

function atlasWarmQueueActivityParts(group, { activeWord = "active" } = {}) {
  const parts = [];
  if (group.active > 0) {
    parts.push(`${C.bold}${group.active}${C.reset}${C.dim} ${activeWord}${C.reset}`);
  }
  const queuedEvents = atlasWarmQueuedEventCount(group);
  if (queuedEvents > 0) {
    parts.push(`${C.bold}${queuedEvents}${C.reset}${C.dim} queued${C.reset}`);
  }
  return parts;
}

function atlasWarmQueueSummaryParts(group, { activeWord = "active", labelColor = C.cyan } = {}) {
  return [
    `${labelColor}${group.label}${C.reset}`,
    ...atlasWarmQueueActivityParts(group, { activeWord }),
  ];
}

function formatAtlasWarmQueueSummary(group, opts = {}) {
  return atlasWarmQueueSummaryParts(group, opts).join(`${C.dim} · ${C.reset}`);
}

function formatAtlasWarmQueueRow(group, { activeWord = "active", labelColor = C.cyan } = {}) {
  const label = String(group.label || "Context prep").padEnd(12);
  const parts = atlasWarmQueueActivityParts(group, { activeWord });
  const status = parts.length > 0 ? parts.join(`${C.dim}  ${C.reset}`) : `${C.dim}idle${C.reset}`;
  return `${labelColor}${label}${C.reset} ${status}`;
}

function queueRowsRequiredForPendingCap(items = [], pendingCap = 0) {
  let rows = 0;
  for (const item of items) {
    if (item.allDone) {
      rows += 1;
      continue;
    }
    rows += 1; // WI header
    rows += item.activeJobs.length;
    const pendingShown = Math.min(item.pendingJobs.length, pendingCap);
    rows += pendingShown;
    if (item.pendingJobs.length > pendingShown) rows += 1;
    if (item.doneCount > 0) rows += 1;
  }
  return rows;
}

function queuePendingCapForVisibleItems(items = [], rowBudget = 0) {
  const maxPending = Math.max(0, ...items.map((item) => item.pendingJobs.length));
  let cap = 0;
  for (let candidate = 0; candidate <= maxPending; candidate++) {
    if (queueRowsRequiredForPendingCap(items, candidate) > rowBudget) break;
    cap = candidate;
  }
  return cap;
}

function queueJobDisplayState(job, { active = false } = {}) {
  const status = String(job?.status || "").toLowerCase();
  if (active || status === "running" || status === "leased") return "running";
  if (status === "awaiting_assessment") return "assessing";
  if (status === "waiting_on_human" || (job?.job_type === "human_input" && status !== "succeeded")) return "input";
  if (status === "waiting_on_review") return "review";
  if (status === "blocked") return "blocked";
  if (status === "queued") return "queued";
  return status || "pending";
}

const QUEUE_JOB_STATE_LABELS = {
  running: { label: "running", color: C.cyan },
  assessing: { label: "assessing", color: C.cyan },
  queued: { label: "queued", color: C.blue },
  blocked: { label: "blocked", color: C.yellow },
  input: { label: "needs input", color: C.yellow },
  review: { label: "needs review", color: C.magenta },
  pending: { label: "pending", color: C.dim },
};

const QUEUE_JOB_STATE_ORDER = ["running", "assessing", "queued", "blocked", "input", "review", "pending"];

function formatQueueJobStateSummary(jobs = [], jobStates = null) {
  const counts = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const state = jobStates?.get(Number(job?.id)) || queueJobDisplayState(job);
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  const orderedStates = [
    ...QUEUE_JOB_STATE_ORDER,
    ...[...counts.keys()].filter((state) => !QUEUE_JOB_STATE_ORDER.includes(state)).sort(),
  ];
  return orderedStates
    .filter((state) => counts.has(state))
    .map((state) => {
      const meta = QUEUE_JOB_STATE_LABELS[state] || QUEUE_JOB_STATE_LABELS.pending;
      const count = counts.get(state);
      return `${meta.color}${count} ${meta.label}${C.reset}`;
    })
    .join(`${C.dim}, ${C.reset}`);
}

function formatQueueWiHeader(prefix, title, inner) {
  const text = _sanitizeDisplayLine(title || "");
  if (!text) return prefix;
  const titleBudget = Math.max(0, inner - stripAnsi(prefix).length - 1);
  if (titleBudget <= 0) return prefix;
  return `${prefix} ${text.slice(0, titleBudget)}`;
}

function formatQueueJobTitle(title, maxWidth, siblingTitles = []) {
  const text = _sanitizeDisplayLine(title || "");
  const width = Math.max(0, Number(maxWidth || 0));
  if (width <= 0) return "";
  if (text.length <= width) return text;

  const clippedHead = text.slice(0, width);
  const matchingSiblings = siblingTitles
    .map((other) => _sanitizeDisplayLine(other || ""))
    .filter((otherText) => (
      otherText !== text
      && otherText.length > width
      && otherText.slice(0, width) === clippedHead
    ));
  const hasSameVisiblePrefix = matchingSiblings.length > 0;
  if (!hasSameVisiblePrefix || width < 14) return clippedHead;

  const marker = "…";
  const commonPrefixLength = (left, right) => {
    const limit = Math.min(left.length, right.length);
    let i = 0;
    while (i < limit && left[i] === right[i]) i++;
    return i;
  };
  const commonSuffixLength = (left, right, prefixLimit) => {
    const max = Math.min(left.length, right.length) - prefixLimit;
    let i = 0;
    while (i < max && left[left.length - 1 - i] === right[right.length - 1 - i]) i++;
    return i;
  };
  const stripLeadingFiller = (value) => String(value || "")
    .replace(/^[\s:;,.()[\]{}"'`<>/\\|+\-=]+/, "")
    .replace(/^(?:and|or|in|for|to|with|from|of|the|a|an)\s+/i, "");

  let bestSnippet = "";
  for (const otherText of matchingSiblings) {
    const prefixLen = commonPrefixLength(text, otherText);
    const suffixLen = commonSuffixLength(text, otherText, prefixLen);
    const differingEnd = Math.max(prefixLen, text.length - suffixLen);
    const snippet = stripLeadingFiller(text.slice(prefixLen, differingEnd));
    if (snippet.length > bestSnippet.length) bestSnippet = snippet;
  }
  if (bestSnippet) {
    const headWidth = Math.max(6, Math.min(Math.floor(width * 0.48), width - marker.length - 4));
    const snippetWidth = Math.max(4, width - marker.length - headWidth);
    return `${text.slice(0, headWidth)}${marker}${bestSnippet.slice(0, snippetWidth)}`;
  }

  const hasSharedPrefix = siblingTitles.some((other) => {
    const otherText = _sanitizeDisplayLine(other || "");
    return otherText !== text && otherText.length > width && otherText.slice(0, width) === clippedHead;
  });
  if (!hasSharedPrefix) return clippedHead;

  const headWidth = Math.max(6, Math.floor((width - marker.length) * 0.55));
  const tailWidth = Math.max(4, width - marker.length - headWidth);
  return `${text.slice(0, headWidth)}${marker}${text.slice(-tailWidth)}`;
}

const TOOL_SUMMARY_LABEL_ALIASES = new Map([
  ["chainverdict", ["chainreview"]],
  ["editfile", ["edit"]],
  ["hashfile", ["hash"]],
  ["inspectfile", ["inspect"]],
  ["listfiles", ["list"]],
  ["pruneartifactoutput", ["pruneartifact"]],
  ["readfile", ["read"]],
  ["searchfiles", ["search"]],
  ["validateartifactoutput", ["validateartifact"]],
  ["webfetch", ["fetch", "webfetch"]],
  ["websearch", ["search", "websearch"]],
  ["writefile", ["write"]],
]);

function normalizeToolSummaryLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripAtlasSummaryActionPrefix(summary) {
  const text = String(summary || "").trimStart();
  const match = text.match(/^((?:(?:atlas)\s+|(?:atlas)[._-]){0,4}[A-Za-z][A-Za-z0-9_.-]*)(.*)$/i);
  if (!match) return text;
  const action = canonicalAtlasActionName(match[1]);
  return action ? `${action}${match[2] || ""}` : text;
}

function stripRedundantToolSummaryLabel(tool, summary) {
  const text = String(summary || "").trimStart();
  if (!text) return "";
  const normalizedTool = normalizeToolSummaryLabel(tool);
  const isAtlasTool = normalizedTool === "atlas" || normalizedTool.startsWith("atlas");
  const aliases = new Set([
    normalizedTool,
    ...(isAtlasTool ? ["atlas"] : []),
    ...(TOOL_SUMMARY_LABEL_ALIASES.get(normalizedTool) || []),
  ].map(normalizeToolSummaryLabel).filter(Boolean));

  const colonLabel = text.match(/^([A-Za-z][A-Za-z0-9_. -]{0,40}):\s*/);
  if (colonLabel && aliases.has(normalizeToolSummaryLabel(colonLabel[1]))) {
    const stripped = text.slice(colonLabel[0].length);
    return isAtlasTool ? stripAtlasSummaryActionPrefix(stripped) : stripped;
  }

  const leadingToken = text.match(/^([A-Za-z][A-Za-z0-9_.-]{0,20})\s+/);
  if (
    leadingToken
    && normalizeToolSummaryLabel(leadingToken[1]) === "atlas"
    && aliases.has("atlas")
  ) {
    return stripAtlasSummaryActionPrefix(text.slice(leadingToken[0].length));
  }

  return isAtlasTool ? stripAtlasSummaryActionPrefix(text) : text;
}

function atlasWarmStatusWords(info) {
  switch (atlasWarmFamily(info)) {
    case "reindex":
      return {
        active: "reindexing",
        queued: "reindex queued",
        failed: "reindex failed",
        succeeded: "reindexed",
      };
    case "replay":
      return {
        active: "replaying",
        queued: "replay queued",
        failed: "replay failed",
        succeeded: "replayed",
      };
    case "cleanup":
      return {
        active: "cleaning",
        queued: "cleanup queued",
        failed: "cleanup failed",
        succeeded: "cleaned",
      };
    default:
      return {
        active: "warming",
        queued: "warm queued",
        failed: "warm failed",
        succeeded: "warmed",
      };
  }
}

function resolvedCallCostUsd(call) {
  const est = estimateCallCost({
    provider: call?.provider,
    modelName: call?.model_name,
    modelTier: call?.model_tier,
    inputTokens: call?.input_tokens,
    outputTokens: call?.output_tokens,
    cachedInputTokens: call?.cached_input_tokens,
    knownCostUsd: call?.cost_estimate_usd,
  });
  return Number.isFinite(est.costUsd) ? est.costUsd : 0;
}

function formatOverlayElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

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

function questionContextSourceLines(context) {
  if (!context) return [];
  const raw = Array.isArray(context) ? context.join("\n") : String(context);
  return raw
    .split(/\r?\n/)
    .map((line) => _sanitizeDisplayLine(line).trimEnd())
    .map((line) => line.replace(/^\s{2,}/, "  "))
    .filter((line) => line.trim().length > 0);
}

function questionContextPriority(line) {
  const clean = String(line || "").trim().toLowerCase();
  if (/^(task|block reason|summary|notes):/.test(clean)) return 0;
  if (/^(files_touched|file_requests|criteria_check|status):/.test(clean)) return 1;
  if (/^-\s+/.test(clean)) return 2;
  return 3;
}

function wrapQuestionContextLine(line, width, firstLine = false) {
  const out = [];
  const safeWidth = Math.max(16, width);
  const firstPrefix = firstLine ? " Context: " : "          ";
  const nextPrefix = "          ";
  let text = String(line || "");
  if (text.length === 0) return [firstPrefix.trimEnd()];
  let prefix = firstPrefix;
  while (text.length > 0) {
    const available = Math.max(10, safeWidth - prefix.length);
    out.push(`${C.dim}${prefix}${text.slice(0, available)}${C.reset}`);
    text = text.slice(available);
    prefix = nextPrefix;
  }
  return out;
}

function buildQuestionContextDisplayLines(context, width, maxLines = 6) {
  const source = questionContextSourceLines(context);
  if (source.length === 0 || maxLines <= 0) return [];

  const sorted = source
    .map((line, idx) => ({ line, idx, priority: questionContextPriority(line) }))
    .sort((a, b) => (a.priority - b.priority) || (a.idx - b.idx));
  const selected = sorted
    .slice(0, Math.max(1, maxLines))
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.line);

  const lines = [];
  for (let idx = 0; idx < selected.length; idx++) {
    const line = selected[idx];
    const wrapped = wrapQuestionContextLine(line, width, lines.length === 0);
    const remainingSelected = selected.length - idx - 1;
    const remainingSlots = maxLines - lines.length;
    const slotsForLine = Math.max(1, remainingSlots - remainingSelected);
    lines.push(...wrapped.slice(0, slotsForLine));
    if (lines.length >= maxLines) break;
  }
  if (source.length > selected.length && lines.length < maxLines) {
    lines.push(`${C.dim}          ... ${source.length - selected.length} more context line(s)${C.reset}`);
  }
  return lines;
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

  _resetBlockingOverlayBaseFrame() {
    this._blockingOverlayBaseFrame = "";
    this._blockingOverlayBaseKey = "";
    this._lastFrameBase = "";
  }

  _baseFrameForBlockingOverlay(buf) {
    if (!this._blockingOverlay) {
      this._resetBlockingOverlayBaseFrame();
      return buf;
    }
    const key = `${this._mode}:${this.cols}x${this.rows}`;
    if (!this._blockingOverlayBaseFrame || this._blockingOverlayBaseKey !== key) {
      this._blockingOverlayBaseFrame = buf;
      this._blockingOverlayBaseKey = key;
    }
    return this._blockingOverlayBaseFrame;
  }

  _applyBlockingOverlay(buf) {
    if (!this._blockingOverlay) return buf;
    if (this._blockingOverlay.kind === "wrapup") {
      return this._applyWrapUpOverlay(buf);
    }
    const title = this._blockingOverlay.title;
    const subtitle = this._blockingOverlay.subtitle || "";
    const visibleTitle = stripAnsi(title);
    const visibleSubtitle = stripAnsi(subtitle);
    const innerW = Math.min(
      Math.max(visibleTitle.length, visibleSubtitle.length, 18) + 8,
      Math.max(18, this.cols - 8),
    );
    const boxW = innerW + 2;
    const col = Math.max(1, Math.floor((this.cols - boxW) / 2) + 1);
    const row = Math.max(2, Math.floor((this.rows - 7) / 2) + 1);
    const titleLine = fit(`${C.yellow}${C.bold}! ${title}${C.reset}`, innerW);
    const subtitleLine = subtitle ? fit(`${C.dim}${subtitle}${C.reset}`, innerW) : " ".repeat(innerW);
    const pad = " ".repeat(innerW);
    return buf
      + `\x1b[${row};${col}H${C.yellow}${C.bold}\u250c${"\u2500".repeat(innerW)}\u2510${C.reset}`
      + `\x1b[${row + 1};${col}H${C.yellow}${C.bold}\u2502${C.reset}${pad}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 2};${col}H${C.yellow}${C.bold}\u2502${C.reset}${titleLine}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 3};${col}H${C.yellow}${C.bold}\u2502${C.reset}${subtitleLine}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 4};${col}H${C.yellow}${C.bold}\u2502${C.reset}${pad}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 5};${col}H${C.yellow}${C.bold}\u2514${"\u2500".repeat(innerW)}\u2518${C.reset}`;
  }

  _wrapUpStepIcon(status, tick = 0) {
    const clean = String(status || "pending");
    if (clean === "done") return `${C.green}\u2713${C.reset}`;
    if (clean === "failed") return `${C.red}\u2717${C.reset}`;
    if (clean === "skipped") return `${C.dim}-${C.reset}`;
    if (clean === "running") {
      const frames = ["|", "/", "-", "\\"];
      return `${C.cyan}${frames[Math.abs(Number(tick) || 0) % frames.length]}${C.reset}`;
    }
    return `${C.dim}\u00b7${C.reset}`;
  }

  _applyWrapUpOverlay(buf) {
    const overlay = this._blockingOverlay || {};
    const title = overlay.title || "Wrapping up";
    const subtitle = overlay.subtitle || "Finishing closeout work. Please wait.";
    const steps = Array.isArray(overlay.steps) ? overlay.steps : [];
    const nowMs = Date.now();
    const startedAt = Number(overlay.startedAt || nowMs);
    const elapsedMs = Math.max(0, nowMs - startedAt);
    const elapsed = formatOverlayElapsed(elapsedMs);
    const progressTick = Math.floor(elapsedMs / 250);
    const runningStep = steps.find((step) => step.status === "running");
    const maxStepLines = Math.max(1, Math.min(steps.length, this.rows - 10));
    const visibleSteps = steps.slice(0, maxStepLines);
    const hiddenCount = Math.max(0, steps.length - visibleSteps.length);
    const stepLines = visibleSteps.map((step) => {
      const detail = step.detail ? `${C.dim} - ${step.detail}${C.reset}` : "";
      return ` ${this._wrapUpStepIcon(step.status, progressTick)} ${step.label}${detail}`;
    });
    if (hiddenCount > 0) {
      stepLines.push(` ${C.dim}\u00b7 ${hiddenCount} more step${hiddenCount === 1 ? "" : "s"}${C.reset}`);
    }

    const content = [
      "",
      `${C.yellow}${C.bold}! ${title}${C.reset}`,
      subtitle ? `${C.dim}${subtitle}${C.reset}` : "",
      `${C.cyan}heartbeat${C.reset} ${elapsed}${runningStep ? `${C.dim} - ${runningStep.label}${C.reset}` : ""}`,
      `${C.dim}Progress only - no choice needed here; Ctrl+C interrupts.${C.reset}`,
      "",
      ...stepLines,
      "",
    ];
    // Box width is derived from the STATIC content only (title, subtitle, the
    // fixed instruction, and step labels) — NOT the live heartbeat elapsed or the
    // streaming step details, which change width every tick. Letting those resize
    // and recenter the box on the frozen base frame each tick was the flicker.
    // The dynamic lines fit() to innerW below (truncating any overflow).
    const widthBasis = [
      `${C.yellow}${C.bold}! ${title}${C.reset}`,
      subtitle ? `${C.dim}${subtitle}${C.reset}` : "",
      `${C.dim}Progress only - no choice needed here; Ctrl+C interrupts.${C.reset}`,
      ...visibleSteps.map((step) => ` ${this._wrapUpStepIcon(step.status, 0)} ${step.label}`),
    ];
    const rawWidth = Math.max(34, ...widthBasis.map((line) => displayColumnWidth(line)));
    const innerW = Math.min(rawWidth + 4, Math.max(18, this.cols - 8));
    const boxW = innerW + 2;
    const boxH = content.length + 2;
    const col = Math.max(1, Math.floor((this.cols - boxW) / 2) + 1);
    const row = Math.max(2, Math.floor((this.rows - boxH) / 2) + 1);
    const pad = " ".repeat(innerW);
    let out = buf + `\x1b[${row};${col}H${C.yellow}${C.bold}\u250c${"\u2500".repeat(innerW)}\u2510${C.reset}`;
    for (let i = 0; i < content.length; i++) {
      out += `\x1b[${row + i + 1};${col}H${C.yellow}${C.bold}\u2502${C.reset}${fit(content[i], innerW)}${C.yellow}${C.bold}\u2502${C.reset}`;
    }
    out += `\x1b[${row + boxH - 1};${col}H${C.yellow}${C.bold}\u2514${"\u2500".repeat(innerW)}\u2518${C.reset}`;
    return out;
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
    if (/\b(?:fail(?:ed|ure)?|error|conflict|stale|blocked|lost|missing|denied|unauthorized|timeout|interrupted|abort(?:ed)?|cancell?ed|warn(?:ing)?)\b/i.test(clean)) {
      return "log";
    }
    return "system";
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

  // ── Render ──────────────────────────────────────────────────────────────

  render({ advanceAnimation = false } = {}) {
    if (!this._started && !this._renderOnce) return;
    if (this._stdoutBackedUp) return;
    this._renderOnce = false;
    this._lastRenderAt = Date.now();
    this._refreshViewport();

    if (advanceAnimation && !this._blockingOverlay) {
      this._spinIdx++;
    }

    if (this._mode === "approval") {
      this._renderApproval();
      return;
    }

    // ── Panel sizing ──
    // fullW = usable width inside the outer border (cols - 2 border chars)
    const fullW = Math.max(0, this.cols - 2);
    const maxLeftW = Math.max(0, this.cols - 3);
    const leftW = Math.max(0, Math.min(Math.max(Math.floor(this.cols * 0.31), 28), 44, fullW, maxLeftW));
    const rightW = Math.max(0, this.cols - leftW - 3); // 3 = │ + │ + │

    // Build fixed sections
    const progressLines = this._buildProgressBar(fullW);
    // Context-health is now shown by the dedicated ATLAS/ONNX readiness bars in
    // the left panel, so the old bottom status bar is retired (no placeholder row).
    const contextBarLines = [];
    const inputLines = this._buildBottomInput(fullW);

    // Layout rows:  top border(1) + progress + divider(1) + middle + divider(1)
    //               + context bar + input + bottom border(1)
    const overhead = 2 + progressLines.length + 1 + 1 + contextBarLines.length + inputLines.length;
    const middleRows = Math.max(this.rows - overhead, 5);

    let left = this._buildLeft(leftW, middleRows);
    let right = this._buildRight(rightW, middleRows);

    if (left.length > middleRows) left.length = middleRows;
    if (right.length > middleRows) right.length = middleRows;
    while (left.length < middleRows) left.push("");
    while (right.length < middleRows) right.push("");

    // ── Compose frame with absolute cursor positioning ──
    let buf = "";
    let row = 1;

    // Top border
    buf += `\x1b[${row};1H${C.dim}\u250c${"\u2500".repeat(fullW)}\u2510${C.reset}\x1b[K`;
    row++;

    // Progress bar section (full width)
    for (const line of progressLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Divider: progress → split panels
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(leftW)}\u252c${"\u2500".repeat(rightW)}\u2524${C.reset}\x1b[K`;
    row++;

    // Middle: split panels
    for (let i = 0; i < middleRows; i++) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(left[i], leftW)}${C.dim}\u2502${C.reset}${fit(right[i], rightW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Divider: split panels → bottom input
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(leftW)}\u2534${"\u2500".repeat(rightW)}\u2524${C.reset}\x1b[K`;
    row++;

    // Context status bar (thin, full width) \u2014 a vim/tmux-style status line
    // between the split panels and the input. Part of the cacheable base frame
    // since it tracks context-health state, not keystrokes.
    for (const line of contextBarLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Bottom input section \u2014 built separately so the overlay base-frame
    // cache never freezes keystroke feedback. Keys still get processed while
    // the overlay is up; this lets the user actually SEE the result.
    let inputBuf = "";
    for (const line of inputLines) {
      inputBuf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Bottom border + clear-below (part of the cacheable base frame)
    buf += `\x1b[${row};1H${C.dim}\u2514${"\u2500".repeat(fullW)}\u2518${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H\x1b[J`;

    const baseFrame = this._baseFrameForBlockingOverlay(buf);
    // Build the overlay portion separately so we can write only its delta
    // when just the wrap-up heartbeat ticks. Repainting the whole base frame
    // every second was the visible flicker source.
    const overlayPart = this._blockingOverlay ? this._applyBlockingOverlay("") : "";
    const full = baseFrame + inputBuf + overlayPart;

    if (full === this._lastFrame) return;

    const overlayActive = !!this._blockingOverlay;
    const haveLast = this._lastFrame !== "";
    const baseSame = overlayActive && haveLast && this._lastFrameBase === baseFrame;
    const inputSame = baseSame && this._lastFrameInput === inputBuf;
    let payload;
    if (inputSame) {
      payload = overlayPart;
    } else if (baseSame) {
      payload = inputBuf + overlayPart;
    } else {
      payload = full;
    }
    // Wrap the frame write in DEC 2026 synchronized-output markers (BSU/ESU) so
    // terminals that support it (Windows Terminal, modern xterm/kitty) buffer the
    // whole repaint and present it atomically instead of tearing mid-frame. When
    // busy we rewrite the entire frame on every change — token counters and the
    // provider gauges (the [S]/[W] rows) tick constantly — and an un-synchronized
    // full repaint at render cadence is what makes those rows flicker. Terminals
    // that don't implement 2026 ignore the unknown private mode harmlessly.
    const ok = process.stdout.write(`\x1b[?2026h${payload}\x1b[?2026l`);
    if (!ok) {
      this._stdoutBackedUp = true;
      process.stdout.once("drain", () => {
        this._stdoutBackedUp = false;
        this._lastFrame = "";
        this._lastFrameBase = "";
        this._lastFrameInput = "";
        this.requestRender({ force: true });
      });
    } else {
      this._lastFrame = full;
      this._lastFrameBase = baseFrame;
      this._lastFrameInput = inputBuf;
    }
  }

  // ── Context status bar (thin, full width, above the input) ────────────
  // One always-present line that answers "is code-intelligence healthy right
  // now?": a verdict word + glyph, then the live graph-warm families and the
  // ONNX encoder phase. Derives only from cheap job-row state + the in-memory
  // ONNX warm singleton — no per-frame DB reads. Returns [] (hidden) only when
  // there is genuinely nothing to report (ATLAS idle and encoder never warmed).
  _buildContextStatusBar(width) {
    let groups = [];
    try {
      const { jobs } = this._getQueueData();
      const terminal = new Set(TERMINAL_JOB_STATUSES);
      const warmJobs = (jobs || []).filter(
        (job) => jobIsBackgroundAtlasWarm(job) && !terminal.has(job.status),
      );
      groups = atlasWarmQueueGroups(warmJobs).filter(
        (g) => g.active > 0 || atlasWarmQueuedEventCount(g) > 0,
      );
    } catch {
      groups = [];
    }
    const onnx = getOnnxWarmState();

    const anyRunning = groups.some((g) => g.active > 0);
    const anyQueued = groups.some((g) => atlasWarmQueuedEventCount(g) > 0);

    // Nothing to say: ATLAS idle and the encoder never started.
    if (!anyRunning && !anyQueued && onnx.phase === "idle") return [];

    const halo = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spin = halo[this._spinIdx % halo.length];

    let glyph;
    let glyphColor;
    let word;
    if (onnx.phase === "failed") {
      glyph = "✗"; glyphColor = C.red; word = "attention";
    } else if (anyRunning || onnx.phase === "loading") {
      glyph = spin; glyphColor = C.cyan; word = "warming";
    } else if (anyQueued) {
      glyph = "·"; glyphColor = C.yellow; word = "queued";
    } else {
      glyph = "✓"; glyphColor = C.green; word = "ready";
    }

    const clauses = [];
    for (const g of groups) {
      const bits = [];
      if (g.active > 0) bits.push(`${g.active}↻`);
      const queued = atlasWarmQueuedEventCount(g);
      if (queued > 0) bits.push(`${queued}⏳`);
      clauses.push(`${C.dim}${g.label}${C.reset} ${bits.join(" ")}`);
    }
    if (onnx.phase === "loading") {
      clauses.push(`${C.cyan}encoder ${syntheticOnnxLoadPercent()}%${C.reset}`);
    } else if (onnx.phase === "ready") {
      clauses.push(`${C.dim}encoder ready${C.reset}`);
    } else if (onnx.phase === "failed") {
      const reason = String(onnx.error || "warm failed").split("\n")[0];
      clauses.push(`${C.red}encoder warm failed${C.reset} ${C.dim}— search is lexical-only (${reason})${C.reset}`);
    }

    const head = `${glyphColor}${glyph} context ${word}${C.reset}`;
    const sep = `${C.dim} · ${C.reset}`;
    // The render loop fit()s every full-width line, trimming the tail (and thus
    // the lower-priority trailing clauses) first while the leading verdict head
    // survives — so we return the line raw and let fit() handle the width.
    const line = clauses.length > 0 ? ` ${head}${sep}${clauses.join(sep)}` : ` ${head}`;
    return [line];
  }

  // ── Progress Bar (full width, top) ────────────────────────────────────

  _buildProgressBar(width) {
    const lines = [];
    try {
      // Only count jobs from visible work items (not complete/canceled)
      const { workItems, jobs } = this._getQueueData();
      const normalJobs = jobs.filter((job) => !jobIsBackgroundAtlasWarm(job));
      const visibleWiIds = new Set();
      for (const wi of workItems) {
        const wiJobs = normalJobs.filter(j => j.work_item_id === wi.id);
        const displayStatus = workItemDisplayStatus(wi, wiJobs);
        if (displayStatus === "canceled") continue;
        if (displayStatus === "complete") continue;
        visibleWiIds.add(wi.id);
      }

      const terminal = new Set(TERMINAL_JOB_STATUSES);
      const allJobs = normalJobs.filter(j => visibleWiIds.has(j.work_item_id));
      const total = allJobs.length;
      if (total === 0) {
        const warmJobs = jobs.filter((job) => jobIsBackgroundAtlasWarm(job) && !terminal.has(job.status));
        if (warmJobs.length > 0) {
          const groups = atlasWarmQueueGroups(warmJobs);
          const summary = groups.map((group) =>
            formatAtlasWarmQueueSummary(group, { activeWord: "running", labelColor: C.cyan }))
            .join(`${C.dim} | ${C.reset}`);
          lines.push(` ${C.cyan}${CONTEXT_HEALTH_LABEL}${C.reset}${C.dim} · ${C.reset}${summary}`);
          return lines;
        }
        if (!Array.isArray(normalJobs) || normalJobs.length === 0) {
          lines.push(` ${C.dim}No jobs yet${C.reset}`);
          return lines;
        }
        const resolved = normalJobs.filter((j) => terminal.has(j.status)).length;
        const completeWIs = workItems.filter((wi) => {
          const wiJobs = normalJobs.filter((j) => j.work_item_id === wi.id);
          return workItemDisplayStatus(wi, wiJobs) === "complete";
        });
        const pendingMerges = completeWIs.filter((wi) => wi.branch_name && wi.merge_state !== "merged").length;
        const merged = completeWIs.filter((wi) => wi.merge_state === "merged").length;
        const phase = this._runPhaseMessage || (pendingMerges > 0
          ? `${pendingMerges} pending merge${pendingMerges === 1 ? "" : "s"}`
          : "wrap-up");
        const parts = [
          `${C.green}All jobs complete${C.reset}`,
          `${C.bold}${resolved}${C.reset}${C.dim}/${normalJobs.length} done${C.reset}`,
        ];
        if (merged > 0) parts.push(`${C.bold}${merged}${C.reset}${C.dim} merged${C.reset}`);
        parts.push(`${C.dim}${phase}${C.reset}`);
        lines.push(` ${parts.join(`${C.dim} · ${C.reset}`)}`);
        return lines;
      }

      const {
        failed,
        running,
        queued,
        assessing,
        resolved,
        fraction,
      } = computeJobProgressStats(allJobs);

      // Build stats string — show resolved/total so bar matches
      const parts = [`${resolved}/${total}`];
      if (running > 0) parts.push(`${C.cyan}${running} running${C.reset}`);
      if (assessing > 0) parts.push(`${C.cyan}${assessing} assessing${C.reset}`);
      if (queued > 0) parts.push(`${C.blue}${queued} queued${C.reset}`);
      if (failed > 0) parts.push(`${C.red}${failed} failed${C.reset}`);
      const statsStr = parts.join("  ");
      const statsVisible = stripAnsi(statsStr);

      // Progress bar fills remaining width — fraction tracks resolved (terminal) jobs
      const barW = Math.max(width - statsVisible.length - 4, 15);
      const fullBlocks = Math.floor(fraction * barW);
      const partials = [" ", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589", "\u2588"];
      const remainder = (fraction * barW) - fullBlocks;
      const partialChar = fullBlocks < barW ? partials[Math.round(remainder * 8)] : "";
      const emptyBlocks = Math.max(barW - fullBlocks - (partialChar && partialChar !== " " ? 1 : 0), 0);
      const bar = `${C.green}${"\u2588".repeat(fullBlocks)}${partialChar}${C.reset}${C.dim}${"\u2591".repeat(emptyBlocks)}${C.reset}`;

      lines.push(` ${bar} ${statsStr}`);
    } catch {
      lines.push(` ${C.dim}Loading...${C.reset}`);
    }
    return lines;
  }

  // ── Bottom Input (full width) ─────────────────────────────────────────

  _buildBottomInput(width) {
    const lines = [];

    // ── Ask mode ──
    if (this._inputMode === "ask") {
      lines.push("");
      lines.push(` ${C.magenta}${C.bold}? Ask a Question${C.reset}  ${C.dim}Research-only (no dev tasks):${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.magenta}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] ask  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Inject mode ──
    if (this._inputMode === "inject") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}+ Inject Work Item${C.reset}  ${C.dim}Describe what you want built:${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.cyan}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] add  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Image mode ──
    if (this._inputMode === "image") {
      lines.push("");
      lines.push(` ${C.magenta}${C.bold}\u{1f5bc} Generate Image${C.reset}  ${C.dim}Describe the image to generate:${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.magenta}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] generate  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Kill mode ──
    if (this._inputMode === "kill") {
      lines.push("");
      lines.push(` ${C.red}${C.bold}\u26a1 Kill/Bump Worker${C.reset}  ${C.dim}Select worker to kill (moves to next attempt):${C.reset}`);
      let idx = 1;
      const killJobIds = this._visibleKillJobIds();
      for (const jobId of killJobIds) {
        const w = this.workers.get(jobId);
        if (!w) continue;
        const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
        const wiRef = w.workItemId ? `${C.blue}WI#${w.workItemId}${C.reset}` : `${C.dim}#${jobId}${C.reset}`;
        lines.push(` ${C.red}${C.bold}${idx}${C.reset} ${this._roleTag(w.role)} ${wiRef} ${w.activity || w.role} ${C.dim}${elapsed}s${C.reset}`);
        idx++;
      }
      lines.push("");
      lines.push(` ${C.dim}[1-${killJobIds.length}] kill  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Kill WI mode ──
    if (this._inputMode === "killwi") {
      lines.push("");
      lines.push(` ${C.red}${C.bold}\u2717 Cancel Work Item${C.reset}  ${C.dim}Cancel all jobs and clean up branch:${C.reset}`);
      if (this._killWIList && this._killWIList.length > 0) {
        let idx = 1;
        for (const wi of this._killWIList) {
          const statusTag = `${C.dim}(${wi.status})${C.reset}`;
          lines.push(` ${C.red}${C.bold}${idx}${C.reset} ${C.blue}WI#${wi.id}${C.reset} ${_sanitizeDisplayLine(wi.title).slice(0, width - 25)} ${statusTag}`);
          idx++;
          if (idx > 9) break;
        }
        lines.push("");
        lines.push(` ${C.dim}[1-${Math.min(this._killWIList.length, 9)}] cancel WI  [Esc] back${C.reset}`);
      } else {
        lines.push(` ${C.dim}No active work items${C.reset}`);
        lines.push("");
        lines.push(` ${C.dim}[Esc] back${C.reset}`);
      }
      return lines;
    }

    // ── Skip job mode ──
    if (this._inputMode === "skip") {
      lines.push("");
      lines.push(` ${C.yellow}${C.bold}\u23ed Skip Task${C.reset}  ${C.dim}Mark as succeeded (unblocks downstream):${C.reset}`);
      if (this._skipJobList && this._skipJobList.length > 0) {
        let idx = 1;
        for (const j of this._skipJobList) {
          const statusTag = `${C.dim}(${j.status})${C.reset}`;
          const wiRef = `${C.blue}WI#${j.work_item_id}${C.reset}`;
          lines.push(` ${C.yellow}${C.bold}${idx}${C.reset} ${wiRef} ${C.dim}#${j.id}${C.reset} ${jobLabel(j.job_type, j.title).slice(0, width - 30)} ${statusTag}`);
          idx++;
          if (idx > 9) break;
        }
        lines.push("");
        lines.push(` ${C.dim}[1-${Math.min(this._skipJobList.length, 9)}] skip  [Esc] back${C.reset}`);
      } else {
        lines.push(` ${C.dim}No skippable tasks${C.reset}`);
        lines.push("");
        lines.push(` ${C.dim}[Esc] back${C.reset}`);
      }
      return lines;
    }

    // ── Nudge select mode ──
    if (this._inputMode === "nudge_select") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}\u270e Nudge${C.reset}  ${C.dim}Select running job to redirect:${C.reset}`);
      let idx = 1;
      const nudgeJobIds = this._visibleNudgeJobIds();
      for (const jobId of nudgeJobIds) {
        const w = this.workers.get(jobId);
        if (!w) continue;
        const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
        const wiRef = w.workItemId ? `${C.blue}WI#${w.workItemId}${C.reset}` : `${C.dim}#${jobId}${C.reset}`;
        lines.push(` ${C.cyan}${C.bold}${idx}${C.reset} ${this._roleTag(w.role)} ${wiRef} ${w.activity || w.role} ${C.dim}${elapsed}s${C.reset}`);
        idx++;
      }
      lines.push("");
      lines.push(` ${C.dim}[1-${nudgeJobIds.length}] select  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Nudge text mode ──
    if (this._inputMode === "nudge_text") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}\u270e Nudge job #${this._nudgeJobId}${C.reset}  ${C.dim}What should it do instead?${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.cyan}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] kill & redirect  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Question answering mode ──
    if (this._inputMode === "question" && this._activeQ) {
      const q = this._activeQ;
      const qNum = q.currentIdx + 1;
      const qTotal = q.questions.length;
      // q.questions[i] and q.context originate from worker role output
      // (parsed LLM output). Sanitize through the same filter the event log
      // uses so a crafted response cannot inject ANSI cursor-hide / alt-screen
      // sequences into the TUI.
      const qText = _sanitizeDisplayLine(q.questions[q.currentIdx] || "");
      const bodyLines = [];
      const qLineW = width - 5;
      const maxQuestionBodyLines = Math.max(6, Math.min(14, this.rows - 10));

      lines.push("");
      const maxContextLines = Math.max(0, Math.min(6, maxQuestionBodyLines - 4));
      const contextLines = buildQuestionContextDisplayLines(q.context, qLineW, maxContextLines);
      bodyLines.push(...contextLines);

      const qHeader = ` ${C.yellow}${C.bold}\u26a0 Q${qNum}/${qTotal}${C.reset} ${C.dim}(job #${q.jobId})${C.reset}`;
      bodyLines.push(qHeader);
      const wrappedQuestionLines = _wrapQuestionBodyLines(qText, qLineW);
      bodyLines.push(...wrappedQuestionLines);

      if (bodyLines.length > maxQuestionBodyLines) {
        const reservedPrefix = contextLines.length + 1;
        const availableQuestionSlots = Math.max(3, maxQuestionBodyLines - reservedPrefix);
        const headCount = Math.max(1, Math.ceil(availableQuestionSlots / 2));
        const tailCount = Math.max(1, availableQuestionSlots - headCount - 1);
        const preservedPrefix = bodyLines.slice(0, reservedPrefix);
        const questionHead = wrappedQuestionLines.slice(0, headCount);
        const questionTail = tailCount > 0 ? wrappedQuestionLines.slice(-tailCount) : [];
        bodyLines.length = 0;
        bodyLines.push(...preservedPrefix);
        bodyLines.push(...questionHead);
        bodyLines.push(` ${C.dim}... question clipped; showing beginning and end${C.reset}`);
        bodyLines.push(...questionTail);
      }
      lines.push(...bodyLines);

      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.green}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] submit  [Esc] skip${C.reset}`);
      return lines;
    }

    // ── Questions waiting (not in input mode) ──
    if (this._questionQueue.length > 0) {
      const totalQs = this._questionQueue.reduce((s, q) => s + (q.questions.length - q.currentIdx), 0);
      const qPreview = [];
      for (const qSet of this._questionQueue) {
        for (let i = qSet.currentIdx; i < qSet.questions.length && qPreview.length < 3; i++) {
          qPreview.push(_sanitizeDisplayLine(qSet.questions[i]).slice(0, 50));
        }
      }
      lines.push("");
      lines.push(` ${C.yellow}${C.bold}\u26a0 ${totalQs} question(s) waiting${C.reset}  ${C.dim}${qPreview.join("  |  ")}${C.reset}`);
      lines.push(` ${C.yellow}[Q] answer  [1-${Math.min(totalQs, 4)}] pick${C.reset}  ${this._buildHints()}`);
      return lines;
    }

    // ── Default: hints ──
    lines.push(` ${this._buildHints()}`);
    return lines;
  }

  _buildHints() {
    // Hints split into two zones separated by a dim divider:
    //   left  = input / inspection  (cyan + magenta keys)
    //   right = control / destruction (yellow + red keys, then quit)
    // Each hint colors the key letter in its action's semantic color and
    // leaves the label dim so the key reads at a glance.
    const hint = (key, label, keyColor) => `${keyColor}[${key}]${C.reset}${C.dim} ${label}${C.reset}`;
    const input = [];
    const inspect = [];
    const control = [];

    if (this.onInject) input.push(hint("i", "inject", C.cyan));
    if (this.onAsk) input.push(hint("?", "ask", C.cyan));
    if (this.onImage) input.push(hint("g", "image", C.magenta));

    if (this.getPipelineData) inspect.push(hint("p", this._rightMode === "pipeline" ? "log" : "pipeline", C.blue));
    if (this.onReviewPending) inspect.push(hint("r", "review", C.magenta));
    if (this.getToolData) inspect.push(hint("t", this._rightMode === "tools" ? "log" : "tools", C.blue));

    if (this.onNudge && this.workers.size > 0) control.push(hint("n", "nudge", C.yellow));
    if (this.onSkipJob) control.push(hint("s", "skip task", C.yellow));
    if (this.onKill && this.workers.size > 0) control.push(hint("k", "kill", C.red));
    if (this.onKillWI) control.push(hint("x", "cancel WI", C.red));
    control.push(hint("Ctrl+C", "quit", C.red));

    const left = [...input, ...inspect].join("  ");
    const right = control.join("  ");
    const divider = (left && right) ? `  ${C.dim}│${C.reset}  ` : "";
    return `${left}${divider}${right}`;
  }

  // ── Run clock: `⏱  14:32  ·  elapsed 3m 12s  ·  4 WI  ·  12 done` ───────
  _buildRunClockLine(width) {
    const startedIso = this._runStartedAtIso;
    if (!startedIso) return null;
    const startedAt = Date.parse(startedIso);
    if (!Number.isFinite(startedAt)) return null;

    const startHHMM = new Date(startedAt).toTimeString().slice(0, 5);
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const elapsed = formatDuration(elapsedMs);

    let wiTotal = 0;
    let jobsDone = 0;
    try {
      const { workItems, jobs } = this._getQueueData();
      wiTotal = Array.isArray(workItems) ? workItems.length : 0;
      const TERMINAL = new Set(["succeeded", "recovered"]);
      jobsDone = Array.isArray(jobs)
        ? jobs.filter((j) => TERMINAL.has(jobReportStatus(j, jobs))).length
        : 0;
    } catch { /* best effort */ }

    const sep = `${C.dim} · ${C.reset}`;
    const parts = [
      `${C.dim}⏱${C.reset}  ${C.bold}${startHHMM}${C.reset}`,
      `${C.dim}elapsed${C.reset} ${C.bold}${elapsed}${C.reset}`,
      `${C.bold}${wiTotal}${C.reset}${C.dim} WI${C.reset}`,
      `${C.bold}${jobsDone}${C.reset}${C.dim} done${C.reset}`,
    ];
    return fit(` ${parts.join(sep)}`, Math.max(1, width - 1));
  }

  // ── Left Panel: Workers + Queue ───────────────────────────────────────

  _blockedLockSummaryLabels(limitCount = null) {
    const details = Array.isArray(this._blockedByLockDetails) ? this._blockedByLockDetails.filter(Boolean) : [];
    const counts = { worktreeCap: 0, serialization: 0, fileLock: 0 };
    for (const detail of details) {
      if (detail.holder_type === "worktree_cap") counts.worktreeCap++;
      else if (detail.holder_type === "worktree_serialization") counts.serialization++;
      else counts.fileLock++;
    }
    if (details.length === 0 && Number(this._blockedByLock || 0) > 0) {
      counts.fileLock = Number(this._blockedByLock || 0);
    }
    const labels = [];
    if (counts.worktreeCap > 0) labels.push(`${counts.worktreeCap} queued for worktree slot${counts.worktreeCap === 1 ? "" : "s"}`);
    if (counts.fileLock > 0) labels.push(`${counts.fileLock} waiting on file lock${counts.fileLock === 1 ? "" : "s"}`);
    if (counts.serialization > 0) labels.push(`${counts.serialization} waiting on serialization`);
    if (limitCount != null && details.length > 0 && limitCount > details.length) {
      labels.push(`${limitCount - details.length} more waiting`);
    }
    if (limitCount != null && labels.length === 0 && limitCount > 0) {
      labels.push(`${limitCount} waiting on file lock${limitCount === 1 ? "" : "s"}`);
    }
    return labels;
  }

  _buildLeft(width, maxLines) {

    // ── Workers ──
    const workers = [];
    const halo = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
    const spin = halo[this._spinIdx % halo.length];
    const countTag = `${C.dim}${this.workers.size}/${this.concurrency}${C.reset}`;
    const rule = "\u2501".repeat(Math.max(width - 14, 5));
    workers.push(` ${C.bold}Workers${C.reset} ${C.dim}${rule}${C.reset} ${countTag}`);

    for (const [jobId, w] of this.workers) {
      const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
      const isWaiting = this._questionQueue.some(q => q.jobId === jobId);
      const c = roleBrandColor(w.role);

      // `\u258e` accent bar in role color makes each active worker scannable
      // even when the spinner ticks change. Waiting workers go yellow.
      const accent = isWaiting ? `${C.yellow}\u258e${C.reset}` : `${c}\u258e${C.reset}`;
      const wiRefColor = w.role === "researcher" ? c : C.blue;
      const wiPlain = (w.workItemId ? `WI#${w.workItemId}` : `#${jobId}`).padEnd(7);
      const wiCol = w.workItemId
        ? `${wiRefColor}${wiPlain}${C.reset}`
        : `${C.dim}${wiPlain}${C.reset}`;
      if (isWaiting) {
        workers.push(`${accent} ${C.yellow}${spin}${C.reset} ${this._roleTag(w.role)} ${wiCol} ${C.yellow}\u26a0 waiting${C.reset}`);
      } else {
        const tierColors = { cheap: C.dim, standard: C.cyan, strong: C.magenta };
        const effortAbbr = { low: "low", medium: "med", high: "high" };
        const modelLabel = w.modelName || tierModelName(w.tier, { providerName: w.provider, role: w.role });
        // Truncate model name to a stable 14-char column so trailing fields stay aligned
        const modelShort = modelLabel.length > 14 ? `${modelLabel.slice(0, 13)}\u2026` : modelLabel;
        const modelPadded = modelShort.padEnd(14);
        const tierTag = `${tierColors[w.tier] || C.dim}${modelPadded}${C.reset}`;
        const effortTag = `${C.dim}${(effortAbbr[w.effort] || w.effort || "").padEnd(4)}${C.reset}`;
        const attemptTag = w.attempt > 1 ? ` ${C.yellow}a${w.attempt}${C.reset}` : "";
        const stateTag = w.booting
          ? this._describeWorkerBootState(w)
          : `${C.dim}${String(elapsed).padStart(4)}s${C.reset}`;
        workers.push(`${accent} ${c}${spin}${C.reset} ${this._roleTag(w.role)} ${wiCol} ${tierTag} ${effortTag}${attemptTag} ${stateTag}`);
      }
    }

    // Idle slots — distinguish between truly idle and blocked-by-file-lock
    const openSlots = this.concurrency - this.workers.size;
    const blockedByLock = Math.min(this._blockedByLock || 0, openSlots);
    const trulyIdle = openSlots - blockedByLock;
    if (blockedByLock > 0) {
      const labels = this._blockedLockSummaryLabels(blockedByLock);
      workers.push(`  ${C.yellow}\u00b7 ${labels.join(", ")}${C.reset}`);
    }
    if (trulyIdle > 0) {
      workers.push(`  ${C.dim}\u00b7 ${trulyIdle} idle${C.reset}`);
    }

    // ── ONNX encoder warm state ──
    // The encoder warm no longer rides as a stray chip in the workers list —
    // it's reported by the ATLAS/ONNX readiness bars below (see
    // _buildAtlasReadinessLines), alongside the graph-warm verdict, so the whole
    // code-intelligence picture reads in one place.

    // ── Queue (fills remaining space) ──
    const footerLineBudget = Math.min(Math.max(0, maxLines - workers.length - 3), 9);
    const activeProviders = new Set(
      [...this.workers.values()]
        .map((worker) => String(worker?.provider || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const providerUsageCache = getProviderUsageSummaryCache();
    const footerLines = footerLineBudget >= 4
      ? _buildQueueProviderUsageLines(width, footerLineBudget, providerUsageCache.summaries || [], {
        activeProviders,
        currentRunProviderUsage: providerUsageCache.currentRunProviderUsage || [],
        runStartedAtIso: this._runStartedAtIso,
      })
      : [];
    // ── Code-intelligence readiness bars (ATLAS + ONNX), above the queue ──
    const readinessLines = (maxLines - workers.length - footerLines.length) >= 6
      ? this._buildAtlasReadinessLines()
      : [];
    // Brand-rule headers bracket the two sections: "context health" over the
    // readiness bars, "queue" over the work-item list (the rule replaces the old
    // plain divider AND the inline bold "Queue" header).
    const readinessHeader = readinessLines.length > 0 ? 1 : 0;
    const queueBudget = Math.max(maxLines - workers.length - 1 - readinessHeader - footerLines.length - readinessLines.length, 2); // -1 for the queue rule
    const queue = this._buildQueue(width, queueBudget);

    // ── Assemble ──
    const lines = [];
    lines.push(...workers);
    if (readinessLines.length > 0) {
      lines.push(brandRule({ label: "context health", color: C.cyan, width }));
      lines.push(...readinessLines);
    }
    lines.push(brandRule({ label: "queue", color: C.cyan, width })); // header + separator above queue
    lines.push(...queue);
    if (footerLines.length > 0) {
      const paddingLines = Math.max(0, maxLines - lines.length - footerLines.length);
      for (let i = 0; i < paddingLines; i++) lines.push("");
      lines.push(...footerLines);
    }

    return lines;
  }

  /**
   * Two live code-intelligence readiness bars (ATLAS composite + ONNX) for the
   * left panel, above the queue. Fed by the conductor's streamed warm progress
   * and seeded from the boot warm's real result (see warm-progress.js): they
   * fill while a warm runs and rest at "ready"/"incomplete". "off" is reserved
   * for genuinely-disabled-by-config; "not ready" means nothing has been
   * observed yet this session.
   */
  _buildAtlasReadinessLines() {
    let r;
    try { r = getWarmReadiness(); } catch { return []; }
    // Ease the displayed fill toward its target each frame so even a sub-second
    // incremental warm shows a visible sweep instead of snapping idle→ready. Eases
    // UP only; snaps down (a new warm cycle resets the target to ~0, and idle/off
    // resets to 0) so the bar never visibly reverses.
    if (!this._readinessAnim) this._readinessAnim = { atlas: 0, onnx: 0 };
    const ease = (key, target, known) => {
      if (!known) { this._readinessAnim[key] = 0; return 0; }
      const cur = this._readinessAnim[key] ?? 0;
      const next = target <= cur
        ? target
        : Math.min(target, cur + Math.max(3, (target - cur) * 0.34));
      this._readinessAnim[key] = next;
      return next;
    };
    const pctStr = (n) => `${String(Math.round(n)).padStart(3)}%`;
    // Leading status glyph + rest-label color per row, so the bar's state reads
    // at a glance: active sweep, finished, didn't-finish, or never-ran.
    //   active → forward caret (bar color)   ready  → check (green)
    //   off / idle → dim dot                 partial→ "!" (yellow, honest)
    const rowState = (color, known, active, pct, off) => {
      // off/never-ran wins over active: an idle ONNX bar shouldn't show a sweep
      // caret just because ATLAS is warming.
      if (off || !known) return { glyph: `${C.dim}·${C.reset}`, restColor: C.dim };
      if (active) return { glyph: `${color}▸${C.reset}`, restColor: C.bold };
      if (pct >= 100) return { glyph: `${C.green}✓${C.reset}`, restColor: C.green };
      return { glyph: `${C.yellow}!${C.reset}`, restColor: C.yellow };
    };
    const row = (key, label, color, target, known, right, off = false) => {
      const shown = ease(key, target, known);
      const g = readinessGauge(known && !off ? shown : null, { width: 16, color });
      const st = rowState(color, known, r.active, target ?? 0, off);
      return ` ${st.glyph} ${color}${label.padEnd(5)}${C.reset} ${g.bar} ${st.restColor}${right}${C.reset}`;
    };
    // Resting label: "ready" (fully warmed) / "incomplete" (warm didn't
    // finish) / "not ready" (nothing observed yet this session — e.g. boot
    // failed before seeding). Active → live % + the language/stage worked.
    const restLabel = (pct) => pct == null ? "not ready" : (pct >= 100 ? "ready" : "incomplete");
    // "off" only when config genuinely disables the subsystem (seeded at boot
    // from real settings) — never inferred from "no percent observed yet".
    const atlasOff = r.atlasEnabled === false;
    const onnxOff = atlasOff || r.onnxEnabled === false;
    // ATLAS composite (scip + tree-sitter + view-merge).
    const atlasRight = atlasOff
      ? "off"
      : (r.active
        ? `${pctStr(r.atlas ?? 0)} ${r.lang || r.stage || ""}`.trimEnd()
        : restLabel(r.atlas));
    // ONNX (embeddings).
    const onnxRight = onnxOff
      ? "off"
      : (r.active && r.onnx != null ? pctStr(r.onnx) : restLabel(r.onnx));
    return [
      row("atlas", "ATLAS", C.cyan, r.atlas ?? 0, r.atlas != null || r.active, atlasRight, atlasOff),
      row("onnx", "ONNX", C.magenta, r.onnx ?? 0, r.onnx != null, onnxRight, onnxOff),
    ];
  }

  _buildQueue(width, maxLines) {
    const lines = [];
    const inner = width - 1;

    try {
      const { workItems, jobs: allJobs, dirtyState = null } = this._getQueueData();
      // Background ATLAS warm jobs are reported by the context-health readiness
      // bars (see _buildAtlasReadinessLines), not as queue rows, so the queue
      // shows only normal work-item jobs.
      const normalJobs = allJobs.filter((job) => !jobIsBackgroundAtlasWarm(job));
      const jobsByWi = new Map();
      for (const job of normalJobs) {
        if (!jobsByWi.has(job.work_item_id)) jobsByWi.set(job.work_item_id, []);
        jobsByWi.get(job.work_item_id).push(job);
      }

      // Active job IDs (for highlighting)
      const activeJobIds = new Set();
      for (const [jobId] of this.workers) activeJobIds.add(jobId);

      const TERMINAL = new Set(TERMINAL_JOB_STATUSES);
      const dirtyReviewByWi = this._dirtyReviewIssuesByWi(dirtyState);
      const dirtyReviewForWi = (wi) => {
        if (String(wi?.merge_state || "").toLowerCase() === "merged") return null;
        return dirtyReviewByWi.get(Number(wi?.id)) || null;
      };

      // Hide only truly finished WIs. If a follow-up recommendation job was
      // queued against a previously-complete WI, trust live job state here
      // rather than stale work_item.status so it still shows in the queue.
      const visible = workItems.filter(wi => {
        const jobs = jobsByWi.get(wi.id) || [];
        if (dirtyReviewForWi(wi)) return true;
        const displayStatus = workItemDisplayStatus(wi, jobs);
        if (displayStatus === "canceled") return false;
        if (jobs.length === 0) return displayStatus !== "complete";
        if (displayStatus === "complete") return false;
        return !jobs.every((job) => TERMINAL.has(job.status));
      });
      const hidden = workItems.length - visible.length;
      // The "queue" brand-rule header is emitted by the panel assembler above
      // (alongside the "context health" rule over the readiness bars), so no
      // inline header is pushed here.

      const visibleItems = visible.map((wi) => {
        const jobs = jobsByWi.get(wi.id) || [];
        const dirtyReview = dirtyReviewForWi(wi);
        const done = jobs.filter(j => TERMINAL.has(j.status)).length;
        const wiFailed = jobs.filter(j => jobIsDisplayFailure(j, jobs)).length;
        const allDone = jobs.length > 0 && done === jobs.length;
        const activeJobs = [];
        const pendingJobs = [];
        const jobStates = new Map();
        let doneCount = 0;
        let failedCount = 0;

        for (const j of jobs) {
          const isActive = activeJobIds.has(j.id);
          const state = queueJobDisplayState(j, { active: isActive });
          jobStates.set(Number(j.id), state);
          if (state === "running" || state === "assessing") {
            activeJobs.push(j);
          } else if (TERMINAL.has(j.status)) {
            doneCount++;
            if (jobIsDisplayFailure(j, jobs)) failedCount++;
          } else {
            pendingJobs.push(j);
          }
        }

        return {
          wi,
          jobs,
          done,
          wiFailed,
          allDone,
          allPassed: allDone && wiFailed === 0,
          activeJobs,
          pendingJobs,
          jobStates,
          queueJobLabels: jobs.map((job) => jobLabel(job.job_type, job.title)),
          doneCount,
          failedCount,
          dirtyReview,
        };
      });
      const pendingJobCap = queuePendingCapForVisibleItems(
        visibleItems,
        Math.max(maxLines - lines.length, 0)
      );

      for (let wiIdx = 0; wiIdx < visibleItems.length; wiIdx++) {
        const {
          wi,
          jobs,
          done,
          wiFailed,
          allDone,
          allPassed,
          activeJobs,
          pendingJobs,
          jobStates,
          queueJobLabels,
          doneCount,
          failedCount,
          dirtyReview,
        } = visibleItems[wiIdx];
        if (lines.length >= maxLines - 1) {
          const remaining = visibleItems.length - wiIdx;
          // A prior work-item block can push us to (or past) the budget, so drop
          // any trailing detail rows before appending the tally. Otherwise the
          // "... N more" line overruns maxLines and the panel assembler clips a
          // line off the bottom — which is the pinned provider/codex usage footer.
          while (lines.length > maxLines - 1) lines.pop();
          lines.push(` ${C.dim}... ${remaining} more${C.reset}`);
          break;
        }

        // All done — single collapsed line
        if (allDone) {
          const icon = allPassed ? `${C.green}\u2713` : `${C.red}\u2717`;
          const failTag = wiFailed > 0 ? ` ${C.red}${wiFailed} failed${C.reset}${C.dim}` : "";
          const reviewTag = dirtyReview ? ` ${C.yellow}needs review${C.reset}${C.dim}` : "";
          const dirtyTag = dirtyReview ? `, ${dirtyReview.label}` : "";
          const prefix = ` ${icon}${C.reset} ${C.dim}WI#${wi.id} (${done}/${jobs.length}${failTag}${dirtyTag})${reviewTag}${C.reset}`;
          lines.push(formatQueueWiHeader(prefix, wi.title, inner));
          continue;
        }

        // WI header — surface failure count so partial failures aren't hidden
        const headerFail = wiFailed > 0 ? ` ${C.red}${wiFailed}\u2717${C.reset}${C.dim}` : "";
        const dirtyTag = dirtyReview ? `${C.dim} · ${dirtyReview.label}${C.reset}` : "";
        const liveSummary = formatQueueJobStateSummary([...activeJobs, ...pendingJobs], jobStates);
        const liveTag = liveSummary ? ` ${liveSummary}` : "";
        const reviewTag = dirtyReview && activeJobs.length === 0 && pendingJobs.length === 0
          ? ` ${C.yellow}needs review${C.reset}`
          : "";
        const prefix = ` ${C.blue}WI#${wi.id}${C.reset} ${C.dim}(${done}/${jobs.length}${headerFail}${C.dim})${C.reset}${liveTag}${dirtyTag}${reviewTag}`;
        lines.push(formatQueueWiHeader(prefix, "", inner));

        // Show running jobs with glow
        for (const j of activeJobs) {
          if (lines.length >= maxLines) break;
          const runTag = this._jobRunningTag(j);
          const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
          const glowOn = Math.floor(this._spinIdx / 3) % 2 === 0;
          const glow = glowOn ? `${C.bold}${C.brightWhite}` : `${C.bold}${tc}`;
          const jobRef = `${C.dim}#${j.id}${C.reset}`;
          // Budget the title around the status tag so long tags (e.g. ATLAS
          // warm details) shrink the title instead of overflowing the row.
          const statusTag = this._jobStatusTag(j);
          const tagWidth = statusTag ? stripAnsi(statusTag).length : 0;
          const jTitle = formatQueueJobTitle(jobLabel(j.job_type, j.title), Math.max(12, inner - 20 - tagWidth), queueJobLabels);
          lines.push(`  ${runTag} ${jobRef} ${glow}${jTitle}${C.reset}${statusTag}`);
        }

        const maxPending = Math.min(
          pendingJobs.length,
          Math.max(pendingJobCap, 0)
        );
        for (let i = 0; i < maxPending; i++) {
          if (lines.length >= maxLines) break;
          const j = pendingJobs[i];
          const icon = this._jobIcon(j, false, jobs);
          const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
          const typeTag = `${tc}[${JOB_TYPE_ABBR[j.job_type] || j.job_type[0].toUpperCase()}]${C.reset}`;
          const jobRef = `${C.dim}#${j.id}${C.reset}`;
          const statusTag = this._jobStatusTag(j);
          const tagWidth = statusTag ? stripAnsi(statusTag).length : 0;
          const jTitle = formatQueueJobTitle(jobLabel(j.job_type, j.title), Math.max(12, inner - 20 - tagWidth), queueJobLabels);
          lines.push(`  ${icon}${C.reset} ${typeTag} ${jobRef} ${jTitle}${statusTag}`);
        }
        if (pendingJobs.length > maxPending) {
          const hiddenJobs = pendingJobs.slice(maxPending);
          const hiddenSummary = formatQueueJobStateSummary(hiddenJobs, jobStates);
          lines.push(`  ${C.dim}  + ${hiddenSummary || `${hiddenJobs.length} pending`} hidden${C.reset}`);
        }

        // Summary line for done jobs
        if (doneCount > 0) {
          const failStr = failedCount > 0 ? `, ${C.red}${failedCount} failed${C.reset}${C.dim}` : "";
          lines.push(`  ${C.dim}\u2713 ${doneCount} done${failStr}${C.reset}`);
        }
      }
      if (hidden > 0) {
        lines.push(` ${C.dim}${hidden} merged/done${C.reset}`);
      }
    } catch {
      lines.push(` ${C.dim}(loading...)${C.reset}`);
    }

    // Honor the budget unconditionally: the per-work-item body pushes a few rows
    // ("+N hidden", done summaries) without re-checking, so the last block can
    // overshoot. Returning more than maxLines lets the assembler clip the pinned
    // footer off the bottom of the panel.
    if (lines.length > maxLines) lines.length = maxLines;

    return lines;
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

  _jobIcon(j, isActive, jobs = []) {
    if (isActive || j.status === "running") return null; // handled by _jobRunningTag
    const displayStatus = jobDisplayStatus(j, jobs);
    if (displayStatus === "succeeded") return `${C.green}\u2713`;
    if (displayStatus === "recovered") return `${C.yellow}\u21bb`;
    if (j.status === "awaiting_assessment") return `${C.cyan}\u2026`;
    if (displayStatus === "failed" || displayStatus === "dead_letter") return `${C.red}\u2717`;
    if (j.status === "waiting_on_human" || (j.job_type === "human_input" && j.status !== "succeeded")) return `${C.yellow}\u26a0`;
    if (j.status === "waiting_on_review") return `${C.magenta}?`;
    if (j.status === "blocked") return `${C.yellow}\u2016`;
    if (j.status === "queued") return `${C.blue}\u25cb`;
    return `${C.dim}~`;
  }

  /** Build a snake-wrapped role tag for running jobs, e.g. ⠋[D]⠁ */
  _jobRunningTag(j) {
    // 3-dot snake traces a rectangular path (clockwise) around the [X] tag.
    // Path: L.dot1 → L.dot4 → R.dot1 → R.dot4 → R.dot5 → R.dot6 → R.dot3 → L.dot6 → L.dot3 → L.dot2
    // Each frame is [left_braille, right_braille] showing 3 consecutive positions on the rectangle.
    const frames = [
      ["\u2807", "\u2800"],  // ⠇ ⠀  — left side (dots 1,2,3)
      ["\u280b", "\u2800"],  // ⠋ ⠀  — turning top-left corner (dots 1,2,4)
      ["\u2809", "\u2801"],  // ⠉ ⠁  — across top-left (dots 1,4 | dot 1)
      ["\u2808", "\u2809"],  // ⠈ ⠉  — across top-right (dot 4 | dots 1,4)
      ["\u2800", "\u2819"],  // ⠀ ⠙  — turning top-right corner (dots 1,4,5)
      ["\u2800", "\u2838"],  // ⠀ ⠸  — right side (dots 4,5,6)
      ["\u2800", "\u2834"],  // ⠀ ⠴  — turning bottom-right corner (dots 3,5,6)
      ["\u2820", "\u2824"],  // ⠠ ⠤  — across bottom-right (dot 6 | dots 3,6)
      ["\u2824", "\u2804"],  // ⠤ ⠄  — across bottom-left (dots 3,6 | dot 3)
      ["\u2826", "\u2800"],  // ⠦ ⠀  — turning bottom-left corner (dots 2,3,6)
    ];
    const [l, r] = frames[this._spinIdx % frames.length];
    const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
    const letter = JOB_TYPE_ABBR[j.job_type] || j.job_type[0].toUpperCase();
    return `${C.cyan}${l}${C.reset}${tc}[${letter}]${C.reset}${C.cyan}${r}${C.reset}`;
  }

  _jobStatusTag(j) {
    if (j.job_type === "atlas_warm") return this._atlasWarmStatusTag(j);
    if (j.status === "waiting_on_human") return ` ${C.yellow}needs input${C.reset}`;
    if (j.status === "waiting_on_review") return ` ${C.magenta}needs review${C.reset}`;
    if (j.job_type === "human_input" && ["running", "queued"].includes(j.status)) return ` ${C.yellow}input needed${C.reset}`;
    if (j.status === "awaiting_assessment") return ` ${C.cyan}assessing${C.reset}`;
    return "";
  }

  _atlasWarmStatusTag(j) {
    const info = describeAtlasWarmJob(j);
    const paths = info.paths > 0 ? ` ${info.paths} path${info.paths === 1 ? "" : "s"}` : "";
    const label = `${info.purpose} ${info.target}${paths}`;
    const words = atlasWarmStatusWords(info);
    if (j.status === "running" || j.status === "leased") return ` ${C.cyan}${words.active} ${label}${C.reset}`;
    if (j.status === "queued" || j.status === "blocked") return ` ${C.blue}${words.queued} ${label}${C.reset}`;
    if (j.status === "failed" || j.status === "dead_letter") return ` ${C.red}${words.failed} ${label}${C.reset}`;
    if (j.status === "succeeded") return ` ${C.green}${words.succeeded} ${label}${C.reset}`;
    return ` ${C.dim}${label}${C.reset}`;
  }

  _withPosseMascot(headerLines, width) {
    const laneWidth = Math.max(0, width - POSSE_HEADER_WIDTH - POSSE_HEADER_MASCOT_GAP);
    const mascot = renderPosseMascotFrame({
      tick: this._spinIdx,
      laneWidth,
      colors: C,
    });
    if (!mascot) return headerLines;

    const gap = " ".repeat(POSSE_HEADER_MASCOT_GAP);
    return headerLines.map((line, idx) => `${line}${gap}${mascot[idx] || ""}`);
  }

  _dirtyReviewIssuesByWi(dirtyState = null) {
    const byWi = new Map();
    const dirtyItems = Array.isArray(dirtyState?.dirtyItems) ? dirtyState.dirtyItems : [];
    for (const item of dirtyItems) {
      const wiId = Number(item?.wiId ?? item?.work_item_id);
      if (!Number.isFinite(wiId)) continue;
      const issues = Array.isArray(item?.issues) ? item.issues : [];
      const manualIssues = issues.filter((issue) =>
        ["dirty", "stash", "orphan", "orphan_ref"].includes(String(issue?.type || "")));
      if (manualIssues.length === 0) continue;
      const dirtyIssue = manualIssues.find((issue) => issue.type === "dirty");
      const dirtyCount = dirtyIssue?.files
        ? String(dirtyIssue.files).split("\n").filter(Boolean).length
        : 0;
      const stashIssue = manualIssues.find((issue) => issue.type === "stash");
      const orphanIssue = manualIssues.find((issue) => issue.type === "orphan" || issue.type === "orphan_ref");
      const parts = [
        dirtyCount > 0 ? `${dirtyCount} dirty` : dirtyIssue ? "dirty" : null,
        stashIssue ? "stash" : null,
        orphanIssue ? "orphan" : null,
      ].filter(Boolean);
      byWi.set(wiId, {
        item,
        issues: manualIssues,
        label: parts.length > 0 ? parts.join(", ") : "dirty tree",
      });
    }
    return byWi;
  }

  // ── Right Panel: Header + Event Log ───────────────────────────────────

  _buildRight(width, maxLines) {
    const lines = [];

    // ── ASCII art header (side-by-side box-drawing) ──
    //   MASONS (dim) + gap + POSSE (cyan)
    //   Each letter is 3 chars wide, 1-char space between letters, 2-char gap between words
    //   Total visible: 23 + 2 + 19 = 44 chars + 1 leading space = 45
    if (width >= 46) {
      lines.push(...this._withPosseMascot([
        ` ${C.dim}\u250f\u2533\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2513\u257b \u250f\u2501\u2513${C.reset}  ${C.cyan}\u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2578${C.reset}`,
        ` ${C.dim}\u2503\u2503\u2503 \u2523\u2501\u252b \u2517\u2501\u2513 \u2503 \u2503 \u2503\u2517\u252b \u2517\u2501\u2513${C.reset}  ${C.cyan}\u2523\u2501\u251b \u2503 \u2503 \u2517\u2501\u2513 \u2517\u2501\u2513 \u2523\u2501\u2578${C.reset}`,
        ` ${C.dim}\u2579 \u2579 \u2579 \u2579 \u2517\u2501\u251b \u2517\u2501\u251b \u2579 \u2579 \u2517\u2501\u251b${C.reset}  ${C.cyan}\u2579   \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u2578${C.reset}`,
      ], width));
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 44))}${C.reset}`);
    } else if (width >= 20) {
      lines.push(` ${C.dim}Mason's${C.reset} ${C.cyan}${C.bold}Posse${C.reset}`);
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 16))}${C.reset}`);
    } else {
      lines.push(` ${C.cyan}${C.bold}Mason's Posse${C.reset}`);
    }

    if (this._rightMode === "pipeline" && this.getPipelineData) {
      return this._buildPipeline(lines, width, maxLines);
    }

    if (this._rightMode === "tools" && this.getToolData) {
      return this._buildTools(lines, width, maxLines);
    }

    // ── Event log fills the rest, minus a pinned "system" tail ──
    // Reserve the bottom rows for git / ATLAS chatter so it can never scroll
    // the job/work log off-screen. The tail is hidden when there's no recent
    // system activity, and capped so it can't crowd the log on a short pane.
    const sysCount = Math.min(
      this._systemEvents.length,
      this._systemLaneRows,
      Math.max(0, maxLines - lines.length - 2),
    );
    const sysBlock = sysCount > 0 ? sysCount + 1 : 0; // +1 for the rule

    const available = Math.max(0, maxLines - lines.length - sysBlock);
    const start = Math.max(0, this.events.length - available);
    const visible = this.events.slice(start);

    for (const ev of visible) {
      const { glyph, color } = this._classifyEvent(ev.text);
      lines.push(` ${C.dim}${ev.time}${C.reset} ${color}${glyph}${C.reset} ${ev.text}`);
    }

    if (sysBlock > 0) {
      // Pin the tail to the bottom of the pane.
      while (lines.length < maxLines - sysBlock) lines.push("");
      const tail = "╌".repeat(Math.max(3, Math.min(width - 12, 40)));
      lines.push(` ${C.dim}╌╌╌ system ${tail}${C.reset}`);
      for (const ev of this._systemEvents.slice(-sysCount)) {
        lines.push(` ${C.dim}${ev.time}${C.reset} ${ev.text}`);
      }
    }

    return lines;
  }

  // Cheap classifier: stripped-text keyword sniffing to choose a leading glyph
  // and tint. The event log stores opaque pre-styled strings, so we infer
  // from visible content rather than threading a type all the way through.
  _classifyEvent(text) {
    const lower = stripAnsi(String(text || "")).toLowerCase();
    if (/\[assessor\]\s*pass\b/.test(lower)) {
      return { glyph: "✓", color: C.green };
    }
    if (/\[assessor\]\s*fail\b/.test(lower)) {
      return { glyph: "✗", color: C.red };
    }
    if (/\b(failed|rejected|killed|aborted|✗|✖)\b/.test(lower) || /\berror\s*[:=-]/.test(lower)) {
      return { glyph: "✗", color: C.red };
    }
    if (/\b(succeeded|completed|merged|approved|pass|passed|✓|✔)\b/.test(lower)) {
      return { glyph: "✓", color: C.green };
    }
    if (/\b(recovered|retry|retrying|reassigned|↻)\b/.test(lower)) {
      return { glyph: "↻", color: C.yellow };
    }
    if (/\b(needs input|question|waiting on|paused|stalled|\?|⚠)\b/.test(lower)) {
      return { glyph: "?", color: C.yellow };
    }
    if (/\b(started|spawned|queued|leased|begin|booting)\b/.test(lower)) {
      return { glyph: "→", color: C.blue };
    }
    return { glyph: "·", color: C.dim };
  }

  // ── Pipeline View ──────────────────────────────────────────────────────

  _buildPipeline(headerLines, width, maxLines) {
    const lines = [...headerLines];
    lines.push(` ${C.bold}${C.cyan}\u2502 Pipeline${C.reset}  ${C.dim}[p] back to log  [\u2191\u2193] scroll${C.reset}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 50))}${C.reset}`);

    let data;
    try { data = this.getPipelineData(); } catch { data = []; }
    if (!data || data.length === 0) {
      lines.push(` ${C.dim}No active work items${C.reset}`);
      return lines;
    }

    const contentLines = [];
    const VERDICT_ICON = { pass: `${C.green}\u2713`, fail: `${C.red}\u2717`, blocked: `${C.yellow}\u25a0`, needs_review: `${C.yellow}?`, needs_replan: `${C.magenta}\u21bb`, not_assessed: `${C.dim}\u00b7` };

    for (const wi of data) {
      contentLines.push(` ${C.bold}${C.blue}WI#${wi.id}${C.reset} ${_sanitizeDisplayLine(wi.title).slice(0, width - 12)}`);

      if (!wi.jobs || wi.jobs.length === 0) {
        contentLines.push(`   ${C.dim}(no jobs)${C.reset}`);
        contentLines.push("");
        continue;
      }

      // Group jobs into pipeline stages and show handoff data
      for (const job of wi.jobs) {
        const icon = roleBrandIcon(job.job_type);
        const color = roleBrandColor(job.job_type);
        const displayStatus = jobDisplayStatus(job, wi.jobs);
        const statusIcon = displayStatus === "recovered"
          ? `${C.yellow}\u21bb`
          : paletteStatusIcon(displayStatus, { kind: "job", colors: C });

        // Verdict indicator for assessed jobs
        const verdict = job.assessor_verdict && job.assessor_verdict !== "not_assessed"
          ? ` ${VERDICT_ICON[job.assessor_verdict] || ""}${C.reset}`
          : "";

        // Brand-tinted, bolded role badge + role-colored leading accent bar
        contentLines.push(`  ${color}\u258e${C.reset} ${statusIcon}${C.reset} ${C.bold}${color}[${icon}]${C.reset} #${job.id} ${_sanitizeDisplayLine(jobLabel(job.job_type, job.title)).slice(0, width - 22)}${verdict}`);

        // Show handoff data based on role
        if (job.handoff) {
          for (const h of job.handoff) {
            contentLines.push(`     ${C.dim}\u2514\u2500 ${_sanitizeDisplayLine(h)}${C.reset}`);
          }
        }
      }
      contentLines.push("");
    }

    // Apply scroll. Clamp (and write back) so holding the down key past the
    // end can't scroll the content fully out of view into a blank panel.
    const available = maxLines - lines.length;
    const maxScroll = Math.max(0, contentLines.length - available);
    if (this._pipelineScroll > maxScroll) this._pipelineScroll = maxScroll;
    const scrolled = contentLines.slice(this._pipelineScroll, this._pipelineScroll + available);
    lines.push(...scrolled);

    return lines;
  }

  // ── Tools View ─────────────────────────────────────────────────────────

  _buildTools(headerLines, width, maxLines) {
    const lines = [...headerLines];
    lines.push(` ${C.bold}${C.cyan}\u2502 Tools${C.reset}  ${C.dim}[t] back to log  [Tab/1-3] pane  [\u2191\u2193] scroll${C.reset}`);
    const tabBar = [
      this._toolsTab === 0 ? `${C.bold}${C.cyan}[1:Tools]${C.reset}` : `${C.dim} 1:Tools ${C.reset}`,
      this._toolsTab === 1 ? `${C.bold}${C.cyan}[2:Roles]${C.reset}` : `${C.dim} 2:Roles ${C.reset}`,
      this._toolsTab === 2 ? `${C.bold}${C.cyan}[3:Locks]${C.reset}` : `${C.dim} 3:Locks ${C.reset}`,
    ].join(" ");
    lines.push(` ${tabBar}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 50))}${C.reset}`);

    let data;
    try { data = this.getToolData(); } catch { data = null; }
    const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
    const recent = (data && Array.isArray(data.recent)) ? data.recent : [];
    const activeLockLines = this._buildActiveLockLines(width, data?.activeLocks);

    if (jobs.length === 0 && recent.length === 0 && activeLockLines.length === 0) {
      const emptyLines = this._toolsTab === 2
        ? [
            ` ${C.dim}No active file locks right now${C.reset}`,
            "",
            ` ${C.dim}Held file locks appear here, grouped by work item, while dev/fix/promote jobs run.${C.reset}`,
          ]
        : [
            ` ${C.dim}No tool invocations recorded yet${C.reset}`,
            "",
            ` ${C.dim}Tools appear here when agents invoke MCP or web tools${C.reset}`,
            ` ${C.dim}(read_file, list_files, WebSearch, WebFetch, etc.).${C.reset}`,
          ];
      lines.push(...emptyLines);
      return lines;
    }

    const toolLines = [];
    const roleLines = [];
    const lockLines = [];

    if (recent.length > 0) {
      const collapsedRecent = [];
      for (const r of recent) {
        const key = [
          r.job_id ?? "",
          r.work_item_id ?? "",
          r.observation_type || "",
          r.summary || "",
        ].join("|");
        const last = collapsedRecent[collapsedRecent.length - 1];
        if (last?._collapseKey === key) {
          last._repeatCount += 1;
          continue;
        }
        collapsedRecent.push({ ...r, _collapseKey: key, _repeatCount: 1 });
      }
      const collapsedHint = collapsedRecent.length === recent.length
        ? ""
        : `, ${collapsedRecent.length} shown`;
      toolLines.push(` ${C.bold}Recent invocations${C.reset} ${C.dim}(latest ${recent.length}${collapsedHint})${C.reset}`);
      for (const r of collapsedRecent) {
        const when = String(r.created_at || "").slice(11, 19) || "--:--:--";
        const jobId = r.job_id != null ? `#${r.job_id}` : "#?";
        const tool = String(r.observation_type || "tool.?").replace(/^tool\./, "");
        const summary = stripRedundantToolSummaryLabel(tool, r.summary);
        const prefix = ` ${C.dim}${when}${C.reset} ${jobId.padStart(5)} ${C.cyan}${tool}${C.reset} `;
        const prefixLen = when.length + 1 + Math.max(jobId.length, 5) + 1 + tool.length + 2;
        const budget = Math.max(10, width - prefixLen - 2);
        const repeatHint = r._repeatCount > 1 ? ` ${C.dim}x${r._repeatCount}${C.reset}` : "";
        const repeatLen = r._repeatCount > 1 ? String(` x${r._repeatCount}`).length : 0;
        const summaryBudget = Math.max(10, budget - repeatLen);
        const summaryShort = summary.length > summaryBudget ? summary.slice(0, summaryBudget - 1) + "\u2026" : summary;
        toolLines.push(`${prefix}${summaryShort}${repeatHint}`);
      }
    } else {
      toolLines.push(` ${C.dim}No recent tool invocations${C.reset}`);
    }

    if (jobs.length > 0) {
      roleLines.push(` ${C.bold}By role${C.reset} ${C.dim}(from top ${jobs.length} jobs)${C.reset}`);
      const roleMap = new Map();
      for (const j of jobs) {
        const role = String(j.job_type || "?");
        if (!roleMap.has(role)) roleMap.set(role, { calls: 0, jobs: 0, toolTypes: new Set() });
        const entry = roleMap.get(role);
        entry.calls += Number(j.total || 0);
        entry.jobs += 1;
        for (const t of String(j.tool_types || "").split(",")) {
          const norm = String(t || "").trim().replace(/^tool\./, "");
          if (norm) entry.toolTypes.add(norm);
        }
      }
      const hdr = `  ${"Role".padEnd(12)} ${"Calls".padStart(7)} ${"Jobs".padStart(6)}  Tools`;
      roleLines.push(` ${C.dim}${hdr}${C.reset}`);
      const sorted = [...roleMap.entries()].sort((a, b) => b[1].calls - a[1].calls);
      for (const [role, agg] of sorted) {
        const color = roleBrandColor(role);
        const roleLabel = role.slice(0, 12).padEnd(12);
        const calls = String(agg.calls).padStart(7);
        const jobCount = String(agg.jobs).padStart(6);
        const types = [...agg.toolTypes].slice(0, 8).join(", ");
        roleLines.push(`  ${C.bold}${color}${roleLabel}${C.reset} ${calls} ${jobCount}  ${C.dim}${types}${C.reset}`);
      }

      roleLines.push("");
      roleLines.push(` ${C.bold}By job${C.reset} ${C.dim}(live detail)${C.reset}`);
      const byJobHdr = `  ${"Job".padStart(5)}  ${"WI".padStart(4)}  ${"Role".padEnd(9)}  ${"Calls".padStart(5)}  Tools`;
      roleLines.push(` ${C.dim}${byJobHdr}${C.reset}`);
      for (const j of jobs) {
        const color = roleBrandColor(j.job_type);
        const role = (j.job_type || "?").slice(0, 9).padEnd(9);
        const jobId = String(j.job_id ?? "?").padStart(5);
        const wi = String(j.work_item_id ?? "?").padStart(4);
        const calls = String(j.total || 0).padStart(5);
        const types = String(j.tool_types || "").split(",").map((t) => t.trim().replace(/^tool\./, "")).filter(Boolean).join(", ");
        const typesMax = Math.max(10, width - (5 + 2 + 4 + 2 + 9 + 2 + 5 + 2 + 3));
        const typesShort = types.length > typesMax ? types.slice(0, typesMax - 1) + "\u2026" : types;
        roleLines.push(`  ${jobId}  ${wi}  ${color}${role}${C.reset}  ${calls}  ${C.dim}${typesShort}${C.reset}`);
      }
    } else {
      roleLines.push(` ${C.dim}No role/tool aggregates available yet${C.reset}`);
    }

    if (activeLockLines.length > 0) {
      lockLines.push(...activeLockLines);
    } else {
      lockLines.push(` ${C.dim}No active file locks right now${C.reset}`);
    }

    const panes = [toolLines, roleLines, lockLines];
    const contentLines = panes[this._toolsTab] || toolLines;
    const available = Math.max(0, maxLines - lines.length);
    const maxScroll = Math.max(0, contentLines.length - available);
    const rawScroll = this._toolsTabScrolls[this._toolsTab] || 0;
    const scroll = Math.max(0, Math.min(rawScroll, maxScroll));
    this._toolsTabScrolls[this._toolsTab] = scroll;
    this._toolScroll = scroll;
    const scrolled = contentLines.slice(scroll, scroll + available);
    lines.push(...scrolled);

    return lines;
  }

  _buildActiveLockLines(width, activeLocks = null) {
    // Active locks only. Queued reservations ("what a job will lock later")
    // are filtered out by the _isDisplayActive* guards, and the queued-job
    // waiting forecast lives in the worker pane, not here.
    const heldJobs = Array.isArray(activeLocks?.jobs)
      ? activeLocks.jobs.filter((lock) => this._isDisplayActiveJobLock(lock))
      : [];
    const heldWorkItems = Array.isArray(activeLocks?.work_items)
      ? activeLocks.work_items.filter((lock) => this._isDisplayActiveWorkItemLock(lock))
      : [];

    // One group per work item. Job-tier and work-item-tier locks merge into a
    // single file list per WI; each file is attributed to the job that holds
    // it (the running job, or the source job behind a pending-review WI lock).
    // Identical holder+path pairs collapse so a file appears once.
    const byWi = new Map();
    const ensureGroup = (wiId, sample = {}) => {
      const key = wiId == null ? "?" : String(wiId);
      let group = byWi.get(key);
      if (!group) {
        group = { wiId: key, title: null, status: null, mergeState: null, files: new Map() };
        byWi.set(key, group);
      }
      if (!group.title && sample.work_item_title) group.title = sample.work_item_title;
      if (!group.status && sample.work_item_status) group.status = sample.work_item_status;
      if (!group.mergeState && sample.merge_state) group.mergeState = sample.merge_state;
      return group;
    };
    const addFile = (group, holderId, path) => {
      const cleanPath = path || "unknown";
      const holder = holderId != null ? `#${holderId}` : "WI";
      group.files.set(`${holder}${cleanPath}`, { holder, path: cleanPath });
    };

    for (const lock of heldJobs) addFile(ensureGroup(lock.work_item_id, lock), lock.job_id, lock.path);
    for (const lock of heldWorkItems) {
      addFile(ensureGroup(lock.work_item_id, lock), lock.source_job_id ?? lock.job_id ?? null, lock.path);
    }

    let fileCount = 0;
    for (const group of byWi.values()) fileCount += group.files.size;
    if (fileCount === 0) return [];

    const wiCount = byWi.size;
    const lines = [];
    lines.push(` ${C.bold}Active locks${C.reset} ${C.dim}· ${fileCount} file${fileCount === 1 ? "" : "s"} across ${wiCount} WI${wiCount === 1 ? "" : "s"}${C.reset}`);
    const ruleWidth = Math.min(Math.max(width - 4, 24), 58);
    lines.push(` ${C.dim}${"─".repeat(ruleWidth)}${C.reset}`);

    const sortedGroups = [...byWi.values()].sort((a, b) => this._compareMaybeNumber(a.wiId, b.wiId));

    const maxFileLines = 40;
    let shownFiles = 0;
    for (const group of sortedGroups) {
      if (shownFiles >= maxFileLines) break;

      // WI header: number, optional state, title. State explains why a WI with
      // no running job still holds locks (e.g. held pending review).
      const state = this._activeLockWiState(group);
      const wiLabel = `WI #${group.wiId}`;
      const stateChip = state ? ` ${state.color}${state.text}${C.reset}` : "";
      const headLen = wiLabel.length + (state ? state.text.length + 1 : 0);
      const titleBudget = Math.max(8, width - 2 - headLen - 3);
      let titleChip = "";
      if (group.title) {
        const raw = stripAnsi(String(group.title));
        const clipped = raw.length > titleBudget ? `${raw.slice(0, Math.max(0, titleBudget - 1))}…` : raw;
        titleChip = ` ${C.dim}· ${clipped}${C.reset}`;
      }
      lines.push("");
      lines.push(` ${C.blue}${C.bold}${wiLabel}${C.reset}${stateChip}${titleChip}`);

      const files = [...group.files.values()].sort((a, b) =>
        this._compareLockText(a.path, b.path) || this._compareLockText(a.holder, b.holder));
      const holderWidth = files.reduce((max, f) => Math.max(max, f.holder.length), 3);
      const pathBudget = Math.max(12, width - 3 - holderWidth - 2);
      for (const file of files) {
        if (shownFiles >= maxFileLines) break;
        const holderCell = file.holder.padEnd(holderWidth);
        const pathCell = this._lockTableCell(file.path, pathBudget);
        lines.push(`   ${C.cyan}${holderCell}${C.reset}  ${C.dim}${pathCell}${C.reset}`);
        shownFiles++;
      }
    }

    const remaining = fileCount - shownFiles;
    if (remaining > 0) {
      lines.push(`   ${C.dim}+${remaining} more locked file${remaining === 1 ? "" : "s"}${C.reset}`);
    }

    return lines;
  }

  // Short, meaningful WI state for the locks pane. Returns { text, color } or
  // null. Pending-review is highlighted because that's the common reason a WI
  // keeps holding file locks after its jobs finish.
  _activeLockWiState(group = {}) {
    const status = String(group.status || "").toLowerCase();
    const merge = String(group.mergeState || "").toLowerCase();
    if (merge === "pending_review" || (status === "complete" && merge && merge !== "merged")) {
      return { text: "pending review", color: C.yellow };
    }
    if (merge === "merge_failed") return { text: "merge failed", color: C.yellow };
    if (status) return { text: status, color: C.dim };
    return null;
  }

  _lockTableCell(value, width, align = "left") {
    const cellWidth = Math.max(1, Number(width || 1));
    const raw = stripAnsi(String(value ?? ""));
    const clipped = raw.length > cellWidth
      ? `${raw.slice(0, Math.max(0, cellWidth - 1))}\u2026`
      : raw;
    return align === "right" ? clipped.padStart(cellWidth) : clipped.padEnd(cellWidth);
  }

  _compareMaybeNumber(left, right) {
    const a = Number(left);
    const b = Number(right);
    const aFinite = Number.isFinite(a);
    const bFinite = Number.isFinite(b);
    if (aFinite && bFinite && a !== b) return a - b;
    if (aFinite !== bFinite) return aFinite ? -1 : 1;
    return this._compareLockText(left, right);
  }

  _compareLockText(left, right) {
    return String(left ?? "").localeCompare(String(right ?? ""));
  }

  _isDisplayActiveJobLock(lock = {}) {
    const status = String(lock.job_status || lock.status || "").toLowerCase();
    return status !== "queued" && status !== "pending";
  }

  _isDisplayActiveWorkItemLock(lock = {}) {
    const wiStatus = String(lock.work_item_status || "").toLowerCase();
    const mergeState = String(lock.merge_state || "").toLowerCase();
    if (wiStatus === "complete" && mergeState && mergeState !== "merged") return true;

    const sourceStatus = String(lock.source_job_status || lock.job_status || "").toLowerCase();
    if (!sourceStatus) return true;
    return sourceStatus !== "queued" && sourceStatus !== "pending";
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
