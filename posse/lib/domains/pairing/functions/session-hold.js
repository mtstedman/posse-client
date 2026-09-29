// Per-checkout session hold. A hold freezes THIS clone: the scheduler's
// shared-trunk poller keeps fetching, reconciling and refreshing claims but
// skips the local fast-forward, and new shared-trunk publications defer
// (transiently) without building a candidate. It never applies to journal
// recovery or to the close-time final sync, and it always expires, so a
// forgotten hold cannot wedge a session.
//
// A resume request does not delete the row: it marks it so the live poller
// can clear the hold and make its next poll due immediately. A marked row is
// no longer an active hold for any reader.

import { SESSION_SYNC_POLICY, SESSION_SYNC_TEXT_LIMITS } from "../../../catalog/session-sync.js";
import {
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  updateRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { activeSessionCloseClaim } from "./session-close-claim.js";
import { getLivePairingState } from "./state.js";

export const SESSION_HOLD_STATES = Object.freeze({
  NONE: "none",
  ACTIVE: "active",
  RESUME_REQUESTED: "resume_requested",
});

function boundedReason(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SESSION_SYNC_TEXT_LIMITS.HOLD_REASON);
  return text || null;
}

function holdTtlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return SESSION_SYNC_POLICY.HOLD_DEFAULT_TTL_MS;
  return Math.min(SESSION_SYNC_POLICY.HOLD_MAX_TTL_MS, Math.max(SESSION_SYNC_POLICY.HOLD_MIN_TTL_MS, Math.trunc(parsed)));
}

/** undefined resolves the live pairing session; null means "no session". */
function resolveStateId(stateId) {
  if (stateId !== undefined) return stateId == null || stateId === "" ? null : String(stateId);
  try {
    return getLivePairingState()?.id || null;
  } catch {
    return undefined;
  }
}

function expired(row, nowMs) {
  const expiresMs = Date.parse(String(row?.expires_at || ""));
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

/**
 * Classify the persisted hold row for one session, lazily deleting rows that
 * are expired, malformed, or written for another (or no) session.
 * @returns {{ state: "none"|"active"|"resume_requested", hold: object|null }}
 */
export function readSessionHoldStatus({ stateId = undefined, nowMs = Date.now(), cleanup = true } = {}) {
  const resolved = resolveStateId(stateId);
  const row = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_HOLD);
  if (!row) return { state: SESSION_HOLD_STATES.NONE, hold: null };
  // An unreadable session table proves nothing about the row; keep it.
  if (resolved === undefined) return { state: SESSION_HOLD_STATES.NONE, hold: null };
  const foreign = !resolved || row.state_id !== resolved;
  if (foreign || expired(row, nowMs)) {
    // A caller asking about another session never deletes the live session's
    // hold: only rows that are expired or belong to no live session are dead.
    const liveId = stateId === undefined ? resolved : resolveStateId(undefined);
    const dead = expired(row, nowMs) || (liveId !== undefined && liveId !== row.state_id);
    if (cleanup && dead) {
      updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_HOLD, (current) => (
        // Delete only the row that was judged; a concurrent new hold survives.
        current && current.state_id === row.state_id && current.set_at === row.set_at ? null : current
      ));
    }
    return { state: SESSION_HOLD_STATES.NONE, hold: null };
  }
  return row.resume_requested_at
    ? { state: SESSION_HOLD_STATES.RESUME_REQUESTED, hold: row }
    : { state: SESSION_HOLD_STATES.ACTIVE, hold: row };
}

/** The active hold row for the session, or null. */
// A drain request older than this belongs to a close that died with its
// process (matches the pair console's own freshness bound).
const DRAIN_REQUEST_FRESH_MS = 10 * 60_000;

/**
 * True once this session has started closing: a live local close claim, a
 * recent graceful-drain request, or the Remote reporting draining/closed in
 * the relayed snapshot (the only signal a member sees). A hold never survives
 * that point, or merges it deferred would miss the host's final sync and drop
 * out of the integration unnoticed.
 */
