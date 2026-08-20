// lib/domains/git/functions/workflow-startup-guard.js
// Startup dirty-tree and target-branch guard helpers.

import fs from "fs";
import path from "path";
import {
  getJob,
  getSetting,
  listWaitingLanePreparations,
  logEvent,
  poisonWaitingLanePreparation,
  retireWaitingLanePreparation,
} from "../../queue/functions/index.js";
import { LOCK_HOLDING_JOB_STATUSES } from "../../queue/functions/common.js";
import { C } from "../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { SETTING_KEYS, STARTUP_DIRTY_TREE_POLICY_VALUES } from "../../../catalog/settings.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import {
  buildPosseRuntimeIgnoreEntries,
  isPosseRuntimeOnlyGitignoreContent,
} from "../../runtime/functions/ignore.js";
import { GIT_OPERATION_TIMEOUT_MS, isGitCommandFailure } from "./utils.js";
import { snapshotAndResetDirtyWorktree } from "./worktree.js";
import { GIT_WORKFLOW_TASK_TIMEOUT_MS } from "./workflow-context.js";
import { firstGitLine } from "./workflow-git-utils.js";
import { inspectPreparedWorktreeLockedAsync } from "./prepared-worktree-recovery.js";

const LIVE_PREPARATION_JOB_STATUS_SET = new Set(["queued", ...LOCK_HOLDING_JOB_STATUSES]);

export function waitingLaneStartupInspectionAction(preparation, value, {
  pathExists = false,
  gitJobLive = false,
} = {}) {
  const intentRecoverable = value?.ok === true
    && value.ownershipPhase === "intent"
    && ["preparing_git", "activating"].includes(preparation?.state);
  const intentBeforeAddRecoverable = value?.ok === false
    && value?.status === "inspection_mismatch"
    && value?.ownershipPhase === "intent"
    && value?.registered === false
    && pathExists === false
    && preparation?.state === "preparing_git"
    && gitJobLive === true;
  const preparedAgreement = value?.ok === true
    && value.ownershipPhase === "prepared"
    && value.detached === true
    && preparation?.state !== "active";
  const expectedAttachedOid = String((
    preparation?.state === "active"
      ? (preparation?.applied_git_oid || preparation?.desired_generation?.git_oid || preparation?.desired_git_oid)
      : (preparation?.desired_generation?.git_oid || preparation?.desired_git_oid || preparation?.applied_git_oid)
  ) || "").trim().toLowerCase();
  const attachedAgreement = value?.ok === true
    && value.ownershipPhase === "attached"
    && value.detached === false
    && String(value?.branchName || "").trim().length > 0
    && /^[0-9a-f]{40,64}$/u.test(expectedAttachedOid)
    && String(value?.headOid || "").trim().toLowerCase() === expectedAttachedOid
    && ["active", "activating"].includes(preparation?.state);
  if (intentRecoverable) return "intent_observed";
  if (intentBeforeAddRecoverable) return "intent_pre_add_observed";
  if (attachedAgreement) return "attached_observed";
  if (preparedAgreement) {
    return preparation?.state === "activating"
      ? "prepared_activation_recoverable"
      : "prepared_observed";
  }
  return null;
}

/**
 * Filesystem-first waiting-lane recovery. It records poison/retirement through
 * the queue CAS API but never schedules replacement work; the coordinator runs
 * its demand/job reconciliation only after these observations are returned.
 */
