import { createHash } from "crypto";
import {
  canonicalHumanGateAction,
  humanGateContractForPayload,
} from "../../../catalog/human-input.js";
import { EVENT_TYPES } from "../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";
import { TERMINAL_WORK_ITEM_STATUSES_SQL } from "../../../catalog/work-item.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";
import { flushEventsNow } from "./events.js";
import { jobHasLiveLeaseAt } from "./lease-state.js";

const ACTIVE_GATE_STATES = Object.freeze(["open", "resolving"]);
const WORK_ITEM_SINGLETON_GATE_KINDS = new Set(["oneshot_scope_selection"]);
let _humanGateReconcileHook = null;

// queue-store owns the authoritative work-item state machine, while it also
// imports this module for gate registration. Register a callback after that
// state machine is initialized instead of introducing a circular import.
export function __registerHumanGateReconcileHook(fn) {
  _humanGateReconcileHook = typeof fn === "function" ? fn : null;
}

function asPayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function humanGatePromptFingerprint(payload = {}) {
  const promptPayload = Object.fromEntries(
    Object.entries(asPayload(payload))
      .filter(([key]) => !String(key).startsWith("_human_prompt_")),
  );
  return createHash("sha256")
    .update(JSON.stringify(promptPayload))
    .digest("hex")
    .slice(0, 16);
}

function hydrateGate(row) {
  if (!row) return null;
  return {
    ...row,
    allowed_source_states: jsonArray(row.allowed_source_states_json),
    allowed_actions: jsonArray(row.allowed_actions_json),
  };
}

function executeTransaction(db, fn) {
  return db.inTransaction ? fn() : runImmediateTransaction(db, fn);
}

export function humanGateIdempotencyKey({
  gateJobId,
  generation,
  action,
  requestKey = null,
} = {}) {
  if (requestKey != null && String(requestKey).trim()) {
    return String(requestKey).trim().slice(0, 240);
  }
  return createHash("sha256")
    .update(`${Number(gateJobId) || 0}:${Number(generation) || 1}:${canonicalHumanGateAction(action) || "respond"}`)
    .digest("hex");
}

export function findActiveHumanGateForPayload(payload, {
  parentJobId = null,
  workItemId = null,
} = {}) {
  const db = getDb();
  const contract = humanGateContractForPayload(asPayload(payload), { parentJobId });
  if (contract.original_job_id) {
    return hydrateGate(db.prepare(`
      SELECT hg.*
      FROM human_gates hg
      JOIN jobs j ON j.id = hg.gate_job_id
      WHERE hg.original_job_id = ?
        AND hg.gate_kind = ?
        AND hg.gate_state IN ('open','resolving')
        AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      ORDER BY hg.generation DESC
      LIMIT 1
    `).get(contract.original_job_id, contract.gate_kind));
  }
  const normalizedWorkItemId = Number(workItemId);
  if (
    !WORK_ITEM_SINGLETON_GATE_KINDS.has(contract.gate_kind)
    || !Number.isInteger(normalizedWorkItemId)
    || normalizedWorkItemId <= 0
  ) return null;
  return hydrateGate(db.prepare(`
    SELECT hg.*
    FROM human_gates hg
    JOIN jobs j ON j.id = hg.gate_job_id
    WHERE hg.original_job_id IS NULL
      AND j.work_item_id = ?
      AND hg.gate_kind = ?
      AND hg.gate_state IN ('open','resolving')
      AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
    ORDER BY hg.generation DESC
    LIMIT 1
  `).get(normalizedWorkItemId, contract.gate_kind));
}