export function sessionClosingForHold({ stateId = undefined, nowMs = Date.now() } = {}) {
  try {
    const resolved = resolveStateId(stateId);
    if (resolved && activeSessionCloseClaim({ stateId: resolved })) return true;
    const drain = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_DRAIN_REQUEST);
    const requestedMs = Date.parse(String(drain?.requested_at || ""));
    if (drain && Number.isFinite(requestedMs) && nowMs - requestedMs <= DRAIN_REQUEST_FRESH_MS) return true;
    const snapshot = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PEERS);
    return ["draining", "closed", "expired"].includes(String(snapshot?.status || ""));
  } catch {
    return false;
  }
}

export function readActiveSessionHold({ stateId = undefined, nowMs = Date.now(), cleanup = true } = {}) {
  const status = readSessionHoldStatus({ stateId, nowMs, cleanup });
  if (status.state !== SESSION_HOLD_STATES.ACTIVE) return null;
  return sessionClosingForHold({ stateId, nowMs }) ? null : status.hold;
}

/**
 * Hold this checkout for `ttlMs` (default 30 minutes, clamped to 24 hours).
 * Replaces any earlier hold, including a pending resume.
 * @returns {{ ok: true, hold: object } | { ok: false, reason: string }}
 */
export function setSessionHold({
  stateId = undefined,
  reason = null,
  ttlMs = SESSION_SYNC_POLICY.HOLD_DEFAULT_TTL_MS,
  nowMs = Date.now(),
} = {}) {
  const resolved = resolveStateId(stateId);
  if (!resolved) return { ok: false, reason: "no_active_session" };
  const hold = {
    state_id: resolved,
    reason: boundedReason(reason),
    set_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + holdTtlMs(ttlMs)).toISOString(),
    resume_requested_at: null,
  };
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_HOLD, () => hold);
  return written.ok ? { ok: true, hold } : { ok: false, reason: "hold_write_failed" };
}

/**
 * Ask the live poller to lift the hold. The hold stops applying immediately;
 * the poller clears the row and fast-forwards on its next lap.
 * @returns {{ ok: boolean, resumed: boolean, reason?: string, hold?: object }}
 */
export function requestSessionResume({ stateId = undefined, nowMs = Date.now() } = {}) {
  const resolved = resolveStateId(stateId);
  if (!resolved) return { ok: false, resumed: false, reason: "no_active_session" };
  const status = readSessionHoldStatus({ stateId: resolved, nowMs });
  if (status.state === SESSION_HOLD_STATES.NONE) return { ok: true, resumed: false, reason: "not_held" };
  if (status.state === SESSION_HOLD_STATES.RESUME_REQUESTED) return { ok: true, resumed: true, hold: status.hold };
  let marked = null;
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_HOLD, (current) => {
    if (!current || current.state_id !== resolved || current.set_at !== status.hold.set_at) return current;
    marked = { ...current, resume_requested_at: new Date(nowMs).toISOString() };
    return marked;
  });
  if (!written.ok) return { ok: false, resumed: false, reason: "hold_write_failed" };
  return marked ? { ok: true, resumed: true, hold: marked } : { ok: true, resumed: false, reason: "not_held" };
}

/**
 * Delete the hold row. With a session id, a row written for another session
 * is left alone (the lazy read-side cleanup owns it); with `setAt`, only that
 * exact hold is removed, so a hold set concurrently survives.
 * @returns {boolean} true when the write succeeded.
 */
export function clearSessionHold({ stateId = undefined, setAt = undefined } = {}) {
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_HOLD, (current) => {
    if (!current) return null;
    if (stateId !== undefined && stateId !== null && current.state_id !== String(stateId)) return current;
    if (setAt !== undefined && current.set_at !== setAt) return current;
    return null;
  });
  return written.ok;
}
