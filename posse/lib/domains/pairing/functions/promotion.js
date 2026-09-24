import path from "node:path";

import { createGitWorkflowHelpers } from "../../git/functions/workflows.js";
import { adminGitExec } from "../../git/functions/admin-git.js";
import { gitPushWithGitHubCliFallback } from "../../git/functions/git-push-auth.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import {
  clearRuntimeStatus,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import {
  assertCleanPairingCheckout,
  canonicalRepositoryLocator,
  validateBranchName,
  validateRemoteName,
} from "./git.js";

const PROTOCOL = "posse.pairing_promotion.v2";
const LEGACY_PROTOCOL = "posse.pairing_promotion.v1";
const SHA_RE = /^[0-9a-f]{40,64}$/iu;
const MAX_REBUILDS = 3;

function git(args, projectDir, options = {}) {
  return adminGitExec(args, projectDir, { timeoutMs: 15 * 60_000, ...options });
}

function validatePromotionSource(value) {
  const source = String(value || "").trim();
  try {
    canonicalRepositoryLocator(source);
  } catch (error) {
    // Local absolute remotes are retained for deterministic/self-hosted Git
    // workflows. Pairing enrollment itself accepts only network remotes, so
    // this arm is principally the existing local integration-test seam.
    if (!path.isAbsolute(source) || /[\u0000-\u001f\u007f]/u.test(source)) throw error;
  }
  return source;
}

function refSha(projectDir, ref, exec = git) {
  try {
    const value = exec(["rev-parse", "--verify", ref], projectDir, { timeoutMs: 5_000 }).trim();
    return SHA_RE.test(value) ? value : "";
  } catch {
    return "";
  }
}

function isAncestor(projectDir, ancestor, descendant, exec = git) {
  try {
    exec(["merge-base", "--is-ancestor", ancestor, descendant], projectDir, { timeoutMs: 10_000 });
    return true;
  } catch (error) {
    if (Number(error?.status) === 1) return false;
    throw error;
  }
}

function store(journal) {
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PROMOTION, journal);
  return journal;
}

export function readPairingPromotionJournal() {
  const journal = readRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PROMOTION);
  if (journal?.protocol === PROTOCOL) return journal;
  if (journal?.protocol === LEGACY_PROTOCOL) {
    return {
      ...journal,
      source_url: null,
      target_remote: journal.remote,
    };
  }
  return null;
}

export function beginPairingPromotion(state, {
  projectDir = process.cwd(), reason = "host_shutdown", strategy = "squash",
} = {}) {
  if (!["squash", "fast-forward"].includes(strategy)) {
    throw Object.assign(new Error(`Unknown pairing promotion strategy: ${strategy}`), {
      code: "pairing_promotion_strategy_invalid",
    });
  }
  const existing = readPairingPromotionJournal();
  if (existing && existing.session_id === state?.remote_session_id) {
    if ((existing.strategy || "squash") !== strategy) {
      throw promotionError("pairing_promotion_strategy_locked", "The frozen pairing promotion uses a different strategy");
    }
    return existing;
  }
  if (existing) {
    throw Object.assign(new Error(
      `Pairing integration ${existing.session_id || "(unknown)"} is still pending`,
    ), { code: "pairing_promotion_already_pending" });
  }
  const targetRemote = validateRemoteName(state?.origin_remote_name || state?.remote_name);
  const sourceRemote = validateRemoteName(state?.remote_name);
  const sourceUrl = String(state?.remote_url || "").trim()
    || git(["remote", "get-url", sourceRemote], projectDir, { timeoutMs: 5_000 }).trim();
  const journal = {
    protocol: PROTOCOL,
    session_id: String(state?.remote_session_id || state?.id || ""),
    source_url: sourceUrl,
    source_branch: validateBranchName(projectDir, state?.shared_branch),
    target_remote: targetRemote,
    target_branch: validateBranchName(projectDir, state?.original_branch),
    target_ssh_command: state?.original_ssh_command || null,
    temporary_repository: state?.temporary_repository || null,
    strategy,
    approval_required: strategy === "fast-forward" || state?.submission_approval_enabled === 1,
    phase: "requested",
    reason,
    target_base_sha: null,
    candidate_sha: null,
    updated_at: new Date().toISOString(),
    last_error: null,
  };
  validatePromotionSource(journal.source_url);
  return store(journal);
}

