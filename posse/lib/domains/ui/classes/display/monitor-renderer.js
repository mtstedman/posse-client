import { C } from "../../../../shared/format/functions/colors.js";
import { appendResearchChildMonitorRows } from "../../functions/display/helpers/research-children.js";
import { renderPosseMascotFrame } from "../../functions/display/helpers/mascot.js";
import { fit, stripAnsi, visiblePad, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { posseWordmark, roleBrandColor } from "../../functions/display/helpers/brand.js";
import { jobLabel, jobIsBackgroundAtlasWarm } from "../../functions/display/helpers/job-status.js";
import { BRIDGE_OPEN_GATE_STATUSES } from "../../../../catalog/bridge.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import { humanGateStateAllowsAnswer } from "../../../../catalog/human-input.js";
import { getAgentActivityEvents, getHumanGate, listActiveAgentGuidanceForJob, listAgentInteractions, listWorkItems } from "../../../queue/functions/index.js";
import { buildAdminGitDiffSnapshot, buildAdminGitDiffFileDetail } from "../../functions/admin/git-diff-review.js";
import { buildGateReviewDiff } from "../../functions/admin/gate-review-diff.js";
import {
  formatElapsed, compactTime, roleLabel, monitorStateMeta, monitorWiStateChip,
  monitorPulse, fmtAgo, fmtDur, latestStamp, mergeMonitorAgentActivityEvents,
  monitorActivityState, monitorFeedbackMeta, monitorFeedbackSuffix,
} from "../../functions/display/monitor-presentation.js";
import { monitorToolMeta, monitorToolRowParts } from "../../functions/display/tool-observation-presentation.js";
// Focus-pane mascot uses saddle tan to stay distinct from the brand marks.
const MASCOT_FG = "\x1b[38;2;201;148;92m";
const LIVE_CHANNEL_TOOL_TYPES = new Set([
  "tool.agent_feedback",
  "tool.get_operator_feedback",
  "tool.ack_operator_feedback",
]);

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const MONITOR_ACTIVE_JOB_STATUSES = new Set(["leased", "running", "awaiting_assessment"]);
const MONITOR_HUMAN_GATE_STATUSES = new Set(BRIDGE_OPEN_GATE_STATUSES);
const MONITOR_TERMINAL_JOB_STATUSES = new Set(TERMINAL_JOB_STATUSES);
function monitorHumanGateIsOpen(job) {
  if (job?.job_type !== "human_input") return false;
  try {
    const contract = getHumanGate(job.id);
    return humanGateStateAllowsAnswer(contract?.gate_state);
  } catch {
    // Rendering must stay available during DB churn, but an unverifiable gate
    // must not present an answer control that may mutate stale work.
    return false;
  }
}



// ── Verdict-gate diff helpers (for _buildGateReviewDiffPane) ──
// The change a gate judges does not move while it waits (a committed attempt,
// a parked work-item branch), so it is built once per prompt, like the
// approval Changes tab, and paged as one scrolling document; a failed build is
// retried after a few seconds.
function gateReviewDiffLines(display, q, inner) {
  const cache = display._gateReviewDiffCache;
  const cached = cache?.questionId === q.id ? cache : null;
  const stale = !cached || (cached.failed && Date.now() - cached.at > 5000);
  if (stale && display._gateReviewDiffBuilding !== q.id) {
    display._gateReviewDiffBuilding = q.id;
    const projectDir = display.projectDir || process.cwd();
    Promise.resolve()
      .then(() => buildGateReviewDiff({ projectDir, target: q.reviewDiff }))
      .then((diff) => { display._gateReviewDiffCache = { questionId: q.id, diff, failed: false, at: Date.now() }; })
      .catch((err) => {
        display._gateReviewDiffCache = {
          questionId: q.id,
          diff: { title: "", unavailable: `diff load failed: ${err?.message || err}`, errors: [], files: [] },
          failed: true,
          at: Date.now(),
        };
      })
      .finally(() => {
        if (display._gateReviewDiffBuilding === q.id) display._gateReviewDiffBuilding = null;
        try { display.requestRender?.({ force: true }); } catch { /* best effort */ }
      });
  }
  if (!cached) return [` ${C.dim}Loading the change under review\u2026${C.reset}`];
  if (cached.formattedWidth !== inner) {
    cached.formatted = formatGateReviewDiffLines(cached.diff, inner, (lines) => display._monitorDiffBodyLines(lines, inner));
    cached.formattedWidth = inner;
  }
  return cached.formatted;
}

// The diff text is file content an agent wrote: sanitize it like any other
// role output before it reaches the terminal.
function formatGateReviewDiffLines(diff, inner, bodyLines) {
  const textW = Math.max(8, inner - 2);
  const out = [` ${C.bold}${fit(_sanitizeDisplayLine(diff.title || "change under review"), textW)}${C.reset}`];
  if (diff.unavailable) {
    out.push("", ` ${C.yellow}${fit(`Diff unavailable: ${_sanitizeDisplayLine(diff.unavailable)}`, textW)}${C.reset}`);
    return out;
  }
  for (const error of diff.errors || []) out.push(` ${C.red}${fit(_sanitizeDisplayLine(error), textW)}${C.reset}`);
  const files = diff.files || [];
  if (files.length === 0) {
    out.push("", ` ${C.dim}No file changes.${C.reset}`);
    return out;
  }
  const add = files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const del = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const fileCount = files.length + (diff.omittedFiles || 0);
  out.push(` ${C.bold}${fileCount} file${fileCount === 1 ? "" : "s"} changed${C.reset}  ${C.green}+${add}${C.reset} ${C.red}-${del}${C.reset}`);
  if (diff.omittedFiles > 0) out.push(` ${C.dim}${diff.omittedFiles} more file(s) not shown${C.reset}`);
  if ((diff.excludedTargetMergeFiles || []).length > 0) {
    out.push(` ${C.dim}${fit(`${diff.excludedTargetMergeFiles.length} file(s) the target-branch merge brought in are not the job's and are not shown`, textW)}${C.reset}`);
  }
  for (const file of files) {
    out.push("", ` ${C.dim}${"\u2500".repeat(textW)}${C.reset}`);
    out.push(` ${C.cyan}${C.bold}${fit(_sanitizeDisplayLine(file.path || "?"), Math.max(8, inner - 16))}${C.reset}  ${C.green}+${file.additions || 0}${C.reset} ${C.red}-${file.deletions || 0}${C.reset}`);
    if (!file.lines) out.push(` ${C.dim}patch omitted: the diff line limit was reached${C.reset}`);
    else out.push(...bodyLines(file.lines.map((line) => _sanitizeDisplayLine(line))));
  }
  return out;
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



export class DisplayMonitorRenderer {
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

    // Status chips carry a drop priority so a narrow pane sheds the least
    // important ones first (idle, then zero-counts/on-lock, then the heartbeat)
    // instead of letting the frame clip whatever happens to sit rightmost.
    // Running and a non-zero "waiting on you" always survive.
    const chips = [
      { keep: 2, text: heartbeat },
      { keep: 3, text: `${C.brightWhite}${String(running).padStart(2, "0")}${C.reset}${C.dim} running${C.reset}` },
      waiting > 0
        ? { keep: 4, text: `${C.yellow}${C.bold}${String(waiting).padStart(2, "0")} waiting on you${C.reset}` }
        : { keep: 1, text: `${C.dim}00 waiting on you${C.reset}` },
      ...(blockedByLock > 0 ? [{ keep: 1, text: `${C.yellow}${String(blockedByLock).padStart(2, "0")} on lock${C.reset}` }] : []),
      { keep: 0, text: `${C.dim}${Math.max(0, openSlots - blockedByLock)} idle${C.reset}` },
    ];
    const statusText = () => chips.map((chip) => chip.text).join(` ${C.dim}\u00b7${C.reset} `);
    while (chips.length > 1 && 24 + stripAnsi(statusText()).length > width) {
      let dropIdx = 0;
      for (let i = 1; i < chips.length; i++) {
        if (chips[i].keep < chips[dropIdx].keep) dropIdx = i;
      }
      if (chips[dropIdx].keep >= 3) break;
      chips.splice(dropIdx, 1);
    }
    const status = statusText();

    const mastheadLeft = ` ${posseWordmark()} ${C.dim}/${C.reset} ${C.brightWhite}${C.bold}monitor agents${C.reset} ${C.dim}[operator console]${C.reset}`;
    lines.push(`${visiblePad(mastheadLeft, Math.max(20, width - stripAnsi(status).length - 1))}${status}`);
    lines.push(this._buildRightModeTabs(width));
    lines.push(` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`);

    // Paired members' work runs on their machines, so it is never one of this
    // clone's agents. Show it here as well as in the log view: the run screen
    // opens in this view, and a host often has no local agents at all.
    // Local agents keep room for their two header rows, the controls row, and
    // at least four agent rows; the lane gets what is left (up to five rows).
    const reserved = agents.length > 0 ? 3 + 4 : 1;
    const peerLane = this._buildPeerWorkLane(width, Math.min(5, Math.max(0, maxLines - lines.length - reserved - 1)));
    if (peerLane.length > 0) {
      lines.push(...peerLane, ` ${C.dim}${"\u2500".repeat(Math.max(8, width - 2))}${C.reset}`);
    }

    if (agents.length === 0) {
      const remaining = Math.max(0, maxLines - lines.length);
      const accountingLines = this._buildRunAccountingWidget(width, Math.min(5, remaining));
      const emptyRows = Math.max(0, remaining - accountingLines.length);
      lines.push(...this._buildMonitorEmptyLines(width, emptyRows).slice(0, emptyRows));
      while (lines.length < maxLines - accountingLines.length) lines.push("");
      lines.push(...accountingLines);
      return lines.slice(0, maxLines);
    }

    // Narrow panes go single-column: the fleet rail gets the full width and the
    // focus pane sits out \u2014 a sub-20-col detail column was unreadable anyway.
    // Selection, jumping, and the state-aware controls all keep working.
    if (width < 76) {
      lines.push(fit(` ${this._monitorAgentActionsLine(selected)}`, width));
      lines.push(fit(` ${this._monitorAgentNavigationLine(waiting)}  ${C.dim}[↑↓] HISTORY${C.reset}`, width));
      const remaining = Math.max(0, maxLines - lines.length);
      const accountingLines = this._buildRunAccountingWidget(width, Math.min(5, remaining));
      const bodyRows = Math.max(0, remaining - accountingLines.length);
      const railW = Math.max(20, width - 1);
      const fleetLines = this._buildMonitorFleetLines(agents, selected, railW, bodyRows);
      for (let idx = 0; idx < bodyRows; idx++) {
        lines.push(visiblePad(fleetLines[idx] || "", railW));
      }
      lines.push(...accountingLines);
      return lines.slice(0, maxLines);
    }

    const leftW = clamp(Math.floor(width * 0.34), 28, Math.min(42, width - 32));
    const rightW = Math.max(20, width - leftW - 1);
    const divider = `${C.dim}\u2502${C.reset}`;
    const leftHead = ` ${C.dim}FLEET${C.reset}`;
    const rightHead = selected
      ? ` ${C.brightWhite}${C.bold}[${selected.index}] ${selected.role} #${selected.agentCallId ? `call ${selected.agentCallId}` : selected.jobId}${C.reset}${C.dim} \u00b7 ${selected.wiLabel}${selected.attempt > 1 ? ` \u00b7 attempt ${selected.attempt}` : ""}${C.reset}`
      : "";
    lines.push(`${visiblePad(leftHead, leftW)}${divider}${fit(rightHead, rightW)}`);
    lines.push(`${visiblePad(` ${this._monitorAgentNavigationLine(waiting)}`, leftW)}${divider}${fit(` ${this._monitorAgentActionsLine(selected)}`, rightW)}`);
    lines.push(`${C.dim}${"\u2500".repeat(leftW)}\u253c${"\u2500".repeat(rightW)}${C.reset}`);

    const bodyRows = Math.max(0, maxLines - lines.length);
    const accountingBudget = bodyRows >= 2
      ? Math.min(9, Math.max(2, Math.floor(bodyRows * 0.34)))
      : 0;
    const accountingLines = this._buildRunAccountingWidget(rightW, accountingBudget);
    const focusRows = Math.max(0, bodyRows - accountingLines.length);
    // Both columns fill the whole body height (the fleet rail tails into a live
    // event feed, the focus pane pads its own boxes), so neither side leaves a
    // trailing whitespace gap below its content.
    const fleetLines = this._buildMonitorFleetLines(agents, selected, leftW, bodyRows);
    const focusLines = selected ? this._buildMonitorFocusLines(selected, rightW, focusRows) : [];
    while (focusLines.length < focusRows) focusLines.push("");
    focusLines.push(...accountingLines);
    const rows = Math.min(bodyRows, Math.max(fleetLines.length, focusLines.length));
    for (let idx = 0; idx < rows; idx++) {
      lines.push(`${visiblePad(fleetLines[idx] || "", leftW)}${divider}${fit(focusLines[idx] || "", rightW)}`);
    }

    while (lines.length < maxLines) {
      lines.push(`${" ".repeat(leftW)}${divider}`);
    }
    return lines.slice(0, maxLines);
  }



  // Agent actions occupy fixed slots directly below the selected-agent title.
  // Disabled actions stay visible but dim, so selection changes alter state,
  // not geometry. This prevents the control bar from jumping under the cursor.
  _monitorAgentActionsLine(selected) {
    const action = (key, label, enabled, color) => enabled
      ? `${color}[${key}] ${label}${C.reset}`
      : `${C.dim}[${key}] ${label}${C.reset}`;
    const killable = Boolean(
      selected
      && !selected.agentCallId
      && this.onKill
      && this.workers?.has?.(selected.jobId),
    );
    return [
      action("a", "answer", selected?.state === "ask", C.green),
      action("n", "nudge", Boolean(selected && this.onNudge), C.yellow),
      action("d", "changes", Boolean(selected), C.magenta),
      action("!", "kill", killable, C.red),
    ].join(" ");
  }


  _monitorAgentNavigationLine(waiting) {
    const waitingControl = waiting > 0
      ? `${C.yellow}[w] waiting${C.reset}`
      : `${C.dim}[w] waiting${C.reset}`;
    return `${C.dim}[1-9] select  [←→] cycle${C.reset}  ${waitingControl}`;
  }


  _monitorControlsLine(agents, selected, waiting) {
    void agents;
    return `${this._monitorAgentActionsLine(selected)}  ${C.dim}·${C.reset}  ${this._monitorAgentNavigationLine(waiting)}`;
  }



  // Empty-state: answer "why is nothing running?" with the queue itself —
  // what's waiting for a slot and what just finished — instead of dead space.
  _buildMonitorEmptyLines(width, maxLines) {
    const lines = [];
    lines.push("");
    lines.push(` ${C.dim}No live agents right now.${C.reset}`);
    let queueData = {};
    try { queueData = this._getQueueData?.({ maxAgeMs: 1000 }) || {}; } catch { queueData = {}; }
    const jobs = queueData.jobs || [];
    const workItems = queueData.workItems || [];
    const queued = jobs.filter((job) => ["queued", "pending"].includes(String(job.status || "").toLowerCase()));
    const queuedWorkItems = workItems.filter((wi) => String(wi?.status || "").toLowerCase() === "queued");
    const finished = jobs
      .filter((job) => ["succeeded", "failed", "canceled"].includes(String(job.status || "").toLowerCase()))
      .sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0))
      .slice(0, 4);
    if (queued.length > 0 && lines.length + 2 <= maxLines) {
      lines.push("");
      lines.push(` ${C.bold}QUEUED${C.reset} ${C.dim}· ${queued.length} waiting for a slot${C.reset}`);
      for (const job of queued.slice(0, 4)) {
        if (lines.length >= maxLines) break;
        const label = _sanitizeDisplayLine(jobLabel(job.job_type, job.title));
        lines.push(`  ${C.dim}·${C.reset} #${job.id} ${roleBrandColor(job.job_type)}${roleLabel(job.job_type)}${C.reset}  ${C.dim}${fit(label, Math.max(8, width - 22))}${C.reset}`);
      }
    } else if (queuedWorkItems.length > 0 && lines.length + 2 <= maxLines) {
      lines.push("");
      lines.push(` ${C.bold}QUEUED WORK ITEMS${C.reset} ${C.dim}· ${queuedWorkItems.length} waiting for planning${C.reset}`);
      for (const wi of queuedWorkItems.slice(0, 4)) {
        if (lines.length >= maxLines) break;
        const label = _sanitizeDisplayLine(wi.title || "");
        lines.push(`  ${C.dim}·${C.reset} WI#${wi.id} ${C.blue}queued${C.reset}  ${C.dim}${fit(label, Math.max(8, width - 24))}${C.reset}`);
      }
    }
    if (finished.length > 0 && lines.length + 2 <= maxLines) {
      lines.push("");
      lines.push(` ${C.bold}RECENTLY FINISHED${C.reset}`);
      for (const job of finished) {
        if (lines.length >= maxLines) break;
        const jobStatus = String(job.status || "").toLowerCase();
        const glyph = jobStatus === "succeeded" ? `${C.green}✓` : (jobStatus === "failed" ? `${C.red}✗` : `${C.dim}·`);
        const ago = fmtAgo(Date.now() - (Date.parse(job.updated_at || "") || Date.now()));
        const label = _sanitizeDisplayLine(jobLabel(job.job_type, job.title));
        lines.push(`  ${glyph}${C.reset} #${job.id} ${roleBrandColor(job.job_type)}${roleLabel(job.job_type)}${C.reset}  ${fit(label, Math.max(8, width - 30))} ${C.dim}${ago} ago${C.reset}`);
      }
    }
    if (queued.length === 0 && queuedWorkItems.length === 0 && finished.length === 0) {
      lines.push(` ${C.dim}Monitor Agents will show running workers, questions, nudges, and tool history here.${C.reset}`);
    }
    return lines;
  }



  _collectMonitorAgents({ maxAgeMs = 750 } = {}) {
    // Rebuilding this hits the interactions/guidance tables per agent, and the
    // render loop repaints every ~120ms — cache the built roster like the queue
    // snapshot so a repaint is a pure read. Selection hotkeys read the same
    // cache, so the roster a keypress acts on is the roster on screen.
    const cacheNow = Date.now();
    if (this._monitorAgentsCache && (cacheNow - (this._monitorAgentsCacheAt || 0)) < maxAgeMs) {
      return this._monitorAgentsCache;
    }
    const queueData = this._getQueueData?.({ maxAgeMs: 1000 }) || {};
    const jobsById = new Map((queueData.jobs || []).map((job) => [Number(job.id), job]));
    // WI rows (already fetched + cached in queueData) so the focus-pane agent
    // card can show the work-item title and merge state without a fresh query.
    const wiById = new Map((queueData.workItems || []).map((wi) => [Number(wi.id), wi]));
    const questionJobIds = new Set((this._questionQueue || []).map((q) => Number(q.jobId)).filter(Number.isFinite));
    // Pull tool observations once and bucket the newest non-coordination call
    // per job so each agent's "thinking vs tool call" state is one cheap lookup.
    let toolRecent = [];
    try { toolRecent = (typeof this.getToolData === "function" ? this.getToolData()?.recent : null) || []; } catch { toolRecent = []; }
    const liveness = (numericJobId, activityRows, interactionRows, fallbackTs) => {
      const jobToolRows = toolRecent.filter((row) => Number(row.job_id) === numericJobId
        && !LIVE_CHANNEL_TOOL_TYPES.has(String(row.observation_type || "")));
      // Track the agent's NEWEST tool observation alongside the latest timestamp:
      // "in a tool call" means that newest row is a started-but-unfinished
      // (in_flight) call. Reading the newest row (not "any in_flight row") keeps
      // it self-healing — if a finish observation is ever lost, the next tool the
      // agent starts becomes the newest row and clears the stale flag.
      let latestToolTs = 0;
      let newestToolRow = null;
      for (const row of jobToolRows) {
        const ts = Date.parse(row?.created_at || "") || 0;
        if (ts >= latestToolTs) { latestToolTs = ts; newestToolRow = row; }
      }
      const latestTalkTs = Math.max(latestStamp(activityRows), latestStamp(interactionRows));
      return {
        lastActivityAt: Math.max(latestToolTs, latestTalkTs, fallbackTs || 0),
        inFlightTool: !!newestToolRow?.in_flight,
      };
    };
    // ATLAS warm jobs are harness work, not agents: they report through the
    // system log and never take an agent row or a digit-key slot.
    const isAtlasWarmWorker = (jobId, worker) => jobIsBackgroundAtlasWarm(jobsById.get(Number(jobId)))
      || jobIsBackgroundAtlasWarm({ job_type: worker?.jobType ?? worker?.job_type ?? worker?.role });
    const agents = [...this.workers.entries()].filter(([jobId, worker]) => !isAtlasWarmWorker(jobId, worker)).map(([jobId, worker], idx) => {
      const numericJobId = Number(jobId);
      const job = jobsById.get(numericJobId) || {};
      const wiRow = wiById.get(Number(worker?.workItemId ?? job.work_item_id)) || {};
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
        interactionRows = mergeMonitorAgentActivityEvents(interactionRows, getAgentActivityEvents(numericJobId, 60));
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
      const hasActionableQuestion = questionJobIds.has(numericJobId)
        && (job.job_type !== "human_input" || monitorHumanGateIsOpen(job));
      const state = hasActionableQuestion ? "ask" : (pendingGuidance.length > 0 ? "nudge" : "live");
      const activity = _sanitizeDisplayLine(activityRows[0]?.body || worker?.activity || job.title || worker?.role || "running");
      return {
        index: idx + 1,
        jobId: numericJobId,
        workItemId: worker?.workItemId ?? job.work_item_id ?? null,
        wiLabel: (worker?.workItemId ?? job.work_item_id) ? `WI#${worker?.workItemId ?? job.work_item_id}` : "WI?",
        wiTitle: wiRow.title || job.title || null,
        wiStatus: wiRow.status || null,
        wiMergeState: wiRow.merge_state || null,
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
      if (jobIsBackgroundAtlasWarm(job)) continue;
      const status = String(job.status || "").toLowerCase();
      const humanGateOpen = monitorHumanGateIsOpen(job);
      const isHumanWait = humanGateOpen && MONITOR_HUMAN_GATE_STATUSES.has(status);
      const hasActionableQuestion = questionJobIds.has(numericJobId)
        && !MONITOR_TERMINAL_JOB_STATUSES.has(status)
        && (job.job_type !== "human_input" || humanGateOpen);
      const isDurablyActive = MONITOR_ACTIVE_JOB_STATUSES.has(status);
      if (!isHumanWait && !hasActionableQuestion && !isDurablyActive) continue;
      let guidance = [];
      let interactionRows = [];
      try {
        guidance = listActiveAgentGuidanceForJob(numericJobId, { limit: 3 });
        interactionRows = listAgentInteractions({ job_id: numericJobId, limit: 14 });
        interactionRows = mergeMonitorAgentActivityEvents(interactionRows, getAgentActivityEvents(numericJobId, 60));
      } catch {
        guidance = [];
        interactionRows = [];
      }
      const activityRows = interactionRows.filter((row) => row.direction === "agent_to_user" && row.kind === "activity");
      const pendingGuidance = guidance.filter((row) => row.ack_state !== "acknowledged");
      const wiRow = wiById.get(Number(job.work_item_id)) || {};
      const fallbackActivityAt = Date.parse(job.started_at || job.updated_at || job.created_at || "") || Date.now();
      agents.push({
        index: agents.length + 1,
        jobId: numericJobId,
        workItemId: job.work_item_id ?? null,
        wiLabel: job.work_item_id ? `WI#${job.work_item_id}` : "WI?",
        wiTitle: wiRow.title || job.title || null,
        wiStatus: wiRow.status || null,
        wiMergeState: wiRow.merge_state || null,
        role: roleLabel(job.job_type || "human"),
        state: isHumanWait || hasActionableQuestion
          ? "ask"
          : (pendingGuidance.length > 0 ? "nudge" : "live"),
        activity: _sanitizeDisplayLine(activityRows[0]?.body || job.title || (isHumanWait ? "waiting on human input" : "running")),
        attempt: job.attempt_count || 1,
        provider: job.provider || null,
        modelName: job.model_name || null,
        tier: job.model_tier || "standard",
        effort: job.reasoning_effort || "medium",
        elapsed: formatElapsed(fallbackActivityAt),
        interactionRows,
        activityRows,
        guidance,
        pendingGuidance,
        status: job.status || (isHumanWait ? "waiting_on_human" : "running"),
        ...liveness(numericJobId, activityRows, interactionRows, fallbackActivityAt),
      });
      seen.add(numericJobId);
    }
    // Display order IS selection order: regroup by work item (first-seen order,
    // exactly how the fleet rail groups its rows) BEFORE numbering, so the [n]
    // printed beside an agent is always the [n] the digit keys jump to.
    const grouped = new Map();
    for (const agent of agents) {
      const key = agent.workItemId == null ? "_none" : String(agent.workItemId);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(agent);
    }
    const ordered = appendResearchChildMonitorRows([...grouped.values()].flat(), { toolRows: toolRecent });
    ordered.forEach((agent, idx) => { agent.index = idx + 1; });
    this._monitorAgentsCache = ordered;
    this._monitorAgentsCacheAt = cacheNow;
    return ordered;
  }



  _selectMonitorAgent(agents) {
    if (!Array.isArray(agents) || agents.length === 0) {
      this._monitorSelectedJobId = null;
      return null;
    }
    let selected = agents.find((agent) => agent.jobId === this._monitorSelectedJobId && (agent.agentCallId || null) === (this._monitorSelectedAgentCallId || null));
    if (!selected) {
      // Prefer an agent that's blocked on the operator: when the previous
      // selection finishes (or nothing is selected yet), the focus pane lands
      // on whoever actually needs attention rather than whoever is first.
      selected = agents.find((agent) => agent.state === "ask") || agents[0];
      this._monitorSelectedJobId = selected.jobId;
      this._monitorSelectedAgentCallId = selected.agentCallId || null;
      this._monitorFeedbackScroll = 0;
      this._monitorChangesMode = false;
      this._monitorDiffOpen = false;
      this._monitorDiffFileIndex = 0;
      this._monitorDiffScroll = 0;
    }
    return selected;
  }



  _buildMonitorFleetLines(agents, selected, width, height = 0) {
    const lines = [];
    const spin = this._spinIdx | 0;

    // Group occupied slots by work item so the rail reads "what is working on
    // what": one WI header, then its agents, then the next WI. Agents arrive
    // already numbered in this grouped order (_collectMonitorAgents), so the
    // rail's visual order always matches the digit-jump numbers.
    const groups = new Map();
    for (const agent of agents) {
      const key = agent.workItemId == null ? "_none" : String(agent.workItemId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
    // One block per agent (its WI header rides the group's first block) so
    // overflow can window whole agents into view instead of slicing raw lines.
    const blocks = [];
    let firstGroup = true;
    for (const [key, groupAgents] of groups) {
      groupAgents.forEach((agent, agentIdx) => {
        const blockLines = [];
        if (agentIdx === 0) {
          if (!firstGroup) blockLines.push("");
          // Just the WI id \u2014 the title only gets cut off at this width.
          blockLines.push(key === "_none"
            ? ` ${C.dim}\u00b7 no work item${C.reset}`
            : ` ${C.blue}${C.bold}WI#${key}${C.reset}`);
        }
        const meta = monitorActivityState(agent, spin);
        const isSelected = selected?.jobId === agent.jobId && (selected?.agentCallId || null) === (agent.agentCallId || null);
        // Only the selected row carries the cursor and the bright/bold ink, so
        // the focused agent pops from the roster instead of sharing its weight
        // with every row. The rail bar keeps the ROLE tint (researcher purple,
        // dev green, planner cyan, \u2026) so the roster still reads as "who is
        // who"; agent STATE shows in the activity tag on the right
        // (waiting/nudge/tool/thinking) and the "waiting on you" header count.
        const selector = isSelected ? `${C.brightWhite}${C.bold}\u258c${C.reset}` : " ";
        const rail = `${roleBrandColor(agent.role)}\u2503${C.reset}`;
        const titleInk = isSelected ? `${C.brightWhite}${C.bold}` : "";
        const title = `${selector}${rail} ${titleInk}[${agent.index}] ${agent.role}${C.reset} ${C.dim}#${agent.agentCallId ? `call ${agent.agentCallId}` : agent.jobId}${C.reset}`;
        const tag = `${meta.color}${meta.bold ? C.bold : ""}${meta.glyph} ${meta.label}${C.reset}`;
        blockLines.push(`${visiblePad(title, Math.max(0, width - stripAnsi(tag).length - 1))}${tag}`);
        blockLines.push(`   ${C.dim}${fit(agent.activity, Math.max(8, width - 5))}${C.reset}`);
        if (agent.pendingGuidance?.length > 0) {
          blockLines.push(`   ${C.yellow}${fit(`nudge queued: ${agent.pendingGuidance[0].body || ""}`, Math.max(8, width - 5))}${C.reset}`);
        }
        blocks.push({ lines: blockLines, isSelected });
      });
      firstGroup = false;
    }

    // Open slots \u2014 surfaced like the main queue panel: file-lock-blocked first
    // (yellow, same lock-summary labels), then truly-idle/available slots.
    // Built before the roster so the windowing below knows its real budget.
    const openSlots = Math.max(0, (this.concurrency || 0) - (this.workers?.size || 0));
    const blockedByLock = Math.min(this._blockedByLock || 0, openSlots);
    const trulyIdle = openSlots - blockedByLock;
    const slotLines = [];
    if (blockedByLock > 0 || trulyIdle > 0) {
      if (blocks.length > 0) slotLines.push("");
      if (blockedByLock > 0) {
        const labels = this._blockedLockSummaryLabels(blockedByLock);
        slotLines.push(`  ${C.yellow}\u00b7 ${fit(labels.join(", "), Math.max(8, width - 4))}${C.reset}`);
      }
      if (trulyIdle > 0) {
        slotLines.push(`  ${C.dim}\u00b7 ${trulyIdle} idle slot${trulyIdle === 1 ? "" : "s"} available${C.reset}`);
      }
    }

    // Window the agent blocks around the selection instead of silently
    // truncating at nine: every agent stays reachable via cycling, and clipped
    // ends announce themselves with \u25b2/\u25bc counts.
    const totalAgentLines = blocks.reduce((sum, block) => sum + block.lines.length, 0);
    const agentBudget = Math.max(3, (height || 0) - slotLines.length);
    if (height > 0 && totalAgentLines > agentBudget) {
      const avail = Math.max(1, agentBudget - 2); // reserve the marker rows
      let start = Math.max(0, blocks.findIndex((block) => block.isSelected));
      let end = start;
      let used = blocks[start].lines.length;
      let grew = true;
      while (grew) {
        grew = false;
        if (end + 1 < blocks.length && used + blocks[end + 1].lines.length <= avail) {
          end++; used += blocks[end].lines.length; grew = true;
        }
        if (start > 0 && used + blocks[start - 1].lines.length <= avail) {
          start--; used += blocks[start].lines.length; grew = true;
        }
      }
      if (start > 0) lines.push(` ${C.dim}\u25b2 ${start} earlier${C.reset}`);
      for (let i = start; i <= end; i++) {
        // The first visible block drops its leading group gap so the window
        // opens on content, not a blank.
        const blockLines = (i === start && blocks[i].lines[0] === "") ? blocks[i].lines.slice(1) : blocks[i].lines;
        lines.push(...blockLines);
      }
      const below = blocks.length - end - 1;
      if (below > 0) lines.push(` ${C.dim}\u25bc ${below} more${C.reset}`);
    } else {
      for (const block of blocks) lines.push(...block.lines);
    }
    lines.push(...slotLines);
    while (lines.length < (height || 0)) lines.push("");
    return lines;
  }



  _monitorToolActivityForJob(jobId, { limit = 8, agentCallId = null, excludeCallIds = [] } = {}) {
    let data = null;
    try { data = typeof this.getToolData === "function" ? this.getToolData() : null; } catch { data = null; }
    const recent = Array.isArray(data?.recent) ? data.recent : [];
    const allRows = recent
      .filter((row) => Number(row.job_id) === Number(jobId)
        && (agentCallId ? Number(row.agent_call_id) === agentCallId : !excludeCallIds.includes(Number(row.agent_call_id))));
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
    // count == null omits the "NN" tally chip (the agent card has no count).
    const countChip = count == null ? "" : ` ${C.dim}${String(count).padStart(2, "0")}${C.reset}`;
    const lines = [
      `${C.dim}\u256d${"\u2500".repeat(inner)}\u256e${C.reset}`,
      this._monitorBoxLine(` ${color}${C.bold}${String(title || "").toUpperCase()}${C.reset}${countChip}`, safeWidth),
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
    const duration = Number.isFinite(row.duration_ms) ? fmtDur(row.duration_ms) : "";
    const status = inFlight
      ? `${C.cyan}running${C.reset}`
      : (meta.outcome === "failed" || meta.outcome === "rejected"
          ? `${meta.color}${meta.label}${C.reset}${duration ? ` ${C.dim}${duration}${C.reset}` : ""}`
          : (duration ? `${C.dim}${duration}${C.reset}` : ""));
    // No timestamp: glyph → module → command → info, status pinned at the end.
    const moduleColor = module === "atlas" ? C.magenta : C.blue;
    const commandText = command ? `${C.cyan}${command}${C.reset} ` : "";
    const prefix = ` ${glyphColor}${glyph}${C.reset} ${moduleColor}${module}${C.reset} ${commandText}`;
    const statusLen = status ? stripAnsi(status).length + 1 : 0;
    const budget = Math.max(8, safeWidth - stripAnsi(prefix).length - statusLen - 3);
    const body = command ? info : (info || meta.label);
    return `${prefix}${fit(body, budget)}${status ? ` ${status}` : ""}`;
  }



  _formatToolDetailRows(row, width) {
    const meta = monitorToolMeta(row);
    if (meta.outcome !== "failed" && meta.outcome !== "rejected") return [];
    const safeWidth = Math.max(18, width | 0);
    const rejected = meta.outcome === "rejected";
    const detail = _sanitizeDisplayLine(rejected
      ? (row.rejection_reason || "No reason was recorded for this rejected call.")
      : (row.error || "No error diagnostic was recorded for this failed call."));
    const label = rejected ? "reason:" : "error:";
    const color = rejected ? C.yellow : C.red;
    const firstPrefix = `   ${color}\u21b3 ${label}${C.reset} `;
    const nextPrefix = " ".repeat(stripAnsi(firstPrefix).length);
    const firstWidth = Math.max(8, safeWidth - stripAnsi(firstPrefix).length - 2);
    const nextWidth = Math.max(8, safeWidth - nextPrefix.length - 2);
    return wrapHanging(detail, firstWidth, nextWidth).map((line, index) =>
      `${index === 0 ? firstPrefix : nextPrefix}${C.brightWhite}${line}${C.reset}`);
  }



  _formatMonitorToolRows(row, width) {
    return [
      this._formatMonitorToolRow(row, width),
      ...this._formatToolDetailRows(row, width),
    ];
  }



  _buildMonitorFeedbackToolLanes(agent, width, height) {
    const toolActivity = this._monitorToolActivityForJob(agent.jobId, { limit: 60, agentCallId: agent.agentCallId, excludeCallIds: agent.excludeCallIds });
    const feedbackEntries = this._monitorFeedbackEntries(agent, toolActivity.feedbackToolRows, { limit: 60 });
    const toolRows = [...toolActivity.toolRows]
      .sort((a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0));
    const renderedToolRows = toolRows.flatMap((row) => this._formatMonitorToolRows(row, width));

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
    // history. Build the natural (unclipped) rows ONCE so the box can be sized to
    // its CONTENT rather than a fixed share \u2014 a short feed gets a short box and
    // the reclaimed rows go to the agent card + tools below.
    const feedbackRows = (() => {
      if (feedbackEntries.length === 0) return [];
      const ordered = feedbackEntries; // oldest \u2192 newest
      const active = ordered[ordered.length - 1];
      const history = ordered.slice(0, -1);
      const out = [];
      for (const row of history) {
        for (const line of this._monitorFeedbackEntryLines(row, inner, { dim: true })) out.push(line);
        out.push(""); // blank gap between historical messages
      }
      if (history.length > 0) {
        out.push(` ${C.dim}${"\u254c".repeat(Math.max(3, inner - 1))}${C.reset}`);
      }
      out.push(...this._monitorFeedbackEntryLines(active, inner));
      return out;
    })();

    const buildFeedback = (content) => {
      // The history scrolls: _monitorFeedbackScroll counts lines back from the
      // live floor (0 = pinned to the newest message). Clamp and write back
      // like the diff scroll so holding the key can't run past the history.
      const maxScroll = Math.max(0, feedbackRows.length - content);
      const scroll = clamp(this._monitorFeedbackScroll || 0, 0, maxScroll);
      this._monitorFeedbackScroll = scroll;
      const boxedFeedback = (rows) => this._monitorBoxedLane({
        title: scroll > 0 ? `feedback \u2191${scroll}` : "feedback",
        count: feedbackEntries.length,
        color: C.yellow,
        width,
        rows,
        emptyText: `no updates yet \u2014 current: ${agent.activity}`,
        fixedRows: content,
      });
      if (feedbackRows.length === 0) return boxedFeedback([]);
      // Anchor to the bottom: drop oldest lines from the top, pad short content
      // at the top so the live message always lands on the floor.
      let rows = feedbackRows.slice();
      if (rows.length > content) rows = rows.slice(rows.length - content - scroll, rows.length - scroll);
      while (rows.length < content) rows.unshift("");
      return boxedFeedback(rows);
    };

    // A blocked agent leads with WHAT it's asking: the pending question renders
    // in its own amber box instead of hiding in the bottom-bar preview.
    const askRows = agent.state === "ask" ? this._monitorPendingQuestionRows(agent, inner) : [];

    // A short pane only has room for one box.
    if (total < 11) {
      if (this._monitorChangesMode) return this._buildMonitorChangesBox(agent, width, total);
      if (askRows.length > 0) return this._monitorAskBox(askRows, width, Math.max(1, total - 4));
      return buildFeedback(Math.max(1, total - 4));
    }

    const FEEDBACK_MAX = 8;     // preferred cap; may grow into rows tools doesn't need
    const CARD_BOX_H = 8;       // 4 dossier rows + 4 chrome
    const MIN_TOOLS_H = 5;

    // CHANGES mode keeps the two-box feedback+diff split (no card \u2014 the git-diff
    // browser wants the height). Feedback is still compressed to its content so
    // the reclaimed rows go to the diff instead of padding an empty feedback box.
    if (this._monitorChangesMode) {
      const fbContent = Math.max(2, Math.min(Math.max(1, feedbackRows.length), FEEDBACK_MAX));
      let feedbackBoxH = fbContent + 4;
      let diffBoxH = total - feedbackBoxH;
      if (diffBoxH < 6) { diffBoxH = 6; feedbackBoxH = total - diffBoxH; }
      return [
        ...buildFeedback(Math.max(1, feedbackBoxH - 4)),
        ...this._buildMonitorChangesBox(agent, width, diffBoxH),
      ];
    }

    // Normal mode: agent card (top) + ask box (only while blocked) + feedback +
    // tools. The dossier leads so its WI/diff/tool stats and the trotting horse
    // sit at the top of the focus pane, with the conversation and tool log
    // stacked below.
    let askBoxH = 0;
    if (askRows.length > 0) {
      askBoxH = Math.min(askRows.length + 4, 12, Math.max(5, total - 11));
      if (total - askBoxH < 11) askBoxH = 0; // no room: [a] still opens the answer flow
    }
    const showCard = total >= 19 + askBoxH; // only seat the card when everything else fits
    const cardH = showCard ? CARD_BOX_H : 0;

    // Feedback states its preference (content up to FEEDBACK_MAX); tools sizes
    // to its call count within what's left. The tools height RATCHETS per
    // selection — it may grow as calls land but never shrinks back — so the box
    // boundary settles instead of bouncing, and any leftover height goes to
    // feedback, which pads at the top like a chat. Net effect: a chatty agent
    // with few tool calls gets a tall conversation, not a pane of blank rows.
    const rest = total - cardH - askBoxH;
    const feedbackDesired = Math.max(2, Math.min(Math.max(1, feedbackRows.length), FEEDBACK_MAX));
    const toolCap = Math.max(MIN_TOOLS_H, rest - (feedbackDesired + 4));
    const toolLaneId = `${agent.jobId}:${agent.agentCallId || "parent"}`;
    if (this._monitorToolRatchetJob !== toolLaneId) {
      this._monitorToolRatchetJob = toolLaneId;
      this._monitorToolRatchetH = 0;
    }
    let toolBoxH = Math.max(MIN_TOOLS_H, Math.min(renderedToolRows.length + 4, toolCap));
    toolBoxH = Math.min(Math.max(toolBoxH, this._monitorToolRatchetH), toolCap);
    this._monitorToolRatchetH = toolBoxH;
    let feedbackBoxH = rest - toolBoxH;
    if (feedbackBoxH < 6) { feedbackBoxH = 6; toolBoxH = rest - 6; }
    const toolContent = Math.max(1, toolBoxH - 4);

    const toolsBox = this._monitorBoxedLane({
      title: "tools",
      count: toolRows.length,
      color: C.cyan,
      width,
      rows: renderedToolRows.slice(0, toolContent),
      emptyText: "no tool calls yet",
      fixedRows: toolContent,
    });

    return [
      ...(showCard ? this._buildMonitorAgentCard(agent, width, cardH) : []),
      ...(askBoxH > 0 ? this._monitorAskBox(askRows, width, askBoxH - 4) : []),
      ...buildFeedback(Math.max(1, feedbackBoxH - 4)),
      ...toolsBox,
    ];
  }



  // The selected agent's pending interactive question, wrapped for the ask box.
  // Empty when the job has no queued question set (e.g. a human-wait job whose
  // input arrives through another surface).
  _monitorPendingQuestionRows(agent, inner) {
    const qSet = (this._questionQueue || []).find((entry) => Number(entry.jobId) === Number(agent.jobId));
    const pending = qSet ? (qSet.questions || []).slice(qSet.currentIdx || 0) : [];
    if (pending.length === 0) return [];
    const rows = [];
    const bodyW = Math.max(8, inner - 3);
    for (const chunk of wrapHanging(_sanitizeDisplayLine(pending[0]), bodyW, bodyW)) {
      rows.push(` ${C.yellow}▏${C.reset} ${chunk}`);
    }
    const more = pending.length - 1;
    rows.push(` ${C.dim}${more > 0 ? `+${more} more queued · ` : ""}[a] answer${C.reset}`);
    return rows;
  }



  _monitorAskBox(askRows, width, contentRows) {
    return this._monitorBoxedLane({
      title: "waiting on you",
      count: null,
      color: C.yellow,
      width,
      rows: askRows,
      emptyText: "waiting",
      fixedRows: contentRows,
    });
  }

  // \u2500\u2500 Focus-pane agent card \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // A compact dossier \u2014 WI + status/phase + diff/tool stats \u2014 with the Posse
  // mascot trotting in a lane on the right. It also carries the status line
  // that used to sit above the boxes, so the card is the single place that
  // answers "what is this agent and what is it doing". Everything here is free
  // at render time: the WI title/state ride the cached queue snapshot, the
  // +/\u2212 counts come from the same git-diff snapshot the [d] changes view
  // already builds, and the tool tally is the per-job observation count. No
  // per-agent token plumbing \u2014 run-level token/cost already has a dedicated
  // lower-right accounting card, so repeating it here would just duplicate.
  _buildMonitorAgentCard(agent, width, height) {
    const content = Math.max(1, (height | 0) - 4);
    const boxInner = Math.max(8, width - 2); // content width between the box borders

    // The horse is decoration, so the dossier text sets the floor: the lane only
    // gets what a ~44-col text column doesn't need (below that the horse sits
    // out and the text spans the full width) instead of always claiming half the
    // card and squeezing the WI title. renderPosseMascotFrame additionally needs
    // ~19 cells to draw and returns null below that.
    const horseLane = Math.min(Math.floor(boxInner / 2), Math.max(0, boxInner - 44));
    const horse = horseLane > 0
      ? (renderPosseMascotFrame({ tick: this._spinIdx, laneWidth: horseLane, colors: { ...C, orange: MASCOT_FG } }) || [])
      : [];
    const horseW = horse.length ? horseLane : 0;
    const textW = Math.max(8, boxInner - (horseW ? horseW + 1 : 0));

    // Diff stats from the cached snapshot (same source as the [d] view, on a
    // slower clock: the card only needs coarse counts, so it doesn't re-shell
    // git every 3s while the monitor idles open).
    const diff = this._monitorDiffFilesForAgent(agent, { ttlMs: 10000 });
    const files = Array.isArray(diff.files) ? diff.files : [];
    let add = 0;
    let del = 0;
    for (const f of files) {
      if (Number.isFinite(f.additions)) add += f.additions;
      if (Number.isFinite(f.deletions)) del += f.deletions;
    }
    const toolCount = this._monitorToolActivityForJob(agent.jobId, { limit: 500, agentCallId: agent.agentCallId, excludeCallIds: agent.excludeCallIds }).toolRows.length;
    const nudges = agent.pendingGuidance?.length || 0;
    const ago = agent.lastActivityAt ? `${fmtAgo(Date.now() - agent.lastActivityAt)} ago` : "idle";

    // Row 1 \u2014 WI id + title + state chip.
    const wiLabel = agent.wiLabel || "WI?";
    const chip = monitorWiStateChip(agent);
    const chipText = chip ? ` ${chip.color}${chip.label}${C.reset}` : "";
    const wiTitle = _sanitizeDisplayLine(agent.researchQuestion || agent.wiTitle || "");
    const titleBudget = Math.max(6, textW - wiLabel.length - stripAnsi(chipText).length - 3);
    const row1 = ` ${C.blue}${C.bold}${wiLabel}${C.reset}${wiTitle ? ` ${C.brightWhite}${fit(wiTitle, titleBudget)}${C.reset}` : ""}${chipText}`;

    // Row 2 \u2014 live status + phase (folded in from the old focus-pane header).
    const stateMeta = monitorStateMeta(agent.state);
    const statusLabel = String(agent.status || "running");
    const phaseBudget = Math.max(8, textW - statusLabel.length - 5);
    const row2 = ` ${stateMeta.color}\u25cf${C.reset} ${C.dim}${statusLabel}${C.reset}  ${C.brightWhite}${fit(_sanitizeDisplayLine(agent.activity || ""), phaseBudget)}${C.reset}`;

    // Row 3 \u2014 change + tool tally.
    const tally = `${toolCount} tool call${toolCount === 1 ? "" : "s"}`;
    let row3;
    if (agent.agentCallId) {
      row3 = ` ${C.dim}${tally} · parent call #${agent.parentAgentCallId}${C.reset}`;
    } else if (diff.loading) {
      row3 = ` ${C.dim}changes computing\u2026 \u00b7 ${tally}${C.reset}`;
    } else if (diff.error) {
      row3 = ` ${C.dim}changes ${fit(diff.error, Math.max(8, textW - 10))}${C.reset}`;
    } else if (files.length === 0) {
      row3 = ` ${C.dim}changes none yet \u00b7 ${tally}${C.reset}`;
    } else {
      row3 = ` ${C.dim}changes${C.reset} ${C.green}+${add}${C.reset} ${C.red}\u2212${del}${C.reset} ${C.dim}\u00b7 ${files.length} file${files.length === 1 ? "" : "s"} \u00b7 ${tally}${C.reset}`;
    }

    // Row 4 \u2014 pending nudges, model/effort (only when they deviate from the
    // defaults: "tier/standard \u00b7 medium" said nothing), runtime, freshness.
    const modelChip = agent.provider
      ? `${agent.provider}${agent.modelName ? `/${agent.modelName}` : ""}`
      : (agent.tier && agent.tier !== "standard" ? `tier/${agent.tier}` : "");
    const effortChip = agent.effort && agent.effort !== "medium" ? String(agent.effort) : "";
    const nudgeChip = nudges > 0
      ? `${C.yellow}${nudges} nudge${nudges === 1 ? "" : "s"} queued${C.reset}${C.dim} \u00b7 ${C.reset}`
      : "";
    const bits = [
      ...(modelChip ? [modelChip] : []),
      ...(effortChip ? [effortChip] : []),
      ...(agent.elapsed ? [`elapsed ${agent.elapsed}`] : []),
      ago,
    ];
    const row4 = ` ${nudgeChip}${C.dim}${bits.join(" \u00b7 ")}${C.reset}`;

    const textRows = [row1, row2, row3, row4].slice(0, content);
    while (textRows.length < content) textRows.push("");

    // Seat the horse flush against the right border: pad the text to textW, one
    // gap, then the half-row braille lane (visible width textW + 1 + horseW == boxInner).
    const rows = textRows.map((t, i) => (horseW ? `${visiblePad(t, textW)} ${horse[i] || ""}` : t));

    return this._monitorBoxedLane({
      title: "agent",
      count: null,
      color: C.cyan,
      width,
      rows,
      emptyText: "agent",
      fixedRows: content,
    });
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
  // ttlMs picks the refresh clock per consumer: the [d] changes browser wants
  // fresh counts (3s), the always-on agent card only coarse ones (it passes
  // 10s) so the monitor doesn't shell out to git constantly while idling open.
  _monitorDiffFilesForAgent(agent, { ttlMs = 3000 } = {}) {
    const wiId = agent?.workItemId;
    if (wiId == null) return { files: [], loading: false };
    const fresh = this._monitorDiffSnapshotCache && this._monitorDiffSnapshotWi === wiId
      && (Date.now() - (this._monitorDiffSnapshotAt || 0)) < ttlMs;
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
        title: files.length ? `changes ${this._monitorDiffFileIndex + 1}/${files.length}  [↑↓ select · enter open · esc back]` : "changes  [esc back]",
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
      title: `diff${span}  [↑↓ PgUp/Dn scroll · esc files]`,
      count: file ? (file.additions || 0) + (file.deletions || 0) : 0,
      color: C.magenta,
      width,
      rows: view,
      emptyText: "empty diff",
      fixedRows: content,
    });
  }

  // ── Verdict-gate diff ([d] on a prompt that judges code) ──
  // The full-width middle pane while the active prompt's diff is open, or null.
  _buildGateReviewDiffPane(width, height) {
    const q = this._activeQ;
    const view = this._gateReviewDiffView;
    if (this._inputMode !== "question" || !q?.reviewDiff || view?.questionId !== q.id) return null;
    const content = Math.max(1, (height | 0) - 4);
    const lines = gateReviewDiffLines(this, q, Math.max(8, width - 4));
    const maxScroll = Math.max(0, lines.length - content);
    view.scroll = clamp(view.scroll, 0, maxScroll);
    const span = maxScroll > 0
      ? ` ${view.scroll + 1}-${Math.min(lines.length, view.scroll + content)}/${lines.length}`
      : "";
    return this._monitorBoxedLane({
      title: `gate #${q.jobId} change under review${span}  [↑↓ PgUp/Dn scroll · d/esc back to the question]`,
      count: null,
      color: C.magenta,
      width,
      rows: lines.slice(view.scroll, view.scroll + content),
      emptyText: "no diff",
      fixedRows: content,
    });
  }

  _buildMonitorFocusLines(agent, width, height = 18) {
    // The status/phase header folded into the agent card (row 2), so the focus
    // pane can devote its remaining rows to the selected agent. Actions live in
    // the stable header above; accounting owns the reserved lower-right rows.
    const bodyH = Math.max(0, height);
    const body = [];
    if (bodyH >= 5) {
      body.push(...this._buildMonitorFeedbackToolLanes(agent, width, bodyH));
    }

    const out = body.slice(0, bodyH);
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



}
