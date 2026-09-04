import {
  getLiveSchedulerBlockMessage,
  getSchedulerLockInfo,
} from "../../queue/functions/locks.js";
import {
  clearRuntimeStatus,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";

const POLL_MS = 250;
const FORCE_REQUEST_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveScheduler() {
  if (!getLiveSchedulerBlockMessage("main")) return null;
  return getSchedulerLockInfo("main");
}

function writeSchedulerRequest(key, state, source) {
  const lock = liveScheduler();
  if (!lock) return { requested: false, stopped: true };
  writeRuntimeStatus(key, {
    requested_at: new Date().toISOString(),
    owner_id: lock.owner_id || null,
    session_id: state?.remote_session_id || null,
    source,
  });
  return { requested: true, stopped: false, ownerId: lock.owner_id || null };
}

export function requestPairingDrain(state) {
  return writeSchedulerRequest(
    RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST,
    state,
    "pairing_graceful_close",
  );
}

export function requestPairingForceStop(state) {
  return writeSchedulerRequest(
    RUNTIME_STATUS_KEYS.STOP_REQUEST,
    state,
    "pairing_force_close",
  );
}

function schedulerSignalTarget(expectedOwnerId, nowMs = Date.now()) {
  const lock = liveScheduler();
  if (!lock || lock.owner_id !== expectedOwnerId) return null;
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
  const pid = Number(status?.process_pid);
  const heartbeatMs = Date.parse(String(status?.heartbeat_at || ""));
  if (status?.owner_id !== expectedOwnerId
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isFinite(heartbeatMs)
    || nowMs - heartbeatMs > 30_000
    || heartbeatMs - nowMs > 5_000) return null;
  return { pid, ownerId: expectedOwnerId };
}

export async function waitForPairingSchedulerStop({
  state,
  graceful,
  onProgress = () => {},
  sleepFn = sleep,
  kill = process.kill.bind(process),
} = {}) {
  const request = graceful ? requestPairingDrain(state) : requestPairingForceStop(state);
  if (request.stopped) {
    if (graceful) clearRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
    return { ok: true, alreadyStopped: true };
  }
  const startedAt = Date.now();
  let termSentAt = null;
  let termTarget = null;
  while (liveScheduler()) {
    const elapsed = Date.now() - startedAt;
    if (!graceful && termSentAt == null && elapsed >= FORCE_REQUEST_GRACE_MS) {
      termTarget = schedulerSignalTarget(request.ownerId);
      if (termTarget) {
        onProgress(`Scheduler did not stop; sending SIGTERM to PID ${termTarget.pid}`);
        try { kill(termTarget.pid, "SIGTERM"); } catch { /* re-check below */ }
        termSentAt = Date.now();
      }
    } else if (!graceful && termSentAt != null && Date.now() - termSentAt >= SIGTERM_GRACE_MS) {
      const target = schedulerSignalTarget(termTarget?.ownerId);
      if (target && target.pid === termTarget?.pid) {
        onProgress(`Scheduler ignored SIGTERM; sending SIGKILL to PID ${target.pid}`);
        try { kill(target.pid, "SIGKILL"); } catch { /* re-check below */ }
      }
      termSentAt = Number.POSITIVE_INFINITY;
    }
    await sleepFn(POLL_MS);
  }
  if (graceful) {
    const remaining = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
    if (!remaining?.owner_id || remaining.owner_id === request.ownerId) {
      clearRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
    }
  }
  return { ok: true, graceful: graceful === true };
}

export const __testPairingShutdownInternals = Object.freeze({ schedulerSignalTarget });
