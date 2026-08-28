import { randomUUID } from "node:crypto";

import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";
import { finalizeApprovedWorkItemMerge } from "./queue-store.js";
import { logDurableEvent } from "./events.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";

export const SHARED_TRUNK_MERGE_PURPOSES = Object.freeze(["final", "iterative"]);
export const SHARED_TRUNK_MERGE_PHASES = Object.freeze([
  "intent",
  "candidate",
  "publish_unknown",
  "deferred",
  "published",
]);

const PURPOSE_SET = new Set(SHARED_TRUNK_MERGE_PURPOSES);
const PHASE_SET = new Set(SHARED_TRUNK_MERGE_PHASES);
const UNRESOLVED_PHASES = Object.freeze(["intent", "candidate", "publish_unknown"]);
const UNRESOLVED_PHASE_SQL = UNRESOLVED_PHASES.map(() => "?").join(",");

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function requiredWorkItemId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("workItemId must be a positive integer");
  return id;
}

function decodeOperation(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    workItemId: Number(row.work_item_id),
    purpose: row.purpose,
    purposeKey: row.purpose_key,
    sourceBranch: row.source_branch,
    sourceSha: row.source_sha,
    targetBranch: row.target_branch,
    remote: row.remote,
    baseSha: row.base_sha,
    expectedRemoteSha: row.expected_remote_sha,
    candidateSha: row.candidate_sha || null,
    phase: row.phase,
    attempt: Number(row.attempt) || 0,
    version: Number(row.version) || 0,
    lastErrorCode: row.last_error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectOperation(db, operationId) {
  return decodeOperation(db.prepare(`
    SELECT * FROM shared_trunk_merge_operations WHERE operation_id = ?
  `).get(operationId));
}

/**
 * Persist the intent before the first external Git mutation. Repeated calls for
 * the same WI/purpose/source identity return the existing journal row so a
 * restarted coordinator continues rather than opening a competing operation.
 */
export function beginSharedTrunkMergeOperation({
  operationId = randomUUID(),
  workItemId,
  purpose = "final",
  purposeKey = null,
  sourceBranch,
  sourceSha,
  targetBranch,
  remote,
  baseSha,
  expectedRemoteSha,
  attempt = 0,
} = {}) {
  const normalizedPurpose = requiredString(purpose, "purpose");
  if (!PURPOSE_SET.has(normalizedPurpose)) throw new TypeError(`Unsupported shared-trunk merge purpose: ${normalizedPurpose}`);
  const normalizedSourceSha = requiredString(sourceSha, "sourceSha");
  const input = {
    operationId: requiredString(operationId, "operationId"),
    workItemId: requiredWorkItemId(workItemId),
    purpose: normalizedPurpose,
    purposeKey: requiredString(purposeKey || normalizedSourceSha, "purposeKey"),
    sourceBranch: requiredString(sourceBranch, "sourceBranch"),
    sourceSha: normalizedSourceSha,
    targetBranch: requiredString(targetBranch, "targetBranch"),
    remote: requiredString(remote, "remote"),
    baseSha: requiredString(baseSha, "baseSha"),
    expectedRemoteSha: requiredString(expectedRemoteSha, "expectedRemoteSha"),
    attempt: Math.max(0, Number.parseInt(String(attempt), 10) || 0),
  };
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const existing = db.prepare(`
      SELECT * FROM shared_trunk_merge_operations
      WHERE work_item_id = ? AND purpose = ? AND purpose_key = ?
    `).get(input.workItemId, input.purpose, input.purposeKey);
    if (existing) return decodeOperation(existing);
    const ts = now();
    db.prepare(`
      INSERT INTO shared_trunk_merge_operations (
        operation_id, work_item_id, purpose, purpose_key,
        source_branch, source_sha, target_branch, remote,
        base_sha, expected_remote_sha, candidate_sha,
        phase, attempt, version, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'intent', ?, 1, NULL, ?, ?)
    `).run(
      input.operationId,
      input.workItemId,
      input.purpose,
      input.purposeKey,
      input.sourceBranch,
      input.sourceSha,
      input.targetBranch,
      input.remote,
      input.baseSha,
      input.expectedRemoteSha,
      input.attempt,
      ts,
      ts,
    );
    return selectOperation(db, input.operationId);
  });
}

export function getSharedTrunkMergeOperation(operationId) {
  return selectOperation(getDb(), requiredString(operationId, "operationId"));
}

export function findSharedTrunkMergeOperation({
  workItemId,
  purpose = "final",
  purposeKey = null,
  sourceSha = null,
} = {}) {
  const db = getDb();
  const key = purposeKey || sourceSha;
  if (key) {
    return decodeOperation(db.prepare(`
      SELECT * FROM shared_trunk_merge_operations
      WHERE work_item_id = ? AND purpose = ? AND purpose_key = ?
      LIMIT 1
    `).get(requiredWorkItemId(workItemId), requiredString(purpose, "purpose"), requiredString(key, "purposeKey")));
  }
  return decodeOperation(db.prepare(`
    SELECT * FROM shared_trunk_merge_operations
    WHERE work_item_id = ? AND purpose = ?
    ORDER BY updated_at DESC, operation_id DESC
    LIMIT 1
  `).get(requiredWorkItemId(workItemId), requiredString(purpose, "purpose")));
}

export function listUnresolvedSharedTrunkMergeOperations({ workItemId = null } = {}) {
  const db = getDb();
  const rows = workItemId == null
    ? db.prepare(`
        SELECT * FROM shared_trunk_merge_operations
        WHERE phase IN (${UNRESOLVED_PHASE_SQL})
        ORDER BY created_at, operation_id
      `).all(...UNRESOLVED_PHASES)
    : db.prepare(`
        SELECT * FROM shared_trunk_merge_operations
        WHERE work_item_id = ? AND phase IN (${UNRESOLVED_PHASE_SQL})
        ORDER BY created_at, operation_id
      `).all(requiredWorkItemId(workItemId), ...UNRESOLVED_PHASES);
  return rows.map(decodeOperation);
}

