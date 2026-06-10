import { assertTestContext } from "../../runtime/functions/test-context.js";
import { slugify } from "../../../shared/format/functions/slug.js";

// Status enums live in the catalogue. We re-export them here so existing
// `import { TERMINAL_JOB_STATUSES } from "./common.js"` call sites keep
// working without a sweep.
export {
  ACTIVE_LEASE_STATUSES,
  ACTIVE_LEASE_STATUSES_SQL,
  COMPLETED_OUTCOME_JOB_STATUSES,
  COMPLETED_OUTCOME_JOB_STATUSES_SQL,
  DEADLOCK_TERMINAL_STATUSES,
  DEADLOCK_TERMINAL_STATUSES_SQL,
  FAILED_JOB_STATUSES,
  FAILED_JOB_STATUSES_SQL,
  LEASE_HOLDING_STATUSES,
  LEASE_HOLDING_STATUSES_SQL,
  LOCK_HOLDING_JOB_STATUSES,
  LOCK_HOLDING_JOB_STATUSES_SQL,
  PARKED_JOB_STATUSES,
  PARKED_JOB_STATUSES_SQL,
  PROVIDER_QUEUE_JOB_STATUSES,
  PROVIDER_QUEUE_JOB_STATUSES_SQL,
  STALE_CANCELABLE_JOB_STATUSES,
  STALE_CANCELABLE_JOB_STATUSES_SQL,
  TERMINAL_JOB_STATUSES,
  TERMINAL_JOB_STATUSES_SQL,
} from "../../../catalog/job.js";
export {
  TERMINAL_WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES_SQL,
} from "../../../catalog/work-item.js";

let _nowClockForTests = null;

export function now() {
  const value = typeof _nowClockForTests === "function" ? _nowClockForTests() : Date.now();
  const ms = Number.isFinite(Number(value)) ? Number(value) : Date.now();
  return new Date(ms).toISOString();
}

export function __testSetNowClockForTests(clock = null) {
  assertTestContext("__testSetNowClockForTests");
  _nowClockForTests = typeof clock === "function" ? clock : null;
}

// Normalize a free-form skills value (array, JSON string, or comma list)
// into a canonical JSON array of slugified ids, or null when empty. Used
// by createWorkItem and the agent_calls writers.
export function normalizeSkillsColumn(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        raw = Array.isArray(parsed) ? parsed : [];
      } catch {
        raw = trimmed.split(",");
      }
    } else {
      raw = trimmed.split(",");
    }
  }
  const seen = new Set();
  const ids = [];
  for (const entry of raw) {
    const id = slugify(entry, { alphabet: "id", fallback: "" });
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? JSON.stringify(ids) : null;
}

// Transaction lifecycle hooks. wakeups.js registers a flush/discard pair so
// deferred wake-listener emissions only fire after COMMIT succeeds. We use a
// setter rather than a direct import to avoid a static cycle (wakeups.js
// already imports `now` from this file).
let _commitHook = null;
let _rollbackHook = null;

export function registerTransactionLifecycleHooks({ onCommit = null, onRollback = null } = {}) {
  _commitHook = typeof onCommit === "function" ? onCommit : null;
  _rollbackHook = typeof onRollback === "function" ? onRollback : null;
}

export function runImmediateTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = fn();
    db.exec("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw err;
  } finally {
    try {
      if (committed) _commitHook?.();
      else _rollbackHook?.();
    } catch { /* lifecycle hooks must never break the caller */ }
  }
}
