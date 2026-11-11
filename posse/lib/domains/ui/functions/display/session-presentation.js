import { C } from "../../../../shared/format/functions/colors.js";
import { fit, _sanitizeDisplayLine } from "./helpers/formatters.js";
import { brandRule } from "./helpers/brand.js";
import { formatPeerSyncRow } from "../../../pairing/functions/sync-state.js";
import { formatSessionRosterLines } from "../../../pairing/functions/session-roster.js";
import { SESSION_PANEL_LAYOUT } from "../../../../catalog/session-roster.js";

const SESSION_PEER_SYNC_ROWS = 8;

// Everyone in the session, one row each: role, run state, work counts and
// compute lease (the session console's control panel, inside the run screen).
// `selectedId` marks that participant's row; `onSelectedLine` is told its
// index among the returned lines.
function sessionRosterDashboardLines(session, width, { selectedId = null, onSelectedLine = null } = {}) {
  const roster = session?.participants;
  if (!Array.isArray(roster?.rows) || roster.rows.length === 0) return [];
  const selectedIndex = selectedId == null ? -1 : roster.rows.findIndex((row) => row?.id === selectedId);
  const rows = formatSessionRosterLines(roster, {
    width: Math.max(8, width - 4),
    // The pipeline pane scrolls, so it can afford more rows than the console.
    maxRows: SESSION_PANEL_LAYOUT.MAX_PARTICIPANT_ROWS * 3,
    header: false,
    indent: "",
    moreHint: "",
  });
  return rows.map((row, index) => {
    const color = index === 0 ? C.dim : /\bpending\b/u.test(row) ? C.yellow : "";
    // Line 0 is the column header; a row cut off by "+N more" has no line.
    const selected = index > 0 && index - 1 === selectedIndex && !/^\+\d+ more /u.test(row);
    if (!selected) return fit(` ${C.magenta}\u2502${C.reset} ${color}${_sanitizeDisplayLine(row)}${C.reset}`, width);
    onSelectedLine?.(index);
    return fit(` ${C.cyan}${C.bold}\u25b6 ${color}${_sanitizeDisplayLine(row)}${C.reset}`, width);
  });
}

// The derived session sync indicator; "trunk <status>" only for a summary
// written before the indicator existed.
function sessionSyncLabel(session) {
  const label = typeof session?.sync?.label === "string" ? session.sync.label : "";
  return label ? _sanitizeDisplayLine(label) : `trunk ${session?.trunk_health?.status || "pending"}`;
}



function sessionPairingStatusColor(session) {
  const state = String(session?.sync?.state || session?.trunk_health?.status || "").toLowerCase();
  if (["disconnected", "blocked", "failed"].includes(state)) return C.red;
  if (["behind", "held", "stale", "not_syncing", "not-syncing"].includes(state)) return C.yellow;
  if (["synced", "healthy"].includes(state)) return C.green;
  return C.cyan;
}



/** One peer work item, as the paired-work lane and Session mode both show it. */
function peerWorkSummary(wi) {
  const job = (Array.isArray(wi?.jobs) ? wi.jobs : [])[0];
  const jobSummary = job ? ` \u2014 ${job.job_type}/${job.status}: ${job.title}` : "";
  return `${wi.peer_label} WI#${wi.peer_work_item_id} ${wi.status}: ${wi.title}${jobSummary}`;
}

