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
});

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
