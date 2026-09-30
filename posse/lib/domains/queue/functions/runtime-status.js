// Writers for the runtime_status table: tiny key/value rows the run
// process maintains (boot steps, scheduler heartbeat, clean shutdown) so
// the bridge — a separate process sharing only the SQLite DB — can stream
// instance_status to the phone. All writes are best-effort: status
// telemetry must never break a run.

import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";

export const RUNTIME_STATUS_KEYS = Object.freeze({
  BOOT: "boot",
  SCHEDULER: "scheduler",
  SHUTDOWN: "shutdown",
  // Written by the bridge (run.stop), consumed by the live scheduler loop.
  STOP_REQUEST: "stop_request",
  // Heartbeat from `posse serve`: a remote operator can reach this repo.
  BRIDGE: "bridge",
  // Persisted shared-trunk synchronization health, projected read-only by the
  // bridge. This intentionally survives scheduler shutdown for diagnostics.
  SHARED_TRUNK: "shared_trunk",
  // Short-lived pairing presence mirrored by the persistent pair monitor for
  // local dashboards. Peer rows never enter the schedulable queue tables.
  PAIRING_PEERS: "pairing_peers",
  // Pairing graceful-close request. The live scheduler stops leasing new jobs
  // and exits only after its currently active workers settle.
  PAIRING_DRAIN_REQUEST: "pairing_drain_request",
  // Durable host-side integration journal. Recovery owns this until the
  // frozen side trunk is proven published to the original trunk.
  PAIRING_PROMOTION: "pairing_promotion",
  // Pairing relay link health, written by whichever local process owns the
  // session heartbeat (pair console or scheduler). Read by the sync indicator.
  SESSION_LINK: "session_link",
  // Per-checkout hold: freezes this clone's shared-trunk fast-forward and
  // defers its publications while fetch/reconcile keep running.
  SESSION_HOLD: "session_hold",
  // The one process closing and integrating the session (pairing
  // session-close-claim.js); a claim whose process is gone no longer counts.
  SESSION_CLOSING: "session_closing",
  // Serializes GitHub member-key creation/removal with session close. Unlike
  // the close claim, short member-management commands own this row too.
  SESSION_CREDENTIAL_MUTATION: "session_credential_mutation",
});

/** How stale the bridge heartbeat may be and still count as "present".
 *  The bridge writes every 30s; 120s tolerates a couple of missed beats. */
export const BRIDGE_PRESENCE_FRESH_MS = 120_000;

/**
 * True when `posse serve` has heartbeaten recently, meaning a phone/SPA can
 * answer human gates remotely. Consumed by headless recovery so a served
 * repo's gates wait for the operator instead of timing out.
 */
export function isBridgePresenceFresh({ maxAgeMs = BRIDGE_PRESENCE_FRESH_MS } = {}) {
  const row = readRuntimeStatus(RUNTIME_STATUS_KEYS.BRIDGE);
  const at = Date.parse(row?.at || "");
  return row?.present === true && Number.isFinite(at) && Date.now() - at < maxAgeMs;
}

export function readRuntimeStatus(key) {
  try {
    const row = getDb()
      .prepare(`SELECT value_json FROM runtime_status WHERE key = ?`)
      .get(String(key));
    if (!row) return null;
    return JSON.parse(row.value_json || "{}");
  } catch {
    return null;
  }
}

export function writeRuntimeStatus(key, value) {
  try {
    getDb()
      .prepare(
        `INSERT INTO runtime_status (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE
           SET value_json = excluded.value_json,
               updated_at = excluded.updated_at`,
      )
      .run(String(key), JSON.stringify(value ?? {}), now());
    return true;
  } catch {
    return false;
  }
}

/**
 * Durable shared-trunk health mutation. Unlike ordinary best-effort heartbeat
 * rows, contention counters and divergence are recovery-relevant operator
 * state, so this path uses the queue's immediate transaction discipline.
 */
export function updateSharedTrunkRuntimeStatus(patch = {}, { increments = {} } = {}) {
  try {
    const db = getDb();
    return runImmediateTransaction(db, () => {
      let current = {};
      try {
        const row = db.prepare("SELECT value_json FROM runtime_status WHERE key = ?")
          .get(RUNTIME_STATUS_KEYS.SHARED_TRUNK);
        const parsed = row ? JSON.parse(row.value_json || "{}") : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
      } catch { /* replace malformed status with a valid bounded snapshot */ }
      const next = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
      for (const [key, delta] of Object.entries(increments || {})) {
        const amount = Number(delta);
        if (!Number.isFinite(amount)) continue;
        next[key] = Math.max(0, Number(next[key]) || 0) + amount;
      }
      const ts = now();
      db.prepare(`
        INSERT INTO runtime_status (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(RUNTIME_STATUS_KEYS.SHARED_TRUNK, JSON.stringify(next), ts);
      return next;
    });
  } catch {
    return null;
  }
}

/**
 * Transactional read-modify-write for one runtime_status row. `mutate`
 * receives the parsed current object (or null) and returns the next object,
 * or null to delete the row. Best-effort like every status write: a failure
 * returns { ok: false } instead of throwing into the caller.
 */
export function updateRuntimeStatus(key, mutate) {
  try {
    const db = getDb();
    return runImmediateTransaction(db, () => {
      let current = null;
      try {
        const row = db.prepare("SELECT value_json FROM runtime_status WHERE key = ?").get(String(key));
        const parsed = row ? JSON.parse(row.value_json || "{}") : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
      } catch { /* a malformed row is replaced by the mutation's result */ }
      const next = mutate(current);
      if (next == null) {
        db.prepare("DELETE FROM runtime_status WHERE key = ?").run(String(key));
        return { ok: true, value: null };
      }
      db.prepare(`
        INSERT INTO runtime_status (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(String(key), JSON.stringify(next), now());
      return { ok: true, value: next };
    });
  } catch {
    return { ok: false, value: null };
  }
}

export function clearRuntimeStatus(key) {
  try {
    getDb().prepare(`DELETE FROM runtime_status WHERE key = ?`).run(String(key));
    return true;
  } catch {
    return false;
  }
}

/** Mark a clean shutdown and drop boot/scheduler rows so the next boot
 *  starts from a blank slate (and stale rows can't masquerade as live). */
export function markCleanShutdown() {
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.SHUTDOWN, { clean: true, at: now() });
  clearRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT);
  clearRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
}
