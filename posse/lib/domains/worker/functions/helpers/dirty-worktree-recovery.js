import {
  beginJobRetryGeneration, createJob, getAttempts, getJob, getWorkItem, listActiveFileLocks,
  requestParkedJobResumeAfterGate, runInTransaction, setAttemptCommitHash,
  setJobResult, storeArtifact, updateJobPayload,
} from "../../../queue/functions/index.js";
import { Scope } from "../../../../shared/scope/classes/Scope.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { activeLiveSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import { gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { gitCurrentHashAsync, gitExecAsync } from "../../../git/functions/utils.js";
import { worktreePathAsync } from "../../../git/functions/worktree.js";
import { DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE, DIRTY_WORKTREE_RECOVERY_KEY, humanInputChoicesForReviewType } from "../../../../catalog/human-input.js";
import { normalizeRepoPath, parsePorcelainEntries, payloadExplicitlyClaimsPath, unfinishedSiblingDirtyLocks } from "./worktree-dirty-classification.js";

export function parkDirtyWorktreeRecovery(worker, job, leaseToken, { paths, attemptId = null, output = "", phase = "commit" }) {
  const files = [...new Set(paths.map(normalizeRepoPath).filter(Boolean))];
  if (!files.length) return false;
  return runInTransaction(() => {
    if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human", { attemptId })) return false;
    if (output && attemptId) storeArtifact({ work_item_id: job.work_item_id, job_id: job.id,
      attempt_id: attemptId, artifact_type: "response", content_long: output });
    createJob({ work_item_id: job.work_item_id, parent_job_id: job.id, job_type: "human_input",
      title: `Recover dirty work: ${job.title}`.slice(0, 160), priority: "high",
      payload_json: JSON.stringify({
        review_type: DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE, original_job_id: job.id,
        choices: humanInputChoicesForReviewType(DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE),
        dirty_paths: files, recovery_phase: phase, source_attempt_id: attemptId,
        questions: [`Job #${job.id} has preserved uncommitted work. Commit includes the listed files and resumes validation; send_back adds them to the task scope and resumes development with your feedback; fail stops the job. The work is preserved while you decide.`],
        context: `Paused during ${phase}. Files to preserve or include:\n${files.map(file => `- ${file}`).join("\n")}`,
      }) });
    return true;
  });
}

