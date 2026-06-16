// lib/worker/helpers/worktree-dirty-classification.js
//
// Porcelain parsing and the tolerable-dirty policy extracted from
// worktree-lifecycle.js: normalizing repo paths, classifying which dirty
// entries are tolerable (claimed by this job, sibling-owned, or runtime
// residual) versus blocking, and the targeted snapshot/reset of blocking
// paths during setup recovery.

import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { logEvent } from "../../../queue/functions/index.js";
import { preserveDirtyWorktreeSnapshotAsync } from "../../../git/functions/worktree.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { isAbortError } from "../../../runtime/functions/yield.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

export function normalizeRepoPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return "";
  return normalized;
}

export function payloadExplicitlyClaimsPath(payload = {}, repoPath = "") {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized) return false;
  const claimed = [
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload.files_to_delete) ? payload.files_to_delete : []),
  ].map(normalizeRepoPath).filter(Boolean);
  const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const foldedNormalized = fold(normalized);
  if (new Set(claimed.map(fold)).has(foldedNormalized)) return true;
  const roots = (Array.isArray(payload.create_roots) ? payload.create_roots : [])
    .map(normalizeRepoPath)
    .filter(Boolean)
    .map(fold);
  return roots.some((root) =>
    root === "*"
    || root === "."
    || foldedNormalized === root
    || foldedNormalized.startsWith(`${root}/`)
  );
}

export function foldRepoPath(value) {
  const normalized = normalizeRepoPath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function siblingLockCoversPath(lock, repoPath) {
  const normalized = foldRepoPath(repoPath);
  const rawLockPath = String(lock?.path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!normalized || !rawLockPath) return false;
  if (rawLockPath === "*" || rawLockPath === ".") return true;
  const lockPath = foldRepoPath(rawLockPath);
  if (!lockPath) return false;
  if (lock?.lock_kind === "root") {
    return normalized === lockPath || normalized.startsWith(`${lockPath}/`);
  }
  return normalized === lockPath;
}

export function parsePorcelainEntries(raw = "") {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      // Some git helpers trim leading whitespace, so a porcelain entry that
      // should be " M file" can arrive as "M file". Recover that shape without
      // corrupting staged "M  file" entries.
      const trimmedLeadingWorktreeOnly = line.length > 2 && line[1] === " " && line[2] !== " ";
      const status = trimmedLeadingWorktreeOnly ? ` ${line[0]}` : line.slice(0, 2);
      const rawPath = (trimmedLeadingWorktreeOnly ? line.slice(2) : line.slice(3)).trim();
      const repoPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop().trim()
        : rawPath;
      return {
        status,
        path: normalizeRepoPath(repoPath),
        raw: line,
      };
    })
    .filter((entry) => entry.path);
}

