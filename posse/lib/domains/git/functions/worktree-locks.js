// File-based worktree locks. The same lock file is used to gate concurrent
// worktree mutations from inside the same machine — both within one Posse
// process and across cooperating processes. Owner metadata (pid + createdAt)
// lets waiters reclaim locks held by dead owners without waiting the full
// stale-age timeout.
//
// Each function exists in a sync and an async flavor; the sync versions are
// kept for worker-side polling that runs off the event loop. Reclaim
// policy is identical in both flavors.

import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { setTimeout as sleepAsyncTimer } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../queue/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { WorktreeLock, AsyncWorktreeLock } from "../classes/WorktreeLock.js";
import { runGitNativeMethod } from "./native/invoke.js";

const WORKTREE_LOCK_STALE_MS = 2 * 60 * 1000;
const WORKTREE_LOCK_WAIT_MS = 3 * 60 * 1000;
const WORKTREE_LOCK_POLL_MS = 50;
const WORKTREE_LOCK_LIVE_PID_STALE_MULTIPLIER = 10;
const ACTIVE_WORKTREE_LOCK_TOKENS = new Set();

// Exclusive-create (`wx`) lock open normally fails with EEXIST when the lock is
// held. On Windows it can instead fail with EPERM/EBUSY/EACCES when the lock
// path is in a delete-pending state (a prior holder just unlinked it) or is
// briefly held open by a scanner/indexer. Those are transient/contended states,
// not hard failures — treat them like EEXIST so the poll/reclaim loop retries
// instead of failing the whole worktree setup. POSIX keeps the strict EEXIST
// behavior to avoid masking genuine permission errors.
export function isRetryableLockOpenError(error) {
  if (error?.code === "EEXIST") return true;
  if (process.platform === "win32") {
    return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
  }
  return false;
}

// On acquire timeout, surface the last retryable open error (e.g. a Windows
// EPERM/EBUSY that was a real ACL problem, not a transient race) so callers
// throw something diagnosable instead of a bare "timed out" after the full wait.
function worktreeLockTimeoutDetail(lock) {
  if (!lock || lock.acquired) return "";
  const code = lock.lastErrorCode ? ` ${lock.lastErrorCode}` : "";
  const msg = lock.lastErrorMessage ? `: ${lock.lastErrorMessage}` : "";
  return code || msg ? ` (last open error${code}${msg})` : "";
}

export function registerActiveWorktreeLockToken(ownerToken) {
  if (ownerToken) ACTIVE_WORKTREE_LOCK_TOKENS.add(ownerToken);
}

export function unregisterActiveWorktreeLockToken(ownerToken) {
  if (ownerToken) ACTIVE_WORKTREE_LOCK_TOKENS.delete(ownerToken);
}

function hasActiveWorktreeLockToken(ownerToken) {
  return ownerToken ? ACTIVE_WORKTREE_LOCK_TOKENS.has(ownerToken) : false;
}

export function sleepMs(ms) {
  // Synchronous by design: used only in worker-side lock polling, not
  // scheduler/event-loop ticks.
  const timeout = Math.max(1, Number(ms) || 1);
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, timeout);
}

export async function sleepMsAsync(ms, signal = null) {
  throwIfAborted(signal);
  try {
    const options = signal ? { signal } : undefined;
    await sleepAsyncTimer(Math.max(1, Number(ms) || 1), undefined, options);
  } catch (err) {
    if (isAbortError(err)) throwIfAborted(signal);
    throw err;
  }
  throwIfAborted(signal);
}

