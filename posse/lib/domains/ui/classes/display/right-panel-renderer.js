import { C } from "../../../../shared/format/functions/colors.js";
import { statusIcon as paletteStatusIcon } from "../../functions/display/status-palette.js";
import { fit, stripAnsi, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { roleBrandColor, roleBrandIcon } from "../../functions/display/helpers/brand.js";
import { jobLabel, jobDisplayStatus } from "../../functions/display/helpers/job-status.js";
import { renderPosseMascotFrame } from "../../functions/display/helpers/mascot.js";
import { canonicalAtlasActionName } from "../../../../functions/tools/mcp-surface.js";
import { listActiveAgentGuidanceForJob, listAgentInteractions } from "../../../queue/functions/index.js";
import { readRecentPrompts } from "../../../../shared/telemetry/functions/logging/prompt-log.js";

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



function monitorToolMeta(row = {}) {
  const text = `${row.observation_type || ""} ${row.summary || ""}`.toLowerCase();
  if (/\b(error|failed|fail|denied|cancelled|canceled)\b/.test(text)) return { glyph: "\u2715", color: C.red, label: "err" };
  if (/\b(pass|passed|ok|succeeded|complete)\b/.test(text)) return { glyph: "\u2713", color: C.green, label: "ok" };
  return { glyph: "\u25cf", color: C.cyan, label: "call" };
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

    const status = [
      `${C.brightWhite}${String(running).padStart(2, "0")}${C.reset}${C.dim} running${C.reset}`,
      waiting > 0
        ? `${C.red}${C.bold}${String(waiting).padStart(2, "0")} waiting on you${C.reset}`
        : `${C.dim}00 waiting on you${C.reset}`,
      `${C.dim}${Math.max(0, this.concurrency - this.workers.size)} idle slots${C.reset}`,
    ].join(` ${C.dim}\u00b7${C.reset} `);

    const mastheadLeft = ` ${posseWordmark()} ${C.dim}/${C.reset} ${C.brightWhite}${C.bold}monitor agents${C.reset} ${C.dim}[operator console]${C.reset}`;
    lines.push(`${visiblePad(mastheadLeft, Math.max(20, width - stripAnsi(status).length - 1))}${status}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`);

    if (agents.length === 0) {
      lines.push("");
      lines.push(` ${C.dim}No live agents right now.${C.reset}`);
      lines.push(` ${C.dim}Monitor Agents will show running workers, questions, nudges, prompt lens snapshots, and tool history here.${C.reset}`);
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

    const fleetLines = this._buildMonitorFleetLines(agents, selected, leftW);
    const focusLines = selected ? this._buildMonitorFocusLines(selected, rightW) : [];
    const bodyRows = Math.max(0, maxLines - lines.length - 1);
    const rows = Math.min(bodyRows, Math.max(fleetLines.length, focusLines.length));
    for (let idx = 0; idx < rows; idx++) {
      lines.push(`${visiblePad(fleetLines[idx] || "", leftW)}${divider}${fit(focusLines[idx] || "", rightW)}`);
    }

    while (lines.length < maxLines - 1) {
      lines.push(`${" ".repeat(leftW)}${divider}`);
    }
    const selectedHint = selected ? `selected job #${selected.jobId}` : "no selection";
    lines.push(` ${C.dim}[1-${Math.min(agents.length, 9)}] jump  [< >] cycle  [n] nudge ${selectedHint}  [q/m] log${C.reset}`);
    return lines.slice(0, maxLines);
  }



  _collectMonitorAgents() {
    const queueData = this._getQueueData?.({ maxAgeMs: 1000 }) || {};
    const jobsById = new Map((queueData.jobs || []).map((job) => [Number(job.id), job]));
    const questionJobIds = new Set((this._questionQueue || []).map((q) => Number(q.jobId)).filter(Number.isFinite));
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



  _buildMonitorFleetLines(agents, selected, width) {
    const lines = [];
    for (const agent of agents.slice(0, 9)) {
      const meta = monitorStateMeta(agent.state);
      const isSelected = selected?.jobId === agent.jobId;
      const selector = isSelected ? `${C.cyan}\u258c${C.reset}` : " ";
      const rail = `${meta.rail}\u2503${C.reset}`;
      const title = `${selector}${rail} ${C.brightWhite}${C.bold}[${agent.index}] ${agent.role}${C.reset} ${C.dim}#${agent.jobId} ${agent.wiLabel}${C.reset}`;
      const tag = `${meta.color}${meta.label}${C.reset}`;
      lines.push(`${visiblePad(title, Math.max(0, width - stripAnsi(tag).length - 1))}${tag}`);
      lines.push(`   ${C.dim}${fit(agent.activity, Math.max(8, width - 5))}${C.reset}`);
      if (agent.pendingGuidance?.length > 0) {
        const latest = agent.pendingGuidance[0];
        lines.push(`   ${C.yellow}${fit(`nudge queued: ${latest.body || ""}`, Math.max(8, width - 5))}${C.reset}`);
      } else if (agent.guidance?.length > 0) {
        const latest = agent.guidance[0];
        lines.push(`   ${C.dim}${fit(`guidance active: ${latest.body || ""}`, Math.max(8, width - 5))}${C.reset}`);
      }
      lines.push("");
    }
    lines.push(`${C.dim}live steering on tool results${C.reset}`);
    lines.push(`${C.dim}blocking questions will park here, not die in logs${C.reset}`);
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

    for (const row of feedbackToolRows || []) {
      const tool = stripToolPrefix(row.observation_type);
      const label = tool === "get_operator_feedback"
        ? "retrieved"
        : (tool === "ack_operator_feedback" ? "ack" : "status");
      rows.push({
        _kind: "coordination",
        created_at: row.created_at,
        label,
        body: stripRedundantToolSummaryLabel(tool, row.summary) || tool,
      });
    }

    rows.sort((a, b) => (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0));
    return rows.slice(-Math.max(1, limit));
  }



  _monitorBoxLine(content, width) {
    const safeWidth = Math.max(18, width | 0);
    return `${C.dim}\u2502${C.reset}${visiblePad(content, safeWidth - 2)}${C.dim}\u2502${C.reset}`;
  }



  _monitorBoxedLane({ title, count = 0, color = C.cyan, width, rows = [], emptyText = "waiting" } = {}) {
    const safeWidth = Math.max(18, width | 0);
    const inner = Math.max(8, safeWidth - 2);
    const lines = [
      `${C.dim}\u256d${"\u2500".repeat(inner)}\u256e${C.reset}`,
      this._monitorBoxLine(` ${color}${C.bold}${String(title || "").toUpperCase()}${C.reset} ${C.dim}${String(count).padStart(2, "0")}${C.reset}`, safeWidth),
      `${C.dim}\u251c${"\u2500".repeat(inner)}\u2524${C.reset}`,
    ];

    const visibleRows = rows.length > 0 ? rows : [` ${C.dim}\u00b7 ${emptyText}${C.reset}`];
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
    const tool = stripToolPrefix(row.observation_type);
    const meta = monitorToolMeta(row);
    const summary = _sanitizeDisplayLine(stripRedundantToolSummaryLabel(tool, row.summary));
    const time = compactTime(row.created_at);
    const prefix = ` ${C.dim}${time}${C.reset} ${meta.color}${meta.glyph}${C.reset} ${C.cyan}${tool}${C.reset} `;
    const budget = Math.max(8, safeWidth - stripAnsi(prefix).length - 3);
    return `${prefix}${fit(summary || meta.label, budget)}`;
  }



  _buildMonitorFeedbackToolLanes(agent, width) {
    const toolActivity = this._monitorToolActivityForJob(agent.jobId, { limit: 8 });
    const feedbackEntries = this._monitorFeedbackEntries(agent, toolActivity.feedbackToolRows, { limit: 7 });
    const toolRows = toolActivity.toolRows.slice(0, 7).reverse();
    const feedbackLines = feedbackEntries.map((row) => this._formatMonitorFeedbackRow(row, Math.floor(width / 2) - 2));
    const toolLines = toolRows.map((row) => this._formatMonitorToolRow(row, Math.floor(width / 2) - 2));

    const narrow = width < 72;
    if (narrow) {
      const feedbackBox = this._monitorBoxedLane({
        title: "feedback",
        count: feedbackEntries.length,
        color: C.yellow,
        width,
        rows: feedbackEntries.map((row) => this._formatMonitorFeedbackRow(row, width)),
        emptyText: `current: ${agent.activity}`,
      });
      const toolBox = this._monitorBoxedLane({
        title: "tools",
        count: toolRows.length,
        color: C.cyan,
        width,
        rows: toolRows.map((row) => this._formatMonitorToolRow(row, width)),
        emptyText: "no normal tool calls yet",
      });
      return [...feedbackBox, ...toolBox];
    }

    const gap = `${C.dim}\u2502${C.reset}`;
    const laneWidth = Math.floor((width - 1) / 2);
    const rightWidth = Math.max(18, width - laneWidth - 1);
    const feedbackBox = this._monitorBoxedLane({
      title: "feedback",
      count: feedbackEntries.length,
      color: C.yellow,
      width: laneWidth,
      rows: feedbackLines,
      emptyText: `current: ${agent.activity}`,
    });
    const toolBox = this._monitorBoxedLane({
      title: "tools",
      count: toolRows.length,
      color: C.cyan,
      width: rightWidth,
      rows: toolLines,
      emptyText: "no normal tool calls yet",
    });
    const rows = Math.max(feedbackBox.length, toolBox.length);
    const lines = [];
    for (let idx = 0; idx < rows; idx++) {
      lines.push(`${visiblePad(feedbackBox[idx] || "", laneWidth)}${gap}${fit(toolBox[idx] || "", rightWidth)}`);
    }
    return lines;
  }



  _buildMonitorFocusLines(agent, width) {
    const lines = [];
    const meta = monitorStateMeta(agent.state);
    const provider = agent.provider
      ? `${agent.provider}${agent.modelName ? `/${agent.modelName}` : ""}`
      : `tier/${agent.tier}`;
    lines.push(` ${meta.color}\u25cf${C.reset} ${agent.status}  ${C.dim}${provider}  elapsed ${agent.elapsed}  phase${C.reset} ${C.brightWhite}${fit(agent.activity, Math.max(8, width - 54))}${C.reset}`);
    lines.push(` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`);

    if (this._monitorPromptLens) {
      lines.push(...this._buildMonitorPromptLens(agent, width));
      lines.push("");
    }

    lines.push(...this._buildMonitorFeedbackToolLanes(agent, width));

    const remaining = Math.max(0, width - 2);
    lines.push("");
    lines.push(` ${C.dim}${"\u2500".repeat(Math.max(8, remaining))}${C.reset}`);
    if (agent.state === "ask") {
      lines.push(` ${C.red}${C.bold}ASK${C.reset} ${C.dim}answer is blocking; this job should be exempt from stall/lease reaping${C.reset}`);
      lines.push(` ${C.green}[a] answer${C.reset}  ${C.yellow}[n] nudge${C.reset}  ${C.blue}[t] prompt lens${C.reset}  ${C.red}[!] interrupt + requeue${C.reset}`);
    } else {
      lines.push(` ${C.cyan}${C.bold}suggestion${C.reset} ${C.dim}| correction | scope-request | status-request${C.reset}`);
      lines.push(` ${C.yellow}[n] nudge selected agent${C.reset}  ${C.blue}[t] prompt lens${C.reset}  ${C.dim}delivery: next safe checkpoint/tool result${C.reset}`);
    }
    return lines;
  }



  _buildMonitorPromptLens(agent, width) {
    const lines = [];
    let prompt = null;
    try {
      prompt = readRecentPrompts({ limit: 1, jobId: agent.jobId })[0] || null;
    } catch {
      prompt = null;
    }
    lines.push(` ${C.blue}${C.bold}prompt lens${C.reset} ${C.dim}read-only latest captured prompt${C.reset}`);
    if (!prompt) {
      lines.push(`   ${C.dim}No prompt captured yet for job #${agent.jobId}.${C.reset}`);
      return lines;
    }
    const stamp = [prompt.role, prompt.provider, prompt.model].filter(Boolean).join("/");
    lines.push(`   ${C.dim}${stamp || "agent"} · ${prompt.prompt_chars || 0} chars · ${prompt.ts || ""}${C.reset}`);
    const promptLines = String(prompt.prompt || "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .slice(0, 9);
    for (const line of promptLines) {
      lines.push(`   ${C.dim}${fit(line, Math.max(8, width - 5))}${C.reset}`);
    }
    const total = String(prompt.prompt || "").split("\n").filter((line) => line.trim() !== "").length;
    if (total > promptLines.length) {
      lines.push(`   ${C.dim}+${total - promptLines.length} more prompt lines in prompt log${C.reset}`);
    }
    return lines;
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
