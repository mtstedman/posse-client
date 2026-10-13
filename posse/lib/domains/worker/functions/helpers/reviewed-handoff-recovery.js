import path from "node:path";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { now, runImmediateTransaction } from "../../../queue/functions/common.js";
import { reviewedTransfers, workItemBranchGeneration, transitionReviewedTransfer } from "../../../queue/functions/reviewed-handoff-records.js";
import { notifyQueueStateChanged } from "../../../queue/functions/wakeups.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { withWorktreeLockAsync } from "../../../git/functions/worktree.js";
import { withBranchLockAsync } from "../../../git/functions/worktree-locks.js";
import { recoverReviewedTransferCommit, reviewedWorkingObject } from "./reviewed-file-sync.js";
import { exactReviewedPath, reviewedFileObject, sameReviewedObject } from "../../../git/functions/reviewed-file-objects.js";
import { cancelUnusedReviewedTransfers } from "../../../queue/functions/reviewed-handoff-journal.js";
import { REVIEWED_HANDOFF_OUTCOMES, REVIEWED_HANDOFF_REASONS } from "../../../../catalog/reviewed-handoffs.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { logDurableEvent } from "../../../queue/functions/events.js";
import { reviewedTransferTelemetry, recordReviewedHandoffOperation } from "../../../observability/functions/reviewed-handoff-telemetry.js";

async function restoreUncommittedImport(cwd, transfer, options) {
  if (!transfer.target_head || String(await gitExecAsync(["rev-parse", "HEAD"], cwd, options)).trim() !== transfer.target_head) return false;
  const prefix = String(await gitExecAsync(["rev-parse", "--show-prefix"], cwd, options));
  if (transfer.files.some((file) => !exactReviewedPath(file.path) || file.repo_path !== `${prefix}${file.path}`)) return false;
  // Only erase bytes exactly explained by the journal. A changed index,
  // divergent file, or advanced branch remains an explicit recovery blocker.
  try {
    await gitExecAsync(["diff", "--cached", "--quiet", "--", ...transfer.files.map((file) => `:(literal)${file.path}`)], cwd, options);
    for (const file of transfer.files) {
      const before = await reviewedFileObject(cwd, transfer.target_head, file.repo_path, options);
      const current = await reviewedWorkingObject(cwd, file, options);
      if (!sameReviewedObject(current, before) && !sameReviewedObject(current, file.object)) return false;
    }
    for (const file of transfer.files) {
      const before = await reviewedFileObject(cwd, transfer.target_head, file.repo_path, options);
      if (before) await gitExecAsync(["restore", `--source=${transfer.target_head}`, "--worktree", "--", `:(literal)${file.path}`], cwd, options);
      else fs.rmSync(path.resolve(cwd, file.path), { force: true });
    }
    for (const file of transfer.files) {
      if (!sameReviewedObject(await reviewedWorkingObject(cwd, file, options),
        await reviewedFileObject(cwd, transfer.target_head, file.repo_path, options))) return false;
    }
    return true;
  } catch { return false; }
}

