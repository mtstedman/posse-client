// The session console's landing screen: one glance at who is in the session,
// what each of them is running, what is waiting on you, and how to leave.
// Pure formatting over data the console already holds (the Remote's member
// list, the relayed peer snapshot, the derived sync state, and this clone's
// own advertised work), so any surface can render it.

import { SESSION_SYNC_GLYPHS, SESSION_SYNC_STATES } from "../../../catalog/session-sync.js";
import { formatPeerSyncRow } from "./sync-state.js";
import { sessionMemberLabel } from "./session-console.js";

const RUNNING_JOB_STATUSES = new Set(["leased", "running", "awaiting_assessment"]);
const WAITING_JOB_STATUSES = new Set(["waiting_on_human", "waiting_on_review"]);
const NAME_WIDTH_MAX = 36;

function quoted(text, max = 48) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return `"${value.length > max ? `${value.slice(0, max - 1)}…` : value}"`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Approvals and questions waiting on this participant. */
export function waitingApprovals(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => (
    job?.job_type === "human_input" || WAITING_JOB_STATUSES.has(job?.status)
  ));
}

/**
 * What one participant is doing, from the work it advertises: the task it is
 * working on, else how many tasks it has queued, else idle; plus approvals it
 * is waiting on.
 */
export function describeParticipantWork({ work_items: workItems = [], jobs = [] } = {}) {
  const items = Array.isArray(workItems) ? workItems : [];
  const running = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => RUNNING_JOB_STATUSES.has(job?.status) && job?.job_type !== "human_input");
  let text;
  if (running.length > 0) {
    const job = running[0];
    const item = items.find((candidate) => Number(candidate.id) === Number(job.work_item_id));
    text = `working on ${quoted(item?.title || job.title)} (${job.job_type || "job"})`
      + (running.length > 1 ? ` +${running.length - 1} more` : "");
  } else if (items.length > 0) {
    text = `${plural(items.length, "task")} queued`;
  } else {
    text = "idle";
  }
  const waiting = waitingApprovals(jobs).length;
  return waiting > 0 ? `${text} · ${waiting} waiting for approval` : text;
}

const SHORT_SYNC_WORDS = Object.freeze({
  [SESSION_SYNC_STATES.SYNCED]: "synced",
  [SESSION_SYNC_STATES.HELD]: "held",
  [SESSION_SYNC_STATES.BLOCKED]: "blocked",
  [SESSION_SYNC_STATES.DIVERGED]: "diverged",
  [SESSION_SYNC_STATES.DISCONNECTED]: "disconnected",
  [SESSION_SYNC_STATES.STALE]: "stale",
  [SESSION_SYNC_STATES.PUBLISHING]: "publishing",
  [SESSION_SYNC_STATES.NOT_SYNCING]: "not syncing",
  [SESSION_SYNC_STATES.UNKNOWN]: "syncing",
});

/** The console prompt, carrying the live state: `  [● synced · 3 in session] posse> `. */
export function sessionPrompt({ sync = null, peopleCount = 1, observing = false } = {}) {
  const people = `${peopleCount} in session`;
  if (observing) return `  [▶ posse go running · ${people}] posse> `;
  const state = sync?.state || SESSION_SYNC_STATES.UNKNOWN;
  const glyph = SESSION_SYNC_GLYPHS[state] || SESSION_SYNC_GLYPHS[SESSION_SYNC_STATES.UNKNOWN];
  const word = state === SESSION_SYNC_STATES.BEHIND
    ? `${sync?.behind ?? "?"} behind`
    : SHORT_SYNC_WORDS[state] || state;
  return `  [${glyph} ${word} · ${people}] posse> `;
}

