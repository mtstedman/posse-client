import { createGitWorkflowHelpers } from "../../git/functions/workflows.js";
import { adminGitExec } from "../../git/functions/admin-git.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import {
  clearRuntimeStatus,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { assertCleanPairingCheckout, validateBranchName, validateRemoteName } from "./git.js";

const PROTOCOL = "posse.pairing_promotion.v1";
const SHA_RE = /^[0-9a-f]{40,64}$/iu;
const MAX_REBUILDS = 3;

function git(args, projectDir, options = {}) {
  return adminGitExec(args, projectDir, { timeoutMs: 15 * 60_000, ...options });
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
  return journal?.protocol === PROTOCOL ? journal : null;
}

export function beginPairingPromotion(state, { projectDir = process.cwd(), reason = "host_shutdown" } = {}) {
  const existing = readPairingPromotionJournal();
  if (existing && existing.session_id === state?.remote_session_id) return existing;
  if (existing) {
    throw Object.assign(new Error(
      `Pairing integration ${existing.session_id || "(unknown)"} is still pending`,
    ), { code: "pairing_promotion_already_pending" });
  }
  const journal = {
    protocol: PROTOCOL,
    session_id: String(state?.remote_session_id || state?.id || ""),
    remote: validateRemoteName(state?.remote_name),
    source_branch: validateBranchName(projectDir, state?.shared_branch),
    target_branch: validateBranchName(projectDir, state?.original_branch),
    phase: "requested",
    reason,
    target_base_sha: null,
    candidate_sha: null,
    updated_at: new Date().toISOString(),
    last_error: null,
  };
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

async function promoteLocked(projectDir, initialJournal, {
  exec = git,
  workflowFactory = createPromotionWorkflow,
  onProgress = () => {},
} = {}) {
  let journal = initialJournal;
  const remote = validateRemoteName(journal.remote);
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
    const source = fetchBranch(projectDir, remote, sourceBranch, exec);
    const target = fetchBranch(projectDir, remote, targetBranch, exec);
    const current = refSha(projectDir, targetBranch, exec);
    const candidate = SHA_RE.test(String(journal.candidate_sha || "")) ? journal.candidate_sha : null;

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

    const validation = workflow._validatePushCandidate({ pushBranch: targetBranch });
    if (!validation?.ok) {
      throw Object.assign(new Error(`Pairing promotion push gate failed: ${validation?.reason || "unknown"}`), {
        code: "pairing_promotion_gate_failed",
        validation,
      });
    }

    const refreshed = fetchBranch(projectDir, remote, targetBranch, exec);
    if (refreshed.sha !== journal.target_base_sha) {
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
    try {
      exec([
        "push",
        `--force-with-lease=refs/heads/${targetBranch}:${journal.target_base_sha}`,
        remote,
        `${journal.candidate_sha}:refs/heads/${targetBranch}`,
      ], projectDir);
    } catch (error) {
      journal = markPairingPromotion(journal, {
        phase: "candidate",
        last_error: "push_rejected_or_unavailable",
      });
      if (attempt + 1 < MAX_REBUILDS) continue;
      throw error;
    }
    const published = fetchBranch(projectDir, remote, targetBranch, exec);
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
  isAncestor,
  preserveCandidate,
  refSha,
});
