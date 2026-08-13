// Shared classification for transient native/git identity faults.
// SQLite contention is included: the orchestrator DB uses WAL + busy_timeout,
// but a long writer (tree compression, checkpointing) can still outlast the
// timeout — repeating the identical "database is locked" error must not be
// read as a structural failure that escalation can't help.

const TRANSIENT_COMMIT_INFRA_RE = /posse_key\s+heartbeat|pulse[\s_-]?token|identity\s+heartbeat|\bETIMEDOUT\b|\bgit\b[^\n]{0,80}\btimed out\b|database is (?:busy|locked)|\bSQLITE_(?:BUSY|LOCKED)\b/i;

export function isTransientCommitInfraFailure(error = {}) {
  if (error?.code === "GIT_SCOPED_COMMIT_OUT_OF_SCOPE_DIRTY") return false;
  if (Array.isArray(error?.createdOutOfScope) && error.createdOutOfScope.length > 0) return false;
  if (String(error?.hookOutput || "").trim()) return false;
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
  return TRANSIENT_COMMIT_INFRA_RE.test(text);
}
