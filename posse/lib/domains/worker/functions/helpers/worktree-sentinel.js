// lib/worker/helpers/worktree-sentinel.js
//
// The `.posse` active-job sentinel concern extracted from
// worktree-lifecycle.js: resolving the worktree repo root, locating and
// reading/writing/clearing the active-job sentinel file, and the liveness /
// queue-state checks that decide whether a sentinel still owns the worktree.

import fs from "fs";
import path from "path";
import { gitExec } from "../../../git/functions/utils.js";
import { getJob } from "../../../queue/functions/index.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);

// Memoized per path: the worktree's repo root cannot change for the lifetime
// of a session, and this backs the active-job sentinel which is read/written
// several times per job — without the cache each touch pays a synchronous
// `git rev-parse` on the main thread. Only successful resolutions are cached
// (a pre-creation miss must retry once the worktree exists).
const _worktreeRootCache = new Map();

function resolveWorktreeRoot(wtPath) {
  if (!wtPath) return null;
  const key = path.resolve(wtPath);
  const cached = _worktreeRootCache.get(key);
  if (cached) return cached;
  try {
    const root = path.resolve(gitExec(["rev-parse", "--show-toplevel"], wtPath));
    _worktreeRootCache.set(key, root);
    return root;
  } catch {
    return key;
  }
}

function activeWorktreeSentinelPath(wtPath, { ensureDir = false } = {}) {
  const root = resolveWorktreeRoot(wtPath);
  if (!root) return null;
  const posseDir = path.join(root, ".posse");
  if (ensureDir) fs.mkdirSync(posseDir, { recursive: true });
  return path.join(posseDir, "active-job");
}

export function writeActiveWorktreeSentinel(wtPath, payload = {}) {
  const sentinelPath = activeWorktreeSentinelPath(wtPath, { ensureDir: true });
  if (!sentinelPath) return null;
  fs.writeFileSync(sentinelPath, `${JSON.stringify({
    ...payload,
    written_at: new Date().toISOString(),
  })}\n`, "utf-8");
  return sentinelPath;
}

export function readActiveWorktreeSentinel(wtPath) {
  const sentinelPath = activeWorktreeSentinelPath(wtPath, { ensureDir: false });
  if (!sentinelPath || !fs.existsSync(sentinelPath)) return null;
  try {
    const raw = fs.readFileSync(sentinelPath, "utf-8");
    const payload = JSON.parse(raw);
    return { sentinelPath, payload };
  } catch {
    return { sentinelPath, payload: null };
  }
}

export function isSentinelProcessAlive(payload = {}) {
  const pid = Number(payload?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    return null;
  }
}

export function clearActiveWorktreeSentinel(wtPath, { jobId = null } = {}) {
  const current = readActiveWorktreeSentinel(wtPath);
  if (!current?.sentinelPath) return false;
  if (jobId != null && current?.payload?.jobId != null && Number(current.payload.jobId) !== Number(jobId)) {
    const alive = isSentinelProcessAlive(current.payload);
    if (alive === true) return false;
  }
  try {
    fs.rmSync(current.sentinelPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function sentinelJobStillActive(payload = {}) {
  const jobId = Number(payload?.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return true;
  try {
    const job = getJob(jobId);
    if (!job) return false;
    return !TERMINAL_JOB_STATUS_SET.has(job.status);
  } catch {
    return true;
  }
}
