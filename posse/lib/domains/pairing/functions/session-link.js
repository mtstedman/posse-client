// Pairing relay link health. Whichever local process owns the session
// heartbeat (the pair console or the scheduler's SessionMonitor) records each
// heartbeat outcome here so the sync indicator can say "disconnected" from
// evidence instead of guessing from a stale peer snapshot. Writes are
// best-effort: link telemetry must never break a heartbeat.

import { SESSION_LINK_OWNERS, SESSION_SYNC_TEXT_LIMITS } from "../../../catalog/session-sync.js";
import {
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  updateRuntimeStatus,
} from "../../queue/functions/runtime-status.js";

const OWNERS = new Set(Object.values(SESSION_LINK_OWNERS));

function boundedText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function linkError(error) {
  if (error == null) return null;
  const code = typeof error === "object" ? error.code : null;
  const message = typeof error === "object" ? error.message : error;
  const text = [code, message].filter((value) => value != null && String(value).trim()).map(String);
  return boundedText([...new Set(text)].join(": "), SESSION_SYNC_TEXT_LIMITS.LINK_ERROR) || null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function baseRow(current, { stateId, owner, pid, leaseSec }) {
  const sameSession = current?.state_id === String(stateId);
  return {
    state_id: String(stateId),
    owner: OWNERS.has(owner) ? owner : (sameSession && OWNERS.has(current?.owner) ? current.owner : null),
    owner_pid: positiveInteger(pid) ?? (sameSession ? positiveInteger(current?.owner_pid) : null),
    last_ok_at: sameSession ? current?.last_ok_at || null : null,
    last_attempt_at: sameSession ? current?.last_attempt_at || null : null,
    consecutive_failures: sameSession ? Math.max(0, Number(current?.consecutive_failures) || 0) : 0,
    last_error: sameSession ? current?.last_error || null : null,
    lease_sec: positiveInteger(leaseSec) ?? (sameSession ? positiveInteger(current?.lease_sec) : null),
  };
}

/**
 * Record one successful relay heartbeat for session `stateId`.
 * @returns {object|null} the persisted SESSION_LINK row, or null when the
 *   write failed or no session id was given.
 */
export function recordSessionLinkSuccess({
  stateId,
  owner,
  pid = process.pid,
  leaseSec = null,
  nowMs = Date.now(),
} = {}) {
  if (!stateId) return null;
  const at = new Date(nowMs).toISOString();
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_LINK, (current) => ({
    ...baseRow(current, { stateId, owner, pid, leaseSec }),
    last_ok_at: at,
    last_attempt_at: at,
    consecutive_failures: 0,
    last_error: null,
  }));
  return written.ok ? written.value : null;
}

/**
 * Record one failed relay heartbeat. The last success is kept so the
 * indicator can count down to the Remote's membership lease.
 * @returns {object|null} the persisted SESSION_LINK row, or null.
 */
export function recordSessionLinkFailure({
  stateId,
  owner,
  pid = process.pid,
  leaseSec = null,
  error = null,
  nowMs = Date.now(),
} = {}) {
  if (!stateId) return null;
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_LINK, (current) => {
    const base = baseRow(current, { stateId, owner, pid, leaseSec });
    return {
      ...base,
      last_attempt_at: new Date(nowMs).toISOString(),
      consecutive_failures: base.consecutive_failures + 1,
      last_error: linkError(error) || "heartbeat_failed",
    };
  });
  return written.ok ? written.value : null;
}

/**
 * The persisted link row. With `stateId`, a row written for any other
 * session is ignored (returns null).
 */
export function readSessionLink({ stateId = undefined } = {}) {
  const row = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_LINK);
  if (!row || typeof row !== "object" || !row.state_id) return null;
  if (stateId !== undefined && row.state_id !== String(stateId ?? "")) return null;
  return row;
}
