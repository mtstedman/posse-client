import { logEvent } from "./events.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { randomUUID } from "node:crypto";
import { BUDGET_PAUSED, BUDGET_STATES as S, BUDGET_REASONS as R } from "../../../catalog/admission-budget.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { runImmediateTransaction } from "./common.js";
import { notifyQueueStateChanged } from "./wakeups.js";

export function budgetPauseError(reason) {
  const error = new Error(`Work-item budget paused (${reason}); inspect posse budget show, reconcile unknown costs or change the threshold, then resume.`);
  error.code = BUDGET_PAUSED;
  return error;
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function completedCost(row, db) {
  const call = row.agent_call_id ? db.prepare("SELECT * FROM agent_calls WHERE id = ?").get(row.agent_call_id) : null;
  const cost = call?.cost_estimate_usd;
  return call?.status !== "running" && ["exact", "aggregate_only"].includes(call?.billing_precision)
    && cost != null && Number.isFinite(cost) && cost >= 0 ? cost : null;
}
function snapshot(id, db) {
  const budget = db.prepare("SELECT * FROM work_item_budgets WHERE work_item_id = ?").get(id);
  if (!budget) return null;
  const reservations = db.prepare("SELECT * FROM budget_reservations WHERE work_item_id = ? ORDER BY started_at, id").all(id);
  return { ...budget, spent_usd: reservations.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
    reserved_usd: reservations.filter(r => r.state === S.RESERVED).reduce((sum, r) => sum + (r.reserved_usd ?? 0), 0),
    unknown_costs: reservations.filter(r => r.state === S.UNKNOWN).length,
    spend_is_complete: reservations.every(r => r.state === S.SETTLED),
    reservations };
}
function pause(id, reason, db) {
  const changed = db.prepare("UPDATE work_item_budgets SET paused_reason = ? WHERE work_item_id = ? AND enabled = 1 AND paused_reason IS NOT ? AND (? != ? OR limit_usd IS NOT NULL)").run(reason, id, reason, reason, R.UNKNOWN).changes;
  if (changed) logEvent({ work_item_id: id, event_type: EVENT_TYPES.WORK_ITEM_BUDGET_PAUSED, actor_type: EVENT_ACTORS.SYSTEM,
    message: `Budget paused: ${reason}. Inspect posse budget show ${id}; reconcile costs or adjust thresholds, then resume.` });
  notifyQueueStateChanged({ reason: "budget_paused", workItemId: id });
}
function reconcileDead(id, db) {
  for (const row of db.prepare("SELECT * FROM budget_reservations WHERE work_item_id = ? AND state = ?").all(id, S.UNKNOWN)) {
    const cost = completedCost(row, db);
    if (cost != null) db.prepare("UPDATE budget_reservations SET state = ?, cost_usd = ?, finished_at = ? WHERE id = ?")
      .run(S.SETTLED, cost, Date.now(), row.id);
  }
  for (const row of db.prepare("SELECT * FROM budget_reservations WHERE work_item_id = ? AND state = ?").all(id, S.RESERVED)) {
    const attempt = row.attempt_id ? db.prepare("SELECT status FROM job_attempts WHERE id = ?").get(row.attempt_id) : null;
    if (ownerAlive(row.owner_pid) && (!row.attempt_id || attempt?.status === "running")) continue;
    const cost = completedCost(row, db);
    db.prepare("UPDATE budget_reservations SET state = ?, cost_usd = ?, finished_at = ?, reconciliation_reason = ? WHERE id = ?")
      .run(cost == null ? S.UNKNOWN : S.SETTLED, cost, Date.now(), "owner_process_or_attempt_ended", row.id);
    if (cost == null) pause(id, R.UNKNOWN, db);
  }
}
export function readAdmissionBudget(id) {
  if (!id) return null;
  const db = getDb();
  return snapshot(id, db);
}
export function isBudgetPaused(id, db = null) {
  if (!id) return false;
  return !!(db || getDb()).prepare("SELECT 1 FROM work_item_budgets WHERE work_item_id = ? AND enabled = 1 AND paused_reason IS NOT NULL").get(id);
}

/** Atomic across worker processes; pending calls and unknown costs never disappear. */
export function reserveBudget({ workItemId, jobId = null, attemptId = null, parentCallId = null, provider = null, model = null, role = null } = {}) {
  if (!workItemId && !jobId && !parentCallId) return null;
  const db = getDb();
  const id = workItemId || (jobId ? db.prepare("SELECT work_item_id FROM jobs WHERE id = ?").get(jobId)?.work_item_id : null)
    || (parentCallId ? db.prepare("SELECT work_item_id FROM agent_calls WHERE id = ?").get(parentCallId)?.work_item_id : null);
  if (!id) return null;
  const result = runImmediateTransaction(db, () => {
    reconcileDead(id, db);
    const budget = snapshot(id, db);
    if (!budget?.enabled) return {};
    const reason = budget.paused_reason || (budget.deadline_at != null && Date.now() >= budget.deadline_at ? R.TIME
      : budget.limit_usd != null && budget.unknown_costs ? R.UNKNOWN
        : budget.limit_usd != null && budget.spent_usd + budget.reserved_usd + budget.reservation_usd > budget.limit_usd ? R.SPEND : null);
    if (reason) { pause(id, reason, db); return { reason }; }
    const reservation = { id: randomUUID(), work_item_id: id };
    const ownerAttempt = attemptId || (jobId ? db.prepare("SELECT id FROM job_attempts WHERE job_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(jobId)?.id : null);
    db.prepare(`INSERT INTO budget_reservations (id, work_item_id, job_id, attempt_id, owner_pid, provider, model, role, reserved_usd, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reservation.id, id, jobId, ownerAttempt || null, process.pid, provider, model, role, budget.reservation_usd, S.RESERVED, Date.now());
    return { reservation };
  });
  if (result.reason) throw budgetPauseError(result.reason); // throw after COMMIT, retaining the pause
  return result.reservation || null;
}
export function attachBudgetCall(reservation, callId) {
  if (reservation) getDb().prepare("UPDATE budget_reservations SET agent_call_id = ? WHERE id = ? AND state = ?").run(callId, reservation.id, S.RESERVED);
}
export function settleBudget(reservation, { notDispatched = false } = {}) {
  if (!reservation) return;
  const db = getDb();
  runImmediateTransaction(db, () => {
    const row = db.prepare("SELECT * FROM budget_reservations WHERE id = ?").get(reservation.id);
    if (!row || row.state !== S.RESERVED) return;
    const cost = notDispatched ? 0 : completedCost(row, db);
    db.prepare("UPDATE budget_reservations SET state = ?, cost_usd = ?, finished_at = ? WHERE id = ?")
      .run(cost == null ? S.UNKNOWN : S.SETTLED, cost, Date.now(), row.id);
    const budget = snapshot(row.work_item_id, db);
    if (budget?.enabled && budget.limit_usd != null) {
      if (cost == null) pause(row.work_item_id, R.UNKNOWN, db);
      else if (budget.spent_usd + budget.reserved_usd >= budget.limit_usd) pause(row.work_item_id, R.SPEND, db);
    }
  });
}

export function configureAdmissionBudget(id, { limitUsd = null, reservationUsd = null, minutes = null } = {}) {
  for (const [key, value] of Object.entries({ limitUsd, reservationUsd, minutes })) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error(`${key} must be a positive number`);
  }
  if (limitUsd == null && minutes == null) throw new Error("Specify a spend threshold or wall-time threshold");
  if (limitUsd != null && reservationUsd == null) throw new Error("A spend threshold requires an explicit per-call reservation estimate");
  const db = getDb();
  return runImmediateTransaction(db, () => {
    if (!db.prepare("SELECT 1 FROM work_items WHERE id = ?").get(id)) throw new Error("Unknown work item");
    const previous = db.prepare("SELECT * FROM work_item_budgets WHERE work_item_id = ?").get(id);
    const audit = JSON.parse(previous?.audit_json || "[]");
    const deadline = minutes == null ? null : Date.now() + Math.ceil(minutes * 60000);
    if (deadline != null && !Number.isSafeInteger(deadline)) throw new Error("Wall-time threshold is out of range");
    audit.push({ action: "configure", limit_usd: limitUsd, reservation_usd: reservationUsd, deadline_at: deadline, at: new Date().toISOString() });
    db.prepare(`INSERT INTO work_item_budgets (work_item_id, enabled, limit_usd, reservation_usd, deadline_at, audit_json) VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET enabled = 1, limit_usd = excluded.limit_usd, reservation_usd = excluded.reservation_usd,
      deadline_at = excluded.deadline_at, audit_json = excluded.audit_json`).run(id, limitUsd, reservationUsd, deadline, JSON.stringify(audit));
    // Enabling a work-item threshold mid-run includes prior calls. Calls whose
    // receipts are incomplete stay unknown; an empty price is never free.
    for (const call of db.prepare(`SELECT a.* FROM agent_calls a WHERE a.work_item_id = ?
      AND NOT EXISTS (SELECT 1 FROM budget_reservations r WHERE r.agent_call_id = a.id)`).all(id)) {
      const cost = completedCost({ agent_call_id: call.id }, db);
      db.prepare(`INSERT INTO budget_reservations (id, work_item_id, job_id, agent_call_id, attempt_id, owner_pid, provider, model, role,
        cost_usd, state, started_at, finished_at, reconciliation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`historical:${call.id}`, id, call.job_id, call.id, call.attempt_id, 0, call.provider, call.model_name, call.role, cost,
          cost == null ? S.UNKNOWN : S.SETTLED, Date.parse(call.started_at) || Date.now(), call.finished_at ? Date.parse(call.finished_at) : null, "included_at_configuration");
    }
    const current = snapshot(id, db);
    if (limitUsd != null && current.unknown_costs) pause(id, R.UNKNOWN, db);
    else if (limitUsd != null && current.spent_usd + current.reserved_usd + reservationUsd > limitUsd) pause(id, R.SPEND, db);
    return snapshot(id, db);
  });
}
export function changeBudgetState(id, action) {
  if (!["pause", "resume", "disable"].includes(action)) throw new Error("Expected pause, resume or disable");
  const db = getDb();
  const result = runImmediateTransaction(db, () => {
    reconcileDead(id, db);
    const budget = snapshot(id, db);
    if (!budget) throw new Error("No admission budget configured");
    if (action === "resume" && ((budget.limit_usd != null && (budget.unknown_costs || budget.spent_usd + budget.reserved_usd + budget.reservation_usd > budget.limit_usd))
      || (budget.deadline_at != null && Date.now() >= budget.deadline_at))) return { resumeBlocked: true };
    const audit = JSON.parse(budget.audit_json); audit.push({ action, at: new Date().toISOString() });
    db.prepare("UPDATE work_item_budgets SET enabled = ?, paused_reason = ?, audit_json = ? WHERE work_item_id = ?")
      .run(action === "disable" ? 0 : 1, action === "pause" ? R.OPERATOR : null, JSON.stringify(audit), id);
    return snapshot(id, db);
  });
  if (result.resumeBlocked) throw new Error("Reconcile unknown costs or increase the threshold before resuming");
  logEvent({ work_item_id: id, event_type: EVENT_TYPES.WORK_ITEM_BUDGET_CHANGED, actor_type: EVENT_ACTORS.HUMAN, message: `Budget ${action}` });
  notifyQueueStateChanged({ reason: "budget_changed", workItemId: id });
  return result;
}
export function reconcileBudgetCost(id, reservationId, costUsd, reason) {
  if (!Number.isFinite(costUsd) || costUsd < 0 || !String(reason || "").trim()) throw new Error("Reconciliation requires a nonnegative observed cost and a reason");
  const db = getDb();
  return runImmediateTransaction(db, () => {
    reconcileDead(id, db);
    const row = db.prepare("SELECT * FROM budget_reservations WHERE id = ? AND work_item_id = ?").get(reservationId, id);
    if (!row || row.state === S.SETTLED) throw new Error("No unresolved reservation");
    const call = row.agent_call_id ? db.prepare("SELECT status FROM agent_calls WHERE id = ?").get(row.agent_call_id) : null;
    const attempt = row.attempt_id ? db.prepare("SELECT status FROM job_attempts WHERE id = ?").get(row.attempt_id) : null;
    if ((row.state === S.RESERVED && ownerAlive(row.owner_pid)) || (row.owner_pid === 0 && call?.status === "running" && (!row.attempt_id || attempt?.status === "running"))) throw new Error("Cannot reconcile an in-flight call");
    db.prepare("UPDATE budget_reservations SET cost_usd = ?, state = ?, reconciliation_reason = ?, finished_at = ? WHERE id = ?")
      .run(costUsd, S.SETTLED, String(reason), Date.now(), reservationId);
    return snapshot(id, db);
  });
}
