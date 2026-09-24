// Shared-trunk publication coordinator.
//
// Git and SQLite cannot share a transaction.  The operation journal therefore
// records intent and the locally-created candidate before the compare-and-swap
// push, and startup/poll reconciliation proves ambiguous publication from the
// fetched remote before allowing another trunk write.

import {
  TEAM_ATTENTION_FAILURE_REASONS,
  TEAM_FATAL_FAILURE_REASONS,
  TEAM_PARKED_CANDIDATE_REASONS,
  TEAM_TRANSIENT_FAILURE_REASONS,
} from "../../../catalog/team.js";
import {
  abandonSharedTrunkMergeOperation,
  beginSharedTrunkMergeOperation,
  createJob,
  finalizePublishedSharedTrunkMergeOperation,
  getSharedTrunkMergeOperation,
  listSharedTrunkMergeOperations,
  listUnresolvedSharedTrunkMergeOperations,
  logEvent,
  notifyQueueStateChanged,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  transitionSharedTrunkMergeOperation,
  updateSharedTrunkRuntimeStatus,
  withMergeLock,
} from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import { resolveSharedTrunkConfigRuntime, SharedTrunkConfigError } from "./shared-trunk-config.js";
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
import {
  gitHubCliAuthRemediation,
  isGitPushAuthenticationFailure,
} from "./git-push-auth.js";

const SHA_RE = /^[0-9a-f]{40,64}$/iu;
const MAX_PROVENANCE_COMMITS = 256;

// Test-only seams (set through __testSharedTrunkInternals.setTestOverrides).
// Production always runs with overrides null; the reconcile arms are otherwise
// untestable without a live native binary and warmed pulse.
let testOverrides = null;

function execGit(args, cwd, options) {
  return (testOverrides?.gitExec || gitExec)(args, cwd, options);
}

function sharedTrunkCapabilities(projectDir) {
  return (testOverrides?.capabilities || getSharedTrunkNativeCapabilities)(projectDir, { timeoutMs: 30_000 });
}

/** Native options for one trunk call. In an approval-managed Session every
 * trunk mutation is minted under the work item's verified grant; outside one
 * the options stay empty and the call behaves exactly as before. */
function nativeTrunkOptions(workItemContext, timeoutMs = 30_000, signal = null) {
  return { ...(workItemContext ? { workItemContext } : {}), timeoutMs, ...(signal ? { signal } : {}) };
}

function sharedTrunkFetch(args, workItemContext = null, signal = null) {
  return (testOverrides?.fetch || fetchSharedTrunkNative)(args, nativeTrunkOptions(workItemContext, 30_000, signal));
}

function sharedTrunkFastForward(args, workItemContext = null, signal = null) {
  return (testOverrides?.fastForward || ffUpdateSharedTrunkNative)(args, nativeTrunkOptions(workItemContext, 390_000, signal));
}

function sharedTrunkPush(args, workItemContext = null) {
  return (testOverrides?.push || pushSharedTrunkNative)(args, nativeTrunkOptions(workItemContext, 180_000));
}

/** The verified grant pins for a work item's trunk publication, or null when
 * the Session is not approval-managed. The native trunk methods are mutations
 * on both sides of the boundary (posse-bin classifies git.trunk.* as Mutate,
 * and Remote refuses a session-bound mutate pulse without a grant), so without
 * these pins every fetch in an opted-in Session fails before the publication
 * gate is reached. A grant that cannot be resolved is a Team deferral, not a
 * thrown native error: the completed work is kept and the merge re-attempts
 * once a valid grant exists. */
async function teamMergeContext(args) {
  if (testOverrides?.teamMergeContext) return testOverrides.teamMergeContext(args);
  const { getLivePairingState } = await import("../../pairing/functions/state.js");
  if (getLivePairingState()?.submission_approval_enabled !== 1) return { ok: true, workItemContext: null };
  const { getVerifiedTeamGrantForWorkItem } = await import("../../pairing/functions/team-submissions.js");
  const verified = await getVerifiedTeamGrantForWorkItem(args.workItemId, { projectDir: args.projectDir, fresh: true });
  if (!verified?.ok) {
    return { ok: false, team: true, reason: verified?.reason || "team_grant_unavailable", message: verified?.message };
  }
  return { ok: true, workItemContext: verified.workItemContext };
}

async function teamPublicationGate(args) {
  if (testOverrides?.teamGate) return testOverrides.teamGate(args);
  const { gateTeamCandidateForPublication } = await import("../../pairing/functions/team-submissions.js");
  return gateTeamCandidateForPublication(args);
}

async function teamPublishedProof(args) {
  if (testOverrides?.teamPublishedProof) return testOverrides.teamPublishedProof(args);
  const { verifyTeamPublishedCandidate } = await import("../../pairing/functions/team-submissions.js");
  return verifyTeamPublishedCandidate(args);
}

async function sessionProvenanceContext() {
  try {
    const [{ getLivePairingState }, { readPairingPeerSnapshot }] = await Promise.all([
      import("../../pairing/functions/state.js"),
      import("../../pairing/functions/work-items.js"),
    ]);
    const state = getLivePairingState();
    if (!state?.baseline_oid || state.phase !== "active") return null;
    const snapshot = readPairingPeerSnapshot();
    return {
      baselineOid: state.baseline_oid,
      gitIdentities: (snapshot?.peers || [])
        .flatMap((peer) => Array.isArray(peer.git_identities) ? peer.git_identities : []),
    };
  } catch {
    return null;
  }
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

function fetchedClaimsPagination(result) {
  const camel = Object.prototype.hasOwnProperty.call(result || {}, "claimsNextCursor");
  const snake = Object.prototype.hasOwnProperty.call(result || {}, "claims_next_cursor");
  if (!camel && !snake) return { claimsPaginationSupported: false, claimsNextCursor: null };
  const raw = camel ? result.claimsNextCursor : result.claims_next_cursor;
  if (raw == null) return { claimsPaginationSupported: true, claimsNextCursor: null };
  const cursor = String(raw).trim();
  if (!/^[0-9a-f]{64}$/u.test(cursor)) {
    return { claimsPaginationSupported: false, claimsNextCursor: null };
  }
  return { claimsPaginationSupported: true, claimsNextCursor: cursor };
}

function claimFetchMetadata(result) {
  return {
    claimsTruncated: result?.claimsTruncated === true,
    claimsPaginationSupported: result?.claimsPaginationSupported === true,
    claimsNextCursor: result?.claimsNextCursor || null,
  };
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
  let config;
  try {
    config = await resolveSharedTrunkConfigRuntime(projectDir, {
      remoteDefaultBranchResolver: testOverrides?.resolveRemoteDefaultBranch || null,
      targetBranchResolver: testOverrides?.resolveTargetBranch || null,
      nativeCapabilityPreflight: async ({ projectDir: root }) => {
        try {
          capabilityEnvelope = await sharedTrunkCapabilities(root);
        } catch (err) {
          capabilityError = err;
        }
        // Preserve the validated config in the typed unavailable result below;
        // the coordinator still fails closed before any mutation.
        return capabilityEnvelope?.available === true ? capabilityEnvelope : true;
      },
    });
  } catch (err) {
    if (!(err instanceof SharedTrunkConfigError)) throw err;
    return {
      config: { enabled: true, remote: null, branch: null, claimsEnabled: false },
      capabilities: null,
      unavailable: true,
      reason: err.code,
      error: err,
    };
  }
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
function commitExists(projectDir, sha) {
  if (!SHA_RE.test(String(sha || ""))) return false;
  try {
    execGit(["cat-file", "-e", `${sha}^{commit}`], projectDir);
    return true;
  } catch {
    return false;
  }
}

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
    const oid = String(
      testOverrides?.resolveRefSha
        ? testOverrides.resolveRefSha(projectDir, ref)
        : execGit(["rev-parse", ref], projectDir),
    ).trim();
    return SHA_RE.test(oid) ? oid : "";
  } catch {
    return "";
  }
}

