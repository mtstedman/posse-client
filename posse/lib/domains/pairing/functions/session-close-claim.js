import { randomUUID } from "node:crypto";

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
//
// A PID alone cannot prove that: once the closer dies, the operating system
// may hand its PID to an unrelated long-lived process. The closer therefore
// renews the claim while it runs, and a claim not renewed within the lease
// counts as abandoned whatever its PID shows. Renewal pauses only while
// synchronous Git work blocks the closer's event loop, which takes seconds to
// minutes, so the lease is generous: a live closer keeps it, and a dead one's
// claim ages out instead of lasting as long as the PID's next owner.
export const SESSION_CLOSE_CLAIM_LEASE_MS = 30 * 60_000;
export const SESSION_CLOSE_CLAIM_RENEW_MS = 30_000;
export const SESSION_CREDENTIAL_CLAIM_LEASE_MS = 5 * 60_000;

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

function liveClaim(row, stateId, kill, nowMs) {
  if (!row || typeof row !== "object") return null;
  if (stateId != null && String(row.state_id) !== String(stateId)) return null;
  const renewedMs = Date.parse(String(row.renewed_at || row.started_at || ""));
  if (!Number.isFinite(renewedMs) || nowMs - renewedMs > SESSION_CLOSE_CLAIM_LEASE_MS) return null;
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
    const held = liveClaim(current, stateId, kill, nowMs);
    if (held && Number(held.owner_pid) !== pid) {
      refusedBy = held;
      return current;
    }
    const at = new Date(nowMs).toISOString();
    return { state_id: String(stateId), owner_pid: pid, started_at: at, renewed_at: at };
  });
  if (refusedBy) {
    return { ok: false, ownerPid: Number(refusedBy.owner_pid) || null, reason: "session_close_in_progress" };
  }
  if (!written.ok) return { ok: false, ownerPid: null, reason: "session_close_claim_failed" };
  return { ok: true, claim: written.value };
}

/** Extend this process's claim; a claim it no longer holds is left alone. */
export function renewSessionClose({ stateId, pid = process.pid, nowMs = Date.now() } = {}) {
  updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CLOSING, (current) => {
    if (!current || String(current.state_id) !== String(stateId) || Number(current.owner_pid) !== pid) return current;
    return { ...current, renewed_at: new Date(nowMs).toISOString() };
  });
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
export function activeSessionCloseClaim({
  stateId,
  kill = process.kill.bind(process),
  nowMs = Date.now(),
} = {}) {
  return liveClaim(readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CLOSING), stateId, kill, nowMs);
}

function liveCredentialClaim(row, stateId, kill, nowMs) {
  if (!row || typeof row !== "object") return null;
  if (stateId != null && String(row.state_id) !== String(stateId)) return null;
  const renewedMs = Date.parse(String(row.renewed_at || row.started_at || ""));
  if (!Number.isFinite(renewedMs) || nowMs - renewedMs > SESSION_CREDENTIAL_CLAIM_LEASE_MS) return null;
  return processAlive(Number(row.owner_pid), kill) ? row : null;
}

/** Serialize member-key mutations with close's revoke-and-freeze boundary. */
export function claimSessionCredentialMutation({
  stateId,
  operation,
  pid = process.pid,
  ownerId = `${pid}:${randomUUID()}`,
  nowMs = Date.now(),
  kill = process.kill.bind(process),
} = {}) {
  let refusedBy = null;
  const written = updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CREDENTIAL_MUTATION, (current) => {
    const held = liveCredentialClaim(current, stateId, kill, nowMs);
    if (held && String(held.owner_id) !== String(ownerId)) {
      refusedBy = held;
      return current;
    }
    const at = new Date(nowMs).toISOString();
    return {
      state_id: String(stateId),
      owner_id: String(ownerId),
      owner_pid: pid,
      operation: String(operation || "member-key mutation"),
      started_at: current?.owner_id === ownerId ? current.started_at : at,
      renewed_at: at,
    };
  });
  if (refusedBy) {
    return {
      ok: false,
      ownerPid: Number(refusedBy.owner_pid) || null,
      operation: String(refusedBy.operation || "member-key mutation"),
      reason: "session_credential_mutation_in_progress",
    };
  }
  if (!written.ok) return { ok: false, ownerPid: null, operation: null, reason: "session_credential_claim_failed" };
  return { ok: true, claim: written.value };
}

export function renewSessionCredentialMutation({
  stateId,
  ownerId,
  nowMs = Date.now(),
} = {}) {
  return updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CREDENTIAL_MUTATION, (current) => {
    if (!current || String(current.state_id) !== String(stateId)
      || String(current.owner_id) !== String(ownerId)) return current;
    return { ...current, renewed_at: new Date(nowMs).toISOString() };
  }).ok;
}

export function releaseSessionCredentialMutation({ stateId, ownerId } = {}) {
  updateRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_CREDENTIAL_MUTATION, (current) => {
    if (!current) return null;
    if (String(current.state_id) === String(stateId)
      && String(current.owner_id) === String(ownerId)) return null;
    return current;
  });
}
