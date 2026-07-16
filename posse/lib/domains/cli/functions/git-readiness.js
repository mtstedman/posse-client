function firstProbeErrorLine(error) {
  return String(error?.stderr || error?.message || error || "unknown")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "unknown";
}

export function assertGitIdentityChecks(nameCheck, emailCheck) {
  for (const [label, check] of [["user.name", nameCheck], ["user.email", emailCheck]]) {
    if (check?.ok) continue;
    const error = new Error(`git ${label} probe failed: ${firstProbeErrorLine(check?.error)}`);
    error.code = "POSSE_GIT_IDENTITY_PROBE_FAILED";
    throw error;
  }

  if (!String(nameCheck?.stdout || "").trim() || !String(emailCheck?.stdout || "").trim()) {
    const error = new Error('git user identity not configured. Posse needs this to commit changes in worktrees. Run: git config user.name "Your Name" && git config user.email "you@example.com"');
    error.code = "POSSE_GIT_IDENTITY_NOT_CONFIGURED";
    throw error;
  }
}