export async function reconcileCanceledReviewedImports(jobId, cwd, projectDir, { signal = null } = {}) {
  const db = getDb();
  const readJob = () => db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  const eligible = (job) => job && !job.lease_token && ["canceled", "dead_letter"].includes(job.status);
  const initial = readJob();
  if (!eligible(initial) || !reviewedTransfers(initial).length) return 0;
  const started = performance.now();
  const timing = { outcome: "completed", reason: null, transfer_count: reviewedTransfers(initial).length,
    worktree_lock_wait_ms: null, branch_lock_wait_ms: null, pending_count: null };
  let recovered = 0;
  try {
    await withWorktreeLockAsync(cwd, projectDir, async () => {
      timing.worktree_lock_wait_ms = performance.now() - started;
      const branch = String(await gitExecAsync(["branch", "--show-current"], cwd, { signal })).trim();
      const branchWait = performance.now();
      await withBranchLockAsync(cwd, branch, projectDir, async () => {
        timing.branch_lock_wait_ms = performance.now() - branchWait;
        for (const transfer of reviewedTransfers(readJob())) {
          const commit = await recoverReviewedTransferCommit(cwd, transfer, { signal });
          const initialWi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(readJob()?.work_item_id);
          if (!eligible(readJob()) || initialWi?.branch_name !== branch || workItemBranchGeneration(initialWi) !== transfer.receiver_generation) continue;
          const restored = !commit && await restoreUncommittedImport(cwd, transfer, { signal });
          if (!commit && !restored) continue; // Preserve unexplained bytes for reconciliation/discard.
          runImmediateTransaction(db, () => {
            const job = readJob();
            const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job?.work_item_id);
            if (!eligible(job) || wi?.branch_name !== branch || workItemBranchGeneration(wi) !== transfer.receiver_generation) return;
            const current = reviewedTransfers(job).find((entry) => entry.transfer_id === transfer.transfer_id);
            if (!current) return;
            if (restored) {
              const payload = parseJobPayload(job);
              payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.map((entry) => entry.transfer_id === current.transfer_id
                ? transitionReviewedTransfer(current, "blocked", { applying_at: null, rollback_verified_at: now() }) : entry);
              db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), jobId);
              recovered += cancelUnusedReviewedTransfers(jobId);
              return;
            }
            const applied = transitionReviewedTransfer(current, "applied", { sync_commit: commit, applied_at: now(), recovered: true,
              application_outcome: REVIEWED_HANDOFF_OUTCOMES.RECOVERED });
            const payload = parseJobPayload(job);
            payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.filter((entry) => entry.transfer_id !== current.transfer_id);
            payload._cross_wi_file_syncs_applied = [...(payload._cross_wi_file_syncs_applied || []), applied];
            db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), now(), jobId);
            logDurableEvent({ job_id: jobId, work_item_id: wi.id,
              event_type: EVENT_TYPES.WORK_ITEM_REVIEWED_TRANSFER_STATE, actor_type: EVENT_ACTORS.WORKER,
              message: "Recovered reviewed file transfer after cancellation",
              event_json: JSON.stringify(reviewedTransferTelemetry(applied, current)) });
            if (!reviewedTransfers({ payload_json: JSON.stringify(payload) }).length) {
              db.prepare("UPDATE job_file_locks SET released_at = ?, release_reason = 'reviewed_import_reconciled' WHERE job_id = ? AND released_at IS NULL").run(now(), jobId);
            }
            notifyQueueStateChanged({ reason: "reviewed_handoff_recovered", jobId, workItemId: wi.id });
            recovered++;
          });
        }
      }, { signal });
    }, { signal });
    return recovered;
  } catch (error) {
    timing.outcome = "failed";
    timing.reason = signal?.aborted ? "aborted" : error.code || "other";
    throw error;
  } finally {
    try {
      timing.pending_count = reviewedTransfers(readJob()).length;
      if (timing.pending_count && timing.outcome === "completed") {
        timing.outcome = "deferred"; timing.reason = REVIEWED_HANDOFF_REASONS.RECOVERY;
      }
    } catch { /* A telemetry read must not replace a recovery outcome. */ }
    recordReviewedHandoffOperation(initial, EVENT_TYPES.WORK_ITEM_REVIEWED_TRANSFER_RECOVERY,
      { ...timing, recovered_count: recovered, duration_ms: performance.now() - started });
  }
}

export async function reconcileReviewedHandoffsOnBoot(projectDir, { signal = null } = {}) {
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM jobs WHERE payload_json LIKE '%transfer_id%'").all().filter((job) => reviewedTransfers(job).length);
  if (!jobs.length) return { recovered: 0 };
  // One bounded retry per restart also reconciles an unknown Git outcome whose
  // HEAD did not move. Normal unchanged polls retain the cached blocker.
  runImmediateTransaction(db, () => {
    for (const job of jobs.filter((entry) => entry.status === "queued" && !entry.lease_token)) {
      const payload = parseJobPayload(job);
      payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.map((entry) => entry.transfer_id
        ? { ...entry, reconcile_requested_at: now() } : entry);
      db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND lease_token IS NULL")
        .run(JSON.stringify(payload), now(), job.id);
      notifyQueueStateChanged({ reason: "reviewed_handoff_reconcile", jobId: job.id, workItemId: job.work_item_id });
    }
  });
  const canceled = jobs.filter((job) => ["canceled", "dead_letter"].includes(job.status) && !job.lease_token);
  if (!canceled.length) return { recovered: 0 };
  const listed = String(await gitExecAsync(["worktree", "list", "--porcelain", "-z"], projectDir, { signal, trim: false }));
  const branches = new Map();
  let root = null;
  for (const field of listed.split("\0")) {
    if (field.startsWith("worktree ")) root = field.slice(9);
    if (field.startsWith("branch refs/heads/") && root) branches.set(field.slice(18), root);
  }
  const prefix = String(await gitExecAsync(["rev-parse", "--show-prefix"], projectDir, { signal }));
  let recovered = 0;
  for (const job of canceled) {
    const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job.work_item_id);
    const worktree = branches.get(wi?.branch_name);
    if (worktree) recovered += await reconcileCanceledReviewedImports(job.id, path.join(worktree, prefix), projectDir, { signal });
  }
  return { recovered };
}
