import { C } from "../../../../shared/format/functions/colors.js";
import { fit, _sanitizeDisplayLine } from "./helpers/formatters.js";
import { brandRule } from "./helpers/brand.js";
import { formatPeerSyncRow } from "../../../pairing/functions/sync-state.js";

const SESSION_PEER_SYNC_ROWS = 8;

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



function sessionPairingDashboardLines(session, peerRows, width) {
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
    lines.push(fit(` ${C.yellow}${C.bold}! ${pending} join request${pending === 1 ? "" : "s"} waiting${C.reset}  ${C.dim}\u00b7 [U] SESSION \u2192 ADMIT <CODE>${C.reset}`, width));
  }

  const peersSync = Array.isArray(session?.peers_sync) ? session.peers_sync : [];
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
    ? "STATUS  ADMIT  INVITE  POLICY  CLOSE"
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


export { sessionSyncLabel, sessionPairingDashboardLines, unpairedPipelineLines };
