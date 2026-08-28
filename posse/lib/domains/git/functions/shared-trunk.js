// Shared-trunk publication coordinator.
//
// Git and SQLite cannot share a transaction.  The operation journal therefore
// records intent and the locally-created candidate before the compare-and-swap
// push, and startup/poll reconciliation proves ambiguous publication from the
// fetched remote before allowing another trunk write.

import {
  beginSharedTrunkMergeOperation,
  finalizePublishedSharedTrunkMergeOperation,
  getSharedTrunkMergeOperation,
  listUnresolvedSharedTrunkMergeOperations,
  logEvent,
  notifyQueueStateChanged,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  transitionSharedTrunkMergeOperation,
  updateSharedTrunkRuntimeStatus,
  withMergeLock,
} from "../../queue/functions/index.js";
import {
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import { resolveSharedTrunkConfigRuntime } from "./shared-trunk-config.js";
import {
  fetchSharedTrunkNative,
  ffUpdateSharedTrunkNative,
  getSharedTrunkNativeCapabilities,
  pushSharedTrunkNative,
  resetRejectedSharedTrunkNative,
} from "./shared-trunk-native.js";
import { gitExec } from "./utils.js";
import { isGitCommandFailure } from "../classes/Repo.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { withWorktreeLockAsync } from "./worktree.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";

const SHA_RE = /^[0-9a-f]{40,64}$/iu;

// Test-only seams (set through __testSharedTrunkInternals.setTestOverrides).
// Production always runs with overrides null; the reconcile arms are otherwise
// untestable without a live native binary and warmed pulse.
let testOverrides = null;

function execGit(args, cwd, options) {
  return (testOverrides?.gitExec || gitExec)(args, cwd, options);
}

function nativeResult(envelope) {
  return envelope && Object.prototype.hasOwnProperty.call(envelope, "result")
    ? envelope.result
    : envelope;
}

function nativeUnavailable(envelope) {
  return !envelope || envelope.available !== true;
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function fetchedRemoteSha(result, config, projectDir) {
  const direct = firstString(result, [
    "remoteSha", "remote_sha", "remoteHead", "remote_head", "headOid", "head_oid", "newOid", "new_oid", "oid", "sha",
  ]);
  if (SHA_RE.test(direct)) return direct;
  try {
    const oid = execGit(["rev-parse", `${config.remote}/${config.branch}`], projectDir).trim();
    return SHA_RE.test(oid) ? oid : "";
  } catch {
    return "";
  }
}

function fetchedClaims(result) {
  const claims = result?.fetchedClaims ?? result?.fetched_claims ?? result?.claims;
  return Array.isArray(claims) ? claims : [];
}

function fetchedClaimsTruncated(result) {
  return result?.claimsTruncated === true || result?.claims_truncated === true;
}

async function underMergeLock(fn, ownerSuffix, alreadyHeld = false) {
  if (alreadyHeld) return fn();
  const locked = await withMergeLock(fn, {
    ownerId: `merge-${process.pid}-${ownerSuffix}`,
  });
  if (!locked.acquired) {
    return { ok: false, unavailable: false, skipped: "merge_in_progress", reason: "merge_in_progress" };
  }
  return locked.result;
}

async function runtimeSharedTrunkConfig(projectDir) {
  let capabilityEnvelope = null;
  let capabilityError = null;
  const config = await resolveSharedTrunkConfigRuntime(projectDir, {
    nativeCapabilityPreflight: async ({ projectDir: root }) => {
      try {
        capabilityEnvelope = await getSharedTrunkNativeCapabilities(root);
      } catch (err) {
        capabilityError = err;
      }
      // Preserve the validated config in the typed unavailable result below;
      // the coordinator still fails closed before any mutation.
      return capabilityEnvelope?.available === true ? capabilityEnvelope : true;
    },
  });
  if (!config.enabled) return { config, capabilities: null, unavailable: false };
  if (capabilityError || nativeUnavailable(capabilityEnvelope)) {
    return {
      config,
      capabilities: null,
      unavailable: true,
      reason: capabilityError?.code || capabilityEnvelope?.reason || "native_capability_unavailable",
      error: capabilityError,
    };
  }
  return { config, capabilities: nativeResult(capabilityEnvelope), unavailable: false };
}

/**
 * Ancestry proof for publication recovery. `git merge-base --is-ancestor`
 * exit 1 is the only outcome that proves "not an ancestor"; every other
 * failure (missing object, gate busy, native transport) proves nothing, and
 * the recovery arms must never read it as license to strict-reset a possibly
 * published candidate — so those throw a typed error instead.
 */
function isAncestor(projectDir, ancestor, descendant) {
  if (!SHA_RE.test(String(ancestor || "")) || !SHA_RE.test(String(descendant || ""))) return false;
  try {
    execGit(["merge-base", "--is-ancestor", ancestor, descendant], projectDir);
    return true;
  } catch (err) {
    if (isGitCommandFailure(err) && Number(err?.status) === 1) return false;
    const error = new Error(`Cannot prove whether ${ancestor} is contained in ${descendant}: ${err?.message || err}`);
    error.code = "shared_trunk_ancestry_unresolved";
    error.cause = err;
    throw error;
  }
}

function refSha(projectDir, ref) {
  try {
    const oid = execGit(["rev-parse", ref], projectDir).trim();
    return SHA_RE.test(oid) ? oid : "";
  } catch {
    return "";
  }
}

function candidateRecoveredFromIntent(projectDir, operation, exec = execGit) {
  const resolveRef = (ref) => {
    try {
      const oid = exec(["rev-parse", ref], projectDir).trim();
      return SHA_RE.test(oid) ? oid : "";
    } catch {
      return "";
    }
  };
  const head = resolveRef(operation.targetBranch);
  if (!head || head === operation.baseSha) return "";
  const parent = resolveRef(`${head}^`);
  if (parent !== operation.baseSha) return "";
  try {
    const message = exec(["show", "-s", "--format=%B", head], projectDir).trim();
    const [subject = ""] = message.split(/\r?\n/);
    const trailer = new RegExp(`^Posse-Shared-Trunk-Operation: ${operation.operationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
    return subject === `Squash merge ${operation.sourceBranch} into ${operation.targetBranch}` && trailer.test(message) ? head : "";
  } catch {
    return "";
  }
}

function transition(operation, values) {
  const next = transitionSharedTrunkMergeOperation(operation.operationId, {
    expectedVersion: operation.version,
    ...values,
  });
  if (!next) {
    const error = new Error(`Shared-trunk operation ${operation.operationId} changed concurrently`);
    error.code = "shared_trunk_operation_stale";
    throw error;
  }
  return next;
}

function finalizePublished(operation, values) {
  const next = finalizePublishedSharedTrunkMergeOperation(operation.operationId, {
    expectedVersion: operation.version,
    ...values,
  });
  if (!next) {
    const error = new Error(`Shared-trunk operation ${operation.operationId} changed concurrently`);
    error.code = "shared_trunk_operation_stale";
    throw error;
  }
  return next;
}

function diffPaths(projectDir, oldSha, newSha) {
  if (!oldSha || !newSha || oldSha === newSha) return [];
  try {
    return [...new Set(execGit(["diff", "--name-only", oldSha, newSha], projectDir, { trim: false })
      .split(/\r?\n/)
      .map((value) => value.trim().replace(/\\/g, "/"))
      .filter(Boolean))];
  } catch {
    return [];
  }
}

function divergenceCounts(projectDir, localSha, remoteSha) {
  if (!localSha || !remoteSha) return { aheadCount: 0, behindCount: 0 };
  try {
    const [ahead, behind] = execGit([
      "rev-list", "--left-right", "--count", `${localSha}...${remoteSha}`,
    ], projectDir).trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    return {
      aheadCount: Number.isFinite(ahead) ? ahead : 0,
      behindCount: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return { aheadCount: 0, behindCount: 0 };
  }
}

function sharedTrunkEvent(eventType, message, json = {}, workItemId = null) {
  logEvent({
    work_item_id: workItemId,
    event_type: eventType,
    actor_type: EVENT_ACTORS.SYSTEM,
    message,
    event_json: JSON.stringify(json),
  });
}

function recordSyncStatus(projectDir, config, {
  localSha = undefined,
  remoteSha = undefined,
  success = false,
  diverged = undefined,
  unavailable = false,
} = {}) {
  const havePair = typeof localSha === "string" && localSha
    && typeof remoteSha === "string" && remoteSha;
  const { aheadCount, behindCount } = havePair
    ? divergenceCounts(projectDir, localSha, remoteSha)
    : { aheadCount: 0, behindCount: 0 };
  const timestamp = new Date().toISOString();
  return updateSharedTrunkRuntimeStatus({
    enabled: true,
    remote: config.remote,
    branch: config.branch,
    claims_enabled: config.claimsEnabled === true,
    ...(localSha !== undefined ? { local_sha: localSha || null } : {}),
    ...(remoteSha !== undefined ? { remote_sha: remoteSha || null } : {}),
    ...(havePair ? { ahead_count: aheadCount, behind_count: behindCount } : {}),
    last_attempt_at: timestamp,
    ...(success ? { last_success_at: timestamp } : {}),
    ...(diverged === undefined && !success ? {} : { diverged: diverged === true }),
  }, { increments: unavailable ? { sync_unavailable_count: 1 } : {} });
}

function recordPublicationHealth(config, unresolved = []) {
  const prior = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
  const rows = Array.isArray(unresolved) ? unresolved : [];
  const publicationUnresolved = rows.length > 0;
  const lastErrorCode = rows
    .map((operation) => operation?.lastErrorCode)
    .find(Boolean) || null;
  updateSharedTrunkRuntimeStatus({
    enabled: true,
    remote: config.remote,
    branch: config.branch,
    claims_enabled: config.claimsEnabled === true,
    publication_unresolved: publicationUnresolved,
    unresolved_operation_count: rows.length,
    last_error_code: lastErrorCode,
  });
  if (publicationUnresolved && prior.publication_unresolved !== true) {
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk publication requires reconciliation", {
      publication_unresolved: true,
      unresolved_operation_count: rows.length,
      last_error_code: lastErrorCode,
    });
  }
}

/**
 * Retryable coordinator outcomes. Callers that would otherwise finalize a WI
 * as merge-failed must instead leave it mergeable: these deferrals resolve on
 * a later attempt (lock released, transport restored, journal reconciled,
 * divergence repaired) and say nothing about the WI's own mergeability.
 */
export function isTransientSharedTrunkMergeResult(result) {
  if (!result || result.ok === true || result.sharedTrunk !== true) return false;
  if (result.skipped || result.unavailable || result.publishUnknown || result.resetPending) return true;
  const reason = String(result.reason || "");
  return [
    "merge_in_progress",
    "unresolved_shared_trunk_operation",
    "push_retry_exhausted",
    "publication_ambiguous",
    "ancestry_unresolved",
    "fast_forward_blocked",
    "remote_head_unresolved",
    "local_trunk_diverged",
  ].includes(reason) || reason.startsWith("unexpected_fast_forward_outcome");
}

/** One fanout point for a proven local/remote shared-trunk advancement. */
export function handleSharedTrunkAdvance(projectDir, {
  oldSha,
  newSha,
  targetBranch,
  source = "shared_trunk_sync",
} = {}) {
  if (!newSha) return { advanced: false };
  try { notifyQueueStateChanged({ reason: "shared_trunk_advanced" }); } catch { /* publication remains authoritative */ }
  sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_ADVANCED, `Shared trunk advanced to ${newSha}`, {
    old_sha: oldSha || null,
    new_sha: newSha,
    target_branch: targetBranch,
    source,
  });
  if (!isAtlasV2EmissionEnabled()) {
    updateSharedTrunkRuntimeStatus({ last_signaled_sha: newSha });
    return { advanced: true, atlas: { attempted: false } };
  }
  const paths = diffPaths(projectDir, oldSha, newSha);
  let atlas;
  try {
    atlas = emitAtlasV2MainAdvanced({
      payload: {
        from_sha: oldSha || "",
        to_sha: newSha,
        target_branch: targetBranch,
        paths,
        source,
      },
      jobId: null,
    });
  } catch (err) {
    atlas = { attempted: true, ok: false, error: err?.message || String(err) };
  }
  // Persist the marker only after the transactional ATLAS outbox accepts the
  // exact-OID warm. A crash or temporary outbox failure is retried by the next
  // sync even when Git itself then reports an unchanged branch.
  if (atlas?.ok === true) updateSharedTrunkRuntimeStatus({ last_signaled_sha: newSha });
  return { advanced: true, atlas, paths };
}

async function fetchRemote(projectDir, config, { includeClaims = false } = {}) {
  let envelope;
  try {
    envelope = await fetchSharedTrunkNative({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      includeClaims: includeClaims === true,
    });
  } catch (err) {
    return { ok: false, unavailable: true, operational: true, reason: err?.code || "fetch_failed", error: err };
  }
  if (nativeUnavailable(envelope)) {
    return { ok: false, unavailable: true, reason: envelope?.reason || "native_capability_unavailable" };
  }
  const result = nativeResult(envelope) || {};
  const remoteSha = fetchedRemoteSha(result, config, projectDir);
  if (!remoteSha) return { ok: false, unavailable: false, reason: "remote_head_unresolved", result };
  return {
    ok: true,
    result,
    remoteSha,
    fetchedClaims: fetchedClaims(result),
    claimsTruncated: fetchedClaimsTruncated(result),
  };
}

async function reconcileAlreadyLocked(projectDir, config, { fetched = null, includeClaims = false } = {}) {
  const observed = fetched || await fetchRemote(projectDir, config, { includeClaims });
  if (!observed.ok) return { ...observed, config, operations: [], unresolved: [] };
  const operations = [];
  const unresolved = [];
  for (let operation of listUnresolvedSharedTrunkMergeOperations()) {
    if (operation.targetBranch !== config.branch || operation.remote !== config.remote) {
      unresolved.push(operation);
      continue;
    }
    // One damaged or concurrently-transitioned row must stay an unresolved
    // health condition for this cycle only — never an exception that aborts
    // the whole reconcile, which would turn a recoverable journal entry into
    // a startup crash loop.
    try {
      if (!operation.candidateSha && operation.phase === "intent") {
        const recoveredCandidate = candidateRecoveredFromIntent(projectDir, operation);
        if (recoveredCandidate) {
          operation = transition(operation, { phase: "candidate", candidateSha: recoveredCandidate });
        } else if (refSha(projectDir, operation.targetBranch) === operation.baseSha) {
          operation = transition(operation, { phase: "deferred", lastErrorCode: "intent_recovered" });
          operations.push({ operation, recovered: "deferred" });
          continue;
        }
      }
      if (operation.candidateSha && isAncestor(projectDir, operation.candidateSha, observed.remoteSha)) {
        handleSharedTrunkAdvance(projectDir, {
          oldSha: operation.baseSha,
          newSha: observed.remoteSha,
          targetBranch: operation.targetBranch,
          source: "shared_trunk_recovery",
        });
        operation = finalizePublished(operation, {
          remoteSha: observed.remoteSha,
          recovered: true,
        });
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_RECOVERED, `Recovered published shared-trunk merge for WI#${operation.workItemId}`, {
          operation_id: operation.operationId,
          candidate_sha: operation.candidateSha,
          remote_sha: observed.remoteSha,
        }, operation.workItemId);
        operations.push({ operation, recovered: "published" });
        continue;
      }
      // Any candidate the fetched remote does not contain — a pending
      // gate/rejection reset, an interrupted push, or a publish_unknown probe
      // — is returned to the remote head so a deferred re-merge can proceed.
      // The strict native reset refuses unless the trunk checkout still holds
      // exactly this candidate, so unrelated local state is never destroyed.
      if (operation.candidateSha) {
        const pendingMarker = ["candidate_gate_reset_pending", "rejection_reset_pending"].includes(operation.lastErrorCode)
          ? operation.lastErrorCode
          : null;
        const localHead = refSha(projectDir, operation.targetBranch);
        const reset = localHead === observed.remoteSha
          ? { ok: true, recovered: "already_reset" }
          : await strictResetRejected(projectDir, config, operation, observed.remoteSha);
        if (!reset.ok) {
          operation = transition(operation, {
            phase: "publish_unknown",
            // Keep the pending-reset marker: it carries the retry
            // classification, while the reset failure itself is usually a
            // transient checkout condition retried next cycle.
            lastErrorCode: pendingMarker || reset.reason || "pending_reset_failed",
          });
          unresolved.push(operation);
          operations.push({ operation, recovered: "reset_failed" });
          continue;
        }
        const resolvedCode = pendingMarker === "rejection_reset_pending"
          ? "push_rejected_retry"
          : pendingMarker === "candidate_gate_reset_pending"
            ? "candidate_gate_failed"
            : "publication_not_landed";
        operation = transition(operation, {
          phase: "deferred",
          candidateSha: null,
          baseSha: observed.remoteSha,
          expectedRemoteSha: observed.remoteSha,
          lastErrorCode: resolvedCode,
        });
        operations.push({ operation, recovered: resolvedCode === "push_rejected_retry" ? "retry_deferred" : "deferred" });
        continue;
      }
      unresolved.push(operation);
      operations.push({ operation, recovered: null });
    } catch (err) {
      sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, `Shared-trunk reconciliation failed for WI#${operation.workItemId}: ${err?.message || err}`, {
        operation_id: operation.operationId,
        error_code: err?.code || null,
      }, operation.workItemId);
      unresolved.push(operation);
      operations.push({ operation, recovered: "error" });
    }
  }
  recordPublicationHealth(config, unresolved);
  return {
    ok: unresolved.length === 0,
    reason: unresolved.length ? "unresolved_shared_trunk_operation" : null,
    config,
    remoteSha: observed.remoteSha,
    // The fetch completed even when recovery left rows unresolved, so any
    // claim snapshot it carried is authoritative for the peer-claim mirror.
    fetchCompleted: true,
    fetchedClaims: observed.fetchedClaims,
    claimsTruncated: observed.claimsTruncated === true,
    operations,
    unresolved,
  };
}

