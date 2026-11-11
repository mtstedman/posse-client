// The session participant roster: one row per person (the host and every
// member, pending ones included) with role, admission, compute lease, whether
// their scheduler runs, and work counts. A pure projection of data the session
// already exchanges: the host's member list, the relayed peer snapshot, this
// clone's pairing row and its own advertised work. The session console's
// `who` block and the `posse go` Session mode both render it.
//
// Every row carries what a host action on it would need: a stable `id` (the
// participant's instance id), `is_host`, the host's `member_id` for it, its
// admission and the lease as issued.

import { ACTIVE_LEASE_STATUSES } from "../../../catalog/job.js";
import { PAIRING_JOB_LIMIT, PAIRING_WORK_ITEM_LIMIT } from "../../../catalog/pairing-presence.js";
import {
  SESSION_PANEL_LAYOUT,
  SESSION_ROSTER_ADMISSIONS,
  SESSION_ROSTER_PRESENCE,
  SESSION_ROSTER_SCHEDULER_EVIDENCE,
  SESSION_ROSTER_SCHEDULER_STATES,
} from "../../../catalog/session-roster.js";
import {
  SESSION_COMPUTE_OWNERS,
  SESSION_SYNC_POLICY,
  defaultSessionComputeOwner,
} from "../../../catalog/session-sync.js";
import { displayColumnWidth, stripAnsi } from "../../../shared/format/functions/ansi.js";
import { normalizeComputeOwner, ownComputeOwner, peerComputeOwner } from "./compute-lease.js";
import { shortId, shortInstanceId } from "./session-console.js";
import { waitingApprovals } from "./session-landing.js";

const RUNNING_JOB_STATUSES = new Set(ACTIVE_LEASE_STATUSES);
const WAITING_WORK_ITEM_STATUSES = new Set(["waiting_on_human", "waiting_on_review"]);
const { PENDING, ADMITTED } = SESSION_ROSTER_ADMISSIONS;
const SCHEDULER = SESSION_ROSTER_SCHEDULER_STATES;
const EVIDENCE = SESSION_ROSTER_SCHEDULER_EVIDENCE;
const PRESENCE = SESSION_ROSTER_PRESENCE;

function list(value) {
  return Array.isArray(value) ? value : [];
}

