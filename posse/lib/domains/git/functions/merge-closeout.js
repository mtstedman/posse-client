// Close-out refresh for final work-item merges.
//
// Parallel work items that touch the same lines conflict only because of the
// order they reach the target branch (live wowiekowie 2026-10-01: WI 155
// appended a nav item next to WI 154's; WI 158 changed `buildGraph()` while
// WI 156/157 inserted a helper above it, through a stale cross-WI handoff
// copy). Before the squash merge, the close-out replays the work item's own
// commits onto the current target, dropping handoff-sync copies whose source
// has merged, and resolves only conflicts whose shape proves ordering was the
// cause. Anything else is a real overlapping edit and stays parked.

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import {
  HANDOFF_SYNC_SUBJECT_RE,
  mergeConflictSummary,
  mergeFileZdiff3,
  readConflictStageBlob,
  walkDiff3Conflicts,
} from "./handoff-conflict-resolution.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";

export const CLOSEOUT_RESOLUTION_RULES = Object.freeze({
  APPEND_APPEND: "append_append",
  INSERT_BESIDE_MODIFY: "insert_beside_modify",
  BRANCH_ADDITION: "branch_addition",
});

export const CLOSEOUT_TEST_TIMEOUT_MS = 10 * 60_000;
const CLOSEOUT_DEPENDENCY_DIRS = Object.freeze(["node_modules", "vendor"]);
const HANDOFF_SYNC_JOB_RE = /^posse: sync cross-WI file handoff for job #(\d+)/;

function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

// `side` is the base lines with a pure insertion directly before and/or after.
function insertionAroundBase(side, base) {
  if (base.length === 0 || side.length <= base.length) return null;
  for (let start = 0; start + base.length <= side.length; start++) {
    if (!sameLines(side.slice(start, start + base.length), base)) continue;
    return { before: side.slice(0, start), after: side.slice(start + base.length) };
  }
  return null;
}

/**
 * Resolve one diff3 hunk (ours = target side, theirs = work-item side) when
 * its shape proves the conflict came from merge order alone:
 *   (a) both sides inserted at the same point (empty base): target lines
 *       first, then the work item's;
 *   (b) one side inserted directly beside base lines the other side changed:
 *       the insertion plus the change;
 *   (c) a pure work-item addition (empty base and target sections), the
 *       handoff-duplication shape.
 * Any other hunk is an overlapping edit and is declined.
 */
export function resolveOrderingConflictHunk({ ours = [], base = [], theirs = [] } = {}) {
  if (base.length === 0) {
    if (ours.length === 0) return { ok: true, lines: theirs, rule: CLOSEOUT_RESOLUTION_RULES.BRANCH_ADDITION };
    if (theirs.length === 0 || sameLines(ours, theirs)) {
      return { ok: true, lines: ours, rule: CLOSEOUT_RESOLUTION_RULES.APPEND_APPEND };
    }
    return { ok: true, lines: [...ours, ...theirs], rule: CLOSEOUT_RESOLUTION_RULES.APPEND_APPEND };
  }
  const targetInsertion = insertionAroundBase(ours, base);
  if (targetInsertion && !sameLines(theirs, base)) {
    return {
      ok: true,
      lines: [...targetInsertion.before, ...theirs, ...targetInsertion.after],
      rule: CLOSEOUT_RESOLUTION_RULES.INSERT_BESIDE_MODIFY,
    };
  }
  const branchInsertion = insertionAroundBase(theirs, base);
  if (branchInsertion && !sameLines(ours, base)) {
    return {
      ok: true,
      lines: [...branchInsertion.before, ...ours, ...branchInsertion.after],
      rule: CLOSEOUT_RESOLUTION_RULES.INSERT_BESIDE_MODIFY,
    };
  }
  return { ok: false, reason: "overlapping_edit" };
}

export function resolveOrderingConflictsDiff3(mergedText, labels = {}) {
  return walkDiff3Conflicts(mergedText, labels, resolveOrderingConflictHunk);
}

