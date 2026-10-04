// lib/domains/worker/functions/helpers/worktree-sentinel.js
//
// The `.posse` active-job sentinel concern extracted from
// worktree-lifecycle.js: resolving the worktree repo root, locating and
// reading/writing/clearing the active-job sentinel file, and the liveness /
// queue-state checks that decide whether a sentinel still owns the worktree.

import fs from "fs";
import path from "path";
import { gitExec, isGitCommandFailure } from "../../../git/functions/utils.js";
import { getJob } from "../../../queue/functions/index.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import { ensurePosseGitInfoExclude } from "../../../runtime/functions/ignore.js";

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
  // Defense one: make a newly-created runtime sentinel invisible to every
  // worktree's broad `git add`. This is repository-local and never changes a
  // project-owned .gitignore.
  if (ensureDir) ensurePosseGitInfoExclude(root);

  let sentinelPath = path.join(root, ".posse", "active-job");
  let tracked = false;
  try {
    // Legacy repositories can already have the sentinel tracked. Never mutate
    // that project file: doing so makes every scoped job dirty before it can
    // commit. Keep the live sentinel in this worktree's private Git directory
    // until the repository removes the historical path from its index.
    gitExec(["ls-files", "--error-unmatch", "--", ".posse/active-job"], root);
    tracked = true;
  } catch (error) {
    // `ls-files --error-unmatch` exits 1 for an untracked path. Any other
    // failure leaves ownership unknown, so fail closed instead of risking a
    // write through a tracked project file. Lifecycle unit helpers also use
    // this sentinel in plain temporary directories; those have no index to
    // contaminate, so preserve the filesystem-only behavior there.
    const notARepository = isGitCommandFailure(error)
      && Number(error?.status) === 128
      && /not a git repository/i.test(`${error?.stderr || ""}\n${error?.message || ""}`);
    if (!notARepository && (!isGitCommandFailure(error) || Number(error?.status) !== 1)) throw error;
  }
  if (tracked) {
    const gitPath = gitExec(["rev-parse", "--git-path", "posse/active-job"], root).trim();
    sentinelPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(root, gitPath);
  }
  if (ensureDir) fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  return sentinelPath;
}

export function writeActiveWorktreeSentinel(wtPath, payload = {}) {
  const sentinelPath = activeWorktreeSentinelPath(wtPath, { ensureDir: true });
  if (!sentinelPath) return null;
  const writtenAt = new Date().toISOString();
  const current = readActiveWorktreeSentinel(wtPath);
  const jobs = sentinelEntries(current?.payload)
    .filter((entry) => Number(entry?.jobId) !== Number(payload?.jobId));
  jobs.push({ ...payload, written_at: writtenAt });
  fs.writeFileSync(sentinelPath, `${JSON.stringify({
    ...payload,
    written_at: writtenAt,
    jobs,
  })}\n`, "utf-8");
  return sentinelPath;
}

export function readActiveWorktreeSentinel(wtPath) {
  // Terminal cleanup commonly runs after a worktree has already disappeared.
  // There cannot be a live sentinel in that case, and asking native Git to
  // inspect the missing directory turns the harmless absence into ENOENT.
  if (!wtPath || !fs.existsSync(wtPath)) return null;
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
  let unknown = false;
  for (const entry of sentinelEntries(payload)) {
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      unknown = true;
      continue;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err?.code !== "ESRCH") unknown = true;
    }
  }
  return unknown ? null : false;
}

export function clearActiveWorktreeSentinel(wtPath, { jobId = null } = {}) {
  const current = readActiveWorktreeSentinel(wtPath);
  if (!current?.sentinelPath) return false;
  const entries = sentinelEntries(current.payload);
  if (jobId != null) {
    const remaining = entries.filter((entry) => Number(entry?.jobId) !== Number(jobId));
    if (remaining.length < entries.length) {
      if (remaining.length === 0) {
        try {
          fs.rmSync(current.sentinelPath, { force: true });
          return true;
        } catch {
          return false;
        }
      }
      const latest = remaining[remaining.length - 1];
      try {
        fs.writeFileSync(current.sentinelPath, `${JSON.stringify({ ...latest, jobs: remaining })}\n`, "utf-8");
        return true;
      } catch {
        return false;
      }
    }
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

export function sentinelEntries(payload) {
  if (Array.isArray(payload?.jobs)) {
    return payload.jobs.filter((entry) => entry && typeof entry === "object");
  }
  return payload && typeof payload === "object" ? [payload] : [];
}

export function sentinelHasOtherLiveJob(payload = {}, jobId = null) {
  let unknown = false;
  for (const entry of sentinelEntries(payload)) {
    if (jobId != null && Number(entry?.jobId) === Number(jobId)) continue;
    const alive = isSentinelProcessAlive(entry);
    if (alive === true) return true;
    if (alive == null) unknown = true;
  }
  return unknown ? null : false;
}

export function sentinelJobStillActive(payload = {}) {
  for (const entry of sentinelEntries(payload)) {
    const jobId = Number(entry?.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) return true;
    try {
      const job = getJob(jobId);
      if (job && !TERMINAL_JOB_STATUS_SET.has(job.status)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
