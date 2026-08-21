import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import {
  WAITING_LANE_DEMAND_REASONS,
  WAITING_LANE_PREPARATORY_STATES,
  WAITING_LANE_STATES,
  WAITING_LANE_TRANSITION_OUTCOMES,
  normalizeWaitingLaneGeneration,
  waitingLaneGenerationsEqual,
} from "../../../catalog/waiting-lane.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { LOCK_HOLDING_JOB_STATUSES, now, runImmediateTransaction } from "./common.js";
import { recordWaitingLaneTelemetry } from "../../observability/functions/waiting-lane-telemetry.js";
import {
  compareWaitingLaneGenerations,
  evaluateWaitingLaneEligibility,
  normalizeWaitingLaneHotPaths,
} from "./waiting-lane-preparation-policy.js";

export {
  compareWaitingLaneGenerations,
  evaluateWaitingLaneEligibility,
  normalizeWaitingLaneHotPaths,
} from "./waiting-lane-preparation-policy.js";

const DEFAULT_MAX_HOT_PATHS = 32;
const ABSOLUTE_MAX_HOT_PATHS = 256;
const DEFAULT_LIST_LIMIT = 100;
// Page-size ceiling, never a lifetime enumeration ceiling. Callers that must
// see every relevant row resume with the compound `(updated_at, work_item_id)`
// keyset cursor returned by the previous page instead of raising this number.
const MAX_LIST_LIMIT = 1000;

const DEMAND_PRIORITY = new Map(
  WAITING_LANE_DEMAND_REASONS.map((reason, index) => [reason, index]),
);
const OUTCOMES = new Set(WAITING_LANE_TRANSITION_OUTCOMES);
const STATE_SET = new Set(WAITING_LANE_STATES);

const sqlList = (values) => [...values].map((value) => `'${value}'`).join(", ");
const MUTATING_JOB_TYPE_SQL = sqlList(MUTATING_JOB_TYPES);
const LIVE_PLANNER_CONSUMER_STATUS_SQL = sqlList(["queued", ...LOCK_HOLDING_JOB_STATUSES]);

const MUTABLE_COLUMNS = new Set([
  "state",
  "demand_reason",
  "target_branch",
  "worktree_root",
  "project_cwd",
  "ownership_record_id",
  "desired_git_oid",
  "desired_atlas_seq",
  "desired_atlas_layer_revision",
  "desired_view_fingerprint",
  "applied_git_oid",
  "applied_atlas_seq",
  "applied_atlas_layer_revision",
  "applied_view_fingerprint",
  "git_job_id",
  "atlas_job_id",
  "successor_needed",
  "hot_paths_json",
  "poisoned_reason",
  "activated_at",
  "retired_at",
]);

function transitionResult(outcome, preparation, reason = null) {
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`Unknown waiting-lane transition outcome: ${outcome}`);
  }
  return reason
    ? { outcome, preparation, reason }
    : { outcome, preparation };
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function generationFromPreparation(row, prefix) {
  if (!row) return null;
  return normalizeWaitingLaneGeneration({
    target_branch: row.target_branch,
    git_oid: row[`${prefix}_git_oid`],
    atlas_ledger_seq: row[`${prefix}_atlas_seq`],
    atlas_layer_revision: row[`${prefix}_atlas_layer_revision`],
    view_fingerprint: row[`${prefix}_view_fingerprint`],
  });
}

function decodePreparation(row) {
  if (!row) return null;
  return {
    ...row,
    hot_paths: normalizeWaitingLaneHotPaths(parseArray(row.hot_paths_json), ABSOLUTE_MAX_HOT_PATHS),
    desired_generation: generationFromPreparation(row, "desired"),
    applied_generation: generationFromPreparation(row, "applied"),
  };
}

function selectPreparation(db, workItemId) {
  return db.prepare(`
    SELECT *
    FROM waiting_lane_preparations
    WHERE work_item_id = ?
  `).get(workItemId);
}

