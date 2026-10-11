import { C } from "../../../../shared/format/functions/colors.js";
import { normalizeAgentActivitySummary } from "../../../../catalog/event.js";

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
  // Amber = needs the operator. A routine question is not an error, so it must
  // not scream red — red stays reserved for genuine failures (merge failed,
  // killed) to keep its alarm value.
  if (state === "ask") return { label: "ASK", color: C.yellow, rail: C.yellow };
  if (state === "nudge") return { label: "nudge", color: C.yellow, rail: C.yellow };
  if (state === "done") return { label: "done", color: C.dim, rail: C.dim };
  if (state === "partial") return { label: "partial", color: C.yellow, rail: C.yellow };
  if (state === "failed") return { label: "failed", color: C.red, rail: C.red };
  if (state === "canceled") return { label: "canceled", color: C.dim, rail: C.dim };
  if (state === "idle") return { label: "idle", color: C.dim, rail: C.dim };
  return { label: "live", color: C.green, rail: C.green };
}

// Short WI state chip for the focus-pane agent card. Mirrors the locks-pane
// state logic: the merge_state explains why a finished WI still holds work
// (pending review / merge failed), otherwise the live status. Returns
// { text, color } or null when "running" (the card header already says so).
function monitorWiStateChip(agent = {}) {
  const merge = String(agent.wiMergeState || "").toLowerCase();
  const status = String(agent.wiStatus || agent.status || "").toLowerCase();
  if (merge === "pending_review") return { label: "pending review", color: C.yellow };
  if (merge === "merge_failed") return { label: "merge failed", color: C.red };
  if (merge === "merged") return { label: "merged", color: C.green };
  if (status && status !== "running") return { label: status, color: C.dim };
  return null;
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

// The stored event summary is the normalized form of the interaction body
// (whitespace collapsed, capped at SUMMARY_CHARS), so both sides of the key
// must go through the same transform or long/multiline bodies never match.
function monitorActivityEventDedupKey({ actorId = null, interactionId = null, agentCallId = null, body = "" } = {}) {
  return `${actorId ?? interactionId ?? ""}\u001f${agentCallId ?? ""}\u001f${normalizeAgentActivitySummary(body) || ""}`;
}

// Bossy consumes the versioned agent.activity event stream, while explicit
// agent_feedback calls also create interaction rows for local coordination.
// Merge both sources so Posse shows provider-native commentary too, and use the
// interaction id carried as the event actor id to suppress the explicit-tool
// duplicate.
function mergeMonitorAgentActivityEvents(interactionRows = [], activityEvents = []) {
  const represented = new Set(
    interactionRows
      .filter((row) => row.direction === "agent_to_user" && row.kind === "activity")
      .map((row) => monitorActivityEventDedupKey({
        interactionId: row.id,
        agentCallId: row.agent_call_id,
        body: row.body,
      })),
  );
  const eventRows = activityEvents
    .filter((event) => !represented.has(monitorActivityEventDedupKey({
      actorId: event.actor_id,
      agentCallId: event.activity.agent_call_id,
      body: event.activity.summary,
    })))
    .map((event) => ({
      id: `agent-activity:${event.id ?? `${event.created_at || ""}:${event.activity.summary}`}`,
      _kind: "agent_activity",
      direction: "agent_to_user",
      kind: "activity",
      status: event.activity.status,
      source: "agent_activity",
      author: event.actor_type || "agent",
      body: event.activity.summary,
      activity_kind: event.activity.kind,
      activity_phase: event.activity.phase || null,
      agent_call_id: event.activity.agent_call_id ?? null,
      created_at: event.created_at,
    }));
  return [...interactionRows, ...eventRows].sort((a, b) => {
    const timeDelta = (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0);
    if (timeDelta !== 0) return timeDelta;
    return String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
}

// What an OCCUPIED slot's agent is doing right now, for the fleet rail tag.
// "waiting" = blocked on the operator (ask); "nudge" = a redirect is queued;
// otherwise an IN-FLIGHT tool call reads as "tool call" and anything else as
// "thinking". We key off whether a tool is *currently running* (an in-flight
// observation), NOT whether the last recorded event happened to be a tool —
// tool rows dominate the stream and never get a "thinking" counter-event, so
// last-event logic stuck the tag on "tool call" forever after the first call.
// The two live states breathe (glyph pulses off the render tick); waiting and
// nudge sit still so a parked agent reads as parked at a glance. Both parked
// states are amber (attention, not failure); "waiting" is bolded so the agent
// blocked on the operator still outranks a mere queued nudge.
function monitorActivityState(agent, spinIdx) {
  if (agent.state === "ask") return { label: "waiting", color: C.yellow, glyph: "◉", bold: true };
  if (agent.state === "nudge") return { label: "nudge", color: C.yellow, glyph: "◆" };
  if (agent.inFlightTool) {
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



export {
  formatElapsed, compactTime, roleLabel, monitorStateMeta, monitorWiStateChip,
  monitorPulse, fmtAgo, fmtDur, latestStamp, mergeMonitorAgentActivityEvents,
  monitorActivityState, monitorFeedbackMeta, monitorFeedbackSuffix,
};
