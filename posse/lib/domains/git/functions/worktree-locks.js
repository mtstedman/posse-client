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
import { randomBytes } from "crypto";
import { setTimeout as sleepAsyncTimer } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../queue/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

const WORKTREE_LOCK_STALE_MS = 2 * 60 * 1000;
const WORKTREE_LOCK_WAIT_MS = 3 * 60 * 1000;
const WORKTREE_LOCK_POLL_MS = 50;
const WORKTREE_LOCK_LIVE_PID_STALE_MULTIPLIER = 10;

function sleepMs(ms) {
  // Synchronous by design: used only in worker-side lock polling, not
  // scheduler/event-loop ticks.
  const timeout = Math.max(1, Number(ms) || 1);
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, timeout);
}

async function sleepMsAsync(ms, signal = null) {
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
  ownerToken,
  releasedAtMs,
  staleMs,
  stat,
}) {
  if (Number.isFinite(releasedAtMs)) return { reclaim: true, ownerToken, stat };
  if (ownerState === false) return { reclaim: true, ownerToken, stat };
  if (hasOwnerPid && ownerState === true) {
    if (Number(ownerPid) === process.pid) return false;
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

function cloneOwner(owner = null) {
  return owner && typeof owner === "object" ? { ...owner } : null;
}

export class WorktreeLock {
  #fd;
  #owner;
  #ownerToken;
  #released = false;

  constructor({ lockPath, fd, owner }) {
    this.acquired = true;
    this.lockPath = lockPath;
    this.#fd = fd;
    this.#owner = cloneOwner(owner);
    this.#ownerToken = owner?.ownerToken || null;
  }

  get fd() {
    return this.#fd;
  }

  get owner() {
    return cloneOwner(this.#owner);
  }

  get ownerToken() {
    return this.#ownerToken;
  }

  get isReleased() {
    return this.#released;
  }

  release() {
    if (this.#released) return true;
    try { if (this.#fd != null) fs.closeSync(this.#fd); } catch { /* ignore */ }
    this.#fd = null;
    this.#released = true;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (removeLockIfOwner(this.lockPath, this.#ownerToken)) return true;
      sleepMs(25 * (attempt + 1));
    }
    // Waiters can still time out instead of waiting forever. Never mark a lock
    // released unless it is still owned by this lock holder.
    return writeReleasedMarker(this.lockPath, this.#ownerToken);
  }

  async releaseAsync() {
    return this.release();
  }
}

export class AsyncWorktreeLock {
  #fileHandle;
  #owner;
  #ownerToken;
  #released = false;

  constructor({ lockPath, fileHandle, owner }) {
    this.acquired = true;
    this.lockPath = lockPath;
    this.#fileHandle = fileHandle;
    this.#owner = cloneOwner(owner);
    this.#ownerToken = owner?.ownerToken || null;
  }

  get fileHandle() {
    return this.#fileHandle;
  }

  get owner() {
    return cloneOwner(this.#owner);
  }

  get ownerToken() {
    return this.#ownerToken;
  }

  get isReleased() {
    return this.#released;
  }

  release() {
    throw new Error("Use releaseAsync() for async worktree locks");
  }

  async releaseAsync() {
    if (this.#released) return true;
    try { if (this.#fileHandle?.close) await this.#fileHandle.close(); } catch { /* ignore */ }
    this.#fileHandle = null;
    this.#released = true;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await removeLockIfOwnerAsync(this.lockPath, this.#ownerToken)) return true;
      await sleepMsAsync(25 * (attempt + 1)).catch(() => {});
    }
    // Waiters can still time out instead of waiting forever. Never mark a lock
    // released unless it is still owned by this lock holder.
    return writeReleasedMarkerAsync(this.lockPath, this.#ownerToken);
  }
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

function removeLockIfOwner(lockPath, ownerToken, { allowUnowned = false, expectedStat = null } = {}) {
  let metadata = null;
  if (ownerToken) {
    metadata = readLockMetadata(lockPath);
    if (!metadata && !lockFileExists(lockPath)) return true;
    if (metadata?.ownerToken !== ownerToken) return false;
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

async function removeLockIfOwnerAsync(lockPath, ownerToken, { allowUnowned = false, expectedStat = null } = {}) {
  let metadata = null;
  if (ownerToken) {
    metadata = await readLockMetadataAsync(lockPath);
    if (!metadata && !(await lockFileExistsAsync(lockPath))) return true;
    if (metadata?.ownerToken !== ownerToken) return false;
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

function writeReleasedMarker(lockPath, ownerToken) {
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

async function writeReleasedMarkerAsync(lockPath, ownerToken) {
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
      if (error?.code !== "EEXIST") throw error;
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
  return { acquired: false, reason: "timeout", lockPath };
}

export function releaseWorktreeLock(lockOrPath, maybeLock = null) {
  const lock = isWorktreeLockHandle(lockOrPath) ? lockOrPath : maybeLock;
  if (!(lock instanceof WorktreeLock)) {
    throw new Error("releaseWorktreeLock requires a WorktreeLock handle");
  }
  return lock.release();
}

export async function acquireWorktreeLockAsync(lockPath, {
  waitMs = null,
  pollMs = WORKTREE_LOCK_POLL_MS,
  staleMs = WORKTREE_LOCK_STALE_MS,
  signal = null,
} = {}) {
  const start = Date.now();
  const resolvedWaitMs = resolveWorktreeLockWaitMs(waitMs);
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
      if (error?.code !== "EEXIST") throw error;
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
  return { acquired: false, reason: "timeout", lockPath };
}

export async function releaseWorktreeLockAsync(lockOrPath, maybeLock = null) {
  const lock = isWorktreeLockHandle(lockOrPath) ? lockOrPath : maybeLock;
  if (lock instanceof AsyncWorktreeLock) return lock.releaseAsync();
  if (lock instanceof WorktreeLock) return lock.release();
  throw new Error("releaseWorktreeLockAsync requires a worktree lock handle");
}

export function worktreeLockPath(wtPath, projectDir = null, nativeParity = {}) {
  const runtimeRoot = getRuntimeRoot(projectDir || wtPath);
  try { ensurePosseGitInfoExclude(projectDir || wtPath); } catch { /* best effort */ }
  return runGitNativeMethod(
    "git.worktree.lockPath",
    { wtPath: path.resolve(wtPath), projectDir: projectDir ? path.resolve(projectDir) : null, runtimeRoot },
    nativeParity,
  );
}

export function gitStashLockPath(wtPath, projectDir = null, nativeParity = {}) {
  const runtimeRoot = getRuntimeRoot(projectDir || wtPath);
  try { ensurePosseGitInfoExclude(projectDir || wtPath); } catch { /* best effort */ }
  return runGitNativeMethod(
    "git.worktree.stashLockPath",
    { wtPath: path.resolve(wtPath), projectDir: projectDir ? path.resolve(projectDir) : null, runtimeRoot },
    nativeParity,
  );
}

export async function gitStashLockPathAsync(wtPath, projectDir = null, { signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.stashLockPath",
    { wtPath: path.resolve(wtPath), projectDir: projectDir ? path.resolve(projectDir) : null, runtimeRoot: getRuntimeRoot(projectDir || wtPath) },
    { ...nativeParity, signal },
  );
}

export function gitBranchLockPath(wtPath, branchName, projectDir = null, nativeParity = {}) {
  const runtimeRoot = getRuntimeRoot(projectDir || wtPath);
  try { ensurePosseGitInfoExclude(projectDir || wtPath); } catch { /* best effort */ }
  return runGitNativeMethod(
    "git.worktree.branchLockPath",
    {
      wtPath: path.resolve(wtPath),
      projectDir: projectDir ? path.resolve(projectDir) : null,
      branchName,
      runtimeRoot,
    },
    nativeParity,
  );
}

export function withWorktreeLock(wtPath, projectDir, fn, opts = {}) {
  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  const lock = acquireWorktreeLock(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export async function withWorktreeLockAsync(wtPath, projectDir, fn, opts = {}) {
  const lockPath = worktreeLockPath(wtPath, projectDir);
  const lock = await acquireWorktreeLockAsync(lockPath, opts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
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
    throw new Error(`Timed out waiting for git branch lock: ${lockPath}`);
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
    throw new Error(`Timed out waiting for git branch lock: ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    await lock.releaseAsync();
  }
}
