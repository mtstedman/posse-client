import {
  beginJobRetryGeneration, createJob, getAttempts, getJob, getWorkItem,
  requestParkedJobResumeAfterGate, runInTransaction, setAttemptCommitHash,
  setJobResult, storeArtifact, updateJobPayload,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { activeLiveSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import { gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { gitCurrentHashAsync, gitExecAsync } from "../../../git/functions/utils.js";
import { worktreePathAsync } from "../../../git/functions/worktree.js";
import { DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE, DIRTY_WORKTREE_RECOVERY_KEY, humanInputChoicesForReviewType } from "../../../../catalog/human-input.js";
import { normalizeRepoPath } from "./worktree-dirty-classification.js";

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

export async function applyDirtyWorktreeRecovery({ worker, job, payload, action, feedback = "", operationKey }) {
  const original = getJob(payload.original_job_id);
  if (!original || !["waiting_on_human", "waiting_on_review", "blocked"].includes(original.status)) {
    throw new Error("The original job is no longer waiting for dirty-work recovery");
  }
  if (action === "fail") {
    await worker._setJobRowStatus(original, "failed");
    return;
  }
  if (!["commit", "send_back"].includes(action)) throw new Error("Choose commit, send_back, or fail");
  if (activeLiveSiblingWriteLocks(original).length) throw new Error("Another job is writing this worktree; retry after it finishes");
  const cwd = await worktreePathAsync(worker.projectDir, original.work_item_id);
  const expectedBranch = getWorkItem(original.work_item_id)?.branch_name;
  const currentBranch = String(await gitExecAsync(["branch", "--show-current"], cwd)).trim();
  if (!expectedBranch || currentBranch !== expectedBranch) throw new Error("The recovery worktree is no longer on the job's branch");
  const next = parseJobPayload(original);
  const paths = (payload.dirty_paths || []).map(normalizeRepoPath).filter(Boolean);
  const untracked = new Set(String(await gitExecAsync(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0"));
  const deleted = new Set(String(await gitExecAsync(["diff", "HEAD", "--no-renames", "--name-only", "--diff-filter=D", "-z"], cwd)).split("\0"));
  for (const file of paths) {
    const key = deleted.has(file) ? "files_to_delete" : untracked.has(file) ? "files_to_create" : "files_to_modify";
    next[key] = [...new Set([...(next[key] || []), file])];
  }
  next[DIRTY_WORKTREE_RECOVERY_KEY] = { gate_id: job.id, paths, action };
  delete next._assess_only;
  next.instructions = [next.instructions || next.task_spec || original.title,
    `Operator authorized recovery of these existing files: ${paths.join(", ")}.`, feedback].filter(Boolean).join("\n\n");
  // Persist the authorized scope before committing: a crash may retry the
  // answer, but cannot leave a commit whose expanded scope was never recorded.
  updateJobPayload(original.id, JSON.stringify(next));
  if (action === "commit") {
    const base = await gitCurrentHashAsync(cwd);
    const result = await gitCommitAllAsync(`posse: recover job #${original.id}`, cwd, {
      modifyFiles: [...new Set([...(next.files_to_modify || []), ...(next.must_modify || [])])],
      createFiles: next.files_to_create || [], deleteFiles: next.files_to_delete || [], createRoots: next.create_roots || [],
    }, { projectDir: worker.projectDir, wiId: original.work_item_id, jobId: original.id,
      branchName: getWorkItem(original.work_item_id)?.branch_name, failOnOutOfScopeDirty: true });
    const sourceAttempt = getAttempts(original.id).find(entry => entry.id === payload.source_attempt_id);
    if (sourceAttempt && payload.recovery_phase === "commit") {
      if (result.hash !== base) setAttemptCommitHash(sourceAttempt.id, result.hash, base);
      setJobResult(original.id, { commit_hash: result.hash, recovery_gate_id: job.id });
      // Expanded scope invalidates the old final-review identity. Resume the
      // developer so the preserved commit receives fresh validation.
    }
  }
  beginJobRetryGeneration(original.id, { payload: next });
  const resumed = requestParkedJobResumeAfterGate({ gateJobId: job.id, originalJobId: original.id,
    operationKey, reason: `dirty_worktree_${action}` });
  if (!resumed.ok) throw new Error(`Could not resume the recovered job: ${resumed.reason}`);
}
