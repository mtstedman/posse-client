// Cross-WI handoff squash-conflict resolution.
//
// The cross-WI file handoff copies a source WI's edits into a dependent WI's
// branch as a pipeline-authored commit ("posse: sync cross-WI file handoff
// for job #N"). When the source WI later squash-merges into the target
// branch, git cannot recognize the duplicated content as shared history, so
// the dependent's squash merge conflicts wherever its own additions sit
// adjacent to the copied lines — even when merge ordering is correct
// (observed: wowiekowie 2026-08-13 WI#26/#29, merge_failed loops).
//
// The duplication produces a precisely recognizable conflict shape: in a
// diff3 view, both the BASE section and the OURS section of every conflict
// hunk are empty — the branch side is a pure addition at a position where
// the target added nothing. That shape is safe to resolve by union (keep the
// branch-side lines). An empty OURS section alone is NOT sufficient: it also
// occurs when the target deleted base lines the branch modified, and a union
// there would resurrect deliberately deleted code — hence the diff3 base
// check.

import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "node:crypto";
import { normPath } from "../../../shared/scope/functions/path.js";

export const HANDOFF_SYNC_SUBJECT_RE = /^posse: sync cross-WI file handoff for job #\d+/;
export const DETERMINISTIC_MERGE_FAILURE_KEY = "last_deterministic_merge_failure";

const CONFLICT_LINE_RE = /^CONFLICT\s*\([^)]*\):.*$/gm;

export function mergeFailureHeadsUnchanged(record, { branchHead, targetHead } = {}) {
  return !!record
    && !!branchHead
    && !!targetHead
    && String(record.branch_head || "") === String(branchHead)
    && String(record.target_head || "") === String(targetHead);
}

/**
 * Extract git's "CONFLICT (...)" lines from a failed-merge error so the
 * logged error names the actual blocker instead of the first stderr line
 * (which for conflicts is the informational "Auto-merging <file>").
 */
export function mergeConflictSummary(errOrText) {
  const text = [errOrText?.stderr, errOrText?.stdout, errOrText?.message, typeof errOrText === "string" ? errOrText : null]
    .filter(Boolean)
    .join("\n");
  const lines = text.match(CONFLICT_LINE_RE);
  if (!lines || lines.length === 0) return null;
  return [...new Set(lines.map((line) => line.trim()))].join("; ");
}

/**
 * Parse diff3-style merged content (`git merge-file -p --diff3`) and resolve
 * it by union when every conflict hunk is a pure branch-side addition
 * (empty base section AND empty ours section). Returns:
 *   { safe: true, content, hunkCount }  — content has markers removed,
 *                                         theirs sections kept
 *   { safe: false, reason, hunkCount }  — any hunk fails the shape check or
 *                                         the markers are malformed
 */
