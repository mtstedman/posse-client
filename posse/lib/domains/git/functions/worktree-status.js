// Worktree status surfaced inside the review/approval flow.
//
// Computes per-WI worktree dirt (in-scope vs out-of-scope vs untracked) plus
// target-branch dirt, and offers mutating helpers (commit-in-scope, discard,
// stash-target) so reviewers can resolve blockers in place instead of finding
// out at merge time.

import fs from "fs";
import { Worker as NodeWorker } from "worker_threads";

import { gitCommitAll } from "./commit-scope.js";
import { gitExec } from "./utils.js";
import { acquireWorktreeLock, gitStashLockPath } from "./worktree-locks.js";
import { worktreePath as canonicalWorktreePath, findLegacyWorktreeForWi } from "./worktree.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { runHook } from "./hooks.js";
import { sanitizeWorkerExecArgv } from "../../runtime/functions/worker-exec-argv.js";
import { errorFromThreadPayload } from "../../../shared/concurrency/classes/ThreadManager.js";

const PORCELAIN_TIMEOUT_MS = 5000;
const MUTATING_TIMEOUT_MS = 15000;
const STASH_PUSH_TIMEOUT_MS = 120000;

function runWorktreeStatusTaskOffMainThread(task, args = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new NodeWorker(new URL("./git-workflow-worker.js", import.meta.url), {
      execArgv: sanitizeWorkerExecArgv(),
      workerData: {
        task,
        args,
        projectDir: args.projectDir || args.wtDir || process.cwd(),
        targetBranch: args.targetBranch || "main",
      },
    });
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    // git-workflow-worker.js posts ThreadManager-style { type, result|error|event }
    // messages; "progress" frames are observational and must not settle the task.
    worker.on("message", (message = {}) => {
      if (message.type === "progress") return;
      if (message.type === "result") settle(resolve, message.result);
      else settle(reject, errorFromThreadPayload(message.error || {}, "worktree status task failed"));
    });
    worker.on("error", (err) => settle(reject, err));
    worker.on("exit", (code) => {
      if (code !== 0) settle(reject, new Error(`worktree status worker exited with code ${code}`));
    });
  });
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function parsePorcelainLine(rawLine) {
  if (typeof rawLine !== "string" || rawLine.length < 3) return null;
  const code = rawLine.slice(0, 2);
  let rest = rawLine.slice(3);
  // Renames/copies show as "R  old -> new"; report the new path.
  if (rest.includes(" -> ")) {
    rest = rest.split(" -> ").pop();
  }
  const cleaned = rest.replace(/^"|"$/g, "");
  const path = normalizePath(cleaned);
  if (!path) return null;
  return {
    status: code,
    path,
    untracked: code.startsWith("?"),
    deleted: code.includes("D"),
    modified: /[M ]/.test(code) && !code.startsWith("?") && !code.includes("D"),
  };
}

function gitFile(args, cwd, timeoutMs = PORCELAIN_TIMEOUT_MS) {
  try {
    return gitExec(["-c", "core.quotePath=false", ...args], cwd, { timeoutMs, trim: false });
  } catch {
    return "";
  }
}

function porcelainLines(cwd) {
  const out = gitFile(["status", "--porcelain", "--untracked-files=all"], cwd);
  return String(out || "")
    .split("\n")
    .map(parsePorcelainLine)
    .filter(Boolean);
}

function parseNumstatLine(rawLine) {
  const parts = String(rawLine || "").split("\t");
  if (parts.length < 3) return null;
  const rawPath = parts.slice(2).join("\t").replace(/^"|"$/g, "");
  const filePath = normalizePath(rawPath);
  if (!filePath) return null;
  const additions = Number(parts[0]);
  const deletions = Number(parts[1]);
  const binary = parts[0] === "-" || parts[1] === "-"
    || !Number.isFinite(additions)
    || !Number.isFinite(deletions);
  return {
    path: filePath,
    additions: binary ? null : additions,
    deletions: binary ? null : deletions,
    binary,
    summary: binary ? "binary" : `+${additions}/-${deletions}`,
  };
}