export function handoffSyncJobIdFromSubject(subject) {
  const match = String(subject || "").match(HANDOFF_SYNC_JOB_RE);
  return match ? Number(match[1]) : null;
}

/**
 * Handoff-sync commits carry the dependent job id. A copy is obsolete once
 * every source work item it came from has merged; the replay drops it so the
 * source's canonical squash content wins.
 * @param {Array<{ via_job_id?: number|null, source?: { merge_state?: string|null }|null }>} dependencies
 */
export function droppableHandoffSyncJobIds(dependencies = []) {
  const byJob = new Map();
  for (const dependency of Array.isArray(dependencies) ? dependencies : []) {
    const jobId = Number(dependency?.via_job_id);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) continue;
    const merged = dependency?.source?.merge_state === "merged";
    byJob.set(jobId, (byJob.get(jobId) ?? true) && merged);
  }
  return new Set([...byJob].filter(([, merged]) => merged).map(([jobId]) => jobId));
}

function jobPayload(job) {
  if (job?.payload_json && typeof job.payload_json === "object") return job.payload_json;
  try {
    return JSON.parse(job?.payload_json || "{}") || {};
  } catch {
    return {};
  }
}

/** The work item's declared verification: its most frequent succeeded test_command. */
export function closeoutTestCommandFromJobs(jobs = []) {
  const counts = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.status !== "succeeded" || !["dev", "fix"].includes(job?.job_type)) continue;
    const command = String(jobPayload(job).test_command || "").trim();
    if (command) counts.set(command, (counts.get(command) || 0) + 1);
  }
  let best = null;
  for (const [command, count] of counts) {
    if (!best || count > best.count) best = { command, count };
  }
  return best?.command || null;
}

/** Completion order (oldest first), then id: the order close-out merges run in. */
export function sortWorkItemsByCompletion(workItems = []) {
  const stamp = (wi) => {
    const parsed = Date.parse(String(wi?.completed_at || wi?.updated_at || ""));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...(Array.isArray(workItems) ? workItems : [])].sort((left, right) => (
    stamp(left) - stamp(right) || Number(left?.id || 0) - Number(right?.id || 0)
  ));
}

/**
 * Run the declared test command synchronously in `cwd` (the merge runs in a
 * git workflow worker, never on the scheduler thread). Linked dependency
 * directories come from the target checkout when the worktree lacks them.
 */
export function runCloseoutTestCommandSync(command, {
  cwd,
  dependencySourceDir = null,
  timeoutMs = CLOSEOUT_TEST_TIMEOUT_MS,
  spawnSyncImpl = spawnSync,
} = {}) {
  const linked = [];
  try {
    if (dependencySourceDir) {
      for (const dir of CLOSEOUT_DEPENDENCY_DIRS) {
        const source = path.join(dependencySourceDir, dir);
        const destination = path.join(cwd, dir);
        if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
        fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
        linked.push(destination);
      }
    }
    const [executable, ...args] = parseCommandArguments(command);
    const spec = commandSpawnSpec(executable, args);
    const result = spawnSyncImpl(spec.command, spec.args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
      env: process.env,
    });
    const output = `${result?.stdout || ""}${result?.stderr || ""}`;
    if (result?.error) {
      return { ok: false, status: null, output: `${result.error.message || result.error}\n${output}`.trim() };
    }
    return { ok: result?.status === 0, status: result?.status ?? null, output: output.trim() };
  } catch (error) {
    return { ok: false, status: null, output: String(error?.message || error) };
  } finally {
    for (const destination of linked) {
      try { fs.unlinkSync(destination); } catch { /* best effort */ }
    }
  }
}

function blobAt(exec, cwd, rev, file) {
  try {
    return exec(["rev-parse", "--verify", "--quiet", `${rev}:${file}`], cwd);
  } catch {
    return null;
  }
}

