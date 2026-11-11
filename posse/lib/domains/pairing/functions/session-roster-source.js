// Reads the session roster's inputs from what this clone already holds: the
// pairing row, the relayed peer snapshot (written by whichever local process
// heartbeats: the session console or posse go), the host's member list, and
// this clone's own queue. The database only; never the network.

import { buildSessionRoster } from "./session-roster.js";
import { getLivePairingState } from "./state.js";
import {
  collectPairingJobs,
  collectPairingWorkItems,
  readPairingPeerSnapshot,
} from "./work-items.js";

/**
 * @param {object} [options]
 * @param {object} [options.state] The pairing row.
 * @param {object|null} [options.status] This process's last heartbeat status,
 *   when it heartbeats; it carries this clone's lease as issued.
 * @param {object[]|null} [options.members] The host's member list, when this
 *   process fetched one; otherwise the snapshot's copy is used.
 * @param {boolean|null} [options.schedulerRunning] This clone's scheduler lock.
 * @returns {object|null} The roster, or null outside an active session.
 */
export function readSessionRoster({
  state = getLivePairingState(),
  status = null,
  members = null,
  snapshot = readPairingPeerSnapshot(),
  schedulerRunning = null,
} = {}) {
  if (!state || state.phase !== "active") return null;
  let local = { work_items: [], jobs: [] };
  try {
    local = { work_items: collectPairingWorkItems(), jobs: collectPairingJobs() };
  } catch { /* an unreadable queue shows as nothing queued */ }
  return buildSessionRoster({
    role: state.role === "host" ? "host" : "member",
    self: {
      instance_id: state.instance_id,
      compute_owner: status?.compute_owner ?? state.compute_owner,
      // Only a heartbeat status says whether the lease was issued or follows
      // the policy; without one that is left unknown rather than guessed.
      compute_lease: status ? status.compute_lease ?? null : undefined,
      scheduler_running: schedulerRunning,
      ...local,
    },
    computePolicy: status?.compute_policy || snapshot?.compute_policy || state.compute_policy || null,
    members: Array.isArray(members) ? members : snapshot?.members || [],
    peers: snapshot?.peers || status?.peers || [],
  });
}