export function registerHumanGate({
  gateJobId,
  payload = {},
  parentJobId = null,
} = {}) {
  const db = getDb();
  return executeTransaction(db, () => {
    const existing = db.prepare(`SELECT * FROM human_gates WHERE gate_job_id = ?`).get(gateJobId);
    if (existing) return hydrateGate(existing);

    const normalizedPayload = asPayload(payload);
    const contract = humanGateContractForPayload(normalizedPayload, { parentJobId });
    const gateJob = db.prepare(`SELECT work_item_id FROM jobs WHERE id = ?`).get(gateJobId);
    const singletonWorkItemIdCandidate = !contract.original_job_id
      && WORK_ITEM_SINGLETON_GATE_KINDS.has(contract.gate_kind)
      ? Number(gateJob?.work_item_id)
      : null;
    const singletonWorkItemId = Number.isInteger(singletonWorkItemIdCandidate)
      && singletonWorkItemIdCandidate > 0
      ? singletonWorkItemIdCandidate
      : null;
    if (contract.original_job_id) {
      // Gate/job state can drift between maintenance sweeps. A terminal or
      // missing gate job cannot answer a new request, but its open contract
      // still occupies the unique active slot unless creation retires it.
      const ts = now();
      db.prepare(`
        UPDATE human_gates
        SET gate_state = 'superseded',
            resolver_lease_token = NULL,
            resolution_error = COALESCE(
              resolution_error,
              'Superseded by a new gate after the prior gate job became terminal or disappeared'
            ),
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE original_job_id = ?
          AND gate_kind = ?
          AND gate_state IN ('open','resolving')
          AND NOT EXISTS (
            SELECT 1
            FROM jobs j
            WHERE j.id = human_gates.gate_job_id
              AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
          )
      `).run(ts, ts, contract.original_job_id, contract.gate_kind);
    } else if (singletonWorkItemId) {
      const ts = now();
      db.prepare(`
        UPDATE human_gates
        SET gate_state = 'superseded',
            resolver_lease_token = NULL,
            resolution_error = COALESCE(
              resolution_error,
              'Superseded by a new gate after the prior gate job became terminal or disappeared'
            ),
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE original_job_id IS NULL
          AND gate_kind = ?
          AND gate_state IN ('open','resolving')
          AND EXISTS (
            SELECT 1
            FROM jobs stale
            JOIN jobs owner ON owner.id = ?
            WHERE stale.id = human_gates.gate_job_id
              AND stale.work_item_id = owner.work_item_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs j
            WHERE j.id = human_gates.gate_job_id
              AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
          )
      `).run(ts, ts, contract.gate_kind, gateJobId);
    }
    const competing = contract.original_job_id
      ? db.prepare(`
          SELECT *
          FROM human_gates
          WHERE original_job_id = ?
            AND gate_kind = ?
            AND gate_state IN ('open','resolving')
          ORDER BY generation DESC
          LIMIT 1
        `).get(contract.original_job_id, contract.gate_kind)
      : singletonWorkItemId
        ? db.prepare(`
            SELECT hg.*
            FROM human_gates hg
            JOIN jobs j ON j.id = hg.gate_job_id
            WHERE hg.original_job_id IS NULL
              AND j.work_item_id = ?
              AND hg.gate_kind = ?
              AND hg.gate_state IN ('open','resolving')
            ORDER BY hg.generation DESC
            LIMIT 1
          `).get(singletonWorkItemId, contract.gate_kind)
        : null;
    if (competing) return hydrateGate(competing);

    const previous = contract.original_job_id
      ? db.prepare(`
          SELECT MAX(generation) AS generation
          FROM human_gates
          WHERE original_job_id = ? AND gate_kind = ?
        `).get(contract.original_job_id, contract.gate_kind)
      : singletonWorkItemId
        ? db.prepare(`
            SELECT MAX(hg.generation) AS generation
            FROM human_gates hg
            JOIN jobs j ON j.id = hg.gate_job_id
            WHERE hg.original_job_id IS NULL
              AND j.work_item_id = ?
              AND hg.gate_kind = ?
          `).get(singletonWorkItemId, contract.gate_kind)
        : null;
    const generation = Math.max(1, Number(previous?.generation || 0) + 1);
    const original = contract.original_job_id
      ? db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(contract.original_job_id)
      : null;
    db.prepare(`
      INSERT INTO human_gates (
        gate_job_id, gate_kind, contract_version, original_job_id, generation,
        gate_state, expected_original_status, allowed_source_states_json,
        allowed_actions_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `).run(
      gateJobId,
      contract.gate_kind,
      contract.contract_version,
      contract.original_job_id,
      generation,
      original?.status || null,
      JSON.stringify(contract.allowed_source_states),
      JSON.stringify(contract.allowed_actions),
      now(),
      now(),
    );
    return hydrateGate(db.prepare(`SELECT * FROM human_gates WHERE gate_job_id = ?`).get(gateJobId));
  });
}

export function getHumanGate(gateJobId) {
  return hydrateGate(getDb().prepare(
    `SELECT * FROM human_gates WHERE gate_job_id = ?`
  ).get(gateJobId));
}

/**
 * Atomically reserve one automatic TUI presentation for the gate's current
 * durable generation/resurface tuple. Process-local prompt maps prevent
 * duplicate snapshots within one run; this marker prevents the same parked
 * plan or push decision from being announced again on every CLI restart.
 * Explicit operator Answer actions intentionally do not call this helper.
 */