function restoreParkedCandidate(projectDir, operation) {
  const branchRef = `refs/heads/${operation.targetBranch}`;
  const actualBranch = (() => {
    try { return execGit(["symbolic-ref", "--quiet", "--short", "HEAD"], projectDir).trim(); }
    catch { return ""; }
  })();
  if (actualBranch !== operation.targetBranch) {
    return { ok: false, reason: "wrong_checkout" };
  }
  if (refSha(projectDir, branchRef) !== operation.baseSha) {
    return { ok: false, reason: "local_changed" };
  }
  const dirty = execGit(["status", "--porcelain", "--untracked-files=all"], projectDir, { trim: false })
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const statusPath = line.slice(3).replace(/\\/gu, "/").replace(/^"|"$/gu, "");
      return statusPath !== ".posse"
        && !statusPath.startsWith(".posse/")
        && statusPath !== ".posse-worktrees"
        && !statusPath.startsWith(".posse-worktrees/");
    })
    .join("\n")
    .trim();
  if (dirty) return { ok: false, reason: "dirty" };
  try {
    // The ref update is the CAS. Reset then materializes the already-validated
    // tree/index; moving only the ref would leave the checked-out branch dirty.
    execGit(["update-ref", branchRef, operation.candidateSha, operation.baseSha], projectDir);
    execGit(["reset", "--hard", operation.candidateSha], projectDir);
    if (refSha(projectDir, "HEAD") !== operation.candidateSha) {
      throw new Error("parked candidate checkout verification failed");
    }
    return { ok: true };
  } catch (error) {
    // Best-effort rollback is itself compare-and-swap guarded; never overwrite
    // a concurrent ref move while reporting the restore failure.
    try {
      execGit(["update-ref", branchRef, operation.baseSha, operation.candidateSha], projectDir);
      execGit(["reset", "--hard", operation.baseSha], projectDir);
    } catch { /* the journal remains a recoverable candidate */ }
    return { ok: false, reason: "parked_candidate_restore_failed", error };
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

export function verifySharedTrunkProvenance(projectDir, {
  baselineOid,
  newSha,
  gitIdentities = [],
  exec = execGit,
} = {}) {
  if (!SHA_RE.test(String(baselineOid || "")) || !SHA_RE.test(String(newSha || ""))) {
    return { ok: false, reason: "provenance_range_invalid", commits: [] };
  }
  try {
    exec(["merge-base", "--is-ancestor", baselineOid, newSha], projectDir);
  } catch {
    return { ok: false, reason: "provenance_baseline_not_ancestor", commits: [] };
  }
  const rawLog = exec([
    "log", `--max-count=${MAX_PROVENANCE_COMMITS + 1}`,
    "--format=%H%x00%ce%x00%B%x00", `${baselineOid}..${newSha}`,
  ], projectDir, { trim: false });
  const fields = String(rawLog || "").split("\0");
  while (fields.length > 0 && !fields.at(-1).trim()) fields.pop();
  const commits = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    commits.push({
      commit: fields[index].trim(),
      email: fields[index + 1].trim().toLowerCase(),
      message: fields[index + 2],
    });
  }
  if (commits.length > MAX_PROVENANCE_COMMITS) {
    return { ok: false, reason: "provenance_range_too_large", commits: [] };
  }
  const identities = new Set(
    gitIdentities.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean),
  );
  try {
    const localEmail = exec(["config", "--get", "user.email"], projectDir).trim().toLowerCase();
    if (localEmail) identities.add(localEmail);
  } catch { /* identity is optional */ }
  const unknown = [];
  for (const commit of commits) {
    if (!SHA_RE.test(commit.commit)) {
      return { ok: false, reason: "provenance_range_invalid", commits: [] };
    }
    const operationId = commit.message.match(/^Posse-Shared-Trunk-Operation:\s*(\S+)\s*$/mu)?.[1] || null;
    let journaled = false;
    if (operationId) {
      try {
        const operation = getSharedTrunkMergeOperation(operationId);
        journaled = operation?.candidateSha === commit.commit;
      } catch { /* an unverifiable trailer is not provenance */ }
    }
    if (journaled || identities.has(commit.email)) continue;
    unknown.push({ commit: commit.commit, email: commit.email || null });
  }
  return unknown.length > 0
    ? { ok: false, reason: "unknown_commit_provenance", commits: unknown }
    : { ok: true, reason: null, commits: [] };
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
  blockedReason = undefined,
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
    ...(blockedReason !== undefined ? { blocked_reason: blockedReason || null } : {}),
    ...(success ? { blocked_reason: null } : {}),
  }, { increments: unavailable ? { sync_unavailable_count: 1 } : {} });
}

