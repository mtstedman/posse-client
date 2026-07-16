// Read-only git diff collection for the admin Diff Review tab.
//
// The TUI owns selection, focus, and rendering. This module only snapshots the
// live WI branch/worktree diff state and builds selected-file diff text.

import fs from "fs";
import path from "path";
import {
  adminGitExecAsync,
  adminWorktreePath,
  findAdminLegacyWorktree,
} from "../../../git/functions/admin-git.js";
import { resolveTargetBranchForAdmin } from "../../../git/functions/target-branch.js";

const GIT_TIMEOUT_MS = 10000;
const MAX_BUFFER = 1024 * 1024 * 8;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_UNTRACKED_LINES = 500;
// Lines of unchanged context kept around each hunk in the file-detail diff. We
// want the review/TUI panes to show only the changed code with enough
// surrounding lines to orient — not the whole file. A wide context (this used to
// be 80) folds every hunk's window into one another on all but the largest
// files, so the pane effectively reprinted the entire file plus the edits; the
// git default of 3 keeps it to just the modified regions.
const DIFF_CONTEXT_LINES = 3;

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^"\s*/, "")
    .replace(/\s*"$/, "")
    .trim();
}

function isRuntimePath(filePath) {
  const p = normalizePath(filePath);
  return p === ".posse"
    || p.startsWith(".posse/")
    || p === ".posse-worktrees"
    || p.startsWith(".posse-worktrees/")
    || p === ".posse-test-suites"
    || p.startsWith(".posse-test-suites/");
}

// Async so the whole snapshot/detail build can run off the TUI render thread:
// the old execFileSync fan-out (~6 spawns per WI × up to 200 WIs) blocked
// keypress/render for seconds. Each await yields the event loop, so the TUI
// stays responsive while the snapshot builds in the background.
async function safeGit(cwd, args, { allowFailure = false, maxBuffer = MAX_BUFFER } = {}) {
  try {
    return await adminGitExecAsync(["-c", "core.quotePath=false", ...args], cwd, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer,
    });
  } catch (err) {
    if (!allowFailure) throw err;
    const stderr = String(err?.stderr || "").trim();
    const stdout = String(err?.stdout || "");
    return stderr ? `${stdout}\n${stderr}`.trim() : stdout;
  }
}

async function gitBranchExists(cwd, branchName) {
  const branch = String(branchName || "").trim();
  if (!branch) return false;
  try {
    await safeGit(cwd, ["rev-parse", "--verify", `${branch}^{commit}`], { maxBuffer: 1024 * 128 });
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(raw = "") {
  const rows = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0] || "";
    const filePath = normalizePath(parts[parts.length - 1]);
    if (!filePath || isRuntimePath(filePath)) continue;
    rows.push({
      path: filePath,
      statusCode,
      status: statusCode.charAt(0) || "?",
    });
  }
  return rows;
}

function parseNumstat(raw = "") {
  const byPath = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const filePath = normalizePath(parts[parts.length - 1]);
    if (!filePath || isRuntimePath(filePath)) continue;
    const additions = Number.parseInt(parts[0], 10);
    const deletions = Number.parseInt(parts[1], 10);
    const binary = parts[0] === "-" || parts[1] === "-"
      || !Number.isFinite(additions)
      || !Number.isFinite(deletions);
    byPath.set(filePath, {
      additions: binary ? null : additions,
      deletions: binary ? null : deletions,
      binary,
    });
  }
  return byPath;
}

function parseUntracked(raw = "") {
  const rows = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.startsWith("?? ")) continue;
    const filePath = normalizePath(line.slice(3));
    if (!filePath || isRuntimePath(filePath)) continue;
    rows.push({
      path: filePath,
      statusCode: "??",
      status: "?",
      additions: null,
      deletions: null,
      binary: false,
      untracked: true,
    });
  }
  return rows;
}

async function collectDiffRows(cwd, diffSpec) {
  const [nameStatusRaw, numstatRaw] = await Promise.all([
    safeGit(cwd, ["diff", "--relative", "--find-renames", "--name-status", ...diffSpec, "--"]),
    safeGit(cwd, ["diff", "--relative", "--find-renames", "--numstat", ...diffSpec, "--"]),
  ]);
  const nameStatus = parseNameStatus(nameStatusRaw);
  const numstat = parseNumstat(numstatRaw);

  return nameStatus.map((row) => ({
    ...row,
    ...(numstat.get(row.path) || { additions: null, deletions: null, binary: false }),
  }));
}

