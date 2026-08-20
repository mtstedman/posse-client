// @ts-check
//
// Deterministic waiting-lane Git executor. It holds the canonical repository
// worktree-admin fence before the prepared-root lock, rechecks the durable CAS
// row/tombstone under both locks, invokes only the guarded native protocol, and
// releases its lease immediately after transactionally publishing durable Git
// proof and, when enabled, the Atlas child. It never waits for Atlas.

import path from "node:path";

import { C } from "../../../../shared/format/functions/colors.js";
import {
  WAITING_LANE_ATLAS_PURPOSES,
  normalizeWaitingLaneGeneration,
} from "../../../../catalog/waiting-lane.js";
import { Worktree } from "../../../git/classes/Worktree.js";
import {
  withRepositoryWorktreeAdminLockAsync,
  withWorktreeLockAsync,
} from "../../../git/functions/worktree-locks.js";
import {
  gitTopLevelAsync,
  nestedProjectSubpathAsync,
  worktreePathAsync,
} from "../../../git/functions/worktree-path.js";
import { enqueueWaitingLaneAtlasWarm } from "../../../atlas/classes/v2/PipelineHooks.js";
import {
  claimWaitingLaneGitPreparation,
  completeAttempt,
  ensureWaitingLanePreparation,
  getWaitingLanePreparation,
  incrementAndCreateAttempt,
  poisonWaitingLanePreparation,
  recordWaitingLaneGitPrepared,
  refreshWorkItemStatus,
  retireWaitingLanePreparation,
  setJobResult,
  storeArtifact,
} from "../../../queue/functions/index.js";
import {
  canRunWaitingLanePreparation,
  readWaitingLaneCoordinatorSettings,
  waitingLaneAtlasPurposeForPreparation,
  waitingLanePhysicalPreparationGate,
} from "../../../scheduler/functions/waiting-lane-coordinator.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";
import { recordWaitingLaneTelemetry } from "../../../observability/functions/waiting-lane-telemetry.js";

const WAITING_LANE_DISABLED_REQUEUE_DELAY_MS = 10 * 60 * 1000;

function preparationIdentity(workItemId) {
  return `waiting-lane-wi-${workItemId}`;
}

function normalizedOid(value) {
  const oid = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null;
}

function nativePreparedResult(operation, desiredOid) {
  if (operation?.available !== true) {
    return { ok: false, reason: operation?.reason || "native_capability_unavailable", unavailable: true };
  }
  const result = operation.result;
  const headOid = normalizedOid(result?.headOid || result?.afterOid);
  if (
    result?.ok !== true
    || result?.ownershipPhase !== "prepared"
    || result?.clean !== true
    || result?.detached !== true
    || result?.sentinelPresent === true
    || headOid !== desiredOid
  ) {
    return {
      ok: false,
      reason: result?.reason || result?.status || "native_preparation_mismatch",
      result,
    };
  }
  return { ok: true, headOid, result };
}

function atlasPriority(preparation) {
  // Successfully published main warms are high priority. Dev/planner/operator
  // demand and every bounded catch-up sit immediately below them; speculative
  // initial research snapshots remain low priority.
  if (
    normalizeWaitingLaneGeneration(preparation?.applied_generation)
    || ["dev", "planner", "operator"].includes(preparation?.demand_reason)
  ) return "normal";
  return "low";
}

function lostPreparationResult(preparation, reason = "preparation_token_lost") {
  return {
    ok: true,
    skipped: reason,
    preparation: preparation || null,
  };
}

const DEFAULT_DEPS = Object.freeze({
  Worktree,
  claimWaitingLaneGitPreparation,
  ensureWaitingLanePreparation,
  getWaitingLanePreparation,
  poisonWaitingLanePreparation,
  recordWaitingLaneGitPrepared,
  retireWaitingLanePreparation,
  enqueueWaitingLaneAtlasWarm,
  readWaitingLaneCoordinatorSettings,
  canRunWaitingLanePreparation,
  waitingLanePhysicalPreparationGate,
  waitingLaneAtlasPurposeForPreparation,
  gitTopLevelAsync,
  nestedProjectSubpathAsync,
  worktreePathAsync,
  withRepositoryWorktreeAdminLockAsync,
  withWorktreeLockAsync,
});

