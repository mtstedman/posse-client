import { createHash } from "crypto";
import {
  canonicalHumanGateAction,
  humanGateContractForPayload,
} from "../../../catalog/human-input.js";
import { TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";

const ACTIVE_GATE_STATES = Object.freeze(["open", "resolving"]);

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

export function findActiveHumanGateForPayload(payload, { parentJobId = null } = {}) {
  const db = getDb();
  const contract = humanGateContractForPayload(asPayload(payload), { parentJobId });
  if (!contract.original_job_id) return null;
  return hydrateGate(db.prepare(`
    SELECT *
    FROM human_gates
    WHERE original_job_id = ?
      AND gate_kind = ?
      AND gate_state IN ('open','resolving')
    ORDER BY generation DESC
    LIMIT 1
  `).get(contract.original_job_id, contract.gate_kind));
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
      : null;
    if (competing) return hydrateGate(competing);

    const previous = contract.original_job_id
      ? db.prepare(`
          SELECT MAX(generation) AS generation
          FROM human_gates
          WHERE original_job_id = ? AND gate_kind = ?
        `).get(contract.original_job_id, contract.gate_kind)
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
    if (requireLease && (!leaseToken || gateJob.lease_token !== leaseToken)) {
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

export function reconcileHumanGates() {
  const db = getDb();
  return executeTransaction(db, () => {
    let registered = 0;
    let reopened = 0;
    let retired = 0;
    const missing = db.prepare(`
      SELECT id, parent_job_id, payload_json
      FROM jobs
      WHERE job_type = 'human_input'
        AND NOT EXISTS (
          SELECT 1 FROM human_gates hg WHERE hg.gate_job_id = jobs.id
        )
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
        }
      } catch {
        // A newer active gate for the same original/kind is authoritative.
      }
    }

    const inconsistent = db.prepare(`
      SELECT hg.gate_job_id, hg.gate_state, j.status
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
      } else if (row.status === "canceled") {
        db.prepare(`
          UPDATE human_gates
          SET gate_state='superseded', resolved_at=?, updated_at=?,
              resolver_lease_token=NULL
          WHERE gate_job_id=?
        `).run(now(), now(), row.gate_job_id);
        retired += 1;
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
      }
    }
    return { registered, reopened, retired };
  });
}

export { ACTIVE_GATE_STATES };
