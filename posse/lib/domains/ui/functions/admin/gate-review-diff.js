// The diff a verdict gate judges, for the TUI prompt's [d] view and
// `posse gate show`.
//
// The change itself comes from queue state (resolveGateReviewDiffTarget); this
// builds it with the same snapshot/file-detail builders as Agent View's [d]
// changes view and the approval Changes tab: an attempt's committed range, or
// the work-item branch against its merge base plus uncommitted worktree work.
// Like those views it keeps three context lines per hunk; on top of that the
// whole document is bounded so a large change cannot flood a terminal: files
// past the file cap are counted, and patch lines past the line cap are cut at
// a file boundary or, for the file that crosses it, mid-file with a marker.

import {
  buildAdminGitDiffFileDetail,
  buildAdminGitDiffSnapshot,
  buildAttemptGitDiffSnapshot,
} from "./git-diff-review.js";

export const GATE_REVIEW_DIFF_MAX_FILES = 40;
export const GATE_REVIEW_DIFF_MAX_LINES = 2000;

function shortHash(hash) {
  return String(hash || "").trim().slice(0, 12);
}

/** One-line description of the change a gate judges. */
export function gateReviewDiffTitle(target) {
  if (!target) return "";
  if (target.scope === "work_item") {
    const branch = target.branch_name ? ` branch ${target.branch_name}` : "";
    return `WI#${target.work_item_id ?? "?"}${branch} against its merge base`;
  }
  const attempt = target.attempt_number ? ` attempt ${target.attempt_number}` : "";
  const range = target.commit_hash
    ? ` commit ${target.commit_base_hash ? `${shortHash(target.commit_base_hash)}..` : ""}${shortHash(target.commit_hash)}`
    : "";
  return `job #${target.job_id ?? "?"}${attempt}${range}`;
}

/**
 * Build the bounded diff for a resolved gate target.
 *
 * @returns {Promise<{
 *   title: string,
 *   unavailable: string | null,
 *   errors: string[],
 *   files: Array<{ path: string, status: string, additions: number | null, deletions: number | null, binary: boolean, lines: string[] | null }>,
 *   omittedFiles: number,
 *   excludedTargetMergeFiles: string[],
 * }>}
 */
export async function buildGateReviewDiff({
  projectDir,
  target,
  maxFiles = GATE_REVIEW_DIFF_MAX_FILES,
  maxLines = GATE_REVIEW_DIFF_MAX_LINES,
} = {}) {
  const result = {
    title: gateReviewDiffTitle(target),
    unavailable: target?.unavailable || null,
    errors: [],
    files: [],
    omittedFiles: 0,
    excludedTargetMergeFiles: [],
  };
  if (!target) {
    result.unavailable = "this gate does not judge a code change";
    return result;
  }
  if (result.unavailable) return result;

  const snapshot = target.scope === "work_item"
    ? await buildAdminGitDiffSnapshot({
      projectDir,
      // A minimal row: the gate's branch is what it judges, whatever the work
      // item's merge state reads now.
      workItems: [{ id: target.work_item_id, branch_name: target.branch_name }],
      limit: 1,
    })
    : await buildAttemptGitDiffSnapshot({
      projectDir,
      workItemId: target.work_item_id,
      jobId: target.job_id,
      commitHash: target.commit_hash,
      baseHash: target.commit_base_hash,
    });
  result.errors = [...(snapshot.errors || []), ...(snapshot.items || []).flatMap((item) => item.errors || [])];
  result.excludedTargetMergeFiles = [...(snapshot.targetMergeFiles || [])];

  const files = snapshot.files || [];
  result.omittedFiles = Math.max(0, files.length - maxFiles);
  let remaining = Math.max(0, maxLines);
  for (const file of files.slice(0, maxFiles)) {
    const entry = {
      path: file.path,
      status: file.hasCommitDiff ? (file.status || "?") : (file.branchStatus || file.worktreeStatus || "?"),
      additions: Number.isFinite(file.additions) ? file.additions : null,
      deletions: Number.isFinite(file.deletions) ? file.deletions : null,
      binary: !!file.binary,
      lines: null,
    };
    result.files.push(entry);
    if (remaining <= 0) continue;
    const detail = await buildAdminGitDiffFileDetail({ projectDir, file });
    const lines = (detail.lines || []).map((line) => String(line ?? ""));
    // Drop the blank separator after the last section (never a diff line,
    // which always carries a prefix) so it does not read as a context line.
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > remaining) {
      entry.lines = [...lines.slice(0, remaining), `# diff truncated: ${lines.length - remaining} more line(s) of ${file.path}`];
      remaining = 0;
    } else {
      entry.lines = lines;
      remaining -= lines.length;
    }
  }
  return result;
}

/** Plain-text stat plus patch for the CLI, mirroring the TUI view. */
export function formatGateReviewDiffText(diff) {
  if (!diff) return [];
  const out = [`Change under review: ${diff.title}`];
  if (diff.unavailable) {
    out.push(`Diff unavailable: ${diff.unavailable}.`);
    return out;
  }
  for (const error of diff.errors) out.push(`Diff error: ${error}`);
  if (diff.files.length === 0) {
    out.push(diff.errors.length > 0 ? "No file changes could be read." : "No file changes.");
    return out;
  }
  const add = diff.files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const del = diff.files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const fileCount = diff.files.length + diff.omittedFiles;
  out.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed, +${add} -${del}`);
  for (const file of diff.files) {
    const counts = file.binary ? "binary" : `+${file.additions ?? "?"} -${file.deletions ?? "?"}`;
    out.push(`  ${file.status.padEnd(2)} ${file.path}  ${counts}`);
  }
  if (diff.omittedFiles > 0) out.push(`  ... ${diff.omittedFiles} more file(s) not shown`);
  if (diff.excludedTargetMergeFiles.length > 0) {
    out.push(`  (${diff.excludedTargetMergeFiles.length} file(s) the target-branch merge brought in are not the job's and are not shown)`);
  }
  for (const file of diff.files) {
    if (!file.lines) continue;
    out.push("", ...file.lines);
  }
  if (diff.files.some((file) => !file.lines)) {
    out.push("", `... patch omitted for ${diff.files.filter((file) => !file.lines).length} file(s): the diff line limit was reached`);
  }
  return out;
}