export function claimHumanGatePromptPresentation(gateJobId) {
  const db = getDb();
  return executeTransaction(db, () => {
    const row = db.prepare(`
      SELECT j.id, j.status, j.payload_json, hg.generation, hg.gate_state
      FROM jobs j
      JOIN human_gates hg ON hg.gate_job_id = j.id
      WHERE j.id = ?
    `).get(Number(gateJobId));
    if (!row || row.status !== "waiting_on_human" || row.gate_state !== "open") {
      return { claimed: false, reason: "gate_not_presentable" };
    }
    const payload = asPayload(row.payload_json);
    const resurfaceCount = Math.max(
      0,
      Number.parseInt(String(payload._human_prompt_resurface_count || 0), 10) || 0,
    );
    const signature = [
      Math.max(1, Number(row.generation) || 1),
      resurfaceCount,
      humanGatePromptFingerprint(payload),
    ].join(":");
    if (payload._human_prompt_last_presented_signature === signature) {
      return { claimed: false, reason: "already_presented", signature };
    }
    const ts = now();
    const result = db.prepare(`
      UPDATE jobs
      SET payload_json = ?, updated_at = ?
      WHERE id = ? AND status = 'waiting_on_human'
    `).run(JSON.stringify({
      ...payload,
      _human_prompt_last_presented_signature: signature,
      _human_prompt_last_presented_at: ts,
    }), ts, row.id);
    return result.changes === 1
      ? { claimed: true, signature }
      : { claimed: false, reason: "presentation_raced", signature };
  });
}

/**
 * Advance the question generation for a materially revised, still-open gate.
 * Answers and owner-delivery reservations carry this generation, so bumping it
 * atomically invalidates any prompt that was rendered from the older payload.
 */
export function reviseOpenHumanGateGeneration(gateJobId) {
  const db = getDb();
  return executeTransaction(db, () => {
    const row = db.prepare(`
      SELECT gate_job_id, generation, gate_state
      FROM human_gates
      WHERE gate_job_id = ?
    `).get(Number(gateJobId));
    if (!row) return { ok: false, reason: "gate_not_found" };
    if (row.gate_state !== "open") {
      return { ok: false, reason: "gate_not_open", gate_state: row.gate_state };
    }
    const previousGeneration = Math.max(1, Number(row.generation) || 1);
    const nextGeneration = previousGeneration + 1;
    const result = db.prepare(`
      UPDATE human_gates
      SET generation = ?, updated_at = ?
      WHERE gate_job_id = ? AND gate_state = 'open' AND generation = ?
    `).run(nextGeneration, now(), Number(gateJobId), row.generation);
    return result.changes === 1
      ? { ok: true, previous_generation: previousGeneration, generation: nextGeneration }
      : { ok: false, reason: "gate_revision_raced" };
  });
}

export function beginHumanGateResolution({
  gateJobId,
  leaseToken = null,
  action,
  idempotencyKey = null,
  requireLease = true,
} = {}) {
  const db = getDb();
  return executeTransaction(db, () => {
    const row = hydrateGate(db.prepare(
      `SELECT * FROM human_gates WHERE gate_job_id = ?`
    ).get(gateJobId));
    if (!row) return { ok: false, reason: "gate_contract_missing" };

    const canonicalAction = canonicalHumanGateAction(action) || "respond";
    const accepted = new Set([
      ...row.allowed_actions,
      ...row.allowed_actions.map(canonicalHumanGateAction),
    ]);
    if (!accepted.has(action) && !accepted.has(canonicalAction)) {
      return {
        ok: false,
        reason: "action_not_allowed",
        allowed_actions: row.allowed_actions,
      };
    }
    const key = humanGateIdempotencyKey({
      gateJobId,
      generation: row.generation,
      action: canonicalAction,
      requestKey: idempotencyKey,
    });
    if (row.gate_state === "resolved") {
      return row.idempotency_key === key
        ? { ok: true, idempotent: true, gate: row, action: row.resolution_action }
        : { ok: false, reason: "gate_already_resolved", gate: row };
    }
    if (row.gate_state !== "open") {
      return { ok: false, reason: "gate_not_open", gate: row };
    }

    const gateJob = db.prepare(
      `SELECT status, lease_token, lease_expires_at FROM jobs WHERE id = ?`
    ).get(gateJobId);
    if (!gateJob) return { ok: false, reason: "gate_job_missing" };
    if (
      requireLease
      && (
        !leaseToken
        || gateJob.lease_token !== leaseToken
        || !jobHasLiveLeaseAt(gateJob, now())
      )
    ) {
      return { ok: false, reason: "stale_gate_lease" };
    }
    if (row.original_job_id) {
      const original = db.prepare(
        `SELECT status, state_version FROM jobs WHERE id = ?`
      ).get(row.original_job_id);
      if (!original) return { ok: false, reason: "original_job_missing" };
      if (!row.allowed_source_states.includes(original.status)) {
        return {
          ok: false,
          reason: "original_state_changed",
          expected_states: row.allowed_source_states,
          actual_state: original.status,
        };
      }
      const reserved = db.prepare(`
        UPDATE jobs
        SET state_version = state_version + 1, updated_at = ?
        WHERE id = ? AND state_version = ?
      `).run(now(), row.original_job_id, original.state_version);
      if (reserved.changes !== 1) {
        return { ok: false, reason: "original_state_changed" };
      }
    }

    const claimed = db.prepare(`
      UPDATE human_gates
      SET gate_state = 'resolving',
          resolution_action = ?,
          idempotency_key = ?,
          resolver_lease_token = ?,
          resolution_error = NULL,
          updated_at = ?
      WHERE gate_job_id = ? AND gate_state = 'open' AND generation = ?
    `).run(canonicalAction, key, leaseToken, now(), gateJobId, row.generation);
    if (claimed.changes !== 1) return { ok: false, reason: "resolution_raced" };
    return {
      ok: true,
      idempotent: false,
      action: canonicalAction,
      idempotency_key: key,
      gate: getHumanGate(gateJobId),
    };
  });
}