function recordPublicationHealth(config, unresolved = [], stale = []) {
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
    stale_operation_count: stale.length,
    stale_operation_ids: stale.slice(0, 16).map((operation) => operation.operationId),
  });
  if (publicationUnresolved && prior.publication_unresolved !== true) {
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Shared-trunk publication requires reconciliation", {
      publication_unresolved: true,
      unresolved_operation_count: rows.length,
      last_error_code: lastErrorCode,
    });
  }
  if (stale.length > 0 && Number(prior.stale_operation_count || 0) !== stale.length) {
    sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE, "Stale shared-trunk operations need operator review", {
      stale_operation_count: stale.length,
      operation_ids: stale.slice(0, 16).map((operation) => operation.operationId),
      remediation: "Run `posse shared-trunk ops` and inspect old branch/remote rows.",
    });
  }
}

/**
 * Retryable coordinator outcomes. Callers that would otherwise finalize a WI
 * as merge-failed must instead leave it mergeable: these deferrals resolve on
 * a later attempt (lock released, transport restored, journal reconciled,
 * divergence repaired) and say nothing about the WI's own mergeability.
 */
/** A Team publication failure that is still deferrable -- the work item keeps
 * its completed passes -- but must be reported as its own blocked state rather
 * than an ordinary "shared trunk busy" retry. It survived the deterministic
 * repair, so the signed material itself does not verify. */
// The candidate already appears on the trunk but its Team publication could
// not be proven this attempt. No proof reason means the work is bad: carry
// the same ambiguity flags the ancestry path uses so the journal row retries
// rather than finalizing a work item whose code is already published.
function teamProofUnavailable(proof, operation) {
  return {
    ok: false,
    team: true,
    unavailable: true,
    operational: true,
    publishUnknown: operation.phase === "publish_unknown",
    reason: proof?.reason || "team_publication_unverified",
    ...(proof?.message ? { message: proof.message } : {}),
    operation,
  };
}

function isParkedCandidateReason(reason) {
  return TEAM_PARKED_CANDIDATE_REASONS.includes(reason)
    || reason === "shared_trunk_push_refused";
}

function ensureUnprovablePublicationGate(operation, proof) {
  const existing = getDb().prepare(`
    SELECT id FROM jobs
    WHERE job_type = 'human_input'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.subtype') = 'shared_trunk_publication_unprovable'
          AND json_extract(payload_json, '$.operation_id') = ?
        ELSE 0 END
    ORDER BY id DESC LIMIT 1
  `).get(operation.operationId);
  if (existing) return existing.id;
  return createJob({
    work_item_id: operation.workItemId,
    job_type: "human_input",
    title: `Review unprovable shared-trunk publication for WI#${operation.workItemId}`,
    priority: "urgent",
    max_attempts: 1,
    payload_json: {
      subtype: "shared_trunk_publication_unprovable",
      review_type: "shared_trunk_publication_unprovable",
      question_kind: "shared_trunk_publication_unprovable",
      questions: ["The candidate is present on the shared trunk, but its required Team publication proof failed permanently. Inspect the operation before continuing."],
      choices: ["acknowledge"],
      operation_id: operation.operationId,
      candidate_oid: operation.candidateSha,
      remote_oid: operation.publishedSha,
      proof_reason: proof?.reason || null,
    },
  }).id;
}

function abandonUnprovablePublication(operation, publishedSha, proof) {
  const gateJobId = ensureUnprovablePublicationGate({
    ...operation,
    publishedSha,
  }, proof);
  const abandoned = abandonSharedTrunkMergeOperation(operation.operationId, {
    expectedVersion: operation.version,
    lastErrorCode: "team_publication_unprovable",
  });
  if (!abandoned) {
    const error = new Error(`Shared-trunk operation ${operation.operationId} changed concurrently`);
    error.code = "shared_trunk_operation_stale";
    throw error;
  }
  return { operation: abandoned, gateJobId };
}

export function sharedTrunkTeamResultNeedsAttention(result) {
  if (!result || result.ok === true) return false;
  return TEAM_ATTENTION_FAILURE_REASONS.includes(String(result.reason || ""))
    || result.reason === "shared_trunk_push_refused";
}

