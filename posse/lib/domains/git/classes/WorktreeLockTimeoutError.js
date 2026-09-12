export class WorktreeLockTimeoutError extends Error {
  constructor(message, lockPath) {
    super(message);
    this.name = new.target.name;
    this.lockPath = lockPath;
  }

  static is(error) {
    return error instanceof WorktreeLockTimeoutError
      || error?.name === WorktreeLockTimeoutError.name
      // Older/native callers can carry only the original diagnostic text.
      || /^Timed out waiting for (?:worktree|repository worktree-admin|git branch) lock:/im
        .test([error?.message, error?.stderr].filter(Boolean).join("\n"));
  }
}
