import { DIRTY_WORKTREE_RECOVERY_KEY } from "../../../catalog/human-input.js";
import fs from "node:fs";
import { gitCommitAllAsync } from "./commit-scope.js";
import { gitExecAsync } from "./utils.js";
import { resolveTargetBranchAsync, worktreePathAsync } from "./worktree.js";
import { getJob, listJobsByWorkItem, updateJobPayload } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";

async function dirtyScope(cwd) {
  const names = async (args) => String(await gitExecAsync(args, cwd, { trim: false })).split("\0").filter(Boolean);
  const modified = await names(["diff", "HEAD", "--no-renames", "--name-only", "--diff-filter=ACMRT", "-z"]);
  const deleted = await names(["diff", "HEAD", "--no-renames", "--name-only", "--diff-filter=D", "-z"]);
  const created = await names(["ls-files", "--others", "--exclude-standard", "-z"]);
  return { modifyFiles: modified, createFiles: created, deleteFiles: deleted, createRoots: [] };
}

// Only invoked by the explicit commit choice at a merge-recovery gate.
// Source changes return to development/review; committing them is not proof
// that they satisfy the work item. Target changes get their own local commit.
export async function commitMergeRecoveryDirt(workItem, { projectDir, gateJobId }) {
  const cwd = await worktreePathAsync(projectDir, workItem.id);
  if (fs.existsSync(cwd) && String(await gitExecAsync(["branch", "--show-current"], cwd)).trim() !== workItem.branch_name) {
    throw new Error("The recovery worktree is no longer on the work-item branch");
  }
  const targetBranch = await resolveTargetBranchAsync(projectDir);
  if (String(await gitExecAsync(["branch", "--show-current"], projectDir)).trim() !== targetBranch) {
    throw new Error(`The target checkout must be on ${targetBranch} before committing recovery work`);
  }
  const sourceScope = fs.existsSync(cwd) ? await dirtyScope(cwd) : { modifyFiles: [], createFiles: [], deleteFiles: [], createRoots: [] };
  const sourceChanged = sourceScope.modifyFiles.length + sourceScope.createFiles.length + sourceScope.deleteFiles.length > 0;
  const gatePayload = parseJobPayload(getJob(gateJobId));
  const validationPending = gatePayload[DIRTY_WORKTREE_RECOVERY_KEY]?.source_validation_required === true;
  if (sourceChanged) {
    const owner = listJobsByWorkItem(workItem.id).filter(job => MUTATING_JOB_TYPES.has(job.job_type)).at(-1);
    if (!owner) throw new Error("No development job owns this branch; send it back before including dirty work");
    const payload = parseJobPayload(owner);
    for (const [key, files] of [["files_to_modify", sourceScope.modifyFiles], ["files_to_create", sourceScope.createFiles], ["files_to_delete", sourceScope.deleteFiles]]) {
      payload[key] = [...new Set([...(payload[key] || []), ...files])];
    }
    updateJobPayload(owner.id, JSON.stringify(payload));
    // Persist before committing: a target commit failure or process exit must
    // not turn a retried answer into permission to merge unvalidated source.
    updateJobPayload(gateJobId, JSON.stringify({ ...gatePayload,
      [DIRTY_WORKTREE_RECOVERY_KEY]: { source_validation_required: true } }));
    await gitCommitAllAsync(`review: preserve dirty work for WI#${workItem.id}`, cwd, sourceScope,
      { projectDir, wiId: workItem.id, branchName: workItem.branch_name, jobId: owner.id, failOnOutOfScopeDirty: true });
  }
  const targetScope = await dirtyScope(projectDir);
  if (targetScope.modifyFiles.length + targetScope.createFiles.length + targetScope.deleteFiles.length > 0) {
    await gitCommitAllAsync(`review: preserve target work before WI#${workItem.id}`, projectDir, targetScope,
      { projectDir, failOnOutOfScopeDirty: true });
  }
  return { sourceChanged: sourceChanged || validationPending };
}