function diffStatByPath(cwd) {
  const out = gitFile(["diff", "--numstat", "HEAD", "--"], cwd);
  const byPath = new Map();
  for (const line of String(out || "").split("\n")) {
    const stat = parseNumstatLine(line);
    if (stat) byPath.set(stat.path, stat);
  }
  return byPath;
}

function stashCount(cwd) {
  const out = gitFile(["stash", "list"], cwd);
  return String(out || "").trim().split("\n").filter(Boolean).length;
}

function isRuntimePath(p) {
  return p === ".posse"
    || p.startsWith(".posse/")
    || p === ".posse-worktrees"
    || p.startsWith(".posse-worktrees/")
    || p === ".posse-test-suites"
    || p.startsWith(".posse-test-suites/");
}

function resolveWorktreeDir(projectDir, wiId) {
  if (wiId == null) return null;
  const canonical = canonicalWorktreePath(projectDir, wiId);
  if (fs.existsSync(canonical)) return canonical;
  return findLegacyWorktreeForWi(projectDir, wiId);
}

export function collectScopePaths(jobs = []) {
  const files = new Set();
  const modifyFiles = new Set();
  const createFiles = new Set();
  const deleteFiles = new Set();
  const roots = new Set();
  for (const job of jobs) {
    const payload = parseJobPayload(job);
    for (const p of payload.files_to_modify || []) {
      const norm = normalizePath(p);
      if (!norm) continue;
      files.add(norm);
      modifyFiles.add(norm);
    }
    for (const p of payload.files_to_create || []) {
      const norm = normalizePath(p);
      if (!norm) continue;
      files.add(norm);
      createFiles.add(norm);
    }
    for (const p of payload.files_to_delete || []) {
      const norm = normalizePath(p);
      if (!norm) continue;
      files.add(norm);
      deleteFiles.add(norm);
    }
    for (const r of payload.create_roots || []) {
      const norm = normalizePath(r);
      if (norm) roots.add(norm);
    }
  }
  return {
    files: [...files],
    roots: [...roots],
    modifyFiles: [...modifyFiles],
    createFiles: [...createFiles],
    deleteFiles: [...deleteFiles],
  };
}

export function pathInScope(filePath, scope) {
  const fp = normalizePath(filePath);
  if (!fp) return false;
  if (scope.files.includes(fp)) return true;
  for (const root of scope.roots) {
    if (fp === root) return true;
    if (fp.startsWith(root + "/")) return true;
  }
  return false;
}

export function computeWorktreeStatus({ wi, jobs = [], projectDir, targetBranch }) {
  if (!wi || !projectDir) {
    return {
      wtDir: null, wtExists: false, wtFiles: [], wtStashes: 0,
      sourceBranch: wi?.branch_name || null,
      sourceDir: null,
      workItemId: wi?.id ?? null,
      targetDir: projectDir || null,
      targetBranch: targetBranch || null, targetDirty: false, targetFiles: [],
      scope: { files: [], roots: [] },
    };
  }

  const expectedWtDir = wi.branch_name ? canonicalWorktreePath(projectDir, wi.id) : null;
  const wtDir = wi.branch_name ? (resolveWorktreeDir(projectDir, wi.id) || expectedWtDir) : null;
  const wtExists = !!wtDir && fs.existsSync(wtDir);
  const scope = collectScopePaths(jobs);

  let wtFiles = [];
  let wtStashes = 0;
  if (wtExists) {
    const wtDiffStats = diffStatByPath(wtDir);
    wtFiles = porcelainLines(wtDir)
      .filter((entry) => !isRuntimePath(entry.path))
      .map((entry) => ({
        ...entry,
        inScope: pathInScope(entry.path, scope),
        diff: wtDiffStats.get(entry.path) || null,
      }));
    wtStashes = stashCount(wtDir);
  }

  const targetDiffStats = diffStatByPath(projectDir);
  const targetFiles = porcelainLines(projectDir)
    .filter((entry) => !isRuntimePath(entry.path))
    .map((entry) => ({ ...entry, diff: targetDiffStats.get(entry.path) || null }));

  return {
    wtDir,
    wtExists,
    wtFiles,
    wtStashes,
    sourceBranch: wi.branch_name || null,
    sourceDir: wtDir,
    workItemId: wi.id ?? null,
    targetDir: projectDir,
    targetBranch: targetBranch || null,
    targetDirty: targetFiles.length > 0,
    targetFiles,
    scope,
  };
}

