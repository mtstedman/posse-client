import crypto from "crypto";
import fs from "fs";
import path from "path";
import { managedInstallStateRoot } from "../../platform/functions/managed-install-state.js";

const LOCK_POLL_MS = 200;
const WINDOWS_TRANSIENT_RETRY_MS = 2000;
const RELEASE_RETRY_ATTEMPTS = 5;
const MALFORMED_LOCK_STALE_MS = 30 * 1000;
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LOCK_TOKENS = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return { value, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function lockIsStale(lockPath) {
  const lock = readLock(lockPath);
  if (!lock) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > MALFORMED_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  const acquiredMs = Date.parse(lock.value?.acquired_at || "");
  const tooOld = Number.isFinite(acquiredMs) && Date.now() - acquiredMs > MAX_LOCK_AGE_MS;
  const abandonedByThisProcess = Number(lock.value?.pid) === process.pid
    && !ACTIVE_LOCK_TOKENS.has(lock.value?.token);
  return tooOld || abandonedByThisProcess || !processIsAlive(Number(lock.value?.pid));
}

async function releaseOwnedLock(lockPath, token) {
  for (let attempt = 1; attempt <= RELEASE_RETRY_ATTEMPTS; attempt += 1) {
    const lock = readLock(lockPath);
    if (lock?.value?.token !== token) return true;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      const retryable = isRetryableDependencyLockOpenError(error);
      if (!retryable || attempt >= RELEASE_RETRY_ATTEMPTS) return false;
      await delay(40 * attempt);
    }
  }
  return false;
}

async function reapStaleLock(lockPath) {
  const reaperPath = `${lockPath}.reaper`;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  let handle = null;
  let created = false;
  try {
    handle = fs.openSync(reaperPath, "wx");
    created = true;
    ACTIVE_LOCK_TOKENS.add(token);
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`, "utf8");
    fs.closeSync(handle);
    handle = null;
  } catch (err) {
    if (handle != null) {
      try { fs.closeSync(handle); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(reaperPath); } catch {}
      ACTIVE_LOCK_TOKENS.delete(token);
    }
    if (!isRetryableDependencyLockOpenError(err)) throw err;
    if (lockIsStale(reaperPath)) {
      try { fs.unlinkSync(reaperPath); } catch {}
    }
    return false;
  }

  try {
    if (!lockIsStale(lockPath)) return false;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    await releaseOwnedLock(reaperPath, token);
    ACTIVE_LOCK_TOKENS.delete(token);
  }
}

export function isRetryableDependencyLockOpenError(error, platform = process.platform) {
  if (error?.code === "EEXIST") return true;
  return platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
}

export function dependencyInstallLockPath(posseRoot) {
  return path.join(managedInstallStateRoot(posseRoot), "deps", "dependency-install.lock");
}

export async function withDependencyInstallLock(posseRoot, fn, {
  dryRun = false,
  waitMs = null,
  onProgress = null,
} = {}) {
  if (dryRun) return await fn();
  const lockPath = dependencyInstallLockPath(posseRoot);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  let waitingReported = false;
  let lastOpenError = null;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle = null;
    let created = false;
    try {
      handle = fs.openSync(lockPath, "wx");
      created = true;
      ACTIVE_LOCK_TOKENS.add(token);
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`, "utf8");
      fs.closeSync(handle);
      handle = null;
      break;
    } catch (err) {
      if (handle != null) {
        try { fs.closeSync(handle); } catch {}
      }
      if (created) {
        try { fs.unlinkSync(lockPath); } catch {}
        ACTIVE_LOCK_TOKENS.delete(token);
      }
      if (!isRetryableDependencyLockOpenError(err)) throw err;
      lastOpenError = err;
      if (err?.code !== "EEXIST" && Date.now() - startedAt >= WINDOWS_TRANSIENT_RETRY_MS) throw err;
      if (lockIsStale(lockPath) && await reapStaleLock(lockPath)) continue;
      const maxWaitMs = waitMs == null ? null : Math.max(0, Number(waitMs) || 0);
      if (maxWaitMs != null && Date.now() - startedAt >= maxWaitMs) {
        const lastError = lastOpenError?.code
          ? ` (last open error ${lastOpenError.code}: ${lastOpenError.message || "unknown"})`
          : "";
        const timeout = new Error(`dependency install lock timed out after ${maxWaitMs}ms: ${lockPath}${lastError}`);
        timeout.code = "DEPENDENCY_INSTALL_LOCK_TIMEOUT";
        throw timeout;
      }
      if (!waitingReported) {
        waitingReported = true;
        onProgress?.("waiting for another dependency repair to finish");
      }
      await delay(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    const released = await releaseOwnedLock(lockPath, token);
    ACTIVE_LOCK_TOKENS.delete(token);
    if (!released) onProgress?.("dependency install lock release was deferred; the next repair will reclaim it");
  }
}
