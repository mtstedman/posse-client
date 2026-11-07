import { MUTATING_JOB_TYPES } from "../../../../catalog/job.js";
import { WAIVED_WORK_COMMIT_TRAILER, WAIVED_WORK_FINALIZATION_KEY } from "../../../../catalog/human-input.js";
import { Scope } from "../../../../shared/scope/classes/Scope.js";
import { finalReviewIdentity } from "../../../assessment/functions/final-review-authority.js";
import { gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { restoreScopedSnapshotAsync } from "../../../git/functions/restore-scoped-snapshot.js";
import { listSnapshotRefsAsync, SNAPSHOT_REF_PREFIX } from "../../../git/functions/worktree-snapshots.js";
import { gitCurrentHashAsync, gitExecAsync } from "../../../git/functions/utils.js";
import { withWorktreeLockAsync, worktreePathAsync } from "../../../git/functions/worktree.js";
import { getAttempts, getDependencies, getJob, getWorkItem, listActiveFileLocks, listJobsByWorkItem,
  setAttemptCommitHash, setJobResult, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { activeLiveSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import { parsePorcelainEntries, unfinishedSiblingDirtyLocks } from "./worktree-dirty-classification.js";

function dependsOn(jobId, predecessorId, seen = new Set()) {
  if (seen.has(jobId)) return false;
  seen.add(jobId);
  return getDependencies(jobId).some(edge => edge.dependency_kind === "hard"
    && (edge.depends_on_job_id === predecessorId || dependsOn(edge.depends_on_job_id, predecessorId, seen)));
}

export async function finalizeWaivedJobWork(worker, original, { gateId = null, commitWork = gitCommitAllAsync, preserveSuccessors = false } = {}) {
  const job = getJob(original.id) || original;
  const payload = parseJobPayload(job);
  const attempt = getAttempts(job.id).findLast(entry => entry.worker_type !== "assessor");
  if (!MUTATING_JOB_TYPES.has(job.job_type) || payload.task_mode === "db" || !attempt || attempt.commit_hash) return;
  const cwd = await worktreePathAsync(worker.projectDir, job.work_item_id);
  let scope = new Scope({ modifyFiles: [...(payload.files_to_modify || []), ...(payload.must_modify || [])],
    createFiles: payload.files_to_create || [], deleteFiles: payload.files_to_delete || [],
    createRoots: payload.create_roots || [], cwd });
  if (scope.isEmpty()) return; // A waiver does not grant an unscoped commit.
  return await withWorktreeLockAsync(cwd, worker.projectDir, async () => {
    let receipt = payload[WAIVED_WORK_FINALIZATION_KEY];
    if (receipt?.attempt_id !== attempt.id) receipt = null;
    if (receipt?.complete) return;
    if (receipt?.scope) scope = new Scope({ ...receipt.scope, cwd });
    const branch = getWorkItem(job.work_item_id)?.branch_name;
    if (!branch || String(await gitExecAsync(["branch", "--show-current"], cwd)).trim() !== branch) {
      throw new Error("Cannot finalize waived work: the worktree is on a different branch");
    }
    const dirty = parsePorcelainEntries(await gitExecAsync([
      "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all",
    ], cwd, { trim: false })).map(entry => entry.path);
    // Git's ordinary status hides ignored declared tests. Include only exact
    // owned paths here, not whole ignored dependency/build directories.
    if (scope.allFiles().length) dirty.push(...String(await gitExecAsync([
      "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
      "--", ...scope.allFiles().map(file => `:(literal)${file}`),
    ], cwd, { trim: false })).split("\0").filter(Boolean));
    const overlapping = unfinishedSiblingDirtyLocks(job, dirty.filter(file => scope.contains(file)), { includeCurrentScope: true });
    const superseded = new Set();
    for (const lock of overlapping) {
      const ownerAttempt = getAttempts(lock.job_id).findLast(entry => entry.worker_type !== "assessor");
      if (preserveSuccessors && job.status === "succeeded" && job.assessment_state === "assessment_waived"
        && dependsOn(lock.job_id, job.id)
        && Date.parse(ownerAttempt?.started_at) >= Date.parse(job.assessment_completed_at || attempt.finished_at)) {
        superseded.add(lock.path);
      } else throw new Error(`Cannot attribute waived job #${job.id}'s work shared with another unfinished attempt: ${lock.path}`);
    }
    if (superseded.size) scope = new Scope({
      modifyFiles: [...new Set([...scope.modifyFiles, ...dirty.filter(file => scope.contains(file))])].filter(file => !superseded.has(file)),
      createFiles: scope.createFiles.filter(file => !superseded.has(file)),
      deleteFiles: scope.deleteFiles.filter(file => !superseded.has(file)), cwd,
    });
    const liveLocks = activeLiveSiblingWriteLocks(job);
    if (scope.conflictsWith({
      modifyFiles: liveLocks.filter(lock => lock.lock_kind === "file").map(lock => lock.path),
      createRoots: liveLocks.filter(lock => lock.lock_kind === "root").map(lock => lock.path), cwd,
    })) throw new Error("Cannot finalize waived work while another job is writing its scope");
    const identityPayload = { ...payload, files_to_modify: scope.modifyFiles, must_modify: [],
      files_to_create: scope.createFiles, files_to_delete: scope.deleteFiles, create_roots: scope.createRoots };

    if (!receipt) {
      // Older clients reset blocked candidates. Only consider snapshots from
      // this exact job and implementation attempt; retain the ref afterward.
      const prefix = `${SNAPSHOT_REF_PREFIX}/wi-${job.work_item_id}-blocked-job-${job.id}-`;
      const snapshots = (await listSnapshotRefsAsync(worker.projectDir)).filter(entry =>
        entry.refName.startsWith(prefix) && entry.createdMs >= Date.parse(attempt.started_at)
        && (!attempt.finished_at || entry.createdMs <= Date.parse(attempt.finished_at) + 1000));
      if (snapshots.length > 1) throw new Error(`Multiple recovery snapshots match job #${job.id}; refusing an ambiguous restore`);
      if (snapshots.length) await restoreScopedSnapshotAsync(cwd, snapshots[0].refName, scope);
      receipt = { attempt_id: attempt.id, gate_id: gateId,
        base_hash: await gitCurrentHashAsync(cwd),
        identity: await finalReviewIdentity(cwd, identityPayload, { jobId: job.id }),
        scope: scope.toJSON(), superseded_paths: [...superseded],
        snapshot_ref: snapshots[0]?.refName || null };
      payload[WAIVED_WORK_FINALIZATION_KEY] = receipt;
      updateJobPayload(job.id, JSON.stringify(payload));
    } else if (receipt.identity !== await finalReviewIdentity(cwd, identityPayload, { jobId: job.id })) {
      throw new Error("Waived candidate changed during recovery; refusing to accept different work");
    }
    const marker = `${WAIVED_WORK_COMMIT_TRAILER}: ${job.id}/${attempt.id}`;
    const message = `posse: finalize waived job #${job.id} attempt #${attempt.id}\n\n${marker}`;
    // A Git commit may have completed before the answer owner crashed. Find
    // that exact operation instead of attributing a sibling's HEAD to this job.
    const matches = String(await gitExecAsync([
      "log", "--format=%H", `--grep=^${marker}$`, `${receipt.base_hash}..HEAD`,
    ], cwd)).trim().split(/\s+/).filter(Boolean);
    if (matches.length > 1) throw new Error("Waiver recovery found multiple commits for one operation");
    let commitHash = matches[0] || null;
    if (!commitHash && !scope.isEmpty()) {
      const commitDirty = parsePorcelainEntries(await gitExecAsync([
        "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all",
      ], cwd, { trim: false })).map(entry => entry.path);
      const locks = listActiveFileLocks();
      const preservationJob = { ...job, payload_json: JSON.stringify(identityPayload) };
      const result = await commitWork(message, cwd, scope.toJSON(), {
        projectDir: worker.projectDir, wiId: job.work_item_id, jobId: job.id, branchName: branch,
        worktreeLock: false, failOnOutOfScopeDirty: true,
        activeFileLocks: { ...locks, jobs: [...locks.jobs, ...unfinishedSiblingDirtyLocks(preservationJob, commitDirty)] },
      });
      if (result.createdCommit) commitHash = result.hash;
    }
    if (commitHash) {
      const committedPaths = String(await gitExecAsync([
        "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitHash,
      ], cwd, { trim: false })).split("\0").filter(Boolean);
      if (committedPaths.some(file => !scope.contains(file))) throw new Error("Waiver commit contains files outside its owner's scope");
      const base = String(await gitExecAsync(["rev-parse", `${commitHash}^1`], cwd)).trim();
      setAttemptCommitHash(attempt.id, commitHash, base);
      setJobResult(job.id, { commit_hash: commitHash, waiver_gate_id: gateId });
    }
    payload[WAIVED_WORK_FINALIZATION_KEY] = { ...receipt, complete: true, commit_hash: commitHash };
    updateJobPayload(job.id, JSON.stringify(payload));
  });
}

// Existing waivers are already operator authorization. Repair their pending
// Git phase under their original scopes before retrying a recovery commit.
export async function finalizePreviouslyWaivedWork(worker, original) {
  for (const job of listJobsByWorkItem(original.work_item_id)) {
    if (job.id !== original.id && job.status === "succeeded" && job.assessment_state === "assessment_waived") {
      await finalizeWaivedJobWork(worker, job, { preserveSuccessors: true });
    }
  }
}
