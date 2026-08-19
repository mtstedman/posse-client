import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export function jobNeedsGitWorktree(job, nativeParity = {}) {
  if (!job || typeof job !== "object") {
    return false;
  }
  return Boolean(runGitNativeMethod("git.jobNeedsWorktree", job, nativeParity));
}

export async function jobNeedsGitWorktreeAsync(job, options = {}) {
  if (!job || typeof job !== "object") {
    return false;
  }
  return Boolean(await runGitNativeMethodAsync("git.jobNeedsWorktree", job, options));
}

export function jobsNeedGitWorktree(jobs = [], nativeParity = {}) {
  return Boolean(runGitNativeMethod(
    "git.jobsNeedWorktree",
    { jobs: Array.isArray(jobs) ? jobs : [] },
    nativeParity,
  ));
}
