// Gather the persisted evidence for the pairing-session sync indicator and
// derive it. Reads only SQLite rows and process liveness (signal 0) — never
// Git or the network — so any surface can call it on every render.

import { SESSION_LINK_OWNERS, SESSION_SYNC_POLICY } from "../../../catalog/session-sync.js";
import { SHARED_TRUNK_NON_PUBLISHING_LOCK_OWNERS } from "../../../catalog/shared-trunk.js";
import {
  getSchedulerLockInfo,
  LIVE_SCHEDULER_LOCK_GRACE_MS,
} from "../../queue/functions/locks.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS } from "../../queue/functions/runtime-status.js";
import { readActiveSessionHold } from "./session-hold.js";
import { readSessionLink } from "./session-link.js";
import { getLivePairingState } from "./state.js";
import {
  derivePeerSyncStates,
  deriveSessionSyncState,
  unresolvedPeerTrunkHeads,
} from "./sync-state.js";

// The scheduler rewrites its runtime row every ~10s from inside the run loop.
const SCHEDULER_STATUS_FRESH_MS = 60_000;

function parseMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function pidAlive(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process is gone; EPERM and platform errors do not.
    return error?.code !== "ESRCH";
  }
}

/**
 * True when a live scheduler owns the shared-trunk poller: the scheduler lock
 * is fresh, the scheduler's own runtime row names the same owner with a fresh
 * heartbeat, and that process is still alive.
 */
export function sharedTrunkFetchOwnerAlive({
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  let lock;
  try {
    lock = getSchedulerLockInfo("main");
  } catch {
    return false;
  }
  if (!lock) return false;
  const lockHeartbeatMs = parseMs(lock.acquired_at);
  const lockExpiresMs = parseMs(lock.expires_at);
  const lockLive = (lockHeartbeatMs != null && nowMs - lockHeartbeatMs < LIVE_SCHEDULER_LOCK_GRACE_MS)
    || (lockExpiresMs != null && lockExpiresMs > nowMs);
  if (!lockLive) return false;
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
  if (!status || status.owner_id !== lock.owner_id) return false;
  const heartbeatMs = parseMs(status.heartbeat_at);
  if (heartbeatMs == null || nowMs - heartbeatMs > SCHEDULER_STATUS_FRESH_MS || heartbeatMs - nowMs > 5_000) {
    return false;
  }
  return pidAlive(Number(status.process_pid), kill);
}

/**
 * True when a live process here keeps this checkout synced: a running posse
 * go, or the session console heartbeating (it polls while it owns the
 * session). Either one's hold, resume and fast-forwards take effect.
 */
export function sessionFetchOwnerAlive({
  stateId = undefined,
  link = undefined,
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  if (sharedTrunkFetchOwnerAlive({ nowMs, kill })) return true;
  const row = link === undefined ? readSessionLink({ stateId }) : link;
  if (!row || row.owner !== SESSION_LINK_OWNERS.CONSOLE) return false;
  const attemptMs = parseMs(row.last_attempt_at) ?? parseMs(row.last_ok_at);
  if (attemptMs == null || nowMs - attemptMs > SESSION_SYNC_POLICY.LINK_SILENT_AFTER_MS) return false;
  return pidAlive(Number(row.owner_pid), kill);
}

/**
 * True when a live local process holds the merge lock for anything but the
 * poller's routine fetch/fast-forward or recovery pass. A lock left behind by
 * a crashed process (dead PID) or an expired lease is not a publication.
 */
export function sharedTrunkPublishInProgress({
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  let lock;
  try {
    lock = getSchedulerLockInfo("merge");
  } catch {
    return false;
  }
  if (!lock) return false;
  const expiresMs = parseMs(lock.expires_at);
  if (expiresMs == null || expiresMs <= nowMs) return false;
  const match = /^merge-(\d+)(?:[-:](.*))?$/u.exec(String(lock.owner_id || ""));
  if (!match) return false;
  if (SHARED_TRUNK_NON_PUBLISHING_LOCK_OWNERS.includes(String(match[2] || ""))) return false;
  return pidAlive(Number(match[1]), kill);
}

/**
 * Collect the derivation inputs for one live session. `snapshot` is the
 * fresh peer snapshot (readPairingPeerSnapshot()); null means no peers known.
 */
export function collectSessionSyncInputs({
  state = getLivePairingState(),
  snapshot = null,
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  if (!state) return null;
  // A row for another branch (a previous session, or before the first poll of
  // this one) says nothing about this session's checkout.
  const trunkRow = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK);
  const trunk = trunkRow && trunkRow.branch === state.shared_branch ? trunkRow : null;
  // Peer ages are relayed as of the snapshot; age them to now.
  const snapshotAgeSec = Math.max(0, Math.floor((nowMs - Date.parse(String(snapshot?.at || ""))) / 1000));
  const peers = (Array.isArray(snapshot?.peers) ? snapshot.peers : []).map((peer) => (
    Number.isSafeInteger(peer?.last_seen_age_sec) && Number.isFinite(snapshotAgeSec)
      ? { ...peer, last_seen_age_sec: peer.last_seen_age_sec + snapshotAgeSec }
      : peer
  ));
  const link = readSessionLink({ stateId: state.id });
  return {
    nowMs,
    role: state.role || null,
    link,
    trunk,
    hold: readActiveSessionHold({ stateId: state.id, nowMs }),
    fetchOwnerAlive: sessionFetchOwnerAlive({ link, nowMs, kill }),
    publishing: sharedTrunkPublishInProgress({ nowMs, kill }),
    unresolvedPeerHeads: unresolvedPeerTrunkHeads(peers, trunk || {}),
    peers,
  };
}

/**
 * The derived indicator for this checkout and its peers, or null outside a
 * live session.
 * @returns {{ sync: object, peers_sync: object[] } | null}
 */
export function readSessionSync(options = {}) {
  const inputs = collectSessionSyncInputs(options);
  if (!inputs) return null;
  const { peers, ...syncInputs } = inputs;
  return {
    sync: deriveSessionSyncState(syncInputs),
    peers_sync: derivePeerSyncStates({ peers, trunk: inputs.trunk, nowMs: inputs.nowMs }),
  };
}