export function completeHumanGateResolution({
  gateJobId,
  leaseToken = null,
  resolution = {},
} = {}) {
  const db = getDb();
  return executeTransaction(db, () => {
    const gate = getHumanGate(gateJobId);
    if (!gate) return { ok: false, reason: "gate_contract_missing" };
    if (gate.gate_state === "resolved") return { ok: true, idempotent: true, gate };
    if (gate.gate_state !== "resolving") return { ok: false, reason: "gate_not_resolving" };
    if (leaseToken != null && gate.resolver_lease_token !== leaseToken) {
      return { ok: false, reason: "stale_gate_lease" };
    }
    if (leaseToken != null) {
      const gateJob = db.prepare(
        `SELECT lease_token, lease_expires_at FROM jobs WHERE id = ?`
      ).get(gateJobId);
      if (gateJob?.lease_token !== leaseToken || !jobHasLiveLeaseAt(gateJob, now())) {
        return { ok: false, reason: "stale_gate_lease" };
      }
    }
    const result = db.prepare(`
      UPDATE human_gates
      SET gate_state = 'resolved',
          resolution_payload_json = ?,
          resolution_error = NULL,
          resolver_lease_token = NULL,
          resolved_at = ?,
          updated_at = ?
      WHERE gate_job_id = ?
        AND gate_state = 'resolving'
        AND (? IS NULL OR resolver_lease_token = ?)
    `).run(
      JSON.stringify(resolution ?? {}),
      now(),
      now(),
      gateJobId,
      leaseToken,
      leaseToken,
    );
    return result.changes === 1
      ? { ok: true, idempotent: false, gate: getHumanGate(gateJobId) }
      : { ok: false, reason: "resolution_raced" };
  });
}

export function reopenHumanGateResolution({
  gateJobId,
  leaseToken = null,
  error = null,
} = {}) {
  const db = getDb();
  return executeTransaction(db, () => {
    const result = db.prepare(`
      UPDATE human_gates
      SET gate_state = 'open',
          resolution_action = NULL,
          idempotency_key = NULL,
          resolver_lease_token = NULL,
          resolution_error = ?,
          updated_at = ?
      WHERE gate_job_id = ?
        AND gate_state = 'resolving'
        AND (? IS NULL OR resolver_lease_token = ?)
    `).run(
      error == null ? null : String(error).slice(0, 2000),
      now(),
      gateJobId,
      leaseToken,
      leaseToken,
    );
    return result.changes === 1;
  });
}

export function supersedeHumanGate(gateJobId, reason = "superseded") {
  const db = getDb();
  return executeTransaction(db, () => {
    const result = db.prepare(`
      UPDATE human_gates
      SET gate_state = 'superseded',
          resolution_error = ?,
          resolver_lease_token = NULL,
          resolved_at = ?,
          updated_at = ?
      WHERE gate_job_id = ? AND gate_state IN ('open','resolving')
    `).run(String(reason).slice(0, 500), now(), now(), gateJobId);
    return result.changes === 1;
  });
}

/**
 * Atomically claim an unanswered, unleased gate for headless timeout.
 * A resolver that acquires the job lease or changes the contract state first
 * wins; timeout recovery must never supersede an accepted/in-flight answer.
 */