export function dedupePorcelainEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.status}\0${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function classifyIgnorableSetupDirty(payload = {}, dirtyPorcelain = "", ignoredPorcelain = "", siblingLocks = []) {
  const ignoredEntries = parsePorcelainEntries(ignoredPorcelain).filter((entry) => entry.status === "!!");
  const entries = dedupePorcelainEntries([
    ...parsePorcelainEntries(dirtyPorcelain),
    ...ignoredEntries,
  ]);
  if (entries.length === 0) return {
    tolerated: false,
    entries: [],
    paths: [],
    residualEntries: [],
    siblingEntries: [],
    blockingEntries: [],
  };

  const residualEntries = [];
  const siblingEntries = [];
  const blockingEntries = [];
  for (const entry of entries) {
    const claimedByCurrent = payloadExplicitlyClaimsPath(payload, entry.path);
    const untrackedResidual = (entry.status === "??" || entry.status === "!!") && !claimedByCurrent;
    const siblingLock = !claimedByCurrent
      ? siblingLocks.find((lock) => siblingLockCoversPath(lock, entry.path))
      : null;
    if (siblingLock) {
      siblingEntries.push({ ...entry, job_id: siblingLock.job_id ?? null, lock_path: siblingLock.path || null });
    } else if (untrackedResidual) {
      residualEntries.push(entry);
    } else {
      blockingEntries.push(entry);
    }
  }

  return {
    tolerated: blockingEntries.length === 0,
    entries,
    paths: entries.map((entry) => entry.path),
    residualEntries,
    siblingEntries,
    blockingEntries,
  };
}

export function isRuntimeResidualPath(repoPath = "") {
  const normalized = normalizeRepoPath(repoPath);
  return normalized === ".posse"
    || normalized.startsWith(".posse/")
    || normalized === ".posse-worktrees"
    || normalized.startsWith(".posse-worktrees/")
    || normalized === ".posse-test-suites"
    || normalized.startsWith(".posse-test-suites/");
}

export async function inspectIgnorableSetupDirty(wtPath, payload = {}, siblingLocks = [], { signal = null } = {}) {
  const dirtyPorcelain = await gitExecAsync(["status", "--porcelain", "--untracked-files=all"], wtPath, { signal });
  const ignoredPorcelain = await gitExecAsync(["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], wtPath, { signal });
  return {
    dirtyPorcelain,
    ignoredPorcelain,
    ...classifyIgnorableSetupDirty(payload, dirtyPorcelain, ignoredPorcelain, siblingLocks),
  };
}

export function targetedSetupDirtyRecoveryEligible(dirty = {}) {
  const blockingEntries = dirty.blockingEntries || [];
  if (blockingEntries.length === 0) return false;
  // Ignored files are not captured by the existing dirty snapshot path. Leave
  // those to the conservative retry path rather than deleting unpreserved data.
  return blockingEntries.every((entry) => entry.status !== "!!");
}

export async function snapshotAndResetSetupBlockingPathsAsync(worker, job, wi, wtPath, {
  branchName = null,
  dirty = {},
  signal = null,
} = {}) {
  const entries = dirty.blockingEntries || [];
  const paths = [...new Set(entries.map((entry) => normalizeRepoPath(entry.path)).filter(Boolean))];
  if (paths.length === 0) return null;

  const reason = `dirty-worktree-setup-wi-${wi.id}-job-${job.id}-targeted`;
  const snapshotDir = await preserveDirtyWorktreeSnapshotAsync(wtPath, worker.projectDir, {
    reason,
    branchName,
    wiId: wi.id,
    signal,
    onMsg: (msg) => {
      worker.emit(job.id, `${C.dim}[system] WI#${wi.id} ${msg}${C.reset}`);
    },
  });
  if (!snapshotDir) {
    throw new Error(`Dirty worktree snapshot failed before targeted setup cleanup for: ${paths.slice(0, 10).join(", ")}`);
  }

  const trackedPaths = paths.filter((repoPath) =>
    entries.some((entry) => normalizeRepoPath(entry.path) === repoPath && entry.status !== "??" && entry.status !== "!!")
  );
  const untrackedPaths = paths.filter((repoPath) =>
    entries.some((entry) => normalizeRepoPath(entry.path) === repoPath && entry.status === "??")
  );
  if (trackedPaths.length > 0) {
    try { await gitExecAsync(["reset", "HEAD", "--", ...trackedPaths], wtPath, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
    try { await gitExecAsync(["checkout", "HEAD", "--", ...trackedPaths], wtPath, { signal }); } catch (err) {
      if (isAbortError(err)) throw err;
      // Paths newly added to the index have no HEAD version. After reset they
      // become untracked and are removed by the clean step below.
      untrackedPaths.push(...trackedPaths);
    }
  }
  const uniqueUntracked = [...new Set(untrackedPaths)];
  if (uniqueUntracked.length > 0) {
    await gitExecAsync(["clean", "-fd", "--", ...uniqueUntracked], wtPath, { signal });
  }

  const post = await gitExecAsync(["status", "--porcelain", "--untracked-files=all", "--", ...paths], wtPath, { signal });
  const ignoredPost = await gitExecAsync(["status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--", ...paths], wtPath, { signal });
  const remaining = dedupePorcelainEntries([
    ...parsePorcelainEntries(post),
    ...parsePorcelainEntries(ignoredPost).filter((entry) => entry.status === "!!"),
  ]);
  if (remaining.length > 0) {
    const preview = remaining.slice(0, 10).map((entry) => `${entry.status} ${entry.path}`).join(", ");
    throw new Error(`Targeted setup cleanup left dirty path(s): ${preview}`);
  }

  worker.emit(job.id, `${C.dim}[system] WI#${wi.id} targeted setup cleanup reset ${paths.length} blocking path(s): ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " ..." : ""}${C.reset}`);
  logEvent({
    work_item_id: wi.id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_RECOVERED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Targeted setup cleanup reset ${paths.length} blocking dirty path(s) while same-WI siblings were active`,
    event_json: JSON.stringify({
      paths: paths.slice(0, 100),
      snapshot_dir: snapshotDir,
      sibling_locks: (dirty.siblingLocks || []).slice(0, 20),
    }),
  });
  return snapshotDir;
}
