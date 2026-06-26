import { C } from "../../../../shared/format/functions/colors.js";
import { statusIcon as paletteStatusIcon } from "../../functions/display/status-palette.js";
import { fit, stripAnsi, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { roleBrandColor, roleBrandIcon } from "../../functions/display/helpers/brand.js";
import { jobLabel, jobDisplayStatus } from "../../functions/display/helpers/job-status.js";
import { renderPosseMascotFrame } from "../../functions/display/helpers/mascot.js";
import { canonicalAtlasActionName } from "../../../../functions/tools/mcp-surface.js";
import { listActiveAgentGuidanceForJob, listAgentInteractions, listWorkItems } from "../../../queue/functions/index.js";
import { _buildQueueProviderUsageLines, getProviderUsageSummaryCache } from "../../functions/display/helpers/provider-usage.js";
import { buildAdminGitDiffSnapshot, buildAdminGitDiffFileDetail } from "../../functions/admin/git-diff-review.js";

const POSSE_HEADER_WIDTH = 25;
const POSSE_HEADER_MASCOT_GAP = 2;
const POSSE_MARK = "\u259f";

// The brand mark: the original \u259f (U+259F) reverse-L / "_|" corner, aligned to the
// POSSE *letters*, not the cell grid. Box-drawing strokes are centered in their
// cell, so POSSE's cap sits at the middle of row 0 and its baseline at the middle
// of row 2 \u2014 the ink spans only mid-row-0 \u2192 mid-row-2 (two cells, centered). A
// solid \u2588 filling whole cells runs taller than that, so the upright is inset: a
// lower-half block (\u2584) starts it on the cap line, and the foot's bottom lands on
// the baseline. The foot is a uniform two-cell bar (one cell narrower than the
// banner letters) \u2014 block glyphs can't shave a partial width off a half-height
// bar without stepping the bottom edge to two widths, so it stays on whole cells \u2014
// nudged a quarter-cell taller toward the post (\u2582). One-column post (mark stays
// 3 wide). Where "MASONS" used to be, left of POSSE.
const POSSE_LOGO_ROWS = Object.freeze([
  "  \u2584",
  " \u2582\u2588",
  " \u2580\u2580",
]);
// "POSSE" in 3-row heavy box-drawing block letters (each glyph 3 cols wide, a
// 1-col gap between them). Restored from the original masthead \u2014 the only
// change is dropping the leading "MASONS" word in favour of the boxy mark.
const POSSE_BANNER_ROWS = Object.freeze([
  "\u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2513 \u250f\u2501\u2578",
  "\u2523\u2501\u251b \u2503 \u2503 \u2517\u2501\u2513 \u2517\u2501\u2513 \u2523\u2501\u2578",
  "\u2579   \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u251b \u2517\u2501\u2578",
]);
// Truecolor (24-bit) brand colours for the masthead so the mark and the word stay
// visibly distinct even on terminal themes that flatten the 16 named ANSI colours
// toward white. Mark = green, POSSE = cyan.
const MASTHEAD_LOGO_FG = "\x1b[38;2;106;214;128m";
const MASTHEAD_WORD_FG = "\x1b[38;2;96;200;236m";
const LIVE_CHANNEL_TOOL_TYPES = new Set([
  "tool.agent_feedback",
  "tool.get_operator_feedback",
  "tool.ack_operator_feedback",
]);



function posseWordmark() {
  return `${C.green}${C.bold}${POSSE_MARK}${C.reset} ${C.brightWhite}${C.bold}POSSE${C.reset}`;
}



// The full 3-row masthead: the boxy brand mark (green) beside the POSSE banner
// (cyan) — two distinct colours so the mark reads as a logo, not a letter.
function posseMastheadRows() {
  return POSSE_LOGO_ROWS.map((logo, i) =>
    ` ${C.bold}${MASTHEAD_LOGO_FG}${logo}${C.reset}  ${MASTHEAD_WORD_FG}${POSSE_BANNER_ROWS[i]}${C.reset}`);
}



function visiblePad(text, width) {
  const safeWidth = Math.max(0, width | 0);
  const fitted = fit(String(text || ""), safeWidth);
  const visible = stripAnsi(fitted).length;
  return `${fitted}${" ".repeat(Math.max(0, safeWidth - visible))}`;
}



function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// Greedy word-wrap with a hanging indent: the first line may use a different
// (usually narrower) width than the continuation lines. Hard-breaks any single
// word longer than the available width so nothing overflows the box.
function wrapHanging(text, firstWidth, restWidth) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  const cap = () => Math.max(4, lines.length === 0 ? firstWidth : restWidth);
  for (const word of words) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= cap()) cur = `${cur} ${word}`;
    else { lines.push(cur); cur = word; }
    while (cur.length > cap()) { lines.push(cur.slice(0, cap())); cur = cur.slice(cap()); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}



