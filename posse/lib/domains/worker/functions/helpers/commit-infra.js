// Shared classification for transient native/git identity faults.

const TRANSIENT_COMMIT_INFRA_RE = /posse_key\s+heartbeat|pulse[\s_-]?token|identity\s+heartbeat|\bETIMEDOUT\b|\bgit\b[^\n]{0,80}\btimed out\b/i;

export function isTransientCommitInfraFailure(error = {}) {
  if (Array.isArray(error?.createdOutOfScope) && error.createdOutOfScope.length > 0) return false;
  if (String(error?.hookOutput || "").trim()) return false;
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
  return TRANSIENT_COMMIT_INFRA_RE.test(text);
}
