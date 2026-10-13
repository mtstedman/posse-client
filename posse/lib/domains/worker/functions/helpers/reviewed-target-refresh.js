import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { isLeaseValid } from "../../../queue/functions/attempts.js";
import { getWorkItemMergeDependencies } from "../../../queue/functions/cross-wi-deps.js";
import { activeLiveSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import { reviewedTransfers, reviewedSourceMergeProof, workItemBranchGeneration } from "../../../queue/functions/reviewed-handoff-records.js";
import { createGitWorkflowContext } from "../../../git/functions/workflow-context.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { withBranchLockAsync } from "../../../git/functions/worktree-locks.js";
import { REVIEWED_HANDOFF_REASONS, REVIEWED_REFRESH_TASK, REVIEWED_REFRESH_REF_PREFIX } from "../../../../catalog/reviewed-handoffs.js";
import { EVENT_TYPES } from "../../../../catalog/event.js";
import { recordReviewedHandoffOperation, reviewedHandoffReason } from "../../../observability/functions/reviewed-handoff-telemetry.js";

function defer(message) {
  return Object.assign(new Error(message), { code: REVIEWED_HANDOFF_REASONS.RECOVERY, reviewedHandoffDeferred: true });
}

function settledSnapshot(job, leaseToken) {
  const db = getDb();
  const fresh = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(fresh?.work_item_id);
  if (!fresh || fresh.lease_token !== leaseToken || !isLeaseValid(job.id, leaseToken)
      || !wi?.branch_name || ["failed", "canceled"].includes(wi.status) || wi.merge_state === "merged") throw defer("Target refresh lost its receiver lease or branch");
  const jobs = db.prepare("SELECT * FROM jobs WHERE work_item_id = ? ORDER BY id").all(wi.id);
  const generation = workItemBranchGeneration(wi);
  const dependencies = getWorkItemMergeDependencies(wi);
  const settled = [];
  for (const sourceJob of jobs) {
    for (const transfer of reviewedTransfers(sourceJob, { applied: true })) {
      if (transfer.integrated || transfer.receiver_generation !== generation) continue;
      if (!transfer.files.every((file) => dependencies.some((dep) => dep.transfer_id === transfer.transfer_id
          && dep.receipt_id === transfer.receipt_id && dep.source_generation === transfer.source_generation
          && dep.source_work_item_id === transfer.source_work_item_id && dep.path === file.path))) continue;
      const proofs = [transfer, ...(transfer.required_provenance || [])].map((entry) => {
        const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(entry.source_work_item_id);
        return source?.merge_state === "merged" && !["failed", "canceled"].includes(source.status)
          ? reviewedSourceMergeProof(source, entry) : null;
      });
      if (proofs.some((proof) => !proof?.merge_commit)) continue;
      settled.push({ transfer, mergeCommits: [...new Set(proofs.map((proof) => proof.merge_commit))] });
    }
  }
  return { job: fresh, branch: wi.branch_name, settled,
    unresolved: jobs.some((entry) => reviewedTransfers(entry).some((transfer) => transfer.applying_at)),
    key: JSON.stringify([wi.branch_name, generation, settled, dependencies]) };
}

function assertIdle(snapshot) {
  if (snapshot.unresolved) throw defer("Target refresh waits for an unresolved reviewed import");
  if (activeLiveSiblingWriteLocks(snapshot.job).length) {
    throw Object.assign(new Error("Target refresh waits for live same-WI work"), { code: "WORKTREE_ACTIVE_SIBLING_LOCKS" });
  }
}

// Caller holds the receiver worktree lock. Preparation runs in an isolated
// worker; cancellation or an expired lease cannot leave its checkout detached.
// null means the existing native merge/developer conflict path still applies.
export async function refreshSettledReviewedTargetAsync(worker, job, leaseToken, cwd, targetBranch, { signal = null } = {}) {
  const initial = settledSnapshot(job, leaseToken);
  if (!initial.settled.length) return null;
  const started = performance.now();
  const timing = { transfer_count: initial.settled.length, outcome: "completed", reason: null,
    branch_lock_wait_ms: null, preparation_ms: null, publication_ms: null, dropped_copy_count: 0 };
  try {
    return await withBranchLockAsync(cwd, initial.branch, worker.projectDir, async () => {
      timing.branch_lock_wait_ms = performance.now() - started;
      const snapshot = settledSnapshot(job, leaseToken);
      assertIdle(snapshot);
      const exec = (args) => gitExecAsync(args, cwd, { signal });
      if (String(await exec(["branch", "--show-current"])).trim() !== snapshot.branch) throw defer("Target refresh found a different receiver branch");
      const branchHead = String(await exec(["rev-parse", "HEAD"])).trim();
      const targetHead = String(await exec(["rev-parse", "--verify", `${targetBranch}^{commit}`])).trim();
      try {
        await exec(["merge-base", "--is-ancestor", targetHead, branchHead]);
        timing.outcome = "unchanged"; timing.reason = "already_on_target";
        return null;
      }
      catch (error) { if (error.status !== 1 && error.code !== 1) throw error; }
      if (String(await exec(["status", "--porcelain", "--untracked-files=all"]))) {
        timing.outcome = "fallback"; timing.reason = "dirty_receiver";
        return null;
      }
      // A clean index can still be in a paused merge/cherry-pick/rebase.
      for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        try {
          await exec(["rev-parse", "--verify", name]);
          timing.outcome = "fallback"; timing.reason = "operation_in_progress";
          return null;
        }
        catch (error) { if (error.status !== 128 && error.code !== 128) throw error; }
      }
      const resultRef = `${REVIEWED_REFRESH_REF_PREFIX}${randomUUID()}`;
      const context = createGitWorkflowContext({ projectDir: worker.projectDir, targetBranch });
      try {
        const preparationStarted = performance.now();
        let result;
        try {
          result = await context.runGitWorkflowTaskOffMainThread(REVIEWED_REFRESH_TASK, {
            projectDir: worker.projectDir, branchHead, targetHead, settled: snapshot.settled, resultRef,
          }, { signal });
        } finally { timing.preparation_ms = performance.now() - preparationStarted; }
        const current = settledSnapshot(job, leaseToken);
        assertIdle(current);
        if (current.key !== snapshot.key) throw defer("Reviewed source or receiver authority changed during target refresh");
        if (!result.prepared) {
          timing.outcome = "fallback";
          timing.reason = reviewedHandoffReason(result.reason) === "other" ? "clean_replay_declined" : result.reason;
          return null;
        }
        if (String(await exec(["branch", "--show-current"])).trim() !== snapshot.branch
            || String(await exec(["rev-parse", "HEAD"])).trim() !== branchHead
            || String(await exec(["rev-parse", "--verify", `${targetBranch}^{commit}`])).trim() !== targetHead
            || String(await exec(["status", "--porcelain", "--untracked-files=all"]))) throw defer("Receiver or target changed during target refresh");
        // Recheck database ownership after the asynchronous Git reads as well.
        const owner = settledSnapshot(job, leaseToken);
        assertIdle(owner);
        if (owner.key !== snapshot.key) throw defer("Reviewed authority changed before target integration");
        const publicationStarted = performance.now();
        try { await exec(["merge", "--ff-only", "--no-overwrite-ignore", result.commit]); }
        finally { timing.publication_ms = performance.now() - publicationStarted; }
        timing.dropped_copy_count = result.dropped.length;
        return { ok: true, updated: true, mergeCommit: result.commit, reviewedRefresh: true, dropped: result.dropped };
      } finally {
        // The merge, if published, retains the prepared tree. A killed worker
        // can at worst leave a private ref/worktree; receiver history is intact.
        try { await gitExecAsync(["update-ref", "-d", resultRef], cwd); } catch { /* Safe retained scratch ref. */ }
      }
    }, { signal });
  } catch (error) {
    timing.outcome = "deferred";
    timing.reason = signal?.aborted ? "aborted" : error.code || "other";
    error.reviewedHandoffDeferred = true;
    throw error;
  } finally {
    recordReviewedHandoffOperation(job, EVENT_TYPES.WORK_ITEM_REVIEWED_TARGET_REFRESH,
      { ...timing, duration_ms: performance.now() - started });
  }
}
