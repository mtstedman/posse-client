// Preparation-aware dev activation. This module owns the narrow bridge among
// queue CAS state, guarded native Git attachment, and exact Atlas mounting.

import fs from "fs";
import path from "path";
import { WAITING_LANE_SETTING_KEYS, waitingLaneGenerationsEqual } from "../../../../catalog/waiting-lane.js";
import { ACTIVE_LEASE_STATUSES, TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import {
  claimWaitingLaneActivation,
  clearWaitingLanePreparedAssetProof,
  forceUpdateJobStatus,
  getJob,
  getSetting,
  getWaitingLanePreparation,
  getWorkItem,
  markWaitingLaneActive,
  poisonWaitingLanePreparation,
  retireWaitingLanePreparation,
  setWorkItemBranch,
} from "../../../queue/functions/index.js";
import { Worktree } from "../../../git/classes/Worktree.js";
import { configureWorktreeScopeAsync } from "../../../git/functions/worktree-create.js";
import {
  sleepMsAsync,
  withRepositoryWorktreeAdminLockAsync,
  withWorktreeLockAsync,
} from "../../../git/functions/worktree-locks.js";
import { gitTopLevelAsync } from "../../../git/functions/worktree-path.js";
import { resolveTargetBranchAsync } from "../../../git/functions/target-branch.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { removePreparedWorktreeIfSafeAsync } from "../../../git/functions/prepared-worktree-recovery.js";
import { tombstoneWaitingLanePreparationForCleanup } from "../../../git/functions/waiting-lane-cleanup.js";
import { resolveWorkItemAtlasContext } from "../../../integrations/functions/atlas.js";
import { Ledger } from "../../../atlas/classes/v2/Ledger.js";
import { View } from "../../../atlas/classes/v2/View.js";
import { Warmer } from "../../../atlas/classes/v2/Warmer.js";
import { ledgerBranchForWi } from "../../../atlas/functions/v2/runtime-paths.js";
import { withAtlasViewWriteLock } from "../../../atlas/functions/v2/view-write-lock.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { writeActiveWorktreeSentinel } from "./worktree-sentinel.js";

const ACTIVE_JOB_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const DEFAULT_CHILD_WAIT_MS = 2_000;
const CHILD_POLL_MS = 50;

export function waitingLaneActivationEnabled(projectDir, getSettingFn = getSetting) {
  try {
    return String(getSettingFn(WAITING_LANE_SETTING_KEYS.ACTIVATION_ENABLED, { projectDir }) || "")
      .trim()
      .toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function waitingLaneInspectionRequiresPreservation(inspection, pathExists) {
  const result = inspection?.result || null;
  if (inspection?.available === false) return false;
  if (result?.ok === true) return false;
  if (pathExists) return true;
  // `clean: false` on a failed inspection is the native default for a checkout
  // it never examined, not a dirty tree; see classifyPreparedWorktreeInspection.
  // The statuses below are the ones that do report something worth keeping.
  return result?.registered === true
    || ["wrong_owner", "unmanaged_root", "attached_mismatch", "inspection_mismatch"]
      .includes(String(result?.status || ""));
}

async function cancelAndBoundedWait(preparation, currentJobId, { signal = null, waitMs = DEFAULT_CHILD_WAIT_MS } = {}) {
  const ids = [...new Set([preparation?.git_job_id, preparation?.atlas_job_id]
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0 && id !== Number(currentJobId)))];
  for (const id of ids) {
    const job = getJob(id);
    if (!job || TERMINAL_JOB_STATUS_SET.has(job.status) || ACTIVE_JOB_STATUS_SET.has(job.status)) continue;
    forceUpdateJobStatus(id, "canceled", { expectedStatuses: [job.status] });
  }
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (Date.now() < deadline) {
    const active = ids.some((id) => {
      const job = getJob(id);
      return !!job && ACTIVE_JOB_STATUS_SET.has(job.status);
    });
    if (!active) return { settled: true, job_ids: ids };
    await sleepMsAsync(Math.min(CHILD_POLL_MS, Math.max(1, deadline - Date.now())), signal);
  }
  return {
    settled: !ids.some((id) => ACTIVE_JOB_STATUS_SET.has(getJob(id)?.status)),
    job_ids: ids,
  };
}

function exactClaimStillOwned(workItemId, claimed) {
  const current = getWaitingLanePreparation(workItemId);
  return current
    && current.state === "activating"
    && current.version === claimed.version
    ? current
    : null;
}

function settingExplicitlyEnabled(projectDir, key) {
  try {
    return String(getSetting(key, { projectDir }) || "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

function normalizeOid(value) {
  const oid = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null;
}

export function isPreparedWorktreeAlreadyAttached(result, branchName, expectedOid) {
  return result?.ownershipPhase === "attached"
    && result?.detached === false
    && result?.branchName === branchName
    && normalizeOid(result?.headOid) === normalizeOid(expectedOid);
}

export function waitingLaneActivationAtlasMode(preparation, { catchupEnabled = false } = {}) {
  if (preparation?.atlas_job_id == null && preparation?.applied_generation == null) {
    return "git-only";
  }
  return catchupEnabled ? "catchup" : "exact-only";
}

async function exactWorktreeRegistration(projectDir, worktreeRoot, { signal = null } = {}) {
  const canonical = path.resolve(worktreeRoot);
  const porcelain = await gitExecAsync(["worktree", "list", "--porcelain"], projectDir, { signal });
  return String(porcelain || "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => path.resolve(line.slice("worktree ".length).trim()) === canonical);
}

async function exactTarget(projectDir, preparation, { signal = null } = {}) {
  const targetBranch = await resolveTargetBranchAsync(projectDir, { signal });
  if (targetBranch !== preparation.target_branch) {
    return { ok: false, reason: "target_branch_changed" };
  }
  const oid = normalizeOid(await gitExecAsync(
    ["rev-parse", "--verify", `${targetBranch}^{commit}`],
    projectDir,
    { signal },
  ));
  if (!oid || oid !== preparation.desired_generation?.git_oid) {
    return { ok: false, reason: "target_oid_changed", target_branch: targetBranch, git_oid: oid };
  }
  return { ok: true, target_branch: targetBranch, git_oid: oid };
}

export function isExactMountedWaitingLaneView(viewPath, ledgerBranch, generation) {
  if (!viewPath || !fs.existsSync(viewPath)) return false;
  let view = null;
  try {
    view = View.mount({ dbPath: viewPath });
    const meta = view.metaLocal();
    return meta.branch === ledgerBranch
      && meta.parent_branch === generation.target_branch
      && meta.parent_seq === generation.atlas_ledger_seq
      && meta.ledger_seq === generation.atlas_ledger_seq
      && meta.layer_revision === generation.atlas_layer_revision
      && meta.view_fingerprint === generation.view_fingerprint
      && meta.git_oid === generation.git_oid;
  } catch {
    return false;
  } finally {
    try { view?.close(); } catch { /* best effort */ }
  }
}

function exactParkedGeneration(viewPath, generation) {
  if (!viewPath || !fs.existsSync(viewPath)) return false;
  let view = null;
  try {
    view = View.mount({ dbPath: viewPath });
    return waitingLaneGenerationsEqual(view.generationLocal(), generation);
  } catch {
    return false;
  } finally {
    try { view?.close(); } catch { /* best effort */ }
  }
}

async function reconcileAndMountAtlas({
  worker,
  workItemId,
  worktreeRoot,
  generation,
  hotPaths,
  attachGit,
  persistBranch,
  recheckClaim,
  recheckTarget,
  allowCatchup,
  signal,
}) {
  const config = worker?._atlasConfig || undefined;
  const ctx = resolveWorkItemAtlasContext({
    projectDir: worker.projectDir,
    worktreePath: worktreeRoot,
    workItemId,
    config,
  });
  const ledgerBranch = ledgerBranchForWi(workItemId);
  return runSqliteWrite(ctx.ledgerDbPath, async () => {
    let ledger = null;
    try {
      ledger = await Ledger.open({ dbPath: ctx.ledgerDbPath });
      const target = ledger.getBranch(generation.target_branch);
      const ledgerCurrent = !!target
        && ledger.headSeq(generation.target_branch) === generation.atlas_ledger_seq
        && ledger.layerRevision() === generation.atlas_layer_revision;
      if (allowCatchup && !ledgerCurrent) {
        return { attached: false, atlas_ready: false, reason: "atlas_generation_not_current" };
      }
      const warmer = new Warmer({
        ledger,
        repoRoot: ctx.repoRoot,
        defaultBranch: generation.target_branch,
        config: ctx.config,
        signal,
      });
      let actual = generation;
      if (allowCatchup) {
        const caughtUp = await warmer.handleWarmJob({
          purpose: "wi-catchup",
          work_item_id: workItemId,
          generation,
        });
        actual = caughtUp?.generation || null;
        if (!waitingLaneGenerationsEqual(actual, generation)) {
          return { attached: false, atlas_ready: false, reason: caughtUp?.waiting_lane_outcome || "atlas_catchup_failed" };
        }
      }
      // Catch-up releases its own source lock. Reacquire the exact same lock,
      // then recheck both the CAS tombstone and actual parked bytes before the
      // move. mountForWorktreeAsync nests the destination lock under this one.
      return withAtlasViewWriteLock(ctx.warmedViewDbPath, async () => {
        if (!recheckClaim()) {
          return { attached: false, atlas_ready: false, reason: "activation_version_lost_under_source_fence" };
        }
        const parkedExact = ledgerCurrent && exactParkedGeneration(ctx.warmedViewDbPath, generation);
        if (!parkedExact && allowCatchup) {
          return { attached: false, atlas_ready: false, reason: "parked_generation_changed_under_source_fence" };
        }
        if (!parkedExact) {
          const beforeFallbackTarget = await recheckTarget();
          if (!beforeFallbackTarget?.ok) {
            return { attached: false, atlas_ready: false, reason: beforeFallbackTarget?.reason || "target_changed_before_attach" };
          }
          const fallbackAttachment = await attachGit();
          if (!fallbackAttachment?.ok) {
            return {
              attached: false,
              atlas_ready: fallbackAttachment?.safe_fallback ? false : true,
              reason: fallbackAttachment?.reason || "git_attach_failed",
            };
          }
          persistBranch();
          const afterFallbackTarget = await recheckTarget();
          return {
            attached: true,
            atlas_ready: false,
            reason: afterFallbackTarget?.ok
              ? "parked_generation_unavailable_without_catchup"
              : afterFallbackTarget?.reason || "target_changed_during_attach",
          };
        }
        const beforeAttachTarget = await recheckTarget();
        if (!beforeAttachTarget?.ok) {
          return { attached: false, atlas_ready: false, reason: beforeAttachTarget?.reason || "target_changed_before_attach" };
        }
        const attached = await attachGit();
        if (!attached?.ok) {
          return {
            attached: false,
            atlas_ready: attached?.safe_fallback ? false : true,
            reason: attached?.reason || "git_attach_failed",
          };
        }
        persistBranch();
        const afterAttachTarget = await recheckTarget();
        if (!afterAttachTarget?.ok) {
          return { attached: true, atlas_ready: false, reason: afterAttachTarget?.reason || "target_changed_during_attach" };
        }

        const existing = ledger.getBranch(ledgerBranch);
        if (!existing) {
          await ledger.forkBranch(ledgerBranch, generation.target_branch, generation.atlas_ledger_seq, {
            label: "waiting-lane.activation.fork",
          });
        } else if (existing.parent_branch !== generation.target_branch
          || existing.parent_seq !== generation.atlas_ledger_seq
          || ledger.headSeq(ledgerBranch) !== generation.atlas_ledger_seq) {
          return { attached: true, atlas_ready: false, reason: "atlas_branch_fork_mismatch" };
        }
        const mount = await warmer.mountForWorktreeAsync({
          workItemId,
          ledgerBranch,
          worktreePath: worktreeRoot,
        }, { label: "waiting-lane.activation.mount" });
        if (!isExactMountedWaitingLaneView(mount?.viewPath, ledgerBranch, generation)) {
          return { attached: true, atlas_ready: false, reason: "mounted_view_generation_mismatch" };
        }
        const prefetched = await warmer.handleWarmJob({
          purpose: "wi-prefetch",
          work_item_id: workItemId,
          out_view_path: mount.viewPath,
          paths: Array.isArray(hotPaths) ? hotPaths.slice(0, 256) : [],
        });
        if (!isExactMountedWaitingLaneView(mount?.viewPath, ledgerBranch, generation)) {
          return { attached: true, atlas_ready: false, reason: "prefetched_view_generation_mismatch" };
        }
        const finalTarget = await recheckTarget();
        if (!finalTarget?.ok) {
          return { attached: true, atlas_ready: false, reason: finalTarget?.reason || "target_changed_before_finalize" };
        }
        return {
          attached: true,
          atlas_ready: true,
          actual_generation: actual,
          atlas_context: ctx,
          mount,
          prefetch: prefetched,
        };
      });
    } finally {
      try { await ledger?.closeNative?.(); } catch { try { ledger?.close?.(); } catch { /* best effort */ } }
    }
  }, {
    label: "waiting-lane.activation.source-view-fence",
    waitMs: 30_000,
  });
}

function stateReason(prefix, detail) {
  return `${prefix}:${String(detail || "unknown").slice(0, 800)}`;
}

function closeActivationClaimForDeferred(workItemId, claimed, reason) {
  try {
    const retired = retireWaitingLanePreparation({
      workItemId,
      expectedVersion: claimed.version,
      reason,
    });
    if (retired.preparation?.state !== "activating") return retired;
  } catch { /* try the current CAS row below */ }
  try {
    const current = getWaitingLanePreparation(workItemId);
    if (!current || current.state !== "activating") return null;
    return poisonWaitingLanePreparation({
      workItemId,
      expectedVersion: current.version,
      reason: stateReason("activation_deferred_poison", reason),
    });
  } catch {
    return null;
  }
}

async function cleanupDisabledWaitingLanePreparation({
  worker,
  job,
  wi,
  worktreeRoot,
  signal,
  childWaitMs,
  deps,
}) {
  const preparation = getWaitingLanePreparation(wi.id);
  if (!preparation) {
    return { activated: false, fallback: true, reason: "activation_disabled" };
  }
  const expectedRoot = path.resolve(worktreeRoot);
  const preparedRoot = preparation.worktree_root
    ? path.resolve(preparation.worktree_root)
    : null;
  if (preparation.state === "active") {
    return {
      activated: false,
      fallback: false,
      deferred: true,
      preserve_path: preparedRoot || expectedRoot,
      reason: "activation_disabled_preparation_already_active",
    };
  }
  if (preparation.state === "poisoned") {
    return {
      activated: false,
      fallback: false,
      poisoned: true,
      preserve_path: preparedRoot || expectedRoot,
      reason: "activation_disabled_preparation_poisoned",
    };
  }

  const tombstone = await tombstoneWaitingLanePreparationForCleanup(preparation, {
    signal,
    waitMs: childWaitMs,
  });
  if (!tombstone.ready) {
    return {
      activated: false,
      fallback: false,
      deferred: true,
      preserve_path: preparedRoot || expectedRoot,
      reason: tombstone.deferred
        ? "activation_disabled_children_still_active"
        : "activation_disabled_tombstone_conflict",
      child_job_ids: tombstone.job_ids,
    };
  }
  const retired = tombstone.preparation;
  if (!retired || !preparedRoot) {
    if (retired) {
      const cleared = clearWaitingLanePreparedAssetProof({
        workItemId: wi.id,
        expectedVersion: retired.version,
      });
      if (!cleared.preparation || !["promoted", "already_current"].includes(cleared.outcome)) {
        return {
          activated: false,
          fallback: false,
          deferred: true,
          reason: "activation_disabled_asset_clear_conflict",
        };
      }
    }
    return { activated: false, fallback: true, reason: "activation_disabled_preparation_absent" };
  }
  if (preparedRoot !== expectedRoot || !retired.ownership_record_id) {
    poisonWaitingLanePreparation({
      workItemId: wi.id,
      expectedVersion: retired.version,
      reason: "activation_disabled_preparation_ownership_mismatch",
    });
    return {
      activated: false,
      fallback: false,
      poisoned: true,
      preserve_path: preparedRoot,
      reason: "activation_disabled_preparation_ownership_mismatch",
    };
  }

  const removePrepared = typeof deps.removePreparedWorktreeIfSafeAsync === "function"
    ? deps.removePreparedWorktreeIfSafeAsync
    : removePreparedWorktreeIfSafeAsync;
  let cleanup;
  try {
    cleanup = await removePrepared({
      projectDir: worker.projectDir,
      worktreeRoot: preparedRoot,
      preparationId: retired.ownership_record_id,
      expectedOid: retired.applied_git_oid || retired.desired_git_oid,
      signal,
    });
  } catch (error) {
    cleanup = { preserve: true, reason: stateReason("activation_disabled_cleanup_error", error?.message || error) };
  }
  if (cleanup?.preserve || fs.existsSync(preparedRoot)) {
    poisonWaitingLanePreparation({
      workItemId: wi.id,
      expectedVersion: retired.version,
      reason: stateReason("activation_disabled_preparation_preserved", cleanup?.reason),
    });
    return {
      activated: false,
      fallback: false,
      poisoned: true,
      preserve_path: preparedRoot,
      reason: cleanup?.reason || "activation_disabled_preparation_preserved",
    };
  }
  const cleared = clearWaitingLanePreparedAssetProof({
    workItemId: wi.id,
    expectedVersion: retired.version,
  });
  if (!cleared.preparation || !["promoted", "already_current"].includes(cleared.outcome)) {
    return {
      activated: false,
      fallback: false,
      deferred: true,
      reason: "activation_disabled_asset_clear_conflict",
    };
  }
  return { activated: false, fallback: true, reason: "activation_disabled_preparation_cleaned" };
}

/**
 * Consume a claimed prepared lane. A poisoned result is a hard stop: callers
 * must not route the same path through ordinary reset/recovery.
 */
export async function tryActivateWaitingLaneForJobAsync({
  worker,
  job,
  wi,
  branchName,
  worktreeRoot,
  signal = null,
  childWaitMs = DEFAULT_CHILD_WAIT_MS,
  deps = {},
} = {}) {
  if (!worker || !job || !wi || !worktreeRoot || job.job_type !== "dev") {
    return { activated: false, fallback: true, reason: "not_dev_activation" };
  }
  if (!waitingLaneActivationEnabled(worker.projectDir)) {
    return cleanupDisabledWaitingLanePreparation({
      worker,
      job,
      wi,
      worktreeRoot,
      signal,
      childWaitMs,
      deps,
    });
  }
  const claim = claimWaitingLaneActivation({ workItemId: wi.id });
  const resumableActivation = claim.outcome === "already_current"
    && claim.preparation?.state === "activating";
  if (claim.outcome === "poisoned" && claim.preparation) {
    const poisoned = claim.preparation;
    const expectedRoot = path.resolve(worktreeRoot);
    const poisonedRoot = poisoned.worktree_root ? path.resolve(poisoned.worktree_root) : expectedRoot;
    let poisonSettlement = null;
    try {
      poisonSettlement = await cancelAndBoundedWait(poisoned, job.id, { signal, waitMs: childWaitMs });
    } catch { /* absence is not proven */ }
    if (!poisonSettlement?.settled || poisonedRoot !== expectedRoot || fs.existsSync(poisonedRoot)) {
      return {
        activated: false,
        fallback: false,
        poisoned: true,
        preserve_path: poisonedRoot,
        reason: !poisonSettlement?.settled
          ? "poisoned_preparation_children_unsettled"
          : poisonedRoot !== expectedRoot
            ? "poisoned_preparation_path_mismatch"
            : "poisoned_preparation_path_exists",
      };
    }
    try {
      const repoRoot = await gitTopLevelAsync(worker.projectDir, { signal });
      return await withRepositoryWorktreeAdminLockAsync(repoRoot, worker.projectDir, () => {
        return withWorktreeLockAsync(poisonedRoot, worker.projectDir, async () => {
          if (fs.existsSync(poisonedRoot)
            || await exactWorktreeRegistration(worker.projectDir, poisonedRoot, { signal })) {
            return {
              activated: false,
              fallback: false,
              poisoned: true,
              preserve_path: poisonedRoot,
              reason: "poisoned_preparation_still_present",
            };
          }
          return { activated: false, fallback: true, reason: "poisoned_preparation_provably_absent" };
        }, { signal, waitMs: 30_000 });
      }, { signal, waitMs: 30_000 });
    } catch (error) {
      return {
        activated: false,
        fallback: false,
        poisoned: true,
        preserve_path: poisonedRoot,
        reason: stateReason("poisoned_preparation_absence_unproven", error?.message || error),
      };
    }
  }
  if (claim.outcome === "retired" && claim.preparation) {
    const retired = claim.preparation;
    let settlement;
    try {
      settlement = await cancelAndBoundedWait(retired, job.id, { signal, waitMs: childWaitMs });
    } catch (error) {
      return {
        activated: false,
        fallback: false,
        deferred: true,
        reason: stateReason("retired_child_settlement_error", error?.message || error),
      };
    }
    if (!settlement.settled) {
      return {
        activated: false,
        fallback: false,
        deferred: true,
        reason: "retired_preparation_children_still_active",
        child_job_ids: settlement.job_ids,
      };
    }
    const retiredRoot = retired.worktree_root ? path.resolve(retired.worktree_root) : null;
    if (!retiredRoot || !fs.existsSync(retiredRoot)) {
      return { activated: false, fallback: true, reason: "retired_preparation_absent" };
    }
    if (!retired.ownership_record_id || retiredRoot !== path.resolve(worktreeRoot)) {
      poisonWaitingLanePreparation({
        workItemId: wi.id,
        expectedVersion: retired.version,
        reason: "retired_preparation_existing_path_mismatch",
      });
      return { activated: false, fallback: false, poisoned: true, preserve_path: retiredRoot, reason: "retired_preparation_existing_path_mismatch" };
    }
    const cleanup = await removePreparedWorktreeIfSafeAsync({
      projectDir: worker.projectDir,
      worktreeRoot: retiredRoot,
      preparationId: retired.ownership_record_id,
      expectedOid: retired.applied_git_oid || retired.desired_git_oid,
      signal,
    });
    if (cleanup.preserve || fs.existsSync(retiredRoot)) {
      poisonWaitingLanePreparation({
        workItemId: wi.id,
        expectedVersion: retired.version,
        reason: stateReason("retired_preparation_preserved", cleanup.reason),
      });
      return { activated: false, fallback: false, poisoned: true, preserve_path: retiredRoot, reason: cleanup.reason || "retired_preparation_preserved" };
    }
    return { activated: false, fallback: true, reason: "retired_preparation_cleaned" };
  }
  if ((!resumableActivation && claim.outcome !== "activation_claimed") || !claim.preparation) {
    return { activated: false, fallback: true, reason: claim.reason || claim.outcome };
  }
  const claimed = claim.preparation;
  let childSettlement;
  try {
    childSettlement = await cancelAndBoundedWait(claimed, job.id, { signal, waitMs: childWaitMs });
  } catch (error) {
    closeActivationClaimForDeferred(
      wi.id,
      claimed,
      stateReason("activation_child_settlement_error", error?.message || error),
    );
    return {
      activated: false,
      fallback: false,
      deferred: true,
      reason: stateReason("activation_child_settlement_error", error?.message || error),
    };
  }
  if (!childSettlement.settled) {
    closeActivationClaimForDeferred(wi.id, claimed, "activation_children_still_active");
    return {
      activated: false,
      fallback: false,
      deferred: true,
      reason: "preparation_children_still_active",
      child_job_ids: childSettlement.job_ids,
    };
  }

  const desired = claimed.desired_generation;
  const preparationId = String(claimed.ownership_record_id || "").trim();
  const expectedRoot = path.resolve(worktreeRoot);
  if (!desired || !preparationId || !claimed.worktree_root
    || path.resolve(claimed.worktree_root) !== expectedRoot) {
    if (fs.existsSync(expectedRoot)) {
      poisonWaitingLanePreparation({
        workItemId: wi.id,
        expectedVersion: claimed.version,
        reason: "activation_asset_incomplete_existing_path",
      });
      return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: "activation_asset_incomplete" };
    }
    retireWaitingLanePreparation({ workItemId: wi.id, expectedVersion: claimed.version, reason: "activation_asset_incomplete" });
    return { activated: false, fallback: true, reason: "activation_asset_incomplete" };
  }

  let repoRoot = null;
  let worktree = null;
  let attached = false;
  let branchPersisted = false;
  let preparedClean = false;
  const resolveExactTarget = typeof deps.exactTarget === "function" ? deps.exactTarget : exactTarget;
  const WorktreeClass = deps.Worktree || Worktree;
  const configureScope = typeof deps.configureWorktreeScopeAsync === "function"
    ? deps.configureWorktreeScopeAsync
    : configureWorktreeScopeAsync;
  const writeSentinel = typeof deps.writeActiveWorktreeSentinel === "function"
    ? deps.writeActiveWorktreeSentinel
    : writeActiveWorktreeSentinel;
  const proveWorktreeRegistration = typeof deps.exactWorktreeRegistration === "function"
    ? deps.exactWorktreeRegistration
    : exactWorktreeRegistration;
  const persistWorkItemBranch = typeof deps.setWorkItemBranch === "function"
    ? deps.setWorkItemBranch
    : setWorkItemBranch;
  const readWorkItem = typeof deps.getWorkItem === "function"
    ? deps.getWorkItem
    : getWorkItem;
  try {
    const resolveGitTopLevelAsync = typeof deps.gitTopLevelAsync === "function"
      ? deps.gitTopLevelAsync
      : gitTopLevelAsync;
    repoRoot = await resolveGitTopLevelAsync(worker.projectDir, { signal });
    worktree = WorktreeClass.at(repoRoot, expectedRoot);
    return await withRepositoryWorktreeAdminLockAsync(repoRoot, worker.projectDir, async () => {
      return withWorktreeLockAsync(expectedRoot, worker.projectDir, async () => {
        const current = exactClaimStillOwned(wi.id, claimed);
        if (!current) return { activated: false, fallback: true, reason: "activation_version_lost" };
        let inspection = await worktree.inspectPreparedAsync({ preparationId, signal });
        if (inspection.available === false) {
          let registered = null;
          try {
            registered = await proveWorktreeRegistration(worker.projectDir, expectedRoot, { signal });
          } catch { /* absence remains unproven */ }
          if (!fs.existsSync(expectedRoot) && registered === false) {
            retireWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: "activation_unavailable_asset_absent",
            });
            return { activated: false, fallback: true, reason: "activation_unavailable_asset_absent" };
          }
          poisonWaitingLanePreparation({
            workItemId: wi.id,
            expectedVersion: current.version,
            reason: inspection.reason,
          });
          return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: inspection.reason };
        }
        if (!inspection.result?.ok) {
          const preserve = waitingLaneInspectionRequiresPreservation(
            inspection,
            fs.existsSync(expectedRoot),
          );
          if (preserve) {
            poisonWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: stateReason("activation_inspection", inspection.result?.status || inspection.result?.reason),
            });
            return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: "prepared_asset_poisoned" };
          }
          retireWaitingLanePreparation({
            workItemId: wi.id,
            expectedVersion: current.version,
            reason: "prepared_asset_missing",
          });
          return { activated: false, fallback: true, reason: "prepared_asset_missing" };
        }
        preparedClean = true;
        const removeCleanOwnedAssetForFallback = async () => {
          try {
            await worktree.removeAsync({
              force: false,
              prune: true,
              fallbackRemove: false,
              signal,
            });
          } catch {
            return false;
          }
          return !fs.existsSync(expectedRoot);
        };

        const target = await resolveExactTarget(worker.projectDir, current, { signal });
        if (!target.ok) {
          retireWaitingLanePreparation({ workItemId: wi.id, expectedVersion: current.version, reason: target.reason });
          return { activated: false, fallback: true, reason: target.reason };
        }

        if (inspection.result.detached && normalizeOid(inspection.result.headOid) !== desired.git_oid) {
          const refreshed = await worktree.refreshPreparedAsync({
            preparationId,
            expectedOldOid: inspection.result.headOid,
            targetOid: desired.git_oid,
            signal,
          });
          if (refreshed.available === false) {
            const removed = await removeCleanOwnedAssetForFallback();
            if (!removed) {
              poisonWaitingLanePreparation({
                workItemId: wi.id,
                expectedVersion: current.version,
                reason: stateReason("activation_refresh_unavailable_preserved", refreshed.reason),
              });
              return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: "prepared_refresh_unavailable_preserved" };
            }
            retireWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: stateReason("activation_refresh_unavailable", refreshed.reason),
            });
            return { activated: false, fallback: true, reason: "prepared_refresh_unavailable" };
          }
          if (!refreshed.result?.ok) {
            poisonWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: stateReason("activation_refresh", refreshed.result?.status || refreshed.reason),
            });
            return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: "prepared_refresh_failed" };
          }
          inspection = refreshed;
        }

        const attachGit = async () => {
          if (isPreparedWorktreeAlreadyAttached(inspection.result, branchName, desired.git_oid)) {
            attached = true;
            return { ok: true, status: "already_attached_by_same_preparation" };
          }
          const activation = await worktree.activatePreparedAsync({
            preparationId,
            expectedOid: desired.git_oid,
            branchName,
            signal,
          });
          const result = activation.result;
          const ok = activation.available !== false
            && result?.ok === true
            && ["attached", "already_attached_by_same_preparation"].includes(result.status);
          attached = ok;
          let safeFallback = false;
          if (activation.available === false) {
            safeFallback = await removeCleanOwnedAssetForFallback();
          }
          return {
            ok,
            safe_fallback: safeFallback,
            reason: result?.status || activation.reason,
            result,
          };
        };
        const persistBranch = () => {
          persistWorkItemBranch(wi.id, branchName, desired.git_oid);
          const persisted = readWorkItem(wi.id);
          if (String(persisted?.branch_name || "").trim() !== branchName
            || normalizeOid(persisted?.merge_base_hash) !== desired.git_oid) {
            throw new Error("waiting-lane attached branch metadata was not durably persisted");
          }
          branchPersisted = true;
        };
        const catchupEnabled = settingExplicitlyEnabled(
          worker.projectDir,
          WAITING_LANE_SETTING_KEYS.ATLAS_CATCHUP_ENABLED,
        );
        const atlasMode = waitingLaneActivationAtlasMode(current, { catchupEnabled });
        const gitOnly = atlasMode === "git-only";
        if (gitOnly) {
          const beforeAttachTarget = await resolveExactTarget(worker.projectDir, current, { signal });
          if (!beforeAttachTarget.ok) {
            retireWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: beforeAttachTarget.reason,
            });
            return { activated: false, fallback: true, reason: beforeAttachTarget.reason };
          }
          const gitAttachment = await attachGit();
          if (!gitAttachment.ok) {
            if (gitAttachment.safe_fallback) {
              retireWaitingLanePreparation({
                workItemId: wi.id,
                expectedVersion: current.version,
                reason: stateReason("git_only_attach_unavailable", gitAttachment.reason),
              });
              return { activated: false, fallback: true, reason: "prepared_activation_unavailable" };
            }
            poisonWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: stateReason("git_only_attach", gitAttachment.reason),
            });
            return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: gitAttachment.reason };
          }
          persistBranch();
          const afterAttachTarget = await resolveExactTarget(worker.projectDir, current, { signal });
          const projectCwd = await configureScope(expectedRoot, worker.projectDir, { signal });
          const sentinelPath = writeSentinel(expectedRoot, {
            pid: process.pid,
            jobId: job.id ?? null,
            wiId: wi.id,
            branchName,
          });
          retireWaitingLanePreparation({
            workItemId: wi.id,
            expectedVersion: current.version,
            reason: afterAttachTarget.ok
              ? "activation_git_only"
              : stateReason("activation_git_only_target_changed", afterAttachTarget.reason),
          });
          return {
            activated: true,
            fallback: false,
            atlas_ready: false,
            wtPath: projectCwd,
            worktreeRoot: expectedRoot,
            branchName,
            sentinelPath,
            atlas_context: null,
            reason: afterAttachTarget.ok ? "activation_git_only" : afterAttachTarget.reason,
          };
        }
        const atlas = await reconcileAndMountAtlas({
          worker,
          workItemId: wi.id,
          worktreeRoot: expectedRoot,
          generation: desired,
          hotPaths: current.hot_paths,
          attachGit,
          persistBranch,
          recheckClaim: () => !!exactClaimStillOwned(wi.id, current),
          recheckTarget: () => resolveExactTarget(worker.projectDir, current, { signal }),
          allowCatchup: atlasMode === "catchup",
          signal,
        });
        if (!atlas.attached) {
          if (atlas.atlas_ready === false) {
            retireWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: current.version,
              reason: stateReason("activation_fallback", atlas.reason),
            });
            return { activated: false, fallback: true, reason: atlas.reason };
          }
          poisonWaitingLanePreparation({
            workItemId: wi.id,
            expectedVersion: current.version,
            reason: stateReason("activation_attach", atlas.reason),
          });
          return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: atlas.reason };
        }

        const projectCwd = await configureScope(expectedRoot, worker.projectDir, { signal });
        const sentinelPath = writeSentinel(expectedRoot, {
          pid: process.pid,
          jobId: job.id ?? null,
          wiId: wi.id,
          branchName,
        });
        if (atlas.atlas_ready) {
          const activeTransition = markWaitingLaneActive({
            workItemId: wi.id,
            expectedVersion: current.version,
            actualGeneration: atlas.actual_generation,
          });
          if (!activeTransition.preparation || activeTransition.preparation.state !== "active"
            || !["promoted", "already_current"].includes(activeTransition.outcome)) {
            retireWaitingLanePreparation({
              workItemId: wi.id,
              expectedVersion: activeTransition.preparation?.version,
              reason: stateReason("activation_state_finalize", activeTransition.reason || activeTransition.outcome),
            });
            return {
              activated: true,
              fallback: false,
              atlas_ready: false,
              wtPath: projectCwd,
              worktreeRoot: expectedRoot,
              branchName,
              sentinelPath,
              atlas_context: atlas.atlas_context || null,
              reason: "activation_state_finalize_failed",
            };
          }
        } else {
          retireWaitingLanePreparation({
            workItemId: wi.id,
            expectedVersion: current.version,
            reason: stateReason("activation_atlas_fallback", atlas.reason),
          });
        }
        return {
          activated: true,
          fallback: false,
          atlas_ready: atlas.atlas_ready,
          wtPath: projectCwd,
          worktreeRoot: expectedRoot,
          branchName,
          sentinelPath,
          atlas_context: atlas.atlas_context || null,
          reason: atlas.reason || null,
        };
      }, { signal, waitMs: 30_000 });
    }, { signal, waitMs: 30_000 });
  } catch (error) {
    let current = null;
    try { current = getWaitingLanePreparation(wi.id); } catch { /* state transition helpers below remain fail-closed */ }
    if (!attached) {
      if (preparedClean) {
        retireWaitingLanePreparation({
          workItemId: wi.id,
          expectedVersion: current?.version,
          reason: stateReason("activation_clean_fallback", error?.message || error),
        });
        return { activated: false, fallback: true, reason: "activation_clean_fallback" };
      }
      if (fs.existsSync(expectedRoot)) {
        poisonWaitingLanePreparation({
          workItemId: wi.id,
          expectedVersion: current?.version,
          reason: stateReason("activation_exception", error?.message || error),
        });
        return { activated: false, fallback: false, poisoned: true, preserve_path: expectedRoot, reason: "activation_exception" };
      }
      retireWaitingLanePreparation({
        workItemId: wi.id,
        expectedVersion: current?.version,
        reason: stateReason("activation_exception", error?.message || error),
      });
      return { activated: false, fallback: true, reason: "activation_exception" };
    }
    if (!branchPersisted) {
      try {
        persistWorkItemBranch(wi.id, branchName, desired.git_oid);
      } catch { /* a write-then-throw still gets the durable read below */ }
      try {
        const persisted = readWorkItem(wi.id);
        branchPersisted = String(persisted?.branch_name || "").trim() === branchName
          && normalizeOid(persisted?.merge_base_hash) === desired.git_oid;
      } catch { /* handled by the hard-stop below */ }
    }
    if (!branchPersisted) {
      return {
        activated: false,
        fallback: false,
        deferred: true,
        preserve_path: expectedRoot,
        reason: "activation_branch_persistence_deferred",
      };
    }
    closeActivationClaimForDeferred(
      wi.id,
      current || claimed,
      stateReason("activation_post_attach_fallback", error?.message || error),
    );
    let sentinelPath = null;
    try {
      sentinelPath = writeSentinel(expectedRoot, {
        pid: process.pid,
        jobId: job.id ?? null,
        wiId: wi.id,
        branchName,
      });
    } catch { /* lifecycle sentinel phase will retry; never rethrow after attach */ }
    let projectCwd = expectedRoot;
    try {
      projectCwd = await configureScope(expectedRoot, worker.projectDir, { signal });
    } catch { /* checkout root remains the safe attached fallback */ }
    return {
      activated: true,
      fallback: false,
      atlas_ready: false,
      wtPath: projectCwd,
      worktreeRoot: expectedRoot,
      branchName,
      sentinelPath,
      reason: "activation_post_attach_fallback",
    };
  }
}