export function markPairingPromotion(journal, values = {}) {
  return store({
    ...journal,
    ...values,
    updated_at: new Date().toISOString(),
  });
}

export function clearPairingPromotionJournal() {
  return clearRuntimeStatus(RUNTIME_STATUS_KEYS.PAIRING_PROMOTION);
}

function fetchBranch(projectDir, remote, branch, exec = git) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  exec(["fetch", "--no-tags", remote, `+refs/heads/${branch}:${remoteRef}`], projectDir);
  const sha = refSha(projectDir, remoteRef, exec);
  if (!sha) throw Object.assign(new Error(`Could not resolve ${remote}/${branch} after fetch`), {
    code: "pairing_promotion_remote_head_unresolved",
  });
  return { remoteRef, sha };
}

function fetchSourceBranch(projectDir, journal, exec = git) {
  const branch = validateBranchName(projectDir, journal.source_branch);
  if (!journal.source_url) {
    return fetchBranch(projectDir, validateRemoteName(journal.remote), branch, exec);
  }
  const sourceUrl = validatePromotionSource(journal.source_url);
  const suffix = String(journal.session_id || "recovery")
    .replace(/[^a-zA-Z0-9-]/gu, "")
    .slice(0, 64) || "recovery";
  const sourceRef = `refs/posse/pairing-sources/${suffix}`;
  exec(["fetch", "--no-tags", sourceUrl, `+refs/heads/${branch}:${sourceRef}`], projectDir);
  const sha = refSha(projectDir, sourceRef, exec);
  if (!sha) {
    throw Object.assign(new Error(`Could not resolve the session source branch ${branch} after fetch`), {
      code: "pairing_promotion_source_head_unresolved",
    });
  }
  return { remoteRef: sourceRef, sha };
}

function targetGitArgs(journal, args) {
  return ["-c", `core.sshCommand=${journal.target_ssh_command || "ssh"}`, ...args];
}

function fetchTargetBranch(projectDir, journal, remote, branch, exec = git) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  exec(targetGitArgs(journal, [
    "fetch", "--no-tags", remote, `+refs/heads/${branch}:${remoteRef}`,
  ]), projectDir);
  const sha = refSha(projectDir, remoteRef, exec);
  if (!sha) throw Object.assign(new Error(`Could not resolve ${remote}/${branch} after fetch`), {
    code: "pairing_promotion_remote_head_unresolved",
  });
  return { remoteRef, sha };
}

function createPromotionWorkflow(projectDir, targetBranch) {
  return createGitWorkflowHelpers({
    projectDir,
    targetBranch,
    nonInteractive: true,
    gitExecFn: adminGitExec,
    gitExecAsyncFn: async (args, cwd, options) => adminGitExec(args, cwd, options),
    // The promotion owns the repo-wide merge lock and runs only after the
    // scheduler stopped. Avoid acquiring the agent worktree lock recursively.
    withWorktreeLockFn: (_worktreePath, _root, fn) => fn(),
  });
}

function preserveCandidate(projectDir, sessionId, candidate, exec = git) {
  if (!candidate) return null;
  const suffix = String(sessionId || "recovery").replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 64) || "recovery";
  const ref = `refs/posse/pairing-promotions/${suffix}`;
  exec(["update-ref", ref, candidate], projectDir, { timeoutMs: 5_000 });
  return ref;
}

function promotionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function publishedFastForward(projectDir, journal, remote, targetBranch, observed, {
  exec, onProgress,
}) {
  if (observed.sha !== journal.candidate_sha) {
    throw promotionError("pairing_promotion_publication_unresolved", "Origin advanced beyond the approved frozen source");
  }
  onProgress(`Verified history-preserving promotion ${journal.candidate_sha.slice(0, 8)}`);
  markPairingPromotion(journal, { phase: "published", last_error: null });
  clearPairingPromotionJournal();
  return { ok: true, sourceBranch: journal.source_branch, targetBranch, remote,
    strategy: "fast-forward", mergeHash: observed.sha, sourceOid: journal.candidate_sha };
}

async function promoteFastForwardLocked(projectDir, initialJournal, {
  exec = git, workflowFactory = createPromotionWorkflow, onProgress = () => {}, publish = true,
  approval = null,
} = {}) {
  let journal = initialJournal;
  const remote = validateRemoteName(journal.target_remote || journal.remote);
  const sourceBranch = validateBranchName(projectDir, journal.source_branch);
  const targetBranch = validateBranchName(projectDir, journal.target_branch);
  if (sourceBranch === targetBranch) throw promotionError("pairing_promotion_self_merge", "Pairing side trunk cannot equal its promotion target");
  assertCleanPairingCheckout(projectDir);
  const source = fetchSourceBranch(projectDir, journal, exec);
  let target = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
  const frozen = SHA_RE.test(String(journal.candidate_sha || "")) ? journal.candidate_sha : null;
  if (!frozen && source.sha === target.sha) {
    clearPairingPromotionJournal();
    return { ok: true, skipped: "already_up_to_date", sourceBranch, targetBranch,
      remote, strategy: "fast-forward", mergeHash: target.sha, sourceOid: source.sha };
  }
  if (frozen && source.sha !== frozen) {
    throw promotionError("pairing_promotion_source_moved", "The session source changed after the history-preserving candidate was frozen");
  }
  const candidate = frozen || source.sha;
  if (!frozen && !isAncestor(projectDir, target.sha, candidate, exec)) {
    throw promotionError("pairing_promotion_not_fast_forward", "Origin is not an ancestor of the frozen session trunk");
  }
  if (frozen && ["publishing", "publish_unknown"].includes(journal.phase)
    && target.sha === candidate) {
    if (journal.approved_source_sha !== candidate
      || journal.approved_origin_sha !== journal.target_base_sha) {
      throw promotionError("pairing_promotion_approval_required", "The publication attempt has no exact host OID approval");
    }
    return publishedFastForward(projectDir, journal, remote, targetBranch, target, { exec, onProgress });
  }
  if (!isAncestor(projectDir, target.sha, candidate, exec)) {
    throw promotionError("pairing_promotion_target_diverged", "Origin advanced outside the frozen session history; rebase and obtain a new approval");
  }
  if (!frozen) {
    preserveCandidate(projectDir, journal.session_id, candidate, exec);
    journal = markPairingPromotion(journal, {
      phase: "candidate", target_base_sha: target.sha, candidate_sha: candidate, last_error: null,
    });
  }
  // The gate examines the exact local target branch. Align it with the frozen
  // source commit without creating a squash or merge commit.
  const current = refSha(projectDir, targetBranch, exec);
  if (current && current !== candidate && current !== target.sha
    && !isAncestor(projectDir, current, target.sha, exec)) {
    throw promotionError("pairing_promotion_local_target_unpublished",
      "Local target has commits absent from origin; history-preserving promotion will not reset it");
  }
  if (current !== candidate) {
    exec(["switch", targetBranch], projectDir);
    exec(["reset", "--hard", candidate], projectDir);
  } else {
    exec(["switch", targetBranch], projectDir);
  }
  if (!publish) return { ok: true, pending: true, phase: "candidate", sourceBranch,
    targetBranch, remote, strategy: "fast-forward", mergeHash: candidate,
    targetBaseOid: journal.target_base_sha };

  if (approval?.sourceOid !== candidate || approval?.originOid !== journal.target_base_sha
    || target.sha !== approval.originOid) {
    throw promotionError("pairing_promotion_approval_required",
      "History-preserving publication requires the exact frozen source and current origin base OIDs");
  }

  const workflow = workflowFactory(projectDir, targetBranch);
  const validation = workflow._validatePushCandidate({ pushBranch: targetBranch });
  if (!validation?.ok) {
    journal = markPairingPromotion(journal, { phase: "candidate", last_error: "candidate_gate_failed" });
    throw Object.assign(new Error(`Pairing promotion push gate failed: ${validation?.reason || "unknown"}`), {
      code: "pairing_promotion_gate_failed", validation,
    });
  }
  target = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
  if (!isAncestor(projectDir, target.sha, candidate, exec)) {
    throw promotionError("pairing_promotion_target_diverged", "Origin advanced outside the frozen session history after validation");
  }
  if (target.sha === candidate) {
    if (!["publishing", "publish_unknown"].includes(journal.phase)
      || journal.approved_source_sha !== candidate
      || journal.approved_origin_sha !== journal.target_base_sha) {
      throw promotionError("pairing_promotion_publication_unresolved", "The candidate appeared on origin before this promotion published it");
    }
    return publishedFastForward(projectDir, journal, remote, targetBranch, target, { exec, onProgress });
  }
  journal = markPairingPromotion(journal, {
    phase: "publishing", target_base_sha: target.sha,
    approved_source_sha: candidate, approved_origin_sha: target.sha,
    last_error: null,
  });
  try {
    gitPushWithGitHubCliFallback(targetGitArgs(journal, [
      "push", `--force-with-lease=refs/heads/${targetBranch}:${target.sha}`,
      remote, `${candidate}:refs/heads/${targetBranch}`,
    ]), projectDir, {
      remote,
      gitExecFn: exec,
      fallbackGitExecFn: exec,
    });
  } catch (error) {
    journal = markPairingPromotion(journal, { phase: "publish_unknown", last_error: "push_outcome_unknown" });
    // A timeout can occur after the server accepts the push. Re-read the
    // target before considering any retry, and retain the journal on doubt.
    try {
      const observed = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
      if (observed.sha === candidate) {
        return publishedFastForward(projectDir, journal, remote, targetBranch, observed, { exec, onProgress });
      }
    } catch { /* keep the frozen candidate and unresolved journal */ }
    throw Object.assign(error, { code: "pairing_promotion_publication_unresolved" });
  }
  try {
    target = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
  } catch (error) {
    markPairingPromotion(journal, { phase: "publish_unknown", last_error: "post_push_fetch_failed" });
    throw Object.assign(error, { code: "pairing_promotion_publication_unresolved" });
  }
  if (target.sha !== candidate) {
    markPairingPromotion(journal, { phase: "publish_unknown", last_error: "post_push_ancestry_failed" });
    throw promotionError("pairing_promotion_publication_unresolved", "Could not prove pairing promotion publication");
  }
  return publishedFastForward(projectDir, journal, remote, targetBranch, target, { exec, onProgress });
}