// `roster` adds the participant table (Session mode); the Pipeline view keeps
// the short form.
function sessionPairingDashboardLines(session, peerRows, width, { roster = false, selectedId = null, onSelectedLine = null } = {}) {
  const lines = [brandRule({ label: "session pairing", color: C.magenta, width })];
  const role = session?.role === "host" ? "HOSTING" : "MEMBER";
  const phase = String(session?.phase || "connecting").toUpperCase();
  const sync = sessionSyncLabel(session);
  const statusColor = sessionPairingStatusColor(session);
  const peers = Math.max(0, Number(session?.peer_count) || 0);
  const pending = Math.max(0, Number(session?.pending_count) || 0);
  const delegated = Array.isArray(session?.delegations) ? session.delegations.length : 0;
  const sharedWork = Array.isArray(peerRows) ? peerRows.length : 0;

  lines.push(fit(
    ` ${statusColor}${C.bold}\u25cf ${phase}${C.reset}  ${C.brightWhite}YOU: ${role}${C.reset} ${C.dim}\u00b7${C.reset} ${statusColor}${sync}${C.reset}`,
    width,
  ));
  lines.push(fit(` ${C.dim}BRANCH${C.reset} ${_sanitizeDisplayLine(session?.branch || "session branch pending")}`, width));
  lines.push(fit(
    ` ${C.dim}TEAM${C.reset} ${peers} connected ${C.dim}\u00b7${C.reset} ${sharedWork} active work ${C.dim}\u00b7${C.reset} ${pending} waiting ${C.dim}\u00b7${C.reset} ${delegated} delegated`,
    width,
  ));

  if (pending > 0 && session?.role === "host") {
    const how = roster ? "select the request, [A] admit" : "[U] SESSION \u2192 ADMIT <CODE>";
    lines.push(fit(` ${C.yellow}${C.bold}! ${pending} join request${pending === 1 ? "" : "s"} waiting${C.reset}  ${C.dim}\u00b7 ${how}${C.reset}`, width));
  }

  const rosterStart = lines.length;
  const rosterLines = roster
    ? sessionRosterDashboardLines(session, width, {
      selectedId,
      onSelectedLine: (index) => onSelectedLine?.(rosterStart + index),
    })
    : [];
  lines.push(...rosterLines);

  const peersSync = Array.isArray(session?.peers_sync) ? session.peers_sync : [];
  if (peersSync.length > 0 && rosterLines.length > 0) lines.push(fit(` ${C.dim}SYNC${C.reset}`, width));
  for (const peer of peersSync.slice(0, SESSION_PEER_SYNC_ROWS)) {
    lines.push(fit(` ${C.magenta}\u2502${C.reset} ${_sanitizeDisplayLine(formatPeerSyncRow(peer))}`, width));
  }
  if (peersSync.length > SESSION_PEER_SYNC_ROWS) {
    lines.push(fit(` ${C.magenta}\u2502${C.reset} ${C.dim}+${peersSync.length - SESSION_PEER_SYNC_ROWS} more teammate(s)${C.reset}`, width));
  }

  if (peers === 0 && pending === 0) {
    const invitation = session?.enrollment_open ? "Invites are open" : "Invites are closed";
    lines.push(` ${C.dim}\u25cb Waiting for teammates \u00b7 ${invitation}${C.reset}`);
  } else if (peers > 0 && sharedWork === 0) {
    lines.push(` ${C.green}\u2713 Team connected${C.reset}${C.dim} \u00b7 peer work will appear here when it starts${C.reset}`);
  }

  const controls = session?.role === "host"
    ? "STATUS  ADMIT  LEASE  SCOPE  INVITE  POLICY  MERGE  DEPLOY  AUTO  CLOSE"
    : "STATUS  HOLD  RESUME";
  lines.push(fit(` ${C.cyan}${C.bold}[U] SESSION${C.reset}  ${C.dim}${controls}${C.reset}`, width));
  return lines;
}



function unpairedPipelineLines(width) {
  return [
    brandRule({ label: "work queue", color: C.blue, width }),
    ` ${C.dim}\u25cb No active work items${C.reset}`,
    "",
    brandRule({ label: "session pairing", color: C.magenta, width }),
    ` ${C.brightWhite}${C.bold}Work together from separate clones${C.reset}`,
    ` ${C.dim}Shared branch, live teammate presence, and read-only peer work.${C.reset}`,
    ` ${C.magenta}${C.bold}HOST${C.reset}  ${C.brightWhite}posse session host${C.reset}`,
    ` ${C.magenta}${C.bold}JOIN${C.reset}  ${C.brightWhite}posse session join <code>${C.reset}`,
  ].map((line) => fit(line, width));
}


export { peerWorkSummary, sessionSyncLabel, sessionPairingDashboardLines, unpairedPipelineLines };
