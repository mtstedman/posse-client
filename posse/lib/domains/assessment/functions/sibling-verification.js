import { getJob } from "../../queue/functions/index.js";
import { porcelain, porcelainChangedPaths } from "../../verification/functions/receipt-fingerprint.js";
import { unfinishedSiblingDirtyLocks } from "../../worker/functions/helpers/worktree-dirty-classification.js";

// Attribution is deliberately narrower than "outside writable scope": only
// dirty paths owned by another unfinished implementation attempt qualify.
export async function pendingSiblingVerificationPaths(cwd, jobId) {
  const job = jobId ? getJob(jobId) : null;
  if (!job) return [];
  return unfinishedSiblingDirtyLocks(job, porcelainChangedPaths(await porcelain(cwd)));
}
