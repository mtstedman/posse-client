import { getDb } from "../../../shared/storage/functions/index.js";
import { now, registerTransactionLifecycleHooks } from "./common.js";

const listeners = new Set();

// Listener emissions are deferred while the DB is mid-transaction so a later
// ROLLBACK never leaves the in-memory lock index reflecting writes that did
// not actually commit. The DB UPDATE to scheduler_wakeups stays inline so
// generation bumps roll back atomically with the rest of the transaction.
let _pendingEmits = [];

function emitWake(payload) {
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch {
      // Wake listeners must never break the queue mutation that triggered them.
    }
  }
}

export function flushPendingWakeEmissions() {
  if (_pendingEmits.length === 0) return;
  const drained = _pendingEmits;
  _pendingEmits = [];
  for (const payload of drained) emitWake(payload);
}

export function discardPendingWakeEmissions() {
  _pendingEmits = [];
}

registerTransactionLifecycleHooks({
  onCommit: flushPendingWakeEmissions,
  onRollback: discardPendingWakeEmissions,
});

function normalizeId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function ensureWakeRow(db) {
  db.prepare(`
    INSERT OR IGNORE INTO scheduler_wakeups (id, generation, updated_at)
    VALUES (1, 0, ?)
  `).run(now());
}

export function getQueueWakeGeneration() {
  const db = getDb();
  ensureWakeRow(db);
  const row = db.prepare(`SELECT generation FROM scheduler_wakeups WHERE id = 1`).get();
  return Number(row?.generation || 0);
}

export function notifyQueueStateChanged({
  reason = "queue_state_changed",
  jobId = null,
  workItemId = null,
  path = null,
  lockKind = null,
} = {}) {
  const db = getDb();
  const ts = now();
  ensureWakeRow(db);
  db.prepare(`
    UPDATE scheduler_wakeups
    SET generation = generation + 1,
        reason = ?,
        job_id = ?,
        work_item_id = ?,
        updated_at = ?
    WHERE id = 1
  `).run(
    String(reason || "queue_state_changed"),
    normalizeId(jobId),
    normalizeId(workItemId),
    ts,
  );
  const row = db.prepare(`
    SELECT generation, reason, job_id, work_item_id, updated_at
    FROM scheduler_wakeups
    WHERE id = 1
  `).get();
  const payload = {
    generation: Number(row?.generation || 0),
    reason: row?.reason || reason,
    jobId: row?.job_id || null,
    workItemId: row?.work_item_id || null,
    path: path == null ? null : String(path),
    lockKind: lockKind == null ? null : String(lockKind),
    updatedAt: row?.updated_at || ts,
  };
  if (db.inTransaction) {
    _pendingEmits.push(payload);
  } else {
    emitWake(payload);
  }
  return payload;
}

export function onQueueStateChanged(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function waitForQueueStateChangeAfter(generation, { signal = null } = {}) {
  const startGeneration = Number(generation || 0);
  const currentGeneration = getQueueWakeGeneration();
  if (currentGeneration !== startGeneration) {
    return Promise.resolve({ reason: "generation", generation: currentGeneration });
  }
  if (signal?.aborted) {
    return Promise.resolve({ reason: "aborted", generation: currentGeneration });
  }

  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (unsubscribe) unsubscribe();
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ reason: "aborted", generation: getQueueWakeGeneration() });
    const onWake = (payload = {}) => {
      const nextGeneration = Number(payload.generation || getQueueWakeGeneration());
      if (nextGeneration !== startGeneration) {
        finish({ reason: "generation", generation: nextGeneration, wake: payload });
      }
    };

    unsubscribe = onQueueStateChanged(onWake);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const afterSubscribeGeneration = getQueueWakeGeneration();
    if (afterSubscribeGeneration !== startGeneration) {
      finish({ reason: "generation", generation: afterSubscribeGeneration });
    }
  });
}
