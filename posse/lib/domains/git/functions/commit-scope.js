// lib/domains/git/functions/commit-scope.js
//
// Git scope helpers for staged commit boundaries, scoped asset repair, and
// commit-time hook integration inside worker-managed worktrees.

import fs from "fs";
import path from "path";
import { Worker as NodeWorker } from "worker_threads";
import { runHook } from "./hooks.js";
import { gitExec, gitCurrentHash } from "./utils.js";
import { withWorktreeLock } from "./worktree.js";
import { withBranchLock } from "./worktree-locks.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { listActiveFileLocks } from "../../queue/functions/file-locks.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { sanitizeWorkerExecArgv } from "../../runtime/functions/worker-exec-argv.js";
import { getGitAtlasPostCommitHookTimeoutMs } from "../../settings/functions/tunables.js";
import { isUnderRoot, normalizeRoots } from "../../../shared/scope/functions/path.js";
import { findActiveSiblingLockForPath } from "../../queue/functions/sibling-locks.js";
import { MutationPolicy } from "../../../shared/scope/classes/MutationPolicy.js";
import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { UNSCOPED_GIT_ADD_TASK_MODES } from "../../../catalog/artifact.js";
import { runGitNativeMethod } from "./native/invoke.js";

const GIT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_COMMIT_CORE_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_COMMIT_HOOK_GRACE_MS = 30_000;

function gitCommitTimeoutBudget() {
  const coreTimeoutMs = DEFAULT_GIT_COMMIT_CORE_TIMEOUT_MS;
  const postCommitHookTimeoutMs = getGitAtlasPostCommitHookTimeoutMs();
  const hookGraceMs = DEFAULT_GIT_COMMIT_HOOK_GRACE_MS;
  const processTimeoutMs = coreTimeoutMs + postCommitHookTimeoutMs + hookGraceMs;
  return {
    coreTimeoutMs,
    postCommitHookTimeoutMs,
    hookGraceMs,
    processTimeoutMs,
    legacyProcessTimeoutMs: null,
  };
}

function isGitCommitProcessTimeout(err) {
  const text = `${err?.message || ""}\n${err?.code || ""}\n${err?.signal || ""}`;
  return /ETIMEDOUT|SIGTERM|timed out/i.test(text);
}

function isGitIndexLockError(err) {
  const text = [err?.message, err?.stderr, err?.stdout].filter(Boolean).join("\n");
  return /index\.lock|Another git process seems to be running|Unable to create ['"]?.*?\.git[\\/].*?index\.lock/i.test(text);
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function gitIndexLockInfo(cwd) {
  let lockPath = null;
  let lockStat = null;
  try {
    const gitDir = gitExec(["rev-parse", "--git-dir"], cwd).trim();
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    lockPath = path.join(resolvedGitDir, "index.lock");
  } catch {
    lockPath = null;
  }
  if (lockPath) {
    try {
      const stat = fs.statSync(lockPath);
      lockStat = {
        exists: true,
        mtime: stat.mtime.toISOString(),
        age_ms: Math.max(0, Date.now() - stat.mtimeMs),
        size: stat.size,
      };
    } catch {
      lockStat = { exists: false };
    }
  }
  return { lockPath, lockStat };
}

function annotateGitIndexLockError(err, cwd, operation) {
  err.gitIndexLock = true;
  err.gitIndexLockInfo = gitIndexLockInfo(cwd);
  const firstLine = String(err?.message || err || "git index lock").split(/\r?\n/).find(Boolean) || "git index lock";
  const lock = err.gitIndexLockInfo?.lockPath ? ` (${err.gitIndexLockInfo.lockPath})` : "";
  err.message = `${operation} blocked by git index.lock${lock}: ${firstLine}`;
  return err;
}

function gitExecWithIndexLockRetry(args, cwd, operation, { attempts = 3, waitMs = 1000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return gitExec(args, cwd);
    } catch (err) {
      if (!isGitIndexLockError(err)) throw err;
      lastErr = err;
      if (attempt < attempts) sleepSync(waitMs * attempt);
    }
  }
  throw annotateGitIndexLockError(lastErr, cwd, operation);
}

function execGitCommitWithIndexLockRetry(message, cwd, budget, { attempts = 3, waitMs = 1000, allowEmpty = false } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return gitExec(["commit", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message], cwd, {
        timeoutMs: budget.processTimeoutMs,
        trim: false,
      });
    } catch (err) {
      if (!isGitIndexLockError(err)) throw err;
      lastErr = err;
      if (attempt < attempts) sleepSync(waitMs * attempt);
    }
  }
  throw annotateGitIndexLockError(lastErr, cwd, "git commit");
}