async function collectWorktreeRows(wtDir) {
  const [rows, untrackedRaw] = await Promise.all([
    collectDiffRows(wtDir, ["HEAD"]),
    safeGit(wtDir, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const untracked = parseUntracked(untrackedRaw);
  for (const row of untracked) {
    if (!byPath.has(row.path)) rows.push(row);
  }
  return rows;
}

function mergeSourceRows({ wi, targetBranch, wtDir, wtExists, branchRows, worktreeRows }) {
  const byPath = new Map();
  const ensure = (filePath) => {
    if (!byPath.has(filePath)) {
      byPath.set(filePath, {
        key: `${wi.id}:${filePath}`,
        wiId: wi.id,
        wiTitle: wi.title || "",
        wiStatus: wi.status || "",
        branchName: wi.branch_name || "",
        mergeState: wi.merge_state || null,
        targetBranch,
        wtDir,
        wtExists,
        path: filePath,
        branchStatus: "",
        worktreeStatus: "",
        hasBranchDiff: false,
        hasWorktreeDiff: false,
        untracked: false,
        binary: false,
        additions: 0,
        deletions: 0,
      });
    }
    return byPath.get(filePath);
  };

  for (const row of branchRows) {
    const entry = ensure(row.path);
    entry.hasBranchDiff = true;
    entry.branchStatus = row.statusCode || row.status || "?";
    entry.binary = entry.binary || !!row.binary;
    if (Number.isFinite(row.additions)) entry.additions += row.additions;
    else entry.additions = null;
    if (Number.isFinite(row.deletions)) entry.deletions += row.deletions;
    else entry.deletions = null;
  }

  for (const row of worktreeRows) {
    const entry = ensure(row.path);
    entry.hasWorktreeDiff = true;
    entry.worktreeStatus = row.statusCode || row.status || "?";
    entry.untracked = entry.untracked || !!row.untracked;
    entry.binary = entry.binary || !!row.binary;
    if (Number.isFinite(entry.additions) && Number.isFinite(row.additions)) entry.additions += row.additions;
    else entry.additions = null;
    if (Number.isFinite(entry.deletions) && Number.isFinite(row.deletions)) entry.deletions += row.deletions;
    else entry.deletions = null;
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveWorktreeDirAsync(projectDir, wiId) {
  if (wiId == null) return null;
  const canonical = adminWorktreePath(projectDir, wiId);
  if (fs.existsSync(canonical)) return canonical;
  return findAdminLegacyWorktree(projectDir, wiId);
}

function lineCount(raw = "") {
  const value = String(raw || "").trim();
  return value ? value.split(/\r?\n/).length : 0;
}

function sumFinite(files, key) {
  return files.reduce((sum, file) => sum + (Number.isFinite(file[key]) ? file[key] : 0), 0);
}

export async function buildAdminGitDiffSnapshot({ projectDir, workItems = [], limit = 200 } = {}) {
  const root = path.resolve(projectDir || process.cwd());
  let targetBranch = "main";
  try { targetBranch = resolveTargetBranchForAdmin(root); } catch { targetBranch = "main"; }

  const items = [];
  const flatFiles = [];
  const candidates = (Array.isArray(workItems) ? workItems : [])
    .filter((wi) => wi && String(wi.branch_name || "").trim())
    .filter((wi) => wi.merge_state !== "merged")
    .slice(0, Math.max(1, limit));

  for (const wi of candidates) {
    const branchName = String(wi.branch_name || "").trim();
    const errors = [];
    let branchRows = [];
    let worktreeRows = [];
    let wtDir = null;
    let wtExists = false;

    if (await gitBranchExists(root, branchName)) {
      try {
        branchRows = await collectDiffRows(root, [`${targetBranch}...${branchName}`]);
      } catch (err) {
        errors.push(`branch diff failed: ${err?.message?.split(/\r?\n/)[0] || err}`);
      }
    } else {
      errors.push(`branch ${branchName} is missing`);
    }

    try {
      wtDir = await resolveWorktreeDirAsync(root, wi.id);
      wtExists = !!(wtDir && fs.existsSync(wtDir));
      if (wtExists) worktreeRows = await collectWorktreeRows(wtDir);
    } catch (err) {
      errors.push(`worktree diff failed: ${err?.message?.split(/\r?\n/)[0] || err}`);
    }

    const files = mergeSourceRows({
      wi,
      targetBranch,
      wtDir,
      wtExists,
      branchRows,
      worktreeRows,
    });

    if (files.length === 0 && errors.length === 0) continue;
    const item = {
      wiId: wi.id,
      title: wi.title || "",
      status: wi.status || "",
      branchName,
      mergeState: wi.merge_state || null,
      targetBranch,
      wtDir,
      wtExists,
      files,
      errors,
      additions: sumFinite(files, "additions"),
      deletions: sumFinite(files, "deletions"),
    };
    items.push(item);
    flatFiles.push(...files);
  }

  return {
    targetBranch,
    generatedAt: Date.now(),
    items,
    files: flatFiles,
    workItemCount: items.length,
    fileCount: flatFiles.length,
    additions: sumFinite(flatFiles, "additions"),
    deletions: sumFinite(flatFiles, "deletions"),
  };
}

function resolvePathUnder(root, filePath) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, normalizePath(filePath));
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function buildUntrackedDiff(file) {
  const abs = resolvePathUnder(file.wtDir, file.path);
  if (!abs) return `Untracked file is outside the worktree: ${file.path}`;
  let stat;
  try { stat = fs.statSync(abs); } catch { return `Untracked file is no longer present: ${file.path}`; }
  if (!stat.isFile()) return `Untracked path is not a regular file: ${file.path}`;
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file.path}`,
      `@@ untracked file omitted (${stat.size} bytes) @@`,
    ].join("\n");
  }

  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) {
    return [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      `Binary files /dev/null and b/${file.path} differ`,
    ].join("\n");
  }

  const text = buf.toString("utf8").replace(/\r\n/g, "\n");
  const allLines = text.split("\n");
  const bodyLines = allLines.slice(0, MAX_UNTRACKED_LINES);
  const truncated = allLines.length > bodyLines.length;
  const lines = [
    `diff --git a/${file.path} b/${file.path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file.path}`,
    `@@ -0,0 +1,${bodyLines.length} @@`,
    ...bodyLines.map((line) => `+${line}`),
  ];
  if (truncated) lines.push(`+... (${allLines.length - bodyLines.length} more lines)`);
  return lines.join("\n");
}

function section(title, raw) {
  const text = String(raw || "").trimEnd();
  if (!text) return [];
  return [`# ${title}`, ...text.split(/\r?\n/), ""];
}

function hunkLineIndexes(lines) {
  const indexes = [];
  lines.forEach((line, index) => {
    if (/^@@\s/.test(String(line || ""))) indexes.push(index);
  });
  return indexes;
}

export async function buildAdminGitDiffFileDetail({ projectDir, file } = {}) {
  if (!file) {
    return { lines: ["No file selected."], hunkLineIndexes: [] };
  }

  const root = path.resolve(projectDir || process.cwd());
  const lines = [];
  const errors = [];

  if (file.hasBranchDiff) {
    try {
      const raw = await safeGit(root, [
        "diff",
        "--relative",
        "--find-renames",
        "--no-ext-diff",
        "--color=never",
        `--unified=${DIFF_CONTEXT_LINES}`,
        `${file.targetBranch || "main"}...${file.branchName}`,
        "--",
        file.path,
      ]);
      lines.push(...section(`BRANCH ${file.targetBranch || "main"}...${file.branchName}`, raw));
    } catch (err) {
      errors.push(`branch diff failed: ${err?.message?.split(/\r?\n/)[0] || err}`);
    }
  }

  if (file.hasWorktreeDiff) {
    try {
      const raw = file.untracked
        ? buildUntrackedDiff(file)
        : await safeGit(file.wtDir, [
          "diff",
          "--relative",
          "--find-renames",
          "--no-ext-diff",
          "--color=never",
          `--unified=${DIFF_CONTEXT_LINES}`,
          "HEAD",
          "--",
          file.path,
        ]);
      lines.push(...section(file.untracked ? "WORKTREE untracked" : "WORKTREE HEAD", raw));
    } catch (err) {
      errors.push(`worktree diff failed: ${err?.message?.split(/\r?\n/)[0] || err}`);
    }
  }

  if (errors.length > 0) {
    lines.push("# Errors", ...errors, "");
  }
  if (lines.length === 0) {
    lines.push(`No diff available for ${file.path}.`);
  }

  return {
    lines,
    hunkLineIndexes: hunkLineIndexes(lines),
    lineCount: lineCount(lines.join("\n")),
  };
}