/** Startup/poll callable. It never guesses publication from local state alone. */
export async function reconcileSharedTrunkOperations(projectDir, { includeClaims = false } = {}) {
  const runtime = await runtimeSharedTrunkConfig(projectDir);
  if (!runtime.config.enabled) {
    return { ok: true, skipped: "disabled", unavailable: false, config: runtime.config, operations: [], unresolved: [] };
  }
  if (runtime.unavailable) {
    recordSyncStatus(projectDir, runtime.config, { unavailable: true });
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk reconciliation unavailable", {
      remote: runtime.config.remote,
      branch: runtime.config.branch,
      reason: runtime.reason,
    });
    return { ok: false, unavailable: true, reason: runtime.reason, config: runtime.config, operations: [], unresolved: [] };
  }
  return underMergeLock(
    () => withWorktreeLockAsync(projectDir, projectDir, () => reconcileAlreadyLocked(projectDir, runtime.config, { includeClaims })),
    "shared-trunk-reconcile",
  );
}

/** Private seam for callers that already hold both the merge and worktree lock. */
export async function syncSharedTrunkAlreadyLocked(projectDir, {
  config,
  includeClaims = false,
  allowOperationId = null,
} = {}) {
  recordSyncStatus(projectDir, config, { localSha: refSha(projectDir, config.branch) });
  const fetched = await fetchRemote(projectDir, config, { includeClaims });
  if (!fetched.ok) {
    if (fetched.unavailable) {
      recordSyncStatus(projectDir, config, { localSha: refSha(projectDir, config.branch), unavailable: true });
      sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk fetch unavailable", {
        remote: config.remote,
        branch: config.branch,
        reason: fetched.reason,
      });
    }
    return { ...fetched, config, fetchedClaims: fetched.fetchedClaims || [] };
  }
  const reconciliation = await reconcileAlreadyLocked(projectDir, config, { fetched });
  const blocking = reconciliation.unresolved.filter((operation) => operation.operationId !== allowOperationId);
  if (blocking.length) {
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      claimsTruncated: fetched.claimsTruncated === true,
      reason: "unresolved_shared_trunk_operation",
      unresolved: blocking,
    };
  }
  const allowedOperation = allowOperationId
    ? reconciliation.unresolved.find((operation) => operation.operationId === allowOperationId)
    : null;
  if (allowedOperation && ["candidate", "publish_unknown"].includes(allowedOperation.phase)) {
    const localSha = refSha(projectDir, config.branch);
    recordSyncStatus(projectDir, config, { localSha, remoteSha: fetched.remoteSha, success: true });
    return {
      ok: true,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      claimsTruncated: fetched.claimsTruncated === true,
      advanced: false,
      oldSha: localSha,
      newSha: localSha,
      remoteSha: fetched.remoteSha,
      pendingOperation: allowedOperation,
      diverged: false,
      unavailable: false,
    };
  }
  const oldSha = refSha(projectDir, config.branch);
  const lastSignaledSha = firstString(
    readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK),
    ["last_signaled_sha"],
  );
  let ffEnvelope;
  try {
    ffEnvelope = await ffUpdateSharedTrunkNative({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      expectedLocalOid: oldSha,
    });
  } catch (err) {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha, unavailable: true });
    return { ok: false, unavailable: true, operational: true, config, fetchedClaims: fetched.fetchedClaims, reason: err?.code || "ff_update_failed", error: err };
  }
  if (nativeUnavailable(ffEnvelope)) {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha, unavailable: true });
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk fast-forward unavailable", {
      remote: config.remote,
      branch: config.branch,
    });
    return { ok: false, unavailable: true, config, fetchedClaims: fetched.fetchedClaims, reason: ffEnvelope?.reason || "native_capability_unavailable" };
  }
  const ff = nativeResult(ffEnvelope) || {};
  const status = String(ff.status || ff.outcome || "").toLowerCase();
  const diverged = ff.diverged === true || status === "diverged" || status === "non_fast_forward";
  const newSha = firstString(ff, ["newSha", "new_sha", "newOid", "new_oid", "headSha", "head_sha", "oid"]) || refSha(projectDir, config.branch);
  const advanced = ff.advanced === true || status === "advanced" || (!!oldSha && !!newSha && oldSha !== newSha);
  if (diverged) {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha, diverged: true });
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_DIVERGED, `Shared trunk ${config.branch} diverged from ${config.remote}`, {
      local_sha: oldSha || null,
      remote_sha: fetched.remoteSha,
    });
    return { ok: false, config, fetchCompleted: true, fetchedClaims: fetched.fetchedClaims, claimsTruncated: fetched.claimsTruncated === true, diverged: true, advanced: false, oldSha, newSha, reason: "local_trunk_diverged" };
  }
  if (status === "blocked") {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha });
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      claimsTruncated: fetched.claimsTruncated === true,
      advanced: false,
      diverged: false,
      unavailable: false,
      oldSha,
      newSha,
      reason: ff.reason || "fast_forward_blocked",
    };
  }
  if (!(ff.ok === true || ["advanced", "up_to_date", "unchanged", "already_current", "no_change"].includes(status))) {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha });
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      claimsTruncated: fetched.claimsTruncated === true,
      advanced: false,
      diverged: false,
      unavailable: false,
      oldSha,
      newSha,
      reason: status ? `unexpected_fast_forward_outcome:${status}` : "unexpected_fast_forward_outcome",
    };
  }
  if (newSha && lastSignaledSha !== newSha) {
    handleSharedTrunkAdvance(projectDir, {
      oldSha: lastSignaledSha || oldSha,
      newSha,
      targetBranch: config.branch,
    });
  }
  recordSyncStatus(projectDir, config, { localSha: newSha, remoteSha: fetched.remoteSha, success: true });
  return {
    ok: true,
    config,
    fetchCompleted: true,
    fetchedClaims: fetched.fetchedClaims,
    claimsTruncated: fetched.claimsTruncated === true,
    advanced,
    oldSha,
    newSha,
    diverged: false,
    unavailable: false,
  };
}