function annotateGitCommitProcessError(err, budget) {
  if (!isGitCommitProcessTimeout(err)) return err;
  err.gitCommitTimedOut = true;
  err.gitCommitTimeoutBudget = budget;
  const source = budget.legacyProcessTimeoutMs
    ? `legacy process cap ${budget.legacyProcessTimeoutMs}ms`
    : `core git ${budget.coreTimeoutMs}ms + ATLAS post-commit hook ${budget.postCommitHookTimeoutMs}ms + grace ${budget.hookGraceMs}ms`;
  err.message = `git commit process timed out after ${budget.processTimeoutMs}ms (${source})`;
  return err;
}

export const __testGitCommitTimeoutBudget = gitCommitTimeoutBudget;

function assertUnscopedGitAddAllowed(opts = {}) {
  const taskMode = String(opts?.taskMode || opts?.task_mode || "").trim().toLowerCase();
  if (UNSCOPED_GIT_ADD_TASK_MODES.has(taskMode)) return;
  const allowed = [...UNSCOPED_GIT_ADD_TASK_MODES].join(", ");
  throw new Error(`Unscoped git add -A blocked: task_mode must be one of ${allowed}; got ${taskMode || "<missing>"}`);
}

function safeGitAdd(file, cwd, context, warnings = null) {
  try {
    gitExecWithIndexLockRetry(["add", "--", file], cwd, `git add ${context}`);
  } catch (err) {
    const warning = {
      file,
      context,
      error: err?.message || String(err),
    };
    const strictContext = context === "modifyFiles" || context === "createFiles" || context === "mergeResolution";
    if (strictContext) {
      const addErr = new Error(`Failed to stage ${context} path "${file}": ${warning.error}`);
      addErr.gitAddWarning = warning;
      throw addErr;
    }
    if (Array.isArray(warnings)) warnings.push(warning);
    log.warn("git-commit-scope", "Git add failed while enforcing scope", {
      file: warning.file,
      context: warning.context,
      error: warning.error,
    });
  }
}

function isGitIgnored(file, cwd) {
  try {
    gitExec(["check-ignore", "-q", "--", file], cwd, { timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    throw new Error(`Failed to check whether "${file}" is ignored by git: ${err?.message || String(err)}`);
  }
}

function resolveCaseInsensitivePath(cwd, relPath) {
  if (process.platform !== "win32") return null;
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized) return null;

  const parts = normalized.split("/").filter(Boolean);
  let currentAbs = cwd;
  const actualParts = [];
  for (const part of parts) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return null;
    }
    const match = entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    actualParts.push(match.name);
    currentAbs = path.join(currentAbs, match.name);
  }
  return actualParts.join("/");
}

function firstValueByFold(paths, foldPath) {
  const map = new Map();
  for (const file of paths) {
    const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!normalized) continue;
    const folded = foldPath(normalized);
    if (!map.has(folded)) map.set(folded, normalized);
  }
  return map;
}

export function repairWebAssetCreateScope(task = {}, nativeParity = {}) {
  const native = runGitNativeMethod(
    "git.repairWebAssetCreateScope",
    JSON.parse(JSON.stringify(task || {})),
    nativeParity,
  );
  // The Node implementation mutated the caller's task in place; mirror that so
  // callers observing `task` after the call see the repaired create scope.
  const nativeTask = native && typeof native.task === "object" && native.task ? native.task : null;
  if (nativeTask) {
    if (Array.isArray(nativeTask.files_to_create)) task.files_to_create = nativeTask.files_to_create;
    if (Array.isArray(nativeTask.create_roots)) task.create_roots = nativeTask.create_roots;
  }
  return { changed: Boolean(native?.changed), files: Array.isArray(native?.files) ? native.files : [] };
}

