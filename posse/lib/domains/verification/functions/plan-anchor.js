import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import { getDb } from "../../../shared/storage/functions/index.js";

const COMMIT = /^[0-9a-f]{40}$/i;
const MAX_ANCHOR_FILES = 100;

// Planning is synchronous and may precede the native Git pulse warmup. These
// bounded, read-only identity probes use the bootstrap Git adapter.
function anchorGit(args, cwd) {
  try { return adminGitExec(args, cwd, { timeoutMs: 5_000 }); } catch { return ""; }
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
  for (const file of [...new Set(files || [])].slice(0, MAX_ANCHOR_FILES)) {
    const hash = planFileSha256(root, file);
    if (hash !== undefined) hashes[String(file).replace(/\\/g, "/")] = hash;
  }
  return { base_commit: baseCommit, file_sha256: hashes };
}

/** Only outside commits or uncommitted changes produce a prompt notice. */
export function planAnchorDrift(payload, files, cwd, workItemId, { git = anchorGit, db = getDb() } = {}) {
  const base = String(payload?._plan_base_commit || "");
  const hashes = payload?._plan_file_sha256;
  if (!COMMIT.test(base) || !hashes || typeof hashes !== "object" || Array.isArray(hashes)) return null;
  let ownCommits = new Set();
  try {
    ownCommits = new Set(db.prepare(`
      SELECT a.commit_hash FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE j.work_item_id = ? AND a.commit_hash IS NOT NULL
    `).all(workItemId).map((row) => String(row.commit_hash).trim()));
  } catch { /* Missing provenance must produce a conservative notice. */ }
  const head = String(git(["rev-parse", "HEAD"], cwd) || "").trim();
  const mergeBase = COMMIT.test(head) ? String(git(["merge-base", base, head], cwd) || "").trim() : "";
  const comparable = mergeBase === base;
  const entries = [];
  for (const file of [...new Set(files || [])].slice(0, MAX_ANCHOR_FILES)) {
    const relative = String(file).replace(/\\/g, "/");
    if (!Object.hasOwn(hashes, relative)) continue;
    const current = planFileSha256(cwd, relative);
    if (current === undefined || current === hashes[relative]) continue;
    const commits = comparable ? String(git(["log", "--format=%H", `${base}..${head}`, "--", relative], cwd) || "")
      .split("\n").filter((commit) => COMMIT.test(commit)) : [];
    const outside = commits.filter((commit) => !ownCommits.has(commit));
    const dirty = !!String(git(["status", "--porcelain", "--", relative], cwd) || "").trim();
    if (comparable && commits.length > 0 && outside.length === 0 && !dirty) continue;
    entries.push({ path: relative, planned_sha256: hashes[relative], current_sha256: current,
      outside_commits: outside.slice(0, 8), uncommitted: dirty, ancestry_known: comparable });
  }
  return { base_commit: base, current_head: head || null, entries };
}
