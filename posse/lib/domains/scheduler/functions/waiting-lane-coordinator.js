// @ts-check
//
// Durable admission and generation coordination for waiting-lane preparation.
// This module never mutates Git or Atlas files. It reduces published job/state
// proof into CAS transitions and bounded queue work; the deterministic worker
// executor owns the guarded Git operation and Atlas owns parked-view writes.

import {
  LOCK_HOLDING_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
} from "../../../catalog/job.js";
import {
  WAITING_LANE_ATLAS_PURPOSES,
  WAITING_LANE_JOB_TYPE,
  WAITING_LANE_SETTING_KEYS,
  normalizeWaitingLaneGeneration,
} from "../../../catalog/waiting-lane.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  advanceWaitingLaneDesiredGeneration,
  createJob,
  ensureWaitingLanePreparation,
  getJob,
  getSetting,
  getWaitingLanePreparation,
  listWaitingLanePreparations,
  parseJobPayload,
  retireWaitingLanePreparation,
  runImmediateTransaction,
  settleWaitingLaneAtlas,
  updateJobPayload,
} from "../../queue/functions/index.js";
import { readBoolSetting, readPositiveIntSetting } from "./config.js";
import { recordWaitingLaneTelemetry } from "../../observability/functions/waiting-lane-telemetry.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const LIVE_PREPARATION_JOB_STATUS_SET = new Set(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
const MAIN_GENERATION_PURPOSE_SET = new Set(["main-incremental", "main-full", "main-merge"]);
const SETTLED_ATLAS_PURPOSE_SET = new Set([
  WAITING_LANE_ATLAS_PURPOSES.SNAPSHOT,
  WAITING_LANE_ATLAS_PURPOSES.CATCHUP,
]);
const PREPARATION_SCHEDULABLE_STATES = new Set(["requested", "stale"]);
const EVICTABLE_PREPARATION_STATES = new Set(["ready", "stale"]);
const DEFAULT_PREPARATION_CONCURRENCY = 1;
const DEFAULT_MAX_PREPARED_LANES = 1;
const DEFAULT_PREPARED_TTL_MS = 60 * 60 * 1000;

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function waitingLaneShadowMode() {
  try {
    return String(getSetting(WAITING_LANE_SETTING_KEYS.SHADOW_MODE) || "off").trim().toLowerCase();
  } catch {
    return "off";
  }
}

export function readWaitingLanePreparationConcurrency() {
  return readPositiveIntSetting(
    WAITING_LANE_SETTING_KEYS.PREPARATION_CONCURRENCY,
    DEFAULT_PREPARATION_CONCURRENCY,
  );
}

export function readWaitingLaneCoordinatorSettings() {
  return Object.freeze({
    shadowMode: waitingLaneShadowMode(),
    gitPreparationEnabled: readBoolSetting(
      WAITING_LANE_SETTING_KEYS.GIT_PREPARATION_ENABLED,
      false,
    ),
    atlasSnapshotEnabled: readBoolSetting(
      WAITING_LANE_SETTING_KEYS.ATLAS_SNAPSHOT_ENABLED,
      false,
    ),
    atlasCatchupEnabled: readBoolSetting(
      WAITING_LANE_SETTING_KEYS.ATLAS_CATCHUP_ENABLED,
      false,
    ),
    preparationConcurrency: readWaitingLanePreparationConcurrency(),
    maxPreparedLanes: readPositiveIntSetting(
      WAITING_LANE_SETTING_KEYS.MAX_PREPARED_LANES,
      DEFAULT_MAX_PREPARED_LANES,
    ),
    preparedTtlMs: readPositiveIntSetting(
      WAITING_LANE_SETTING_KEYS.PREPARED_TTL_MS,
      DEFAULT_PREPARED_TTL_MS,
    ),
  });
}

export function isWaitingLanePhysicalPreparationEnabled(settings = readWaitingLaneCoordinatorSettings()) {
  return settings.shadowMode !== "shadow" && settings.gitPreparationEnabled === true;
}