export function unionResolveDiff3(mergedText, {
  oursLabel = "ours",
  baseLabel = "base",
  theirsLabel = "theirs",
  markerSize = 7,
} = {}) {
  const lines = String(mergedText ?? "").split("\n");
  const normalizedMarkerSize = Math.max(7, Number.parseInt(markerSize, 10) || 7);
  const openMarker = `${"<".repeat(normalizedMarkerSize)} ${oursLabel}`;
  const baseMarker = `${"|".repeat(normalizedMarkerSize)} ${baseLabel}`;
  const separatorMarker = "=".repeat(normalizedMarkerSize);
  const closeMarker = `${">".repeat(normalizedMarkerSize)} ${theirsLabel}`;
  const out = [];
  let hunkCount = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === openMarker) {
      hunkCount += 1;
      const ours = [];
      const base = [];
      const theirs = [];
      let section = ours;
      let sawBase = false;
      let sawSeparator = false;
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const inner = lines[index];
        if (inner === baseMarker) {
          if (sawBase || sawSeparator) return { safe: false, reason: "malformed_conflict_markers", hunkCount };
          sawBase = true;
          section = base;
        } else if (inner === separatorMarker) {
          if (sawSeparator) return { safe: false, reason: "malformed_conflict_markers", hunkCount };
          sawSeparator = true;
          section = theirs;
        } else if (inner === closeMarker) {
          closed = true;
          break;
        } else {
          section.push(inner);
        }
        index += 1;
      }
      if (!closed || !sawSeparator) return { safe: false, reason: "malformed_conflict_markers", hunkCount };
      if (!sawBase) {
        // Without a base section this is not diff3 output; the safety
        // property cannot be established.
        return { safe: false, reason: "missing_diff3_base_section", hunkCount };
      }
      if (ours.length > 0 || base.length > 0) {
        return { safe: false, reason: "conflict_is_not_a_pure_branch_addition", hunkCount };
      }
      out.push(...theirs);
      index += 1; // skip the ">>>>>>>" line
      continue;
    }
    out.push(line);
    index += 1;
  }
  const structuralMarkers = new Set([openMarker, baseMarker, separatorMarker, closeMarker]);
  if (out.some((line) => structuralMarkers.has(line))) {
    return { safe: false, reason: "conflict_marker_residue", hunkCount };
  }
  // Zero hunks means merge-file's textual 3-way merge succeeded where git's
  // merge strategy reported a conflict; the output is a valid clean merge.
  return { safe: true, content: out.join("\n"), hunkCount };
}

export function conflictMarkerSizeAbsentFrom(contents = [], { minimum = 32 } = {}) {
  const occupied = new Set();
  for (const content of Array.isArray(contents) ? contents : [contents]) {
    for (const line of String(content ?? "").split("\n")) {
      if (/^=+$/.test(line)) occupied.add(line.length);
    }
  }
  let markerSize = Math.max(7, Number.parseInt(minimum, 10) || 32);
  while (occupied.has(markerSize)) markerSize += 1;
  return markerSize;
}

/**
 * Parse `git log --format=%x00%s --name-only <range>` output into the set of
 * files touched by pipeline-authored handoff-sync commits.
 */