function updatePreparationCas(db, row, changes) {
  const entries = Object.entries(changes);
  if (entries.length === 0) return row;
  for (const [column] of entries) {
    if (!MUTABLE_COLUMNS.has(column)) {
      throw new Error(`Unsupported waiting-lane preparation column: ${column}`);
    }
  }
  const result = db.prepare(`
    UPDATE waiting_lane_preparations
    SET ${entries.map(([column]) => `${column} = ?`).join(", ")},
        version = version + 1,
        updated_at = ?
    WHERE work_item_id = ? AND version = ?
  `).run(
    ...entries.map(([, value]) => value),
    now(),
    row.work_item_id,
    row.version,
  );
  return result.changes === 1 ? selectPreparation(db, row.work_item_id) : null;
}

function generationChanges(generation, prefix = "desired") {
  return {
    [`${prefix}_git_oid`]: generation.git_oid,
    [`${prefix}_atlas_seq`]: generation.atlas_ledger_seq,
    [`${prefix}_atlas_layer_revision`]: generation.atlas_layer_revision,
    [`${prefix}_view_fingerprint`]: generation.view_fingerprint,
  };
}

function normalizeExpectedVersion(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function casRow(db, workItemId, expectedVersion) {
  const row = selectPreparation(db, workItemId);
  if (!row || normalizeExpectedVersion(expectedVersion) !== row.version) return { row, matches: false };
  return { row, matches: true };
}

function jobBelongsToPreparation(db, jobId, workItemId, jobType) {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return false;
  return !!db.prepare(`
    SELECT 1 AS found
    FROM jobs
    WHERE id = ? AND work_item_id = ? AND job_type = ?
  `).get(jobId, workItemId, jobType);
}

function ownershipChanges(row, values) {
  const changes = {};
  for (const [column, value] of Object.entries(values)) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) return null;
    if (row[column] && row[column] !== normalized) return null;
    if (!row[column]) changes[column] = normalized;
  }
  return changes;
}

function normalizedTerminalReason(reason, fallback) {
  return (normalizeOptionalString(reason) || fallback).slice(0, 1000);
}

function isSuccessfulAtlasResult(result) {
  if (result === true) return true;
  const successful = new Set([
    "success",
    "succeeded",
    "ready",
    "applied",
    "tail_applied",
    "cloned",
    "snapshot",
    "caught_up",
    "already_current",
    "prefetched",
  ]);
  if (typeof result === "string") return successful.has(result.trim().toLowerCase());
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const waitingLaneOutcome = typeof result.waiting_lane_outcome === "string"
    ? result.waiting_lane_outcome.trim().toLowerCase()
    : null;
  if (["needs_reprepare", "needs_latest", "superseded"].includes(waitingLaneOutcome)) {
    return false;
  }
  if (result.ok === true) return true;
  return [result.status, result.outcome, result.result, result.waiting_lane_outcome]
    .some((value) => typeof value === "string" && successful.has(value.trim().toLowerCase()));
}

function workItemEligibilityContext(db, workItemId) {
  const workItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(workItemId);
  if (!workItem) return { workItem: null, jobs: [] };
  const jobs = db.prepare(`
    SELECT j.*,
           EXISTS (
             SELECT 1
             FROM job_attempts ja
             WHERE ja.job_id = j.id
               AND ja.commit_hash IS NOT NULL
               AND trim(ja.commit_hash) <> ''
               AND j.job_type IN (${MUTATING_JOB_TYPE_SQL})
           ) AS has_committed_attempt
    FROM jobs j
    WHERE j.work_item_id = ?
  `).all(workItemId);
  return { workItem, jobs };
}

export function getWaitingLanePreparation(workItemId) {
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) return null;
  return decodePreparation(selectPreparation(getDb(), workItemId));
}

/**
 * Compound keyset cursor for `listWaitingLanePreparations`. `work_item_id` is
 * the table's INTEGER PRIMARY KEY, so `(updated_at, work_item_id)` is a total
 * order and resuming strictly after the last returned row can neither skip nor
 * repeat an unchanged row while other rows are inserted concurrently.
 *
 * @param {any} preparation
 * @returns {{ updated_at: string, work_item_id: number } | null}
 */
