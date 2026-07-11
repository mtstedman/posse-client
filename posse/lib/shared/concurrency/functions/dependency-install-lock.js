import crypto from "crypto";
import fs from "fs";
import path from "path";

const LOCK_POLL_MS = 200;
const MALFORMED_LOCK_STALE_MS = 60 * 60 * 1000;
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

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
  return tooOld || !processIsAlive(Number(lock.value?.pid));
}

function releaseOwnedLock(lockPath, token) {
  const lock = readLock(lockPath);
  if (lock?.value?.token !== token) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

function reapStaleLock(lockPath) {
  const reaperPath = `${lockPath}.reaper`;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  let handle = null;
  let created = false;
  try {
    handle = fs.openSync(reaperPath, "wx");
    created = true;
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`, "utf8");
    fs.closeSync(handle);
    handle = null;
  } catch (err) {
    if (handle != null) {
      try { fs.closeSync(handle); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(reaperPath); } catch {}
    }
    if (err?.code !== "EEXIST") throw err;
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
    releaseOwnedLock(reaperPath, token);
  }
}

export function dependencyInstallLockPath(posseRoot) {
  return path.join(path.resolve(posseRoot), ".posse", "deps", "dependency-install.lock");
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
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle = null;
    let created = false;
    try {
      handle = fs.openSync(lockPath, "wx");
      created = true;
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
      }
      if (err?.code !== "EEXIST") throw err;
      if (lockIsStale(lockPath) && reapStaleLock(lockPath)) continue;
      const maxWaitMs = waitMs == null ? null : Math.max(0, Number(waitMs) || 0);
      if (maxWaitMs != null && Date.now() - startedAt >= maxWaitMs) {
        const timeout = new Error(`dependency install lock timed out after ${maxWaitMs}ms: ${lockPath}`);
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
    releaseOwnedLock(lockPath, token);
  }
}