export async function reconcileWaitingLaneFilesystemAtStartupAsync(projectDir, {
  signal = null,
  onMsg = () => {},
} = {}) {
  const observations = [];
  let preparations = [];
  try {
    preparations = listWaitingLanePreparations({ limit: 1000 });
  } catch (error) {
    return [{ action: "unavailable", reason: error?.message || String(error) }];
  }
  for (const preparation of preparations) {
    throwIfAborted(signal);
    const root = preparation.worktree_root
      ? path.resolve(preparation.worktree_root)
      : null;
    const base = {
      work_item_id: preparation.work_item_id,
      state: preparation.state,
      version: preparation.version,
      worktree_root: root,
    };
    if (!root || !preparation.ownership_record_id) {
      if (root && fs.existsSync(root)) {
        const transition = poisonWaitingLanePreparation({
          workItemId: preparation.work_item_id,
          expectedVersion: preparation.version,
          reason: "startup_existing_path_without_ownership",
        });
        observations.push({ ...base, action: "poisoned_preserved", transition });
        onMsg(`startup: preserved unowned prepared path for WI#${preparation.work_item_id}`);
      } else {
        observations.push({ ...base, action: "no_asset" });
      }
      continue;
    }
    try {
      const observed = await inspectPreparedWorktreeLockedAsync({
        projectDir,
        worktreeRoot: root,
        preparationId: preparation.ownership_record_id,
        signal,
      });
      const value = observed.inspection?.result || null;
      if (observed.inspection?.available === false) {
        observations.push({ ...base, action: "native_capability_unavailable", reason: observed.inspection.reason });
        continue;
      }
      let gitJobLive = false;
      try {
        gitJobLive = LIVE_PREPARATION_JOB_STATUS_SET.has(getJob(preparation.git_job_id)?.status);
      } catch { /* unavailable queue proof is never treated as recoverable */ }
      const agreementAction = waitingLaneStartupInspectionAction(preparation, value, {
        pathExists: fs.existsSync(root),
        gitJobLive,
      });
      if (agreementAction) {
        observations.push({
          ...base,
          action: agreementAction,
          inspection: value,
        });
        continue;
      }
      if (!fs.existsSync(root) && value?.registered !== true) {
        const transition = retireWaitingLanePreparation({
          workItemId: preparation.work_item_id,
          expectedVersion: preparation.version,
          reason: "startup_prepared_asset_missing",
        });
        observations.push({ ...base, action: "retired_missing", transition, inspection: value });
        continue;
      }
      const transition = poisonWaitingLanePreparation({
        workItemId: preparation.work_item_id,
        expectedVersion: preparation.version,
        reason: `startup_inspection_mismatch:${String(value?.status || value?.reason || "unknown").slice(0, 800)}`,
      });
      observations.push({ ...base, action: "poisoned_preserved", transition, inspection: value });
      onMsg(`startup: preserved unexpected prepared worktree state for WI#${preparation.work_item_id}`);
    } catch (error) {
      observations.push({ ...base, action: "inspection_error_preserved", reason: error?.message || String(error) });
      onMsg(`startup: prepared worktree inspection failed for WI#${preparation.work_item_id}; path preserved`);
    }
  }
  return observations;
}