export function computeWorktreeStatusAsync(args = {}) {
  return runWorktreeStatusTaskOffMainThread("computeWorktreeStatus", args);
}

function runGitMutating(args, cwd) {
  gitExec(["-c", "core.quotePath=false", ...args], cwd, { timeoutMs: MUTATING_TIMEOUT_MS });
}

function commitScopeFromReviewScope(scope = {}) {
  const files = (scope.files || []).map(normalizePath).filter(Boolean);
  const roots = [...new Set([...(scope.roots || []), ...(scope.createRoots || [])])]
    .map(normalizePath)
    .filter(Boolean);
  return {
    modifyFiles: (scope.modifyFiles || files).map(normalizePath).filter(Boolean),
    createFiles: (scope.createFiles || []).map(normalizePath).filter(Boolean),
    deleteFiles: (scope.deleteFiles || []).map(normalizePath).filter(Boolean),
    createRoots: roots,
  };
}

export function commitInScopeChanges({ wtDir, scope, message = "review: include in-scope dirty changes" }) {
  if (!wtDir || !fs.existsSync(wtDir)) {
    return { ok: false, message: "Worktree directory missing" };
  }
  const dirty = porcelainLines(wtDir).filter((entry) => !isRuntimePath(entry.path));
  const inScope = dirty.filter((entry) => pathInScope(entry.path, scope));
  if (inScope.length === 0) {
    return { ok: false, message: "No in-scope dirty files to commit" };
  }
  const visiblePaths = [...new Set(inScope.map((entry) => entry.path))];
  try {
    // Review actions are scoped to the paths shown in the UI. Clear any
    // pre-staged entries first so the shared scoped commit path evaluates the
    // actual worktree dirt and can revert out-of-scope tracked edits cleanly.
    try { runGitMutating(["reset", "-q", "HEAD", "--", "."], wtDir); } catch { /* best effort */ }
    const headBefore = gitFile(["rev-parse", "HEAD"], wtDir).trim() || null;
    const result = gitCommitAll(message, wtDir, commitScopeFromReviewScope(scope), {
      worktreeLock: false,
      taskMode: "code",
      snapshotReason: "review-scope-enforcement",
      beforeCommitHook: () => runHook("post_dev_verify", { cwd: wtDir }),
    });
    const hash = result.hash || gitFile(["rev-parse", "HEAD"], wtDir).trim() || null;
    let paths = visiblePaths;
    if (headBefore && hash && headBefore !== hash) {
      paths = gitFile(["diff", "--name-only", headBefore, hash], wtDir)
        .split("\n")
        .map(normalizePath)
        .filter(Boolean);
    }
    if (!hash || hash === headBefore) {
      return { ok: false, message: "No in-scope changes remained after scope enforcement", paths: [] };
    }
    const reverted = result.reverted || [];
    const suffix = reverted.length > 0 ? `; reverted ${reverted.length} out-of-scope file(s)` : "";
    return { ok: true, message: `Committed ${paths.length} in-scope file(s) to WI branch${suffix}`, paths, hash, reverted };
  } catch (err) {
    const detail = String(err?.hookOutput || err?.stderr || err?.message || err).split("\n")[0];
    return { ok: false, message: `git commit failed: ${detail}` };
  }
}

