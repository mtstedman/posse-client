// Planner-side join for a speculative waiting lane.
//
// Research starts the expensive work.  This gate is the consumer boundary:
// it reconciles the latest published generation, waits without consuming an
// attempt, freezes an exact detached checkout with the existing activation
// tombstone, and exposes only a physically verified read root to the planner.

import fs from "node:fs";
import path from "node:path";

import { waitingLaneGenerationsEqual } from "../../../../catalog/waiting-lane.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { Worktree } from "../../../git/classes/Worktree.js";
import {
  withRepositoryWorktreeAdminLockAsync,
  withWorktreeLockAsync,
} from "../../../git/functions/worktree-locks.js";
import {
  gitTopLevelAsync,
  worktreePathAsync,
} from "../../../git/functions/worktree-path.js";
import { recordWaitingLaneTelemetry } from "../../../observability/functions/waiting-lane-telemetry.js";
import { resolveAtlasRepoTargetAsync } from "../../../integrations/functions/atlas.js";
import {
  claimWaitingLanePlanning,
  getWaitingLanePreparation,
  poisonWaitingLanePreparation,
  retireWaitingLanePreparation,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import {
  isWaitingLanePhysicalPreparationEnabled,
  readWaitingLaneCoordinatorSettings,
} from "../../../scheduler/functions/waiting-lane-coordinator.js";
import { requestWaitingLanePlannerDemand } from "../../../research/functions/waiting-lane-demand.js";
import { ensureWaitingLanePlannerAtlasReadView } from "./atlas-read-root.js";
import { waitingLaneActivationEnabled } from "./waiting-lane-activation.js";

const PLANNER_WAIT_DELAY_MS = 500;
const PLANNER_WAIT_MAX_MS = 5 * 60 * 1000;
const WAITING_STATES = new Set(["requested", "preparing_git", "waiting_atlas", "stale"]);

function normalizeOid(value) {
  const oid = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null;
}

function directoryExists(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function parsePayload(worker, job) {
  try {
    return worker.parsePayload(job) || {};
  } catch {
    return {};
  }
}

function writePayload(job, payload) {
  job.payload_json = JSON.stringify(payload);
  updateJobPayload(job.id, job.payload_json);
}

function markPlannerFallback(worker, job, reason) {
  const payload = parsePayload(worker, job);
  payload._waiting_lane_planner_mode = "fallback";
  payload._waiting_lane_planner_reason = String(reason || "unavailable").slice(0, 300);
  delete payload._waiting_lane_planner_wait_started_at;
  delete payload._waiting_lane_planner_wait_count;
  delete payload._waiting_lane_planner_generation;
  writePayload(job, payload);
  job._waitingLanePlannerRead = null;
  recordWaitingLaneTelemetry("planner_fallback", {
    workItemId: job.work_item_id,
    jobId: job.id,
    outcome: "fallback",
    reason,
  });
  return { ok: true, fallback: true, reason };
}

function plannerWaitStartedAt(payload, nowMs) {
  const parsed = Date.parse(String(payload?._waiting_lane_planner_wait_started_at || ""));
  return Number.isFinite(parsed) ? parsed : nowMs;
}

function deferPlanner(worker, job, leaseToken, preparation, reason, {
  nowMs = Date.now(),
  delayMs = PLANNER_WAIT_DELAY_MS,
} = {}) {
  const payload = parsePayload(worker, job);
  const startedAt = plannerWaitStartedAt(payload, nowMs);
  payload._waiting_lane_planner_mode = "waiting";
  payload._waiting_lane_planner_wait_started_at = new Date(startedAt).toISOString();
  payload._waiting_lane_planner_wait_count = Math.max(
    0,
    Number(payload._waiting_lane_planner_wait_count) || 0,
  ) + 1;
  writePayload(job, payload);
  const readyAt = new Date(nowMs + Math.max(100, delayMs)).toISOString();
  worker.emit(
    job.id,
    `${C.dim}[waiting-lane] WI#${job.work_item_id} planner waiting for ${reason}; retrying in ${Math.max(100, delayMs)}ms${C.reset}`,
  );
  recordWaitingLaneTelemetry("planner_deferred", {
    preparation,
    workItemId: job.work_item_id,
    jobId: job.id,
    outcome: "deferred",
    reason,
    durationMs: Math.max(0, nowMs - startedAt),
  });
  worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
  return { ok: false, deferred: true, reason, readyAt, preparation };
}

function plannerWaitExpired(worker, job, nowMs, maxWaitMs) {
  const payload = parsePayload(worker, job);
  const startedAt = plannerWaitStartedAt(payload, nowMs);
  return nowMs - startedAt >= Math.max(0, maxWaitMs);
}

async function validatePlannerReservation(worker, job, claimed, {
  signal = null,
  deps = {},
} = {}) {
  const resolveRepoRoot = deps.gitTopLevelAsync || gitTopLevelAsync;
  const resolveWorktreePath = deps.worktreePathAsync || worktreePathAsync;
  const withAdminLock = deps.withRepositoryWorktreeAdminLockAsync
    || withRepositoryWorktreeAdminLockAsync;
  const withRootLock = deps.withWorktreeLockAsync || withWorktreeLockAsync;
  const WorktreeClass = deps.Worktree || Worktree;
  const readPreparation = deps.getWaitingLanePreparation || getWaitingLanePreparation;

  const worktreeRoot = claimed?.worktree_root ? path.resolve(claimed.worktree_root) : null;
  const projectCwd = claimed?.project_cwd ? path.resolve(claimed.project_cwd) : null;
  if (!worktreeRoot || !projectCwd || !directoryExists(worktreeRoot) || !directoryExists(projectCwd)) {
    return { ok: false, preserve: false, reason: "planner_prepared_root_missing" };
  }
  const expectedRoot = path.resolve(await resolveWorktreePath(
    worker.projectDir,
    job.work_item_id,
    null,
    { signal },
  ));
  if (expectedRoot !== worktreeRoot
    || (projectCwd !== worktreeRoot && !projectCwd.startsWith(`${worktreeRoot}${path.sep}`))) {
    return { ok: false, preserve: true, reason: "planner_prepared_root_mismatch" };
  }

  const repoRoot = await resolveRepoRoot(worker.projectDir, { signal });
  return withAdminLock(repoRoot, worker.projectDir, () => (
    withRootLock(worktreeRoot, worker.projectDir, async () => {
      const current = readPreparation(job.work_item_id);
      if (!current || current.state !== "activating" || current.demand_reason !== "planner") {
        return { ok: false, preserve: false, reason: "planner_reservation_lost" };
      }
      const inspection = await WorktreeClass.at(repoRoot, worktreeRoot).inspectPreparedAsync({
        preparationId: current.ownership_record_id,
        signal,
      });
      if (inspection?.available !== true) {
        return { ok: false, preserve: false, reason: inspection?.reason || "planner_inspection_unavailable" };
      }
      const result = inspection.result || {};
      const expectedOid = normalizeOid(current.applied_git_oid);
      const headOid = normalizeOid(result.headOid || result.afterOid);
      const exact = result.ok === true
        && result.ownershipPhase === "prepared"
        && result.detached === true
        && result.clean === true
        && result.sentinelPresent !== true
        && !!expectedOid
        && headOid === expectedOid;
      if (!exact) {
        return {
          ok: false,
          preserve: fs.existsSync(worktreeRoot),
          reason: `planner_inspection_${result.status || result.reason || "mismatch"}`,
          inspection: result,
        };
      }
      return { ok: true, preparation: current, worktreeRoot, projectCwd, inspection: result };
    }, { signal })
  ), { signal });
}

/**
 * Gate a plan job on the exact speculative checkout it will hand to dev.
 */
export async function gateWaitingLanePlannerReadiness(worker, job, leaseToken, {
  signal = null,
  nowMs = Date.now(),
  delayMs = PLANNER_WAIT_DELAY_MS,
  maxWaitMs = PLANNER_WAIT_MAX_MS,
  deps = {},
} = {}) {
  if (job?.job_type !== "plan") return { ok: true, skipped: "not_plan" };
  if (worker?.dryRun) return markPlannerFallback(worker, job, "dry_run");

  const readPreparation = deps.getWaitingLanePreparation || getWaitingLanePreparation;
  const requestDemand = deps.requestWaitingLanePlannerDemand || requestWaitingLanePlannerDemand;
  const claimPlanning = deps.claimWaitingLanePlanning || claimWaitingLanePlanning;
  const retirePreparation = deps.retireWaitingLanePreparation || retireWaitingLanePreparation;
  const poisonPreparation = deps.poisonWaitingLanePreparation || poisonWaitingLanePreparation;
  const activationEnabled = deps.waitingLaneActivationEnabled || waitingLaneActivationEnabled;
  const readSettings = deps.readWaitingLaneCoordinatorSettings || readWaitingLaneCoordinatorSettings;
  const physicalEnabled = deps.isWaitingLanePhysicalPreparationEnabled
    || isWaitingLanePhysicalPreparationEnabled;
  const resolveAtlasRepo = deps.resolveAtlasRepoTargetAsync || resolveAtlasRepoTargetAsync;

  let preparation = readPreparation(Number(job.work_item_id));
  if (!preparation) return markPlannerFallback(worker, job, "missing_preparation");
  if (!activationEnabled(worker.projectDir) || !physicalEnabled(readSettings())) {
    return markPlannerFallback(worker, job, "planner_consumption_disabled");
  }

  if (!(preparation.state === "activating" && preparation.demand_reason === "planner")) {
    let atlasTarget = null;
    try {
      atlasTarget = await resolveAtlasRepo({ cwd: worker.projectDir, signal });
    } catch {
      return markPlannerFallback(worker, job, "planner_atlas_repo_unavailable");
    }
    if (!atlasTarget?.ready || !atlasTarget.repoPath) {
      return markPlannerFallback(worker, job, "planner_atlas_repo_unavailable");
    }
    const demand = requestDemand({
      workItemId: Number(job.work_item_id),
      projectDir: worker.projectDir,
      atlasRepoRoot: atlasTarget.repoPath,
    });
    preparation = demand?.preparation || readPreparation(Number(job.work_item_id));
    if (!preparation) return markPlannerFallback(worker, job, demand?.reason || "missing_preparation");
    if (!demand || ["ineligible", "poisoned", "retired"].includes(demand.outcome)) {
      if (demand?.reason === "published_generation_unavailable") {
        retirePreparation({
          workItemId: job.work_item_id,
          expectedVersion: preparation.version,
          reason: "planner_published_generation_unavailable",
        });
      }
      return markPlannerFallback(
        worker,
        job,
        demand?.reason || demand?.outcome || "planner_demand_reconciliation_failed",
      );
    }
  }

  if (["poisoned", "retired"].includes(preparation.state)) {
    return markPlannerFallback(worker, job, `preparation_${preparation.state}`);
  }

  let claimed = preparation.state === "activating" && preparation.demand_reason === "planner"
    ? { outcome: "already_current", preparation }
    : claimPlanning({ workItemId: Number(job.work_item_id) });
  if (!["activation_claimed", "already_current"].includes(claimed.outcome)) {
    preparation = claimed.preparation || readPreparation(Number(job.work_item_id));
    if (WAITING_STATES.has(preparation?.state)) {
      if (plannerWaitExpired(worker, job, nowMs, maxWaitMs)) {
        retirePreparation({
          workItemId: job.work_item_id,
          expectedVersion: preparation.version,
          reason: "planner_readiness_timeout",
        });
        return markPlannerFallback(worker, job, "planner_readiness_timeout");
      }
      return deferPlanner(
        worker,
        job,
        leaseToken,
        preparation,
        `preparation_${preparation?.state || "pending"}`,
        { nowMs, delayMs },
      );
    }
    return markPlannerFallback(worker, job, claimed.reason || claimed.outcome);
  }

  const validation = await validatePlannerReservation(worker, job, claimed.preparation, {
    signal,
    deps,
  });
  if (!validation.ok) {
    const current = readPreparation(Number(job.work_item_id));
    if (current?.state === "activating" && current.demand_reason === "planner") {
      const transition = validation.preserve ? poisonPreparation : retirePreparation;
      transition({
        workItemId: job.work_item_id,
        expectedVersion: current.version,
        reason: validation.reason,
      });
    }
    return markPlannerFallback(worker, job, validation.reason);
  }

  preparation = validation.preparation;
  const appliedGeneration = preparation.applied_generation || null;
  const gitOnlyGeneration = !appliedGeneration
    && preparation.desired_generation?.git_oid === normalizeOid(preparation.applied_git_oid)
    ? preparation.desired_generation
    : null;
  const plannerGeneration = appliedGeneration || gitOnlyGeneration;
  const atlasSource = appliedGeneration ? "parked" : (gitOnlyGeneration ? "main" : "disabled");
  const plannerRead = {
    reserved: true,
    worktreeRoot: validation.worktreeRoot,
    projectCwd: validation.projectCwd,
    generation: plannerGeneration,
    atlasSource,
    atlasUnavailableReason: null,
  };
  if (atlasSource === "parked") {
    const ensurePlannerView = deps.ensureWaitingLanePlannerAtlasReadView
      || ensureWaitingLanePlannerAtlasReadView;
    const plannerView = await ensurePlannerView({
      projectDir: worker.projectDir,
      readRoot: validation.projectCwd,
      workItemId: Number(job.work_item_id),
      plannerRead,
      signal,
    });
    if (!plannerView?.mounted) {
      // Atlas is optional for planner reads. Keep the physically verified Git
      // reservation shared by parallel planners and let the role disable Atlas
      // for this packet; dev remains responsible for final Atlas reconciliation.
      plannerRead.atlasSource = "disabled";
      plannerRead.atlasUnavailableReason = plannerView?.reason
        || "planner_parked_view_unavailable";
    }
    if (plannerView.config) job._atlasConfig = plannerView.config;
  }
  job._waitingLanePlannerRead = plannerRead;

  const payload = parsePayload(worker, job);
  payload._waiting_lane_planner_mode = "prepared";
  payload._waiting_lane_planner_generation = plannerGeneration;
  payload._waiting_lane_planner_atlas_source = plannerRead.atlasSource;
  if (plannerRead.atlasUnavailableReason) {
    payload._waiting_lane_planner_atlas_reason = plannerRead.atlasUnavailableReason;
  } else {
    delete payload._waiting_lane_planner_atlas_reason;
  }
  delete payload._waiting_lane_planner_wait_started_at;
  delete payload._waiting_lane_planner_wait_count;
  writePayload(job, payload);
  recordWaitingLaneTelemetry("planner_reserved", {
    preparation,
    workItemId: job.work_item_id,
    jobId: job.id,
    outcome: "reserved",
    reason: plannerRead.atlasUnavailableReason || plannerRead.atlasSource,
    appliedGeneration: plannerGeneration,
  });
  return { ok: true, reserved: true, preparation, read: plannerRead };
}