function hasAppliedParkedGeneration(preparation) {
  return !!normalizeWaitingLaneGeneration(preparation?.applied_generation);
}

export function waitingLaneAtlasPurposeForPreparation(preparation) {
  return hasAppliedParkedGeneration(preparation)
    ? WAITING_LANE_ATLAS_PURPOSES.CATCHUP
    : WAITING_LANE_ATLAS_PURPOSES.SNAPSHOT;
}

export function waitingLanePhysicalPreparationGate(
  preparation,
  settings = readWaitingLaneCoordinatorSettings(),
) {
  if (!preparation) return { ok: false, reason: "missing_preparation" };
  if (!normalizeWaitingLaneGeneration(preparation.desired_generation)) {
    return { ok: false, reason: "generation_unavailable" };
  }
  if (!isWaitingLanePhysicalPreparationEnabled(settings)) {
    return { ok: false, reason: settings.shadowMode === "shadow" ? "shadow_only" : "git_disabled" };
  }
  const purpose = waitingLaneAtlasPurposeForPreparation(preparation);
  const atlasEnabled = purpose === WAITING_LANE_ATLAS_PURPOSES.SNAPSHOT
    ? settings.atlasSnapshotEnabled === true
    : settings.atlasCatchupEnabled === true;
  return { ok: true, purpose, atlasEnabled };
}

export function canRunWaitingLanePreparation(preparation, settings = readWaitingLaneCoordinatorSettings()) {
  if (!preparation || !PREPARATION_SCHEDULABLE_STATES.has(preparation.state)) {
    return { ok: false, reason: "state_not_schedulable" };
  }
  return waitingLanePhysicalPreparationGate(preparation, settings);
}

function preparationJobPriority(preparation) {
  if (preparation?.demand_reason === "operator") return "urgent";
  if (preparation?.demand_reason === "dev") return "high";
  if (preparation?.demand_reason === "planner") return "normal";
  return "low";
}

function livePreparationJob(db, workItemId) {
  return db.prepare(`
    SELECT *
    FROM jobs
    WHERE work_item_id = ?
      AND job_type = ?
      AND status IN (${[...LIVE_PREPARATION_JOB_STATUS_SET].map(() => "?").join(", ")})
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'leased' THEN 1 ELSE 2 END, id ASC
    LIMIT 1
  `).get(workItemId, WAITING_LANE_JOB_TYPE, ...LIVE_PREPARATION_JOB_STATUS_SET);
}

function hasLivePlannerReservationConsumer(db, workItemId) {
  return !!db.prepare(`
    SELECT 1 AS found
    FROM jobs
    WHERE work_item_id = ?
      AND job_type IN ('plan', 'dev')
      AND status IN (${[...LIVE_PREPARATION_JOB_STATUS_SET].map(() => "?").join(", ")})
    LIMIT 1
  `).get(workItemId, ...LIVE_PREPARATION_JOB_STATUS_SET);
}

function preparationAdmission(db, preparation, settings) {
  if (preparation?.worktree_root) return { admitted: true, resident: true };
  const rows = db.prepare(`
    SELECT p.work_item_id,
           p.state,
           p.worktree_root,
           wi.branch_name,
           EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.work_item_id = p.work_item_id
               AND j.job_type = ?
               AND j.status IN (${[...LIVE_PREPARATION_JOB_STATUS_SET].map(() => "?").join(", ")})
           ) AS has_live_job
    FROM waiting_lane_preparations p
    JOIN work_items wi ON wi.id = p.work_item_id
    WHERE p.state <> 'active'
  `).all(
    WAITING_LANE_JOB_TYPE,
    ...LIVE_PREPARATION_JOB_STATUS_SET,
  );
  const occupied = rows.filter((row) => (
    Number(row.work_item_id) !== Number(preparation?.work_item_id)
    && (
      (
        !!row.worktree_root
        && !(row.state === "retired" && String(row.branch_name || "").trim())
      )
      || Number(row.has_live_job) === 1
    )
  )).length;
  return occupied < settings.maxPreparedLanes
    ? { admitted: true, resident: false, occupied, cap: settings.maxPreparedLanes }
    : { admitted: false, reason: "prepared_lane_capacity", occupied, cap: settings.maxPreparedLanes };
}