export function isTransientSharedTrunkMergeResult(result) {
  if (!result || result.ok === true || result.sharedTrunk !== true) return false;
  if (result.skipped || result.unavailable || result.publishUnknown || result.resetPending) return true;
  const reason = String(result.reason || "");
  // Team gate and proof results defer by shape: only a reason registered as
  // fatal means the candidate is wrong. A parked github-pr submission, a
  // lagging policy view, or an unreachable Remote must not discard passes.
  if (result.team === true) return !TEAM_FATAL_FAILURE_REASONS.includes(reason);
  return [
    "merge_in_progress",
    "unresolved_shared_trunk_operation",
    "push_retry_exhausted",
    "publication_ambiguous",
    "ancestry_unresolved",
    "fast_forward_blocked",
    "remote_head_unresolved",
    "local_trunk_diverged",
    "local_candidate_changed",
    "parked_candidate_restore_blocked",
    "merge_operational_failure",
    "candidate_validation_unavailable",
    "shared_trunk_push_refused",
    // Team publication deferrals are registered in the catalog. None of them
    // means the work is bad, only that publication is not authorized yet, so
    // all of them defer rather than finalizing the work item and forcing the
    // whole job to run again. The ones needing a human are flagged separately
    // by sharedTrunkTeamResultNeedsAttention.
    ...TEAM_TRANSIENT_FAILURE_REASONS,
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

async function fetchRemote(projectDir, config, { includeClaims = false, claimAfter = null, workItemContext = null, signal = null } = {}) {
  let envelope;
  try {
    envelope = await sharedTrunkFetch({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      includeClaims: includeClaims === true,
      ...(includeClaims === true && claimAfter ? { claimAfter } : {}),
    }, workItemContext, signal);
  } catch (err) {
    const auth = sharedTrunkAuthRemediation(projectDir, config, err);
    if (auth) return { ok: false, unavailable: true, operational: true, ...auth, error: err };
    return { ok: false, unavailable: true, operational: true, reason: err?.code || "fetch_failed", error: err };
  }
  if (nativeUnavailable(envelope)) {
    return { ok: false, unavailable: true, reason: envelope?.reason || "native_capability_unavailable" };
  }
  const result = nativeResult(envelope) || {};
  const auth = sharedTrunkAuthRemediation(projectDir, config, result);
  if (auth) return { ok: false, unavailable: true, operational: true, ...auth, result };
  const remoteSha = fetchedRemoteSha(result, config, projectDir);
  if (!remoteSha) return { ok: false, unavailable: false, reason: "remote_head_unresolved", result };
  return {
    ok: true,
    result,
    remoteSha,
    fetchedClaims: fetchedClaims(result),
    claimsTruncated: fetchedClaimsTruncated(result),
    ...fetchedClaimsPagination(result),
  };
}

async function reconcileAlreadyLocked(projectDir, config, { fetched = null, includeClaims = false, claimAfter = null } = {}) {
  const observed = fetched || await fetchRemote(projectDir, config, { includeClaims, claimAfter });
  if (!observed.ok) return { ...observed, config, operations: [], unresolved: [] };
  const operations = [];
  const unresolved = [];
  for (let operation of listUnresolvedSharedTrunkMergeOperations()) {
    if (operation.targetBranch !== config.branch || operation.remote !== config.remote) {
      operations.push({ operation, recovered: "stale_configuration" });
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
        } else {
          const localHead = refSha(projectDir, operation.targetBranch);
          if (localHead && isAncestor(projectDir, localHead, observed.remoteSha)) {
            operation = transition(operation, {
              phase: "deferred",
              baseSha: observed.remoteSha,
              expectedRemoteSha: observed.remoteSha,
              lastErrorCode: "intent_remote_advanced",
            });
            operations.push({ operation, recovered: "deferred" });
            continue;
          }
        }
      }
      if (operation.candidateSha && isAncestor(projectDir, operation.candidateSha, observed.remoteSha)) {
        const proof = await teamPublishedProof({ projectDir, operation, observedOid: observed.remoteSha });
        if (!proof?.ok) {
          if (TEAM_FATAL_FAILURE_REASONS.includes(String(proof?.reason || ""))
            || [
              "team_approved_submission_missing",
              "team_approval_receipt_stale",
              "github_merge_parents_mismatch",
              "team_candidate_not_on_trunk",
            ].includes(String(proof?.reason || ""))) {
            const abandoned = abandonUnprovablePublication(operation, observed.remoteSha, proof);
            operation = abandoned.operation;
            const gateJobId = abandoned.gateJobId;
            operations.push({ operation, recovered: "abandoned_unprovable", reason: proof.reason, gateJobId });
            continue;
          }
          unresolved.push(operation);
          operations.push({ operation, recovered: "team_publication_unverified", reason: proof?.reason });
          continue;
        }
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
        const pendingMarker = ["candidate_gate_reset_pending", "rejection_reset_pending", "remote_advance_reset_pending"].includes(operation.lastErrorCode)
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
        // A Team-parked candidate was submitted by OID and is awaiting the
        // originator's decision or the host's provider merge. Free the trunk
        // checkout for other operations, but keep the candidate identity so
        // the next attempt pushes the approved OID rather than re-merging a
        // new one that would need a new approval.
        if (isParkedCandidateReason(operation.lastErrorCode)
          && operation.baseSha === observed.remoteSha) {
          operation = transition(operation, {
            phase: "deferred",
            candidateSha: operation.candidateSha,
            lastErrorCode: operation.lastErrorCode,
          });
          operations.push({ operation, recovered: "team_parked" });
          continue;
        }
        const resolvedCode = pendingMarker === "rejection_reset_pending"
          ? "push_rejected_retry"
          : pendingMarker === "candidate_gate_reset_pending"
            ? "candidate_gate_failed"
            : pendingMarker === "remote_advance_reset_pending"
              ? "remote_advanced_before_push"
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
  const stale = operations
    .filter((entry) => entry.recovered === "stale_configuration")
    .map((entry) => entry.operation);
  recordPublicationHealth(config, unresolved, stale);
  return {
    ok: unresolved.length === 0,
    reason: unresolved.length ? "unresolved_shared_trunk_operation" : null,
    config,
    remoteSha: observed.remoteSha,
    // The fetch completed even when recovery left rows unresolved, so any
    // claim snapshot it carried is authoritative for the peer-claim mirror.
    fetchCompleted: true,
    fetchedClaims: observed.fetchedClaims,
    ...claimFetchMetadata(observed),
    operations,
    unresolved,
  };
}

/** Startup/poll callable. It never guesses publication from local state alone. */
export async function reconcileSharedTrunkOperations(projectDir, { includeClaims = false, claimAfter = null } = {}) {
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
    () => withWorktreeLockAsync(projectDir, projectDir, () => reconcileAlreadyLocked(projectDir, runtime.config, { includeClaims, claimAfter })),
    "shared-trunk-reconcile",
  );
}

export async function abandonSharedTrunkOperation(projectDir, operationId) {
  const original = getSharedTrunkMergeOperation(operationId);
  if (!original) return { ok: false, reason: "operation_not_found" };
  if (["published", "abandoned"].includes(original.phase)) {
    return { ok: false, reason: `operation_already_${original.phase}`, operation: original };
  }
  return underMergeLock(() => withWorktreeLockAsync(projectDir, projectDir, async () => {
    let operation = getSharedTrunkMergeOperation(operationId);
    if (!operation || ["published", "abandoned"].includes(operation.phase)) {
      return { ok: false, reason: operation ? `operation_already_${operation.phase}` : "operation_not_found", operation };
    }
    let recoverableCandidate = operation.candidateSha;
    if (!recoverableCandidate && ["intent", "deferred"].includes(operation.phase)) {
      recoverableCandidate = candidateRecoveredFromIntent(projectDir, operation);
      if (recoverableCandidate) {
        operation = transition(operation, {
          phase: "candidate",
          candidateSha: recoverableCandidate,
          lastErrorCode: "operator_abandon_reset_pending",
        });
      }
    }
    const actualHead = refSha(projectDir, "HEAD");
    if (operation.candidateSha && actualHead === operation.candidateSha) {
      const config = { enabled: true, remote: operation.remote, branch: operation.targetBranch, claimsEnabled: false };
      const fetched = await fetchRemote(projectDir, config);
      if (!fetched.ok) return { ...fetched, ok: false, reason: "abandon_reset_fetch_failed", operation };
      const reset = await strictResetRejected(projectDir, config, operation, fetched.remoteSha);
      if (!reset.ok) return { ok: false, reason: "abandon_reset_failed", reset, operation };
    }
    operation = abandonSharedTrunkMergeOperation(operation.operationId, {
      expectedVersion: operation.version,
      lastErrorCode: "operator_abandoned",
    });
    if (!operation) return { ok: false, reason: "operation_changed_concurrently" };
    return { ok: true, operation };
  }), "shared-trunk-abandon");
}

/** Private seam for callers that already hold both the merge and worktree lock. */
export async function syncSharedTrunkAlreadyLocked(projectDir, {
  config,
  includeClaims = false,
  claimAfter = null,
  allowOperationId = null,
  provenance = null,
  workItemContext = null,
  signal = null,
} = {}) {
  recordSyncStatus(projectDir, config, { localSha: refSha(projectDir, config.branch) });
  const fetched = await fetchRemote(projectDir, config, { includeClaims, claimAfter, workItemContext, signal });
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
  if (provenance?.baselineOid) {
    let proof = verifySharedTrunkProvenance(projectDir, {
      baselineOid: provenance.baselineOid,
      newSha: fetched.remoteSha,
      gitIdentities: provenance.gitIdentities,
    });
    if (!proof.ok && proof.reason === "unknown_commit_provenance" && proof.commits.length > 0) {
      try {
        const { verifyTeamProviderMergeProvenance } = await import("../../pairing/functions/team-submissions.js");
        const providerProof = await verifyTeamProviderMergeProvenance({
          projectDir,
          commitOids: proof.commits.map((commit) => commit.commit),
          observedOid: fetched.remoteSha,
          signal,
        });
        if (providerProof?.ok) proof = { ok: true, reason: null, commits: [], provider: providerProof };
      } catch { /* retain the normal provenance gate */ }
    }
    if (!proof.ok) {
      updateSharedTrunkRuntimeStatus({
        provenance_blocked: true,
        provenance_reason: proof.reason,
        provenance_commits: proof.commits,
        remote_sha: fetched.remoteSha,
      });
      sharedTrunkEvent(
        EVENT_TYPES.SHARED_TRUNK_PROVENANCE_BLOCKED,
        "Shared-trunk update requires repository recovery approval",
        { reason: proof.reason, commits: proof.commits },
      );
      return {
        ok: false,
        blocked: true,
        config,
        fetchCompleted: true,
        fetchedClaims: fetched.fetchedClaims,
        ...claimFetchMetadata(fetched),
        reason: "shared_trunk_provenance_blocked",
        remoteSha: fetched.remoteSha,
        provenance: proof,
      };
    }
    updateSharedTrunkRuntimeStatus({
      provenance_blocked: false,
      provenance_reason: null,
      provenance_commits: [],
    });
  }
  const reconciliation = await reconcileAlreadyLocked(projectDir, config, { fetched });
  const blocking = reconciliation.unresolved.filter((operation) => operation.operationId !== allowOperationId);
  if (blocking.length) {
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      ...claimFetchMetadata(fetched),
      reason: "unresolved_shared_trunk_operation",
      remediation: "Run `posse shared-trunk ops` and abandon only the operation you have inspected.",
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
      ...claimFetchMetadata(fetched),
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
    ffEnvelope = await sharedTrunkFastForward({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      expectedLocalOid: oldSha,
      expectedRemoteOid: fetched.remoteSha,
    }, workItemContext, signal);
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
    return { ok: false, config, fetchCompleted: true, fetchedClaims: fetched.fetchedClaims, ...claimFetchMetadata(fetched), diverged: true, advanced: false, oldSha, newSha, reason: "local_trunk_diverged" };
  }
  if (status === "blocked") {
    const blockedReason = String(ff.reason || "").trim() || null;
    const gateJobId = ensureFastForwardBlockedGate(config, blockedReason);
    recordSyncStatus(projectDir, config, {
      localSha: oldSha,
      remoteSha: fetched.remoteSha,
      blockedReason,
    });
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      ...claimFetchMetadata(fetched),
      advanced: false,
      diverged: false,
      unavailable: false,
      oldSha,
      newSha,
      reason: "fast_forward_blocked",
      blockedReason,
      ...(gateJobId ? { gateJobId, needsAttention: true } : {}),
    };
  }
  if (!(ff.ok === true || ["advanced", "up_to_date", "unchanged", "already_current", "no_change"].includes(status))) {
    recordSyncStatus(projectDir, config, { localSha: oldSha, remoteSha: fetched.remoteSha });
    return {
      ok: false,
      config,
      fetchCompleted: true,
      fetchedClaims: fetched.fetchedClaims,
      ...claimFetchMetadata(fetched),
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
    ...claimFetchMetadata(fetched),
    advanced,
    oldSha,
    newSha,
    diverged: false,
    unavailable: false,
  };
}

/** Public locked fetch/reconcile/fast-forward operation used by polling. */
export async function syncSharedTrunkFromOrigin(projectDir, {
  includeClaims = false,
  claimAfter = null,
  provenance = null,
  signal = null,
} = {}) {
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
      claimAfter,
      provenance,
      signal,
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

function pushRejectionReason(result) {
  return String(result?.reason || result?.blockedReason || result?.blocked_reason || "").trim().toLowerCase();
}

function ensurePushRefusedGate(config, pushed) {
  const reason = pushRejectionReason(pushed) || "remote_policy_rejected";
  const existing = getDb().prepare(`
    SELECT id FROM jobs
    WHERE job_type = 'human_input'
      AND status IN ('queued','leased','running','waiting_on_human','blocked')
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.subtype') = 'shared_trunk_push_refused'
          AND json_extract(payload_json, '$.branch') = ?
          AND json_extract(payload_json, '$.reason') = ?
        ELSE 0 END
    ORDER BY id DESC LIMIT 1
  `).get(config.branch, reason);
  if (existing) return existing.id;
  return createJob({
    work_item_id: null,
    job_type: "human_input",
    title: `Shared-trunk push refused for ${config.branch}`,
    priority: "urgent",
    max_attempts: 1,
    payload_json: {
      subtype: "shared_trunk_push_refused",
      review_type: "shared_trunk_push_refused",
      question_kind: "shared_trunk_push_refused",
      questions: ["The remote refused this shared-trunk push. Inspect the branch policy or pre-receive hook, then acknowledge when publication may be retried."],
      choices: ["acknowledge"],
      branch: config.branch,
      remote: config.remote,
      reason,
      stderr_excerpt: String(pushed?.stderrExcerpt || pushed?.stderr_excerpt || "").slice(0, 512),
    },
  }).id;
}

function ensureFastForwardBlockedGate(config, reason) {
  if (!["wrong_checkout", "dirty", "ignored_path_collision"].includes(reason)) return null;
  const existing = getDb().prepare(`
    SELECT id FROM jobs
    WHERE job_type = 'human_input'
      AND status IN ('queued','leased','running','waiting_on_human','blocked')
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.subtype') = 'shared_trunk_fast_forward_blocked'
          AND json_extract(payload_json, '$.branch') = ?
          AND json_extract(payload_json, '$.reason') = ?
        ELSE 0 END
    ORDER BY id DESC LIMIT 1
  `).get(config.branch, reason);
  if (existing) return existing.id;
  return createJob({
    work_item_id: null,
    job_type: "human_input",
    title: `Shared-trunk checkout blocks ${config.branch}`,
    priority: "urgent",
    max_attempts: 1,
    payload_json: {
      subtype: "shared_trunk_fast_forward_blocked",
      review_type: "shared_trunk_fast_forward_blocked",
      question_kind: "shared_trunk_fast_forward_blocked",
      questions: ["The shared-trunk checkout cannot fast-forward safely. Inspect and repair the checkout, then acknowledge to retry."],
      choices: ["acknowledge"],
      branch: config.branch,
      remote: config.remote,
      reason,
    },
  }).id;
}

function sharedTrunkAuthRemediation(projectDir, config, failure) {
  const status = pushStatus(failure);
  const detail = {
    stderr: failure?.stderr,
    stdout: failure?.stdout,
    message: [failure?.message, failure?.error, failure?.reason, status]
      .filter(Boolean)
      .map(String)
      .join("\n"),
  };
  if (!["auth_failed", "authentication_failed", "unauthorized"].includes(status)
    && !isGitPushAuthenticationFailure(detail)) return null;

  let remoteUrl = null;
  try {
    remoteUrl = execGit(["remote", "get-url", "--push", config.remote], projectDir, { timeoutMs: 5_000 }).trim();
  } catch { /* retain a host-neutral remediation below */ }
  return gitHubCliAuthRemediation(remoteUrl);
}

async function strictResetRejected(projectDir, config, operation, remoteOid = operation.baseSha, workItemContext = null) {
  let envelope;
  try {
    envelope = await (testOverrides?.resetRejected || resetRejectedSharedTrunkNative)({
      cwd: projectDir,
      remote: config.remote,
      branch: config.branch,
      expectedCandidateOid: operation.candidateSha,
      remoteOid,
    }, nativeTrunkOptions(workItemContext, 390_000));
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
  let team;
  try {
    team = await teamMergeContext({ projectDir, workItemId: Number(workItemId) });
  } catch (error) {
    const blocked = {
      ok: false,
      sharedTrunk: true,
      team: true,
      unavailable: true,
      operational: true,
      reason: error?.code || "team_grant_unavailable",
      message: error?.message || "Team grant lookup failed",
    };
    return { ...blocked, deferred: true };
  }
  if (!team.ok) {
    const blocked = {
      ...team,
      ok: false,
      sharedTrunk: true,
      reason: team.reason || "team_grant_unavailable",
      message: team.message || `Shared-trunk publication requires a verified Team work-item grant (${team.reason || "team_grant_unavailable"})`,
    };
    return { ...blocked, deferred: isTransientSharedTrunkMergeResult(blocked) };
  }
  const workItemContext = team.workItemContext || null;
  const provenance = await sessionProvenanceContext();

  const sourceShaAtStart = refSha(projectDir, branch);
  let coordinated;
  try {
    coordinated = await underMergeLock(() => withWorktreeLockAsync(projectDir, projectDir, async () => {
    const sourceSha = refSha(projectDir, branch);
    if (!sourceSha) return { ok: false, reason: "source_head_unresolved", message: `Cannot resolve ${branch}` };
    const key = String(purposeKey || sourceSha);
    let existing = listUnresolvedSharedTrunkMergeOperations({ workItemId: Number(workItemId) })
      .find((value) => value.purpose === purpose && value.purposeKey === key) || null;
    let sync = await syncSharedTrunkAlreadyLocked(projectDir, {
      config,
      allowOperationId: existing?.operationId || null,
      workItemContext,
      provenance,
    });
    if (!sync.ok) {
      const remediation = sync.remediation ? ` ${sync.remediation}` : "";
      return { ...sync, message: `Shared trunk synchronization failed: ${sync.reason || "unknown synchronization error"}.${remediation}`.trim() };
    }
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
    if (operation.phase === "abandoned") {
      return {
        ok: false,
        sharedTrunk: true,
        team: Boolean(workItemContext),
        deferred: false,
        needsAttention: true,
        reason: "operation_abandoned",
        message: `Shared-trunk operation ${operation.operationId} was abandoned and cannot be resumed.`,
        operation,
      };
    }
    if (operation.targetBranch !== config.branch || operation.remote !== config.remote) {
      return {
        ok: false,
        sharedTrunk: true,
        deferred: true,
        needsAttention: true,
        reason: "stale_shared_trunk_operation",
        message: `Operation ${operation.operationId} belongs to ${operation.remote}/${operation.targetBranch}; inspect and abandon it before publishing to ${config.remote}/${config.branch}.`,
        operation,
      };
    }
    // begin() can return a previously deferred row through its durable unique
    // key even though deferred rows are intentionally absent from the
    // unresolved query above. Rebase that resumable intent onto the just-
    // synchronized head before creating a new candidate/trailer, and grant a
    // resumed deferral the full retry budget — the persisted attempt would
    // otherwise make push_retry_exhausted permanent for this branch tip.
    // A deferred row that still carries a Team-parked candidate resumes that
    // exact candidate when its base and source are unchanged and the object is
    // still present: the trunk checkout no longer holds it, but the CAS push
    // publishes by OID and the candidate content was validated before it was
    // parked. Anything else drops the stale candidate before rebasing.
    let reusedParkedCandidate = false;
    let parkedCandidateReason = null;
    if (operation.phase === "deferred" && operation.candidateSha) {
      const reusable = isParkedCandidateReason(operation.lastErrorCode)
        && operation.baseSha === baseSha
        && operation.sourceSha === sourceSha
        && commitExists(projectDir, operation.candidateSha);
      if (reusable) {
        reusedParkedCandidate = true;
        parkedCandidateReason = operation.lastErrorCode;
        operation = transition(operation, { phase: "candidate", lastErrorCode: parkedCandidateReason });
      } else {
        let landed = false;
        try {
          landed = isAncestor(projectDir, operation.candidateSha, baseSha);
        } catch (error) {
          return { ok: false, unavailable: true, reason: "ancestry_unresolved", error, operation };
        }
        const proof = landed
          ? await teamPublishedProof({ projectDir, operation, observedOid: baseSha })
          : null;
        if (proof?.ok && proof.legacy !== true) {
          operation = transition(operation, { phase: "candidate" });
          operation = finalizePublished(operation, { remoteSha: baseSha, recovered: true });
          recordPublicationHealth(config, []);
          return {
            ok: true,
            sharedTrunk: true,
            published: true,
            recovered: true,
            mergeHash: operation.candidateSha,
            targetBranch: config.branch,
            operation,
          };
        }
        operation = transition(operation, { phase: "deferred", candidateSha: null });
      }
    }
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
        const observed = await fetchRemote(projectDir, config, { workItemContext });
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
          const proof = await teamPublishedProof({ projectDir, operation, observedOid: observed.remoteSha });
          if (!proof?.ok) return teamProofUnavailable(proof, operation);
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
        operation = transition(operation, {
          phase: "intent",
          candidateSha: null,
          baseSha,
          expectedRemoteSha: baseSha,
          attempt,
          lastErrorCode: null,
        });
        let local;
        try {
          local = await mergeLocalCandidate({
            suppressPostMergeEffects: true,
            worktreeLockAlreadyHeld: true,
            operationId: operation.operationId,
          });
        } catch (error) {
          operation = transition(operation, { phase: "intent", lastErrorCode: error?.code || "merge_operational_failure" });
          return { ok: false, unavailable: true, operational: true, reason: error?.code || "merge_operational_failure", error, operation };
        }
        if (!local?.ok) {
          const mergeHash = local?.mergeHash && commitExists(projectDir, local.mergeHash)
            ? local.mergeHash
            : null;
          operation = transition(operation, mergeHash ? {
            phase: "candidate",
            candidateSha: mergeHash,
            lastErrorCode: local?.reason || "merge_failed_after_commit",
          } : {
            phase: "intent",
            lastErrorCode: local?.deterministicConflict ? "deterministic_conflict" : (local?.reason || "merge_failed"),
          });
          return { ...local, ...(mergeHash ? { resetPending: true } : {}), operation };
        }
        const candidateSha = local.mergeHash || refSha(projectDir, config.branch);
        if (!candidateSha) return { ok: false, reason: "candidate_head_unresolved", operation };
        operation = transition(operation, { phase: "candidate", candidateSha, attempt, lastErrorCode: null });
        if (candidateSha === operation.baseSha) {
          operation = finalizePublished(operation, { remoteSha: operation.baseSha, recovered: true });
          recordPublicationHealth(config, []);
          return {
            ok: true,
            sharedTrunk: true,
            published: false,
            alreadyIntegrated: true,
            mergeHash: candidateSha,
            targetBranch: config.branch,
            operation,
          };
        }
      }

      if (reusedParkedCandidate) {
        const restored = restoreParkedCandidate(projectDir, operation);
        if (!restored.ok) {
          operation = transition(operation, { phase: "candidate", lastErrorCode: parkedCandidateReason });
          return { ok: false, deferred: true, reason: "parked_candidate_restore_blocked", blockedReason: restored.reason, operation };
        }
      }

      let validation;
      try {
        validation = reusedParkedCandidate
          ? { ok: true, reusedParkedCandidate: true }
          : await validateCandidate({ pushBranch: config.branch, effectiveRemote: config.remote });
      } catch (error) {
        operation = transition(operation, { phase: "candidate", lastErrorCode: error?.code || "candidate_validation_unavailable" });
        return { ok: false, unavailable: true, operational: true, reason: error?.code || "candidate_validation_unavailable", error, operation };
      }
      reusedParkedCandidate = false;
      if (!validation?.ok) {
        const capturedCandidate = operation.candidateSha;
        operation = transition(operation, {
          phase: "candidate",
          lastErrorCode: "candidate_gate_reset_pending",
        });
        const gateFetch = await fetchRemote(projectDir, config, { workItemContext });
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
        }, gateFetch.remoteSha, workItemContext);
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

      // Candidate validation may be slow enough for another paired clone to
      // publish meanwhile. Refresh the exact remote head after validation and
      // rebuild locally on top of it before attempting a leased push. The CAS
      // rejection path below remains the final guard for the smaller race
      // between this fetch and the push itself.
      const prePushFetch = await fetchRemote(projectDir, config, { workItemContext });
      if (!prePushFetch.ok) {
        recordPublicationHealth(config, [operation]);
        return { ...prePushFetch, operation, message: "Could not refresh shared trunk before publication" };
      }
      if (prePushFetch.remoteSha !== operation.expectedRemoteSha) {
        let landed = false;
        try {
          landed = operation.candidateSha
            ? isAncestor(projectDir, operation.candidateSha, prePushFetch.remoteSha)
            : false;
        } catch (err) {
          return {
            ok: false,
            unavailable: true,
            operational: true,
            reason: "ancestry_unresolved",
            error: err,
            operation,
            message: "Could not prove whether the refreshed shared trunk already contains this candidate",
          };
        }
        if (landed) {
          const proof = await teamPublishedProof({ projectDir, operation, observedOid: prePushFetch.remoteSha });
          if (!proof?.ok) return teamProofUnavailable(proof, operation);
          handleSharedTrunkAdvance(projectDir, {
            oldSha: operation.baseSha,
            newSha: prePushFetch.remoteSha,
            targetBranch: config.branch,
            source: "shared_trunk_recovery",
          });
          operation = finalizePublished(operation, {
            remoteSha: prePushFetch.remoteSha,
            recovered: true,
          });
          recordPublicationHealth(config, []);
          return {
            ok: true,
            sharedTrunk: true,
            published: true,
            recovered: true,
            mergeHash: operation.candidateSha,
            targetBranch: config.branch,
            operation,
          };
        }

        const capturedCandidate = operation.candidateSha;
        operation = transition(operation, {
          phase: "candidate",
          baseSha: prePushFetch.remoteSha,
          expectedRemoteSha: prePushFetch.remoteSha,
          attempt: attempt + 1,
          lastErrorCode: "remote_advance_reset_pending",
        });
        const reset = await strictResetRejected(projectDir, config, {
          ...operation,
          candidateSha: capturedCandidate,
        }, prePushFetch.remoteSha, workItemContext);
        if (!reset.ok) {
          recordPublicationHealth(config, [operation]);
          return {
            ok: false,
            deferred: true,
            resetPending: true,
            reason: reset.reason || "pre_push_refresh_reset_failed",
            reset,
            operation,
          };
        }
        operation = transition(operation, {
          phase: "deferred",
          candidateSha: null,
          lastErrorCode: "remote_advanced_before_push",
        });
        recordPublicationHealth(config, []);
        if (attempt >= retries) {
          operation = transition(operation, { phase: "deferred", lastErrorCode: "push_retry_exhausted" });
          return { ok: false, deferred: true, reason: "push_retry_exhausted", operation };
        }
        sync = await syncSharedTrunkAlreadyLocked(projectDir, {
          config,
          allowOperationId: operation.operationId,
          workItemContext,
          provenance,
        });
        if (!sync.ok) return { ...sync, operation };
        baseSha = sync.newSha || refSha(projectDir, config.branch);
        operation = transition(operation, {
          phase: "deferred",
          candidateSha: null,
          baseSha,
          expectedRemoteSha: baseSha,
          attempt: operation.attempt,
          lastErrorCode: "remote_advanced_before_push",
        });
        updateSharedTrunkRuntimeStatus({}, { increments: { push_retry_count: 1 } });
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_RETRIED, `Refreshing shared-trunk candidate for WI#${workItemId}`, {
          operation_id: operation.operationId,
          attempt: attempt + 1,
          reason: "remote_advanced_before_push",
          remote_sha: prePushFetch.remoteSha,
        }, Number(workItemId));
        continue;
      }

      const approval = await teamPublicationGate({ projectDir, operation });
      if (!approval?.ok) {
        operation = transition(operation, {
          phase: "candidate",
          lastErrorCode: approval?.reason || "team_approval_unavailable",
        });
        recordPublicationHealth(config, [operation]);
        return {
          ...approval,
          ok: false,
          team: true,
          operation,
          sharedTrunk: true,
          message: approval?.message || "Team submission requires originator approval",
        };
      }

      let pushedEnvelope;
      try {
        pushedEnvelope = await sharedTrunkPush({
          cwd: projectDir,
          remote: config.remote,
          branch: config.branch,
          expectedRemoteOid: operation.expectedRemoteSha,
          newOid: operation.candidateSha,
        }, approval?.workItemContext || workItemContext);
      } catch (err) {
        const auth = sharedTrunkAuthRemediation(projectDir, config, err);
        if (auth) {
          operation = transition(operation, { phase: "candidate", lastErrorCode: auth.reason });
          recordPublicationHealth(config, [operation]);
          return {
            ok: false,
            unavailable: true,
            reason: auth.reason,
            message: auth.message,
            remediation_commands: auth.commands,
            operation,
          };
        }
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
      const auth = sharedTrunkAuthRemediation(projectDir, config, pushed);
      if (auth) {
        operation = transition(operation, { phase: "candidate", lastErrorCode: auth.reason });
        recordPublicationHealth(config, [operation]);
        return {
          ok: false,
          unavailable: true,
          reason: auth.reason,
          message: auth.message,
          remediation_commands: auth.commands,
          operation,
        };
      }
      if (pushRejectionReason(pushed) === "local_changed") {
        operation = transition(operation, { phase: "candidate", lastErrorCode: "local_candidate_changed" });
        recordPublicationHealth(config, [operation]);
        return {
          ok: false,
          deferred: true,
          reason: "local_candidate_changed",
          message: "The checked-out shared-trunk branch no longer points at the journaled candidate",
          operation,
        };
      }
      if (pushStatus(pushed) === "rejected_policy") {
        const gateId = ensurePushRefusedGate(config, pushed);
        operation = transition(operation, { phase: "candidate", lastErrorCode: "shared_trunk_push_refused" });
        recordPublicationHealth(config, [operation]);
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_REJECTED, `Shared-trunk push refused for WI#${workItemId}`, {
          operation_id: operation.operationId,
          gate_job_id: gateId,
          reason: pushRejectionReason(pushed),
        }, Number(workItemId));
        return {
          ok: false,
          deferred: true,
          needsAttention: true,
          reason: "shared_trunk_push_refused",
          message: String(pushed.stderrExcerpt || pushed.stderr_excerpt || "The remote refused the shared-trunk push"),
          gateJobId: gateId,
          operation,
        };
      }
      if (typedPushRejection(pushed)) {
        updateSharedTrunkRuntimeStatus({}, { increments: { push_rejection_count: 1 } });
        sharedTrunkEvent(EVENT_TYPES.SHARED_TRUNK_PUSH_REJECTED, `Shared-trunk push rejected for WI#${workItemId}`, {
          operation_id: operation.operationId,
          attempt,
        }, Number(workItemId));
        const rejectedFetch = await fetchRemote(projectDir, config, { workItemContext });
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
        }, rejectedFetch.remoteSha, workItemContext);
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
        sync = await syncSharedTrunkAlreadyLocked(projectDir, {
          config,
          allowOperationId: operation.operationId,
          workItemContext,
          provenance,
        });
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
  } catch (error) {
    const operation = listSharedTrunkMergeOperations({ workItemId: Number(workItemId) })
      .filter((value) => value.purpose === purpose
        && value.sourceBranch === branch
        && (!sourceShaAtStart || value.sourceSha === sourceShaAtStart))
      .at(-1) || null;
    if (operation?.phase === "published") {
      return {
        ok: true,
        sharedTrunk: true,
        published: true,
        recovered: true,
        mergeHash: operation.candidateSha,
        targetBranch: config.branch,
        operation,
      };
    }
    const failed = {
      ok: false,
      sharedTrunk: true,
      unavailable: true,
      operational: true,
      reason: error?.code || "merge_operational_failure",
      message: error?.message || String(error),
      error,
      operation,
    };
    return { ...failed, deferred: isTransientSharedTrunkMergeResult(failed) };
  }
  if (!coordinated || typeof coordinated !== "object") return coordinated;
  const result = { ...coordinated, sharedTrunk: true };
  return result.ok ? result : { ...result, deferred: isTransientSharedTrunkMergeResult(result) };
}

export const __testSharedTrunkInternals = Object.freeze({
  candidateRecoveredFromIntent,
  isAncestor,
  pushStatus,
  sharedTrunkAuthRemediation,
  typedPushRejection,
  pushRejectionReason,
  restoreParkedCandidate,
  reconcileAlreadyLocked,
  setTestOverrides(overrides) {
    assertTestContext("__testSharedTrunkInternals.setTestOverrides");
    testOverrides = overrides && typeof overrides === "object" ? overrides : null;
  },
});