/**
 * Core protocol split from Worker bookkeeping for focused deterministic tests.
 *
 * @param {{ job: any, projectDir: string, signal?: AbortSignal | null, deps?: Partial<typeof DEFAULT_DEPS> }} args
 */
export async function executeWaitingLanePreparation({
  job,
  projectDir,
  signal = null,
  deps: dependencyOverrides = {},
}) {
  const deps = /** @type {any} */ ({ ...DEFAULT_DEPS, ...dependencyOverrides });
  const workItemId = Number(job?.work_item_id);
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    return { ok: true, skipped: "invalid_work_item" };
  }

  let preparation = deps.getWaitingLanePreparation(workItemId);
  if (!preparation) return { ok: true, skipped: "missing_preparation" };
  if (["retired", "poisoned", "activating", "active"].includes(preparation.state)) {
    return lostPreparationResult(preparation, `state_${preparation.state}`);
  }

  const settings = deps.readWaitingLaneCoordinatorSettings();
  const physicalGate = deps.waitingLanePhysicalPreparationGate(preparation, settings);
  if (!physicalGate.ok) {
    return { ok: true, deferred: true, skipped: physicalGate.reason, preparation };
  }

  const repoRoot = await deps.gitTopLevelAsync(projectDir, { signal });
  const worktreeRoot = preparation.worktree_root
    || await deps.worktreePathAsync(projectDir, workItemId, null, { signal });
  const nestedProjectSubpath = await deps.nestedProjectSubpathAsync(projectDir, { signal });
  const projectCwd = preparation.project_cwd
    || (nestedProjectSubpath ? path.join(worktreeRoot, nestedProjectSubpath) : worktreeRoot);
  const ownershipRecordId = preparation.ownership_record_id || preparationIdentity(workItemId);

  if (["requested", "stale"].includes(preparation.state)) {
    const ensured = deps.ensureWaitingLanePreparation({
      workItemId,
      demandReason: preparation.demand_reason,
      targetBranch: preparation.target_branch,
      generation: preparation.desired_generation,
      worktreeRoot,
      projectCwd,
      ownershipRecordId,
      hotPaths: preparation.hot_paths,
    });
    if (ensured.outcome === "ineligible") {
      const current = ensured.preparation || deps.getWaitingLanePreparation(workItemId);
      if (current && !["retired", "poisoned", "activating", "active"].includes(current.state)) {
        deps.retireWaitingLanePreparation({
          workItemId,
          expectedVersion: current.version,
          reason: `eligibility_recheck_${ensured.reason || "failed"}`,
        });
      }
      return lostPreparationResult(current, ensured.reason || "eligibility_recheck_failed");
    }
    preparation = ensured.preparation || deps.getWaitingLanePreparation(workItemId);
  }

  let claimed;
  if (preparation.state === "preparing_git" && Number(preparation.git_job_id) === Number(job.id)) {
    claimed = { outcome: "already_current", preparation };
  } else {
    claimed = deps.claimWaitingLaneGitPreparation({
      workItemId,
      expectedVersion: preparation.version,
      gitJobId: Number(job.id),
    });
  }
  if (!["promoted", "already_current"].includes(claimed.outcome)) {
    return lostPreparationResult(claimed.preparation, claimed.outcome);
  }
  preparation = claimed.preparation;

  return deps.withRepositoryWorktreeAdminLockAsync(repoRoot, projectDir, async () => (
    deps.withWorktreeLockAsync(worktreeRoot, projectDir, async () => {
      let current = deps.getWaitingLanePreparation(workItemId);
      if (
        !current
        || current.state !== "preparing_git"
        || Number(current.git_job_id) !== Number(job.id)
      ) {
        return lostPreparationResult(current);
      }

      // Re-evaluate semantic eligibility only after both Git fences. Activation
      // can claim the row before taking these locks; the explicit state check
      // above makes its tombstone win without touching the checkout.
      const rechecked = deps.ensureWaitingLanePreparation({
        workItemId,
        demandReason: current.demand_reason,
        targetBranch: current.target_branch,
        generation: current.desired_generation,
        worktreeRoot,
        projectCwd,
        ownershipRecordId,
        hotPaths: current.hot_paths,
      });
      if (rechecked.outcome === "ineligible") {
        current = rechecked.preparation || deps.getWaitingLanePreparation(workItemId);
        const retired = current && current.state === "preparing_git"
          ? deps.retireWaitingLanePreparation({
              workItemId,
              expectedVersion: current.version,
              reason: `eligibility_recheck_${rechecked.reason || "failed"}`,
            })
          : null;
        return lostPreparationResult(retired?.preparation || current, rechecked.reason || "eligibility_recheck_failed");
      }
      current = rechecked.preparation || deps.getWaitingLanePreparation(workItemId);
      if (
        !current
        || current.state !== "preparing_git"
        || Number(current.git_job_id) !== Number(job.id)
      ) {
        return lostPreparationResult(current);
      }

      const lockedGate = deps.waitingLanePhysicalPreparationGate(
        current,
        deps.readWaitingLaneCoordinatorSettings(),
      );
      if (!lockedGate.ok) {
        return { ok: true, deferred: true, skipped: lockedGate.reason, preparation: current };
      }

      const desired = normalizeWaitingLaneGeneration(current.desired_generation);
      if (!desired) return { ok: true, deferred: true, skipped: "generation_unavailable", preparation: current };

      const worktree = deps.Worktree.at(repoRoot, worktreeRoot);
      const inspected = await worktree.inspectPreparedAsync({
        preparationId: ownershipRecordId,
        signal,
      });
      if (inspected.available !== true) {
        const retired = deps.retireWaitingLanePreparation({
          workItemId,
          expectedVersion: current.version,
          reason: "native_capability_unavailable",
        });
        return { ok: true, skipped: "native_capability_unavailable", preparation: retired.preparation };
      }

      const inspection = inspected.result || {};
      const inspectedOid = normalizedOid(inspection.headOid || inspection.afterOid);
      const ownershipPhase = typeof inspection.ownershipPhase === "string"
        ? inspection.ownershipPhase.trim().toLowerCase()
        : null;
      /** @type {any} */
      let nativeOperation = inspected;
      if (
        ownershipPhase === "prepared"
        && inspection.ok === true
        && inspectedOid === desired.git_oid
      ) {
        nativeOperation = inspected;
      } else if (
        ownershipPhase === "intent"
        && !current.applied_git_oid
      ) {
        const beforeMutation = deps.getWaitingLanePreparation(workItemId);
        if (
          !beforeMutation
          || beforeMutation.state !== "preparing_git"
          || Number(beforeMutation.git_job_id) !== Number(job.id)
          || beforeMutation.version !== current.version
        ) {
          return lostPreparationResult(beforeMutation);
        }
        current = beforeMutation;
        nativeOperation = await worktree.prepareDetachedAsync({
          targetOid: desired.git_oid,
          preparationId: ownershipRecordId,
          signal,
        });
      } else if (ownershipPhase === "intent" && current.applied_git_oid) {
        const expectedOldOid = normalizedOid(inspection.expectedOid);
        if (!expectedOldOid) {
          const poisoned = deps.poisonWaitingLanePreparation({
            workItemId,
            expectedVersion: current.version,
            reason: "prepared_worktree_intent_expected_oid_missing",
          });
          return {
            ok: true,
            skipped: "prepared_worktree_ownership_mismatch",
            preparation: poisoned.preparation,
            nativeResult: inspection,
          };
        }
        const beforeMutation = deps.getWaitingLanePreparation(workItemId);
        if (
          !beforeMutation
          || beforeMutation.state !== "preparing_git"
          || Number(beforeMutation.git_job_id) !== Number(job.id)
          || beforeMutation.version !== current.version
        ) {
          return lostPreparationResult(beforeMutation);
        }
        current = beforeMutation;
        nativeOperation = await worktree.refreshPreparedAsync({
          preparationId: ownershipRecordId,
          expectedOldOid,
          targetOid: desired.git_oid,
          signal,
        });
      } else if (
        ownershipPhase === null
        && !current.applied_git_oid
        && inspection.status === "ownership_record_missing"
      ) {
        const beforeMutation = deps.getWaitingLanePreparation(workItemId);
        if (
          !beforeMutation
          || beforeMutation.state !== "preparing_git"
          || Number(beforeMutation.git_job_id) !== Number(job.id)
          || beforeMutation.version !== current.version
        ) {
          return lostPreparationResult(beforeMutation);
        }
        current = beforeMutation;
        nativeOperation = await worktree.prepareDetachedAsync({
          targetOid: desired.git_oid,
          preparationId: ownershipRecordId,
          signal,
        });
      } else if (
        ownershipPhase === "prepared"
        && inspection.ok === true
        && inspectedOid
      ) {
        const beforeMutation = deps.getWaitingLanePreparation(workItemId);
        if (
          !beforeMutation
          || beforeMutation.state !== "preparing_git"
          || Number(beforeMutation.git_job_id) !== Number(job.id)
          || beforeMutation.version !== current.version
        ) {
          return lostPreparationResult(beforeMutation);
        }
        current = beforeMutation;
        nativeOperation = await worktree.refreshPreparedAsync({
          preparationId: ownershipRecordId,
          expectedOldOid: inspectedOid,
          targetOid: desired.git_oid,
          signal,
        });
      } else {
        const poisoned = deps.poisonWaitingLanePreparation({
          workItemId,
          expectedVersion: current.version,
          reason: `prepared_worktree_${inspection.status || "inspection_mismatch"}`,
        });
        return {
          ok: true,
          skipped: "prepared_worktree_ownership_mismatch",
          preparation: poisoned.preparation,
          nativeResult: inspection,
        };
      }

      const validated = nativePreparedResult(nativeOperation, desired.git_oid);
      if (!validated.ok) {
        const transition = validated.unavailable
          ? deps.retireWaitingLanePreparation({
              workItemId,
              expectedVersion: current.version,
              reason: validated.reason,
            })
          : deps.poisonWaitingLanePreparation({
              workItemId,
              expectedVersion: current.version,
              reason: `native_preparation_${validated.reason}`,
            });
        return {
          ok: true,
          skipped: validated.reason,
          preparation: transition.preparation,
          nativeResult: validated.result || null,
        };
      }

      const afterGit = deps.getWaitingLanePreparation(workItemId);
      if (
        !afterGit
        || afterGit.state !== "preparing_git"
        || Number(afterGit.git_job_id) !== Number(job.id)
      ) {
        return lostPreparationResult(afterGit);
      }
      if (
        afterGit.version !== current.version
        || normalizeWaitingLaneGeneration(afterGit.desired_generation)?.git_oid !== validated.headOid
      ) {
        return {
          ok: true,
          retry: true,
          reason: "newer_generation_after_git",
          preparation: afterGit,
          nativeResult: validated.result,
        };
      }

      const purpose = deps.waitingLaneAtlasPurposeForPreparation(afterGit);
      const atlasGate = deps.waitingLanePhysicalPreparationGate(
        afterGit,
        deps.readWaitingLaneCoordinatorSettings(),
      );
      if (atlasGate.ok !== true || atlasGate.atlasEnabled !== true) {
        const stored = deps.recordWaitingLaneGitPrepared({
          workItemId,
          expectedVersion: afterGit.version,
          gitJobId: Number(job.id),
          appliedGitOid: validated.headOid,
          worktreeRoot: validated.result.managedWorktreeRoot || worktreeRoot,
          projectCwd,
          ownershipRecordId: validated.result.preparationId || ownershipRecordId,
          atlasJobId: null,
        });
        if (stored.outcome !== "promoted") {
          const latest = deps.getWaitingLanePreparation(workItemId);
          if (
            latest?.state === "preparing_git"
            && Number(latest.git_job_id) === Number(job.id)
          ) {
            return {
              ok: true,
              retry: true,
              reason: "newer_generation_before_git_only_publish",
              preparation: latest,
              nativeResult: validated.result,
            };
          }
          return lostPreparationResult(latest, stored.outcome);
        }
        return {
          ok: true,
          gitOnly: true,
          purpose,
          preparation: stored.preparation,
          atlasJobId: null,
          atlasCoalesced: false,
          nativeResult: validated.result,
        };
      }
      try {
        const atlas = deps.enqueueWaitingLaneAtlasWarm({
          workItemId,
          parentJobId: Number(job.id),
          purpose,
          generation: afterGit.desired_generation,
          preparationVersion: afterGit.version,
          priority: atlasPriority(afterGit),
          commitState: ({ atlasJobId }) => deps.recordWaitingLaneGitPrepared({
            workItemId,
            expectedVersion: afterGit.version,
            gitJobId: Number(job.id),
            appliedGitOid: validated.headOid,
            worktreeRoot: validated.result.managedWorktreeRoot || worktreeRoot,
            // Native Git addresses the repository root; the queue row retains
            // the separately resolved nested project cwd used by agents.
            projectCwd,
            ownershipRecordId: validated.result.preparationId || ownershipRecordId,
            atlasJobId,
          }),
        });
        return {
          ok: true,
          purpose,
          preparation: atlas.stateResult.preparation,
          atlasJobId: atlas.warmJobId,
          atlasCoalesced: atlas.coalesced,
          nativeResult: validated.result,
        };
      } catch (error) {
        if (error?.code === "WAITING_LANE_STATE_COMMIT_FAILED") {
          const latest = deps.getWaitingLanePreparation(workItemId);
          if (
            latest?.state === "preparing_git"
            && Number(latest.git_job_id) === Number(job.id)
          ) {
            return {
              ok: true,
              retry: true,
              reason: "newer_generation_before_atlas_enqueue",
              preparation: latest,
              nativeResult: validated.result,
            };
          }
          return lostPreparationResult(latest);
        }
        throw error;
      }
    }, { signal })
  ), { signal });
}