/** Public locked fetch/reconcile/fast-forward operation used by polling. */
export async function syncSharedTrunkFromOrigin(projectDir, { includeClaims = false } = {}) {
  const runtime = await runtimeSharedTrunkConfig(projectDir);
  if (!runtime.config.enabled) {
    return {
      ok: true,
      config: runtime.config,
      fetchedClaims: [],
      advanced: false,
      diverged: false,
      unavailable: false,
      skipped: "disabled",
    };
  }
  if (runtime.unavailable) {
    recordSyncStatus(projectDir, runtime.config, { unavailable: true });
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk sync unavailable", {
      remote: runtime.config.remote,
      branch: runtime.config.branch,
      reason: runtime.reason,
    });
    return { ok: false, config: runtime.config, fetchedClaims: [], advanced: false, diverged: false, unavailable: true, reason: runtime.reason };
  }
  return underMergeLock(
    () => withWorktreeLockAsync(projectDir, projectDir, () => syncSharedTrunkAlreadyLocked(projectDir, {
      config: runtime.config,
      includeClaims,
    })),
    "shared-trunk-sync",
  );
}

function pushStatus(result) {
  return String(result?.status || result?.outcome || result?.result || "").trim().toLowerCase();
}

function typedPushRejection(result) {
  const status = pushStatus(result);
  return result?.rejected === true
    || result?.nonFastForward === true
    || result?.non_fast_forward === true
    || ["rejected", "rejected_nonff", "non_fast_forward", "stale_expected_remote"].includes(status);
}