export function handoffSyncFilesFromLog(logText) {
  const files = new Set();
  let inHandoffCommit = false;
  for (const rawLine of String(logText ?? "").split("\n")) {
    // Subject lines carry the NUL prefix from --format=%x00%s, making them
    // unambiguous against file-path lines. NUL is not whitespace, so it is
    // preserved by any upstream trimming.
    if (rawLine.startsWith("\u0000")) {
      inHandoffCommit = HANDOFF_SYNC_SUBJECT_RE.test(rawLine.slice(1).trim());
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;
    if (inHandoffCommit) files.add(line.replace(/\\/g, "/"));
  }
  return files;
}

export function handoffDependencyCoversFile(dependency, file, { platform = process.platform } = {}) {
  const normalize = (value) => {
    const normalized = normPath(value).replace(/\/+$/, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const dependencyPath = normalize(
    dependency && typeof dependency === "object" ? dependency.path : dependency,
  );
  const handoffFile = normalize(file);
  if (!dependencyPath || !handoffFile) return false;
  const lockKind = dependency && typeof dependency === "object"
    ? dependency.lock_kind
    : null;
  // A missing lock_kind means a row persisted before kinds were recorded —
  // treat it as kind-unknown and allow the root-style prefix match. File-lock
  // dependency paths are file paths, so the prefix branch is vacuous for them
  // and this cannot over-cover.
  if (lockKind != null && lockKind !== "root") return dependencyPath === handoffFile;
  return dependencyPath === "*"
    || dependencyPath === "."
    || handoffFile === dependencyPath
    || handoffFile.startsWith(`${dependencyPath}/`);
}

/**
 * Rebase a clean dependent WI branch onto the now-advanced target after its
 * cross-WI source dependencies have squash-merged. The handoff-copy commit
 * becomes empty and is dropped, leaving only the dependent's own commits.
 * A rebase conflict is deterministic for these two heads: abort it and return
 * a stable failure so the caller can park the WI for review.
 */
export function resyncHandoffBranchOntoTarget({
  exec,
  cwd,
  branch,
  targetBranch,
  worktreePath,
  dependencyPaths = [],
  // Optional predicate marking porcelain status lines that do not count as
  // dirt (posse-runtime scaffolding). Mirrors the caller's dirty-state
  // filtering so the resync preflight agrees with the merge preflight.
  isIgnorableStatusLine = null,
} = {}) {
  if (typeof exec !== "function" || !cwd || !branch || !targetBranch || !worktreePath) {
    return { attempted: false, resynced: false, reason: "missing_arguments" };
  }
  let mergeBase;
  let targetHead;
  let branchHead;
  let handoffFiles;
  try {
    mergeBase = exec(["merge-base", targetBranch, branch], cwd);
    targetHead = exec(["rev-parse", targetBranch], cwd);
    branchHead = exec(["rev-parse", branch], cwd);
    const logText = exec(
      ["log", "--format=%x00%s", "--name-only", `${mergeBase}..${branch}`],
      cwd,
      { trim: false },
    );
    handoffFiles = handoffSyncFilesFromLog(logText);
  } catch (error) {
    return {
      attempted: false,
      resynced: false,
      infrastructureFailure: true,
      reason: `handoff_resync_scan_failed: ${error?.message || error}`,
    };
  }
  if (mergeBase === targetHead) {
    return { attempted: false, resynced: false, reason: "branch_already_on_target", mergeBase, targetHead, branchHead };
  }
  if (handoffFiles.size === 0) {
    return { attempted: false, resynced: false, reason: "branch_has_no_handoff_sync_commits", mergeBase, targetHead, branchHead };
  }
  const normalizedDependencies = (Array.isArray(dependencyPaths) ? dependencyPaths : [])
    .filter((value) => normPath(value && typeof value === "object" ? value.path : value));
  if (
    normalizedDependencies.length > 0
    && ![...handoffFiles].some((file) =>
      normalizedDependencies.some((dependency) => handoffDependencyCoversFile(dependency, file)))
  ) {
    return { attempted: false, resynced: false, reason: "handoff_files_do_not_match_dependencies", mergeBase, targetHead, branchHead };
  }

  let checkedOutBranch;
  try {
    checkedOutBranch = exec(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  } catch (error) {
    return {
      attempted: false,
      resynced: false,
      infrastructureFailure: true,
      reason: `handoff_resync_checkout_scan_failed: ${error?.message || error}`,
      mergeBase,
      targetHead,
      branchHead,
    };
  }
  if (checkedOutBranch !== branch) {
    return {
      attempted: false,
      resynced: false,
      infrastructureFailure: true,
      reason: "branch_not_checked_out_in_worktree",
      mergeBase,
      targetHead,
      branchHead,
    };
  }
  let status;
  try {
    status = exec(["status", "--porcelain", "--untracked-files=all"], worktreePath);
  } catch (error) {
    return {
      attempted: false,
      resynced: false,
      infrastructureFailure: true,
      reason: `handoff_resync_status_failed: ${error?.message || error}`,
      mergeBase,
      targetHead,
      branchHead,
    };
  }
  // Posse-runtime porcelain (auto-modified .gitignore, untracked .posse/
  // scaffolding) persists across retries and must not read as "dirty" here —
  // the caller's dirty-state collector already filters it, and treating it
  // as dirt permanently deferred merges of clean branches.
  const dirtyLines = String(status || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => (typeof isIgnorableStatusLine === "function" ? !isIgnorableStatusLine(line) : true));
  if (dirtyLines.length > 0) {
    return {
      attempted: false,
      resynced: false,
      infrastructureFailure: true,
      reason: "dependent_worktree_dirty",
      mergeBase,
      targetHead,
      branchHead,
    };
  }

  try {
    exec(["rebase", "--onto", targetBranch, mergeBase, "--empty=drop"], worktreePath, { trim: false });
  } catch (error) {
    const conflictSummary = mergeConflictSummary(error);
    let hasUnmergedFiles = false;
    try {
      hasUnmergedFiles = exec(["diff", "--name-only", "--diff-filter=U"], worktreePath).trim().length > 0;
    } catch { /* the rebase error remains authoritative */ }
    try { exec(["rebase", "--abort"], worktreePath); } catch { /* best-effort cleanup */ }
    if (!conflictSummary && !hasUnmergedFiles) {
      return {
        attempted: false,
        resynced: false,
        infrastructureFailure: true,
        reason: `handoff_resync_rebase_failed: ${error?.message || error}`,
        mergeBase,
        targetHead,
        branchHead,
      };
    }
    const conflict = conflictSummary
      || String(error?.stderr || error?.stdout || error?.message || error).split("\n").find(Boolean)
      || "unknown rebase conflict";
    return {
      attempted: true,
      resynced: false,
      conflict: true,
      reason: "handoff_resync_conflict",
      error: conflict.trim(),
      mergeBase,
      targetHead,
      branchHead,
    };
  }

  try {
    const rebasedHead = exec(["rev-parse", "HEAD"], worktreePath);
    return {
      attempted: true,
      resynced: true,
      mergeBase,
      targetHead,
      branchHead,
      rebasedHead,
      files: [...handoffFiles],
    };
  } catch (error) {
    return {
      attempted: true,
      resynced: false,
      infrastructureFailure: true,
      reason: `handoff_resync_verification_failed: ${error?.message || error}`,
      mergeBase,
      targetHead,
      branchHead,
    };
  }
}

function readStageBlob(exec, cwd, stage, relPath) {
  try {
    return exec(["show", `:${stage}:${relPath}`], cwd, { trim: false });
  } catch {
    return null;
  }
}

function runMergeFileDiff3(exec, cwd, { oursFile, baseFile, theirsFile }) {
  // --zdiff3, not --diff3: plain diff3 suppresses git's zealous conflict
  // minimization, so lines both sides added identically (the handoff copy)
  // stay inside the hunk and the ours-section is never empty. zdiff3
  // minimizes the hunk to the true divergence while still showing the base
  // section the safety rule needs.
  const inputContents = [oursFile, baseFile, theirsFile].map((file) => fs.readFileSync(file, "utf8"));
  let nonce = randomBytes(16).toString("hex");
  while (inputContents.some((content) => content.includes(nonce))) {
    nonce = randomBytes(16).toString("hex");
  }
  const labels = {
    oursLabel: `ours-${nonce}`,
    baseLabel: `base-${nonce}`,
    theirsLabel: `theirs-${nonce}`,
    markerSize: conflictMarkerSizeAbsentFrom(inputContents),
  };
  const args = [
    "merge-file", "-p", "--zdiff3",
    `--marker-size=${labels.markerSize}`,
    "-L", labels.oursLabel, "-L", labels.baseLabel, "-L", labels.theirsLabel,
    oursFile, baseFile, theirsFile,
  ];
  try {
    return { merged: exec(args, cwd, { trim: false }), labels };
  } catch (error) {
    // merge-file exits with the number of conflicts; the merged content with
    // markers is still on stdout. A missing stdout means a real failure
    // (binary input, bad path) — treat as unresolvable.
    const stdout = error?.stdout;
    if (typeof stdout === "string" && stdout.length > 0) return { merged: stdout, labels };
    return null;
  }
}

/**
 * Attempt to resolve an in-progress conflicted squash merge whose conflicts
 * were caused by cross-WI handoff duplication. Must be called while the
 * conflicted index state from `git merge --squash <branch>` is still
 * present, with the target branch checked out at `cwd`.
 *
 * Every conflicted file must (a) be touched by a handoff-sync commit on the
 * branch and (b) resolve as a pure branch-side addition under diff3 (see
 * unionResolveDiff3). All-or-nothing: any file failing either gate declines
 * the whole resolution and leaves the index untouched for the caller's
 * normal abort path.
 *
 * @returns {{ resolved: boolean, files?: string[], reason?: string, transient?: boolean }}
 */
export function resolveHandoffSquashConflicts({ exec, cwd, branch }) {
  if (typeof exec !== "function" || !cwd || !branch) {
    return { resolved: false, reason: "missing_arguments" };
  }
  let conflicted = [];
  try {
    conflicted = exec(["diff", "--name-only", "--diff-filter=U"], cwd)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    return { resolved: false, transient: true, reason: `conflict_listing_failed: ${error?.message || error}` };
  }
  if (conflicted.length === 0) return { resolved: false, reason: "no_conflicted_files" };

  let handoffFiles;
  try {
    const mergeBase = exec(["merge-base", "HEAD", branch], cwd);
    const logText = exec(
      ["log", "--format=%x00%s", "--name-only", `${mergeBase}..${branch}`],
      cwd,
      { trim: false },
    );
    handoffFiles = handoffSyncFilesFromLog(logText);
  } catch (error) {
    return { resolved: false, transient: true, reason: `handoff_commit_scan_failed: ${error?.message || error}` };
  }
  if (handoffFiles.size === 0) return { resolved: false, reason: "branch_has_no_handoff_sync_commits" };

  const notSynced = conflicted.filter((file) => !handoffFiles.has(file.replace(/\\/g, "/")));
  if (notSynced.length > 0) {
    return { resolved: false, reason: `conflicted_file_not_handoff_synced: ${notSynced.slice(0, 5).join(", ")}` };
  }

  // Compute every resolution before writing anything so a late failure
  // cannot leave a half-resolved index.
  const resolutions = [];
  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-handoff-merge-"));
    for (const relPath of conflicted) {
      const ours = readStageBlob(exec, cwd, 2, relPath);
      const theirs = readStageBlob(exec, cwd, 3, relPath);
      if (ours == null || theirs == null) {
        // Stage content is fixed for the given heads (e.g. a modify/delete
        // conflict): retrying cannot supply the missing stage, so this is a
        // deterministic decline, not an environmental one.
        return { resolved: false, reason: `missing_conflict_stage: ${relPath}` };
      }
      // Stage 1 is absent for both-added files; that is exactly the empty
      // base the safety rule requires.
      const base = readStageBlob(exec, cwd, 1, relPath) ?? "";
      const safeName = relPath.replace(/[^A-Za-z0-9._-]/g, "_");
      const oursFile = path.join(tempDir, `${safeName}.ours`);
      const baseFile = path.join(tempDir, `${safeName}.base`);
      const theirsFile = path.join(tempDir, `${safeName}.theirs`);
      fs.writeFileSync(oursFile, ours);
      fs.writeFileSync(baseFile, base);
      fs.writeFileSync(theirsFile, theirs);
      const mergeResult = runMergeFileDiff3(exec, cwd, { oursFile, baseFile, theirsFile });
      // merge-file failure is blob-content-determined (e.g. binary files) —
      // exec health was already proven by the listing/scan calls above.
      if (mergeResult == null) return { resolved: false, reason: `merge_file_failed: ${relPath}` };
      const union = unionResolveDiff3(mergeResult.merged, mergeResult.labels);
      if (!union.safe) return { resolved: false, reason: `${union.reason}: ${relPath}` };
      resolutions.push({ relPath, content: union.content });
    }
    for (const { relPath, content } of resolutions) {
      fs.writeFileSync(path.join(cwd, relPath), content);
      exec(["add", "--", relPath], cwd);
    }
  } catch (error) {
    return { resolved: false, transient: true, reason: `resolution_write_failed: ${error?.message || error}` };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return { resolved: true, files: conflicted };
}