/**
 * A handoff copy is superseded when, for every file it touched, the exact
 * content it wrote reached the target after the merge base (the source work
 * item merged it). Replaying it can then only conflict with later target
 * edits around that content; dropping it loses nothing of the work item's.
 */
export function handoffCopyLandedOnTarget(exec, cwd, { commit, mergeBase, targetHead }) {
  try {
    const files = exec(["diff-tree", "--no-commit-id", "--name-only", "-r", commit], cwd)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length === 0) return false;
    for (const file of files) {
      const copied = blobAt(exec, cwd, commit, file);
      const landed = exec(["log", "--format=%H", `${mergeBase}..${targetHead}`, "--", file], cwd)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .some((rev) => blobAt(exec, cwd, rev, file) === copied);
      if (!landed) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function unmergedFiles(exec, cwd) {
  return exec(["diff", "--name-only", "--diff-filter=U"], cwd)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function indexMatchesHead(exec, cwd) {
  try {
    exec(["diff", "--cached", "--quiet"], cwd);
    return true;
  } catch {
    return false;
  }
}

// All-or-nothing: compute every file's resolution before writing any.
function resolveConflictedFiles(exec, cwd, files) {
  const resolutions = [];
  const rules = [];
  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-closeout-merge-"));
    for (const relPath of files) {
      const ours = readConflictStageBlob(exec, cwd, 2, relPath);
      const theirs = readConflictStageBlob(exec, cwd, 3, relPath);
      if (ours == null || theirs == null) return { resolved: false, reason: `missing_conflict_stage: ${relPath}` };
      const base = readConflictStageBlob(exec, cwd, 1, relPath) ?? "";
      const safeName = relPath.replace(/[^A-Za-z0-9._-]/g, "_");
      const files3 = {
        oursFile: path.join(tempDir, `${safeName}.ours`),
        baseFile: path.join(tempDir, `${safeName}.base`),
        theirsFile: path.join(tempDir, `${safeName}.theirs`),
      };
      fs.writeFileSync(files3.oursFile, ours);
      fs.writeFileSync(files3.baseFile, base);
      fs.writeFileSync(files3.theirsFile, theirs);
      const merged = mergeFileZdiff3(exec, cwd, files3);
      if (merged == null) return { resolved: false, reason: `merge_file_failed: ${relPath}` };
      const resolution = resolveOrderingConflictsDiff3(merged.merged, merged.labels);
      if (!resolution.safe) return { resolved: false, reason: `${resolution.reason}: ${relPath}` };
      resolutions.push({ relPath, content: resolution.content });
      rules.push(...resolution.rules);
    }
    for (const { relPath, content } of resolutions) {
      fs.writeFileSync(path.join(cwd, relPath), content);
      exec(["add", "--", relPath], cwd);
    }
    return { resolved: true, files, rules };
  } catch (error) {
    return { resolved: false, reason: `resolution_failed: ${error?.message || error}` };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function namesFrom(exec, cwd, args) {
  return String(exec(args, cwd) || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

// A 3-way result as content: an existing blob (`oid`), merged text, or a
// deletion. `clean: false` means git could not merge it without conflict.
function mergeBlobsThreeWay(exec, cwd, tempDir, file, { ours, base, theirs }) {
  if (ours === theirs) return { clean: true, oid: ours };
  if (base === ours) return { clean: true, oid: theirs };
  if (base === theirs) return { clean: true, oid: ours };
  if (ours == null || theirs == null) return { clean: false, reason: "modify_delete" };
  const safeName = file.replace(/[^A-Za-z0-9._-]/g, "_");
  const inputs = { ours, base, theirs };
  const paths = {};
  for (const [side, oid] of Object.entries(inputs)) {
    paths[side] = path.join(tempDir, `${safeName}.${side}`);
    fs.writeFileSync(paths[side], oid == null ? "" : exec(["cat-file", "blob", oid], cwd, { trim: false }));
  }
  try {
    return { clean: true, text: exec(["merge-file", "-p", paths.ours, paths.base, paths.theirs], cwd, { trim: false }) };
  } catch {
    // merge-file exits with the conflict count, or fails on binary input.
    return { clean: false, reason: "conflict" };
  }
}

function sameAsBlob(exec, cwd, result, oid) {
  if (result.oid !== undefined) return result.oid === oid;
  if (oid == null) return false;
  return exec(["cat-file", "blob", oid], cwd, { trim: false }) === result.text;
}

/**
 * Paths the work item's merges carried content for: a merge's result for the
 * path differs from git's own merge of that merge's parents (a conflict
 * resolution, task edits made while completing the merge, or a dropped side).
 * The no-merges replay cannot reproduce that content.
 */
function mergeCarriedPaths(exec, cwd, tempDir, { mergeBase, branchHead, candidates }) {
  const carried = new Set();
  if (candidates.size === 0) return carried;
  const merges = namesFrom(exec, cwd, ["rev-list", "--first-parent", "--merges", "--parents", `${mergeBase}..${branchHead}`])
    .map((line) => line.split(/\s+/).filter(Boolean));
  for (const [merge, ours, theirs, ...extraParents] of merges) {
    if (!ours || !theirs || extraParents.length > 0) {
      for (const file of namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", ours || merge, merge])) {
        if (candidates.has(file)) carried.add(file);
      }
      continue;
    }
    const base = exec(["merge-base", ours, theirs], cwd);
    const touched = new Set([
      ...namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", ours, merge]),
      ...namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", base, theirs]),
    ]);
    for (const file of touched) {
      if (!candidates.has(file) || carried.has(file)) continue;
      const auto = mergeBlobsThreeWay(exec, cwd, tempDir, file, {
        ours: blobAt(exec, cwd, ours, file),
        base: blobAt(exec, cwd, base, file),
        theirs: blobAt(exec, cwd, theirs, file),
      });
      if (!auto.clean || !sameAsBlob(exec, cwd, auto, blobAt(exec, cwd, merge, file))) carried.add(file);
    }
  }
  return carried;
}

/**
 * Commit `restoredFiles` at the branch head's content and `mergedFiles` at
 * their 3-way result on top of the replay in `worktreePath`, then prove the
 * committed tree holds exactly that content.
 */
function applyMergeCarriedContent(exec, worktreePath, { cwd, branch, branchHead, targetHead, restoredFiles, mergedFiles }) {
  try {
    const present = restoredFiles.length > 0
      ? new Set(namesFrom(exec, cwd, ["ls-tree", "-r", "--name-only", branchHead, "--", ...restoredFiles]))
      : new Set();
    const checkoutFiles = restoredFiles.filter((file) => present.has(file));
    const removeFiles = restoredFiles.filter((file) => !present.has(file));
    for (const { file, result } of mergedFiles) {
      if (result.text !== undefined) {
        fs.mkdirSync(path.dirname(path.join(worktreePath, file)), { recursive: true });
        fs.writeFileSync(path.join(worktreePath, file), result.text);
        exec(["add", "--", file], worktreePath);
      } else if (result.oid == null) {
        removeFiles.push(file);
      } else {
        // An unchanged side wins: check it out from its commit so the mode
        // (executable bit, symlink) comes along with the content.
        const sourceRev = [branchHead, targetHead].find((rev) => blobAt(exec, cwd, rev, file) === result.oid);
        if (!sourceRev) throw new Error(`no source commit for the 3-way result of ${file}`);
        exec(["checkout", sourceRev, "--", file], worktreePath);
      }
    }
    if (checkoutFiles.length > 0) exec(["checkout", branchHead, "--", ...checkoutFiles], worktreePath);
    if (removeFiles.length > 0) exec(["rm", "-q", "--ignore-unmatch", "--", ...removeFiles], worktreePath);
    exec([
      "commit", "--no-verify", "-m",
      `posse: close-out restore ${branch} content committed inside merges`,
      "-m", [
        ...restoredFiles.map((file) => `- ${file} (branch head)`),
        ...mergedFiles.map(({ file }) => `- ${file} (3-way with the target)`),
      ].join("\n"),
    ], worktreePath);
    const head = exec(["rev-parse", "HEAD"], worktreePath);
    const stillDiffer = restoredFiles.length > 0
      ? namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", branchHead, head, "--", ...restoredFiles])
      : [];
    for (const { file, result } of mergedFiles) {
      if (!sameAsBlob(exec, cwd, result, blobAt(exec, cwd, head, file))) stillDiffer.push(file);
    }
    if (stillDiffer.length > 0) return { ok: false, error: `restore left differences: ${stillDiffer.join(", ")}` };
    return { ok: true, head };
  } catch (error) {
    return { ok: false, error: `restore_failed: ${String(error?.stderr || error?.message || error).split("\n")[0]}` };
  }
}

/**
 * Replay a work item's own commits onto the current target in `worktreePath`
 * and move the branch to the result. With `ownsWorktree` the worktree is a
 * private detached checkout and the branch moves by compare-and-swap;
 * otherwise it is the work item's own clean worktree with the branch checked
 * out. The branch is untouched unless the whole refresh (and, after any
 * resolution, the declared test command) succeeds.
 */
export function refreshBranchForCloseout({
  exec,
  cwd,
  branch,
  targetBranch,
  worktreePath,
  ownsWorktree = false,
  droppableSyncJobIds = new Set(),
  testCommand = null,
  runTestCommand = runCloseoutTestCommandSync,
  isIgnorableStatusLine = null,
} = {}) {
  if (typeof exec !== "function" || !cwd || !branch || !targetBranch || !worktreePath) {
    return { attempted: false, refreshed: false, infrastructureFailure: true, reason: "missing_arguments" };
  }
  let mergeBase;
  let targetHead;
  let branchHead;
  let commits;
  try {
    mergeBase = exec(["merge-base", targetBranch, branch], cwd);
    targetHead = exec(["rev-parse", targetBranch], cwd);
    branchHead = exec(["rev-parse", branch], cwd);
    commits = exec(["log", "--reverse", "--no-merges", "--format=%H%x00%s", `${mergeBase}..${branch}`], cwd, { trim: false })
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [hash, ...subject] = row.split("\u0000");
        return { hash: hash.trim(), subject: subject.join("\u0000").trim() };
      });
  } catch (error) {
    return { attempted: false, refreshed: false, infrastructureFailure: true, reason: `closeout_scan_failed: ${error?.message || error}` };
  }
  const heads = { mergeBase, targetHead, branchHead };
  if (mergeBase === targetHead) return { attempted: false, refreshed: false, reason: "branch_already_on_target", ...heads };

  const dropped = [];
  const replay = [];
  for (const commit of commits) {
    const isHandoffCopy = HANDOFF_SYNC_SUBJECT_RE.test(commit.subject);
    const syncJobId = isHandoffCopy ? handoffSyncJobIdFromSubject(commit.subject) : null;
    if (syncJobId != null && droppableSyncJobIds.has(syncJobId)) {
      dropped.push({ ...commit, reason: "source_merged" });
    } else if (isHandoffCopy && handoffCopyLandedOnTarget(exec, cwd, { commit: commit.hash, mergeBase, targetHead })) {
      dropped.push({ ...commit, reason: "content_landed_on_target" });
    } else {
      replay.push(commit);
    }
  }

  if (!ownsWorktree) {
    try {
      if (exec(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath) !== branch) {
        return { attempted: false, refreshed: false, infrastructureFailure: true, reason: "branch_not_checked_out_in_worktree", ...heads };
      }
      const dirty = String(exec(["status", "--porcelain", "--untracked-files=all"], worktreePath) || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => (typeof isIgnorableStatusLine === "function" ? !isIgnorableStatusLine(line) : true));
      if (dirty.length > 0) {
        return { attempted: false, refreshed: false, infrastructureFailure: true, reason: "work_item_worktree_dirty", ...heads };
      }
    } catch (error) {
      return { attempted: false, refreshed: false, infrastructureFailure: true, reason: `closeout_worktree_scan_failed: ${error?.message || error}`, ...heads };
    }
  }

  const restore = () => {
    try { exec(["cherry-pick", "--abort"], worktreePath); } catch { /* not mid-pick */ }
    if (!ownsWorktree) {
      try { exec(["checkout", "-f", branch], worktreePath); } catch { /* reported by caller state */ }
    }
  };

  const skipped = [];
  const resolvedFiles = [];
  const rules = [];
  try {
    exec(["checkout", "--detach", targetHead], worktreePath);
    for (const commit of replay) {
      try {
        exec(["cherry-pick", "--allow-empty", commit.hash], worktreePath, { trim: false });
        continue;
      } catch (error) {
        let conflicted;
        try {
          conflicted = unmergedFiles(exec, worktreePath);
        } catch (scanError) {
          restore();
          return { attempted: true, refreshed: false, infrastructureFailure: true, reason: `closeout_conflict_scan_failed: ${scanError?.message || scanError}`, ...heads };
        }
        if (conflicted.length === 0) {
          // The commit's change is already on the target ("now empty").
          if (indexMatchesHead(exec, worktreePath)) {
            exec(["cherry-pick", "--skip"], worktreePath);
            skipped.push(commit);
            continue;
          }
          restore();
          return {
            attempted: true,
            refreshed: false,
            infrastructureFailure: true,
            reason: `closeout_cherry_pick_failed: ${String(error?.stderr || error?.message || error).split("\n")[0]}`,
            ...heads,
          };
        }
        const resolution = resolveConflictedFiles(exec, worktreePath, conflicted);
        if (!resolution.resolved) {
          restore();
          return {
            attempted: true,
            refreshed: false,
            conflict: true,
            reason: "overlapping_edit",
            error: resolution.reason,
            conflictSummary: mergeConflictSummary(error),
            files: conflicted,
            commit: commit.hash,
            ...heads,
          };
        }
        resolvedFiles.push(...resolution.files);
        rules.push(...resolution.rules);
        if (indexMatchesHead(exec, worktreePath)) {
          exec(["cherry-pick", "--skip"], worktreePath);
          skipped.push(commit);
        } else {
          exec(["-c", "core.editor=true", "cherry-pick", "--continue"], worktreePath, { trim: false });
        }
      }
    }
  } catch (error) {
    restore();
    return { attempted: true, refreshed: false, infrastructureFailure: true, reason: `closeout_replay_failed: ${error?.message || error}`, ...heads };
  }

  let refreshedHead;
  try {
    refreshedHead = exec(["rev-parse", "HEAD"], worktreePath);
  } catch (error) {
    restore();
    return { attempted: true, refreshed: false, infrastructureFailure: true, reason: `closeout_head_failed: ${error?.message || error}`, ...heads };
  }

  // The replay skips merge commits, so content a commit carried inside a
  // merge (a dev's conflict resolution plus task edits made while completing
  // the harness's target merge) is not replayed (live WI 167: job #2209's
  // optimizer.js edit in merge 045565d never reached main). Put it back on
  // top of the replay so the ordering resolution and the work both survive:
  // - a path the target has not changed since the merge base takes the
  //   branch head's content, the correct result since only the branch moved;
  // - a path the target changed again, whose content a branch merge carried,
  //   takes a clean 3-way merge of (merge base, target, branch head), the
  //   result a plain squash would produce. If that merge conflicts or cannot
  //   be computed, the refresh declines and the plain squash path runs, so
  //   nothing is dropped silently.
  let restoredFiles = [];
  const mergedFiles = [];
  let tempDir = null;
  try {
    const droppedPaths = new Set(dropped.flatMap((commit) => (
      namesFrom(exec, cwd, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", commit.hash])
    )));
    const targetChanged = namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", mergeBase, targetHead]);
    const expectedChanges = new Set([...targetChanged, ...droppedPaths]);
    restoredFiles = namesFrom(exec, cwd, ["diff", "--no-renames", "--name-only", branchHead, refreshedHead])
      .filter((file) => !expectedChanges.has(file));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-closeout-3way-"));
    const carried = mergeCarriedPaths(exec, cwd, tempDir, {
      mergeBase,
      branchHead,
      candidates: new Set(targetChanged.filter((file) => !droppedPaths.has(file))),
    });
    const conflicts = [];
    for (const file of carried) {
      const result = mergeBlobsThreeWay(exec, cwd, tempDir, file, {
        ours: blobAt(exec, cwd, targetHead, file),
        base: blobAt(exec, cwd, mergeBase, file),
        theirs: blobAt(exec, cwd, branchHead, file),
      });
      if (!result.clean) {
        conflicts.push(`${file} (${result.reason})`);
      } else if (!sameAsBlob(exec, cwd, result, blobAt(exec, cwd, refreshedHead, file))) {
        mergedFiles.push({ file, result });
      }
    }
    if (conflicts.length > 0) {
      restore();
      return {
        attempted: true,
        refreshed: false,
        reason: `merge_carried_content_conflicts_with_target: ${conflicts.slice(0, 10).join(", ")}`,
        lostFiles: [...carried],
        ...heads,
      };
    }
  } catch (error) {
    restore();
    return { attempted: true, refreshed: false, infrastructureFailure: true, reason: `closeout_content_check_failed: ${error?.message || error}`, ...heads };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (restoredFiles.length > 0 || mergedFiles.length > 0) {
    const reapplied = applyMergeCarriedContent(exec, worktreePath, { cwd, branch, branchHead, targetHead, restoredFiles, mergedFiles });
    if (!reapplied.ok) {
      const lostFiles = [...restoredFiles, ...mergedFiles.map(({ file }) => file)];
      restore();
      return {
        attempted: true,
        refreshed: false,
        reason: `replay_would_drop_branch_content: ${lostFiles.slice(0, 10).join(", ")} (${reapplied.error})`,
        lostFiles,
        ...heads,
      };
    }
    refreshedHead = reapplied.head;
  }

  const resolverUsed = resolvedFiles.length > 0;
  let testResult = null;
  if (resolverUsed && testCommand) {
    testResult = runTestCommand(testCommand, { cwd: worktreePath, dependencySourceDir: cwd });
    if (!testResult?.ok) {
      restore();
      return {
        attempted: true,
        refreshed: false,
        testFailed: true,
        reason: "closeout_test_failed",
        testCommand,
        testOutput: String(testResult?.output || "").slice(-2000),
        files: [...new Set(resolvedFiles)],
        ...heads,
      };
    }
  }

  try {
    if (exec(["rev-parse", branch], cwd) !== branchHead) {
      restore();
      return { attempted: true, refreshed: false, infrastructureFailure: true, reason: "branch_moved_during_closeout", ...heads };
    }
    if (ownsWorktree) {
      exec(["update-ref", `refs/heads/${branch}`, refreshedHead, branchHead], cwd);
    } else {
      exec(["checkout", "-B", branch], worktreePath);
    }
  } catch (error) {
    restore();
    return { attempted: true, refreshed: false, infrastructureFailure: true, reason: `closeout_branch_update_failed: ${error?.message || error}`, ...heads };
  }

  return {
    attempted: true,
    refreshed: true,
    refreshedHead,
    ...heads,
    dropped: dropped.map((commit) => ({ hash: commit.hash, reason: commit.reason })),
    skipped: skipped.map((commit) => commit.hash),
    resolvedFiles: [...new Set(resolvedFiles)],
    restoredFiles,
    threeWayMergedFiles: mergedFiles.map(({ file }) => file),
    rules: [...new Set(rules)],
    testCommand: resolverUsed ? testCommand : null,
    testRan: testResult != null,
  };
}