function formatElapsed(startTime) {
  const elapsed = Math.max(0, Math.floor((Date.now() - Number(startTime || Date.now())) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}



function compactTime(value) {
  return String(value || "").slice(11, 19) || "--:--:--";
}



function roleLabel(role) {
  return String(role || "agent").replace(/^developer$/, "dev");
}



function monitorStateMeta(state) {
  if (state === "ask") return { label: "ASK", color: C.red, rail: C.red };
  if (state === "nudge") return { label: "nudge", color: C.yellow, rail: C.yellow };
  if (state === "idle") return { label: "idle", color: C.dim, rail: C.dim };
  return { label: "live", color: C.green, rail: C.green };
}

// A two-frame breathing dot driven by the render tick (_spinIdx advances every
// ~120ms repaint). It is the proof-of-life: while the UI loop runs it pulses,
// and if the process hangs it freezes — so a frozen monitor is visibly frozen.
const MONITOR_PULSE_FRAMES = ["●", "○"]; // ● ○
function monitorPulse(spinIdx) {
  return MONITOR_PULSE_FRAMES[Math.abs(spinIdx | 0) % MONITOR_PULSE_FRAMES.length];
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function fmtDur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
}

function latestStamp(rows) {
  let max = 0;
  for (const row of rows || []) {
    const t = Date.parse(row?.created_at || "") || 0;
    if (t > max) max = t;
  }
  return max;
}

// What an OCCUPIED slot's agent is doing right now, for the fleet rail tag.
// "waiting" = blocked on the operator (ask); "nudge" = a redirect is queued;
// otherwise the most recent observed event decides "tool call" vs "thinking".
// The two live states breathe (glyph pulses off the render tick); waiting and
// nudge sit still so a parked agent reads as parked at a glance.
function monitorActivityState(agent, spinIdx) {
  if (agent.state === "ask") return { label: "waiting", color: C.red, glyph: "◉" };
  if (agent.state === "nudge") return { label: "nudge", color: C.yellow, glyph: "◆" };
  if (agent.lastEventKind === "tool") {
    return { label: "tool call", color: C.cyan, glyph: monitorPulse(spinIdx) };
  }
  return { label: "thinking", color: C.green, glyph: monitorPulse(spinIdx) };
}



function monitorFeedbackMeta(row = {}) {
  const kind = String(row.kind || "").toLowerCase();
  const direction = String(row.direction || "").toLowerCase();
  if (row._kind === "coordination") return { label: row.label || "coord", glyph: "\u25c7", color: C.blue };
  if (kind === "activity") return { label: "agent", glyph: "\u25e6", color: C.cyan };
  if (kind === "answer") return { label: "answer", glyph: "\u2713", color: C.green };
  if (kind === "scope_request") return { label: "scope", glyph: "\u25b3", color: C.magenta };
  if (kind === "status_request") return { label: "status", glyph: "?", color: C.blue };
  if (kind === "nudge") return { label: "nudge", glyph: "\u203a", color: C.yellow };
  if (direction === "user_to_agent") return { label: "input", glyph: "\u203a", color: C.yellow };
  return { label: "feedback", glyph: "\u25e6", color: C.cyan };
}



function monitorFeedbackSuffix(row = {}) {
  const direction = String(row.direction || "").toLowerCase();
  if (row._kind === "coordination") return "";
  if (direction !== "user_to_agent") return "";
  const decision = String(row.ack_decision || "").trim();
  if (decision) {
    if (decision === "accepted") return `${C.green}accepted${C.reset}`;
    if (decision === "rejected") return `${C.red}rejected${C.reset}`;
    if (decision === "deferred") return `${C.yellow}deferred${C.reset}`;
    return `${C.dim}${decision}${C.reset}`;
  }
  if (row.ack_state === "acknowledged") return `${C.green}acked${C.reset}`;
  return `${C.yellow}pending${C.reset}`;
}



// Glyph for a COMPLETED tool row. In-flight rows are detected separately by the
// caller (they pulse \u25cf \u25cb in cyan), so this only decides done-vs-failed. We no
// longer sniff the summary for "ok"/"pass": a recorded invocation that didn't
// fail simply finished, so every completed call gets one consistent \u2713. Only a
// failure keyword in the type/summary (or an explicit ok:false) downgrades it to
// a red \u2717. (Previously only rows whose summary literally carried "ok" \u2014 e.g.
// ATLAS "\u2026 ok (327ms)" \u2014 got the check, so plain reads/searches/atlas calls fell
// through to a neutral \u25cf dot and the lane looked half-finished even when every
// call had already succeeded.)
function monitorToolMeta(row = {}) {
  const text = `${row.observation_type || ""} ${row.summary || ""}`.toLowerCase();
  if (row.ok === false || /\b(error|failed|fail|denied|cancelled|canceled)\b/.test(text)) {
    return { glyph: "\u2715", color: C.red, label: "err" };
  }
  return { glyph: "\u2713", color: C.green, label: "done" };
}



function stripToolPrefix(value) {
  return String(value || "tool.?").replace(/^tool\./, "");
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



function splitAtlasActionFromSummary(summary) {
  const text = String(summary || "").trimStart();
  const match = text.match(/^((?:atlas\s+|atlas[._-]){0,4}[A-Za-z][A-Za-z0-9_.-]*)(.*)$/i);
  if (!match) return { action: null, rest: text };
  const action = canonicalAtlasActionName(match[1]);
  if (!action) return { action: null, rest: text };
  return { action, rest: String(match[2] || "").trim() };
}



// Split a tool observation into the three columns the monitor log renders:
//   module  — "atlas" or "tool" (which subsystem ran the call)
//   command — the action/tool name (memory.get, read_file, …)
//   info    — the remaining call detail (anchors, path, query, …)
// ATLAS rows carry the action inside the summary ("atlas memory.get (…)"), so
// the action is peeled off into its own command column; deterministic rows put
// the tool name in observation_type and the detail in the summary.
function monitorToolRowParts(row = {}) {
  const tool = stripToolPrefix(row.observation_type);
  const normalizedTool = normalizeToolSummaryLabel(tool);
  const isAtlas = normalizedTool === "atlas" || normalizedTool.startsWith("atlas");
  const summary = _sanitizeDisplayLine(stripRedundantToolSummaryLabel(tool, row.summary));
  if (isAtlas) {
    const { action, rest } = splitAtlasActionFromSummary(summary);
    if (action) return { module: "atlas", command: action, info: rest };
    return { module: "atlas", command: "", info: summary };
  }
  return { module: "tool", command: tool, info: summary };
}

export class DisplayRightPanelRenderer {


  _withPosseMascot(headerLines, width) {
    const laneWidth = Math.max(0, width - POSSE_HEADER_WIDTH - POSSE_HEADER_MASCOT_GAP);
    const mascot = renderPosseMascotFrame({
      tick: this._spinIdx,
      laneWidth,
      colors: C,
    });
    if (!mascot) return headerLines;

    const gap = " ".repeat(POSSE_HEADER_MASCOT_GAP);
    return headerLines.map((line, idx) => `${visiblePad(line, POSSE_HEADER_WIDTH)}${gap}${mascot[idx] || ""}`);
  }



  // ── Right Panel: Header + Event Log ───────────────────────────────────

  _buildRight(width, maxLines) {
    const lines = [];

    // ── Masthead: boxy brand mark + POSSE banner ──
    // Wide panes get the full 3-row banner (with the mascot trotting alongside
    // once there's lane room); _withPosseMascot no-ops the mascot when narrow,
    // so the banner still shows on its own down to ~28 cols.
    if (width >= 28) {
      lines.push(...this._withPosseMascot(posseMastheadRows(), width));
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 44))}${C.reset}`);
    } else if (width >= 20) {
      lines.push(` ${posseWordmark()}`);
      const clock = this._buildRunClockLine(width);
      if (clock) lines.push(clock);
      lines.push(` ${C.dim}${"\u2500".repeat(Math.min(width - 2, 16))}${C.reset}`);
    } else {
      lines.push(` ${posseWordmark()}`);
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



  // ── Monitor Agents View ───────────────────────────────────────────────

  _buildMonitor(width, maxLines) {
    const lines = [];
    const agents = this._collectMonitorAgents();
    const running = agents.filter((agent) => agent.state === "live" || agent.state === "nudge").length;
    const waiting = agents.filter((agent) => agent.state === "ask").length;
    const selected = this._selectMonitorAgent(agents);

    // Heartbeat: the pulse breathes off the render tick (proof the UI loop is
    // alive); the clock is global data-freshness \u2014 seconds since the newest event
    // of any agent. Fresh reads green "live", stale reads dim "quiet".
    const now = Date.now();
    const globalLast = agents.reduce((m, a) => Math.max(m, a.lastActivityAt || 0), 0);
    const fresh = globalLast > 0 && (now - globalLast) < 6000;
    const heartbeat = `${fresh ? C.green : C.dim}${monitorPulse(this._spinIdx)} ${fresh ? "live" : "quiet"}${C.reset}${C.dim} \u00b7 ${globalLast ? fmtAgo(now - globalLast) : "--"}${C.reset}`;
    const openSlots = Math.max(0, (this.concurrency || 0) - (this.workers?.size || 0));
    const blockedByLock = Math.min(this._blockedByLock || 0, openSlots);

    const status = [
      heartbeat,
      `${C.brightWhite}${String(running).padStart(2, "0")}${C.reset}${C.dim} running${C.reset}`,
      waiting > 0
        ? `${C.red}${C.bold}${String(waiting).padStart(2, "0")} waiting on you${C.reset}`
        : `${C.dim}00 waiting on you${C.reset}`,
      ...(blockedByLock > 0 ? [`${C.yellow}${String(blockedByLock).padStart(2, "0")} on lock${C.reset}`] : []),
      `${C.dim}${Math.max(0, openSlots - blockedByLock)} idle${C.reset}`,
    ].join(` ${C.dim}\u00b7${C.reset} `);

    const mastheadLeft = ` ${posseWordmark()} ${C.dim}/${C.reset} ${C.brightWhite}${C.bold}monitor agents${C.reset} ${C.dim}[operator console]${C.reset}`;
    lines.push(`${visiblePad(mastheadLeft, Math.max(20, width - stripAnsi(status).length - 1))}${status}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`);

    if (agents.length === 0) {
      lines.push("");
      lines.push(` ${C.dim}No live agents right now.${C.reset}`);
      lines.push(` ${C.dim}Monitor Agents will show running workers, questions, nudges, and tool history here.${C.reset}`);
      return lines.slice(0, maxLines);
    }

    const leftW = clamp(Math.floor(width * 0.34), 28, Math.min(42, width - 32));
    const rightW = Math.max(20, width - leftW - 1);
    const divider = `${C.dim}\u2502${C.reset}`;
    const leftHead = ` ${C.dim}FLEET${C.reset}${" ".repeat(Math.max(1, leftW - 19))}${C.dim}< > cycle${C.reset}`;
    const rightHead = selected
      ? ` ${C.brightWhite}${C.bold}[${selected.index}] ${selected.role} #${selected.jobId}${C.reset}${C.dim} \u00b7 ${selected.wiLabel} \u00b7 attempt ${selected.attempt}${C.reset}`
      : "";
    lines.push(`${visiblePad(leftHead, leftW)}${divider}${fit(rightHead, rightW)}`);
    lines.push(`${C.dim}${"\u2500".repeat(leftW)}\u253c${"\u2500".repeat(rightW)}${C.reset}`);

    const bodyRows = Math.max(0, maxLines - lines.length - 1);
    // Both columns fill the whole body height (the fleet rail tails into a live
    // event feed, the focus pane pads its own boxes), so neither side leaves a
    // trailing whitespace gap below its content.
    const fleetLines = this._buildMonitorFleetLines(agents, selected, leftW, bodyRows);
    const focusLines = selected ? this._buildMonitorFocusLines(selected, rightW, bodyRows) : [];
    const rows = Math.min(bodyRows, Math.max(fleetLines.length, focusLines.length));
    for (let idx = 0; idx < rows; idx++) {
      lines.push(`${visiblePad(fleetLines[idx] || "", leftW)}${divider}${fit(focusLines[idx] || "", rightW)}`);
    }

    while (lines.length < maxLines - 1) {
      lines.push(`${" ".repeat(leftW)}${divider}`);
    }
    // The single agent-controls bar lives UNDER the focus pane (right column):
    // every control here acts on the selected agent shown to the right, so the
    // fleet rail + usage column on the left stays uncluttered. The column divider
    // runs straight down into the bar. (state-aware actions · fleet navigation)
    const nav = `${C.dim}[1-${Math.min(agents.length, 9)}] jump  [< >] cycle  [m] log${C.reset}`;
    let actions;
    if (selected?.state === "ask") {
      actions = `${C.green}[a] answer${C.reset}  ${C.yellow}[n] nudge${C.reset}  ${C.red}[!] interrupt${C.reset}`;
    } else if (selected) {
      actions = `${C.yellow}[n] nudge${C.reset}  ${C.magenta}[d] changes${C.reset}`;
    } else {
      actions = `${C.dim}no agent selected${C.reset}`;
    }
    const controls = `${actions}  ${C.dim}·${C.reset}  ${nav}`;
    lines.push(`${" ".repeat(leftW)}${divider}${fit(` ${controls}`, rightW)}`);
    return lines.slice(0, maxLines);
  }



  _collectMonitorAgents() {
    const queueData = this._getQueueData?.({ maxAgeMs: 1000 }) || {};
    const jobsById = new Map((queueData.jobs || []).map((job) => [Number(job.id), job]));
    const questionJobIds = new Set((this._questionQueue || []).map((q) => Number(q.jobId)).filter(Number.isFinite));
    // Pull tool observations once and bucket the newest non-coordination call
    // per job so each agent's "thinking vs tool call" state is one cheap lookup.
    let toolRecent = [];
    try { toolRecent = (typeof this.getToolData === "function" ? this.getToolData()?.recent : null) || []; } catch { toolRecent = []; }
    const liveness = (numericJobId, activityRows, interactionRows, fallbackTs) => {
      const jobToolRows = toolRecent.filter((row) => Number(row.job_id) === numericJobId
        && !LIVE_CHANNEL_TOOL_TYPES.has(String(row.observation_type || "")));
      const latestToolTs = latestStamp(jobToolRows);
      const latestTalkTs = Math.max(latestStamp(activityRows), latestStamp(interactionRows));
      const lastEventKind = latestToolTs > 0 && latestToolTs >= latestTalkTs ? "tool" : "activity";
      return {
        lastActivityAt: Math.max(latestToolTs, latestTalkTs, fallbackTs || 0),
        lastEventKind,
      };
    };
    const agents = [...this.workers.entries()].map(([jobId, worker], idx) => {
      const numericJobId = Number(jobId);
      const job = jobsById.get(numericJobId) || {};
      let guidance = [];
      let interactionRows = [];
      let activityRows = [];
      try {
        guidance = listActiveAgentGuidanceForJob(numericJobId, { limit: 3 });
      } catch {
        guidance = [];
      }
      try {
        interactionRows = listAgentInteractions({ job_id: numericJobId, limit: 14 });
        activityRows = interactionRows
          .filter((row) => row.direction === "agent_to_user" && row.kind === "activity");
      } catch {
        interactionRows = [];
        activityRows = [];
      }
      // Pending = not yet acknowledged by an attempt. Acknowledged guidance is
      // still durable (shown in the focus pane), but it must not keep the fleet
      // rail stuck on "nudge" forever after the agent has already consumed it.
      const pendingGuidance = guidance.filter((row) => row.ack_state !== "acknowledged");
      const state = questionJobIds.has(numericJobId) ? "ask" : (pendingGuidance.length > 0 ? "nudge" : "live");
      const activity = _sanitizeDisplayLine(activityRows[0]?.body || worker?.activity || job.title || worker?.role || "running");
      return {
        index: idx + 1,
        jobId: numericJobId,
        workItemId: worker?.workItemId ?? job.work_item_id ?? null,
        wiLabel: (worker?.workItemId ?? job.work_item_id) ? `WI#${worker?.workItemId ?? job.work_item_id}` : "WI?",
        role: roleLabel(worker?.role || job.job_type || "agent"),
        state,
        activity,
        attempt: worker?.attempt || 1,
        provider: worker?.provider || null,
        modelName: worker?.modelName || null,
        tier: worker?.tier || job.model_tier || "standard",
        effort: worker?.effort || "medium",
        elapsed: formatElapsed(worker?.startTime),
        interactionRows,
        activityRows,
        guidance,
        pendingGuidance,
        status: job.status || "running",
        ...liveness(numericJobId, activityRows, interactionRows, worker?.startTime),
      };
    });
    const seen = new Set(agents.map((agent) => agent.jobId));
    for (const job of queueData.jobs || []) {
      const numericJobId = Number(job.id);
      if (!Number.isFinite(numericJobId) || seen.has(numericJobId)) continue;
      const status = String(job.status || "").toLowerCase();
      const isHumanWait = status === "waiting_on_human"
        || (job.job_type === "human_input" && status !== "succeeded" && status !== "canceled");
      if (!isHumanWait) continue;
      let guidance = [];
      let interactionRows = [];
      try {
        guidance = listActiveAgentGuidanceForJob(numericJobId, { limit: 3 });
        interactionRows = listAgentInteractions({ job_id: numericJobId, limit: 14 });
      } catch {
        guidance = [];
        interactionRows = [];
      }
      agents.push({
        index: agents.length + 1,
        jobId: numericJobId,
        workItemId: job.work_item_id ?? null,
        wiLabel: job.work_item_id ? `WI#${job.work_item_id}` : "WI?",
        role: roleLabel(job.job_type || "human"),
        state: "ask",
        activity: _sanitizeDisplayLine(job.title || "waiting on human input"),
        attempt: job.attempt_count || 1,
        provider: null,
        modelName: null,
        tier: job.model_tier || "standard",
        effort: job.reasoning_effort || "medium",
        elapsed: formatElapsed(Date.parse(job.updated_at || job.created_at || "") || Date.now()),
        interactionRows,
        activityRows: [],
        guidance,
        pendingGuidance: guidance.filter((row) => row.ack_state !== "acknowledged"),
        status: job.status || "waiting_on_human",
        ...liveness(numericJobId, [], interactionRows, Date.parse(job.updated_at || job.created_at || "") || 0),
      });
      seen.add(numericJobId);
    }
    agents.forEach((agent, idx) => { agent.index = idx + 1; });
    return agents;
  }



  _selectMonitorAgent(agents) {
    if (!Array.isArray(agents) || agents.length === 0) {
      this._monitorSelectedJobId = null;
      return null;
    }
    let selected = agents.find((agent) => agent.jobId === this._monitorSelectedJobId);
    if (!selected) {
      selected = agents[0];
      this._monitorSelectedJobId = selected.jobId;
    }
    return selected;
  }



  _buildMonitorFleetLines(agents, selected, width, height = 0) {
    const lines = [];
    const spin = this._spinIdx | 0;
    const shown = agents.slice(0, 9);

    // Group occupied slots by work item so the rail reads "what is working on
    // what": one WI header, then its agents, then the next WI.
    const groups = new Map();
    for (const agent of shown) {
      const key = agent.workItemId == null ? "_none" : String(agent.workItemId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
    let firstGroup = true;
    for (const [key, groupAgents] of groups) {
      if (!firstGroup) lines.push("");
      firstGroup = false;
      // Just the WI id \u2014 the title only gets cut off at this width.
      lines.push(key === "_none"
        ? ` ${C.dim}\u00b7 no work item${C.reset}`
        : ` ${C.blue}${C.bold}WI#${key}${C.reset}`);
      for (const agent of groupAgents) {
        const meta = monitorActivityState(agent, spin);
        const isSelected = selected?.jobId === agent.jobId;
        const selector = isSelected ? `${C.cyan}\u258c${C.reset}` : " ";
        const rail = `${monitorStateMeta(agent.state).rail}\u2503${C.reset}`;
        const title = `${selector}${rail} ${C.brightWhite}${C.bold}[${agent.index}] ${agent.role}${C.reset} ${C.dim}#${agent.jobId}${C.reset}`;
        const tag = `${meta.color}${meta.glyph} ${meta.label}${C.reset}`;
        lines.push(`${visiblePad(title, Math.max(0, width - stripAnsi(tag).length - 1))}${tag}`);
        lines.push(`   ${C.dim}${fit(agent.activity, Math.max(8, width - 5))}${C.reset}`);
        if (agent.pendingGuidance?.length > 0) {
          lines.push(`   ${C.yellow}${fit(`nudge queued: ${agent.pendingGuidance[0].body || ""}`, Math.max(8, width - 5))}${C.reset}`);
        }
      }
    }

    // Open slots \u2014 surfaced like the main queue panel: file-lock-blocked first
    // (yellow, same lock-summary labels), then truly-idle/available slots.
    const openSlots = Math.max(0, (this.concurrency || 0) - (this.workers?.size || 0));
    const blockedByLock = Math.min(this._blockedByLock || 0, openSlots);
    const trulyIdle = openSlots - blockedByLock;
    if (blockedByLock > 0 || trulyIdle > 0) {
      if (lines.length > 0) lines.push("");
      if (blockedByLock > 0) {
        const labels = this._blockedLockSummaryLabels(blockedByLock);
        lines.push(`  ${C.yellow}\u00b7 ${fit(labels.join(", "), Math.max(8, width - 4))}${C.reset}`);
      }
      if (trulyIdle > 0) {
        lines.push(`  ${C.dim}\u00b7 ${trulyIdle} idle slot${trulyIdle === 1 ? "" : "s"} available${C.reset}`);
      }
    }
    // Provider usage widget tucked against the bottom of the rail — the same
    // widget the main queue page shows (run tokens/cost + session/week pressure
    // gauges). The fleet rail intentionally does NOT mirror the event log here.
    let usageLines = [];
    try {
      const cache = getProviderUsageSummaryCache();
      const activeProviders = new Set(
        [...this.workers.values()].map((w) => String(w?.provider || "").trim().toLowerCase()).filter(Boolean),
      );
      const usageBudget = Math.max(0, (height || 0) - lines.length);
      if (usageBudget >= 4) {
        usageLines = _buildQueueProviderUsageLines(width, usageBudget, cache.summaries || [], {
          activeProviders,
          currentRunProviderUsage: cache.currentRunProviderUsage || [],
          runStartedAtIso: this._runStartedAtIso,
        });
      }
    } catch { usageLines = []; }

    // Usage pinned FLUSH to the bottom of the rail: pad with blank lines above so
    // the block rests at the foot of the pane instead of floating mid-rail.
    if (usageLines.length > 0) {
      const pad = Math.max(0, (height || 0) - lines.length - usageLines.length);
      for (let i = 0; i < pad; i++) lines.push("");
      lines.push(...usageLines);
    }
    while (lines.length < (height || 0)) lines.push("");
    return lines;
  }



  _monitorToolActivityForJob(jobId, { limit = 8 } = {}) {
    let data = null;
    try { data = typeof this.getToolData === "function" ? this.getToolData() : null; } catch { data = null; }
    const recent = Array.isArray(data?.recent) ? data.recent : [];
    const allRows = recent
      .filter((row) => Number(row.job_id) === Number(jobId));
    return {
      toolRows: allRows
        .filter((row) => !LIVE_CHANNEL_TOOL_TYPES.has(String(row.observation_type || "")))
        .slice(0, Math.max(1, limit)),
      feedbackToolRows: allRows
        .filter((row) => LIVE_CHANNEL_TOOL_TYPES.has(String(row.observation_type || "")))
        .slice(0, Math.max(1, limit)),
    };
  }



  _monitorFeedbackEntries(agent, feedbackToolRows = [], { limit = 8 } = {}) {
    const rows = [];
    const seen = new Set();
    const addInteraction = (row) => {
      if (!row) return;
      const key = row.id != null ? `i:${row.id}` : `i:${row.created_at || ""}:${row.kind || ""}:${row.body || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };

    for (const row of agent.interactionRows || []) addInteraction(row);
    for (const row of agent.guidance || []) addInteraction(row);
    for (const row of agent.activityRows || []) addInteraction(row);
    // Intentionally NOT surfacing the live-channel tool observations
    // (feedbackToolRows: get/ack/status markers). The feedback panel shows the
    // agent's own update text and operator messages — not the mechanical
    // "status change" coordination markers, which only added noise.
    void feedbackToolRows;

    rows.sort((a, b) => (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0));
    return rows.slice(-Math.max(1, limit));
  }



  _monitorBoxLine(content, width) {
    const safeWidth = Math.max(18, width | 0);
    return `${C.dim}\u2502${C.reset}${visiblePad(content, safeWidth - 2)}${C.dim}\u2502${C.reset}`;
  }



  _monitorBoxedLane({ title, count = 0, color = C.cyan, width, rows = [], emptyText = "waiting", fixedRows = null } = {}) {
    const safeWidth = Math.max(18, width | 0);
    const inner = Math.max(8, safeWidth - 2);
    const lines = [
      `${C.dim}\u256d${"\u2500".repeat(inner)}\u256e${C.reset}`,
      this._monitorBoxLine(` ${color}${C.bold}${String(title || "").toUpperCase()}${C.reset} ${C.dim}${String(count).padStart(2, "0")}${C.reset}`, safeWidth),
      `${C.dim}\u251c${"\u2500".repeat(inner)}\u2524${C.reset}`,
    ];

    let visibleRows = rows.length > 0 ? rows : [` ${C.dim}\u00b7 ${emptyText}${C.reset}`];
    // fixedRows makes the box a constant height: truncate overflow and pad short
    // content with blank lines so stacked boxes tile the pane with no gap.
    if (Number.isFinite(fixedRows) && fixedRows > 0) {
      visibleRows = visibleRows.slice(0, fixedRows);
      while (visibleRows.length < fixedRows) visibleRows.push("");
    }
    for (const row of visibleRows) {
      lines.push(this._monitorBoxLine(row, safeWidth));
    }
    lines.push(`${C.dim}\u2570${"\u2500".repeat(inner)}\u256f${C.reset}`);
    return lines;
  }



  _formatMonitorFeedbackRow(row, width) {
    const safeWidth = Math.max(18, width | 0);
    const meta = monitorFeedbackMeta(row);
    const suffix = monitorFeedbackSuffix(row);
    const time = compactTime(row.created_at);
    const body = _sanitizeDisplayLine(row.body || row.summary || "");
    const prefix = ` ${C.dim}${time}${C.reset} ${meta.color}${meta.glyph}${C.reset} ${meta.color}${meta.label}${C.reset} `;
    const suffixText = suffix ? ` ${suffix}` : "";
    const suffixLen = suffix ? stripAnsi(suffixText).length : 0;
    const budget = Math.max(8, safeWidth - stripAnsi(prefix).length - suffixLen - 3);
    return `${prefix}${fit(body, budget)}${suffixText}`;
  }



  _formatMonitorToolRow(row, width) {
    const safeWidth = Math.max(18, width | 0);
    const meta = monitorToolMeta(row);
    const { module, command, info } = monitorToolRowParts(row);
    const inFlight = !!row.in_flight;
    // Glyph pulses (● ○, cyan) while a call is in flight (a "started" row with no
    // finish yet); once it completes it settles to the done/failed meta glyph.
    const glyph = inFlight ? monitorPulse(this._spinIdx | 0) : meta.glyph;
    const glyphColor = inFlight ? C.cyan : meta.color;
    // In-flight rows read as "running"; completed ones show their measured
    // duration (both come from the start/finish pair collapsed upstream).
    const status = inFlight
      ? `${C.cyan}running${C.reset}`
      : (Number.isFinite(row.duration_ms) ? `${C.dim}${fmtDur(row.duration_ms)}${C.reset}` : "");
    // No timestamp: glyph → module → command → info, status pinned at the end.
    const moduleColor = module === "atlas" ? C.magenta : C.blue;
    const commandText = command ? `${C.cyan}${command}${C.reset} ` : "";
    const prefix = ` ${glyphColor}${glyph}${C.reset} ${moduleColor}${module}${C.reset} ${commandText}`;
    const statusLen = status ? stripAnsi(status).length + 1 : 0;
    const budget = Math.max(8, safeWidth - stripAnsi(prefix).length - statusLen - 3);
    const body = command ? info : (info || meta.label);
    return `${prefix}${fit(body, budget)}${status ? ` ${status}` : ""}`;
  }



  _buildMonitorFeedbackToolLanes(agent, width, height) {
    const toolActivity = this._monitorToolActivityForJob(agent.jobId, { limit: 60 });
    const feedbackEntries = this._monitorFeedbackEntries(agent, toolActivity.feedbackToolRows, { limit: 60 });
    const toolRows = [...toolActivity.toolRows]
      .sort((a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0));

    // Two full-width boxes stacked to tile the pane: FEEDBACK on top (the larger
    // share) and TOOLS below. Box chrome is 4 lines (top, title, mid, bottom), so
    // content rows = boxHeight - 4. They are sized to exactly fill `height`.
    const total = Math.max(5, height | 0);
    const inner = Math.max(8, width - 4);

    // An open file diff takes the whole focus pane for maximum room.
    if (this._monitorChangesMode && this._monitorDiffOpen) {
      return this._buildMonitorChangesBox(agent, width, total);
    }

    // Feedback reads like a chat: the live (newest) message is pinned to the
    // FLOOR of the box, older history stacks above it (dimmed, so it reads as
    // back-scroll), and a thin delimiter rule separates the live turn from the
    // history. Overflow clips the OLDEST lines from the top; a short conversation
    // pads the top so it still rests on the floor.
    const buildFeedback = (content) => {
      const boxedFeedback = (rows) => this._monitorBoxedLane({
        title: "feedback",
        count: feedbackEntries.length,
        color: C.yellow,
        width,
        rows,
        emptyText: `no updates yet \u2014 current: ${agent.activity}`,
        fixedRows: content,
      });
      if (feedbackEntries.length === 0) return boxedFeedback([]);

      const ordered = feedbackEntries; // oldest \u2192 newest
      const active = ordered[ordered.length - 1];
      const history = ordered.slice(0, -1);

      const historyLines = [];
      for (const row of history) {
        for (const line of this._monitorFeedbackEntryLines(row, inner, { dim: true })) {
          historyLines.push(line);
        }
        historyLines.push(""); // blank gap between historical messages
      }
      const activeLines = this._monitorFeedbackEntryLines(active, inner);

      let rows;
      if (history.length > 0) {
        const rule = ` ${C.dim}${"\u254c".repeat(Math.max(3, inner - 1))}${C.reset}`;
        rows = [...historyLines, rule, ...activeLines];
      } else {
        rows = activeLines;
      }
      // Anchor to the bottom: drop oldest lines from the top, pad short content
      // at the top so the live message always lands on the floor.
      if (rows.length > content) rows = rows.slice(rows.length - content);
      while (rows.length < content) rows.unshift("");
      return boxedFeedback(rows);
    };

    // A short pane only has room for one box.
    if (total < 11) {
      if (this._monitorChangesMode) return this._buildMonitorChangesBox(agent, width, total);
      return buildFeedback(Math.max(1, total - 4));
    }

    let feedbackBoxH = Math.max(6, Math.round(total * 0.58));
    let toolBoxH = total - feedbackBoxH;
    if (toolBoxH < 5) { toolBoxH = 5; feedbackBoxH = total - toolBoxH; }
    const feedbackContent = Math.max(1, feedbackBoxH - 4);
    const toolContent = Math.max(1, toolBoxH - 4);

    // Bottom box: tool calls by default, or the CHANGES (git-diff) view when the
    // operator pressed [d]. Tools: newest-first, one full-width line each.
    const bottomBox = this._monitorChangesMode
      ? this._buildMonitorChangesBox(agent, width, toolBoxH)
      : this._monitorBoxedLane({
        title: "tools",
        count: toolRows.length,
        color: C.cyan,
        width,
        rows: toolRows.slice(0, toolContent).map((row) => this._formatMonitorToolRow(row, width)),
        emptyText: "no tool calls yet",
        fixedRows: toolContent,
      });

    return [...buildFeedback(feedbackContent), ...bottomBox];
  }

  _monitorFeedbackEntryLines(row, inner, { dim = false } = {}) {
    const meta = monitorFeedbackMeta(row);
    const suffix = monitorFeedbackSuffix(row);
    const time = compactTime(row.created_at);
    const body = _sanitizeDisplayLine(row.body || row.summary || "");
    const bodyWidth = Math.max(8, inner - 3);
    // History (back-scroll) messages render fully dimmed — sender, rail and body
    // — so only the live message at the floor of the box reads as active. The
    // suffix chips (acked/pending, etc.) are flattened to dim too (their own
    // colour stripped) so nothing in a past turn competes with the live one.
    if (dim) {
      const suffixText = suffix ? `  ${stripAnsi(suffix)}` : "";
      const lines = [` ${C.dim}${meta.glyph} ${meta.label}  ${time}${suffixText}${C.reset}`];
      for (const chunk of wrapHanging(body, bodyWidth, bodyWidth)) {
        lines.push(` ${C.dim}▏ ${chunk}${C.reset}`);
      }
      return lines;
    }
    const suffixText = suffix ? `  ${suffix}` : "";
    // Render each update as a message: a colored sender/time header, then the
    // body wrapped under a thin accent rail in the same colour (NOT dim, so the
    // wrapped continuation reads as part of the message, not faded log noise).
    const lines = [` ${meta.color}${meta.glyph} ${meta.label}${C.reset}  ${C.dim}${time}${C.reset}${suffixText}`];
    for (const chunk of wrapHanging(body, bodyWidth, bodyWidth)) {
      lines.push(` ${meta.color}▏${C.reset} ${chunk}`);
    }
    return lines;
  }



  // ── Changes / git-diff view (toggled with [d] on the selected agent) ──
  _monitorDiffFilesForAgent(agent) {
    const wiId = agent?.workItemId;
    if (wiId == null) return { files: [], loading: false };
    const fresh = this._monitorDiffSnapshotCache && this._monitorDiffSnapshotWi === wiId
      && (Date.now() - (this._monitorDiffSnapshotAt || 0)) < 3000;
    if (!fresh && !this._monitorDiffSnapshotBuilding) {
      this._monitorDiffSnapshotBuilding = true;
      const projectDir = this.projectDir || process.cwd();
      Promise.resolve()
        .then(() => {
          const wi = (listWorkItems() || []).find((w) => Number(w.id) === Number(wiId));
          return wi ? buildAdminGitDiffSnapshot({ projectDir, workItems: [wi], limit: 1 }) : { files: [] };
        })
        .then((snapshot) => { this._monitorDiffSnapshotCache = snapshot; this._monitorDiffSnapshotWi = wiId; this._monitorDiffSnapshotAt = Date.now(); })
        .catch((err) => { this._monitorDiffSnapshotCache = { files: [], error: err?.message || String(err) }; this._monitorDiffSnapshotWi = wiId; this._monitorDiffSnapshotAt = Date.now(); })
        .finally(() => { this._monitorDiffSnapshotBuilding = false; try { this.requestRender?.({ force: true }); } catch { /* best effort */ } });
    }
    if (this._monitorDiffSnapshotCache && this._monitorDiffSnapshotWi === wiId) {
      return { files: this._monitorDiffSnapshotCache.files || [], error: this._monitorDiffSnapshotCache.error };
    }
    return { files: [], loading: true };
  }

  _monitorDiffDetailForFile(file) {
    if (!file) return { lines: ["No file selected."] };
    const key = `${file.wiId}:${file.key || file.path}`;
    const fresh = this._monitorDiffDetailCache && this._monitorDiffDetailKey === key
      && (Date.now() - (this._monitorDiffDetailAt || 0)) < 3000;
    if (!fresh && this._monitorDiffDetailBuilding !== key) {
      this._monitorDiffDetailBuilding = key;
      const projectDir = this.projectDir || process.cwd();
      Promise.resolve()
        .then(() => buildAdminGitDiffFileDetail({ projectDir, file }))
        .then((detail) => { this._monitorDiffDetailCache = detail; this._monitorDiffDetailKey = key; this._monitorDiffDetailAt = Date.now(); })
        .catch((err) => { this._monitorDiffDetailCache = { lines: [`Diff load failed: ${err?.message || err}`] }; this._monitorDiffDetailKey = key; this._monitorDiffDetailAt = Date.now(); })
        .finally(() => { this._monitorDiffDetailBuilding = null; try { this.requestRender?.({ force: true }); } catch { /* best effort */ } });
    }
    if (this._monitorDiffDetailCache && this._monitorDiffDetailKey === key) return this._monitorDiffDetailCache;
    return { lines: ["Loading diff…"] };
  }

  // Render raw `git diff` lines with an old/new line-number gutter and the usual
  // red `-` / green `+` / cyan `@@` colouring, deriving line numbers from the
  // hunk headers.
  _monitorDiffBodyLines(lines, inner) {
    const out = [];
    const bodyW = Math.max(8, inner - 7);
    let oldNo = 0;
    let newNo = 0;
    // Track whether we are inside a hunk. The ---/+++ file headers (and the
    // diff/index/section preamble) only appear BEFORE the first @@ of a file;
    // once a hunk starts, every +/- line is diff CONTENT — including code lines
    // that legitimately begin with ++ or -- (`--count;`, a `-- sql comment`),
    // which a naive prefix test would misclassify as the ---/+++ headers and
    // mis-paint while drifting the gutter line numbers for the rest of the file.
    let inHunk = false;
    for (const raw of (lines || [])) {
      const text = String(raw ?? "");
      if (text.startsWith("@@")) {
        const m = text.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
        inHunk = true;
        out.push(`${C.dim}  ···${C.reset} ${C.cyan}${fit(text, bodyW)}${C.reset}`);
        continue;
      }
      // A new file's "diff --git" / "# SECTION" title closes the previous hunk so
      // its header block is recognised as a header again.
      if (text.startsWith("diff --git") || text.startsWith("# ")) inHunk = false;
      const isHeader = !inHunk && (
        text.startsWith("diff --git") || text.startsWith("index ")
        || text.startsWith("+++") || text.startsWith("---")
        || text.startsWith("# ") || text.startsWith("new file")
        || text.startsWith("deleted file") || text.startsWith("rename ")
        || text.startsWith("similarity ") || text.startsWith("Binary files")
      );
      if (isHeader) {
        out.push(`      ${C.dim}${fit(text, bodyW)}${C.reset}`);
      } else if (text.startsWith("+")) {
        out.push(`${C.green}${String(newNo++).padStart(5)}${C.reset} ${C.green}${fit(text, bodyW)}${C.reset}`);
      } else if (text.startsWith("-")) {
        out.push(`${C.red}${String(oldNo++).padStart(5)}${C.reset} ${C.red}${fit(text, bodyW)}${C.reset}`);
      } else {
        out.push(`${C.dim}${String(newNo++).padStart(5)}${C.reset} ${fit(text, bodyW)}`);
        oldNo++;
      }
    }
    return out;
  }

  _buildMonitorChangesBox(agent, width, height) {
    const content = Math.max(1, (height | 0) - 4);
    const inner = Math.max(8, width - 4);
    const snap = this._monitorDiffFilesForAgent(agent);
    const files = snap.files || [];
    this._monitorDiffFileIndex = files.length ? Math.max(0, Math.min(this._monitorDiffFileIndex || 0, files.length - 1)) : 0;

    if (!this._monitorDiffOpen) {
      const rows = [];
      if (snap.loading) rows.push(` ${C.dim}· loading changes…${C.reset}`);
      else if (snap.error) rows.push(` ${C.red}· ${fit(snap.error, inner - 3)}${C.reset}`);
      else if (files.length === 0) rows.push(` ${C.dim}· no file changes yet${C.reset}`);
      else {
        const start = Math.max(0, Math.min(this._monitorDiffFileIndex - Math.floor(content / 2), Math.max(0, files.length - content)));
        for (let i = start; i < files.length && rows.length < content; i++) {
          const f = files[i];
          const sel = i === this._monitorDiffFileIndex;
          const counts = `${C.green}+${f.additions || 0}${C.reset} ${C.red}-${f.deletions || 0}${C.reset}`;
          const pathTxt = fit(f.path || "?", Math.max(8, inner - 16));
          const marker = sel ? `${C.cyan}▸${C.reset}` : " ";
          const name = sel ? `${C.brightWhite}${pathTxt}${C.reset}` : pathTxt;
          rows.push(`${marker} ${name}  ${counts}`);
        }
      }
      return this._monitorBoxedLane({
        title: files.length ? `changes ${this._monitorDiffFileIndex + 1}/${files.length}  [↑↓ select · enter open]` : "changes",
        count: files.length,
        color: C.magenta,
        width,
        rows,
        emptyText: "no changes",
        fixedRows: content,
      });
    }

    const file = files[this._monitorDiffFileIndex] || null;
    const detail = this._monitorDiffDetailForFile(file);
    const body = this._monitorDiffBodyLines(detail.lines || [], inner);
    const maxScroll = Math.max(0, body.length - content);
    this._monitorDiffScroll = Math.max(0, Math.min(this._monitorDiffScroll || 0, maxScroll));
    const view = body.slice(this._monitorDiffScroll, this._monitorDiffScroll + content);
    const span = maxScroll > 0
      ? ` ${this._monitorDiffScroll + 1}-${Math.min(body.length, this._monitorDiffScroll + content)}/${body.length}`
      : "";
    return this._monitorBoxedLane({
      title: `diff${span}  [↑↓ scroll · esc files]`,
      count: file ? (file.additions || 0) + (file.deletions || 0) : 0,
      color: C.magenta,
      width,
      rows: view,
      emptyText: "empty diff",
      fixedRows: content,
    });
  }

  _buildMonitorFocusLines(agent, width, height = 18) {
    const meta = monitorStateMeta(agent.state);
    const provider = agent.provider
      ? `${agent.provider}${agent.modelName ? `/${agent.modelName}` : ""}`
      : `tier/${agent.tier}`;
    const top = [
      ` ${meta.color}\u25cf${C.reset} ${agent.status}  ${C.dim}${provider}  elapsed ${agent.elapsed}  phase${C.reset} ${C.brightWhite}${fit(agent.activity, Math.max(8, width - 54))}${C.reset}`,
      ` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`,
    ];

    // No control bar here: the single agent-controls bar lives at the foot of the
    // monitor view (state-aware), so the focus pane just caps its content with a
    // thin rule and hands the full height to the feedback/tools boxes.
    const footer = [` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`];

    const bodyH = Math.max(0, height - top.length - footer.length);
    const body = [];
    const lanesH = Math.max(0, bodyH - body.length);
    if (lanesH >= 5) {
      body.push(...this._buildMonitorFeedbackToolLanes(agent, width, lanesH));
    }

    const out = [...top, ...body.slice(0, bodyH), ...footer];
    while (out.length < height) out.push("");
    return out.slice(0, height);
  }



  _monitorRecentEventsForJob(jobId, width) {
    const rows = [];
    const needle = `#${jobId}`;
    const source = (this.events || []).filter((event) => stripAnsi(event.text || "").includes(needle)).slice(-8);
    for (const event of source) {
      const clean = _sanitizeDisplayLine(event.text || "");
      rows.push(` ${C.dim}${event.time || ""}${C.reset}  ${C.dim}\u25e6${C.reset} ${fit(clean, Math.max(8, width - 16))}`);
    }
    return rows;
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
}
