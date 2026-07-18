import fs from "fs";
import path from "path";

import { gitExec } from "../../git/functions/utils.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { readActiveWorktreeCap } from "../../scheduler/functions/config.js";
import {
  getProviderCapacityState,
  getProviderHealth,
  primeProviderUsageAuth,
  primeProviderUsageAuthAsync,
} from "../../providers/functions/provider.js";

const LOW_DISK_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const CRITICAL_DISK_FREE_BYTES = 512 * 1024 * 1024;
const LOW_DISK_FREE_RATIO = 0.05;
const CRITICAL_DISK_FREE_RATIO = 0.02;
const STALE_LOCK_MS = 10 * 60 * 1000;

function safeStatDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function git(projectDir, args) {
  return gitExec(args, projectDir).trim();
}

function diskProbe(projectDir) {
  try {
    const stat = fs.statfsSync(projectDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : null;
    const critical = freeBytes < CRITICAL_DISK_FREE_BYTES || (freeRatio != null && freeRatio < CRITICAL_DISK_FREE_RATIO);
    const warning = !critical && (freeBytes < LOW_DISK_FREE_BYTES || (freeRatio != null && freeRatio < LOW_DISK_FREE_RATIO));
    return {
      status: critical ? "critical" : warning ? "warning" : "ok",
      free_bytes: freeBytes,
      total_bytes: totalBytes,
      free_ratio: freeRatio,
    };
  } catch (err) {
    return {
      status: "unknown",
      error: err?.message || String(err),
    };
  }
}

function worktreeSlotProbe(projectDir, cap = readActiveWorktreeCap()) {
  const root = path.resolve(projectDir, ".posse-worktrees");
  const dirs = listDirs(root).filter((name) => /^wi-\d+\b/.test(name));
  const activeCount = dirs.length;
  const normalizedCap = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Number(cap) : null;
  const available = normalizedCap == null ? null : Math.max(0, normalizedCap - activeCount);
  return {
    status: normalizedCap != null && activeCount >= normalizedCap ? "critical" : "ok",
    root,
    active_count: activeCount,
    cap: normalizedCap,
    available,
    worktrees: dirs.slice(0, 25),
  };
}

function staleLockProbe(projectDir, staleMs = STALE_LOCK_MS) {
  const runtimeRoot = getRuntimeRoot(projectDir);
  const lockRoots = ["worktree-locks", "git-stash-locks", "git-branch-locks"]
    .map((name) => path.join(runtimeRoot, name));
  const now = Date.now();
  const locks = [];
  for (const lockRoot of lockRoots) {
    for (const lockPath of listFiles(lockRoot)) {
      let stat = null;
      let owner = null;
      try {
        stat = fs.statSync(lockPath);
        owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        // Keep malformed locks visible; they can still block setup.
      }
      const createdAtMs = Date.parse(owner?.createdAt || "") || Number(stat?.mtimeMs || 0);
      const ageMs = createdAtMs > 0 ? Math.max(0, now - createdAtMs) : null;
      if (ageMs == null || ageMs < staleMs) continue;
      locks.push({
        path: lockPath,
        age_ms: ageMs,
        pid: owner?.pid ?? null,
        created_at: owner?.createdAt || null,
      });
    }
  }
  return {
    status: locks.length > 0 ? "warning" : "ok",
    stale_ms: staleMs,
    count: locks.length,
    locks: locks.slice(0, 25),
  };
}

function recoveredWorktreeProbe(projectDir) {
  const runtimeRoot = getRuntimeRoot(projectDir);
  const recoveredRoot = path.join(runtimeRoot, "recovered-worktrees");
  const legacyRoot = path.resolve(projectDir, ".posse-worktrees");
  const recovered = safeStatDir(recoveredRoot) ? listDirs(recoveredRoot) : [];
  const legacyRecovered = listDirs(legacyRoot).filter((name) => name.startsWith(".recovered-"));
  const count = recovered.length + legacyRecovered.length;
  return {
    status: count > 0 ? "warning" : "ok",
    count,
    recovered_root: recoveredRoot,
    recovered: recovered.slice(0, 25),
    legacy_recovered: legacyRecovered.slice(0, 25),
  };
}

export function workspaceHealthProbe(projectDir = process.cwd(), opts = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const disk = diskProbe(root);
  const worktrees = worktreeSlotProbe(root, opts.worktreeCap);
  const staleLocks = staleLockProbe(root, opts.staleLockMs || STALE_LOCK_MS);
  const recoveredWorktrees = recoveredWorktreeProbe(root);
  const checks = { disk, worktrees, stale_locks: staleLocks, recovered_worktrees: recoveredWorktrees };
  const statuses = Object.values(checks).map((check) => check.status);
  const ok = !statuses.includes("critical");
  return {
    ok,
    status: statuses.includes("critical") ? "critical" : statuses.includes("warning") ? "warning" : "ok",
    project_dir: root,
    checks,
  };
}

// ── Async (off-event-loop) variants ─────────────────────────────────────────
// The sync probes above use fs.*Sync, which blocks the event loop — during boot
// that freezes the panel spinners and stalls scheduler-lock renewal. These
// async variants do the same work via fs.promises (libuv threadpool) so the
// boot UX keeps animating while the probe runs. Behaviour/return shape is
// identical to the sync versions; keep the two in sync.

async function safeStatDirAsync(dirPath) {
  try {
    return (await fs.promises.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirsAsync(dirPath) {
  try {
    return (await fs.promises.readdir(dirPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFilesAsync(dirPath) {
  try {
    return (await fs.promises.readdir(dirPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

async function diskProbeAsync(projectDir) {
  try {
    // fs.promises.statfs lands the syscall on the threadpool; fall back to the
    // sync probe only if this Node build predates it.
    if (typeof fs.promises.statfs !== "function") return diskProbe(projectDir);
    const stat = await fs.promises.statfs(projectDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : null;
    const critical = freeBytes < CRITICAL_DISK_FREE_BYTES || (freeRatio != null && freeRatio < CRITICAL_DISK_FREE_RATIO);
    const warning = !critical && (freeBytes < LOW_DISK_FREE_BYTES || (freeRatio != null && freeRatio < LOW_DISK_FREE_RATIO));
    return {
      status: critical ? "critical" : warning ? "warning" : "ok",
      free_bytes: freeBytes,
      total_bytes: totalBytes,
      free_ratio: freeRatio,
    };
  } catch (err) {
    return { status: "unknown", error: err?.message || String(err) };
  }
}

async function worktreeSlotProbeAsync(projectDir, cap = readActiveWorktreeCap()) {
  const root = path.resolve(projectDir, ".posse-worktrees");
  const dirs = (await listDirsAsync(root)).filter((name) => /^wi-\d+\b/.test(name));
  const activeCount = dirs.length;
  const normalizedCap = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Number(cap) : null;
  const available = normalizedCap == null ? null : Math.max(0, normalizedCap - activeCount);
  return {
    status: normalizedCap != null && activeCount >= normalizedCap ? "critical" : "ok",
    root,
    active_count: activeCount,
    cap: normalizedCap,
    available,
    worktrees: dirs.slice(0, 25),
  };
}

async function staleLockProbeAsync(projectDir, staleMs = STALE_LOCK_MS) {
  const runtimeRoot = getRuntimeRoot(projectDir);
  const lockRoots = ["worktree-locks", "git-stash-locks", "git-branch-locks"]
    .map((name) => path.join(runtimeRoot, name));
  const now = Date.now();
  const locks = [];
  for (const lockRoot of lockRoots) {
    for (const lockPath of await listFilesAsync(lockRoot)) {
      let stat = null;
      let owner = null;
      try {
        stat = await fs.promises.stat(lockPath);
        owner = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
      } catch {
        // Keep malformed locks visible; they can still block setup.
      }
      const createdAtMs = Date.parse(owner?.createdAt || "") || Number(stat?.mtimeMs || 0);
      const ageMs = createdAtMs > 0 ? Math.max(0, now - createdAtMs) : null;
      if (ageMs == null || ageMs < staleMs) continue;
      locks.push({ path: lockPath, age_ms: ageMs, pid: owner?.pid ?? null, created_at: owner?.createdAt || null });
    }
  }
  return { status: locks.length > 0 ? "warning" : "ok", stale_ms: staleMs, count: locks.length, locks: locks.slice(0, 25) };
}

async function recoveredWorktreeProbeAsync(projectDir) {
  const runtimeRoot = getRuntimeRoot(projectDir);
  const recoveredRoot = path.join(runtimeRoot, "recovered-worktrees");
  const legacyRoot = path.resolve(projectDir, ".posse-worktrees");
  const recovered = (await safeStatDirAsync(recoveredRoot)) ? await listDirsAsync(recoveredRoot) : [];
  const legacyRecovered = (await listDirsAsync(legacyRoot)).filter((name) => name.startsWith(".recovered-"));
  const count = recovered.length + legacyRecovered.length;
  return {
    status: count > 0 ? "warning" : "ok",
    count,
    recovered_root: recoveredRoot,
    recovered: recovered.slice(0, 25),
    legacy_recovered: legacyRecovered.slice(0, 25),
  };
}

export async function workspaceHealthProbeAsync(projectDir = process.cwd(), opts = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const [disk, worktrees, staleLocks, recoveredWorktrees] = await Promise.all([
    diskProbeAsync(root),
    worktreeSlotProbeAsync(root, opts.worktreeCap),
    staleLockProbeAsync(root, opts.staleLockMs || STALE_LOCK_MS),
    recoveredWorktreeProbeAsync(root),
  ]);
  const checks = { disk, worktrees, stale_locks: staleLocks, recovered_worktrees: recoveredWorktrees };
  const statuses = Object.values(checks).map((check) => check.status);
  const ok = !statuses.includes("critical");
  return {
    ok,
    status: statuses.includes("critical") ? "critical" : statuses.includes("warning") ? "warning" : "ok",
    project_dir: root,
    checks,
  };
}

export function formatWorkspaceHealthProbe(probe) {
  const parts = [];
  const disk = probe?.checks?.disk || {};
  if (disk.status !== "unknown") {
    const gb = disk.free_bytes != null ? (disk.free_bytes / 1024 / 1024 / 1024).toFixed(1) : "?";
    const percent = disk.free_ratio != null ? `${(disk.free_ratio * 100).toFixed(1)}%` : "?";
    parts.push(`disk ${disk.status} (${gb} GB free, ${percent})`);
  } else {
    parts.push(`disk unknown (${disk.error || "unavailable"})`);
  }
  const wt = probe?.checks?.worktrees || {};
  parts.push(`worktrees ${wt.status} (${wt.active_count ?? 0}${wt.cap ? `/${wt.cap}` : ""} active)`);
  const locks = probe?.checks?.stale_locks || {};
  parts.push(`stale locks ${locks.count || 0}`);
  const recovered = probe?.checks?.recovered_worktrees || {};
  parts.push(`recovered backlog ${recovered.count || 0}`);
  return parts.join("; ");
}

export function formatWorkspaceHealthCriticalDetail(probe) {
  const reasons = [];
  const disk = probe?.checks?.disk || {};
  if (disk.status === "critical") {
    const gb = disk.free_bytes != null ? (disk.free_bytes / 1024 / 1024 / 1024).toFixed(1) : "?";
    const percent = disk.free_ratio != null ? `${(disk.free_ratio * 100).toFixed(1)}%` : "?";
    reasons.push(`Low space: ${gb} GB free (${percent})`);
  }
  const worktrees = probe?.checks?.worktrees || {};
  if (worktrees.status === "critical") {
    const count = worktrees.active_count ?? 0;
    const capacity = worktrees.cap != null ? `${count}/${worktrees.cap}` : String(count);
    reasons.push(`Worktree slots full: ${capacity} active`);
  }
  return reasons.join("; ") || "Critical workspace condition";
}

export function branchStalenessCheck({
  projectDir = process.cwd(),
  branchName = null,
  targetBranch = null,
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const branch = String(branchName || "").trim();
  // No implicit resolveTargetBranch fallback: every caller passes targetBranch
  // (resolved async upstream), and a missing target degrades to "unknown" below.
  const target = String(targetBranch || "").trim();
  if (!branch) return { ok: false, status: "unknown", reason: "missing branchName", project_dir: root };
  if (!target) return { ok: false, status: "unknown", reason: "missing targetBranch", project_dir: root, branch };
  try {
    git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
    git(root, ["rev-parse", "--verify", `${target}^{commit}`]);
    const [aheadRaw, behindRaw] = git(root, ["rev-list", "--left-right", "--count", `${branch}...${target}`]).split(/\s+/);
    const mergeBase = git(root, ["merge-base", branch, target]);
    const ahead = Number.parseInt(aheadRaw, 10) || 0;
    const behind = Number.parseInt(behindRaw, 10) || 0;
    return {
      ok: true,
      status: behind > 0 ? "stale" : "fresh",
      project_dir: root,
      branch,
      target_branch: target,
      ahead,
      behind,
      merge_base: mergeBase,
      needs_rebase: behind > 0,
    };
  } catch (err) {
    return {
      ok: false,
      status: "unknown",
      project_dir: root,
      branch,
      target_branch: target,
      reason: err?.message?.split("\n")[0] || String(err),
    };
  }
}

export function formatBranchStalenessCheck(result) {
  if (!result?.ok) return `branch staleness unknown (${result?.reason || "probe failed"})`;
  if (result.behind > 0) {
    return `${result.branch} is ${result.behind} commit(s) behind ${result.target_branch}; target merge needed before dev`;
  }
  return `${result.branch} is fresh against ${result.target_branch}`;
}

export function providerAuthLivenessProbe({
  projectDir = process.cwd(),
  providers = null,
  primeAuth = true,
  forcePrimeAuth = false,
  timeoutMs = 20_000,
} = {}) {
  const prime = primeAuth
    ? primeProviderUsageAuth({ cwd: projectDir, force: forcePrimeAuth, timeoutMs })
    : { attempted: false, ok: true, skipped: "disabled", providers: [] };
  const wanted = providers == null
    ? null
    : new Set([...(Array.isArray(providers) ? providers : [providers])].map((name) => String(name || "").trim().toLowerCase()).filter(Boolean));
  const rows = getProviderHealth()
    .filter((row) => !wanted || wanted.has(String(row.provider || "").replace(/-images$/, "").toLowerCase()))
    .map((row) => {
      let capacity = null;
      if (!String(row.provider || "").endsWith("-images")) {
        try { capacity = getProviderCapacityState(row.provider); } catch { capacity = null; }
      }
      return {
        provider: row.provider,
        ready: row.status === "available",
        status: row.status,
        detail: row.detail || null,
        capacity,
      };
    });
  return {
    ok: rows.every((row) => row.ready),
    prime,
    providers: rows,
  };
}

export async function providerAuthLivenessProbeAsync({
  projectDir = process.cwd(),
  providers = null,
  primeAuth = true,
  forcePrimeAuth = false,
  timeoutMs = 20_000,
} = {}) {
  const prime = primeAuth
    ? await primeProviderUsageAuthAsync({ cwd: projectDir, force: forcePrimeAuth, timeoutMs })
    : { attempted: false, ok: true, skipped: "disabled", providers: [] };
  const wanted = providers == null
    ? null
    : new Set([...(Array.isArray(providers) ? providers : [providers])].map((name) => String(name || "").trim().toLowerCase()).filter(Boolean));
  const rows = getProviderHealth()
    .filter((row) => !wanted || wanted.has(String(row.provider || "").replace(/-images$/, "").toLowerCase()))
    .map((row) => {
      let capacity = null;
      if (!String(row.provider || "").endsWith("-images")) {
        try { capacity = getProviderCapacityState(row.provider); } catch { capacity = null; }
      }
      return {
        provider: row.provider,
        ready: row.status === "available",
        status: row.status,
        detail: row.detail || null,
        capacity,
      };
    });
  return {
    ok: rows.every((row) => row.ready),
    prime,
    providers: rows,
  };
}

export function formatProviderAuthLivenessProbe(probe) {
  const rows = Array.isArray(probe?.providers) ? probe.providers : [];
  if (rows.length === 0) return "provider auth liveness: no configured providers";
  return rows.map((row) => {
    const detail = row.detail ? ` (${row.detail})` : "";
    return `${row.provider}: ${row.status}${detail}`;
  }).join("; ");
}