export function waitingLanePreparationCursor(preparation) {
  const updatedAt = normalizeOptionalString(preparation?.updated_at);
  const workItemId = Number(preparation?.work_item_id);
  if (!updatedAt || !Number.isSafeInteger(workItemId) || workItemId <= 0) return null;
  return { updated_at: updatedAt, work_item_id: workItemId };
}

function normalizeListCursor(after) {
  if (after == null) return null;
  const cursor = waitingLanePreparationCursor(after);
  if (!cursor) {
    throw new TypeError("after must be a { updated_at, work_item_id } waiting-lane cursor");
  }
  return cursor;
}

/**
 * One ordered page of preparation rows. `limit` bounds the page, not the
 * lifetime history: pass `after` with the cursor of the last row to continue.
 */
export function listWaitingLanePreparations({
  states = null,
  targetBranch = null,
  limit = DEFAULT_LIST_LIMIT,
  after = null,
  withWorktreeAsset = false,
} = {}) {
  const db = getDb();
  const stateValues = states == null ? [] : (Array.isArray(states) ? states : [states]);
  if (stateValues.some((state) => !STATE_SET.has(state))) {
    throw new TypeError("states contains an unknown waiting-lane state");
  }
  const normalizedTarget = targetBranch == null ? null : normalizeOptionalString(targetBranch);
  if (targetBranch != null && !normalizedTarget) throw new TypeError("targetBranch must be a non-empty string");
  const cursor = normalizeListCursor(after);
  const normalizedLimit = Number.isSafeInteger(limit) && limit >= 0
    ? Math.min(limit, MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;
  if (normalizedLimit === 0) return [];

  const where = [];
  const params = [];
  if (stateValues.length > 0) {
    where.push(`state IN (${stateValues.map(() => "?").join(", ")})`);
    params.push(...stateValues);
  }
  if (normalizedTarget) {
    where.push("target_branch = ?");
    params.push(normalizedTarget);
  }
  if (withWorktreeAsset) {
    where.push("worktree_root IS NOT NULL AND trim(worktree_root) <> ''");
  }
  if (cursor) {
    where.push("(updated_at > ? OR (updated_at = ? AND work_item_id > ?))");
    params.push(cursor.updated_at, cursor.updated_at, cursor.work_item_id);
  }
  return db.prepare(`
    SELECT *
    FROM waiting_lane_preparations
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at ASC, work_item_id ASC
    LIMIT ?
  `).all(...params, normalizedLimit).map(decodePreparation);
}

/**
 * Complete keyset enumeration of the matching rows, oldest first. Terminal
 * lifetime history can never hide a newer row from a consumer that uses this:
 * there is no lifetime cap, only a page size. Rows whose `updated_at` is
 * rewritten between pages are yielded at most once.
 */
export function* iterateWaitingLanePreparations({
  states = null,
  targetBranch = null,
  withWorktreeAsset = false,
  pageSize = MAX_LIST_LIMIT,
} = {}) {
  const boundedPageSize = Number.isSafeInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, MAX_LIST_LIMIT)
    : MAX_LIST_LIMIT;
  const seen = new Set();
  let after = null;
  for (;;) {
    const page = listWaitingLanePreparations({
      states,
      targetBranch,
      withWorktreeAsset,
      limit: boundedPageSize,
      after,
    });
    if (page.length === 0) return;
    for (const preparation of page) {
      if (seen.has(preparation.work_item_id)) continue;
      seen.add(preparation.work_item_id);
      yield preparation;
    }
    after = waitingLanePreparationCursor(page[page.length - 1]);
    if (!after || page.length < boundedPageSize) return;
  }
}

/**
 * Snapshot of every matching row. Consumers that retire/poison rows while
 * reconciling must use this rather than the lazy iterator, so their own writes
 * cannot reorder the enumeration underneath them.
 */
export function listAllWaitingLanePreparations(options = {}) {
  return [...iterateWaitingLanePreparations(options)];
}