export function hasUnresolvedSharedTrunkMergeOperation(workItemId) {
  const row = getDb().prepare(`
    SELECT 1 AS one FROM shared_trunk_merge_operations
    WHERE work_item_id = ? AND phase IN (${UNRESOLVED_PHASE_SQL})
    LIMIT 1
  `).get(requiredWorkItemId(workItemId), ...UNRESOLVED_PHASES);
  return !!row;
}

/** Versioned phase transition. A stale writer receives null. */
export function transitionSharedTrunkMergeOperation(operationId, {
  expectedVersion,
  phase,
  candidateSha = undefined,
  baseSha = undefined,
  expectedRemoteSha = undefined,
  attempt = undefined,
  lastErrorCode = undefined,
} = {}) {
  const normalizedPhase = requiredString(phase, "phase");
  if (!PHASE_SET.has(normalizedPhase)) throw new TypeError(`Unsupported shared-trunk merge phase: ${normalizedPhase}`);
  if (normalizedPhase === "published") {
    throw new TypeError("Use finalizePublishedSharedTrunkMergeOperation for atomic publication settlement");
  }
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version <= 0) throw new TypeError("expectedVersion must be a positive integer");
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const current = selectOperation(db, requiredString(operationId, "operationId"));
    if (!current || current.version !== version) return null;
    const nextCandidate = candidateSha === undefined ? current.candidateSha : (candidateSha ? String(candidateSha).trim() : null);
    const nextBase = baseSha === undefined ? current.baseSha : requiredString(baseSha, "baseSha");
    const nextExpected = expectedRemoteSha === undefined
      ? current.expectedRemoteSha
      : requiredString(expectedRemoteSha, "expectedRemoteSha");
    const nextAttempt = attempt === undefined
      ? current.attempt
      : Math.max(0, Number.parseInt(String(attempt), 10) || 0);
    const nextError = lastErrorCode === undefined
      ? current.lastErrorCode
      : (lastErrorCode ? String(lastErrorCode).slice(0, 160) : null);
    const result = db.prepare(`
      UPDATE shared_trunk_merge_operations
      SET phase = ?, candidate_sha = ?, base_sha = ?, expected_remote_sha = ?,
          attempt = ?, last_error_code = ?, version = version + 1, updated_at = ?
      WHERE operation_id = ? AND version = ?
    `).run(
      normalizedPhase,
      nextCandidate,
      nextBase,
      nextExpected,
      nextAttempt,
      nextError,
      now(),
      current.operationId,
      version,
    );
    return result.changes === 1 ? selectOperation(db, current.operationId) : null;
  });
}

/**
 * Atomically record proven publication, durable merge evidence, and final-WI
 * settlement.  Keeping these writes in one SQLite transaction ensures a
 * published journal row can never hide an unfinalized work item after a crash.
 */
export function finalizePublishedSharedTrunkMergeOperation(operationId, {
  expectedVersion,
  remoteSha = null,
  recovered = false,
} = {}) {
  const id = requiredString(operationId, "operationId");
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version <= 0) throw new TypeError("expectedVersion must be a positive integer");
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const operation = selectOperation(db, id);
    if (!operation || operation.version !== version) return null;
    if (operation.phase === "published") return operation;
    if (!["candidate", "publish_unknown"].includes(operation.phase) || !operation.candidateSha) {
      throw new Error(`Shared-trunk operation ${id} has no publishable candidate`);
    }

    const eventType = operation.purpose === "final"
      ? EVENT_TYPES.WORK_ITEM_MERGED
      : EVENT_TYPES.WORK_ITEM_ITERATION_PASS_MERGED;
    const evidencePattern = `%\"operation_id\":\"${id.replace(/[%_]/g, "\\$&")}\"%`;
    const evidenceExists = db.prepare(`
      SELECT 1 AS one FROM events
      WHERE work_item_id = ? AND event_type = ? AND event_json LIKE ? ESCAPE '\\'
      LIMIT 1
    `).get(operation.workItemId, eventType, evidencePattern);
    if (!evidenceExists) {
      logDurableEvent({
        work_item_id: operation.workItemId,
        event_type: eventType,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: operation.purpose === "final"
          ? `Published ${operation.sourceBranch} to shared trunk ${operation.targetBranch}`
          : `Published iterative pass from ${operation.sourceBranch} to shared trunk ${operation.targetBranch}`,
        event_json: JSON.stringify({
          operation_id: id,
          purpose: operation.purpose,
          branch: operation.sourceBranch,
          source_sha: operation.sourceSha,
          merge_hash: operation.candidateSha,
          target_branch: operation.targetBranch,
          remote: operation.remote,
          remote_sha: remoteSha || operation.candidateSha,
          recovered: recovered === true,
        }),
      });
    }
    if (operation.purpose === "final") {
      const settlement = finalizeApprovedWorkItemMerge(operation.workItemId);
      if (!settlement?.ok) throw new Error(`Queue settlement failed for shared-trunk operation ${id}`);
    }
    const updated = db.prepare(`
      UPDATE shared_trunk_merge_operations
      SET phase = 'published', last_error_code = NULL,
          version = version + 1, updated_at = ?
      WHERE operation_id = ? AND version = ?
    `).run(now(), id, version);
    if (updated.changes !== 1) throw new Error(`Shared-trunk operation ${id} changed concurrently`);
    return selectOperation(db, id);
  });
}