export function createStartupDirtyGuardHelpers(context) {
  const { projectDir, runGitWorkflowTaskOffMainThread, gitExec, gitExecAsync } = context;
  let projectGitPrefixCache;

  // "" means "git ran and reported a clean tree" (or no repo). An infra
  // failure (git gate busy, posse-git unavailable) must NOT read as clean —
  // the dirty-tree guard would skip preserving uncommitted work — so it
  // propagates and fails the startup step loudly instead.
  function gitStatusPorcelain(cwd = projectDir) {
    try {
      return gitExec(["status", "--porcelain"], cwd, { timeoutMs: 5000 }).trim();
    } catch (err) {
      if (!isGitCommandFailure(err)) throw err;
      return "";
    }
  }

  // Startup only needs to know which paths are dirty. `--untracked-files=all`
  // recursively expands every untracked directory, which can make Windows boot
  // appear frozen on repos with generated trees. `normal` still reports the
  // directory as dirty and `git add -A -- <dir>` stages it recursively.
  // core.quotePath=false keeps non-ASCII paths as raw UTF-8; the default
  // octal-escaped quoting would be mangled by porcelainPath's backslash
  // normalization and break `git add` during the startup dirty-tree commit.
  function gitStatusPorcelainStartup(cwd = projectDir) {
    try {
      return gitExec(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=normal"], cwd, { timeoutMs: 5000 }).trim();
    } catch (err) {
      if (!isGitCommandFailure(err)) throw err;
      return "";
    }
  }

  async function gitStatusPorcelainStartupAsync(cwd = projectDir, { signal = null } = {}) {
    throwIfAborted(signal);
    try {
      return String(await gitExecAsync(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=normal"], cwd, { timeoutMs: 5000, signal }) || "").trim();
    } catch (err) {
      if (isAbortError(err) || !isGitCommandFailure(err)) throw err;
      return "";
    }
  }

  function porcelainPath(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return "";
    const rawPath = trimmed.length >= 4 && trimmed[2] === " "
      ? trimmed.slice(3)
      : trimmed.replace(/^[ MADRCU?!D]{1,2}\s+/, "");
    return String(rawPath || "")
      .replace(/^"|"$/g, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .trim();
  }

  function projectGitPrefix() {
    if (projectGitPrefixCache !== undefined) return projectGitPrefixCache;
    try {
      const raw = gitExec(["rev-parse", "--show-prefix"], projectDir, { timeoutMs: 5000 }).trim();
      const normalized = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      projectGitPrefixCache = normalized ? `${normalized}/` : "";
    } catch {
      projectGitPrefixCache = "";
    }
    return projectGitPrefixCache;
  }

  function projectRelativePorcelainPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
    const prefix = projectGitPrefix();
    if (!prefix) return normalized;
    if (normalized === prefix.slice(0, -1)) return "";
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  }

  function isRuntimePorcelainLine(line, cwd = projectDir) {
    const filePath = projectRelativePorcelainPath(porcelainPath(line));
    if (filePath === ".posse" || filePath.startsWith(".posse/")) return true;
    // Admin merge may run before bootstrap writes the managed .gitignore.
    // A linked worktree under Posse's canonical root is runtime state, not a
    // user edit in the target checkout.
    if (filePath === ".posse-worktrees" || filePath.startsWith(".posse-worktrees/")) return true;
    if (filePath !== ".gitignore") return false;
    const code = String(line || "").trim();
    // Untracked .gitignore that posse just created — already handled.
    if (code.startsWith("??")) {
      try {
        const content = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
        return isPosseRuntimeOnlyGitignoreContent(cwd, content);
      } catch {
        return false;
      }
    }
    // Tracked-and-modified .gitignore: a user-controlled file, so we can
    // only safely ignore it if the diff vs HEAD is purely posse-runtime
    // additions under the "# Posse runtime (auto-added)" marker. Anything
    // outside that — a real edit, a deletion, an unrecognized addition —
    // makes us fall through and treat it as a normal uncommitted change.
    if (code.startsWith("M") || code.startsWith(" M") || code.startsWith("MM") || code.startsWith("AM")) {
      return gitignoreDiffIsRuntimeOnly(cwd);
    }
    return false;
  }

  async function isRuntimePorcelainLineAsync(line, cwd = projectDir, { signal = null } = {}) {
    throwIfAborted(signal);
    const filePath = projectRelativePorcelainPath(porcelainPath(line));
    if (filePath === ".posse" || filePath.startsWith(".posse/")) return true;
    if (filePath === ".posse-worktrees" || filePath.startsWith(".posse-worktrees/")) return true;
    if (filePath !== ".gitignore") return false;
    const code = String(line || "").trim();
    if (code.startsWith("??")) {
      try {
        const content = await fs.promises.readFile(path.join(cwd, ".gitignore"), "utf-8");
        throwIfAborted(signal);
        return isPosseRuntimeOnlyGitignoreContent(cwd, content);
      } catch (err) {
        if (isAbortError(err)) throw err;
        return false;
      }
    }
    if (code.startsWith("M") || code.startsWith(" M") || code.startsWith("MM") || code.startsWith("AM")) {
      return await gitignoreDiffIsRuntimeOnlyAsync(cwd, { signal });
    }
    return false;
  }

  function runtimeGitignorePatterns(cwd) {
    return new Set(buildPosseRuntimeIgnoreEntries(cwd, { anchorDir: cwd }));
  }

  function gitignoreDiffIsRuntimeOnly(cwd) {
    let diff;
    try {
      diff = gitExec(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ".gitignore"], cwd, { timeoutMs: 5000, trim: false });
    } catch {
      return false;
    }
    if (!diff || !diff.trim()) return false;
    // Walk hunk bodies. Lines beginning with '+' (but not '+++') are
    // additions; lines beginning with '-' (but not '---') are deletions.
    // Any deletion fails the check immediately — a real user edit might
    // remove a runtime entry, but we don't try to be clever about that.
    let sawRuntimeAddition = false;
    const allowedRuntimePatterns = runtimeGitignorePatterns(cwd);
    for (const rawLine of diff.split("\n")) {
      if (!rawLine || rawLine.startsWith("diff ") || rawLine.startsWith("index ")
        || rawLine.startsWith("@@") || rawLine.startsWith("+++") || rawLine.startsWith("---")) {
        continue;
      }
      if (rawLine.startsWith("-")) return false;
      if (!rawLine.startsWith("+")) continue;
      const addition = rawLine.slice(1).trim();
      if (!addition) continue;                                  // blank line
      if (addition.startsWith("#")) continue;                    // any comment is fine
      if (allowedRuntimePatterns.has(addition)) {
        sawRuntimeAddition = true;
        continue;
      }
      return false;                                              // unrecognized real change
    }
    return sawRuntimeAddition;
  }

  async function gitignoreDiffIsRuntimeOnlyAsync(cwd, { signal = null } = {}) {
    throwIfAborted(signal);
    let diff;
    try {
      diff = await gitExecAsync(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ".gitignore"], cwd, { timeoutMs: 5000, signal, trim: false });
    } catch (err) {
      if (isAbortError(err)) throw err;
      return false;
    }
    if (!diff || !diff.trim()) return false;
    let sawRuntimeAddition = false;
    const allowedRuntimePatterns = runtimeGitignorePatterns(cwd);
    for (const rawLine of diff.split("\n")) {
      throwIfAborted(signal);
      if (!rawLine || rawLine.startsWith("diff ") || rawLine.startsWith("index ")
        || rawLine.startsWith("@@") || rawLine.startsWith("+++") || rawLine.startsWith("---")) {
        continue;
      }
      if (rawLine.startsWith("-")) return false;
      if (!rawLine.startsWith("+")) continue;
      const addition = rawLine.slice(1).trim();
      if (!addition) continue;
      if (addition.startsWith("#")) continue;
      if (allowedRuntimePatterns.has(addition)) {
        sawRuntimeAddition = true;
        continue;
      }
      return false;
    }
    return sawRuntimeAddition;
  }

  function porcelainPathsForGitAdd(line) {
    const filePath = porcelainPath(line);
    if (!filePath) return [];
    if (!filePath.includes(" -> ")) return [projectRelativePorcelainPath(filePath)].filter(Boolean);
    return filePath
      .split(/\s+->\s+/)
      .map((part) => projectRelativePorcelainPath(part.replace(/^"|"$/g, "").replace(/\\/g, "/").trim()))
      .filter(Boolean);
  }

  function normalizeStartupDirtyTreePolicy(value) {
    const raw = String(value || "").trim().toLowerCase();
    return STARTUP_DIRTY_TREE_POLICY_VALUES.includes(raw) ? raw : "block";
  }

  function startupDirtyTreePolicy() {
    try {
      return normalizeStartupDirtyTreePolicy(getSetting(SETTING_KEYS.STARTUP_DIRTY_TREE_POLICY));
    } catch {
      return "block";
    }
  }

  function isUnmergedPorcelainLine(line) {
    const code = String(line || "").slice(0, 2);
    return code.includes("U") || code === "AA" || code === "DD";
  }

  function commitHasStagedChanges() {
    try {
      gitExec(["diff", "--cached", "--quiet", "--exit-code"], projectDir, { timeoutMs: 5000 });
      return false;
    } catch {
      return true;
    }
  }

  async function commitHasStagedChangesAsync({ signal = null } = {}) {
    throwIfAborted(signal);
    try {
      await gitExecAsync(["diff", "--cached", "--quiet", "--exit-code"], projectDir, { timeoutMs: 5000, signal });
      return false;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return true;
    }
  }

  function gitShortHead() {
    try {
      return gitExec(["rev-parse", "--short", "HEAD"], projectDir, { timeoutMs: 5000 }).trim();
    } catch {
      return "";
    }
  }

  async function gitShortHeadAsync({ signal = null } = {}) {
    throwIfAborted(signal);
    try {
      return String(await gitExecAsync(["rev-parse", "--short", "HEAD"], projectDir, { timeoutMs: 5000, signal }) || "").trim();
    } catch (err) {
      if (isAbortError(err)) throw err;
      return "";
    }
  }

  // scip-typescript's `--infer-tsconfig` writes a placeholder tsconfig.json
  // into the indexed project root to drive the index, then removes it when the
  // run finishes. A hard interruption mid-index (SIGINT/kill/crash) skips that
  // cleanup and orphans the placeholder — and because it isn't a `.posse/`
  // runtime path, the next boot's dirty-tree guard trips on the untracked
  // `{}` file. Sweep it here, but ONLY when it's both untracked AND its
  // content matches the exact generated signature, so a real (even minimal)
  // user tsconfig is never deleted. Mirrors isGeneratedInferTsconfig in
  // lib/domains/atlas/functions/v2/scip/stager.js — keep the two in sync.
  // Mirror isGeneratedInferTsconfig in atlas/v2/scip/stager.js — recognize the
  // tsconfig the SCIP stager generates (so the dirty-guard only sweeps our own,
  // never a real user config). Accepts {} (legacy), {compilerOptions:{allowJs:
  // true}} (legacy), and {compilerOptions:{allowJs:true}, exclude:[...]}.
  function isGeneratedInferTsconfigContent(raw) {
    try {
      const parsed = JSON.parse(String(raw || ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const keys = Object.keys(parsed);
      if (keys.length === 0) return true;
      if (!keys.every((k) => k === "compilerOptions" || k === "exclude")) return false;
      if ("exclude" in parsed && !Array.isArray(parsed.exclude)) return false;
      const compilerOptions = parsed?.compilerOptions;
      return !!compilerOptions
        && Object.keys(compilerOptions).length === 1
        && compilerOptions.allowJs === true;
    } catch {
      return false;
    }
  }

  function tsconfigIsTracked(cwd) {
    try {
      gitExec(["ls-files", "--error-unmatch", "--", "tsconfig.json"], cwd, { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async function tsconfigIsTrackedAsync(cwd, { signal = null } = {}) {
    throwIfAborted(signal);
    try {
      await gitExecAsync(["ls-files", "--error-unmatch", "--", "tsconfig.json"], cwd, { timeoutMs: 5000, signal });
      return true;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return false;
    }
  }

  function sweepOrphanedInferTsconfig(cwd = projectDir) {
    const target = path.join(cwd, "tsconfig.json");
    let raw;
    try {
      raw = fs.readFileSync(target, "utf-8");
    } catch {
      return false; // no file — nothing to sweep
    }
    if (!isGeneratedInferTsconfigContent(raw)) return false;
    if (tsconfigIsTracked(cwd)) return false;
    try {
      fs.rmSync(target, { force: true });
      console.log(`  ${C.dim}[scip] Removed orphaned infer-tsconfig placeholder from ${cwd}.${C.reset}`);
      return true;
    } catch {
      return false;
    }
  }

  async function sweepOrphanedInferTsconfigAsync(cwd = projectDir, { signal = null } = {}) {
    throwIfAborted(signal);
    const target = path.join(cwd, "tsconfig.json");
    let raw;
    try {
      raw = await fs.promises.readFile(target, "utf-8");
    } catch {
      return false;
    }
    if (!isGeneratedInferTsconfigContent(raw)) return false;
    if (await tsconfigIsTrackedAsync(cwd, { signal })) return false;
    try {
      await fs.promises.rm(target, { force: true });
      console.log(`  ${C.dim}[scip] Removed orphaned infer-tsconfig placeholder from ${cwd}.${C.reset}`);
      return true;
    } catch {
      return false;
    }
  }

  function startupDirtyLines() {
    const status = gitStatusPorcelainStartup(projectDir);
    return status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isRuntimePorcelainLine(line, projectDir));
  }

  async function startupDirtyLinesAsync({ signal = null } = {}) {
    throwIfAborted(signal);
    const status = await gitStatusPorcelainStartupAsync(projectDir, { signal });
    const lines = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const out = [];
    for (const line of lines) {
      throwIfAborted(signal);
      if (!(await isRuntimePorcelainLineAsync(line, projectDir, { signal }))) out.push(line);
    }
    return out;
  }

  function dirtyTreeGuardMessage({ reason, dirtyLines, policy }) {
    const preview = dirtyLines.slice(0, 12).join("\n");
    const more = dirtyLines.length > 12 ? `... and ${dirtyLines.length - 12} more` : "";
    const action = policy === "commit"
      ? "Resolve the conflicted paths, then restart Posse."
      : "Commit or stash these changes, or set startup_dirty_tree_policy=commit to let Posse commit them before boot.";
    return [
      `Startup dirty tree guard blocked ${reason}: ${dirtyLines.length} uncommitted change(s) in ${projectDir}.`,
      preview,
      more,
      action,
    ].filter(Boolean).join("\n");
  }

  function stageDirtyLines(dirtyLines) {
    const paths = [];
    const seen = new Set();
    for (const line of dirtyLines) {
      for (const filePath of porcelainPathsForGitAdd(line)) {
        if (!filePath || seen.has(filePath)) continue;
        seen.add(filePath);
        paths.push(filePath);
      }
    }
    for (let index = 0; index < paths.length; index += 100) {
      gitExec(["add", "-A", "--", ...paths.slice(index, index + 100)], projectDir, { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
    }
  }

  async function stageDirtyLinesAsync(dirtyLines, { signal = null } = {}) {
    throwIfAborted(signal);
    const paths = [];
    const seen = new Set();
    for (const line of dirtyLines) {
      throwIfAborted(signal);
      for (const filePath of porcelainPathsForGitAdd(line)) {
        if (!filePath || seen.has(filePath)) continue;
        seen.add(filePath);
        paths.push(filePath);
      }
    }
    for (let index = 0; index < paths.length; index += 100) {
      throwIfAborted(signal);
      await gitExecAsync(["add", "-A", "--", ...paths.slice(index, index + 100)], projectDir, { timeoutMs: GIT_OPERATION_TIMEOUT_MS, signal });
    }
  }

  function guardStartupDirtyTree({
    reason = "startup",
    policy = null,
    message = "chore: preserve startup work before posse boot",
    onPhase = null,
  } = {}) {
    const emitPhase = (detail) => {
      if (typeof onPhase === "function") {
        try { onPhase({ detail }); } catch { /* display callback only */ }
      }
    };
    const mode = normalizeStartupDirtyTreePolicy(policy || startupDirtyTreePolicy());
    emitPhase("checking target tree");
    // Sweep a SCIP infer-tsconfig placeholder orphaned by an interrupted index
    // before measuring dirtiness, so it can't trip the guard.
    sweepOrphanedInferTsconfig(projectDir);
    const dirtyLines = startupDirtyLines();
    if (!dirtyLines.length) {
      emitPhase("target tree clean");
      return { ok: true, dirty: false, policy: mode, action: "clean" };
    }
    if (dirtyLines.some(isUnmergedPorcelainLine) || mode !== "commit") {
      throw new Error(dirtyTreeGuardMessage({ reason, dirtyLines, policy: mode }));
    }

    try {
      emitPhase(`staging ${dirtyLines.length} startup change(s)`);
      stageDirtyLines(dirtyLines);
      emitPhase("checking staged changes");
      if (!commitHasStagedChanges()) {
        return {
          ok: true,
          dirty: true,
          policy: mode,
          action: "no_staged_changes",
          dirtyCount: dirtyLines.length,
        };
      }
      emitPhase("committing startup work");
      gitExec(["commit", "-m", String(message || "chore: preserve startup work before posse boot")], projectDir, { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
    } catch (err) {
      const detail = firstGitLine(err);
      throw new Error(`Startup dirty tree guard could not commit current work before ${reason}: ${detail}`);
    }

    emitPhase("verifying clean tree");
    const remaining = startupDirtyLines();
    if (remaining.length) {
      throw new Error(dirtyTreeGuardMessage({
        reason: `${reason} after auto-commit`,
        dirtyLines: remaining,
        policy: "block",
      }));
    }

    const commit = gitShortHead();
    console.log(`  ${C.green}[git] Committed ${dirtyLines.length} startup change(s)${commit ? ` as ${commit}` : ""} before ${reason}.${C.reset}`);
    return {
      ok: true,
      dirty: true,
      policy: mode,
      action: "committed",
      dirtyCount: dirtyLines.length,
      commit,
    };
  }

  async function guardStartupDirtyTreeAsync({
    reason = "startup",
    policy = null,
    message = "chore: preserve startup work before posse boot",
    onPhase = null,
    signal = null,
  } = {}) {
    throwIfAborted(signal);
    const emitPhase = (detail) => {
      if (typeof onPhase === "function") {
        try { onPhase({ detail }); } catch { /* display callback only */ }
      }
    };
    emitPhase("reconciling waiting-lane filesystem");
    const waitingLaneFilesystemRecovery = await reconcileWaitingLaneFilesystemAtStartupAsync(projectDir, {
      signal,
      onMsg: (detail) => emitPhase(detail),
    });
    throwIfAborted(signal);
    const mode = normalizeStartupDirtyTreePolicy(policy || startupDirtyTreePolicy());
    emitPhase("checking target tree");
    // Sweep a SCIP infer-tsconfig placeholder orphaned by an interrupted index
    // before measuring dirtiness, so it can't trip the guard.
    await sweepOrphanedInferTsconfigAsync(projectDir, { signal });
    throwIfAborted(signal);
    const dirtyLines = await startupDirtyLinesAsync({ signal });
    throwIfAborted(signal);
    if (!dirtyLines.length) {
      emitPhase("target tree clean");
      return { ok: true, dirty: false, policy: mode, action: "clean", waitingLaneFilesystemRecovery };
    }
    if (dirtyLines.some(isUnmergedPorcelainLine) || mode !== "commit") {
      throw new Error(dirtyTreeGuardMessage({ reason, dirtyLines, policy: mode }));
    }

    try {
      emitPhase(`staging ${dirtyLines.length} startup change(s)`);
      await stageDirtyLinesAsync(dirtyLines, { signal });
      throwIfAborted(signal);
      emitPhase("checking staged changes");
      if (!(await commitHasStagedChangesAsync({ signal }))) {
        return {
          ok: true,
          dirty: true,
          policy: mode,
          action: "no_staged_changes",
          dirtyCount: dirtyLines.length,
          waitingLaneFilesystemRecovery,
        };
      }
      throwIfAborted(signal);
      emitPhase("committing startup work");
      await gitExecAsync(["commit", "-m", String(message || "chore: preserve startup work before posse boot")], projectDir, { timeoutMs: GIT_OPERATION_TIMEOUT_MS, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const detail = firstGitLine(err);
      throw new Error(`Startup dirty tree guard could not commit current work before ${reason}: ${detail}`);
    }

    throwIfAborted(signal);
    emitPhase("verifying clean tree");
    const remaining = await startupDirtyLinesAsync({ signal });
    if (remaining.length) {
      throw new Error(dirtyTreeGuardMessage({
        reason: `${reason} after auto-commit`,
        dirtyLines: remaining,
        policy: "block",
      }));
    }

    throwIfAborted(signal);
    const commit = await gitShortHeadAsync({ signal });
    console.log(`  ${C.green}[git] Committed ${dirtyLines.length} startup change(s)${commit ? ` as ${commit}` : ""} before ${reason}.${C.reset}`);
    return {
      ok: true,
      dirty: true,
      policy: mode,
      action: "committed",
      dirtyCount: dirtyLines.length,
      commit,
      waitingLaneFilesystemRecovery,
    };
  }

  async function guardStartupDirtyTreeInWorker({
    reason = "startup",
    policy = null,
    message = "chore: preserve startup work before posse boot",
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    throwIfAborted(signal);
    if (typeof onPhase === "function") {
      try { onPhase({ detail: "reconciling waiting-lane filesystem" }); } catch { /* display callback only */ }
    }
    const waitingLaneFilesystemRecovery = await reconcileWaitingLaneFilesystemAtStartupAsync(projectDir, {
      signal,
      onMsg: (detail) => {
        if (typeof onPhase === "function") {
          try { onPhase({ detail }); } catch { /* display callback only */ }
        }
      },
    });
    throwIfAborted(signal);
    const result = await runGitWorkflowTaskOffMainThread("guardStartupDirtyTree", {
      reason,
      policy,
      message,
    }, {
      onPhase,
      signal,
      timeoutMs,
    });
    return { ...result, waitingLaneFilesystemRecovery };
  }

  function ensureCleanTargetBranch(reason, { fatalOnFailure = false, logWhenClean = false } = {}) {
    const status = gitStatusPorcelain(projectDir);
    const dirtyLines = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isRuntimePorcelainLine(line, projectDir));
    if (!dirtyLines.length) {
      if (logWhenClean) {
        console.log(`  ${C.green}✓${C.reset} Target worktree clean (${reason}); WI merge state is reported separately`);
      }
      return true;
    }

    try {
      const fileCount = dirtyLines.length;
      const snapshotDir = snapshotAndResetDirtyWorktree(projectDir, projectDir, {
        reason: `target-branch-${reason.replace(/\s+/g, "-")}`,
        branchName: null,
        wiId: null,
        // Keep local ignored assets in the main tree (e.g. .env, node_modules)
        // while still snapshotting/resetting tracked + untracked source edits.
        cleanIgnoredOverride: false,
      });
      if (snapshotDir) {
        console.log(`  ${C.yellow}[git] Preserved ${fileCount} target-branch change(s) to ${snapshotDir} before ${reason}${C.reset}`);
        console.log(`  ${C.dim}[git] To restore later, run 'posse cleanup' and choose snapshot restore.${C.reset}`);
        logEvent({
          event_type: EVENT_TYPES.GIT_TARGET_BRANCH_SNAPSHOTTED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Snapshotted ${fileCount} target-branch change(s) to ${snapshotDir} before ${reason}`,
          event_json: JSON.stringify({ reason, file_count: fileCount, snapshot_dir: snapshotDir }),
        });
      } else {
        console.log(`  ${C.yellow}[git] Cleared ${fileCount} target-branch change(s) before ${reason}${C.reset}`);
        logEvent({
          event_type: EVENT_TYPES.GIT_TARGET_BRANCH_CLEARED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Cleared ${fileCount} target-branch change(s) before ${reason} (snapshot skipped or empty)`,
          event_json: JSON.stringify({ reason, file_count: fileCount }),
        });
      }
      return true;
    } catch (err) {
      const msg = `Could not clean target branch before ${reason}: ${err.message.split("\n")[0]}`;
      if (fatalOnFailure) {
        throw new Error(msg);
      }
      console.log(`  ${C.red}[git] ${msg}${C.reset}`);
      return false;
    }
  }

  function ensureCleanTargetBranchAsync(reason, options = {}, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("ensureCleanTargetBranch", {
      reason,
      options,
    }, workerOptions);
  }

  /**
   * Audit all WI worktrees/branches for dirty state (uncommitted changes,
   * unmerged branches, etc). Returns an array of { wiId, title, branchName, wtDir, issues[] }.
   */

  return {
    ensureCleanTargetBranch,
    ensureCleanTargetBranchAsync,
    guardStartupDirtyTree,
    guardStartupDirtyTreeAsync,
    guardStartupDirtyTreeInWorker,
    isRuntimePorcelainLine,
    sweepOrphanedInferTsconfig,
    sweepOrphanedInferTsconfigAsync,
  };
}
