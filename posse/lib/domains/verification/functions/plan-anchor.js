import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { adminGitExec, adminGitExecAsync } from "../../git/functions/admin-git-exec.js";
import { porcelainStatusEntries } from "../../git/functions/worktree-recovery.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { PLAN_ANCHOR_GIT_TIMEOUT_MS, PLAN_ANCHOR_MAX_FILES } from "../../../catalog/planning.js";

const COMMIT = /^[0-9a-f]{40}$/i;
const LOG_COMMIT_MARK = "\x01";

// Planning is synchronous and may precede the native Git pulse warmup. These
// bounded, read-only identity probes use the bootstrap Git adapter.
function anchorGit(args, cwd) {
  try { return adminGitExec(args, cwd, { timeoutMs: PLAN_ANCHOR_GIT_TIMEOUT_MS }); } catch { return ""; }
}

// The drift check runs while a dev or fix prompt is built, so it uses the
// same adapter without blocking the event loop.
async function anchorGitAsync(args, cwd, options = {}) {
  try { return await adminGitExecAsync(args, cwd, { timeoutMs: PLAN_ANCHOR_GIT_TIMEOUT_MS, ...options }); } catch { return ""; }
}

// `git log -z --format=%x01%H --name-only`: a marked commit token, then its
// NUL-terminated paths (the first one after a newline). Returns path -> commits,
// newest first.
function commitsByPath(output) {
  const byPath = new Map();
  let commit = null;
  let firstPath = false;
  for (const token of String(output || "").split("\0")) {
    if (token.startsWith(LOG_COMMIT_MARK)) {
      commit = token.slice(LOG_COMMIT_MARK.length).trim();
      firstPath = true;
      continue;
    }
    const file = firstPath && token.startsWith("\n") ? token.slice(1) : token;
    firstPath = false;
    if (!file || !COMMIT.test(commit || "")) continue;
    if (!byPath.has(file)) byPath.set(file, []);
    byPath.get(file).push(commit);
  }
  return byPath;
}

function safeFile(root, relative) {
  const value = String(relative || "").replace(/\\/g, "/");
  if (!value || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const absolute = path.resolve(root, value);
  return absolute.startsWith(`${path.resolve(root)}${path.sep}`) ? absolute : null;
}

/** A content identity for one planned source path; null means absent. */
export function planFileSha256(root, relative) {
  const absolute = safeFile(root, relative);
  if (!absolute) return undefined;
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) { return error?.code === "ENOENT" ? null : undefined; }
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) return hash.update(`symlink\0${fs.readlinkSync(absolute)}`).digest("hex");
  if (!stat.isFile()) return undefined;
  const real = fs.realpathSync(absolute);
  if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) return undefined;
  const fd = fs.openSync(absolute, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

export function snapshotPlanAnchor(root, files, { git = anchorGit } = {}) {
  const baseCommit = String(git(["rev-parse", "HEAD"], root) || "").trim();
  if (!COMMIT.test(baseCommit)) return null;
  const hashes = {};
  for (const file of [...new Set(files || [])].slice(0, PLAN_ANCHOR_MAX_FILES)) {
    const hash = planFileSha256(root, file);
    if (hash !== undefined) hashes[String(file).replace(/\\/g, "/")] = hash;
  }
  return { base_commit: baseCommit, file_sha256: hashes };
}

/**
 * Only outside commits or uncommitted changes produce a prompt notice. Files
 * whose content still matches the plan need no Git at all; the rest share one
 * history query and one status query.
 */
export async function planAnchorDrift(payload, files, cwd, workItemId, { git = anchorGitAsync, db = getDb() } = {}) {
  const base = String(payload?._plan_base_commit || "");
  const hashes = payload?._plan_file_sha256;
  if (!COMMIT.test(base) || !hashes || typeof hashes !== "object" || Array.isArray(hashes)) return null;
  const changed = [];
  for (const file of [...new Set(files || [])].slice(0, PLAN_ANCHOR_MAX_FILES)) {
    const relative = String(file).replace(/\\/g, "/");
    if (!Object.hasOwn(hashes, relative)) continue;
    const current = planFileSha256(cwd, relative);
    if (current === undefined || current === hashes[relative]) continue;
    changed.push({ relative, current });
  }
  if (changed.length === 0) return { base_commit: base, current_head: null, entries: [] };
  let ownCommits = new Set();
  try {
    ownCommits = new Set(db.prepare(`
      SELECT a.commit_hash FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE j.work_item_id = ? AND a.commit_hash IS NOT NULL
    `).all(workItemId).map((row) => String(row.commit_hash).trim()));
  } catch { /* Missing provenance must produce a conservative notice. */ }
  // Log and status name paths from the repository root; scoped paths are
  // relative to cwd, which may be a subdirectory. Read that prefix with HEAD.
  const [prefix = "", headLine = ""] = String(await git(["rev-parse", "--show-prefix", "HEAD"], cwd, { trim: false }) || "").split("\n");
  const head = headLine.trim();
  const local = (byRootPath) => new Map([...byRootPath]
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, value]) => [name.slice(prefix.length), value]));
  const mergeBase = COMMIT.test(head) ? String(await git(["merge-base", base, head], cwd) || "").trim() : "";
  const comparable = mergeBase === base;
  const paths = changed.map((entry) => entry.relative);
  // `-c` lists a merge's path only when it differs from every parent, the
  // same rule a single-path log uses to show the merge at all.
  const history = comparable
    ? local(commitsByPath(await git(["--literal-pathspecs", "log", "-z", "-c", "--no-renames", "--format=%x01%H", "--name-only",
      `${base}..${head}`, "--", ...paths], cwd, { trim: false })))
    : new Map();
  const status = local(porcelainStatusEntries(await git(["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--", ...paths], cwd, { trim: false })));
  const entries = [];
  for (const { relative, current } of changed) {
    const commits = history.get(relative) || [];
    const outside = commits.filter((commit) => !ownCommits.has(commit));
    const dirty = status.has(relative);
    if (comparable && commits.length > 0 && outside.length === 0 && !dirty) continue;
    entries.push({ path: relative, planned_sha256: hashes[relative], current_sha256: current,
      outside_commits: outside.slice(0, 8), uncommitted: dirty, ancestry_known: comparable });
  }
  return { base_commit: base, current_head: head || null, entries };
}