export function claimHeadlessHumanGateTimeout(
  gateJobId,
  reason = "Human gate timed out in headless mode",
) {
  const db = getDb();
  return executeTransaction(db, () => {
    const observedAt = now();
    const result = db.prepare(`
      UPDATE human_gates
      SET gate_state = 'superseded',
          resolution_error = ?,
          resolver_lease_token = NULL,
          resolved_at = ?,
          updated_at = ?
      WHERE gate_job_id = ?
        AND gate_state = 'open'
        AND EXISTS (
          SELECT 1
          FROM jobs j
          WHERE j.id = human_gates.gate_job_id
            AND j.status = 'waiting_on_human'
            AND NOT (
              j.lease_token IS NOT NULL
              AND j.lease_expires_at IS NOT NULL
              AND julianday(j.lease_expires_at) IS NOT NULL
              AND julianday(j.lease_expires_at) > julianday(?)
            )
        )
    `).run(
      String(reason).slice(0, 500),
      observedAt,
      observedAt,
      gateJobId,
      observedAt,
    );
    return result.changes === 1;
  });
}

export function enqueueHumanGateEffect({
  gateJobId,
  operationKey,
  operationType,
  payload = null,
} = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO human_gate_outbox (
      gate_job_id, operation_key, operation_type, payload_json
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(operation_key) DO NOTHING
  `).run(
    gateJobId,
    String(operationKey),
    String(operationType),
    payload == null ? null : JSON.stringify(payload),
  );
  return db.prepare(
    `SELECT * FROM human_gate_outbox WHERE operation_key = ?`
  ).get(String(operationKey));
}

export function completeHumanGateEffect({ operationKey, payload = null } = {}) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE human_gate_outbox
    SET state = 'completed', payload_json = ?, completed_at = ?, updated_at = ?,
        attempt_count = attempt_count + 1, last_error = NULL
    WHERE operation_key = ?
  `).run(
    payload == null ? null : JSON.stringify(payload),
    now(),
    now(),
    String(operationKey),
  );
  return result.changes === 1;
}

