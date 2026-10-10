// What any Posse command run in a paired folder can say about the session:
// who is in it, what each of them runs, and whether this folder is current.
// Read from the database only (the pairing row, the relayed peer snapshot,
// this clone's own queue); never the network. `posse status` and `posse
// queue` show it so a member's work is visible to the host, and the host's
// to a member, in the same places as local work.

import { readSessionSync } from "./session-sync.js";
import { formatSessionParticipants } from "./session-landing.js";
import { getLivePairingState } from "./state.js";
import {
  collectPairingJobs,
  collectPairingWorkItems,
  readPairingPeerSnapshot,
} from "./work-items.js";

const RUNNING_JOB_STATUSES = new Set(["leased", "running", "awaiting_assessment"]);

/** Null outside an active session. */
export function collectSessionView({
  state = getLivePairingState(),
  snapshot = readPairingPeerSnapshot(),
  nowMs = Date.now(),
} = {}) {
  if (!state || state.phase !== "active") return null;
  let derived = null;
  try {
    derived = readSessionSync({ state, snapshot, nowMs });
  } catch { /* the sync indicator is advisory */ }
  let local = { work_items: [], jobs: [] };
  try {
    local = { work_items: collectPairingWorkItems(), jobs: collectPairingJobs() };
  } catch { /* an unreadable queue shows as idle */ }
  return {
    session_id: state.remote_session_id,
    role: state.role,
    branch: state.shared_branch,
    // The peer snapshot is written by the session console or posse go while
    // one runs here; without one, nothing current is known about the others.
    live: Boolean(snapshot),
    sync: derived?.sync || null,
    peers_sync: derived?.peers_sync || [],
    peers: Array.isArray(snapshot?.peers) ? snapshot.peers : [],
    local,
  };
}

function peerName(peer) {
  const label = String(peer?.label || "").trim();
  const machine = String(peer?.instance_id || "").replace(/^posse-/u, "").slice(0, 8);
  return (label && label !== peer?.instance_id ? label : "") || (machine ? `machine ${machine}` : "peer");
}

/** The others' work items, one line each, with the job running on it. */
export function formatSessionPeerWorkLines(view) {
  const lines = [];
  for (const peer of view?.peers || []) {
    const name = `${peerName(peer)}${peer.role === "host" ? " (host)" : ""}`;
    for (const workItem of peer.work_items || []) {
      const running = (peer.jobs || []).find((job) => (
        Number(job.work_item_id) === Number(workItem.id) && RUNNING_JOB_STATUSES.has(job.status)
      ));
      const detail = running ? `${workItem.status} · ${running.job_type} running` : workItem.status;
      lines.push(`${name}: [WI#${workItem.id}] ${String(workItem.title || "").slice(0, 60)} (${detail})`);
    }
  }
  return lines;
}

/** The session block as lines (no colors); empty outside a session. */
export function formatSessionViewLines(view) {
  if (!view) return [];
  const lines = [
    `You are ${view.role === "host" ? "hosting" : "a member"} · branch ${view.branch}`
      + (view.sync?.label ? ` · this folder ${view.sync.label}` : ""),
  ];
  if (!view.live) {
    lines.push("Others' work shows while the session console or posse go runs in this folder.");
    return lines;
  }
  lines.push(...formatSessionParticipants({
    role: view.role, peers: view.peers, peersSync: view.peers_sync, local: view.local,
  }));
  const work = formatSessionPeerWorkLines(view);
  if (work.length > 0) {
    lines.push("Their work (read-only here):");
    lines.push(...work.map((line) => `  ${line}`));
  }
  return lines;
}
