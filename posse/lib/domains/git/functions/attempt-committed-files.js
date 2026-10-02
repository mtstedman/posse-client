// lib/domains/git/functions/attempt-committed-files.js
//
// Which paths a job attempt's commit range actually changed on the job's
// behalf. The plain first-parent diff (base..head) is wrong when the range
// contains the merge commit that completes the harness's target-branch merge:
// that diff also carries every change the target branch brought in, so a dev
// job that only resolved its handed-over conflicts appears to have committed
// unrelated target-branch files (wowiekowie run 2026-10-01, WI 167 job #2209:
// 17 main-only files reported as out-of-scope commits of a 3-file job).

import { gitExecAsync } from "./utils.js";
import { resolveTargetBranchAsync } from "./target-branch.js";

const NAME_DIFF = ["diff", "--no-renames", "--name-only", "--relative"];

function nameList(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => String(line || "").replace(/\\/g, "/").trim())
    .filter(Boolean);
}

async function diffNamesAsync(cwd, revs) {
  return nameList(await gitExecAsync([...NAME_DIFF, ...revs], cwd));
}

async function isAncestorAsync(cwd, ancestor, descendant) {
  try {
    const mergeBase = String(await gitExecAsync(["merge-base", ancestor, descendant], cwd)).trim();
    return mergeBase === ancestor;
  } catch {
    return false;
  }
}

// Two-parent merges on the first-parent chain of base..head whose second
// parent is already on the target branch: the harness's own target merges,
// never another work item's unmerged branch. Without a resolvable target
// branch nothing qualifies.
async function listTargetMergesAsync({ cwd, base, head, projectDir = null }) {
  const merges = nameList(await gitExecAsync([
    "rev-list", "--first-parent", "--merges", "--parents", `${base}..${head}`,
  ], cwd)).map((line) => line.split(/\s+/).filter(Boolean));
  if (merges.length === 0) return [];
  let targetBranch = null;
  try {
    targetBranch = String(await resolveTargetBranchAsync(projectDir || cwd) || "").trim() || null;
  } catch {
    targetBranch = null;
  }
  if (!targetBranch) return [];
  const targetMerges = [];
  for (const [merge, firstParent, targetParent, ...extraParents] of merges) {
    if (!firstParent || !targetParent || extraParents.length > 0) continue;
    if (!(await isAncestorAsync(cwd, targetParent, targetBranch))) continue;
    const mergeBase = String(await gitExecAsync(["merge-base", firstParent, targetParent], cwd)).trim();
    if (!mergeBase) continue;
    targetMerges.push({ merge, firstParent, targetParent, mergeBase });
  }
  return targetMerges;
}

/**
 * List the files a job attempt committed, attributing target-merge content to
 * the merge rather than to the job.
 *
 * For each target merge in base..head, a path the target side changed and
 * whose content at head still equals the target parent's is target content,
 * not job output, and is dropped. A target-changed path whose result does not
 * keep the target's version is the job's, even when it equals the work-item
 * side (a resolution that kept only the branch side, or a revert of the
 * target's change), so it is listed although the first-parent diff misses it.
 * Paths both sides of the merge changed are also reported as
 * `mergeResolutionFiles`: that is the surface the harness handed to the job
 * to resolve (every conflict lies in it), so scope checks allow it even
 * outside the job's planned scope.
 *
 * Everything else, including a job's edit on top of a target-only change,
 * remains attributed to the job. Without a base the legacy `head^!` form is
 * used, which git already reports as a combined diff for a merge. When the
 * target branch cannot be resolved the plain first-parent diff is returned.
 * Git failures propagate so callers can mark the committed set unknown.
 */
export async function listAttemptCommittedFilesAsync({
  cwd,
  commitHash,
  baseHash = null,
  projectDir = null,
} = {}) {
  const head = String(commitHash || "").trim();
  const base = String(baseHash || "").trim();
  const empty = { files: [], mergeResolutionFiles: [], targetMergeFiles: [] };
  if (!cwd || !head) return empty;
  if (!base) {
    return { ...empty, files: await diffNamesAsync(cwd, [`${head}^!`]) };
  }
  const files = await diffNamesAsync(cwd, [base, head]);
  const targetMerges = await listTargetMergesAsync({ cwd, base, head, projectDir });
  if (targetMerges.length === 0) return { ...empty, files };

  const firstParentChanged = new Set(files);
  const targetContent = new Set();
  const targetNotKept = new Set();
  const resolutionSurface = new Set();
  for (const { firstParent, targetParent, mergeBase } of targetMerges) {
    const [targetChanged, branchChanged, headDiffersFromTarget] = await Promise.all([
      diffNamesAsync(cwd, [mergeBase, targetParent]),
      diffNamesAsync(cwd, [mergeBase, firstParent]),
      diffNamesAsync(cwd, [targetParent, head]),
    ]);
    const branchSet = new Set(branchChanged);
    const differsSet = new Set(headDiffersFromTarget);
    for (const filePath of targetChanged) {
      if (!differsSet.has(filePath)) {
        targetContent.add(filePath);
        continue;
      }
      if (branchSet.has(filePath)) resolutionSurface.add(filePath);
      if (!firstParentChanged.has(filePath)) targetNotKept.add(filePath);
    }
  }
  const own = [...new Set([...files, ...targetNotKept])].filter((filePath) => !targetContent.has(filePath));
  return {
    files: own,
    mergeResolutionFiles: own.filter((filePath) => resolutionSurface.has(filePath)),
    targetMergeFiles: files.filter((filePath) => targetContent.has(filePath)),
  };
}