export function reconcileHumanGates() {
  // Reconciliation uses durable timeout events to distinguish an abandoned
  // gate that should reopen from a headless timeout that must stay terminal.
  // logEvent() is buffered, so make same-process timeout events visible before
  // entering the reconciliation transaction.
  flushEventsNow();
  const db = getDb();
  const affectedWorkItemIds = new Set();
  let mutated = false;
  const noteGateMutation = (workItemId = null) => {
    mutated = true;
    const normalized = Number(workItemId);
    if (Number.isSafeInteger(normalized) && normalized > 0) {
      affectedWorkItemIds.add(normalized);
    }
  };
  const result = executeTransaction(db, () => {
    let registered = 0;
    let reopened = 0;
    let retired = 0;

    const gateWorkItem = db.prepare(`SELECT work_item_id FROM jobs WHERE id = ?`);

    const retireGateJob = (gateJobId, reason) => {
      const ts = now();
      const normalizedReason = String(reason || "Human gate is no longer answerable").slice(0, 500);
      const canceled = db.prepare(`
        UPDATE jobs
        SET status='canceled', finished_at=COALESCE(finished_at, ?),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
            last_error=COALESCE(last_error, ?), updated_at=?
        WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      `).run(ts, normalizedReason, ts, gateJobId);
      const superseded = db.prepare(`
        UPDATE human_gates
        SET gate_state='superseded', resolver_lease_token=NULL,
            resolution_error=COALESCE(resolution_error, ?),
            resolved_at=COALESCE(resolved_at, ?), updated_at=?
        WHERE gate_job_id=? AND gate_state IN ('open','resolving')
      `).run(normalizedReason, ts, ts, gateJobId);
      const changed = canceled.changes > 0 || superseded.changes > 0;
      if (changed) noteGateMutation(gateWorkItem.get(gateJobId)?.work_item_id);
      return changed;
    };

    // A worker records a successful resolution before releasing the gate job
    // lease. If it crashes in that narrow window, the contract is durable but
    // the job remains waiting_on_human. Startup revival used to requeue that
    // row and ask the already-answered question again. Once the old lease is
    // gone, make the contract authoritative over the stale job state. A
    // superseded contract is likewise no longer executable and must not keep
    // its work item active forever.
    const closedContractJobs = db.prepare(`
      SELECT hg.gate_job_id, hg.gate_state, hg.resolution_error, j.work_item_id
      FROM human_gates hg
      JOIN jobs j ON j.id = hg.gate_job_id
      WHERE hg.gate_state IN ('resolved','superseded')
        AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
        AND (
          j.lease_token IS NULL
          OR j.lease_expires_at IS NULL
          OR julianday(j.lease_expires_at) IS NULL
          OR julianday(j.lease_expires_at) <= julianday(?)
        )
    `).all(now());
    for (const row of closedContractJobs) {
      const ts = now();
      const terminalStatus = row.gate_state === "resolved" ? "succeeded" : "canceled";
      const result = db.prepare(`
        UPDATE jobs
        SET status=?, finished_at=COALESCE(finished_at, ?),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
            last_error=CASE
              WHEN ? = 'succeeded' THEN NULL
              ELSE COALESCE(last_error, ?, 'Human gate contract was superseded')
            END,
            state_version=state_version + 1, updated_at=?
        WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
          AND (
            lease_token IS NULL
            OR lease_expires_at IS NULL
            OR julianday(lease_expires_at) IS NULL
            OR julianday(lease_expires_at) <= julianday(?)
          )
      `).run(
        terminalStatus,
        ts,
        terminalStatus,
        row.resolution_error,
        ts,
        row.gate_job_id,
        ts,
      );
      if (result.changes > 0) {
        retired += 1;
        noteGateMutation(row.work_item_id);
      }
    }

    // A terminal work item has no remaining question to answer. Retire any
    // stale gate before registration/repair can revive it. Push offers are the
    // deliberate exception: they attach to a completed WI only as a durable
    // publication anchor and remain independently answerable.
    const terminalWorkItemGates = db.prepare(`
      SELECT j.id, j.work_item_id, j.job_type, j.status, j.payload_json,
             hg.gate_state
      FROM jobs j
      JOIN work_items wi ON wi.id = j.work_item_id
      LEFT JOIN human_gates hg ON hg.gate_job_id = j.id
      WHERE j.job_type = 'human_input'
        AND wi.status IN (${TERMINAL_WORK_ITEM_STATUSES_SQL})
        AND (
          j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
          OR hg.gate_state IN ('open','resolving')
        )
    `).all().filter((job) => asPayload(job.payload_json).subtype !== "push_offer");
    for (const job of terminalWorkItemGates) {
      if (retireGateJob(job.id, "Owning work item is terminal")) retired += 1;
    }

    // If the original job left every state permitted by the gate contract,
    // no advertised action can succeed: beginHumanGateResolution would reject
    // it as original_state_changed forever. Retire an open prompt before the
    // TUI/bridge can keep presenting an impossible decision. A resolving gate
    // is excluded because its accepted action may itself be changing state.
    const sourceStateDrift = db.prepare(`
      SELECT hg.gate_job_id, hg.allowed_source_states_json,
             original.status AS original_status
      FROM human_gates hg
      JOIN jobs gate_job ON gate_job.id = hg.gate_job_id
      JOIN jobs original ON original.id = hg.original_job_id
      WHERE hg.gate_state = 'open'
        AND gate_job.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
    `).all().filter((row) => (
      !jsonArray(row.allowed_source_states_json).includes(row.original_status)
    ));
    for (const row of sourceStateDrift) {
      if (retireGateJob(
        row.gate_job_id,
        `Original job state ${row.original_status} is outside the gate contract`,
      )) retired += 1;
    }

    // ON DELETE SET NULL preserves a gate after its original job is pruned.
    // The payload retains the original identity, so distinguish that broken
    // reference from a legitimate standalone clarification or push offer.
    const originalJobExists = db.prepare(`SELECT 1 FROM jobs WHERE id = ?`);
    const missingOriginalGates = db.prepare(`
      SELECT hg.gate_job_id, gate_job.payload_json
      FROM human_gates hg
      JOIN jobs gate_job ON gate_job.id = hg.gate_job_id
      WHERE hg.gate_state = 'open'
        AND hg.original_job_id IS NULL
        AND gate_job.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
    `).all().map((row) => {
      const payload = asPayload(row.payload_json);
      const referencedId = Number(payload.original_job_id ?? payload.plan_job_id);
      return {
        ...row,
        referencedId: Number.isSafeInteger(referencedId) && referencedId > 0
          ? referencedId
          : null,
      };
    }).filter((row) => (
      row.referencedId != null
      && !originalJobExists.get(row.referencedId)
    ));
    for (const row of missingOriginalGates) {
      if (retireGateJob(
        row.gate_job_id,
        `Original job #${row.referencedId} no longer exists`,
      )) retired += 1;
    }

    const missing = db.prepare(`
      SELECT id, work_item_id, parent_job_id, payload_json, status
      FROM jobs
      WHERE job_type = 'human_input'
        -- Terminal history is not answerable and does not need a gate
        -- contract synthesized during an upgrade. Letting it compete with a
        -- current gate can make stale history own the unique active contract
        -- and cancel the actual question. Existing contracts still go through
        -- the terminal drift repair below, where durable gate intent is known.
        AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM human_gates hg WHERE hg.gate_job_id = jobs.id
        )
      -- If legacy data contains duplicates with no contracts, preserve the
      -- newest question and retire older copies deterministically.
      ORDER BY id DESC
    `).all();
    for (const job of missing) {
      try {
        const gate = registerHumanGate({
          gateJobId: job.id,
          payload: asPayload(job.payload_json),
          parentJobId: job.parent_job_id,
        });
        if (Number(gate?.gate_job_id) === Number(job.id)) {
          registered += 1;
          noteGateMutation(job.work_item_id);
        } else {
          db.prepare(`
            UPDATE jobs
            SET status='canceled', finished_at=COALESCE(finished_at, ?),
                lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
                last_error='Superseded by an existing active human gate',
                updated_at=?
            WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
          `).run(now(), now(), job.id);
          retired += 1;
          noteGateMutation(job.work_item_id);
        }
      } catch (error) {
        // An IMMEDIATE transaction excludes a concurrent registration race.
        // If a legacy row still cannot acquire a durable contract (most often
        // because its referenced original was already pruned), leaving the job
        // answerable would make every sweep/prompt repeat the same failure.
        const detail = error instanceof Error ? error.message : String(error);
        if (retireGateJob(
          job.id,
          `Could not establish durable gate contract: ${detail}`,
        )) retired += 1;
      }
    }

    // An open gate whose gate job row (or whole work item) no longer exists
    // is unanswerable: nothing can lease it, no resolver can act on it, and
    // it lingers in gate listings forever (wowiekowie run: developer_blocked
    // gate #136 stayed open for days after its job and WI rows were pruned).
    // Every other sweep in this function inner-joins jobs, so orphans are
    // invisible to them — retire them here.
    const orphaned = db.prepare(`
      SELECT hg.gate_job_id, j.work_item_id
      FROM human_gates hg
      LEFT JOIN jobs j ON j.id = hg.gate_job_id
      LEFT JOIN work_items wi ON wi.id = j.work_item_id
      WHERE hg.gate_state IN ('open','resolving')
        AND (j.id IS NULL OR (j.work_item_id IS NOT NULL AND wi.id IS NULL))
    `).all();
    for (const row of orphaned) {
      db.prepare(`
        UPDATE jobs
        SET status='canceled', finished_at=COALESCE(finished_at, ?),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
            last_error=COALESCE(last_error, 'Gate work item no longer exists'),
            updated_at=?
        WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      `).run(now(), now(), row.gate_job_id);
      db.prepare(`
        UPDATE human_gates
        SET gate_state='superseded', resolved_at=COALESCE(resolved_at, ?), updated_at=?,
            resolver_lease_token=NULL,
            resolution_error=COALESCE(resolution_error, 'Gate job or work item no longer exists')
        WHERE gate_job_id=? AND gate_state IN ('open','resolving')
      `).run(now(), now(), row.gate_job_id);
      retired += 1;
      noteGateMutation(row.work_item_id);
    }

    // Older workers reopened a gate after a valid answer whenever applying
    // the selected action failed. That converts an internal/stale-target
    // failure into an endless human prompt. The durable failure event proves
    // the human already answered; retire those legacy rows instead of
    // resurfacing them again after upgrade.
    const failedResolutions = db.prepare(`
      SELECT DISTINCT hg.gate_job_id, j.work_item_id
      FROM human_gates hg
      JOIN jobs j ON j.id = hg.gate_job_id
      JOIN events e ON e.job_id = hg.gate_job_id
      WHERE hg.gate_state IN ('open','resolving')
        AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
        AND e.event_type = ?
    `).all(EVENT_TYPES.JOB_HUMAN_RESOLUTION_FAILED);
    for (const row of failedResolutions) {
      db.prepare(`
        UPDATE jobs
        SET status='failed', finished_at=COALESCE(finished_at, ?),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
            last_error=COALESCE(last_error, 'Human answer could not be applied'),
            updated_at=?
        WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      `).run(now(), now(), row.gate_job_id);
      db.prepare(`
        UPDATE human_gates
        SET gate_state='superseded', resolver_lease_token=NULL,
            resolution_error=COALESCE(
              resolution_error,
              'Human answer was accepted but its action could not be applied'
            ),
            resolved_at=COALESCE(resolved_at, ?), updated_at=?
        WHERE gate_job_id=? AND gate_state IN ('open','resolving')
      `).run(now(), now(), row.gate_job_id);
      retired += 1;
      noteGateMutation(row.work_item_id);
    }

    // A gate stuck in 'resolving' whose resolver died (crash between
    // beginHumanGateResolution and completeHumanGateResolution) rejects
    // every later answer with gate_not_open — permanently, because the
    // stale resolver_lease_token can never be presented again. A live
    // resolver always holds a current lease on the gate job, so a
    // lease-free (or lease-expired) resolving gate on a non-terminal job
    // is safe to reopen.
    const abandoned = db.prepare(`
      SELECT hg.gate_job_id, hg.original_job_id, j.work_item_id,
             hg.allowed_source_states_json, j.payload_json
      FROM human_gates hg
      JOIN jobs j ON j.id = hg.gate_job_id
      WHERE hg.gate_state = 'resolving'
        AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
        AND (
          j.lease_token IS NULL
          OR j.lease_expires_at IS NULL
          OR julianday(j.lease_expires_at) IS NULL
          OR julianday(j.lease_expires_at) < julianday(?)
        )
    `).all(now());
    for (const row of abandoned) {
      const payload = asPayload(row.payload_json);
      const referencedId = Number(
        row.original_job_id ?? payload.original_job_id ?? payload.plan_job_id,
      );
      const original = Number.isSafeInteger(referencedId) && referencedId > 0
        ? db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(referencedId)
        : null;
      if (Number.isSafeInteger(referencedId) && referencedId > 0 && !original) {
        if (retireGateJob(
          row.gate_job_id,
          `Resolver disappeared after original job #${referencedId} was removed`,
        )) retired += 1;
        continue;
      }
      if (
        original
        && !jsonArray(row.allowed_source_states_json).includes(original.status)
      ) {
        if (retireGateJob(
          row.gate_job_id,
          `Resolver disappeared after the original job already changed to ${original.status}`,
        )) retired += 1;
        continue;
      }
      db.prepare(`
        UPDATE human_gates
        SET gate_state='open', resolution_action=NULL, idempotency_key=NULL,
            resolver_lease_token=NULL,
            resolution_error='Resolver disappeared mid-resolution; gate reopened',
            updated_at=?
        WHERE gate_job_id=? AND gate_state='resolving'
      `).run(now(), row.gate_job_id);
      reopened += 1;
      noteGateMutation(row.work_item_id);
    }

    const inconsistent = db.prepare(`
      SELECT hg.gate_job_id, hg.gate_state, j.status, j.work_item_id,
             EXISTS (
               SELECT 1
               FROM events e
               WHERE e.job_id = hg.gate_job_id
                 AND e.event_type = '${EVENT_TYPES.JOB_HEADLESS_TIMEOUT}'
             ) AS headless_timed_out
      FROM human_gates hg
      JOIN jobs j ON j.id = hg.gate_job_id
      WHERE hg.gate_state IN ('open','resolving')
        AND j.status IN (${TERMINAL_JOB_STATUSES_SQL})
    `).all();
    for (const row of inconsistent) {
      if (row.status === "succeeded") {
        db.prepare(`
          UPDATE human_gates
          SET gate_state='resolved', resolved_at=?, updated_at=?,
              resolver_lease_token=NULL
          WHERE gate_job_id=?
        `).run(now(), now(), row.gate_job_id);
        retired += 1;
        noteGateMutation(row.work_item_id);
      } else if (row.status === "canceled" || row.headless_timed_out) {
        db.prepare(`
          UPDATE human_gates
          SET gate_state='superseded', resolved_at=?, updated_at=?,
              resolver_lease_token=NULL,
              resolution_error=COALESCE(
                resolution_error,
                CASE WHEN ? THEN 'Human gate timed out in headless mode' ELSE 'Human gate was canceled' END
              )
          WHERE gate_job_id=?
        `).run(now(), now(), row.headless_timed_out ? 1 : 0, row.gate_job_id);
        retired += 1;
        noteGateMutation(row.work_item_id);
      } else {
        db.prepare(`
          UPDATE jobs
          SET status='waiting_on_human', finished_at=NULL,
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
              updated_at=?
          WHERE id=?
        `).run(now(), row.gate_job_id);
        db.prepare(`
          UPDATE human_gates
          SET gate_state='open', resolution_action=NULL, idempotency_key=NULL,
              resolver_lease_token=NULL, updated_at=?
          WHERE gate_job_id=?
        `).run(now(), row.gate_job_id);
        reopened += 1;
        noteGateMutation(row.work_item_id);
      }
    }
    return { registered, reopened, retired };
  });
  if (mutated) {
    _humanGateReconcileHook?.([...affectedWorkItemIds]);
  }
  return result;
}

export { ACTIVE_GATE_STATES };