function participantRows({ role, members, peersSync, peers, local }) {
  const workByInstance = new Map((Array.isArray(peers) ? peers : [])
    .map((peer) => [String(peer?.instance_id || ""), peer]));
  const syncByInstance = new Map((Array.isArray(peersSync) ? peersSync : [])
    .map((peer) => [String(peer?.instance_id || ""), peer]));
  const rows = [{ name: `you (${role === "host" ? "host" : "member"})`, detail: describeParticipantWork(local) }];
  const listed = new Set();
  const peerRow = (instanceId, fallbackName) => {
    const synced = syncByInstance.get(instanceId);
    const work = workByInstance.get(instanceId);
    if (!synced && !work) return { name: fallbackName, detail: "connecting…" };
    // formatPeerSyncRow already names the peer and gives its sync and age.
    const [name, ...rest] = formatPeerSyncRow({ ...(synced || { instance_id: instanceId, label: work?.label }), role: null })
      .split(" · ");
    return { name, detail: [describeParticipantWork(work || {}), ...rest].join(" · ") };
  };
  if (role === "host") {
    for (const member of (Array.isArray(members) ? members : []).filter((entry) => entry?.state === "admitted")) {
      const instanceId = String(member.instance_id || "");
      listed.add(instanceId);
      rows.push(peerRow(instanceId, sessionMemberLabel(member)));
    }
  }
  for (const instanceId of new Set([...syncByInstance.keys(), ...workByInstance.keys()])) {
    if (!instanceId || listed.has(instanceId)) continue;
    const row = peerRow(instanceId, "peer");
    const peerRole = syncByInstance.get(instanceId)?.role || workByInstance.get(instanceId)?.role;
    rows.push(peerRole === "host" ? { ...row, name: `${row.name} (host)` } : row);
  }
  return rows;
}

/**
 * The landing screen as lines (no colors): session and connection, everyone
 * in it and what they run, what needs you, and the next things to type.
 */
export function formatSessionLanding({
  role = "member",
  sessionCode = null,
  branch = null,
  sync = null,
  peersSync = [],
  peers = [],
  members = [],
  local = { work_items: [], jobs: [] },
  scopeLabel = null,
  observing = false,
  // Host only: how merge/deploy run ("merge: you approve · deploy: auto"),
  // and why auto mode paused, if it did.
  publishLabel = null,
  publishPaused = null,
} = {}) {
  const host = role === "host";
  const lines = [];
  lines.push(`── Session ${sessionCode ? `${sessionCode} · ` : ""}${host ? "you are hosting" : "you are a member"}`
    + `${branch ? ` · branch ${branch}` : ""} ──`);
  const disconnected = sync?.state === SESSION_SYNC_STATES.DISCONNECTED;
  // The derived label already leads with its state glyph.
  const syncText = sync?.label ? `this folder ${sync.label}` : "this folder: first sync in progress";
  lines.push(`Connection: ${disconnected ? `${SESSION_SYNC_GLYPHS[SESSION_SYNC_STATES.DISCONNECTED]} reconnecting` : "connected"}`
    + ` · ${syncText}`
    + `${observing ? " · posse go (another terminal) is running this session" : ""}`);
  const rows = participantRows({ role, members, peersSync, peers, local });
  const width = Math.min(NAME_WIDTH_MAX, Math.max(...rows.map((row) => row.name.length)));
  lines.push(`In this session (${rows.length}):`);
  for (const row of rows) {
    const name = row.name.length > width ? `${row.name.slice(0, width - 1)}…` : row.name.padEnd(width);
    lines.push(`  ${name}  ${row.detail}`);
  }
  if (host) {
    const pending = (Array.isArray(members) ? members : []).filter((member) => member?.state === "pending");
    if (pending.length > 0) {
      lines.push(`Waiting to join: ${pending.map(sessionMemberLabel).join(", ")} · type the countersign they read to you`);
    }
    if (publishLabel) lines.push(`Publishing: ${publishLabel}`);
    if (publishPaused) lines.push(`Needs you: auto paused (${publishPaused}) · fix it, then auto merge on / auto deploy on`);
  } else if (scopeLabel) {
    lines.push(`You can change: ${scopeLabel}`);
  }
  const waiting = waitingApprovals(local?.jobs).length;
  if (waiting > 0) {
    lines.push(`Needs you: ${plural(waiting, "approval")} waiting · type go to answer ${waiting === 1 ? "it" : "them"} in the run screen`);
  }
  const queued = (Array.isArray(local?.work_items) ? local.work_items : []).length;
  const start = queued > 0 ? `go (run your ${plural(queued, "task")})` : "go";
  lines.push(observing
    ? "Next: add <task> · status · Ctrl+C detaches this console (posse go keeps the session)"
    : `Next: add <task> · ${start} · hold · ${host ? "merge · deploy · close (end the session for everyone, integrate its work)" : "leave (disconnect)"} · help`);
  return lines;
}