export function commitInScopeChangesAsync(args = {}) {
  return runWorktreeStatusTaskOffMainThread("commitInScopeChanges", args);
}

// :(literal) throughout: these paths come from UI selections, and git pathspecs
// glob after `--` — an untracked `app/[id]/x` otherwise matches (and lets the
// checkout/clean legs revert or delete) a sibling like `app/i/x`. Verified live.
function literalPathspec(p) {
  return `:(literal)${p}`;
}

function isTracked(wtDir, p) {
  try {
    gitExec(["ls-files", "--error-unmatch", "--", literalPathspec(p)], wtDir, { timeoutMs: PORCELAIN_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export function discardWorktreeFiles({ wtDir, paths }) {
  if (!wtDir || !fs.existsSync(wtDir)) {
    return { ok: false, message: "Worktree directory missing" };
  }
  const cleaned = [...new Set((paths || []).map(normalizePath).filter(Boolean))];
  if (cleaned.length === 0) {
    return { ok: false, message: "No paths selected" };
  }

  // Partition: `git checkout HEAD --` fails atomically on unknown paths, so we
  // need to checkout only tracked files and clean only untracked ones.
  const tracked = [];
  const untracked = [];
  for (const p of cleaned) {
    if (isTracked(wtDir, p)) tracked.push(p);
    else untracked.push(p);
  }

  let didClean = false;
  let didCheckout = false;
  if (untracked.length > 0) {
    try {
      runGitMutating(["clean", "-fd", "--", ...untracked.map(literalPathspec)], wtDir);
      didClean = true;
    } catch {
      // Paths may already be absent.
    }
  }
  if (tracked.length > 0) {
    try {
      runGitMutating(["checkout", "HEAD", "--", ...tracked.map(literalPathspec)], wtDir);
      didCheckout = true;
    } catch {
      // Tracked path with conflicting state — leave it alone rather than failing the whole batch.
    }
  }
  if (!didClean && !didCheckout) {
    return { ok: false, message: "Discard had no effect (paths already clean?)" };
  }
  return { ok: true, message: `Discarded ${cleaned.length} path(s)`, paths: cleaned };
}

export function discardWorktreeFilesAsync(args = {}) {
  return runWorktreeStatusTaskOffMainThread("discardWorktreeFiles", args);
}

export function stashTargetBranchChanges({ projectDir, message = "posse-review: pre-merge stash" }) {
  if (!projectDir) return { ok: false, message: "projectDir is required" };
  // refs/stash is shared by every worktree in the repo; an unlocked push here
  // can shift indices under a snapshot lane's list→drop and get the wrong
  // entry dropped. Same lock discipline as the snapshot machinery.
  const stashLock = acquireWorktreeLock(gitStashLockPath(projectDir, projectDir, { disabled: true }));
  if (!stashLock.acquired) {
    return { ok: false, message: "git stash skipped: another snapshot operation holds the stash lock; retry shortly" };
  }
  try {
    // Big repos overrun the default mutating timeout mid-push; a kill then
    // strands the content in a stash the UI never reports (verified: git
    // writes the stash ref before resetting the tree) and leaves a stale
    // index.lock. Give the push the same budget as a git operation, not a UI
    // action.
    gitExec(["-c", "core.quotePath=false", "stash", "push", "-u", "-m", message], projectDir, { timeoutMs: STASH_PUSH_TIMEOUT_MS });
    return { ok: true, message: "Target branch stashed (recover with `git stash pop`)" };
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).split("\n")[0];
    return { ok: false, message: `git stash failed: ${detail}` };
  } finally {
    stashLock.release();
  }
}

export function stashTargetBranchChangesAsync(args = {}) {
  return runWorktreeStatusTaskOffMainThread("stashTargetBranchChanges", args);
}
