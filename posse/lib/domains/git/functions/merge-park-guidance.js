// Operator guidance for a work-item merge that parked on a conflict the
// close-out refresh could not resolve. The parked result used to say only that
// the merge failed or that the heads "have not moved", with no file list and
// no remedy. Name the files and the two ways forward.

const MERGE_CONFLICT_IN_RE = /^CONFLICT\s*\([^)]*\):\s*Merge conflict in (.+?)\s*$/gm;
const DELETED_IN_RE = /^CONFLICT\s*\([^)]*\):\s*(.+?) deleted in \S+ and modified in /gm;

/** Conflicted paths named by git's CONFLICT lines (fallback when the index is gone). */
export function conflictFilesFromMergeError(errOrText) {
  const text = typeof errOrText === "string"
    ? errOrText
    : [errOrText?.stderr, errOrText?.stdout, errOrText?.message].filter(Boolean).join("\n");
  // A memo stores CONFLICT lines joined by "; " on one line.
  const lines = String(text || "").replace(/;\s+(?=CONFLICT\s*\()/g, "\n");
  const files = [];
  for (const re of [MERGE_CONFLICT_IN_RE, DELETED_IN_RE]) {
    for (const match of lines.matchAll(re)) files.push(match[1].trim());
  }
  return [...new Set(files.filter(Boolean))];
}

export function formatConflictFileList(files = [], { limit = 6 } = {}) {
  const unique = [...new Set((Array.isArray(files) ? files : []).filter(Boolean))];
  const more = unique.length > limit ? ` (+${unique.length - limit} more)` : "";
  return `${unique.slice(0, limit).join(", ")}${more}`;
}

/**
 * "Conflicted files: … Next: …" for a parked work-item merge. Resolving on the
 * branch keeps the work: merging the target into it moves the branch head,
 * which lifts the deterministic-conflict memo. Re-queue discards the branch.
 */
export function parkedMergeGuidance({
  wiId = null,
  branch,
  targetBranch,
  files = [],
  worktreePath = null,
} = {}) {
  const fileList = formatConflictFileList(files);
  const where = worktreePath
    ? `run \`git merge ${targetBranch}\` in ${worktreePath}`
    : `check out ${branch} and run \`git merge ${targetBranch}\``;
  const retry = wiId != null
    ? `approve WI#${wiId} again (or \`posse merge ${wiId}\`)`
    : "retry the merge";
  const requeue = wiId != null ? `re-queue WI#${wiId}` : "re-queue the work item";
  return [
    fileList ? `Conflicted files: ${fileList}.` : null,
    `Next: ${where}, resolve and commit ${fileList ? "those files" : "the conflicts"}, then ${retry}; or ${requeue} to redo it on the current ${targetBranch} (discards ${branch}).`,
  ].filter(Boolean).join(" ");
}
