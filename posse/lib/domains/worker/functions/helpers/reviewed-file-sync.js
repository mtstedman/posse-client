import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gitExecAsync, gitCurrentHashAsync } from "../../../git/functions/utils.js";
import { gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { withWorktreeLockAsync, isMergeInProgressAsync } from "../../../git/functions/worktree.js";
import { withBranchLockAsync } from "../../../git/functions/worktree-locks.js";
import { reviewedFileObject, sameReviewedObject, exactReviewedPath } from "../../../git/functions/reviewed-file-objects.js";
import { captureReviewedDestination } from "../../../git/functions/reviewed-destination-state.js";
import { reviewedTransfers, workItemBranchGeneration, reviewedSourceMergeProof } from "../../../queue/functions/reviewed-handoff-records.js";
import { cancelUnusedReviewedTransfers, reviewedTransferOwner, updateReviewedTransfer } from "../../../queue/functions/reviewed-handoff-journal.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { REVIEWED_HANDOFF_REASONS as REASONS, REVIEWED_HANDOFF_TRAILER, REVIEWED_HANDOFF_OUTCOMES as OUTCOMES } from "../../../../catalog/reviewed-handoffs.js";
import { EVENT_TYPES } from "../../../../catalog/event.js";
import { recordReviewedHandoffOperation } from "../../../observability/functions/reviewed-handoff-telemetry.js";

function deferred(reason, message) {
  return Object.assign(new Error(message), { code: reason, reviewedHandoffDeferred: true, retryable: true });
}

export function guardReviewedWorktreeReuse(job, leaseToken, phase) {
  const fresh = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  const pending = reviewedTransfers(fresh);
  if (!pending.length && !reviewedTransfers(job).length) return;
  for (const transfer of pending) {
    try { updateReviewedTransfer(job.id, transfer, leaseToken, "blocked", { reason: REASONS.RECOVERY }); }
    catch { /* A lost lease cannot authorize filesystem recovery either. */ }
  }
  throw Object.assign(deferred(REASONS.RECOVERY, `Reviewed import requires reconciliation before ${phase}`), { deferWorktreeCleanup: true });
}

async function verifyObjects(cwd, revision, entries, options) {
  for (const entry of entries) {
    if (!sameReviewedObject(entry.object, await reviewedFileObject(cwd, revision, entry.repo_path, options))) return false;
  }
  return true;
}

export async function reviewedWorkingObject(cwd, entry, options) {
  const absolute = path.resolve(cwd, entry.path);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  // Avoid following an ancestor symlink, even when Git would accept the path.
  const root = fs.realpathSync(cwd);
  if (!fs.realpathSync(path.dirname(absolute)).startsWith(root + path.sep) && fs.realpathSync(path.dirname(absolute)) !== root) throw deferred(REASONS.DESTINATION, "Transfer path escapes worktree");
  if (!stat.isFile()) throw deferred(REASONS.DESTINATION, "Transfer destination is not a regular file");
  const oid = String(await gitExecAsync(["hash-object", `--path=${entry.path}`, "--", entry.path], cwd, options)).trim();
  let mode = stat.mode & 0o111 ? "100755" : "100644";
  // On filesystems without executable bits Git preserves the index mode.
  const fileMode = String(await gitExecAsync(["config", "--type=bool", "--default=true", "core.filemode"], cwd, options)).trim();
  if (fileMode === "false") {
    const index = String(await gitExecAsync(["ls-files", "--stage", "-z", "--", `:(literal)${entry.path}`], cwd, options));
    mode = /^(100644|100755) [a-f0-9]+ 0\t/.exec(index)?.[1] || "100644";
  }
  return { oid, mode };
}

async function blockDestination(jobId, transfer, leaseToken, cwd, reason, options) {
  let snapshot = null;
  try { snapshot = await captureReviewedDestination(cwd, transfer, options); }
  catch { /* Explicit retry/boot reconciliation can recover unreadable state. */ }
  return updateReviewedTransfer(jobId, transfer, leaseToken, "blocked", { reason,
    blocked_head: await gitCurrentHashAsync(cwd, options), blocked_destination: snapshot });
}

export async function recoverReviewedTransferCommit(cwd, transfer, options = {}) {
  const hashes = String(await gitExecAsync(["log", "--format=%H", "--fixed-strings", `--grep=${REVIEWED_HANDOFF_TRAILER}: ${transfer.transfer_id}`, "HEAD"], cwd, options)).split("\n").filter(Boolean);
  for (const hash of hashes) {
    const message = String(await gitExecAsync(["show", "-s", "--format=%B", hash], cwd, options));
    if (!message.split("\n").includes(`${REVIEWED_HANDOFF_TRAILER}: ${transfer.transfer_id}`)) continue;
    if (transfer.target_head && String(await gitExecAsync(["rev-parse", `${hash}^`], cwd, options)).trim() !== transfer.target_head) continue;
    const paths = String(await gitExecAsync(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", hash], cwd, { ...options, trim: false })).split("\0").filter(Boolean);
    if (paths.some((file) => !transfer.files.some((entry) => entry.repo_path === file))) throw deferred(REASONS.RECOVERY, "Recovered transfer commit includes unauthorized paths");
    if (await verifyObjects(cwd, hash, transfer.files, options)) return hash;
  }
  return null;
}

// Setup normally snapshots and cleans leftover files before target refresh.
// A promised import must instead preserve any pre-existing destination edits.
export async function guardReviewedTransferSetup(worker, job, cwd, { signal = null } = {}) {
  const db = getDb();
  const transfers = reviewedTransfers(db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id));
  if (!transfers.length) return;
  await withWorktreeLockAsync(cwd, worker.projectDir, async () => {
    for (const transfer of transfers) {
      if (transfer.applying_at) continue; // The journal recovery runs first.
      const lease = job._leaseToken || job.lease_token;
      reviewedTransferOwner(job.id, transfer, lease);
      const paths = [...transfer.files, ...transfer.read_inputs].map((file) => `:(literal)${file.path}`);
      try {
        if (await isMergeInProgressAsync(cwd, { signal })
            || String(await gitExecAsync(["status", "--porcelain", "--untracked-files=all", "--ignored", "--", ...paths], cwd, { signal }))) {
          throw deferred(REASONS.DESTINATION, "Reviewed transfer preserves existing destination edits or merge conflicts");
        }
        const head = await gitCurrentHashAsync(cwd, { signal });
        for (const file of [...transfer.files, ...transfer.read_inputs]) {
          if (!sameReviewedObject(await reviewedWorkingObject(cwd, file, { signal }),
            await reviewedFileObject(cwd, head, file.repo_path, { signal }))) {
            throw deferred(REASONS.DESTINATION, `Reviewed transfer preserves uncommitted changes to ${file.path}`);
          }
        }
      } catch (error) {
        await blockDestination(job.id, transfer, lease, cwd, REASONS.DESTINATION, { signal });
        error.reviewedHandoffDeferred = true;
        throw error;
      }
    }
  }, { signal });
}

export async function applyReviewedFileTransfers(worker, job, cwd, { signal = null } = {}) {
  const db = getDb();
  const readJob = () => db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  const transferCount = reviewedTransfers(readJob()).length;
  if (!transferCount) return;
  const leaseToken = job._leaseToken || job.lease_token;
  const options = { signal };
  const started = performance.now();
  const timing = { transfer_count: transferCount, outcome: "completed", reason: null,
    worktree_lock_wait_ms: null, branch_lock_wait_ms: null };
  try {
    await withWorktreeLockAsync(cwd, worker.projectDir, async () => {
      timing.worktree_lock_wait_ms = performance.now() - started;
      const branch = String(await gitExecAsync(["branch", "--show-current"], cwd, options)).trim();
      if (!branch) throw deferred(REASONS.DESTINATION, "Reviewed transfer requires a receiver branch");
      const branchWait = performance.now();
      await withBranchLockAsync(cwd, branch, worker.projectDir, async () => {
        timing.branch_lock_wait_ms = performance.now() - branchWait;
        const prefix = String(await gitExecAsync(["rev-parse", "--show-prefix"], cwd, options));
        for (let transfer of reviewedTransfers(readJob())) {
          try {
            const owner = reviewedTransferOwner(job.id, transfer, leaseToken);
            if (await isMergeInProgressAsync(cwd, options)) throw deferred(REASONS.DESTINATION, "Reviewed transfer cannot run during a merge");
            if (branch !== owner.workItem.branch_name) throw deferred(REASONS.DESTINATION, "Receiver is on a different branch");
            transfer = owner.transfer;
            const head = await gitCurrentHashAsync(cwd, options);
            const recovered = await recoverReviewedTransferCommit(cwd, transfer, options);
            if (recovered) {
              updateReviewedTransfer(job.id, transfer, leaseToken, "applied", { sync_commit: recovered, applied_at: new Date().toISOString(),
                recovered: true, application_outcome: OUTCOMES.RECOVERED });
              continue;
            }
            const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(transfer.source_work_item_id);
            if (!source || ["failed", "canceled"].includes(source.status)
                || transfer.source_generation !== workItemBranchGeneration(source)) {
              cancelUnusedReviewedTransfers(job.id, { staleOnly: true, leaseToken });
              throw deferred(REASONS.GENERATION, "Reviewed source generation is no longer valid");
            }
            for (const file of [...transfer.files, ...transfer.read_inputs]) {
              if (!exactReviewedPath(file.path) || file.repo_path !== `${prefix}${file.path}`) throw deferred(REASONS.SCOPE, "Reviewed transfer path is incompatible with receiver scope");
            }
            if (!await verifyObjects(cwd, transfer.source_commit, transfer.files, options)) throw deferred(REASONS.SOURCE, "Pinned source objects do not match the receipt");
            if (source.merge_state === "merged") {
              const proof = reviewedSourceMergeProof(source, transfer);
              if (!proof) throw deferred(REASONS.INCOMPLETE, "Source merge has no proof for this reviewed generation");
              try { await gitExecAsync(["merge-base", "--is-ancestor", proof.merge_commit, head], cwd, options); }
              catch { throw deferred(REASONS.RECOVERY, "Receiver has not integrated the accepted source merge"); }
              const deletedPaths = [];
              for (const file of transfer.files) if (await reviewedFileObject(cwd, head, file.repo_path, options) == null) deletedPaths.push(file.path);
              updateReviewedTransfer(job.id, transfer, leaseToken, "applied", { sync_commit: head, integrated: true, deleted_paths: deletedPaths, applied_at: new Date().toISOString(),
                application_outcome: OUTCOMES.INTEGRATED });
              continue;
            }
            if (!await verifyObjects(cwd, head, transfer.read_inputs, options)) throw deferred(REASONS.INPUT, "Receiver read inputs differ from the accepted review");
            for (const input of transfer.read_inputs) {
              if (String(await gitExecAsync(["status", "--porcelain", "--untracked-files=all", "--ignored", "--", `:(literal)${input.path}`], cwd, options))
                  || !sameReviewedObject(await reviewedWorkingObject(cwd, input, options), input.object)) throw deferred(REASONS.INPUT, "Receiver read inputs have uncommitted changes");
            }
            const alreadyPresent = await verifyObjects(cwd, head, transfer.files, options);
            const resume = transfer.state === "applying" || !!transfer.applying_at;
            const materialize = [];
            for (const file of transfer.files) {
              const current = await reviewedFileObject(cwd, head, file.repo_path, options);
              if (!sameReviewedObject(current, file.base) && !sameReviewedObject(current, file.object)) throw deferred(REASONS.DESTINATION, `Receiver changed ${file.path}`);
              // Materialization changes only the working tree. New staging on a
              // reserved path is never explained by an interrupted import.
              try { await gitExecAsync(["diff", "--cached", "--quiet", "--", `:(literal)${file.path}`], cwd, options); }
              catch { throw deferred(REASONS.DESTINATION, `Receiver has staged changes to ${file.path}`); }
              const dirty = String(await gitExecAsync(["status", "--porcelain", "--untracked-files=all", "--ignored", "--", `:(literal)${file.path}`], cwd, options));
              const working = await reviewedWorkingObject(cwd, file, options);
              if ((dirty || !sameReviewedObject(working, current))
                  && !(resume && sameReviewedObject(working, file.object))) throw deferred(REASONS.DESTINATION, `Receiver has uncommitted changes to ${file.path}`);
              if (!sameReviewedObject(working, file.object)) materialize.push(file);
            }
            if (alreadyPresent) {
              updateReviewedTransfer(job.id, transfer, leaseToken, "applied", { sync_commit: head, integrated: source.merge_state === "merged", applied_at: new Date().toISOString(),
                application_outcome: OUTCOMES.PRESENT });
              continue;
            }
            transfer = updateReviewedTransfer(job.id, transfer, leaseToken, "applying", { target_head: head, applying_at: transfer.applying_at || new Date().toISOString() });
            // An absent path already satisfies a deletion. Restoring it when it
            // is absent from both source and index would fail with a pathspec error.
            for (const file of materialize) {
              reviewedTransferOwner(job.id, transfer, leaseToken);
              if (file.object?.mode === "120000") throw deferred(REASONS.SCOPE, "Symlink transfers require explicit reconciliation");
              await gitExecAsync(["restore", `--source=${transfer.source_commit}`, "--worktree", "--", `:(literal)${file.path}`], cwd, options);
            }
            reviewedTransferOwner(job.id, transfer, leaseToken);
            if (await gitCurrentHashAsync(cwd, options) !== head) throw deferred(REASONS.DESTINATION, "Receiver HEAD moved during transfer");
            const result = await gitCommitAllAsync(`posse: sync cross-WI file handoff for job #${job.id}\n\n${REVIEWED_HANDOFF_TRAILER}: ${transfer.transfer_id}`, cwd, {
              modifyFiles: transfer.files.filter((file) => file.base && file.object).map((file) => file.path),
              deleteFiles: transfer.files.filter((file) => !file.object).map((file) => file.path),
              createFiles: transfer.files.filter((file) => !file.base && file.object).map((file) => file.path), createRoots: [],
            }, { projectDir: worker.projectDir, wiId: job.work_item_id, jobId: job.id, expectedHead: head, worktreeLock: false, branchLock: false });
            if (!await verifyObjects(cwd, result.hash, transfer.files, options)) throw deferred(REASONS.RECOVERY, "Reviewed sync commit failed object verification");
            updateReviewedTransfer(job.id, transfer, leaseToken, "applied", { sync_commit: result.hash, applied_at: new Date().toISOString(),
              application_outcome: resume ? OUTCOMES.RESUMED : OUTCOMES.COPIED });
          } catch (error) {
            // A missing applied flag is never authority to return ownership.
            try { await blockDestination(job.id, transfer, leaseToken, cwd, error.code || REASONS.RECOVERY, options); } catch { /* Lost lease: leave the prior durable journal untouched. */ }
            error.reviewedHandoffDeferred = true;
            throw error;
          }
        }
      }, options);
    }, options);
    job.payload_json = readJob().payload_json;
  } catch (error) {
    timing.outcome = error.reviewedHandoffDeferred ? "deferred" : "failed";
    timing.reason = error.code || (signal?.aborted ? "aborted" : "other");
    throw error;
  } finally {
    recordReviewedHandoffOperation(job, EVENT_TYPES.WORK_ITEM_REVIEWED_TRANSFER_SETUP,
      { ...timing, duration_ms: performance.now() - started });
  }
}