const MERGE_RESOLUTION_MAX_FILES = 40;
const MERGE_RESOLUTION_DIFF_MAX_BYTES = 24_000;
const MERGE_RESOLUTION_MAX_MISSING_LINES = 12;
const MERGE_RESOLUTION_MAX_LINE_CHARS = 180;

function addedLines(rawDiff) {
  return String(rawDiff || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .filter((line) => line.trim());
}

async function fileLinesAtAsync(cwd, rev, file) {
  try {
    const text = await gitExecAsync(["show", `${rev}:./${file}`], cwd, { trim: false, maxBuffer: 1024 * 1024 * 8 });
    return new Set(String(text || "").split(/\r?\n/));
  } catch {
    return new Set();
  }
}

/**
 * Compact assessor evidence for an attempt that completed a target merge: for
 * each committed file the target side also changed (the merge-resolution
 * surface, and target-only files the job edited or reverted), the committed
 * result against the target parent's version plus the target-added lines the
 * result no longer contains. The primary change view diffs against the
 * work-item side of the merge, so a resolution that keeps only the branch side
 * and drops the target's hunk is invisible there. Bounded like the dependency
 * diffs: an over-cap diff body is replaced by its stat, never truncated
 * mid-hunk. Returns null when the range has no target merge or no such file.
 */
export async function buildMergeResolutionEvidenceAsync({
  cwd,
  commitHash,
  baseHash = null,
  files = [],
  projectDir = null,
} = {}) {
  const head = String(commitHash || "").trim();
  const base = String(baseHash || "").trim();
  const wanted = [...new Set((Array.isArray(files) ? files : []).map((file) => String(file || "").replace(/\\/g, "/").trim()).filter(Boolean))]
    .slice(0, MERGE_RESOLUTION_MAX_FILES);
  if (!cwd || !head || !base || wanted.length === 0) return null;
  const targetMerges = await listTargetMergesAsync({ cwd, base, head, projectDir });

  const assigned = new Set();
  const sections = [];
  let missingLineCount = 0;
  let remainingDiffBytes = MERGE_RESOLUTION_DIFF_MAX_BYTES;
  for (const { merge, targetParent, mergeBase } of targetMerges) {
    const targetChanged = new Set(await diffNamesAsync(cwd, [mergeBase, targetParent]));
    const mergeFiles = wanted.filter((file) => !assigned.has(file) && targetChanged.has(file));
    if (mergeFiles.length === 0) continue;
    for (const file of mergeFiles) assigned.add(file);

    const missing = [];
    for (const file of mergeFiles) {
      const targetAdded = addedLines(await gitExecAsync([
        "diff", "--no-renames", "--relative", "-U0", mergeBase, targetParent, "--", file,
      ], cwd, { trim: false, maxBuffer: 1024 * 1024 * 8 }));
      if (targetAdded.length === 0) continue;
      const resultLines = await fileLinesAtAsync(cwd, head, file);
      const dropped = targetAdded.filter((line) => !resultLines.has(line));
      if (dropped.length === 0) continue;
      missingLineCount += dropped.length;
      missing.push([
        `- ${file}: ${dropped.length} of ${targetAdded.length} target-added line(s) missing`,
        ...dropped.slice(0, MERGE_RESOLUTION_MAX_MISSING_LINES)
          .map((line) => `    ${line.trim().slice(0, MERGE_RESOLUTION_MAX_LINE_CHARS)}`),
        dropped.length > MERGE_RESOLUTION_MAX_MISSING_LINES
          ? `    ...[${dropped.length - MERGE_RESOLUTION_MAX_MISSING_LINES} more]`
          : null,
      ].filter(Boolean).join("\n"));
    }

    const range = [targetParent, head];
    const diff = String(await gitExecAsync([
      "diff", "--no-renames", "--relative", "-U2", ...range, "--", ...mergeFiles,
    ], cwd, { trim: false, maxBuffer: 1024 * 1024 * 8 }) || "").trim();
    const bytes = Buffer.byteLength(diff, "utf8");
    let diffView;
    if (!diff) {
      diffView = "(the result equals the target's version of these files)";
    } else if (bytes <= remainingDiffBytes) {
      diffView = diff;
      remainingDiffBytes -= bytes;
    } else {
      const stat = String(await gitExecAsync(["diff", "--no-renames", "--relative", "--stat", ...range, "--", ...mergeFiles], cwd) || "").trim();
      diffView = `[diff omitted because it exceeds the merge-resolution inline cap (${bytes} bytes)]${stat ? `\n${stat}` : ""}`;
    }
    sections.push([
      `merge ${merge.slice(0, 12)}: target parent ${targetParent.slice(0, 12)}, files ${JSON.stringify(mergeFiles)}`,
      missing.length > 0
        ? `TARGET LINES MISSING FROM THE RESULT (the target branch added these since the merge base; the committed result does not contain them):\n${missing.join("\n")}`
        : "Every line the target branch added to these files since the merge base is still present in the result.",
      `DIFF VS TARGET (${targetParent.slice(0, 12)}..${head.slice(0, 12)}; "-" lines are the target's version the result does not keep, "+" lines are the work item's content):`,
      diffView,
    ].join("\n"));
  }
  if (sections.length === 0) return null;
  return {
    text: [
      "TARGET MERGE RESOLUTION (READ-ONLY CONTEXT — this job completed the harness's merge of the target branch):",
      "The primary change view diffs against the work-item side of the merge, so it cannot show target-branch work a resolution removed. For each committed file the target branch also changed, this compares the committed result with the target's version. A missing target line is target-branch work this commit removes; treat it as a defect unless the task requires that removal.",
      sections.join("\n\n"),
    ].join("\n"),
    missingLineCount,
  };
}
