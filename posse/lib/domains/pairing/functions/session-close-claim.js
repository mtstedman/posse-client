import {
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  updateRuntimeStatus,
} from "../../queue/functions/runtime-status.js";

// Exactly one process closes and integrates a session at a time. The host
// console, a posse go running `u → close`, `posse session close` from another
// terminal, and crash recovery all end in finishHostShutdown; without a claim
// two of them could freeze and publish the same journal concurrently. The
// claim is an atomic runtime-status row naming the closing process; a row
// whose process is gone no longer counts, so a crashed close never wedges the
// next attempt.

function processAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code !== "ESRCH";
  }
}

function liveClaim(row, stateId, kill) {
  if (!row || typeof row !== "object") return null;
  if (stateId != null && String(row.state_id) !== String(stateId)) return null;
  const pid = Number(row.owner_pid);
  return processAlive(pid, kill) ? row : null;
}

/**
 * Claim the close of `stateId` for `pid`. Re-claiming by the same process is
 * allowed; a live claim by another process is refused.
 * @returns {{ ok: true, claim: object } | { ok: false, ownerPid: number|null, reason: string }}
 */
export function claimSessionClose({
  stateId,
  pid = process.pid,
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  let refusedBy = null;
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CLOSING, (current) => {
    const held = liveClaim(current, stateId, kill);
    if (held && Number(held.owner_pid) !== pid) {
      refusedBy = held;
      return current;
    }
    return { state_id: String(stateId), owner_pid: pid, started_at: new Date(nowMs).toISOString() };
  });
  if (refusedBy) {
    return { ok: false, ownerPid: Number(refusedBy.owner_pid) || null, reason: "session_close_in_progress" };
  }
  if (!written.ok) return { ok: false, ownerPid: null, reason: "session_close_claim_failed" };
  return { ok: true, claim: written.value };
}

/** Release this process's claim; another process's claim is left alone. */
export function releaseSessionClose({ stateId, pid = process.pid } = {}) {
  updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CLOSING, (current) => {
    if (!current) return null;
    if (String(current.state_id) === String(stateId) && Number(current.owner_pid) === pid) return null;
    return current;
  });
}

/** The live close claim for `stateId`, or null. */
export function activeSessionCloseClaim({ stateId, kill = process.kill.bind(process) } = {}) {
  return liveClaim(readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CLOSING), stateId, kill);
}