/**
 * Ensure one queued/running Git preparation for a schedulable durable row.
 * Repeated demand only updates the queued job's priority/payload; running work
 * reads the row as truth and observes a single successor flag through CAS.
 */
export function scheduleWaitingLanePreparation(preparationOrWorkItemId, {
  settings = readWaitingLaneCoordinatorSettings(),
} = {}) {
  const workItemId = typeof preparationOrWorkItemId === "object"
    ? Number(preparationOrWorkItemId?.work_item_id)
    : Number(preparationOrWorkItemId);
  const preparation = typeof preparationOrWorkItemId === "object"
    ? preparationOrWorkItemId
    : getWaitingLanePreparation(workItemId);
  const gate = canRunWaitingLanePreparation(preparation, settings);
  if (!gate.ok) {
    const suppressed = { scheduled: false, reason: gate.reason, preparation, job: null };
    recordWaitingLaneTelemetry("scheduling_suppressed", {
      preparation,
      outcome: "suppressed",
      reason: gate.reason,
    });
    return suppressed;
  }

  const db = getDb();
  const scheduled = runImmediateTransaction(db, () => {
    const fresh = getWaitingLanePreparation(workItemId);
    const freshGate = canRunWaitingLanePreparation(fresh, settings);
    if (!freshGate.ok) {
      return { scheduled: false, reason: freshGate.reason, preparation: fresh, job: null };
    }
    const admission = preparationAdmission(db, fresh, settings);
    if (!admission.admitted) {
      return { scheduled: false, reason: admission.reason, preparation: fresh, job: null, admission };
    }
    const existing = livePreparationJob(db, workItemId);
    const priority = preparationJobPriority(fresh);
    const payload = {
      work_item_id: workItemId,
      demand_reason: fresh.demand_reason,
      requested_version: fresh.version,
    };
    if (existing) {
      if (existing.status === "queued") {
        updateJobPayload(existing.id, JSON.stringify(payload));
        db.prepare(`
          UPDATE jobs
          SET priority = CASE
            WHEN priority = 'urgent' OR ? = 'urgent' THEN 'urgent'
            WHEN priority = 'high' OR ? = 'high' THEN 'high'
            WHEN priority = 'normal' OR ? = 'normal' THEN 'normal'
            ELSE 'low'
          END,
          ready_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(priority, priority, priority, new Date().toISOString(), new Date().toISOString(), existing.id);
      }
      return {
        scheduled: true,
        coalesced: true,
        preparation: fresh,
        job: getJob(existing.id) || existing,
        admission,
      };
    }
    const job = /** @type {any} */ (createJob)({
      work_item_id: workItemId,
      job_type: WAITING_LANE_JOB_TYPE,
      title: `Prepare waiting lane: WI#${workItemId}`,
      priority,
      max_attempts: 3,
      payload_json: payload,
    });
    return { scheduled: true, coalesced: false, preparation: fresh, job, admission };
  });
  recordWaitingLaneTelemetry(
    scheduled.scheduled
      ? (scheduled.coalesced ? "scheduling_coalesced" : "scheduling_queued")
      : "scheduling_suppressed",
    {
      preparation: scheduled.preparation || preparation,
      jobId: scheduled.job?.id,
      outcome: scheduled.scheduled ? (scheduled.coalesced ? "coalesced" : "queued") : "suppressed",
      reason: scheduled.reason,
      decision: scheduled.scheduled ? (scheduled.coalesced ? "coalesced" : "queued") : "suppressed",
      coalesced: scheduled.coalesced === true,
      atlasEnabled: gate.atlasEnabled === true,
      counts: scheduled.admission,
    },
  );
  return scheduled;
}

/**
 * Transactionally reduce demand and enqueue at most one preparation job.
 * Shadow mode persists eligibility/demand state but performs no filesystem or
 * Atlas work; with all gates disabled (the default), it records nothing.
 */
/**
 * @param {{
 *   workItemId?: number,
 *   demandReason?: string,
 *   targetBranch?: string,
 *   generation?: any,
 *   hotPaths?: string[],
 * }} [args]
 */
export function requestWaitingLanePreparation({
  workItemId,
  demandReason,
  targetBranch,
  generation,
  hotPaths,
} = {}) {
  const settings = readWaitingLaneCoordinatorSettings();
  recordWaitingLaneTelemetry("demand_requested", {
    workItemId: Number(workItemId),
    demandReason,
    desiredGeneration: generation,
  });
  if (
    settings.shadowMode !== "shadow"
    && !settings.gitPreparationEnabled
    && !settings.atlasSnapshotEnabled
    && !settings.atlasCatchupEnabled
  ) {
    const suppressed = {
      outcome: "ineligible",
      preparation: getWaitingLanePreparation(Number(workItemId)),
      reason: "waiting_lane_disabled",
      scheduled: false,
      job: null,
    };
    recordWaitingLaneTelemetry("demand_suppressed", {
      workItemId: Number(workItemId),
      demandReason,
      desiredGeneration: generation,
      outcome: suppressed.outcome,
      reason: suppressed.reason,
    });
    return suppressed;
  }

  const db = getDb();
  const result = runImmediateTransaction(db, () => {
    const ensured = /** @type {any} */ (ensureWaitingLanePreparation)({
      workItemId: Number(workItemId),
      demandReason,
      targetBranch,
      generation,
      hotPaths,
    });
    if (!ensured.preparation || ["ineligible", "poisoned", "retired"].includes(ensured.outcome)) {
      return { ...ensured, scheduled: false, job: null };
    }
    const scheduled = scheduleWaitingLanePreparation(ensured.preparation, { settings });
    return { ...ensured, ...scheduled, preparation: scheduled.preparation || ensured.preparation };
  });
  const event = ["ineligible", "poisoned", "retired"].includes(result.outcome)
    ? "demand_suppressed"
    : (["promoted", "running_successor_marked"].includes(result.outcome)
        ? "demand_promoted"
        : (["coalesced_queued", "already_current"].includes(result.outcome)
            ? "demand_deduped"
            : null));
  if (event) {
    recordWaitingLaneTelemetry(event, {
      preparation: result.preparation,
      workItemId: Number(workItemId),
      jobId: result.job?.id,
      demandReason,
      desiredGeneration: generation,
      outcome: result.outcome,
      reason: result.reason,
      coalesced: result.coalesced === true,
    });
  }
  return result;
}

export function extractPublishedMainGeneration(job) {
  if (!job || job.job_type !== "atlas_warm" || job.status !== "succeeded") return null;
  const payload = parseJobPayload(job);
  if (!MAIN_GENERATION_PURPOSE_SET.has(String(payload?.purpose || ""))) return null;
  const result = parseJsonObject(job.result_json);
  if (result.generation_proof_reason !== "clean_exact_oid_before_after") return null;
  return normalizeWaitingLaneGeneration(result.generation);
}

function scheduleGenerationResults(results, settings) {
  const scheduled = [];
  for (const entry of results || []) {
    const preparation = entry?.preparation;
    if (!preparation || !PREPARATION_SCHEDULABLE_STATES.has(preparation.state)) continue;
    scheduled.push(scheduleWaitingLanePreparation(preparation, { settings }));
  }
  return scheduled;
}

export function advanceWaitingLanesFromMainWarm(job, {
  settings = readWaitingLaneCoordinatorSettings(),
} = {}) {
  const generation = extractPublishedMainGeneration(job);
  if (!generation) return { advanced: false, reason: "unpublished_main_generation", results: [], scheduled: [] };
  const results = advanceWaitingLaneDesiredGeneration({ generation });
  return {
    advanced: true,
    generation,
    results,
    scheduled: scheduleGenerationResults(results, settings),
  };
}

function waitingLaneAtlasPayload(job) {
  if (!job || job.job_type !== "atlas_warm") return null;
  const payload = parseJobPayload(job);
  return SETTLED_ATLAS_PURPOSE_SET.has(
    /** @type {any} */ (String(payload?.purpose || "")),
  ) ? payload : null;
}

export function settleWaitingLaneFromCompletedAtlasJob(job, {
  settings = readWaitingLaneCoordinatorSettings(),
} = {}) {
  const payload = waitingLaneAtlasPayload(job);
  if (!payload || !TERMINAL_JOB_STATUS_SET.has(job.status)) {
    return { settled: false, reason: "not_terminal_waiting_lane_atlas" };
  }
  const workItemId = Number(payload.work_item_id || job.work_item_id);
  const preparation = getWaitingLanePreparation(workItemId);
  if (!preparation || Number(preparation.atlas_job_id) !== Number(job.id)) {
    return { settled: false, reason: "atlas_job_not_current", preparation };
  }
  const result = parseJsonObject(job.result_json);
  const transition = settleWaitingLaneAtlas({
    workItemId,
    expectedVersion: preparation.version,
    atlasJobId: Number(job.id),
    actualGeneration: job.status === "succeeded" ? result.generation : null,
    result: job.status === "succeeded" ? result : { status: job.status, error: job.last_error || null },
  });
  const scheduled = transition?.preparation?.state === "stale"
    ? scheduleWaitingLanePreparation(transition.preparation, { settings })
    : null;
  recordWaitingLaneTelemetry("atlas_successor", {
    preparation: transition?.preparation,
    workItemId,
    jobId: Number(job.id),
    outcome: transition?.preparation?.state || transition?.outcome,
    reason: scheduled?.reason || transition?.reason,
    decision: scheduled?.scheduled ? "successor_scheduled" : "no_successor",
    successorNeeded: transition?.preparation?.successor_needed === 1,
  });
  return { settled: true, transition, scheduled };
}

/**
 * Scheduler completion hook. Main publication is reduced before fanout; a
 * target-local child is then re-settled from its durable terminal result using
 * the current row version, closing the deliberate stale-token race when main
 * advanced while that child was running.
 */
export function reconcileWaitingLaneJobCompletion(job, options = {}) {
  const main = advanceWaitingLanesFromMainWarm(job, options);
  const atlas = settleWaitingLaneFromCompletedAtlasJob(job, options);
  return { main, atlas };
}

/**
 * Bounded oldest-first rescan used after cap/TTL cleanup releases residency.
 * This only enqueues/coalesces queue work; it never inspects or mutates files.
 */
export function scheduleWaitingLaneBacklog({
  settings = readWaitingLaneCoordinatorSettings(),
  limit = 100,
} = {}) {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.min(1000, Math.max(0, limit))
    : 100;
  const summary = {
    examined: 0,
    scheduled: 0,
    coalesced: 0,
    suppressed: 0,
    results: [],
  };
  if (boundedLimit === 0) return summary;
  const backlog = listWaitingLanePreparations({
    states: [...PREPARATION_SCHEDULABLE_STATES],
    limit: boundedLimit,
  });
  for (const preparation of backlog) {
    const result = scheduleWaitingLanePreparation(preparation, { settings });
    summary.examined++;
    if (result.scheduled) {
      summary.scheduled++;
      if (result.coalesced) summary.coalesced++;
    } else {
      summary.suppressed++;
    }
    summary.results.push(result);
  }
  return summary;
}

function isEvictableWaitingLanePreparation(preparation) {
  if (!preparation?.worktree_root || preparation.state === "active") return false;
  if (preparation.state === "retired") return true;
  if (EVICTABLE_PREPARATION_STATES.has(preparation.state)) return true;
  return preparation.state === "waiting_atlas"
    && preparation.atlas_job_id == null
    && typeof preparation.applied_git_oid === "string"
    && /^[0-9a-f]{40,64}$/u.test(preparation.applied_git_oid);
}

/**
 * Select safe state-level cap/TTL candidates. This function never removes a
 * worktree or view. Versions are included so the physical cleanup owner can
 * CAS-retire the exact observation before inspecting/removing the asset.
 */
export function selectWaitingLaneEvictionCandidates({
  nowMs = Date.now(),
  maxPreparedLanes = readPositiveIntSetting(
    WAITING_LANE_SETTING_KEYS.MAX_PREPARED_LANES,
    DEFAULT_MAX_PREPARED_LANES,
  ),
  ttlMs = readPositiveIntSetting(
    WAITING_LANE_SETTING_KEYS.PREPARED_TTL_MS,
    DEFAULT_PREPARED_TTL_MS,
  ),
} = {}) {
  const branchBackedRetiredIds = new Set(getDb().prepare(`
    SELECT p.work_item_id
    FROM waiting_lane_preparations p
    JOIN work_items wi ON wi.id = p.work_item_id
    WHERE p.state = 'retired'
      AND p.worktree_root IS NOT NULL
      AND wi.branch_name IS NOT NULL
      AND trim(wi.branch_name) <> ''
  `).all().map((row) => Number(row.work_item_id)));
  const physicalResidents = listWaitingLanePreparations({ limit: 1000 })
    .filter((preparation) => (
      preparation.worktree_root
      && preparation.state !== "active"
      && !branchBackedRetiredIds.has(Number(preparation.work_item_id))
    ))
    .sort((left, right) => {
      const timeOrder = Date.parse(left.updated_at || "") - Date.parse(right.updated_at || "");
      return timeOrder || Number(left.work_item_id) - Number(right.work_item_id);
    });
  const residents = physicalResidents.filter(isEvictableWaitingLanePreparation);
  const overflow = Math.max(0, physicalResidents.length - Math.max(1, Number(maxPreparedLanes) || 1));
  const cutoff = Number(nowMs) - Math.max(1, Number(ttlMs) || DEFAULT_PREPARED_TTL_MS);
  const selected = new Map();
  for (const preparation of residents) {
    if (preparation.state === "retired") {
      selected.set(preparation.work_item_id, {
        preparation,
        reason: "retired_prepared_lane",
      });
      continue;
    }
    const updatedAt = Date.parse(preparation.updated_at || "");
    if (Number.isFinite(updatedAt) && updatedAt <= cutoff) {
      selected.set(preparation.work_item_id, { preparation, reason: "prepared_lane_ttl" });
    }
  }
  for (const preparation of residents) {
    if (selected.size >= overflow) break;
    if (!selected.has(preparation.work_item_id)) {
      selected.set(preparation.work_item_id, { preparation, reason: "prepared_lane_capacity" });
    }
  }
  return [...selected.values()].map(({ preparation, reason }) => ({
    workItemId: preparation.work_item_id,
    expectedVersion: preparation.version,
    reason,
    preparation,
  }));
}

/**
 * Reconcile only durable database proof after filesystem recovery has run.
 * No orphan is assumed successful: target-local Atlas results must carry an
 * exact generation, and a Git-preparing row without its live job is retired
 * for the physical recovery owner to inspect.
 */
export function reconcileWaitingLanePreparationsOnBoot({
  settings = readWaitingLaneCoordinatorSettings(),
} = {}) {
  const db = getDb();
  const summary = {
    mainGenerations: 0,
    atlasSettled: 0,
    retired: 0,
    scheduled: 0,
    unchanged: 0,
    actions: [],
  };

  const published = db.prepare(`
    SELECT * FROM (
      SELECT *
      FROM jobs
      WHERE job_type = 'atlas_warm'
        AND status = 'succeeded'
        AND result_json IS NOT NULL
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
      LIMIT 200
    ) newest
    ORDER BY COALESCE(finished_at, updated_at) ASC, id ASC
  `).all();
  for (const job of published) {
    const advanced = advanceWaitingLanesFromMainWarm(job, { settings });
    if (advanced.advanced) summary.mainGenerations++;
  }

  for (const observed of listWaitingLanePreparations({ limit: 1000 })) {
    let preparation = getWaitingLanePreparation(observed.work_item_id) || observed;
    const workItem = db.prepare(`SELECT id, status FROM work_items WHERE id = ?`).get(preparation.work_item_id);
    if (!workItem || TERMINAL_WORK_ITEM_STATUS_SET.has(workItem.status)) {
      const retired = retireWaitingLanePreparation({
        workItemId: preparation.work_item_id,
        expectedVersion: preparation.version,
        reason: !workItem ? "work_item_missing" : `work_item_${workItem.status}`,
      });
      if (retired.outcome === "retired") summary.retired++;
      summary.actions.push(retired);
      continue;
    }

    if (preparation.state === "activating" && preparation.demand_reason === "planner") {
      if (hasLivePlannerReservationConsumer(db, preparation.work_item_id)) {
        summary.unchanged++;
      } else {
        const retired = retireWaitingLanePreparation({
          workItemId: preparation.work_item_id,
          expectedVersion: preparation.version,
          reason: "orphaned_planner_reservation",
        });
        if (retired.outcome === "retired") summary.retired++;
        summary.actions.push(retired);
      }
      continue;
    }

    if (preparation.state === "preparing_git") {
      const gitJob = preparation.git_job_id ? getJob(preparation.git_job_id) : null;
      if (!gitJob || !LIVE_PREPARATION_JOB_STATUS_SET.has(gitJob.status)) {
        const retired = retireWaitingLanePreparation({
          workItemId: preparation.work_item_id,
          expectedVersion: preparation.version,
          reason: "orphaned_git_preparation_unproven",
        });
        if (retired.outcome === "retired") summary.retired++;
        summary.actions.push(retired);
      } else {
        summary.unchanged++;
      }
      continue;
    }

    if (preparation.state === "waiting_atlas") {
      const atlasJob = preparation.atlas_job_id ? getJob(preparation.atlas_job_id) : null;
      if (atlasJob && TERMINAL_JOB_STATUS_SET.has(atlasJob.status)) {
        const settled = settleWaitingLaneFromCompletedAtlasJob(atlasJob, { settings });
        if (settled.settled) summary.atlasSettled++;
        if (settled.scheduled?.scheduled) summary.scheduled++;
        summary.actions.push(settled);
      } else if (
        !atlasJob
        && preparation.atlas_job_id == null
        && typeof preparation.applied_git_oid === "string"
        && /^[0-9a-f]{40,64}$/u.test(preparation.applied_git_oid)
        && typeof preparation.worktree_root === "string"
        && preparation.worktree_root.length > 0
        && typeof preparation.project_cwd === "string"
        && preparation.project_cwd.length > 0
        && typeof preparation.ownership_record_id === "string"
        && preparation.ownership_record_id.length > 0
      ) {
        // Gate 1 deliberately has no Atlas child. The CAS row is durable Git
        // proof; physical startup recovery owns checkout observation and this
        // scheduler phase must preserve the claim for activation.
        summary.unchanged++;
      } else if (!atlasJob) {
        const retired = retireWaitingLanePreparation({
          workItemId: preparation.work_item_id,
          expectedVersion: preparation.version,
          reason: "orphaned_atlas_preparation_unproven",
        });
        if (retired.outcome === "retired") summary.retired++;
        summary.actions.push(retired);
      } else {
        summary.unchanged++;
      }
      continue;
    }

    if (PREPARATION_SCHEDULABLE_STATES.has(preparation.state)) {
      const scheduled = scheduleWaitingLanePreparation(preparation, { settings });
      if (scheduled.scheduled) summary.scheduled++;
      else summary.unchanged++;
      summary.actions.push(scheduled);
      continue;
    }
    summary.unchanged++;
  }
  recordWaitingLaneTelemetry("boot_reconciled", {
    outcome: "succeeded",
    counts: {
      main_generations: summary.mainGenerations,
      atlas_settled: summary.atlasSettled,
      retired: summary.retired,
      scheduled: summary.scheduled,
      unchanged: summary.unchanged,
      actions: summary.actions.length,
    },
  });
  return summary;
}