function resolveWorktreeLockWaitMs(waitMs = null) {
  if (waitMs != null) {
    const explicit = Number(waitMs);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    if (explicit === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  }
  try {
    const configured = getIntSetting(SETTING_KEYS.WORKTREE_LOCK_WAIT_MS, null);
    if (Number.isFinite(configured) && configured > 0) return configured;
  } catch {
    // Settings may be unavailable in early startup or isolated git helpers.
  }
  return WORKTREE_LOCK_WAIT_MS;
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

function reclaimWorktreeLockByAge({ ownerCreatedAtMs, ownerToken, staleMs, stat }) {
  const referenceMs = ownerCreatedAtMs ?? Number(stat?.mtimeMs || 0);
  if (!Number.isFinite(referenceMs) || referenceMs <= 0) return false;
  const ageMs = Date.now() - referenceMs;
  if (ageMs < 0) return false;
  return Number.isFinite(staleMs) && staleMs > 0 && ageMs > staleMs
    ? { reclaim: true, ownerToken, stat }
    : false;
}

function shouldReclaimParsedWorktreeLock({
  hasOwnerPid,
  ownerCreatedAtMs,
  ownerPid,
  ownerState,
  ownerThreadId,
  ownerToken,
  releasedAtMs,
  staleMs,
  stat,
}) {
  if (Number.isFinite(releasedAtMs)) return { reclaim: true, ownerToken, stat };
  if (ownerState === false) return { reclaim: true, ownerToken, stat };
  if (hasOwnerPid && ownerState === true) {
    if (Number(ownerPid) === process.pid) {
      if (
        !ownerToken
        || !Number.isInteger(ownerThreadId)
        || ownerThreadId !== threadId
        || hasActiveWorktreeLockToken(ownerToken)
      ) {
        return false;
      }
      return reclaimWorktreeLockByAge({
        ownerCreatedAtMs,
        ownerToken,
        staleMs,
        stat,
      });
    }
    return reclaimWorktreeLockByAge({
      ownerCreatedAtMs,
      ownerToken,
      staleMs: staleMs * WORKTREE_LOCK_LIVE_PID_STALE_MULTIPLIER,
      stat,
    });
  }
  return reclaimWorktreeLockByAge({ ownerCreatedAtMs, ownerToken, staleMs, stat });
}

function newOwnerToken() {
  return `${process.pid}:${threadId}:${Date.now()}:${randomBytes(8).toString("hex")}`;
}

function lockMetadata(ownerToken) {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    threadId,
    ownerToken,
    createdAt: now,
  };
}

function isWorktreeLockHandle(value) {
  return value instanceof WorktreeLock || value instanceof AsyncWorktreeLock;
}

export function cloneOwner(owner = null) {
  return owner && typeof owner === "object" ? { ...owner } : null;
}

function readLockMetadata(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readLockMetadataAsync(lockPath) {
  try {
    const raw = await fs.promises.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function lockFileExists(lockPath) {
  try {
    return fs.existsSync(lockPath);
  } catch {
    return false;
  }
}

async function lockFileExistsAsync(lockPath) {
  try {
    await fs.promises.access(lockPath);
    return true;
  } catch {
    return false;
  }
}

function statMatchesExpected(lockPath, expectedStat = null) {
  if (!expectedStat) return true;
  try {
    const current = fs.statSync(lockPath);
    if (Number(current.size) !== Number(expectedStat.size)) return false;
    if (Number(current.mtimeMs) !== Number(expectedStat.mtimeMs)) return false;
    if (Number.isFinite(Number(expectedStat.dev)) && Number(current.dev) !== Number(expectedStat.dev)) return false;
    if (Number.isFinite(Number(expectedStat.ino)) && Number(current.ino) !== Number(expectedStat.ino)) return false;
    return true;
  } catch {
    return false;
  }
}

async function statMatchesExpectedAsync(lockPath, expectedStat = null) {
  if (!expectedStat) return true;
  try {
    const current = await fs.promises.stat(lockPath);
    if (Number(current.size) !== Number(expectedStat.size)) return false;
    if (Number(current.mtimeMs) !== Number(expectedStat.mtimeMs)) return false;
    if (Number.isFinite(Number(expectedStat.dev)) && Number(current.dev) !== Number(expectedStat.dev)) return false;
    if (Number.isFinite(Number(expectedStat.ino)) && Number(current.ino) !== Number(expectedStat.ino)) return false;
    return true;
  } catch {
    return false;
  }
}

export function removeLockIfOwner(lockPath, ownerToken, { allowUnowned = false, expectedStat = null } = {}) {
  let metadata = null;
  if (ownerToken) {
    metadata = readLockMetadata(lockPath);
    if (!metadata && !lockFileExists(lockPath)) return true;
    if (metadata?.ownerToken !== ownerToken) return false;
    // A caller-supplied stat pins the exact file observed during the reclaim
    // decision — if another waiter already swapped in a fresh lock, the token
    // may still match a stale read but the stat cannot.
    if (expectedStat && !statMatchesExpected(lockPath, expectedStat)) return false;
  } else if (allowUnowned) {
    if (!expectedStat || !statMatchesExpected(lockPath, expectedStat)) return false;
    metadata = readLockMetadata(lockPath);
    if (metadata?.ownerToken) return false;
  } else {
    return false;
  }
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function removeLockIfOwnerAsync(lockPath, ownerToken, { allowUnowned = false, expectedStat = null } = {}) {
  let metadata = null;
  if (ownerToken) {
    metadata = await readLockMetadataAsync(lockPath);
    if (!metadata && !(await lockFileExistsAsync(lockPath))) return true;
    if (metadata?.ownerToken !== ownerToken) return false;
    // See sync twin: the stat pins the exact file observed at reclaim time.
    if (expectedStat && !(await statMatchesExpectedAsync(lockPath, expectedStat))) return false;
  } else if (allowUnowned) {
    if (!expectedStat || !(await statMatchesExpectedAsync(lockPath, expectedStat))) return false;
    metadata = await readLockMetadataAsync(lockPath);
    if (metadata?.ownerToken) return false;
  } else {
    return false;
  }
  try {
    await fs.promises.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function writeReleasedMarker(lockPath, ownerToken) {
  if (!ownerToken) return false;
  const metadata = readLockMetadata(lockPath);
  if (ownerToken && metadata?.ownerToken !== ownerToken) return false;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      ...(metadata || {}),
      pid: metadata?.pid ?? process.pid,
      threadId: metadata?.threadId ?? threadId,
      ownerToken: metadata?.ownerToken || ownerToken || null,
      createdAt: metadata?.createdAt || new Date().toISOString(),
      releasedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

export async function writeReleasedMarkerAsync(lockPath, ownerToken) {
  if (!ownerToken) return false;
  const metadata = await readLockMetadataAsync(lockPath);
  if (ownerToken && metadata?.ownerToken !== ownerToken) return false;
  try {
    await fs.promises.writeFile(lockPath, JSON.stringify({
      ...(metadata || {}),
      pid: metadata?.pid ?? process.pid,
      threadId: metadata?.threadId ?? threadId,
      ownerToken: metadata?.ownerToken || ownerToken || null,
      createdAt: metadata?.createdAt || new Date().toISOString(),
      releasedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

function shouldReclaimWorktreeLock(lockPath, {
  stat = null,
  staleMs = WORKTREE_LOCK_STALE_MS,
  isProcessAliveFn = isProcessAlive,
} = {}) {
  let ownerState = null;
  let hasOwnerPid = false;
  let ownerPid = null;
  let ownerThreadId = null;
  let ownerCreatedAtMs = null;
  let releasedAtMs = null;
  let ownerToken = null;
  try {
    const parsed = readLockMetadata(lockPath);
    ownerToken = parsed?.ownerToken || null;
    const parsedReleasedAt = Date.parse(parsed?.releasedAt || "");
    if (Number.isFinite(parsedReleasedAt)) releasedAtMs = parsedReleasedAt;
    if (parsed?.pid != null) {
      hasOwnerPid = true;
      ownerPid = parsed.pid;
      ownerState = isProcessAliveFn(parsed.pid);
    }
    if (parsed?.threadId != null) ownerThreadId = Number(parsed.threadId);
    const parsedCreatedAt = Date.parse(parsed?.createdAt || "");
    if (Number.isFinite(parsedCreatedAt)) ownerCreatedAtMs = parsedCreatedAt;
  } catch {
    // Missing or corrupt metadata can still be reclaimed by age below.
  }

  return shouldReclaimParsedWorktreeLock({
    hasOwnerPid,
    ownerCreatedAtMs,
    ownerPid,
    ownerState,
    ownerThreadId,
    ownerToken,
    releasedAtMs,
    staleMs,
    stat,
  });
}

async function shouldReclaimWorktreeLockAsync(lockPath, {
  stat = null,
  staleMs = WORKTREE_LOCK_STALE_MS,
  isProcessAliveFn = isProcessAlive,
} = {}) {
  let ownerState = null;
  let hasOwnerPid = false;
  let ownerPid = null;
  let ownerThreadId = null;
  let ownerCreatedAtMs = null;
  let releasedAtMs = null;
  let ownerToken = null;
  try {
    const parsed = await readLockMetadataAsync(lockPath);
    ownerToken = parsed?.ownerToken || null;
    const parsedReleasedAt = Date.parse(parsed?.releasedAt || "");
    if (Number.isFinite(parsedReleasedAt)) releasedAtMs = parsedReleasedAt;
    if (parsed?.pid != null) {
      hasOwnerPid = true;
      ownerPid = parsed.pid;
      ownerState = isProcessAliveFn(parsed.pid);
    }
    if (parsed?.threadId != null) ownerThreadId = Number(parsed.threadId);
    const parsedCreatedAt = Date.parse(parsed?.createdAt || "");
    if (Number.isFinite(parsedCreatedAt)) ownerCreatedAtMs = parsedCreatedAt;
  } catch {
    // Missing or corrupt metadata can still be reclaimed by age below.
  }

  return shouldReclaimParsedWorktreeLock({
    hasOwnerPid,
    ownerCreatedAtMs,
    ownerPid,
    ownerState,
    ownerThreadId,
    ownerToken,
    releasedAtMs,
    staleMs,
    stat,
  });
}

export function __testResolveWorktreeLockWaitMs(waitMs = null) {
  assertTestContext("__testResolveWorktreeLockWaitMs");
  return resolveWorktreeLockWaitMs(waitMs);
}

export function __testShouldReclaimWorktreeLock(lockPath, opts = {}) {
  assertTestContext("__testShouldReclaimWorktreeLock");
  return shouldReclaimWorktreeLock(lockPath, opts);
}

export function __testRemoveLockIfOwner(lockPath, ownerToken, opts = {}) {
  assertTestContext("__testRemoveLockIfOwner");
  return removeLockIfOwner(lockPath, ownerToken, opts);
}

export function __testReadLockMetadata(lockPath) {
  assertTestContext("__testReadLockMetadata");
  return readLockMetadata(lockPath);
}

export function acquireWorktreeLock(lockPath, {
  waitMs = null,
  pollMs = WORKTREE_LOCK_POLL_MS,
  staleMs = WORKTREE_LOCK_STALE_MS,
} = {}) {
  const start = Date.now();
  const resolvedWaitMs = resolveWorktreeLockWaitMs(waitMs);
  let lastRetryableError = null;
  while (Date.now() - start < resolvedWaitMs) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, "wx");
      const ownerToken = newOwnerToken();
      const owner = lockMetadata(ownerToken);
      // Owner metadata (pid) is what lets other waiters detect dead owners and
      // reclaim the lock without waiting the full stale-age. A lock without
      // metadata forces every waiter to wait out WORKTREE_LOCK_STALE_MS, so
      // treat a failed write as a failed acquisition and retry.
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        sleepMs(pollMs + Math.floor(Math.random() * pollMs));
        continue;
      }
      return new WorktreeLock({ lockPath, fd, owner });
    } catch (error) {
      if (!isRetryableLockOpenError(error)) throw error;
      lastRetryableError = error;
      try {
        const stat = fs.statSync(lockPath);
        const reclaim = shouldReclaimWorktreeLock(lockPath, { stat, staleMs });
        if (reclaim?.reclaim) {
          try {
            removeLockIfOwner(lockPath, reclaim.ownerToken, {
              allowUnowned: !reclaim.ownerToken,
              expectedStat: reclaim.stat || stat,
            });
          } catch { /* retry loop will continue */ }
          continue;
        }
      } catch {
        // If lock inspection fails, keep waiting for owner to release.
      }
      // Jittered poll: without this, several workers waking on the same
      // tick would keep colliding on the same re-poll. Randomizing the
      // backoff in [pollMs, 2*pollMs) diffuses the herd across attempts.
      sleepMs(pollMs + Math.floor(Math.random() * pollMs));
    }
  }
  return { acquired: false, reason: "timeout", lockPath, lastErrorCode: lastRetryableError?.code || null, lastErrorMessage: lastRetryableError?.message || null };
}

export async function acquireWorktreeLockAsync(lockPath, {
  waitMs = null,
  pollMs = WORKTREE_LOCK_POLL_MS,
  staleMs = WORKTREE_LOCK_STALE_MS,
  signal = null,
} = {}) {
  const start = Date.now();
  const resolvedWaitMs = resolveWorktreeLockWaitMs(waitMs);
  let lastRetryableError = null;
  while (Date.now() - start < resolvedWaitMs) {
    throwIfAborted(signal);
    try {
      await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
      const fileHandle = await fs.promises.open(lockPath, "wx");
      const ownerToken = newOwnerToken();
      const owner = lockMetadata(ownerToken);
      if (signal?.aborted) {
        try { await fileHandle.close(); } catch { /* ignore */ }
        try { await fs.promises.rm(lockPath, { force: true }); } catch { /* ignore */ }
        throwIfAborted(signal);
      }
      try {
        await fileHandle.writeFile(JSON.stringify(owner));
      } catch (writeErr) {
        try { await fileHandle.close(); } catch { /* ignore */ }
        try { await fs.promises.rm(lockPath, { force: true }); } catch { /* ignore */ }
        await sleepMsAsync(pollMs + Math.floor(Math.random() * pollMs), signal);
        continue;
      }
      if (signal?.aborted) {
        const lock = new AsyncWorktreeLock({ lockPath, fileHandle, owner });
        await lock.releaseAsync();
        throwIfAborted(signal);
      }
      return new AsyncWorktreeLock({ lockPath, fileHandle, owner });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!isRetryableLockOpenError(error)) throw error;
      lastRetryableError = error;
      try {
        const stat = await fs.promises.stat(lockPath);
        const reclaim = await shouldReclaimWorktreeLockAsync(lockPath, { stat, staleMs });
        if (reclaim?.reclaim) {
          try {
            await removeLockIfOwnerAsync(lockPath, reclaim.ownerToken, {
              allowUnowned: !reclaim.ownerToken,
              expectedStat: reclaim.stat || stat,
            });
          } catch { /* retry loop will continue */ }
          continue;
        }
      } catch {
        // If lock inspection fails, keep waiting for owner to release.
      }
      await sleepMsAsync(pollMs + Math.floor(Math.random() * pollMs), signal);
    }
  }
  return { acquired: false, reason: "timeout", lockPath, lastErrorCode: lastRetryableError?.code || null, lastErrorMessage: lastRetryableError?.message || null };
}

export async function releaseWorktreeLockAsync(lockOrPath, maybeLock = null) {
  const lock = isWorktreeLockHandle(lockOrPath) ? lockOrPath : maybeLock;
  if (lock instanceof AsyncWorktreeLock) return lock.releaseAsync();
  if (lock instanceof WorktreeLock) return lock.release();
  throw new Error("releaseWorktreeLockAsync requires a worktree lock handle");
}

// Shared lock-path request preamble: runtime-root resolution, the best-effort
// info/exclude write, and payload normalization live once so the sync/async
// twins send identical requests.
//
// ROUTING INVARIANT: worktree/stash lock paths are computed locally on both the
// sync worker lane and the async lifecycle lane. They are needed before native
// Git readiness is guaranteed, and a cold pulse must never disable locking or
// divert partial-work recovery. Branch locks still resolve through native Git.
function lockPathRequestPayload(wtPath, projectDir, extra = {}) {
  const runtimeRoot = getRuntimeRoot(projectDir || wtPath);
  try { ensurePosseGitInfoExclude(projectDir || wtPath); } catch { /* best effort */ }
  return {
    wtPath: path.resolve(wtPath),
    projectDir: projectDir ? path.resolve(projectDir) : null,
    runtimeRoot,
    ...extra,
  };
}

function lockSafeFilename(value, fallback) {
  const source = String(value || fallback || "");
  const safe = source
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "x";
}

function localLockPath(runtimeRoot, directory, value, fallback) {
  const resolved = path.resolve(value);
  const lockKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(lockKey).digest("hex").slice(0, 16);
  const base = lockSafeFilename(path.basename(resolved) || fallback, fallback).slice(0, 40);
  return path.join(runtimeRoot, directory, `${base}-${hash}.lock`);
}

function localGitCommonDir(wtPath) {
  const resolvedWorktree = path.resolve(wtPath);
  const dotGit = path.join(resolvedWorktree, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
  } catch { /* inspect a possible gitfile below */ }

  try {
    const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, "utf8"));
    if (match?.[1]) {
      const gitDir = path.resolve(resolvedWorktree, match[1].trim());
      try {
        const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
        if (common) return path.resolve(gitDir, common);
      } catch { /* a submodule gitdir is already its common dir */ }
      return gitDir;
    }
  } catch { /* not a gitfile */ }

  // A bare repository has no .git entry; match `rev-parse --git-common-dir`
  // returning the repository root when its basic control files are present.
  try {
    if (
      fs.statSync(path.join(resolvedWorktree, "objects")).isDirectory()
      && fs.statSync(path.join(resolvedWorktree, "HEAD")).isFile()
    ) return resolvedWorktree;
  } catch { /* not a bare repository */ }
  return null;
}

export function worktreeLockPath(wtPath, projectDir = null, _nativeParity = {}) {
  const request = lockPathRequestPayload(wtPath, projectDir);
  return localLockPath(request.runtimeRoot, "worktree-locks", request.wtPath, "worktree");
}

export function gitStashLockPath(wtPath, projectDir = null, _nativeParity = {}) {
  const request = lockPathRequestPayload(wtPath, projectDir);
  // refs/stash is shared by linked worktrees, so key this lock by the main
  // repository's common Git directory rather than by one worktree lane.
  const repoIdentity = localGitCommonDir(request.wtPath)
    || request.projectDir
    || request.wtPath;
  return localLockPath(request.runtimeRoot, "git-stash-locks", repoIdentity, "repo");
}

export async function gitStashLockPathAsync(wtPath, projectDir = null, { signal = null } = {}) {
  throwIfAborted(signal);
  return gitStashLockPath(wtPath, projectDir);
}

export function gitBranchLockPath(wtPath, branchName, projectDir = null, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.branchLockPath",
    lockPathRequestPayload(wtPath, projectDir, { branchName }),
    nativeParity,
  );
}

export function withWorktreeLock(wtPath, projectDir, fn, opts = {}) {
  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  const lock = acquireWorktreeLock(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}${worktreeLockTimeoutDetail(lock)}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export async function withWorktreeLockAsync(wtPath, projectDir, fn, opts = {}) {
  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  const lock = await acquireWorktreeLockAsync(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}${worktreeLockTimeoutDetail(lock)}`);
  }
  try {
    return await fn();
  } finally {
    await lock.releaseAsync();
  }
}

export function withBranchLock(wtPath, branchName, projectDir, fn, opts = {}) {
  const lockPath = gitBranchLockPath(wtPath, branchName, projectDir);
  const lock = acquireWorktreeLock(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for git branch lock: ${lockPath}${worktreeLockTimeoutDetail(lock)}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export async function withBranchLockAsync(wtPath, branchName, projectDir, fn, opts = {}) {
  const lockPath = gitBranchLockPath(wtPath, branchName, projectDir);
  const lock = await acquireWorktreeLockAsync(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for git branch lock: ${lockPath}${worktreeLockTimeoutDetail(lock)}`);
  }
  try {
    return await fn();
  } finally {
    await lock.releaseAsync();
  }
}
