// lib/domains/git/functions/workflow-git-utils.js
// Shared git workflow constants and formatting helpers.

export const GIT_MERGE_TIMEOUT_MS = 600_000; // 10 min; post-commit ATLAS indexing can legitimately take a while.

export function firstGitLine(err) {
  return String(err?.stderr || err?.stdout || err?.message || err || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] || "unknown git error";
}
