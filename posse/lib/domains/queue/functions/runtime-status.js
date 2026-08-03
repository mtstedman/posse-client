// Writers for the runtime_status table: tiny key/value rows the run
// process maintains (boot steps, scheduler heartbeat, clean shutdown) so
// the bridge — a separate process sharing only the SQLite DB — can stream
// instance_status to the phone. All writes are best-effort: status
// telemetry must never break a run.

import { getDb } from "../../../shared/storage/functions/index.js";
import { now } from "./common.js";

export const RUNTIME_STATUS_KEYS = Object.freeze({
  BOOT: "boot",
  SCHEDULER: "scheduler",
  SHUTDOWN: "shutdown",
  // Written by the bridge (run.stop), consumed by the live scheduler loop.
  STOP_REQUEST: "stop_request",
  // Heartbeat from `posse serve`: a remote operator can reach this repo.
  BRIDGE: "bridge",
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