// Labels cross the relay: nothing in one may move the cursor or span lines.
function plainText(value) {
  return stripAnsi(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function executing(job) {
  return RUNNING_JOB_STATUSES.has(job?.status) && job?.job_type !== "human_input";
}

// A job outside any work item still counts once, under its own key.
function workKey(job) {
  return job?.work_item_id == null ? `job:${job?.id}` : `wi:${Number(job.work_item_id)}`;
}

/**
 * Work counts from what a participant advertises (non-terminal work items and
 * jobs): work items with a job executing now, work items waiting on a person
 * (an approval or question), and the rest, which are not running. A work item
 * can be both running and waiting. `capped` marks an advert that hit the
 * relay's size limit, so the true numbers may be higher.
 */
export function countParticipantWork({ work_items: workItems = [], jobs = [] } = {}) {
  const items = list(workItems);
  const running = new Set(list(jobs).filter(executing).map(workKey));
  const waiting = new Set(waitingApprovals(jobs).map(workKey));
  for (const item of items) {
    if (WAITING_WORK_ITEM_STATUSES.has(item?.status)) waiting.add(`wi:${Number(item.id)}`);
  }
  const queued = items.filter((item) => {
    const key = `wi:${Number(item?.id)}`;
    return !running.has(key) && !waiting.has(key);
  }).length;
  return {
    running: running.size,
    queued,
    waiting: waiting.size,
    capped: items.length >= PAIRING_WORK_ITEM_LIMIT || list(jobs).length >= PAIRING_JOB_LIMIT,
  };
}

function peerLabel(peer, instanceId) {
  const label = plainText(peer?.label);
  // Until a peer's first full heartbeat the relay may echo its instance id.
  return (label && label !== instanceId ? label : "") || `machine ${shortInstanceId(instanceId)}`;
}

function peerPresence(peer) {
  if (!peer) return PRESENCE.CONNECTING;
  const age = peer.last_seen_age_sec;
  return Number.isFinite(age) && age > SESSION_SYNC_POLICY.PEER_STALE_AFTER_SEC ? PRESENCE.AWAY : PRESENCE.LIVE;
}

// A peer's scheduler is not exchanged. A job in an executing status proves it
// runs; anything else leaves it unknown.
function peerScheduler(peer) {
  return list(peer?.jobs).some(executing)
    ? { scheduler: SCHEDULER.RUNNING, scheduler_evidence: EVIDENCE.ACTIVE_JOBS }
    : { scheduler: SCHEDULER.UNKNOWN, scheduler_evidence: EVIDENCE.NONE };
}

function peerRow({ peer, member = null, instanceId, computePolicy }) {
  const role = (member?.role || peer?.role) === "host" ? "host" : "member";
  // The member list carries the lease as issued; a peer row alone carries
  // only the owner the Remote resolved, so "default" cannot be told from here.
  const lease = member ? normalizeComputeOwner(member.compute_lease) : null;
  const computeOwner = role === "host"
    ? SESSION_COMPUTE_OWNERS.HOST
    : lease
      || normalizeComputeOwner(member?.compute_owner)
      || peerComputeOwner(peer, computePolicy)
      || defaultSessionComputeOwner(computePolicy);
  return {
    id: instanceId || `member:${member?.id || ""}`,
    self: false,
    is_host: role === "host",
    label: peerLabel(peer, instanceId),
    short_id: member?.id ? shortId(member.id) : shortInstanceId(instanceId),
    member_id: member?.id ? String(member.id) : null,
    instance_id: instanceId || null,
    role,
    admission: ADMITTED,
    lease: role === "host" ? null : lease,
    lease_known: role === "host" || Boolean(member),
    countersign: null,
    compute_owner: computeOwner,
    ...peerScheduler(peer),
    presence: peerPresence(peer),
    work: peer ? countParticipantWork(peer) : null,
  };
}

function pendingRow(member) {
  const instanceId = String(member.instance_id || "");
  return {
    id: instanceId || `member:${member.id}`,
    self: false,
    is_host: false,
    label: `machine ${shortInstanceId(instanceId)}`,
    short_id: shortId(member.id),
    member_id: String(member.id),
    instance_id: instanceId || null,
    role: "member",
    admission: PENDING,
    // The host issues the lease with the admission; there is none before it.
    lease: null,
    lease_known: true,
    // The Remote's member list does not carry a pending member's countersign
    // today (the joiner reads it to the host); it is passed on if it ever does.
    countersign: typeof member.countersign === "string" && member.countersign ? member.countersign : null,
    compute_owner: null,
    scheduler: SCHEDULER.UNKNOWN,
    scheduler_evidence: EVIDENCE.NONE,
    presence: PRESENCE.WAITING_FOR_HOST,
    work: null,
  };
}

/**
 * Build the roster.
 *
 * @param {object} input
 * @param {"host"|"member"} input.role This clone's role.
 * @param {object} [input.self] This clone: `instance_id`, `compute_owner` (the
 *   pairing row's), `compute_lease` (the lease the last heartbeat reported;
 *   leave undefined when no heartbeat of this process is at hand),
 *   `scheduler_running` (this clone's scheduler lock), `work_items`, `jobs`.
 * @param {string} [input.computePolicy] The session policy, for default leases.
 * @param {object[]} [input.members] The host's member list (empty for members).
 * @param {object[]} [input.peers] The relayed peer snapshot.
 * @returns {{ rows: object[], admitted_count: number, pending_count: number, compute_policy: string|null }}
 */
export function buildSessionRoster({
  role = "member",
  self = {},
  computePolicy = null,
  members = [],
  peers = [],
} = {}) {
  const host = role === "host";
  const selfLease = host ? null : normalizeComputeOwner(self?.compute_lease);
  const selfRow = {
    id: String(self?.instance_id || "self"),
    self: true,
    is_host: host,
    label: "you",
    short_id: shortInstanceId(self?.instance_id),
    member_id: null,
    instance_id: self?.instance_id ? String(self.instance_id) : null,
    role: host ? "host" : "member",
    admission: ADMITTED,
    lease: selfLease,
    lease_known: host || self?.compute_lease !== undefined,
    countersign: null,
    compute_owner: ownComputeOwner({ role, compute_owner: self?.compute_owner, compute_policy: computePolicy }),
    scheduler: self?.scheduler_running == null
      ? SCHEDULER.UNKNOWN
      : self.scheduler_running ? SCHEDULER.RUNNING : SCHEDULER.STOPPED,
    scheduler_evidence: self?.scheduler_running == null ? EVIDENCE.NONE : EVIDENCE.SCHEDULER_LOCK,
    presence: PRESENCE.LIVE,
    work: countParticipantWork(self || {}),
  };
  const peerByInstance = new Map(list(peers)
    .filter((peer) => peer?.instance_id && String(peer.instance_id) !== selfRow.instance_id)
    .map((peer) => [String(peer.instance_id), peer]));
  const pending = [];
  const admitted = [];
  const listed = new Set();
  for (const member of list(members)) {
    if (!member?.id) continue;
    const instanceId = String(member.instance_id || "");
    if (instanceId && instanceId === selfRow.instance_id) continue;
    if (member.state === PENDING) {
      listed.add(instanceId);
      pending.push(pendingRow(member));
    } else if (member.state === ADMITTED) {
      listed.add(instanceId);
      admitted.push(peerRow({ peer: peerByInstance.get(instanceId), member, instanceId, computePolicy }));
    }
  }
  // Peers the member list does not name: everyone, from a member's seat (which
  // has no member list), with the host first.
  const unlisted = [...peerByInstance.entries()]
    .filter(([instanceId]) => !listed.has(instanceId))
    .map(([instanceId, peer]) => peerRow({ peer, instanceId, computePolicy }));
  unlisted.sort((a, b) => Number(b.role === "host") - Number(a.role === "host"));
  // Pending requests need the host, so they are never the rows that overflow.
  const rows = [selfRow, ...pending, ...unlisted.filter((row) => row.role === "host"), ...admitted,
    ...unlisted.filter((row) => row.role !== "host")];
  return {
    rows,
    admitted_count: rows.length - pending.length,
    pending_count: pending.length,
    compute_policy: computePolicy || null,
  };
}

/** Cut `text` to `width` terminal columns, ending in an ellipsis when cut. */
export function fitRosterText(text, width) {
  const value = String(text ?? "");
  const limit = Math.max(1, Math.floor(Number(width) || 0));
  if (displayColumnWidth(value) <= limit) return value;
  let out = "";
  for (const char of value) {
    if (displayColumnWidth(out + char) > limit - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

// The `go` column, at most seven characters wide.
function runText(row) {
  if (row.admission === PENDING) return "pending";
  if (row.presence === PRESENCE.CONNECTING) return "joining";
  if (row.scheduler === SCHEDULER.RUNNING) return "running";
  if (row.scheduler === SCHEDULER.STOPPED) return "stopped";
  // A peer does not say whether its scheduler is up, and the relay may have
  // lost touch with it; say what is known.
  return row.presence === PRESENCE.AWAY ? "away" : "unknown";
}

function countText(row, field) {
  return row.work ? `${row.work[field]}${row.work.capped ? "+" : ""}` : "-";
}

function computeText(row) {
  if (!row.compute_owner) return "-";
  const own = row.role === "host" || row.compute_owner === SESSION_COMPUTE_OWNERS.MEMBER;
  const fromPolicy = row.role !== "host" && row.lease_known && !row.lease;
  return `${own ? "own" : "host"}${fromPolicy ? " (default)" : ""}`;
}

// Columns in the order they survive a narrow window: what people are doing
// first, the id the host types for kick and lease last.
const ROSTER_COLUMNS = Object.freeze([
  { head: "who", cell: (row) => fitRosterText(row.label, SESSION_PANEL_LAYOUT.LABEL_WIDTH_MAX) },
  { head: "role", cell: (row) => row.role },
  { head: "go", cell: runText },
  { head: "run", right: true, cell: (row) => countText(row, "running") },
  { head: "queued", right: true, cell: (row) => countText(row, "queued") },
  { head: "waiting", right: true, cell: (row) => countText(row, "waiting") },
  { head: "runs on", cell: computeText },
  { head: "id", cell: (row) => row.member_id ? row.short_id : "" },
]);

/** The header: who is here and who waits, without a session code if none. */
export function formatSessionRosterHeader(roster, { sessionCode = null } = {}) {
  const pending = Number(roster?.pending_count) || 0;
  return `Roster${sessionCode ? ` ${sessionCode}` : ""} · ${Number(roster?.admitted_count) || 0} in session`
    + (pending > 0 ? ` · ${pending} waiting to join` : "");
}

/**
 * The roster as plain lines (no colors): a header, the column names, and one
 * line per person, columns aligned, every line cut to `width` columns. More
 * people than `maxRows` end in a "+N more" line; pending requests are listed
 * first so they are never the ones cut.
 *
 * Columns: `go` is the scheduler (running, stopped, or unknown for a peer
 * with nothing executing); `run`, `queued` and `waiting` count work items
 * executing now, not running, and waiting on a person; `runs on` is whose
 * computer and provider account run that person's work.
 */
export function formatSessionRosterLines(roster, {
  width = 80,
  maxRows = SESSION_PANEL_LAYOUT.MAX_PARTICIPANT_ROWS,
  sessionCode = null,
  header = true,
  // Draw the header as a rule across the width, to set a pinned panel apart.
  rule = false,
  indent = "  ",
  moreHint = "type who",
} = {}) {
  const rows = list(roster?.rows);
  const limit = Math.max(1, Math.floor(Number(maxRows) || 1));
  const shown = rows.length > limit ? rows.slice(0, Math.max(1, limit - 1)) : rows;
  // Nobody has an id to show from a member's seat: drop the empty column.
  const columns = ROSTER_COLUMNS.filter((column) => column.head !== "id" || shown.some((row) => row.member_id));
  const table = [columns.map((column) => column.head), ...shown.map((row) => columns.map((column) => column.cell(row)))];
  const widths = columns.map((_, index) => Math.max(...table.map((cells) => displayColumnWidth(cells[index]))));
  const lines = [];
  if (header) {
    const title = formatSessionRosterHeader(roster, { sessionCode });
    const ruled = `── ${title} `;
    lines.push(fitRosterText(
      rule ? ruled + "─".repeat(Math.max(2, Math.floor(width) - displayColumnWidth(ruled))) : title,
      width,
    ));
  }
  for (const cells of table) {
    const text = cells.map((cell, index) => {
      const pad = " ".repeat(widths[index] - displayColumnWidth(cell));
      return columns[index].right ? pad + cell : cell + pad;
    }).join("  ").trimEnd();
    lines.push(fitRosterText(`${indent}${text}`, width));
  }
  if (shown.length < rows.length) {
    const hidden = rows.length - shown.length;
    lines.push(fitRosterText(
      `${indent}+${hidden} more ${hidden === 1 ? "person" : "people"}${moreHint ? ` · ${moreHint}` : ""}`,
      width,
    ));
  }
  return lines;
}

/**
 * What a change-driven surface compares: who is in, their admission and
 * lease. Work counts and run state are left out on purpose: they follow every
 * job that starts or ends, and a feed block reprinted that often would bury
 * the feed.
 */
export function sessionRosterMembershipKey(roster) {
  return JSON.stringify(list(roster?.rows).map((row) => [
    row.id, row.role, row.admission, row.lease, row.compute_owner,
    row.presence === PRESENCE.CONNECTING,
  ]));
}

/**
 * The roster as the session console's panel takes it (see
 * createSessionPanel().update): how to render it at a window size, and the
 * key a change-driven block reprint follows.
 */
export function sessionRosterPanelView(roster, { sessionCode = null } = {}) {
  return {
    key: sessionRosterMembershipKey(roster),
    render: ({ columns = 100, maxRows = SESSION_PANEL_LAYOUT.MAX_PARTICIPANT_ROWS } = {}) => (
      formatSessionRosterLines(roster, { width: Math.max(1, columns - 2), maxRows, sessionCode, rule: true })
        .map((line) => `  ${line}`)
    ),
  };
}
