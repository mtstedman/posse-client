import { runGitNativeMethod } from "./native/invoke.js";

export function jobNeedsGitWorktree(job, nativeParity = {}) {
  if (!job || typeof job !== "object") {
    return false;
  }
  return Boolean(runGitNativeMethod("git.jobNeedsWorktree", job, nativeParity));
}

export function jobsNeedGitWorktree(jobs = [], nativeParity = {}) {
  return Boolean(runGitNativeMethod(
    "git.jobsNeedWorktree",
    { jobs: Array.isArray(jobs) ? jobs : [] },
    nativeParity,
  ));
}