async function promoteLocked(projectDir, initialJournal, {
  exec = git,
  workflowFactory = createPromotionWorkflow,
  onProgress = () => {},
  publish = true,
  approval = null,
} = {}) {
  if (initialJournal.strategy === "fast-forward") {
    return promoteFastForwardLocked(projectDir, initialJournal, { exec, workflowFactory, onProgress, publish, approval });
  }
  if (initialJournal.strategy && initialJournal.strategy !== "squash") {
    throw promotionError("pairing_promotion_strategy_invalid", "Unknown journaled pairing promotion strategy");
  }
  let journal = initialJournal;
  const approvalRequired = journal.approval_required === true;
  const remote = validateRemoteName(journal.target_remote || journal.remote);
  const sourceBranch = validateBranchName(projectDir, journal.source_branch);
  const targetBranch = validateBranchName(projectDir, journal.target_branch);
  if (sourceBranch === targetBranch) {
    throw Object.assign(new Error("Pairing side trunk cannot equal its promotion target"), {
      code: "pairing_promotion_self_merge",
    });
  }
  assertCleanPairingCheckout(projectDir);

  const workflow = workflowFactory(projectDir, targetBranch);
  for (let attempt = 0; attempt < MAX_REBUILDS; attempt += 1) {
    const source = fetchSourceBranch(projectDir, journal, exec);
    const target = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
    const current = refSha(projectDir, targetBranch, exec);
    const candidate = SHA_RE.test(String(journal.candidate_sha || "")) ? journal.candidate_sha : null;

    if (approvalRequired && candidate && journal.approved_source_sha === candidate
      && journal.approved_origin_sha === journal.target_base_sha && target.sha === candidate) {
      markPairingPromotion(journal, { phase: "published", last_error: null });
      clearPairingPromotionJournal();
      return { ok: true, sourceBranch, targetBranch, remote,
        strategy: "squash", mergeHash: candidate, recovered: true };
    }
    if (approvalRequired && candidate && target.sha !== journal.target_base_sha) {
      throw promotionError("pairing_promotion_approval_stale", "Origin moved after the squash candidate was frozen");
    }
    if (approvalRequired && candidate && current !== candidate) {
      throw promotionError("pairing_promotion_candidate_moved", "Local target moved after the squash candidate was frozen");
    }

    if (candidate && current === candidate && journal.target_base_sha === target.sha) {
      onProgress(`Retrying preserved pairing promotion ${candidate.slice(0, 8)}`);
    } else {
      if (current !== target.sha) {
        if (current && isAncestor(projectDir, current, target.sha, exec)) {
          exec(["switch", targetBranch], projectDir);
          exec(["merge", "--ff-only", target.remoteRef], projectDir);
        } else if (candidate && current === candidate) {
          preserveCandidate(projectDir, journal.session_id, candidate, exec);
          exec(["switch", targetBranch], projectDir);
          exec(["reset", "--hard", target.sha], projectDir);
        } else {
          throw Object.assign(new Error(
            `Local ${targetBranch} diverged from ${remote}/${targetBranch}; automatic promotion refused`,
          ), { code: "pairing_promotion_target_diverged" });
        }
      } else {
        exec(["switch", targetBranch], projectDir);
      }
      exec(["branch", "--force", sourceBranch, source.sha], projectDir);
      onProgress(`Integrating ${sourceBranch} into ${targetBranch}`);
      const merged = workflow.gitMergeToTarget(sourceBranch, projectDir, { wiId: null });
      if (!merged?.ok) {
        throw Object.assign(new Error(merged?.message || "Pairing promotion merge failed"), {
          code: merged?.deterministicConflict
            ? "pairing_promotion_conflict"
            : "pairing_promotion_merge_failed",
          result: merged,
        });
      }
      const nextCandidate = merged.mergeHash || refSha(projectDir, targetBranch, exec);
      preserveCandidate(projectDir, journal.session_id, nextCandidate, exec);
      journal = markPairingPromotion(journal, {
        phase: "candidate",
        target_base_sha: target.sha,
        candidate_sha: nextCandidate,
        last_error: null,
      });
    }

    if (!publish) {
      return {
        ok: true,
        pending: true,
        phase: "candidate",
        sourceBranch,
        targetBranch,
        remote,
        mergeHash: journal.candidate_sha,
        targetBaseOid: journal.target_base_sha,
        strategy: "squash",
      };
    }

    if (approvalRequired && (approval?.sourceOid !== journal.candidate_sha
      || approval?.originOid !== journal.target_base_sha
      || target.sha !== approval.originOid)) {
      throw promotionError("pairing_promotion_approval_required",
        "Squash publication requires the exact frozen candidate and current origin base OIDs");
    }

    const validation = workflow._validatePushCandidate({ pushBranch: targetBranch });
    if (!validation?.ok) {
      throw Object.assign(new Error(`Pairing promotion push gate failed: ${validation?.reason || "unknown"}`), {
        code: "pairing_promotion_gate_failed",
        validation,
      });
    }

    const refreshed = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
    if (refreshed.sha !== journal.target_base_sha) {
      if (approvalRequired) {
        throw promotionError("pairing_promotion_approval_stale", "Origin moved after the approved squash candidate was validated");
      }
      onProgress(`${remote}/${targetBranch} advanced; rebuilding the promotion`);
      preserveCandidate(projectDir, journal.session_id, journal.candidate_sha, exec);
      exec(["reset", "--hard", refreshed.sha], projectDir);
      journal = markPairingPromotion(journal, {
        phase: "requested",
        target_base_sha: refreshed.sha,
        candidate_sha: null,
        last_error: "target_advanced_before_push",
      });
      continue;
    }

    onProgress(`Publishing ${targetBranch} with an exact remote lease`);
    if (approvalRequired) journal = markPairingPromotion(journal, {
      phase: "publishing", approved_source_sha: journal.candidate_sha,
      approved_origin_sha: journal.target_base_sha,
    });
    try {
      gitPushWithGitHubCliFallback(targetGitArgs(journal, [
        "push",
        `--force-with-lease=refs/heads/${targetBranch}:${journal.target_base_sha}`,
        remote,
        `${journal.candidate_sha}:refs/heads/${targetBranch}`,
      ]), projectDir, {
        remote,
        gitExecFn: exec,
        fallbackGitExecFn: exec,
      });
    } catch (error) {
      if (approvalRequired) {
        journal = markPairingPromotion(journal, { phase: "publish_unknown", last_error: "push_outcome_unknown" });
        try {
          const observed = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
          if (observed.sha === journal.candidate_sha) {
            markPairingPromotion(journal, { phase: "published", last_error: null });
            clearPairingPromotionJournal();
            return { ok: true, sourceBranch, targetBranch, remote,
              strategy: "squash", mergeHash: observed.sha, recovered: true };
          }
        } catch { /* preserve unresolved publication intent */ }
        throw Object.assign(error, { code: "pairing_promotion_publication_unresolved" });
      }
      journal = markPairingPromotion(journal, {
        phase: "candidate",
        last_error: "push_rejected_or_unavailable",
      });
      if (attempt + 1 < MAX_REBUILDS) continue;
      throw error;
    }
    const published = fetchTargetBranch(projectDir, journal, remote, targetBranch, exec);
    if (published.sha !== journal.candidate_sha) {
      throw Object.assign(new Error("Could not prove pairing promotion publication"), {
        code: "pairing_promotion_publication_unresolved",
      });
    }
    markPairingPromotion(journal, { phase: "published", last_error: null });
    clearPairingPromotionJournal();
    return {
      ok: true,
      sourceBranch,
      targetBranch,
      remote,
      mergeHash: published.sha,
    };
  }
  throw Object.assign(new Error("Pairing promotion retry budget exhausted"), {
    code: "pairing_promotion_retry_exhausted",
  });
}

export async function promotePairingTrunk(projectDir, {
  journal = readPairingPromotionJournal(),
  onProgress = () => {},
  ...options
} = {}) {
  if (!journal) return { ok: true, skipped: "no_pending_promotion" };
  const locked = await withMergeLock(
    () => promoteLocked(projectDir, journal, { onProgress, ...options }),
    { ownerId: `merge-${process.pid}-pairing-promotion` },
  );
  if (!locked.acquired) return { ok: false, deferred: true, reason: "merge_in_progress" };
  return locked.result;
}

export const __testPairingPromotionInternals = Object.freeze({
  fetchBranch,
  fetchSourceBranch,
  fetchTargetBranch,
  isAncestor,
  preserveCandidate,
  refSha,
});