function currentBranchForCommitLock(cwd, opts = {}) {
  const configured = String(opts?.branchName || "").trim().replace(/^refs\/heads\//, "");
  if (configured) return configured;
  try {
    const branch = gitExec(["branch", "--show-current"], cwd).trim();
    return branch && branch !== "HEAD" ? branch : "";
  } catch {
    return "";
  }
}

function withCommitBranchLock(cwd, opts = {}, fn) {
  if (opts?.branchLock === false) return fn();
  const branchName = currentBranchForCommitLock(cwd, opts);
  if (!branchName) return fn();
  return withBranchLock(cwd, branchName, opts?.projectDir || cwd, fn, {
    waitMs: opts?.branchLockWaitMs ?? opts?.worktreeLockWaitMs,
  });
}

export function gitCommitAll(message, cwd, scope = null, opts = {}) {
  const commitWithBranchLock = () => withCommitBranchLock(cwd, opts, () =>
    gitCommitAllUnlocked(message, cwd, scope, opts)
  );
  if (opts?.worktreeLock === false) return commitWithBranchLock();
  return withWorktreeLock(cwd, opts?.projectDir || cwd, commitWithBranchLock, {
    waitMs: opts?.worktreeLockWaitMs,
  });
}

export function gitCommitAllAsync(message, cwd, scope = null, opts = {}) {
  if (typeof opts?.beforeCommitHook === "function") {
    return Promise.reject(new Error("gitCommitAllAsync cannot serialize beforeCommitHook; wrap the whole caller off the main thread instead"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new NodeWorker(new URL("./commit-worker.js", import.meta.url), {
      execArgv: sanitizeWorkerExecArgv(),
      workerData: { message, cwd, scope, opts, nativeAuth: heartbeatAuthManager.getCapability() },
    });
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.on("message", (message = {}) => {
      if (message.ok) {
        settle(resolve, message.result);
        return;
      }
      const err = new Error(message.error || "git commit worker failed");
      if (message.stack) err.stack = message.stack;
      for (const key of ["code", "errno", "syscall", "path", "spawnargs", "status", "signal", "killed"]) {
        if (message[key] != null) err[key] = message[key];
      }
      if (message.stderr) err.stderr = message.stderr;
      if (message.stdout) err.stdout = message.stdout;
      if (message.hookOutput) err.hookOutput = message.hookOutput;
      if (message.gitCommitTimedOut) err.gitCommitTimedOut = true;
      if (message.gitCommitTimeoutBudget) err.gitCommitTimeoutBudget = message.gitCommitTimeoutBudget;
      if (Array.isArray(message.createdOutOfScope)) err.createdOutOfScope = message.createdOutOfScope;
      if (Array.isArray(message.gitAddWarnings)) err.gitAddWarnings = message.gitAddWarnings;
      settle(reject, err);
    });
    worker.on("error", (err) => settle(reject, err));
    worker.on("exit", (code) => {
      if (code !== 0) settle(reject, new Error(`git commit worker exited with code ${code}`));
    });
  });
}

function activeFileLocksForCommit(opts = {}) {
  if (opts?.activeFileLocks) return opts.activeFileLocks;
  try {
    return listActiveFileLocks();
  } catch {
    return { work_items: [], jobs: [] };
  }
}

function gitCommitAllUnlocked(message, cwd, scope = null, opts = {}) {
  const reverted = [];
  const createdViaModifyScope = [];
  const createdOutOfScope = [];
  const skippedIgnoredCreateFiles = [];
  const skippedIgnoredModifyFiles = [];
  const skippedStaleModifyFiles = [];
  const discardedGeneratedFiles = [];
  const outOfScopeDirtySkipped = [];
  const outOfScopeStagingSkipped = [];
  const siblingDirtySkipped = [];
  const siblingUntrackedSkipped = [];
  const siblingStagingSkipped = [];
  const gitAddWarnings = [];
  // On Windows, git preserves the case stored in the index while the FS is
  // case-insensitive. Lowercasing keeps scope comparisons robust against
  // case drift between files_to_modify (user-authored) and git diff output
  // (index-authored). Matches the normalization in lib/scheduler.js.
  const caseFold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const normRaw = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const norm = (p) => caseFold(normRaw(p));
  const nestedRepoPrefix = (() => {
    try {
      const repoRoot = path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd));
      const rel = path.relative(repoRoot, path.resolve(cwd)).replace(/\\/g, "/").replace(/\/+$/, "");
      if (rel && rel !== "." && isInsideRoot(path.resolve(cwd), repoRoot, { allowEqual: false, followSymlinks: false })) return rel;
    } catch {
      // Best effort only. Non-nested or detached environments simply skip this normalization.
    }
    return null;
  })();
  const scopeCompatiblePath = (input) => {
    const normalized = normRaw(input);
    if (!normalized || normalized === "*" || !nestedRepoPrefix) return normalized;
    const prefix = `${nestedRepoPrefix}/`;
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  };
  const wiId = opts?.wiId || null;
  const jobId = opts?.jobId || null;
  const activeFileLocks = activeFileLocksForCommit(opts);
  let headAtScopeStart = null;
  try { headAtScopeStart = gitCurrentHash(cwd); } catch { headAtScopeStart = null; }
  let snapshotRestoreFailed = false;
  let snapshotRestoreError = null;
  let snapshotRestoreRef = null;

  const modifyFilesRaw = (scope?.modifyFiles || []).map(scopeCompatiblePath).filter(Boolean);
  const createFilesRaw = (scope?.createFiles || []).map(scopeCompatiblePath).filter(Boolean);
  const deleteFilesRaw = (scope?.deleteFiles || []).map(scopeCompatiblePath).filter(Boolean);
  const modifyFiles = modifyFilesRaw.map(caseFold);
  const createFiles = createFilesRaw.map(caseFold);
  const deleteFiles = deleteFilesRaw.map(caseFold);
  // Fold createRoots to the same case as norm() so isUnderRoot prefix matches
  // line up on Windows where git output and user-authored paths may diverge.
  const createRoots = normalizeRoots(scope?.createRoots || [], cwd).map(scopeCompatiblePath).filter(Boolean).map(caseFold);
  const hasScope = modifyFiles.length > 0 || createFiles.length > 0 || deleteFiles.length > 0 || createRoots.length > 0;
  if (createRoots.includes("*")) {
    const taskMode = String(opts?.taskMode || opts?.task_mode || "").trim().toLowerCase();
    if (!UNSCOPED_GIT_ADD_TASK_MODES.has(taskMode)) {
      throw new Error(`Unsafe create_roots scope blocked: root-wide create scope is not allowed for task_mode ${taskMode || "<missing>"}`);
    }
  }

  // If a merge is in progress (rebase-on-lease left it for the dev), normal
  // cleanup would revert files brought in by the merge. Scoped merge commits
  // instead stage merge-brought-in paths plus declared scope and quarantine
  // unrelated dirty paths so they cannot ride along in the merge commit.
  let mergeInProgress = false;
  try {
    gitExec(["rev-parse", "--verify", "MERGE_HEAD"], cwd, { timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    mergeInProgress = true;
  } catch { /* not in a merge — normal path */ }

  const modifySet = new Set(modifyFiles);
  const createSet = new Set(createFiles);
  const deleteSet = new Set(deleteFiles);
  const policy = MutationPolicy.fromScopeSpec({
    modifyFiles,
    createFiles,
    createRoots,
    deleteFiles,
  }, { cwd });
  const isSnapshotPath = () => false;
  const siblingLockFor = (nf) => findActiveSiblingLockForPath(nf, {
    id: jobId,
    work_item_id: wiId,
  }, { locks: activeFileLocks });
  const rememberSiblingSkipped = (target, file, lock) => {
    target.push({
      file,
      job_id: lock?.job_id ?? null,
      path: lock?.path || null,
      lock_kind: lock?.lock_kind || null,
    });
  };
  const rememberUnique = (target, file) => {
    if (!target.includes(file)) target.push(file);
  };
  const canEdit = (nf) => policy.canEdit(nf);
  const canCreate = (nf) => {
    if (createSet.has(nf) || policy.isWithinScopeRoot(nf)) return true;
    if (modifySet.has(nf)) {
      createdViaModifyScope.push(nf);
      return true;
    }
    return false;
  };
  const canCreateWithoutTrackingCompat = (nf) =>
    createSet.has(nf) || policy.isWithinScopeRoot(nf) || modifySet.has(nf);
  const canDelete = (nf) => policy.canDelete(nf);
  const isExplicitCurrentScope = (nf) => modifySet.has(nf) || createSet.has(nf) || deleteSet.has(nf);
  // Rename detection collapses a staged rename into its destination, hiding
  // the out-of-scope source from enforcement (status R, not D). Force
  // --no-renames so every scope decision sees both sides of a rename.
  const gitNameList = (...args) => gitExec(
    ["-c", "core.quotePath=false", ...(args[0] === "diff" ? ["diff", "--no-renames", ...args.slice(1)] : args)],
    cwd
  );
  const collectDeletedTracked = () => new Set([
    ...gitNameList("diff", "--name-only", "--diff-filter=D")
      .split("\n")
      .filter(Boolean)
      .map(scopeCompatiblePath)
      .filter(Boolean)
      .map(norm),
    ...gitNameList("diff", "--cached", "--name-only", "--diff-filter=D")
      .split("\n")
      .filter(Boolean)
      .map(scopeCompatiblePath)
      .filter(Boolean)
      .map(norm),
  ]);
  const collectMergeBroughtInPaths = (leftRev = "HEAD", rightRev = "MERGE_HEAD") => {
    const raw = gitExec(["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", `${leftRev}...${rightRev}`], cwd);
    const rawPaths = raw.split("\n").map(scopeCompatiblePath).filter(Boolean);
    return {
      rawPaths,
      normalized: new Set(rawPaths.map(norm)),
    };
  };
  const mergePathAllowed = (nf, mergeBroughtIn) =>
    canEdit(nf)
    || canCreateWithoutTrackingCompat(nf)
    || canDelete(nf)
    || mergeBroughtIn.has(nf);

  let outOfScopeMergeFiles = [];
  let quarantinedOutOfScopeMergeFiles = [];
  let mergeAuditFailed = false;
  let mergeAuditError = null;

  const stageScopedMergeResolution = () => {
    const { rawPaths: mergeRawPaths, normalized: mergeBroughtIn } = collectMergeBroughtInPaths();
    const deletedTracked = collectDeletedTracked();
    const quarantined = new Set();
    const stageCandidates = new Set();
    const rememberQuarantined = (file) => {
      const normalized = norm(file);
      if (!normalized || isSnapshotPath(normalized) || mergePathAllowed(normalized, mergeBroughtIn)) return;
      quarantined.add(file);
    };

    for (const f of gitNameList("diff", "--cached", "--name-only").split("\n").map(scopeCompatiblePath).filter(Boolean)) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized) || mergePathAllowed(normalized, mergeBroughtIn)) continue;
      try {
        gitExec(["reset", "HEAD", "--", f], cwd);
        rememberQuarantined(f);
      } catch {
        const err = new Error(`Failed to unstage out-of-scope merge path "${f}" before scoped merge commit`);
        err.outOfScopeMergeFiles = [f];
        err.gitAddWarnings = gitAddWarnings;
        throw err;
      }
    }

    const dirtyFiles = [
      ...new Set(
        `${gitNameList("diff", "--name-only")}\n${gitNameList("diff", "--name-only", "--cached")}`
          .split("\n")
          .map(scopeCompatiblePath)
          .filter(Boolean)
      ),
    ];
    const untrackedFiles = gitNameList("ls-files", "--others", "--exclude-standard")
      .split("\n")
      .map(scopeCompatiblePath)
      .filter(Boolean);
    const unmergedPaths = gitNameList("ls-files", "-u")
      .split("\n")
      .filter(Boolean)
      .map((line) => scopeCompatiblePath(line.split("\t").pop()))
      .filter(Boolean);

    for (const f of dirtyFiles) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized)) continue;
      if (mergePathAllowed(normalized, mergeBroughtIn) || (deletedTracked.has(normalized) && canDelete(normalized))) {
        stageCandidates.add(f);
      } else {
        rememberQuarantined(f);
      }
    }
    for (const u of untrackedFiles) {
      const normalized = norm(u);
      if (isSnapshotPath(normalized)) continue;
      if (mergePathAllowed(normalized, mergeBroughtIn)) {
        stageCandidates.add(u);
      } else {
        createdOutOfScope.push(u);
        rememberQuarantined(u);
      }
    }
    for (const f of [...mergeRawPaths, ...unmergedPaths, ...modifyFilesRaw, ...createFilesRaw, ...deleteFilesRaw]) {
      if (f) stageCandidates.add(f);
    }
    if (createRoots.length > 0) {
      for (const f of [...dirtyFiles, ...untrackedFiles]) {
        const normalized = norm(f);
        if (isUnderRoot(normalized, createRoots)) stageCandidates.add(f);
      }
    }

    for (const f of stageCandidates) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized)) continue;
      if (!mergePathAllowed(normalized, mergeBroughtIn) && !(deletedTracked.has(normalized) && canDelete(normalized))) {
        rememberQuarantined(f);
        continue;
      }
      safeGitAdd(f, cwd, "mergeResolution", gitAddWarnings);
    }

    const stillStagedOutOfScope = gitNameList("diff", "--cached", "--name-only")
      .split("\n")
      .map(scopeCompatiblePath)
      .filter(Boolean)
      .filter((f) => {
        const normalized = norm(f);
        return !isSnapshotPath(normalized) && !mergePathAllowed(normalized, mergeBroughtIn);
      });
    for (const f of stillStagedOutOfScope) {
      try {
        gitExec(["reset", "HEAD", "--", f], cwd);
        rememberQuarantined(f);
      } catch {
        const err = new Error(`Out-of-scope merge path(s) remained staged after quarantine: ${stillStagedOutOfScope.join(", ")}`);
        err.outOfScopeMergeFiles = stillStagedOutOfScope;
        err.gitAddWarnings = gitAddWarnings;
        throw err;
      }
    }

    const blocked = gitNameList("diff", "--cached", "--name-only")
      .split("\n")
      .map(scopeCompatiblePath)
      .filter(Boolean)
      .filter((f) => {
        const normalized = norm(f);
        return !isSnapshotPath(normalized) && !mergePathAllowed(normalized, mergeBroughtIn);
      });
    if (blocked.length > 0) {
      const err = new Error(`Out-of-scope merge path(s) blocked from scoped merge commit: ${blocked.join(", ")}`);
      err.outOfScopeMergeFiles = blocked;
      err.gitAddWarnings = gitAddWarnings;
      throw err;
    }
    return [...new Set([...quarantined].map(scopeCompatiblePath).filter(Boolean))];
  };

  if (hasScope && !mergeInProgress) {
    const deletedTracked = collectDeletedTracked();
    const allDirty = `${gitNameList("diff", "--name-only")}\n${gitNameList("diff", "--name-only", "--cached")}`;
    const dirtyFiles = [
      ...new Set(
        allDirty
          .split("\n")
          .map(scopeCompatiblePath)
          .filter(Boolean)
      ),
    ];
    const untrackedFiles = gitNameList("ls-files", "--others", "--exclude-standard")
      .split("\n")
      .map(scopeCompatiblePath)
      .filter(Boolean);
    const actualDirtyByFold = firstValueByFold([...dirtyFiles, ...untrackedFiles], norm);
    const trackedByFold = firstValueByFold(
      gitNameList("ls-files")
        .split("\n")
        .map(scopeCompatiblePath)
        .filter(Boolean),
      norm
    );
    const resolveScopedPath = (file) =>
      actualDirtyByFold.get(norm(file))
      || trackedByFold.get(norm(file))
      || resolveCaseInsensitivePath(cwd, file)
      || file;
    const isInertStaleModifyPath = (file) => {
      const normalized = norm(file);
      if (!normalized || actualDirtyByFold.has(normalized) || trackedByFold.has(normalized) || deletedTracked.has(normalized)) {
        return false;
      }
      const caseResolved = resolveCaseInsensitivePath(cwd, file);
      if (caseResolved) return false;
      return !fs.existsSync(path.resolve(cwd, file));
    };

    for (const f of dirtyFiles) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized)) continue;
      const allowedDeletion = deletedTracked.has(normalized) && canDelete(normalized);
      if (!canEdit(normalized) && !allowedDeletion) {
        const siblingLock = siblingLockFor(normalized);
        if (siblingLock) {
          rememberSiblingSkipped(siblingDirtySkipped, f, siblingLock);
        } else {
          rememberUnique(outOfScopeDirtySkipped, f);
        }
        continue;
      }
    }

    if (untrackedFiles.length > 0) {
      for (const u of untrackedFiles) {
        const normalized = norm(u);
        if (isSnapshotPath(normalized)) continue;
        if (!canCreate(normalized)) {
          const siblingLock = siblingLockFor(normalized);
          if (siblingLock) {
            rememberSiblingSkipped(siblingUntrackedSkipped, u, siblingLock);
            continue;
          }
          createdOutOfScope.push(u);
        }
      }
    }
    for (const f of modifyFilesRaw) {
      if (isInertStaleModifyPath(f)) {
        skippedStaleModifyFiles.push(f);
        log.warn("git-commit-scope", "Skipped stale modifyFiles path during staging", {
          file: f,
          context: "modifyFiles",
        });
        continue;
      }
      const resolved = resolveScopedPath(f);
      // git add refuses ignored untracked paths; a declared modify path the
      // job never touched (not tracked, not dirty) can only be staged with
      // --force, so skip it like ignored createFiles paths instead of letting
      // the strict-context throw dead-letter a clean job.
      if (!trackedByFold.has(norm(f)) && !actualDirtyByFold.has(norm(f)) && isGitIgnored(resolved, cwd)) {
        skippedIgnoredModifyFiles.push(resolved);
        log.warn("git-commit-scope", "Skipped ignored modifyFiles path during staging", {
          file: resolved,
          context: "modifyFiles",
        });
        continue;
      }
      safeGitAdd(resolved, cwd, "modifyFiles", gitAddWarnings);
    }
    for (const f of createFilesRaw) {
      const resolved = resolveScopedPath(f);
      if (isGitIgnored(resolved, cwd)) {
        skippedIgnoredCreateFiles.push(resolved);
        log.warn("git-commit-scope", "Skipped ignored createFiles path during staging", {
          file: resolved,
          context: "createFiles",
        });
        continue;
      }
      safeGitAdd(resolved, cwd, "createFiles", gitAddWarnings);
    }
    for (const f of deleteFilesRaw) {
      if (canDelete(norm(f))) {
        safeGitAdd(resolveScopedPath(f), cwd, "deleteFiles", gitAddWarnings);
      }
    }
    if (createRoots.length > 0) {
      const postUntracked = gitNameList("ls-files", "--others", "--exclude-standard");
      if (postUntracked) {
        for (const u of postUntracked.split("\n").filter(Boolean)) {
          const siblingLock = siblingLockFor(norm(u));
          if (siblingLock) {
            rememberSiblingSkipped(siblingStagingSkipped, u, siblingLock);
            continue;
          }
          if (isUnderRoot(norm(u), createRoots)) {
            safeGitAdd(u, cwd, "createRoots/untracked", gitAddWarnings);
          }
        }
      }
      for (const f of dirtyFiles) {
        if (isUnderRoot(norm(f), createRoots) && !modifySet.has(norm(f))) {
          const siblingLock = siblingLockFor(norm(f));
          if (siblingLock) {
            rememberSiblingSkipped(siblingStagingSkipped, f, siblingLock);
            continue;
          }
          safeGitAdd(f, cwd, "createRoots/dirty", gitAddWarnings);
        }
      }
    }

    const stagedBeforeCommit = gitNameList("diff", "--cached", "--name-only")
      .split("\n")
      .map(scopeCompatiblePath)
      .filter(Boolean);
    for (const f of stagedBeforeCommit) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized)) continue;
      const siblingLock = isExplicitCurrentScope(normalized) ? null : siblingLockFor(normalized);
      if (siblingLock) {
        try {
          gitExec(["reset", "HEAD", "--", f], cwd);
          rememberSiblingSkipped(siblingStagingSkipped, f, siblingLock);
        } catch {
          const err = new Error(`Failed to unstage sibling-owned path "${f}" before scoped commit`);
          err.gitAddWarnings = gitAddWarnings;
          throw err;
        }
        continue;
      }
      const allowedStaged = canEdit(normalized)
        || canCreateWithoutTrackingCompat(normalized)
        || (deletedTracked.has(normalized) && canDelete(normalized));
      if (!allowedStaged) {
        try {
          gitExec(["reset", "HEAD", "--", f], cwd);
          rememberUnique(outOfScopeStagingSkipped, f);
        } catch {
          const err = new Error(`Failed to unstage out-of-scope path "${f}" before scoped commit`);
          err.gitAddWarnings = gitAddWarnings;
          throw err;
        }
      }
    }

    const expectedStaged = new Set();
    for (const f of dirtyFiles) {
      const normalized = norm(f);
      if (isSnapshotPath(normalized)) continue;
      if (siblingLockFor(normalized)) continue;
      if (canEdit(normalized) || (deletedTracked.has(normalized) && canDelete(normalized))) {
        expectedStaged.add(normalized);
      }
    }
    for (const u of untrackedFiles) {
      const normalized = norm(u);
      if (isSnapshotPath(normalized)) continue;
      if (siblingLockFor(normalized)) continue;
      if (canCreate(normalized)) expectedStaged.add(normalized);
    }
    if (expectedStaged.size > 0) {
      const stagedNow = new Set(
        gitNameList("diff", "--cached", "--name-only")
          .split("\n")
          .map(scopeCompatiblePath)
          .filter(Boolean)
          .map(norm)
      );
      const unstagedAfterAdd = new Set(
        gitNameList("diff", "--name-only")
          .split("\n")
          .map(scopeCompatiblePath)
          .filter(Boolean)
          .map(norm)
      );
      const untrackedAfterAdd = new Set(
        gitNameList("ls-files", "--others", "--exclude-standard")
          .split("\n")
          .map(scopeCompatiblePath)
          .filter(Boolean)
          .map(norm)
      );
      const missing = [...expectedStaged].filter((file) =>
        !stagedNow.has(file) && (unstagedAfterAdd.has(file) || untrackedAfterAdd.has(file))
      );
      if (missing.length > 0) {
        const err = new Error(`Scoped path(s) remained unstaged after case-resolved git add: ${missing.join(", ")}`);
        if (gitAddWarnings.length > 0) err.gitAddWarnings = gitAddWarnings;
        throw err;
      }
    }
  } else if (mergeInProgress && hasScope) {
    quarantinedOutOfScopeMergeFiles = stageScopedMergeResolution();
    outOfScopeMergeFiles = quarantinedOutOfScopeMergeFiles.slice();
  } else {
    // Jobs with no scope are reserved for modes that intentionally commit the
    // whole worktree (artifacts/reports). Merge-resolution commits can also
    // stage broadly, but only when a caller supplied a scope and a merge is live.
    if (!hasScope) assertUnscopedGitAddAllowed(opts);
    gitExecWithIndexLockRetry(["add", "-A"], cwd, "git add -A");
  }

  const staged = gitExec(["-c", "core.quotePath=false", "diff", "--no-renames", "--cached", "--name-only"], cwd);
  // An empty staged diff normally means nothing to commit — except mid-merge,
  // where a resolution that took "ours" everywhere still must commit so
  // MERGE_HEAD is cleared and the merge is recorded instead of dangling into
  // the next job's commit.
  if (!staged && !mergeInProgress) {
    const scopeCleanedNoOp = hasScope && reverted.length > 0;
    return { hash: gitCurrentHash(cwd), reverted, createdViaModifyScope, createdOutOfScope, skippedIgnoredCreateFiles, skippedIgnoredModifyFiles, skippedStaleModifyFiles, discardedGeneratedFiles, outOfScopeDirtySkipped, outOfScopeStagingSkipped, siblingDirtySkipped, siblingUntrackedSkipped, siblingStagingSkipped, gitAddWarnings, scopeCleanedNoOp, snapshotRestoreFailed, snapshotRestoreError, snapshotRestoreRef };
  }

  // When completing a merge, verify the dev actually resolved the conflicts
  // rather than committing files that still contain `<<<<<<<` / `>>>>>>>`
  // markers. `git add -A` marks conflicts resolved even with markers present,
  // so we have to inspect staged content directly. We deliberately do NOT run
  // `git reset HEAD` on failure: that can clear MERGE_HEAD and strand the dev
  // without a way to retry the resolution — the retry loop re-stages from the
  // working tree and needs the merge state intact.
  if (mergeInProgress) {
    let unmergedRaw = "";
    try { unmergedRaw = gitExec(["-c", "core.quotePath=false", "ls-files", "-u"], cwd); } catch { /* empty */ }
    if (unmergedRaw && unmergedRaw.trim()) {
      const unmergedPaths = [...new Set(
        unmergedRaw.split("\n").filter(Boolean).map((line) => {
          const parts = line.split("\t");
          return parts[parts.length - 1];
        })
      )];
      throw new Error(`Merge conflict unresolved: ${unmergedPaths.slice(0, 10).join(", ")}`);
    }
    try {
      gitExec(["diff", "--cached", "--check"], cwd, { timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    } catch (err) {
      const out = String(err.stdout || err.stderr || err.message || "").trim();
      const firstLines = out.split("\n").slice(0, 10).join(" | ");
      throw new Error(`Conflict markers remain in staged files: ${firstLines}`);
    }
  }

  const secretsResult = runHook("secrets_scan", { cwd });
  if (!secretsResult.ok) {
    if (!mergeInProgress) {
      try { gitExec(["reset", "HEAD"], cwd); } catch {}
    }
    const err = new Error("Secrets detected in staged files — commit blocked by hook");
    err.hookOutput = secretsResult.output;
    throw err;
  }

  if (typeof opts?.beforeCommitHook === "function") {
    const hookResult = opts.beforeCommitHook({
      cwd,
      stagedFiles: staged.split("\n").filter(Boolean),
      mergeInProgress,
    });
    if (!hookResult?.ok) {
      if (!mergeInProgress) {
        try { gitExec(["reset", "HEAD"], cwd); } catch {}
      }
      const err = new Error("Pre-commit verification failed — commit blocked by hook");
      err.hookOutput = hookResult?.output || "verification hook failed";
      throw err;
    }
  }

  const commitTimeoutBudget = gitCommitTimeoutBudget();
  if (headAtScopeStart) {
    let headBeforeCommit = null;
    try { headBeforeCommit = gitCurrentHash(cwd); } catch { headBeforeCommit = null; }
    if (headBeforeCommit && headBeforeCommit !== headAtScopeStart) {
      const err = new Error(`Branch HEAD moved during scoped commit (${headAtScopeStart.slice(0, 12)} -> ${headBeforeCommit.slice(0, 12)}); refusing to commit on a stale scope check`);
      err.code = "BRANCH_HEAD_MOVED";
      throw err;
    }
  }
  try {
    execGitCommitWithIndexLockRetry(message, cwd, commitTimeoutBudget, {
      allowEmpty: mergeInProgress && !staged,
    });
  } catch (err) {
    if (err?.gitIndexLock) throw err;
    throw annotateGitCommitProcessError(err, commitTimeoutBudget);
  }

  // Post-merge audit: scoped merge commits stage only declared scope and
  // merge-brought-in files. Recompute the committed diff so the caller can
  // surface any unexpected residuals to the assessor.
  if (mergeInProgress && hasScope) {
    try {
      const mergeParents = gitExec(["rev-parse", "HEAD^1", "HEAD^2"], cwd)
        .split("\n").map((s) => s.trim()).filter(Boolean);
      if (mergeParents.length !== 2) {
        throw new Error(`expected merge commit with 2 parents, got ${mergeParents.length}`);
      }
      if (mergeParents.length === 2) {
        const [p1, p2] = mergeParents;
        const mergeBroughtIn = new Set(
          gitExec(["diff", "--no-renames", "--name-only", `${p1}...${p2}`], cwd)
            .split("\n").map((s) => norm(s)).filter(Boolean)
        );
        const commitChanged = gitExec(["diff", "--no-renames", "--name-only", "HEAD^1", "HEAD"], cwd)
          .split("\n").map((s) => norm(s)).filter(Boolean);
        const committedOutOfScopeMergeFiles = commitChanged.filter((f) =>
          !policy.canEdit(f)
          && !policy.canCreate(f)
          && !policy.canDelete(f)
          && !mergeBroughtIn.has(f)
        );
        outOfScopeMergeFiles = [...new Set([
          ...outOfScopeMergeFiles,
          ...committedOutOfScopeMergeFiles,
        ])];
      }
    } catch (auditErr) {
      mergeAuditFailed = true;
      mergeAuditError = auditErr?.message || String(auditErr);
      log.warn("git-commit-scope", "Post-merge scope audit failed", { error: mergeAuditError });
    }
  }

  return {
    hash: gitCurrentHash(cwd),
    reverted,
    createdViaModifyScope,
    createdOutOfScope,
    skippedIgnoredCreateFiles,
    skippedIgnoredModifyFiles,
    skippedStaleModifyFiles,
    discardedGeneratedFiles,
    outOfScopeDirtySkipped,
    outOfScopeStagingSkipped,
    siblingDirtySkipped,
    siblingUntrackedSkipped,
    siblingStagingSkipped,
    gitAddWarnings,
    scopeCleanedNoOp: false,
    snapshotRestoreFailed,
    snapshotRestoreError,
    snapshotRestoreRef,
    mergeCompleted: mergeInProgress,
    outOfScopeMergeFiles,
    quarantinedOutOfScopeMergeFiles,
    mergeAuditFailed,
    mergeAuditError,
  };
}