/**
 * @param {any} worker
 * @param {any} job
 * @param {any} wrappedJob
 * @param {{ leaseToken?: string | null, abortSignal?: AbortSignal | null }} [options]
 */
export async function runWaitingLanePreparationJob(
  worker,
  job,
  wrappedJob,
  { leaseToken = null, abortSignal = null } = {},
) {
  const startedAt = Date.now();
  let attempt = null;
  try {
    attempt = incrementAndCreateAttempt(
      job.id,
      leaseToken,
      "system",
      "waiting-lane-prepare",
      null,
    );
    if (!attempt) {
      logAttemptSkippedStaleLease(
        job,
        "system",
        "Skipped waiting_lane_prepare attempt because the lease was stale or expired",
      );
      return;
    }

    const result = await executeWaitingLanePreparation({
      job,
      projectDir: worker.projectDir,
      signal: abortSignal,
    });
    const durationMs = Date.now() - startedAt;
    const gitOutcome = result.retry
      ? "retry"
      : (result.deferred
          ? "deferred"
          : (result.gitOnly
              ? "git_only"
              : (result.atlasJobId ? "atlas_queued" : (result.skipped ? "suppressed" : "succeeded"))));
    recordWaitingLaneTelemetry("git_preparation_finished", {
      preparation: result.preparation,
      workItemId: job.work_item_id,
      jobId: job.id,
      outcome: gitOutcome,
      reason: result.reason || result.skipped,
      durationMs,
      gitOnly: result.gitOnly === true,
    });
    if (result.gitOnly || result.atlasJobId) {
      recordWaitingLaneTelemetry("atlas_queue_decision", {
        preparation: result.preparation,
        workItemId: job.work_item_id,
        jobId: result.atlasJobId || job.id,
        outcome: result.gitOnly ? "git_only" : "atlas_queued",
        decision: result.gitOnly ? "git_only" : (result.atlasCoalesced ? "coalesced" : "queued"),
        purpose: result.purpose,
        coalesced: result.atlasCoalesced === true,
        atlasEnabled: !result.gitOnly,
        gitOnly: result.gitOnly === true,
      });
    }
    setJobResult(job.id, result);
    /** @type {any} */ (storeArtifact)({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      artifact_type: "response",
      content_long: JSON.stringify(result),
    });
    /** @type {any} */ (completeAttempt)(attempt.attempt.id, {
      status: result.retry || result.deferred ? "interrupted" : "succeeded",
      duration_ms: Date.now() - startedAt,
      output_chars: 0,
      notes: result.retry ? result.reason : (result.deferred ? result.skipped : null),
    });

    if (result.retry || result.deferred) {
      const delay = result.deferred ? WAITING_LANE_DISABLED_REQUEUE_DELAY_MS : 0;
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + delay).toISOString(),
      });
      worker.emit(
        job.id,
        `${C.dim}[waiting-lane] WI#${job.work_item_id} preparation deferred: ${result.reason || result.skipped}${C.reset}`,
      );
      return;
    }

    if (worker._releaseLease(job, leaseToken, "succeeded") && job.work_item_id) {
      refreshWorkItemStatus(job.work_item_id);
    }
    worker.emit(
      job.id,
      `${C.dim}[waiting-lane] WI#${job.work_item_id} preparation ${result.atlasJobId ? `queued Atlas #${result.atlasJobId}` : (result.skipped || "settled")}${C.reset}`,
    );
  } catch (error) {
    const telemetryLockTimeout = /timed out waiting for .*lock/iu.test(error?.message || String(error));
    recordWaitingLaneTelemetry("git_preparation_finished", {
      workItemId: job.work_item_id,
      jobId: job.id,
      outcome: "failed",
      reason: telemetryLockTimeout ? "lock_timeout" : "execution_error",
      durationMs: Date.now() - startedAt,
    });
    if (attempt && worker._handleDeterministicInterruption?.(
      job,
      attempt.attempt.id,
      startedAt,
      leaseToken,
      error,
    )) return;

    const message = error?.message || String(error);
    const current = getWaitingLanePreparation(job.work_item_id);
    const lockTimeout = /timed out waiting for .*lock/iu.test(message);
    if (lockTimeout && attempt) {
      /** @type {any} */ (completeAttempt)(attempt.attempt.id, {
        status: "interrupted",
        duration_ms: Date.now() - startedAt,
        error_text: message,
      });
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + 1000).toISOString(),
      });
      return;
    }
    if (current && !["retired", "poisoned", "activating", "active"].includes(current.state)) {
      retireWaitingLanePreparation({
        workItemId: job.work_item_id,
        expectedVersion: current.version,
        reason: `preparation_error_${message}`,
      });
    }
    if (!attempt) return;
    /** @type {any} */ (completeAttempt)(attempt.attempt.id, {
      status: "failed",
      duration_ms: Date.now() - startedAt,
      error_text: message,
    });
    try { await wrappedJob?.setError?.(message); } catch { /* best effort */ }
    if (worker._releaseLease(job, leaseToken, "failed") && job.work_item_id) {
      refreshWorkItemStatus(job.work_item_id);
    }
    worker.emit(job.id, `${C.yellow}[waiting-lane] WI#${job.work_item_id} preparation failed: ${message}${C.reset}`);
  }
}