export async function applyDirtyWorktreeRecovery({ worker, job, payload, action, feedback = "", operationKey, commitWork = gitCommitAllAsync }) {
  const original = getJob(payload.original_job_id);
  if (!original || !["waiting_on_human", "waiting_on_review", "blocked"].includes(original.status)) {
    throw new Error("The original job is no longer waiting for dirty-work recovery");
  }
  if (action === "fail") {
    await worker._setJobRowStatus(original, "failed");
    return;
  }
  if (!["commit", "send_back"].includes(action)) throw new Error("Choose commit, send_back, or fail");
  const cwd = await worktreePathAsync(worker.projectDir, original.work_item_id);
  const expectedBranch = getWorkItem(original.work_item_id)?.branch_name;
  const currentBranch = String(await gitExecAsync(["branch", "--show-current"], cwd)).trim();
  if (!expectedBranch || currentBranch !== expectedBranch) throw new Error("The recovery worktree is no longer on the job's branch");
  const next = parseJobPayload(original);
  const wasAssessOnly = next._assess_only;
  const priorRecovery = next[DIRTY_WORKTREE_RECOVERY_KEY];
  const continuingRecovery = priorRecovery?.gate_id === job.id;
  const priorCommits = priorRecovery?.commits || [];
  const requestedPaths = (payload.dirty_paths || []).map(normalizeRepoPath).filter(Boolean);
  const siblingPaths = new Set(unfinishedSiblingDirtyLocks(original, requestedPaths).map((lock) => lock.path));
  const paths = requestedPaths.filter((file) => !siblingPaths.has(file));
  const requiresDevelopment = (continuingRecovery && priorRecovery.requires_development === true)
    || Boolean(feedback) || paths.some(file => !payloadExplicitlyClaimsPath(next, file));
  const untracked = new Set(String(await gitExecAsync(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0"));
  const deleted = new Set(String(await gitExecAsync(["diff", "HEAD", "--no-renames", "--name-only", "--diff-filter=D", "-z"], cwd)).split("\0"));
  for (const file of paths) {
    const key = deleted.has(file) ? "files_to_delete" : untracked.has(file) ? "files_to_create" : "files_to_modify";
    next[key] = [...new Set([...(next[key] || []), file])];
  }
  const recoveryScope = new Scope({
    modifyFiles: [...(next.files_to_modify || []), ...(next.must_modify || [])],
    createFiles: next.files_to_create || [], deleteFiles: next.files_to_delete || [],
    createRoots: next.create_roots || [], cwd,
  });
  const liveLocks = activeLiveSiblingWriteLocks(original);
  if (recoveryScope.conflictsWith({
    modifyFiles: liveLocks.filter(lock => lock.lock_kind === "file").map(lock => lock.path),
    createRoots: liveLocks.filter(lock => lock.lock_kind === "root").map(lock => lock.path),
    cwd,
  })) throw new Error("Another job is writing the recovery scope; retry after it finishes");
  // Disjoint writers already coexist during ordinary scoped commits. Keep
  // their files/index entries intact through the same commit-scope policy.
  const base = action === "commit" ? await gitCurrentHashAsync(cwd) : null;
  const assessmentBase = continuingRecovery ? priorRecovery.assessment_base_hash ?? base : base;
  next[DIRTY_WORKTREE_RECOVERY_KEY] = { gate_id: job.id, paths, action, commits: priorCommits,
    requires_development: requiresDevelopment, assessment_base_hash: assessmentBase };
  next.instructions = [next.instructions || next.task_spec || original.title,
    `Operator authorized recovery of these existing files: ${paths.join(", ")}.`, feedback].filter(Boolean).join("\n\n");
  // Persist the authorized scope before committing: a crash may retry the
  // answer, but cannot leave a commit whose expanded scope was never recorded.
  updateJobPayload(original.id, JSON.stringify(next));
  // A failed commit leaves the gate open. Keep its original checkpoint in
  // storage until recovery succeeds. Retain the initial Git candidate and
  // scope/feedback requirements even when the answer is retried as a no-op.
  delete next._assess_only;
  if (action === "commit") {
    const dirtyPaths = parsePorcelainEntries(await gitExecAsync(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"], cwd, { trim: false })).map(entry => entry.path);
    const locks = listActiveFileLocks();
    const preservedLocks = unfinishedSiblingDirtyLocks(original, dirtyPaths);
    const result = await commitWork(`posse: recover job #${original.id}`, cwd, {
      modifyFiles: [...new Set([...(next.files_to_modify || []), ...(next.must_modify || [])])],
      createFiles: next.files_to_create || [], deleteFiles: next.files_to_delete || [], createRoots: next.create_roots || [],
    }, { projectDir: worker.projectDir, wiId: original.work_item_id, jobId: original.id,
      branchName: getWorkItem(original.work_item_id)?.branch_name, failOnOutOfScopeDirty: true,
      activeFileLocks: { ...locks, jobs: [...locks.jobs, ...preservedLocks] } });
    const attempts = getAttempts(original.id);
    const sourceAttempt = payload.source_attempt_id != null
      ? attempts.find(entry => entry.id === payload.source_attempt_id)
      : attempts.findLast(entry => entry.worker_type !== "assessor");
    if (result.createdCommit === true) {
      // Another writer can advance HEAD while the commit worker starts. Use
      // the actual commit's parent, and never attribute a no-op's HEAD to us.
      const commitBase = String(await gitExecAsync(["rev-parse", `${result.hash}^1`], cwd)).trim();
      const commit = { commit_hash: result.hash, commit_base_hash: commitBase };
      next[DIRTY_WORKTREE_RECOVERY_KEY].commits = [...priorCommits, commit];
      if (sourceAttempt && !sourceAttempt.commit_hash) setAttemptCommitHash(sourceAttempt.id, result.hash, commitBase);
      setJobResult(original.id, { commit_hash: result.hash, recovery_gate_id: job.id });
    }
    // A stale prompt can be answered after the owner already committed. Keep
    // the completed assessment checkpoint only when neither scope nor tree
    // changed. A new candidate still needs fresh developer validation.
    if (wasAssessOnly && !requiresDevelopment && result.hash === base && base === assessmentBase) next._assess_only = wasAssessOnly;
  }
  if (next._assess_only) updateJobPayload(original.id, JSON.stringify(next));
  else beginJobRetryGeneration(original.id, { payload: next });
  const resumed = requestParkedJobResumeAfterGate({ gateJobId: job.id, originalJobId: original.id,
    operationKey, reason: `dirty_worktree_${action}` });
  if (!resumed.ok) throw new Error(`Could not resume the recovered job: ${resumed.reason}`);
}