export function ensureWaitingLanePreparation({
  workItemId,
  demandReason,
  targetBranch,
  generation = null,
  worktreeRoot = null,
  projectCwd = null,
  ownershipRecordId = null,
  hotPaths,
} = {}) {
  const normalizedTarget = normalizeOptionalString(targetBranch);
  const normalizedGeneration = generation == null ? null : normalizeWaitingLaneGeneration(generation);
  if (
    !Number.isSafeInteger(workItemId)
    || workItemId <= 0
    || !DEMAND_PRIORITY.has(demandReason)
    || !normalizedTarget
    || (generation != null && !normalizedGeneration)
    || (normalizedGeneration && normalizedGeneration.target_branch !== normalizedTarget)
  ) {
    return transitionResult("ineligible", null, "invalid_request");
  }

  const db = getDb();
  return runImmediateTransaction(db, () => {
    const eligibility = evaluateWaitingLaneEligibility(workItemEligibilityContext(db, workItemId));
    const existing = selectPreparation(db, workItemId);
    if (!eligibility.eligible) {
      return transitionResult("ineligible", decodePreparation(existing), eligibility.reason);
    }

    const normalizedHotPaths = hotPaths === undefined
      ? null
      : normalizeWaitingLaneHotPaths(hotPaths, DEFAULT_MAX_HOT_PATHS);
    if (!existing) {
      db.prepare(`
        INSERT INTO waiting_lane_preparations (
          work_item_id, state, version, demand_reason, target_branch,
          worktree_root, project_cwd, ownership_record_id,
          desired_git_oid, desired_atlas_seq,
          desired_atlas_layer_revision, desired_view_fingerprint,
          hot_paths_json, requested_at, updated_at
        ) VALUES (?, 'requested', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workItemId,
        demandReason,
        normalizedTarget,
        normalizeOptionalString(worktreeRoot),
        normalizeOptionalString(projectCwd),
        normalizeOptionalString(ownershipRecordId),
        normalizedGeneration?.git_oid || null,
        normalizedGeneration?.atlas_ledger_seq ?? null,
        normalizedGeneration?.atlas_layer_revision ?? null,
        normalizedGeneration?.view_fingerprint || null,
        JSON.stringify(normalizedHotPaths || []),
        now(),
        now(),
      );
      return transitionResult("requested_new", decodePreparation(selectPreparation(db, workItemId)));
    }

    if (existing.state === "poisoned") return transitionResult("poisoned", decodePreparation(existing));
    if (existing.state === "retired") return transitionResult("retired", decodePreparation(existing));
    if (existing.state === "activating" || existing.state === "active") {
      return transitionResult("already_current", decodePreparation(existing));
    }
    if (existing.target_branch !== normalizedTarget) {
      return transitionResult("ineligible", decodePreparation(existing), "target_branch_mismatch");
    }

    const changes = {};
    let promoted = false;
    if ((DEMAND_PRIORITY.get(demandReason) || 0) > (DEMAND_PRIORITY.get(existing.demand_reason) || 0)) {
      changes.demand_reason = demandReason;
      promoted = true;
    }
    for (const [column, rawValue] of Object.entries({
      worktree_root: worktreeRoot,
      project_cwd: projectCwd,
      ownership_record_id: ownershipRecordId,
    })) {
      const value = normalizeOptionalString(rawValue);
      if (!value) continue;
      if (existing[column] && existing[column] !== value) {
        return transitionResult("ineligible", decodePreparation(existing), "ownership_mismatch");
      }
      if (!existing[column]) changes[column] = value;
    }
    if (normalizedHotPaths) {
      const serialized = JSON.stringify(normalizedHotPaths);
      if (serialized !== existing.hot_paths_json) changes.hot_paths_json = serialized;
    }

    const currentGeneration = generationFromPreparation(existing, "desired");
    const generationOrder = normalizedGeneration
      ? compareWaitingLaneGenerations(currentGeneration, normalizedGeneration)
      : 0;
    let outcome = promoted ? "promoted" : "coalesced_queued";
    if (generationOrder > 0) {
      Object.assign(changes, generationChanges(normalizedGeneration));
      if (existing.state === "preparing_git" || existing.state === "waiting_atlas") {
        changes.successor_needed = 1;
        outcome = "running_successor_marked";
      } else if (existing.state === "ready") {
        changes.state = "stale";
        outcome = "promoted";
      }
    } else if (existing.state === "ready" && waitingLaneGenerationsEqual(
      existing.applied_generation || generationFromPreparation(existing, "applied"),
      currentGeneration,
    )) {
      outcome = promoted ? "promoted" : "already_current";
    } else if (existing.state === "preparing_git" || existing.state === "waiting_atlas") {
      outcome = promoted ? "promoted" : "already_current";
    }

    if (Object.keys(changes).length === 0) {
      return transitionResult(outcome, decodePreparation(existing));
    }
    const updated = updatePreparationCas(db, existing, changes);
    if (!updated) return transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
    return transitionResult(outcome, decodePreparation(updated));
  });
}

export function claimWaitingLaneGitPreparation({ workItemId, expectedVersion, gitJobId } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const { row, matches } = casRow(db, workItemId, expectedVersion);
    if (!matches) return transitionResult("version_conflict", decodePreparation(row));
    if (!jobBelongsToPreparation(db, gitJobId, workItemId, "waiting_lane_prepare")) {
      return transitionResult("ineligible", decodePreparation(row), "invalid_git_job");
    }
    if (row.state === "preparing_git" && row.git_job_id === gitJobId) {
      return transitionResult("already_current", decodePreparation(row));
    }
    if (!["requested", "stale"].includes(row.state) || !generationFromPreparation(row, "desired")) {
      return transitionResult("ineligible", decodePreparation(row), "state_not_claimable");
    }
    const updated = updatePreparationCas(db, row, {
      state: "preparing_git",
      git_job_id: gitJobId,
      atlas_job_id: null,
      successor_needed: 0,
    });
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function recordWaitingLaneGitPrepared({
  workItemId,
  expectedVersion,
  gitJobId,
  appliedGitOid,
  worktreeRoot,
  projectCwd,
  ownershipRecordId,
  atlasJobId,
} = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const { row, matches } = casRow(db, workItemId, expectedVersion);
    if (!matches) return transitionResult("version_conflict", decodePreparation(row));
    const appliedOid = normalizeOptionalString(appliedGitOid)?.toLowerCase() || null;
    const hasAtlasJob = atlasJobId != null;
    if (
      row.state !== "preparing_git"
      || row.git_job_id !== gitJobId
      || !appliedOid
      || appliedOid !== String(row.desired_git_oid || "").toLowerCase()
      || (hasAtlasJob && !jobBelongsToPreparation(db, atlasJobId, workItemId, "atlas_warm"))
    ) {
      return transitionResult("ineligible", decodePreparation(row), "git_preparation_mismatch");
    }
    const owned = ownershipChanges(row, {
      worktree_root: worktreeRoot,
      project_cwd: projectCwd,
      ownership_record_id: ownershipRecordId,
    });
    if (!owned) return transitionResult("ineligible", decodePreparation(row), "ownership_mismatch");
    const updated = updatePreparationCas(db, row, {
      ...owned,
      state: "waiting_atlas",
      applied_git_oid: appliedOid,
      // Git proof is durable before Atlas proof. Never retain or synthesize a
      // joint applied generation until exact Atlas settlement succeeds.
      applied_atlas_seq: null,
      applied_atlas_layer_revision: null,
      applied_view_fingerprint: null,
      atlas_job_id: hasAtlasJob ? atlasJobId : null,
    });
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function settleWaitingLaneAtlas({
  workItemId,
  expectedVersion,
  atlasJobId,
  actualGeneration,
  result,
} = {}) {
  const db = getDb();
  const transition = runImmediateTransaction(db, () => {
    const { row, matches } = casRow(db, workItemId, expectedVersion);
    if (!matches) return transitionResult("version_conflict", decodePreparation(row));
    if (row.state === "ready" && row.atlas_job_id === atlasJobId) {
      return transitionResult("already_current", decodePreparation(row));
    }
    if (row.state !== "waiting_atlas" || row.atlas_job_id !== atlasJobId) {
      return transitionResult("ineligible", decodePreparation(row), "atlas_job_mismatch");
    }

    const actual = normalizeWaitingLaneGeneration(actualGeneration);
    const desired = generationFromPreparation(row, "desired");
    const exact = !!actual
      && waitingLaneGenerationsEqual(actual, desired)
      && actual.git_oid === String(row.applied_git_oid || "").toLowerCase();
    const succeeded = isSuccessfulAtlasResult(result);
    const explicitStaleOutcome = result && typeof result === "object" && !Array.isArray(result)
      ? String(result.waiting_lane_outcome || "").trim().toLowerCase()
      : "";
    const validButNotCurrent = !!actual
      && !!desired
      && actual.target_branch === desired.target_branch
      && !waitingLaneGenerationsEqual(actual, desired)
      && (
        succeeded
        || ["superseded", "needs_latest"].includes(explicitStaleOutcome)
      );
    let changes;
    if (succeeded && exact) {
      changes = {
        ...generationChanges(actual, "applied"),
        state: "ready",
        successor_needed: 0,
      };
    } else if (validButNotCurrent) {
      changes = {
        state: "stale",
        successor_needed: 1,
      };
    } else {
      const resultObject = result && typeof result === "object" && !Array.isArray(result)
        ? result
        : {};
      const detail = resultObject.waiting_lane_outcome
        || resultObject.status
        || (typeof result === "string" ? result : null)
        || "invalid_or_missing_generation";
      changes = {
        state: "retired",
        successor_needed: 0,
        poisoned_reason: normalizedTerminalReason(`atlas_${detail}`, "atlas_settlement_failed"),
        retired_at: now(),
      };
    }
    const updated = updatePreparationCas(db, row, changes);
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
  recordWaitingLaneTelemetry("atlas_settled", {
    preparation: transition.preparation,
    workItemId,
    jobId: atlasJobId,
    outcome: transition.preparation?.state || transition.outcome,
    reason: transition.reason,
    appliedGeneration: actualGeneration,
    successorNeeded: transition.preparation?.successor_needed === 1,
  });
  return transition;
}

export function advanceWaitingLaneDesiredGeneration({ generation } = {}) {
  const normalized = normalizeWaitingLaneGeneration(generation);
  if (!normalized) return [];
  const db = getDb();
  const results = runImmediateTransaction(db, () => {
    const rows = db.prepare(`
      SELECT *
      FROM waiting_lane_preparations
      WHERE target_branch = ?
        AND (
          state IN (${sqlList(WAITING_LANE_PREPARATORY_STATES)})
          OR (state = 'activating' AND demand_reason = 'planner')
        )
      ORDER BY work_item_id ASC
    `).all(normalized.target_branch);
    return rows.map((row) => {
      const current = generationFromPreparation(row, "desired");
      if (compareWaitingLaneGenerations(current, normalized) <= 0) {
        return transitionResult("already_current", decodePreparation(row));
      }
      const changes = generationChanges(normalized);
      let outcome = "coalesced_queued";
      if (row.state === "preparing_git" || row.state === "waiting_atlas") {
        changes.successor_needed = 1;
        outcome = "running_successor_marked";
      } else if (row.state === "activating" && row.demand_reason === "planner") {
        // Preserve the exact checkout the planner is reading.  Activation
        // will reconcile to the newest desired generation after it promotes
        // the reservation to dev ownership.
        changes.successor_needed = 1;
        outcome = "running_successor_marked";
      } else if (row.state === "ready") {
        changes.state = "stale";
        outcome = "promoted";
      }
      const updated = updatePreparationCas(db, row, changes);
      return updated
        ? transitionResult(outcome, decodePreparation(updated))
        : transitionResult("version_conflict", decodePreparation(selectPreparation(db, row.work_item_id)));
    });
  });
  for (const result of results) {
    recordWaitingLaneTelemetry("generation_advanced", {
      preparation: result.preparation,
      outcome: result.outcome,
      reason: result.reason,
      desiredGeneration: normalized,
      successorNeeded: result.preparation?.successor_needed === 1,
    });
  }
  return results;
}

export function claimWaitingLaneActivation({ workItemId } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (row.state === "retired") return transitionResult("retired", decodePreparation(row));
    if (row.state === "poisoned") return transitionResult("poisoned", decodePreparation(row));
    if (row.state === "activating" && row.demand_reason === "planner") {
      // Planning reserves the exact detached asset by moving it into the
      // existing activation tombstone.  The first dev consumer promotes that
      // reservation here, before it acquires any filesystem locks, so newer
      // main publications can no longer rewrite desired_generation under a
      // live activation.
      const updated = updatePreparationCas(db, row, {
        demand_reason: "dev",
        successor_needed: 0,
      });
      return updated
        ? transitionResult("activation_claimed", decodePreparation(updated))
        : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
    }
    if (row.state === "activating" || row.state === "active") {
      return transitionResult("already_current", decodePreparation(row));
    }
    if (!WAITING_LANE_PREPARATORY_STATES.has(row.state)) {
      return transitionResult("ineligible", decodePreparation(row), "state_not_claimable");
    }
    const updated = updatePreparationCas(db, row, {
      state: "activating",
      successor_needed: 0,
    });
    return updated
      ? transitionResult("activation_claimed", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

/**
 * Freeze an exact prepared asset for the planner chain without inventing a
 * second resident-state machine.  `activating` is already the durable
 * tombstone that stops refresh, eviction, and cleanup writers, and dev setup
 * already knows how to resume it.  `demand_reason=planner` distinguishes this
 * read reservation from an activation that has started attaching the branch.
 */
export function claimWaitingLanePlanning({ workItemId } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (row.state === "poisoned") return transitionResult("poisoned", decodePreparation(row));
    if (row.state === "retired") return transitionResult("retired", decodePreparation(row));
    if (row.state === "activating" && row.demand_reason === "planner") {
      return transitionResult("already_current", decodePreparation(row));
    }
    if (row.state === "activating" || row.state === "active") {
      return transitionResult("ineligible", decodePreparation(row), "state_not_planner_claimable");
    }

    const desired = generationFromPreparation(row, "desired");
    const applied = generationFromPreparation(row, "applied");
    const exactAtlas = row.state === "ready"
      && !!desired
      && !!applied
      && waitingLaneGenerationsEqual(applied, desired);
    const exactGitOnly = row.state === "waiting_atlas"
      && row.atlas_job_id == null
      && !!desired
      && normalizeOptionalString(row.applied_git_oid)?.toLowerCase() === desired.git_oid;
    if (!exactAtlas && !exactGitOnly) {
      return transitionResult("ineligible", decodePreparation(row), "preparation_not_planner_ready");
    }

    const updated = updatePreparationCas(db, row, {
      state: "activating",
      demand_reason: "planner",
      successor_needed: 0,
    });
    return updated
      ? transitionResult("activation_claimed", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

/**
 * A final planner that materializes no dev work no longer has a consumer for
 * the reserved checkout.  Retire only the planner-owned activation tombstone;
 * a real dev activation or an independently active worktree is never changed.
 */
export function retireWaitingLanePlanning({
  workItemId,
  reason = "planner_no_dev_demand",
  consumerJobId = null,
} = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (row.state !== "activating" || row.demand_reason !== "planner") {
      return transitionResult("ineligible", decodePreparation(row), "state_not_planner_reserved");
    }
    const numericConsumerJobId = Number(consumerJobId);
    if (Number.isSafeInteger(numericConsumerJobId) && numericConsumerJobId > 0) {
      const otherConsumer = db.prepare(`
        SELECT 1 AS found
        FROM jobs
        WHERE work_item_id = ?
          AND id <> ?
          AND job_type IN ('plan', 'dev')
          AND status IN (${LIVE_PLANNER_CONSUMER_STATUS_SQL})
        LIMIT 1
      `).get(workItemId, numericConsumerJobId);
      if (otherConsumer) {
        return transitionResult(
          "already_current",
          decodePreparation(row),
          "planner_reservation_still_consumed",
        );
      }
    }
    const updated = updatePreparationCas(db, row, {
      state: "retired",
      successor_needed: 0,
      poisoned_reason: normalizedTerminalReason(reason, "planner_no_dev_demand"),
      retired_at: now(),
    });
    return updated
      ? transitionResult("retired", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function markWaitingLaneActive({ workItemId, expectedVersion, actualGeneration = null } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const { row, matches } = casRow(db, workItemId, expectedVersion);
    if (!matches) return transitionResult("version_conflict", decodePreparation(row));
    if (row.state === "active") return transitionResult("already_current", decodePreparation(row));
    if (row.state !== "activating") {
      return transitionResult("ineligible", decodePreparation(row), "state_not_activating");
    }
    const desired = generationFromPreparation(row, "desired");
    const actual = actualGeneration == null
      ? generationFromPreparation(row, "applied")
      : normalizeWaitingLaneGeneration(actualGeneration);
    if (!desired || !actual || !waitingLaneGenerationsEqual(actual, desired)) {
      return transitionResult("ineligible", decodePreparation(row), "generation_not_current");
    }
    const updated = updatePreparationCas(db, row, {
      ...generationChanges(actual, "applied"),
      state: "active",
      activated_at: now(),
      successor_needed: 0,
    });
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function retireWaitingLanePreparation({ workItemId, expectedVersion, reason } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (expectedVersion !== undefined && normalizeExpectedVersion(expectedVersion) !== row.version) {
      return transitionResult("version_conflict", decodePreparation(row));
    }
    if (row.state === "retired") return transitionResult("retired", decodePreparation(row));
    if (row.state === "poisoned") return transitionResult("poisoned", decodePreparation(row));
    const updated = updatePreparationCas(db, row, {
      state: "retired",
      successor_needed: 0,
      poisoned_reason: normalizedTerminalReason(reason, "retired"),
      retired_at: now(),
    });
    return updated
      ? transitionResult("retired", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function poisonWaitingLanePreparation({ workItemId, expectedVersion, reason } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (expectedVersion !== undefined && normalizeExpectedVersion(expectedVersion) !== row.version) {
      return transitionResult("version_conflict", decodePreparation(row));
    }
    if (row.state === "poisoned") return transitionResult("poisoned", decodePreparation(row));
    const updated = updatePreparationCas(db, row, {
      state: "poisoned",
      successor_needed: 0,
      poisoned_reason: normalizedTerminalReason(reason, "poisoned"),
      retired_at: now(),
    });
    return updated
      ? transitionResult("poisoned", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

/**
 * Clear resident asset proof only after the physical owner has proved absence.
 * The terminal row remains as history/tombstone; CAS prevents a stale cleanup
 * observation from erasing a newer ownership claim.
 */
export function clearWaitingLanePreparedAssetProof({ workItemId, expectedVersion } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const { row, matches } = casRow(db, workItemId, expectedVersion);
    if (!matches) return transitionResult("version_conflict", decodePreparation(row));
    if (!row || !["retired", "poisoned"].includes(row.state)) {
      return transitionResult("ineligible", decodePreparation(row), "state_not_terminal");
    }
    if (
      row.worktree_root == null
      && row.project_cwd == null
      && row.ownership_record_id == null
      && row.applied_git_oid == null
      && row.applied_atlas_seq == null
      && row.applied_atlas_layer_revision == null
      && row.applied_view_fingerprint == null
    ) {
      return transitionResult("already_current", decodePreparation(row));
    }
    const updated = updatePreparationCas(db, row, {
      worktree_root: null,
      project_cwd: null,
      ownership_record_id: null,
      applied_git_oid: null,
      applied_atlas_seq: null,
      applied_atlas_layer_revision: null,
      applied_view_fingerprint: null,
    });
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}

export function storeWaitingLaneHotPaths({ workItemId, hotPaths, maxPaths = DEFAULT_MAX_HOT_PATHS } = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = selectPreparation(db, workItemId);
    if (!row) return transitionResult("ineligible", null, "missing_preparation");
    if (["activating", "active", "poisoned", "retired"].includes(row.state)) {
      return transitionResult("already_current", decodePreparation(row));
    }
    const normalized = normalizeWaitingLaneHotPaths(hotPaths, maxPaths);
    const serialized = JSON.stringify(normalized);
    if (serialized === row.hot_paths_json) return transitionResult("already_current", decodePreparation(row));
    const updated = updatePreparationCas(db, row, { hot_paths_json: serialized });
    return updated
      ? transitionResult("promoted", decodePreparation(updated))
      : transitionResult("version_conflict", decodePreparation(selectPreparation(db, workItemId)));
  });
}
