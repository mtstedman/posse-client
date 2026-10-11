import { SESSION_LINK_OWNERS, SESSION_SYNC_POLICY } from "../../../catalog/session-sync.js";
import { getLiveSchedulerBlockMessage, getSchedulerLockInfo } from "../../queue/functions/locks.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS } from "../../queue/functions/runtime-status.js";
import { activeSessionCloseClaim } from "./session-close-claim.js";
import { readSessionLink } from "./session-link.js";

export function pidProvablyDead(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    // Only ESRCH proves the process is gone; EPERM and platform errors do not.
    return error?.code === "ESRCH";
  }
}

// A live scheduler lock means posse go may own the session heartbeat. The lock
// outlives a killed process for up to its lease, so a holder whose own runtime
// row names a PID that is provably gone no longer counts.
export function schedulerLockHolderLive(kill) {
  if (!getLiveSchedulerBlockMessage("main")) return false;
  let lock;
  try {
    lock = getSchedulerLockInfo("main");
  } catch {
    return true;
  }
  if (!lock) return false;
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
  if (!status || status.owner_id !== lock.owner_id) return true;
  return !pidProvablyDead(Number(status.process_pid), kill);
}

// After releasing the scheduler lock, a posse go still owns the session only
// while it provably heartbeats: its link row names it and attempted within a
// few beats. One sitting in its wrap-up screen, or a dead or reused pid, has
// stopped, and the Remote lease would lapse unless the console takes over.
function schedulerStillHeartbeating(state, pid, nowMs) {
  const link = readSessionLink({ stateId: state?.id });
  if (link?.owner !== SESSION_LINK_OWNERS.SCHEDULER || Number(link.owner_pid) !== pid) return false;
  const attemptMs = Date.parse(String(link.last_attempt_at || ""));
  return Number.isFinite(attemptMs) && nowMs - attemptMs <= SESSION_SYNC_POLICY.LINK_SILENT_AFTER_MS;
}

// A drain request older than this belongs to a close that died with its
// process; it no longer keeps the console from taking the session back.
const DRAIN_REQUEST_FRESH_MS = 10 * 60_000;

// A close in progress belongs to whichever process started it: a live close
// claim, or a recent graceful-drain request whose closer has not claimed yet.
export function sessionCloseInProgress(state, kill, nowMs) {
  const claim = activeSessionCloseClaim({ stateId: state?.id, kill });
  if (claim) return { ownerPid: Number(claim.owner_pid) || null };
  const drain = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
  const requestedMs = Date.parse(String(drain?.requested_at || ""));
  if (drain && Number.isFinite(requestedMs) && nowMs - requestedMs <= DRAIN_REQUEST_FRESH_MS) {
    return { ownerPid: null };
  }
  return null;
}

/**
 * Who heartbeats the session right now: this console ("self"), a posse go
 * that holds the scheduler lock or still heartbeats ("scheduler"), a close in
 * progress in another process ("closing"), or nobody ("vacant": this console
 * takes the session back).
 */
export function consoleSessionOwnership(state, kill, nowMs = Date.now()) {
  const pid = Number(state?.process_pid);
  if (pid === process.pid) return "self";
  if (schedulerLockHolderLive(kill)) return "scheduler";
  if (Number.isSafeInteger(pid) && pid > 0 && !pidProvablyDead(pid, kill)
    && schedulerStillHeartbeating(state, pid, nowMs)) return "scheduler";
  if (sessionCloseInProgress(state, kill, nowMs)) return "closing";
  return "vacant";
}
