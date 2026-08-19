// Pure setup policy retained separately from the worktree/Git lifecycle.
export function transientSetupRetryCountFromPayload(payload = {}) {
  const value = Number(payload?._transient_infra_retries?.worktree_setup || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function nextTransientSetupRetryPayload(payload = {}) {
  const current = transientSetupRetryCountFromPayload(payload);
  return {
    ...payload,
    _transient_infra_retries: {
      ...(payload._transient_infra_retries || {}),
      worktree_setup: current + 1,
    },
  };
}

export function setupCleanupPrecedenceJobId(job, siblingLocks = []) {
  const ids = [Number(job?.id), ...siblingLocks.map((lock) => Number(lock?.job_id))]
    .filter((id) => Number.isFinite(id));
  return ids.length > 0 ? Math.min(...ids) : null;
}

export function jobHasSetupCleanupPrecedence(job, siblingLocks = []) {
  const jobId = Number(job?.id);
  return Number.isFinite(jobId) && jobId === setupCleanupPrecedenceJobId(job, siblingLocks);
}
