// Direct system-Git adapter for operator/admin CLI commands.
//
// Agent work remains behind the native daemon/MCP toolchain. Bossy and other
// operator surfaces are not agent dispatch, so their status/merge workflow
// must not depend on native heartbeat availability.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new TypeError("admin Git execution requires an argv array");
  return args.map((arg) => String(arg));
}

function commandFailure(args, error) {
  const failure = error instanceof Error ? error : new Error(String(error || "git failed"));
  failure.stdout = error?.stdout == null ? "" : String(error.stdout);
  failure.stderr = error?.stderr == null ? "" : String(error.stderr);
  failure.status = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : 1);
  failure.code = failure.status;
  failure.gitCommandFailed = true;
  if (!failure.message || failure.message === "Command failed") {
    failure.message = failure.stderr.trim() || failure.stdout.trim() || `git ${args.join(" ")} failed`;
  }
  return failure;
}

export function adminGitExec(args, cwd, {
  trim = true,
  input = undefined,
  maxBuffer = DEFAULT_MAX_BUFFER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeout = undefined,
  encoding = "utf8",
} = {}) {
  const argv = normalizeArgs(args);
  try {
    const output = execFileSync("git", argv, {
      cwd,
      encoding: encoding === "buffer" ? "buffer" : "utf8",
      input: input == null ? undefined : input,
      maxBuffer,
      timeout: timeout ?? timeoutMs,
      windowsHide: true,
    });
    if (Buffer.isBuffer(output)) return output;
    const text = String(output ?? "");
    return trim ? text.trim() : text;
  } catch (error) {
    throw commandFailure(argv, error);
  }
}

export function adminGitExecAsync(args, cwd, {
  trim = true,
  input = undefined,
  maxBuffer = DEFAULT_MAX_BUFFER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeout = undefined,
  encoding = "utf8",
  signal = undefined,
} = {}) {
  const argv = normalizeArgs(args);
  return new Promise((resolve, reject) => {
    const child = execFile("git", argv, {
      cwd,
      encoding: encoding === "buffer" ? "buffer" : "utf8",
      maxBuffer,
      timeout: timeout ?? timeoutMs,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(commandFailure(argv, error));
        return;
      }
      if (Buffer.isBuffer(stdout)) {
        resolve(stdout);
        return;
      }
      const text = String(stdout ?? "");
      resolve(trim ? text.trim() : text);
    });
    if (input != null && child.stdin) child.stdin.end(input);
  });
}

export function adminWorktreeRoot(projectDir) {
  return path.join(path.resolve(projectDir), ".posse-worktrees");
}

export function adminWorktreePath(projectDir, wiId) {
  return path.join(adminWorktreeRoot(projectDir), `wi-${wiId}`);
}

export function findAdminLegacyWorktree(projectDir, wiId) {
  const root = adminWorktreeRoot(projectDir);
  const prefix = `wi-${wiId}-`;
  try {
    const entry = fs.readdirSync(root, { withFileTypes: true })
      .find((candidate) => candidate.isDirectory() && candidate.name.startsWith(prefix));
    return entry ? path.join(root, entry.name) : null;
  } catch {
    return null;
  }
}

function adminBranchExists(projectDir, branchName) {
  try {
    adminGitExec(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], projectDir, { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function recoveryRefPart(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "");
  return normalized || fallback;
}

export function adminDeleteBranchPreservingTip(projectDir, branchName, {
  targetBranch = "main",
  reason = "branch-cleanup",
  wiId = null,
  onMsg = null,
} = {}) {
  const branch = String(branchName || "").trim();
  if (!branch) return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "missing_branch_name" };
  if (!adminBranchExists(projectDir, branch)) {
    return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "branch_missing" };
  }

  let ancestorSafe = false;
  try {
    adminGitExec(["merge-base", "--is-ancestor", branch, targetBranch], projectDir, { timeoutMs: 5000 });
    ancestorSafe = true;
  } catch {
    ancestorSafe = false;
  }

  let snapshotRef = null;
  if (!ancestorSafe) {
    const wiPart = wiId == null ? "branch" : `wi-${recoveryRefPart(wiId, "unknown")}`;
    const branchPart = recoveryRefPart(branch, "tip").replace(/\//g, "-");
    const reasonPart = recoveryRefPart(reason, "cleanup").replace(/\//g, "-");
    snapshotRef = `refs/posse/recovery/${wiPart}-${reasonPart}-${branchPart}-${Date.now()}`;
    try {
      adminGitExec(["update-ref", snapshotRef, branch], projectDir, { timeoutMs: 5000 });
      if (typeof onMsg === "function") onMsg(`Preserved ${branch} at ${snapshotRef} before branch cleanup`);
    } catch (error) {
      return {
        ok: false,
        existed: true,
        deleted: false,
        snapshotRef: null,
        reason: "snapshot_failed",
        error: error?.message || String(error),
      };
    }
  }

  try {
    adminGitExec(["branch", ancestorSafe ? "-d" : "-D", branch], projectDir);
  } catch (error) {
    return {
      ok: false,
      existed: true,
      deleted: false,
      snapshotRef,
      reason: "branch_delete_failed",
      error: error?.message || String(error),
    };
  }
  return {
    ok: !adminBranchExists(projectDir, branch),
    existed: true,
    deleted: !adminBranchExists(projectDir, branch),
    snapshotRef,
    reason: ancestorSafe ? "ancestor_merged" : "snapshot_preserved",
  };
}

export function adminPreserveDirtyWorktreeSnapshot(wtPath, projectDir, {
  reason = "dirty-worktree",
  wiId = null,
  onMsg = null,
} = {}) {
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const safeReason = recoveryRefPart(reason, "dirty-worktree").replace(/\//g, "-");
  const wiPart = wiId == null ? "worktree" : `wi-${recoveryRefPart(wiId, "unknown")}`;
  const capturedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const refName = `refs/posse/snapshots/${wiPart}-${safeReason}-${capturedAt}-${token}`;
  const message = `posse-snapshot:${reason}:${token}`;
  try {
    const status = adminGitExec(["status", "--porcelain"], wtPath, { timeoutMs: 5000 });
    if (!String(status || "").trim()) return null;
    adminGitExec(["stash", "push", "--include-untracked", "-m", message], wtPath);
    const entries = String(adminGitExec(["stash", "list", "--format=%H%x00%gd%x00%s"], wtPath) || "")
      .split(/\r?\n/)
      .map((line) => line.split("\0"))
      .filter((parts) => parts.length >= 3);
    const entry = entries.find((parts) => parts.slice(2).join("\0").includes(token));
    const stashHash = entry?.[0] || "";
    const stashRef = entry?.[1] || "";
    if (!stashHash || !stashRef) return null;
    adminGitExec(["update-ref", refName, stashHash], projectDir);
    try {
      adminGitExec(["stash", "apply", "--index", stashHash], wtPath);
    } catch (error) {
      if (typeof onMsg === "function") {
        onMsg(`snapshot restore failed after pinning ${refName}; restore manually with git stash apply ${refName} (${error?.message || String(error)})`);
      }
      return refName;
    }
    try { adminGitExec(["stash", "drop", stashRef], wtPath); } catch { /* pinned ref remains authoritative */ }
    return refName;
  } catch (error) {
    if (typeof onMsg === "function") onMsg(`snapshot failed for ${wtPath}: ${error?.message || String(error)}`);
    throw error;
  }
}