async function strictResetRejected(projectDir, config, operation, remoteOid = operation.baseSha) {
  let envelope;
  try {
    envelope = await (testOverrides?.resetRejected || resetRejectedSharedTrunkNative)({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      expectedCandidateOid: operation.candidateSha,
      remoteOid,
    });
  } catch (err) {
    return { ok: false, reason: err?.code || "reset_rejected_candidate_failed", error: err };
  }
  if (nativeUnavailable(envelope)) return { ok: false, reason: envelope?.reason || "native_capability_unavailable" };
  const result = nativeResult(envelope) || {};
  const status = pushStatus(result);
  const ok = result.ok === true || result.reset === true || ["reset", "already_reset", "applied", "ok"].includes(status);
  return ok ? { ok: true, result } : { ok: false, reason: status || "reset_rejected_candidate_failed", result };
}

/**
 * Durable shared-trunk merge coordinator. The caller must provide the existing
 * local squash merge and push-candidate validation implementations.
 */
export async function mergeToSharedTrunkAsync({
  projectDir,
  branch,
  workItemId,
  purpose = "final",
  purposeKey = null,
  mergeLocalCandidate,
  validateCandidate,
  mergeLockAlreadyHeld = false,
} = {}) {
  const runtime = await runtimeSharedTrunkConfig(projectDir);
  if (!runtime.config.enabled) return mergeLocalCandidate({ suppressPostMergeEffects: false, worktreeLockAlreadyHeld: false });
  if (!Number.isSafeInteger(Number(workItemId)) || Number(workItemId) <= 0) {
    return { ok: false, deferred: true, sharedTrunk: true, reason: "work_item_required", message: "Shared-trunk merge requires a work item id" };
  }
  if (runtime.unavailable) {
    recordSyncStatus(projectDir, runtime.config, { unavailable: true });
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk merge unavailable", {
      remote: runtime.config.remote,
      branch: runtime.config.branch,
      reason: runtime.reason,
    }, Number(workItemId));
    return { ok: false, deferred: true, sharedTrunk: true, unavailable: true, reason: runtime.reason, message: "Shared-trunk native capability is unavailable" };
  }
  const config = runtime.config;

  const coordinated = await underMergeLock(() => withWorktreeLockAsync(projectDir, projectDir, async () => {
    const sourceSha = refSha(projectDir, branch);
    if (!sourceSha) return { ok: false, reason: "source_head_unresolved", message: `Cannot resolve ${branch}` };
    const key = String(purposeKey || sourceSha);
    let existing = listUnresolvedSharedTrunkMergeOperations({ workItemId: Number(workItemId) })
      .find((value) => value.purpose === purpose && value.purposeKey === key) || null;
    let sync = await syncSharedTrunkAlreadyLocked(projectDir, {
      config,
      allowOperationId: existing?.operationId || null,
    });
    if (!sync.ok) return { ...sync, message: `Shared trunk is not writable: ${sync.reason || "synchronization failed"}` };
    if (existing) {
      existing = getSharedTrunkMergeOperation(existing.operationId);
      if (existing?.phase === "published") {
        return { ok: true, sharedTrunk: true, published: true, recovered: true, mergeHash: existing.candidateSha, targetBranch: config.branch, operation: existing };
      }
    }
    let baseSha = sync.newSha || refSha(projectDir, config.branch);
    if (!baseSha) return { ok: false, reason: "base_head_unresolved" };
    let operation = existing || beginSharedTrunkMergeOperation({
      workItemId: Number(workItemId),
      purpose,
      purposeKey: key,
      sourceBranch: branch,
      sourceSha,
      targetBranch: config.branch,
      remote: config.remote,
      baseSha,
      expectedRemoteSha: baseSha,
    });
    // begin() can return a previously deferred row through its durable unique
    // key even though deferred rows are intentionally absent from the
    // unresolved query above. Rebase that resumable intent onto the just-
    // synchronized head before creating a new candidate/trailer, and grant a
    // resumed deferral the full retry budget — the persisted attempt would
    // otherwise make push_retry_exhausted permanent for this branch tip.
    if (["intent", "deferred"].includes(operation.phase)
      && !operation.candidateSha
      && (operation.baseSha !== baseSha || operation.attempt > 0)) {
      operation = transition(operation, {
        phase: operation.phase,
        baseSha,
        expectedRemoteSha: baseSha,
        attempt: 0,
      });
    }
    if (operation.phase === "published") {
      return {
        ok: true,
        sharedTrunk: true,
        published: true,
        alreadyPublished: true,
        mergeHash: operation.candidateSha,
        targetBranch: config.branch,
        operation,
      };
    }

    const retries = Math.max(0, Number(config.pushRetryMax) || 0);
    for (let attempt = operation.attempt; attempt <= retries; attempt += 1) {
      if (operation.phase === "candidate" || operation.phase === "publish_unknown") {
        const observed = await fetchRemote(projectDir, config);
        if (!observed.ok) return { ...observed, operation, message: "Could not reconcile prior shared-trunk publication" };
        let landed = false;
        if (operation.candidateSha) {
          try {
            landed = isAncestor(projectDir, operation.candidateSha, observed.remoteSha);
          } catch (err) {
            // Ancestry could not be proven either way. Publication stays
            // ambiguous — never guess; the journal row retries next attempt.
            return {
              ok: false,
              unavailable: true,
              operational: true,
              publishUnknown: operation.phase === "publish_unknown",
              reason: "ancestry_unresolved",
              error: err,
              operation,
              message: "Could not prove prior shared-trunk publication either way",
            };
          }
        }
        if (landed) {
          handleSharedTrunkAdvance(projectDir, {
            oldSha: operation.baseSha,
            newSha: observed.remoteSha,
            targetBranch: config.branch,
            source: "shared_trunk_recovery",
          });
          operation = finalizePublished(operation, {
            remoteSha: observed.remoteSha,
            recovered: true,
          });
          sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_RECOVERED, `Recovered shared-trunk publication for WI#${workItemId}`, {
            operation_id: operation.operationId,
            candidate_sha: operation.candidateSha,
            remote_sha: observed.remoteSha,
          }, Number(workItemId));
          recordPublicationHealth(config, []);
          return { ok: true, sharedTrunk: true, published: true, recovered: true, mergeHash: operation.candidateSha, targetBranch: config.branch, operation };
        }
        if (operation.phase === "publish_unknown") {
          return { ok: false, publishUnknown: true, reason: "publication_ambiguous", operation, message: "Previous shared-trunk publication remains ambiguous" };
        }
      }

      if (operation.phase !== "candidate") {
        const local = await mergeLocalCandidate({
          suppressPostMergeEffects: true,
          worktreeLockAlreadyHeld: true,
          operationId: operation.operationId,
        });
        if (!local?.ok) {
          operation = transition(operation, {
            phase: "deferred",
            lastErrorCode: local?.deterministicConflict ? "deterministic_conflict" : (local?.reason || "merge_failed"),
          });
          return { ...local, deferred: true, operation };
        }
        const candidateSha = local.mergeHash || refSha(projectDir, config.branch);
        if (!candidateSha) return { ok: false, reason: "candidate_head_unresolved", operation };
        operation = transition(operation, { phase: "candidate", candidateSha, attempt, lastErrorCode: null });
      }

      const validation = await validateCandidate({ pushBranch: config.branch, effectiveRemote: config.remote });
      if (!validation?.ok) {
        const capturedCandidate = operation.candidateSha;
        operation = transition(operation, {
          phase: "candidate",
          lastErrorCode: "candidate_gate_reset_pending",
        });
        const gateFetch = await fetchRemote(projectDir, config);
        if (!gateFetch.ok) {
          recordPublicationHealth(config, [operation]);
          return {
            ...validation,
            ok: false,
            resetPending: true,
            reason: gateFetch.reason || "candidate_gate_reset_fetch_failed",
            operation,
          };
        }
        operation = transition(operation, {
          phase: "candidate",
          baseSha: gateFetch.remoteSha,
          expectedRemoteSha: gateFetch.remoteSha,
          lastErrorCode: "candidate_gate_reset_pending",
        });
        const reset = await strictResetRejected(projectDir, config, {
          ...operation,
          candidateSha: capturedCandidate,
        }, gateFetch.remoteSha);
        operation = transition(operation, reset.ok ? {
          phase: "deferred",
          candidateSha: null,
          lastErrorCode: validation?.reason || "candidate_gate_failed",
        } : {
          phase: "publish_unknown",
          candidateSha: capturedCandidate,
          // Keep the pending-reset marker so reconciliation classifies the
          // retry correctly; reset failures are usually transient checkout
          // conditions and this row must stay recoverable.
          lastErrorCode: "candidate_gate_reset_pending",
        });
        if (!reset.ok) recordPublicationHealth(config, [operation]);
        else recordPublicationHealth(config, []);
        return { ...validation, ok: false, deferred: reset.ok, publishUnknown: !reset.ok, reset, operation };
      }

      let pushedEnvelope;
      try {
        pushedEnvelope = await pushSharedTrunkNative({
          cwd: projectDir,
          remote: config.remote,
          branch: config.branch,
          expectedRemoteOid: operation.expectedRemoteSha,
          newOid: operation.candidateSha,
        });
      } catch (err) {
        operation = transition(operation, { phase: "publish_unknown", lastErrorCode: err?.code || "push_operational_failure" });
        recordPublicationHealth(config, [operation]);
        return { ok: false, publishUnknown: true, reason: "publication_ambiguous", message: err?.message || String(err), operation };
      }
      if (nativeUnavailable(pushedEnvelope)) {
        operation = transition(operation, { phase: "publish_unknown", lastErrorCode: pushedEnvelope?.reason || "native_capability_unavailable" });
        recordPublicationHealth(config, [operation]);
        return { ok: false, unavailable: true, publishUnknown: true, reason: pushedEnvelope?.reason || "native_capability_unavailable", operation };
      }
      const pushed = nativeResult(pushedEnvelope) || {};
      if (typedPushRejection(pushed)) {
        updateSharedTrunkRuntimeStatus({}, { increments: { push_rejection_count: 1 } });
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_REJECTED, `Shared-trunk push rejected for WI#${workItemId}`, {
          operation_id: operation.operationId,
          attempt,
        }, Number(workItemId));
        const rejectedFetch = await fetchRemote(projectDir, config);
        if (!rejectedFetch.ok) {
          operation = transition(operation, { phase: "publish_unknown", lastErrorCode: rejectedFetch.reason || "rejection_fetch_failed" });
          recordPublicationHealth(config, [operation]);
          return { ...rejectedFetch, ok: false, publishUnknown: true, operation };
        }
        const capturedCandidate = operation.candidateSha;
        operation = transition(operation, {
          phase: "candidate",
          baseSha: rejectedFetch.remoteSha,
          expectedRemoteSha: rejectedFetch.remoteSha,
          attempt: attempt + 1,
          lastErrorCode: "rejection_reset_pending",
        });
        const reset = await strictResetRejected(projectDir, config, {
          ...operation,
          candidateSha: capturedCandidate,
        }, rejectedFetch.remoteSha);
        if (!reset.ok) {
          operation = transition(operation, {
            phase: "publish_unknown",
            candidateSha: capturedCandidate,
            // Preserve the recoverable marker (see the gate-reset branch).
            lastErrorCode: "rejection_reset_pending",
          });
          recordPublicationHealth(config, [operation]);
          return { ok: false, publishUnknown: true, reason: "candidate_reset_failed", reset, operation };
        }
        operation = transition(operation, {
          phase: "deferred",
          candidateSha: null,
          lastErrorCode: "push_rejected_retry",
        });
        recordPublicationHealth(config, []);
        if (attempt >= retries) {
          operation = transition(operation, { phase: "deferred", lastErrorCode: "push_retry_exhausted" });
          recordPublicationHealth(config, []);
          return { ok: false, deferred: true, reason: "push_retry_exhausted", operation };
        }
        sync = await syncSharedTrunkAlreadyLocked(projectDir, { config, allowOperationId: operation.operationId });
        if (!sync.ok) return { ...sync, operation };
        baseSha = sync.newSha || refSha(projectDir, config.branch);
        operation = transition(operation, {
          phase: "deferred",
          candidateSha: null,
          baseSha,
          expectedRemoteSha: baseSha,
          attempt: operation.attempt,
          lastErrorCode: "push_rejected_retry",
        });
        updateSharedTrunkRuntimeStatus({}, {
          increments: { push_retry_count: 1 },
        });
        const priorDepth = Number(readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK)?.max_push_retry_depth) || 0;
        updateSharedTrunkRuntimeStatus({ max_push_retry_depth: Math.max(priorDepth, attempt + 1) });
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_RETRIED, `Retrying shared-trunk push for WI#${workItemId}`, {
          operation_id: operation.operationId,
          attempt: attempt + 1,
        }, Number(workItemId));
        continue;
      }
      const status = pushStatus(pushed);
      if (!(pushed.ok === true || pushed.published === true || ["pushed", "published", "already_published", "applied", "ok"].includes(status))) {
        operation = transition(operation, { phase: "publish_unknown", lastErrorCode: status || "push_outcome_unknown" });
        recordPublicationHealth(config, [operation]);
        return { ok: false, publishUnknown: true, reason: "publication_ambiguous", operation };
      }

      // Fan out before closing the journal. If the process dies between these
      // steps, startup proves publication and repeats this idempotent/coalesced
      // wake instead of losing the ATLAS warm permanently.
      handleSharedTrunkAdvance(projectDir, {
        oldSha: operation.baseSha,
        newSha: operation.candidateSha,
        targetBranch: config.branch,
        source: purpose === "iterative" ? "iterative_merge" : "merge",
      });
      operation = finalizePublished(operation, {
        remoteSha: operation.candidateSha,
        recovered: false,
      });
      recordSyncStatus(projectDir, config, {
        localSha: operation.candidateSha,
        remoteSha: operation.candidateSha,
        success: true,
      });
      recordPublicationHealth(config, []);
      return { ok: true, sharedTrunk: true, published: true, mergeHash: operation.candidateSha, targetBranch: config.branch, operation };
    }
    return { ok: false, reason: "push_retry_exhausted", operation };
  }), "shared-trunk-merge", mergeLockAlreadyHeld === true);
  return coordinated && typeof coordinated === "object"
    ? { ...coordinated, ...(coordinated.ok ? {} : { deferred: true }), sharedTrunk: true }
    : coordinated;
}

export const __testSharedTrunkInternals = Object.freeze({
  candidateRecoveredFromIntent,
  isAncestor,
  pushStatus,
  typedPushRejection,
  reconcileAlreadyLocked,
  setTestOverrides(overrides) {
    assertTestContext("__testSharedTrunkInternals.setTestOverrides");
    testOverrides = overrides && typeof overrides === "object" ? overrides : null;
  },
});
