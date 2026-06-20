// lib/domains/cli/functions/git-workflows.js
//
// Git/worktree workflow helpers used by the orchestration command surface.

import fs from "fs";
import path from "path";
import { execFile, execFileSync, execSync } from "child_process";
import { promisify } from "util";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { getSetting, listCrossWiMergeBlockers, listWorkItems, logEvent, refreshWorkItemStatuses, setMergeState } from "../../queue/functions/index.js";
import { markOpenPushOfferGatePushed, upsertPushOfferGate } from "../../queue/functions/push-offer.js";
import { C } from "../../providers/functions/claude.js";
import { runHook } from "../../worker/functions/helpers/hooks.js";
import { disposeWorkItemAtlasGraph, warmAtlasMergedToMainNow } from "../../integrations/functions/atlas.js";
import {
  emitMainAdvanced as emitAtlasV2MainAdvanced,
  emitMergedToMain as emitAtlasV2MergedToMain,
  emitWiCleanup as emitAtlasV2WiCleanup,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import { GIT_OPERATION_TIMEOUT_MS, resolvePushBranch } from "../../git/functions/utils.js";
import { FORCE_REMOVE_OPTIONS } from "../../git/functions/worktree-remove-options.js";
import {
  worktreePath as canonicalWorktreePath,
  findLegacyWorktreeForWi,
  worktreeRoot,
  preserveDirtyWorktreeSnapshot,
  snapshotAndResetDirtyWorktree,
  deleteBranchPreservingTip,
  gcWorktreesAsync,
  withWorktreeLock,
} from "../../git/functions/worktree.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { SETTING_KEYS, STARTUP_DIRTY_TREE_POLICY_VALUES } from "../../../catalog/settings.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";

const execFileAsync = promisify(execFile);
const GIT_WORKFLOW_WORKER_URL = new URL("./git-workflow-worker.js", import.meta.url);
const GIT_WORKFLOW_THREAD_MANAGER = new ThreadManager();
const GIT_WORKFLOW_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_MERGE_STATUS_RECONCILE_STATUSES = [
  "queued",
  "planning",
  "planned",
  "running",
  "blocked",
  "waiting_on_human",
  "waiting_on_review",
];

export async function askSingleKeyYesNo(prompt, {
  stdin = process.stdin,
  stdout = process.stdout,
  fallbackAsk = null,
} = {}) {
  if (!stdin?.isTTY) {
    if (typeof fallbackAsk === "function") return fallbackAsk(prompt);
    stdout.write(prompt);
    return "";
  }

  return new Promise((resolve) => {
    let settled = false;
    const wasRaw = Boolean(stdin.isRaw);
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = () => {
      try { stdin.off("data", onData); } catch { /* best effort */ }
      try { stdin.setRawMode(wasRaw); } catch { /* best effort */ }
      if (wasPaused) {
        try { stdin.pause(); } catch { /* best effort */ }
      }
    };

    const settle = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write(`${answer || ""}\n`);
      resolve(answer);
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!text) return;
      const key = text[0].toLowerCase();
      if (key === "y") return settle("y");
      if (key === "n" || key === "\r" || key === "\n" || key === "\u001b" || key === "\u0003") return settle("");
    };

    stdout.write(prompt);
    try { stdin.setRawMode(true); } catch { /* best effort */ }
    stdin.on("data", onData);
    try { stdin.resume(); } catch { /* best effort */ }
  });
}

export function createGitWorkflowHelpers({
  projectDir,
  targetBranch,
  getTargetBranch = null,
  autoMerge = false,
  nonInteractive = false,
  askFn = async () => "",
  isIterativeWorkItemActive = () => false,
  shouldAutoApproveIterativeWorkItem = () => false,
} = {}) {
  if (!projectDir) throw new Error("createGitWorkflowHelpers requires projectDir");
  if (!targetBranch && typeof getTargetBranch !== "function") {
    throw new Error("createGitWorkflowHelpers requires targetBranch");
  }

  function currentTargetBranch() {
    const resolved = typeof getTargetBranch === "function" ? getTargetBranch() : targetBranch;
    if (resolved && typeof resolved.then === "function") {
      throw new Error("createGitWorkflowHelpers getTargetBranch must be synchronous");
    }
    const branch = String(resolved || "").trim();
    if (!branch) throw new Error("Target branch could not be resolved");
    return branch;
  }

  function runGitWorkflowTaskOffMainThread(task, args = {}, {
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    const parsedTimeoutMs = Number(timeoutMs);
    const effectiveTimeoutMs = timeoutMs == null
      ? GIT_WORKFLOW_TASK_TIMEOUT_MS
      : Number.isFinite(parsedTimeoutMs)
        ? parsedTimeoutMs
        : GIT_WORKFLOW_TASK_TIMEOUT_MS;
    return GIT_WORKFLOW_THREAD_MANAGER.run(GIT_WORKFLOW_WORKER_URL, {
      label: `git workflow ${task}`,
      timeoutMs: effectiveTimeoutMs,
      signal,
      workerData: {
        task,
        args,
        projectDir,
        targetBranch: currentTargetBranch(),
        autoMerge,
        nonInteractive,
        nativeAuth: heartbeatAuthManager.getCapability(),
      },
      onProgress: (event = {}) => {
        if (typeof onPhase === "function") {
          try { onPhase(event || {}); } catch { /* display callback only */ }
        }
      },
    });
  }

  function gitStatusPorcelain(cwd = projectDir) {
    try {
      return execSync("git status --porcelain", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    } catch {
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
      return execFileSync("git", ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=normal"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    } catch {
      return "";
    }
  }

  async function gitStatusPorcelainStartupAsync(cwd = projectDir, { signal = null } = {}) {
    throwIfAborted(signal);
    try {
      const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=normal"], {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        signal,
        windowsHide: true,
      });
      return String(stdout || "").trim();
    } catch (err) {
      if (isAbortError(err)) throw err;
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

  function isRuntimePorcelainLine(line, cwd = projectDir) {
    const filePath = porcelainPath(line);
    if (filePath === ".posse" || filePath.startsWith(".posse/")) return true;
    if (filePath !== ".gitignore") return false;
    const code = String(line || "").trim();
    // Untracked .gitignore that posse just created — already handled.
    if (code.startsWith("??")) {
      try {
        const content = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
        return content.includes("# Posse runtime (auto-added)") && content.includes(".posse/");
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
    const filePath = porcelainPath(line);
    if (filePath === ".posse" || filePath.startsWith(".posse/")) return true;
    if (filePath !== ".gitignore") return false;
    const code = String(line || "").trim();
    if (code.startsWith("??")) {
      try {
        const content = await fs.promises.readFile(path.join(cwd, ".gitignore"), "utf-8");
        throwIfAborted(signal);
        return content.includes("# Posse runtime (auto-added)") && content.includes(".posse/");
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

  // Patterns the posse runtime adds to .gitignore. The set must stay in
  // lockstep with whatever writes "# Posse runtime (auto-added)" entries
  // — add new patterns here when they're added there. Conservative by
  // design: an unrecognized addition causes the diff check to fail and
  // the merge to surface the dirty .gitignore as expected.
  const RUNTIME_GITIGNORE_PATTERNS = new Set([
    ".posse/",
    ".posse-worktrees/",
    ".posse-test-suites/",
    "logs/",
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "*.db-journal",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal",
    "*.sqlite-journal",
  ]);

  function gitignoreDiffIsRuntimeOnly(cwd) {
    let diff;
    try {
      diff = execFileSync(
        "git",
        ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ".gitignore"],
        { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      );
    } catch {
      return false;
    }
    if (!diff || !diff.trim()) return false;
    // Walk hunk bodies. Lines beginning with '+' (but not '+++') are
    // additions; lines beginning with '-' (but not '---') are deletions.
    // Any deletion fails the check immediately — a real user edit might
    // remove a runtime entry, but we don't try to be clever about that.
    let sawRuntimeAddition = false;
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
      if (RUNTIME_GITIGNORE_PATTERNS.has(addition)) {
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
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ".gitignore"],
        { cwd, encoding: "utf-8", timeout: 5000, signal, windowsHide: true },
      );
      diff = stdout;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return false;
    }
    if (!diff || !diff.trim()) return false;
    let sawRuntimeAddition = false;
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
      if (RUNTIME_GITIGNORE_PATTERNS.has(addition)) {
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
    if (!filePath.includes(" -> ")) return [filePath];
    return filePath
      .split(/\s+->\s+/)
      .map((part) => part.replace(/^"|"$/g, "").replace(/\\/g, "/").trim())
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
      execFileSync("git", ["diff", "--cached", "--quiet", "--exit-code"], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
      return false;
    } catch {
      return true;
    }
  }

  async function commitHasStagedChangesAsync({ signal = null } = {}) {
    throwIfAborted(signal);
    try {
      await execFileAsync("git", ["diff", "--cached", "--quiet", "--exit-code"], {
        cwd: projectDir,
        timeout: 5000,
        signal,
        windowsHide: true,
      });
      return false;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return true;
    }
  }

  function gitShortHead() {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    } catch {
      return "";
    }
  }

  async function gitShortHeadAsync({ signal = null } = {}) {
    throwIfAborted(signal);
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: 5000,
        signal,
        windowsHide: true,
      });
      return String(stdout || "").trim();
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
      execFileSync("git", ["ls-files", "--error-unmatch", "--", "tsconfig.json"], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function tsconfigIsTrackedAsync(cwd, { signal = null } = {}) {
    throwIfAborted(signal);
    try {
      await execFileAsync("git", ["ls-files", "--error-unmatch", "--", "tsconfig.json"], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
        signal,
        windowsHide: true,
      });
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
      execFileSync("git", ["add", "-A", "--", ...paths.slice(index, index + 100)], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: GIT_OPERATION_TIMEOUT_MS,
      });
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
      await execFileAsync("git", ["add", "-A", "--", ...paths.slice(index, index + 100)], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: GIT_OPERATION_TIMEOUT_MS,
        signal,
        windowsHide: true,
      });
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
      execFileSync("git", ["commit", "-m", String(message || "chore: preserve startup work before posse boot")], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: GIT_OPERATION_TIMEOUT_MS,
      });
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
      return { ok: true, dirty: false, policy: mode, action: "clean" };
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
        };
      }
      throwIfAborted(signal);
      emitPhase("committing startup work");
      await execFileAsync("git", ["commit", "-m", String(message || "chore: preserve startup work before posse boot")], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: GIT_OPERATION_TIMEOUT_MS,
        signal,
        windowsHide: true,
      });
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
    };
  }

  function guardStartupDirtyTreeInWorker({
    reason = "startup",
    policy = null,
    message = "chore: preserve startup work before posse boot",
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    return runGitWorkflowTaskOffMainThread("guardStartupDirtyTree", {
      reason,
      policy,
      message,
    }, {
      onPhase,
      signal,
      timeoutMs,
    });
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
        console.log(`  ${C.green}✓${C.reset} Target branch clean (${reason})`);
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
        console.log(`  ${C.dim}[git] To restore later, run 'node orchestrator.js cleanup' and choose snapshot restore.${C.reset}`);
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
  function auditWorktreeState() {
    const targetBranch = currentTargetBranch();
    const results = [];
    const allWIs = listWorkItems();

    for (const wi of allWIs) {
      if (!wi.branch_name) continue;

      const issues = [];
      const canonical = canonicalWorktreePath(projectDir, wi.id);
      const legacy = fs.existsSync(canonical) ? null : findLegacyWorktreeForWi(projectDir, wi.id);
      const wtDir = legacy || canonical;

      // Check if worktree directory exists
      const wtExists = fs.existsSync(wtDir);

      // Check for dirty worktree (uncommitted changes)
      if (wtExists) {
        try {
          const status = execSync("git status --porcelain", { cwd: wtDir, encoding: "utf-8", timeout: 5000 }).trim();
          if (status) {
            const fileCount = status.split("\n").length;
            issues.push({ type: "dirty", message: `${fileCount} uncommitted change(s) in worktree`, files: status });
          }
        } catch { /* worktree may be broken */ }

        // Check for stashes
        try {
          const stashList = execSync("git stash list", { cwd: wtDir, encoding: "utf-8", timeout: 5000 }).trim();
          if (stashList) {
            const stashCount = stashList.split("\n").length;
            issues.push({ type: "stash", message: `${stashCount} stash(es) with uncommitted work` });
          }
        } catch { /* ignore */ }
      }

      // Check if branch has commits not yet merged into target
      if (wi.merge_state !== "merged") {
        try {
          const ahead = execFileSync("git", ["rev-list", `${targetBranch}..${wi.branch_name}`, "--count"], {
            cwd: projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
          }).trim();
          if (parseInt(ahead) > 0) {
            issues.push({ type: "unmerged", message: `${ahead} commit(s) not merged into ${targetBranch}` });
          }
        } catch {
          // Branch referenced in DB but doesn't exist in git — orphaned record
          try {
            execFileSync("git", ["rev-parse", "--verify", wi.branch_name], { cwd: projectDir, encoding: "utf-8", stdio: "pipe", timeout: 3000 });
          } catch {
            issues.push({ type: "orphan_ref", message: `Branch ${wi.branch_name} no longer exists in git (DB record is stale)` });
          }
        }
      }

      // Worktree dir exists but WI is terminal (should have been cleaned up)
      if (wtExists && TERMINAL_WORK_ITEM_STATUSES.includes(wi.status)) {
        issues.push({ type: "orphan", message: `Worktree still exists but WI is ${wi.status}` });
      }

      if (issues.length > 0) {
        results.push({ wiId: wi.id, title: wi.title, branchName: wi.branch_name, wtDir, wtExists, issues });
      }
    }

    return results;
  }

  function collectDirtyState() {
    const targetBranch = currentTargetBranch();
    const dirtyItems = auditWorktreeState();
    let targetStatus = "";
    try {
      targetStatus = execSync("git status --porcelain", { cwd: projectDir, encoding: "utf-8", timeout: 5000 }).trim();
    } catch {
      targetStatus = "";
    }
    return {
      targetBranch,
      dirtyItems,
      targetStatus,
      targetDirty: !!targetStatus,
    };
  }

  function collectDirtyStateAsync(workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("collectDirtyState", {}, workerOptions);
  }

  function sourceWorktreeDirtyState(wiId) {
    if (wiId == null) return null;
    const canonical = canonicalWorktreePath(projectDir, wiId);
    const legacy = fs.existsSync(canonical) ? null : findLegacyWorktreeForWi(projectDir, wiId);
    const wtDir = legacy || canonical;
    if (!fs.existsSync(wtDir)) return null;
    let status = "";
    try {
      status = execSync("git status --porcelain --untracked-files=all", {
        cwd: wtDir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
    const dirtyFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isRuntimePorcelainLine(line, wtDir));
    if (dirtyFiles.length === 0) return null;
    // Tracked changes are potential lost work and block the merge; untracked
    // leftovers are agent scaffolding that never entered a commit and can be
    // snapshotted away.
    const trackedFiles = dirtyFiles.filter((line) => !line.startsWith("??"));
    const untrackedFiles = dirtyFiles.filter((line) => line.startsWith("??"));
    return { wtDir, dirtyFiles, trackedFiles, untrackedFiles };
  }


  /**
   * Display dirty worktree warnings and offer a walkthrough to clean them up.
   * Returns true if there are blocking issues (dirty target branch).
   */
  async function notifyDirtyState() {
    const state = await collectDirtyStateAsync().catch(() => collectDirtyState());
    const targetBranch = state.targetBranch || currentTargetBranch();
    const dirtyItems = Array.isArray(state.dirtyItems) ? state.dirtyItems : [];
    const targetStatus = String(state.targetStatus || "").trim();
    const targetDirty = !!targetStatus;

    if (targetDirty) {
      console.log(`\n  ${C.red}${C.bold}\u26a0 Target branch (${targetBranch}) has uncommitted changes:${C.reset}`);
      const lines = targetStatus.split("\n").slice(0, 10);
      for (const line of lines) {
        console.log(`    ${C.dim}${line}${C.reset}`);
      }
      if (targetStatus.split("\n").length > 10) {
        console.log(`    ${C.dim}... and ${targetStatus.split("\n").length - 10} more${C.reset}`);
      }
    }

    if (dirtyItems.length === 0 && !targetDirty) return false;

    // Show WI branch issues
    const unmerged = dirtyItems.filter(d => d.issues.some(i => i.type === "unmerged"));
    const dirty = dirtyItems.filter(d => d.issues.some(i => i.type === "dirty"));
    const orphans = dirtyItems.filter(d => d.issues.some(i => i.type === "orphan"));

    if (unmerged.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${unmerged.length} work item branch(es) with unmerged commits:${C.reset}`);
      for (const item of unmerged) {
        const issue = item.issues.find(i => i.type === "unmerged");
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.branchName})${C.reset}`);
        console.log(`      ${issue.message}`);
      }
    }

    if (dirty.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${dirty.length} worktree(s) with uncommitted changes:${C.reset}`);
      for (const item of dirty) {
        const issue = item.issues.find(i => i.type === "dirty");
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
        console.log(`      ${issue.message}`);
      }
    }

    if (orphans.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${orphans.length} orphaned worktree(s) (WI is terminal):${C.reset}`);
      for (const item of orphans) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${item.title.slice(0, 50)} ${C.dim}(${item.wtDir})${C.reset}`);
      }
    }

    // Offer cleanup walkthrough if there are actionable issues
    if (dirty.length > 0 || orphans.length > 0 || unmerged.length > 0 || targetDirty) {
      console.log(`\n  ${C.bold}Cleanup walkthrough:${C.reset}`);

      if (unmerged.length > 0) {
        console.log(`\n  ${C.cyan}Unmerged branches${C.reset} \u2014 these have commits that didn't make it into ${targetBranch}:`);
        console.log(`    To review and merge:  ${C.bold}node orchestrator.js merge <WI-ID>${C.reset}`);
        console.log(`    To inspect the diff:  ${C.bold}git diff ${targetBranch}...<branch-name>${C.reset}`);
        console.log(`    To discard:           ${C.bold}node orchestrator.js purge${C.reset} (interactive, asks per branch)`);
      }

      if (dirty.length > 0) {
        console.log(`\n  ${C.cyan}Dirty worktrees${C.reset} \u2014 uncommitted changes in work branches:`);
        console.log(`    To inspect:  ${C.bold}cd <worktree-path> && git status && git diff${C.reset}`);
        console.log(`    To commit:   ${C.bold}cd <worktree-path> && git add -A && git commit -m "WIP"${C.reset}`);
        console.log(`    To discard:  ${C.bold}cd <worktree-path> && git checkout -- . && git clean -fd${C.reset}`);
      }

      if (orphans.length > 0) {
        console.log(`\n  ${C.cyan}Orphaned worktrees${C.reset} \u2014 WI is done but worktree/branch wasn't cleaned up:`);
        console.log(`    To clean all: ${C.bold}node orchestrator.js purge${C.reset}`);
      }

      if (targetDirty) {
        console.log(`\n  ${C.cyan}Dirty target branch${C.reset} \u2014 uncommitted changes on ${targetBranch}:`);
        console.log(`    To stash:    ${C.bold}git stash push -u -m "pre-push stash"${C.reset}`);
        console.log(`    To commit:   ${C.bold}git add -A && git commit -m "WIP"${C.reset}`);
        console.log(`    To discard:  ${C.bold}git checkout -- . && git clean -fd${C.reset}`);
      }

      console.log("");
    }

    return targetDirty;
  }

  /**
   * Offer to push the target branch to remote if there are unpushed commits.
   * Used after both manual approval and auto-approval merges.
   */
  function collectPushOfferState(mergedCount) {
    const targetBranch = currentTargetBranch();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectDir, encoding: "utf-8" }).trim();
    const remotes = (() => {
      try {
        return execSync("git remote", { cwd: projectDir, encoding: "utf-8" })
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    })();
    const branchRemote = (() => {
      try {
        return execFileSync("git", ["config", "--get", `branch.${branch}.remote`], {
          cwd: projectDir,
          encoding: "utf-8",
        }).trim();
      } catch {
        return "";
      }
    })();
    const pushRemote = remotes.includes(branchRemote)
      ? branchRemote
      : (remotes[0] || "");
    const hasRemote = pushRemote.length > 0;
    if (!hasRemote) return { hasRemote: false, branch, remotes, targetBranch, mergedCount };

    const pushBranchInfo = resolvePushBranch(projectDir, targetBranch, { currentBranch: branch, remote: pushRemote });
    if (!pushBranchInfo.branch) {
      return { hasRemote: true, branch, remotes, targetBranch, mergedCount, pushBranchInfo };
    }

    const pushBranch = pushBranchInfo.branch;
    const pushBranchRemote = (() => {
      try {
        return execFileSync("git", ["config", "--get", `branch.${pushBranch}.remote`], {
          cwd: projectDir,
          encoding: "utf-8",
        }).trim();
      } catch {
        return "";
      }
    })();
    const effectiveRemote = remotes.includes(pushBranchRemote) ? pushBranchRemote : pushRemote;

    let workingTreeStatus = "";
    try {
      workingTreeStatus = execSync("git status --porcelain", { cwd: projectDir, encoding: "utf-8", timeout: 5000 }).trim();
    } catch {
      workingTreeStatus = "";
    }

    // Commits on the push branch that the remote tracking ref doesn't have.
    // This — not "did this wrap-up pass merge anything" — is what warrants a
    // push offer: mid-run auto-merges land before the wrap-up counts them, so
    // gating on the pass-local merge count strands merged work unpushed.
    // null = no upstream ref yet (never pushed) or git error; callers fall
    // back to the merge-count gate in that case.
    let aheadCount = null;
    try {
      const upstreamRef = `${effectiveRemote}/${pushBranch}`;
      execFileSync("git", ["rev-parse", "--verify", "--quiet", upstreamRef], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const counted = execFileSync("git", ["rev-list", "--count", `${upstreamRef}..${pushBranch}`], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const parsed = Number.parseInt(counted, 10);
      aheadCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      aheadCount = null;
    }

    const dirtyItems = auditWorktreeState();
    const unmergedWIs = dirtyItems
      .filter(d => d.issues.some(i => i.type === "unmerged"))
      .map((item) => ({
        wiId: item.wiId,
        title: item.title,
        branchName: item.branchName,
        message: item.issues.find(i => i.type === "unmerged")?.message || "",
      }));
    return {
      hasRemote: true,
      branch,
      remotes,
      targetBranch,
      mergedCount,
      pushBranchInfo,
      pushBranch,
      effectiveRemote,
      workingTreeStatus,
      unmergedWIs,
      aheadCount,
    };
  }

  function collectPushOfferStateAsync(mergedCount, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("collectPushOfferState", { mergedCount }, workerOptions);
  }

  function executePush({ effectiveRemote, pushBranch, mergedCount = 0 }) {
    try {
      const markerCheck = execSync(
        'git grep -l -e "^<<<<<<<" -e "^=======$" -e "^>>>>>>>" HEAD -- . ":(exclude).posse/**"',
        { cwd: projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      ).trim();
      if (markerCheck) {
        return {
          ok: false,
          reason: "conflict_markers",
          files: markerCheck.split("\n").filter(Boolean).map((file) => file.replace(/^HEAD:/, "")),
        };
      }
    } catch {
      // git grep exits non-zero when no matches are found.
    }

    const gate = runHook("pre_push_gate", { cwd: projectDir, targetBranch: pushBranch });
    if (!gate.ok) {
      return { ok: false, reason: "gate_failed", output: gate.output || "" };
    }

    try {
      execFileSync("git", ["push", effectiveRemote, pushBranch], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: GIT_MERGE_TIMEOUT_MS,
      });
      logEvent({
        event_type: EVENT_TYPES.GIT_PUSHED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Pushed ${pushBranch} to ${effectiveRemote} after merging ${mergedCount} WI(s)`,
      });
      return { ok: true, effectiveRemote, pushBranch };
    } catch (pushErr) {
      const stderr = pushErr.stderr ? pushErr.stderr.toString().trim() : pushErr.message;
      return { ok: false, reason: "push_failed", output: stderr || String(pushErr?.message || pushErr) };
    }
  }

  function executePushAsync(args = {}, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("executePush", args, workerOptions);
  }

  async function offerPush(mergedCount) {
    let state;
    try {
      state = await collectPushOfferStateAsync(mergedCount);
    } catch (err) {
      console.log(`  ${C.yellow}Push check skipped: ${err?.message || String(err)}${C.reset}`);
      console.log("");
      return;
    }

    if (!state?.hasRemote) {
      console.log("");
      return;
    }

    const targetBranch = state.targetBranch || currentTargetBranch();
    const pushBranchInfo = state.pushBranchInfo || {};
    if (!pushBranchInfo.branch) {
      if (mergedCount > 0) {
        console.log(`\n  ${C.bold}${mergedCount} work item(s) merged, but no local branch is available to push.${C.reset}`);
        console.log(`  ${C.yellow}Configured target branch ${C.cyan}${targetBranch}${C.yellow} is not a local branch.${C.reset}`);
        console.log(`  ${C.dim}Create/check out the target branch or update Posse admin setting target_branch before pushing.${C.reset}`);
      }
      console.log("");
      return;
    }

    // The offer is warranted by unpushed commits on the push branch, not just
    // by merges performed in this wrap-up pass: WIs auto-merged mid-run land
    // before the wrap-up counts them and would otherwise strand unpushed.
    const aheadCount = Number.isFinite(state.aheadCount) ? state.aheadCount : 0;
    if (mergedCount <= 0 && aheadCount <= 0) {
      console.log("");
      return;
    }

    const pushBranch = state.pushBranch;
    const effectiveRemote = state.effectiveRemote;
    if (mergedCount > 0) {
      console.log(`\n  ${C.bold}${mergedCount} work item(s) merged into ${C.cyan}${pushBranch}${C.reset}`);
    } else {
      console.log(`\n  ${C.bold}${aheadCount} unpushed commit(s) on ${C.cyan}${pushBranch}${C.reset}${C.bold} from earlier merges${C.reset}`);
    }
    if (mergedCount > 0 && aheadCount > 0) {
      console.log(`  ${C.dim}${aheadCount} commit(s) ahead of ${effectiveRemote}/${pushBranch}${C.reset}`);
    }
    if (pushBranchInfo.fallback) {
      console.log(`  ${C.yellow}Configured target branch ${C.cyan}${pushBranchInfo.missingBranch}${C.yellow} is not a local branch; using ${C.cyan}${pushBranch}${C.yellow} for push.${C.reset}`);
    }

    const workingTreeStatus = String(state.workingTreeStatus || "").trim();
    if (workingTreeStatus) {
      const statusLines = workingTreeStatus.split("\n");
      console.log(`\n  ${C.red}${C.bold}\u26a0 Working tree has ${statusLines.length} uncommitted change(s):${C.reset}`);
      for (const line of statusLines.slice(0, 8)) {
        console.log(`    ${C.dim}${line}${C.reset}`);
      }
      if (statusLines.length > 8) {
        console.log(`    ${C.dim}... and ${statusLines.length - 8} more${C.reset}`);
      }
      console.log(`\n  ${C.yellow}These changes are NOT included in the merge commits.${C.reset}`);
      console.log(`  ${C.yellow}Pushing now will only push the merged work, not these uncommitted files.${C.reset}`);
    }

    const unmergedWIs = Array.isArray(state.unmergedWIs) ? state.unmergedWIs : [];
    if (unmergedWIs.length > 0) {
      console.log(`\n  ${C.yellow}${C.bold}\u26a0 ${unmergedWIs.length} branch(es) with commits NOT in this push:${C.reset}`);
      for (const item of unmergedWIs) {
        console.log(`    ${C.cyan}WI#${item.wiId}${C.reset} ${(item.title || "").slice(0, 50)} \u2014 ${item.message}`);
      }
      console.log(`  ${C.dim}Use 'node orchestrator.js review' or 'merge' to include them.${C.reset}`);
    }

    // Persist the offer as a bridge gate FIRST, regardless of TTY: the
    // phone (or a later CLI session) can deploy even when nobody answers
    // here. Pushing below closes the gate; declining leaves it open.
    let pushGate = { ok: false };
    try {
      pushGate = upsertPushOfferGate(state, { createdBy: "run_wrapup" });
    } catch (err) {
      console.log(`  ${C.dim}Push gate not created: ${err?.message || err}${C.reset}`);
    }

    // Headless/explicit batch mode: never prompt. The gate above carries the
    // offer for the app or a later terminal session.
    if (!process.stdin.isTTY || nonInteractive) {
      console.log(`  ${C.dim}Push offer available \u2014 answer from the Posse app, or run: git push${C.reset}`);
      console.log("");
      return;
    }

    const answer = await askSingleKeyYesNo(`  Push to remote? [y/N] `, { fallbackAsk: askFn });
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log(`  ${C.dim}Skipped push. You can push manually, or from the Posse app.${C.reset}`);
      console.log("");
      return;
    }

    console.log(`  ${C.dim}Pushing ${pushBranch} to ${effectiveRemote}...${C.reset}`);
    const pushed = await executePushAsync({ effectiveRemote, pushBranch, mergedCount }).catch((err) => ({
      ok: false,
      reason: "push_failed",
      output: err?.message || String(err),
    }));
    if (pushed.ok) {
      console.log(`  ${C.green}\u2713 Pushed to ${effectiveRemote}${C.reset}`);
      try {
        markOpenPushOfferGatePushed({ remote: effectiveRemote, branch: pushBranch, via: "terminal" });
      } catch { /* gate close is best-effort; supersede covers stragglers */ }
    } else if (pushed.reason === "conflict_markers") {
      const files = Array.isArray(pushed.files) ? pushed.files : [];
      console.log(`  ${C.red}\u2717 Conflict markers found in ${files.length} file(s) — refusing to push:${C.reset}`);
      for (const f of files.slice(0, 5)) {
        console.log(`    ${C.dim}${f}${C.reset}`);
      }
      if (files.length > 5) console.log(`    ${C.dim}... and ${files.length - 5} more${C.reset}`);
      console.log(`  ${C.dim}Resolve conflicts first, then push manually: git push${C.reset}`);
    } else if (pushed.reason === "gate_failed") {
      const output = String(pushed.output || "");
      console.log(`  ${C.red}\u2717 ${output.split("\n")[0] || "Pre-push gate failed"}${C.reset}`);
      const extra = output.split("\n").slice(1, 8);
      for (const line of extra) {
        console.log(`  ${C.dim}${line}${C.reset}`);
      }
      console.log(`  ${C.dim}Push skipped until the gate passes.${C.reset}`);
    } else {
      const output = String(pushed.output || "unknown error");
      console.log(`  ${C.red}\u2717 Push failed: ${output.split("\n")[0]}${C.reset}`);
    }

    console.log("");
  }

  /**
   * Startup cleanup: enforce target-branch cleanliness, then run shared worktree GC.
   * The worker-owned GC path is the source of truth for preserving dirty state
   * before cleaning startup worktrees.
   */
  async function startupWorktreeCleanup({
    signal = null,
    onMsg = null,
    skipDirtyTreeGuard = false,
    recoveryPruneMinIntervalMs = undefined,
    forceRecoveryPrune = false,
  } = {}) {
    if (!skipDirtyTreeGuard) {
      await guardStartupDirtyTreeAsync({
        reason: "startup cleanup",
        signal,
        onPhase: (event) => {
          if (typeof onMsg === "function" && event?.detail) onMsg(`Git dirty tree: ${event.detail}`);
        },
      });
      throwIfAborted(signal);
    }
    const gcOptions = { signal };
    if (recoveryPruneMinIntervalMs !== undefined) gcOptions.recoveryPruneMinIntervalMs = recoveryPruneMinIntervalMs;
    if (forceRecoveryPrune) gcOptions.forceRecoveryPrune = true;
    await gcWorktreesAsync(projectDir, (msg) => {
      if (typeof onMsg === "function") {
        onMsg(msg);
      } else {
        console.log(`  ${C.yellow}${msg}${C.reset}`);
      }
    }, gcOptions);
  }

  function gitDiffStat(mergeBase, branch, cwd) {
    try {
      const raw = execFileSync("git", ["diff", "--stat", `${mergeBase}...${branch}`], { cwd, encoding: "utf-8", timeout: GIT_OPERATION_TIMEOUT_MS });
      return raw.trim().split("\n").filter(l => l.trim());
    } catch {
      return [];
    }
  }

  function gitDiffStatAsync(mergeBase, branch, cwd = projectDir, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("gitDiffStat", { mergeBase, branch, cwd }, workerOptions);
  }

  /**
   * Merge a WI branch into the explicit target branch (master/main).
   * Checks out the target branch first, stashing any uncommitted changes.
   */
  const GIT_MERGE_TIMEOUT_MS = 600_000; // 10 min; post-commit ATLAS indexing can legitimately take a while.

  function gitMergeExec(args, cwd, { trim = true } = {}) {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_MERGE_TIMEOUT_MS,
    });
    return trim ? String(out || "").trim() : String(out || "");
  }

  function firstGitLine(err) {
    return String(err?.stderr || err?.stdout || err?.message || err || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0] || "unknown git error";
  }

  function isGitTimeoutError(err) {
    const text = String([
      err?.code,
      err?.signal,
      err?.message,
      err?.stderr,
      err?.stdout,
    ].filter(Boolean).join("\n"));
    return err?.code === "ETIMEDOUT" || /ETIMEDOUT|timed out|timeout/i.test(text);
  }

  function expectedSquashSubject(branch, mergeTargetBranch = currentTargetBranch()) {
    const targetBranch = mergeTargetBranch;
    return `Squash merge ${branch} into ${targetBranch}`;
  }

  function emitMergePhase(onPhase, phase, message, data = {}) {
    if (typeof onPhase !== "function") return;
    try { onPhase({ phase, message, ...data }); } catch { /* display callback only */ }
  }

  function gitMergeCommitParent(cwd, mergeHash) {
    if (!mergeHash || mergeHash === "(unknown)") return "";
    try {
      return gitMergeExec(["rev-parse", `${mergeHash}^`], cwd);
    } catch {
      return "";
    }
  }

  function gitMergeCommitChangedPaths(cwd, mergeHash, parentHash = "") {
    if (!mergeHash || mergeHash === "(unknown)") return [];
    const linesFrom = (text) => [...new Set(String(text || "")
      .split("\n")
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter(Boolean))];
    if (parentHash) {
      try {
        return linesFrom(gitMergeExec(["diff", "--name-only", parentHash, mergeHash], cwd, { trim: false }));
      } catch {
        // Fall through to diff-tree below.
      }
    }
    try {
      return linesFrom(gitMergeExec(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", mergeHash], cwd, { trim: false }));
    } catch {
      return [];
    }
  }

  function emitAtlasMainAdvancedAfterMerge({
    wiId = null,
    branchName = null,
    targetBranch = null,
    mergeHash = null,
    cwd = projectDir,
    source = "merge",
  } = {}) {
    if (!mergeHash || mergeHash === "(unknown)") return { attempted: false, skipped: "missing_merge_hash" };
    if (!isAtlasV2EmissionEnabled()) return { attempted: false, skipped: "atlas_v2_emission_disabled" };
    const parentHash = gitMergeCommitParent(cwd, mergeHash);
    const paths = gitMergeCommitChangedPaths(cwd, mergeHash, parentHash);
    const target = String(targetBranch || currentTargetBranch() || "main");
    try {
      const result = emitAtlasV2MainAdvanced({
        payload: {
          from_sha: parentHash,
          to_sha: String(mergeHash),
          target_branch: target,
          paths,
          source,
        },
        jobId: null,
        onError: (err) => logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
          actor_type: EVENT_ACTORS.ATLAS,
          message: `ATLAS main refresh outbox failed after merge of ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
          event_json: JSON.stringify({
            branch: branchName || null,
            target_branch: target,
            merge_hash: mergeHash,
            parent_hash: parentHash || null,
            source,
            error: err?.message || String(err),
          }),
        }),
      });
      return {
        ...result,
        attempted: true,
        parentHash,
        paths,
      };
    } catch (err) {
      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
        actor_type: EVENT_ACTORS.ATLAS,
        message: `ATLAS main refresh outbox failed after merge of ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
        event_json: JSON.stringify({
          branch: branchName || null,
          target_branch: target,
          merge_hash: mergeHash,
          parent_hash: parentHash || null,
          source,
          error: err?.message || String(err),
        }),
      });
      return { attempted: true, ok: false, error: err?.message || String(err) };
    }
  }

  async function refreshAtlasMainAfterMerge({ wiId, branchName, targetBranch, mergeHash, onPhase = null, source = "merge" } = {}) {
    if (!wiId || !mergeHash || mergeHash === "(unknown)") return { attempted: false, skipped: "missing_merge_metadata" };
    emitMergePhase(onPhase, "atlas-indexing", `ATLAS finalizing ${branchName || `WI#${wiId}`}`, {
      branch: branchName,
      target: targetBranch,
      mergeHash,
      source,
    });
    const replay = await warmAtlasMergedToMainNow({
      cwd: projectDir,
      workItemId: wiId,
      targetBranch,
      mergeHash,
      triggerEvent: "atlas.merged_to_main",
    });
    if (replay.attempted) {
      const result = replay.result || {};
      logEvent({
        work_item_id: wiId,
        event_type: replay.ok === false ? EVENT_TYPES.ATLAS_REINDEX_FAILED : EVENT_TYPES.ATLAS_WARM_COMPLETED,
        actor_type: EVENT_ACTORS.ATLAS,
        message: replay.ok === false
          ? `ATLAS merge warm failed for ${branchName || `WI#${wiId}`}: ${replay.error || "unknown error"}`
          : `ATLAS warm (main-merge) completed: considered=${result.paths_considered ?? 0} branch=${targetBranch}`,
        event_json: JSON.stringify({
          purpose: "main-merge",
          branch: targetBranch,
          source_branch: replay.sourceBranch || null,
          merge_hash: mergeHash,
          backend: replay.backend || "atlas-v2",
          trigger_event: "atlas.merged_to_main",
          source,
          ok: replay.ok !== false,
          skipped: replay.skipped || null,
          error: replay.error || null,
          result,
        }),
      });
    }
    if (isAtlasV2EmissionEnabled() && (replay.ok === false || replay.skipped === "source_branch_missing")) {
      emitAtlasV2MergedToMain({
        payload: {
          wi_id: Number(wiId),
          source_branch: String(branchName || ""),
          target_branch: String(targetBranch || "main"),
          merge_commit_sha: String(mergeHash || ""),
        },
        onError: (err) => logEvent({
          work_item_id: wiId,
          event_type: EVENT_TYPES.ATLAS_REINDEX_FAILED,
          actor_type: EVENT_ACTORS.ATLAS,
          message: `ATLAS merge outbox fallback failed for ${branchName || `WI#${wiId}`}: ${err?.message || String(err)}`,
          event_json: JSON.stringify({
            branch: branchName || null,
            target_branch: targetBranch || null,
            merge_hash: mergeHash || null,
            error: err?.message || String(err),
          }),
        }),
      });
    }
    return replay;
  }

  function parseOverwritePaths(err) {
    const text = String(err?.stderr || err?.stdout || err?.message || err || "");
    const paths = [];
    let collecting = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!collecting && /untracked working tree files would be overwritten by \S+/i.test(trimmed)) {
        collecting = true;
        continue;
      }
      if (!collecting) continue;
      if (!trimmed) continue;
      if (/^(?:Please|Aborting|error:|fatal:|Resolve conflicts manually|hint:)\b/i.test(trimmed)) break;
      paths.push(trimmed.replace(/^"|"$/g, "").replace(/\\/g, "/"));
    }
    return [...new Set(paths)].filter(Boolean);
  }

  // Backward-compatible alias; both checkout- and merge-blocked errors use
  // the same "untracked working tree files would be overwritten by <op>"
  // template, so a single parser handles both.
  const parseCheckoutOverwritePaths = parseOverwritePaths;

  function snapshotLabel(snapshotRef) {
    return snapshotRef?.refName || snapshotRef?.snapshotPath || String(snapshotRef || "");
  }

  function cleanupSquashMessage(cwd) {
    try {
      const dotGit = gitMergeExec(["rev-parse", "--git-path", "SQUASH_MSG"], cwd);
      const squashPath = path.isAbsolute(dotGit) ? dotGit : path.join(cwd, dotGit);
      if (squashPath && fs.existsSync(squashPath)) fs.rmSync(squashPath, { force: true });
    } catch { /* best effort */ }
  }

  function gitLines(args, cwd) {
    try {
      return gitMergeExec(args, cwd)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function gitLinesOrNull(args, cwd) {
    try {
      return gitMergeExec(args, cwd)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  function recoverTimedOutMerge(branch, cwd, log, onPhase = null, { step = "unknown", targetBranch = currentTargetBranch() } = {}) {
    const canRecover = step === "commit" || step === "postcommit";
    if (!canRecover) return null;

    const subject = expectedSquashSubject(branch, targetBranch);
    const head = (() => {
      try { return gitMergeExec(["rev-parse", "HEAD"], cwd); } catch { return null; }
    })();
    const headSubject = (() => {
      try { return gitMergeExec(["show", "-s", "--format=%s", "HEAD"], cwd); } catch { return ""; }
    })();
    const stagedFiles = gitLines(["diff", "--cached", "--name-only"], cwd);
    const unmergedFiles = gitLinesOrNull(["diff", "--name-only", "--diff-filter=U"], cwd);
    if (unmergedFiles == null) {
      return null;
    }

    if (head && headSubject === subject && unmergedFiles.length === 0) {
      cleanupSquashMessage(cwd);
      log(`Merge timeout recovered: ${branch} commit already landed at ${head}`, {
        json: {
          branch,
          target: targetBranch,
          merge_hash: head,
          timed_out: true,
          timeout_step: step,
          recovered: "commit_already_landed",
        },
      });
      return {
        ok: true,
        timedOut: true,
        recoveredFromTimeout: true,
        mergeHash: head,
        message: `Merged ${branch} into ${targetBranch} (recovered after timeout)`,
        targetBranch,
      };
    }

    if (unmergedFiles.length === 0 && stagedFiles.length > 0) {
      emitMergePhase(onPhase, "retry", `Retrying merge commit for ${branch}`, { branch, target: targetBranch });
      log(`Merge timed out with staged changes; retrying squash merge commit for ${branch}`, {
        json: {
          branch,
          target: targetBranch,
          staged_count: stagedFiles.length,
          staged_files: stagedFiles.slice(0, 50),
          timed_out: true,
          timeout_step: step,
        },
      });
      try {
        emitMergePhase(onPhase, "atlas-indexing", `ATLAS indexing ${branch}`, { branch, target: targetBranch, retry: true });
        gitMergeExec(["commit", "-m", subject], cwd);
        const mergeHash = gitMergeExec(["rev-parse", "HEAD"], cwd);
        cleanupSquashMessage(cwd);
        log(`Merge timeout retry succeeded: ${branch} into ${targetBranch} at ${mergeHash}`, {
          json: {
            branch,
            target: targetBranch,
            merge_hash: mergeHash,
            timed_out: true,
            timeout_step: step,
            recovered: "commit_retry",
          },
        });
        return {
          ok: true,
          timedOut: true,
          recoveredFromTimeout: true,
          mergeHash,
          message: `Merged ${branch} into ${targetBranch} after retry`,
          targetBranch,
        };
      } catch (retryErr) {
        log(`Merge timeout retry failed: ${branch} into ${targetBranch}`, {
          json: {
            branch,
            target: targetBranch,
            error: firstGitLine(retryErr),
            timed_out: true,
            timeout_step: step,
          },
        });
      }
    }

    return null;
  }

  function resolveStashByToken(cwd, token) {
    if (!token) return null;
    let list = "";
    try {
      list = gitMergeExec(["stash", "list", "--format=%H%x00%gd%x00%s"], cwd);
    } catch {
      return null;
    }
    for (const line of list.split("\n")) {
      if (!line) continue;
      const parts = line.split("\0");
      if (parts.length < 3) continue;
      const [hash, ref, subject] = parts;
      if (subject && subject.includes(token)) return { hash, ref, subject };
    }
    return null;
  }

  function dropResolvedAutoStash(cwd, stashState, log) {
    const resolved = resolveStashByToken(cwd, stashState?.token);
    if (!resolved?.ref || resolved.hash !== stashState?.hash) return false;
    try {
      gitMergeExec(["stash", "drop", resolved.ref], cwd);
      return true;
    } catch (err) {
      log(`Auto-stash restored but drop failed; stash left for manual cleanup`, {
        json: {
          stash_ref: resolved.ref,
          stash_hash: resolved.hash,
          error: firstGitLine(err),
        },
      });
      return false;
    }
  }

  function restoreAutoStash(cwd, stashState, log, context) {
    if (!stashState?.hash) return null;
    const restoreBranch = stashState.originalBranch || null;
    try {
      const nowOn = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      if (restoreBranch && nowOn !== restoreBranch) {
        gitMergeExec(["checkout", restoreBranch], cwd);
        log(`Checked out ${restoreBranch} before restoring auto-stashed changes`, {
          json: { from: nowOn, to: restoreBranch, stash_hash: stashState.hash },
        });
      }
    } catch (err) {
      const warning = `Could not return to ${restoreBranch || "original branch"} before restoring auto-stash: ${firstGitLine(err)}`;
      log(warning, { json: { stash_hash: stashState.hash, stash_ref: stashState.ref } });
      return warning;
    }

    try {
      gitMergeExec(["stash", "apply", "--index", stashState.hash], cwd);
      dropResolvedAutoStash(cwd, stashState, log);
      log(`Restored auto-stashed changes after ${context}`, {
        json: {
          stash_hash: stashState.hash,
          original_branch: restoreBranch,
        },
      });
      return null;
    } catch (err) {
      const resolved = resolveStashByToken(cwd, stashState.token);
      const warning = `Auto-stash restore conflicted after ${context}; stash preserved for manual recovery`;
      log(warning, {
        json: {
          stash_ref: resolved?.ref || stashState.ref,
          stash_hash: stashState.hash,
          original_branch: restoreBranch,
          error: firstGitLine(err),
        },
      });
      return `${warning} (${resolved?.ref || stashState.hash})`;
    }
  }

  function gitMergeToTarget(branch, cwd, { wiId = null, onPhase = null } = {}) {
    const targetBranch = currentTargetBranch();
    const log = (msg, extra = {}) => {
      logEvent({
        work_item_id: wiId,
        event_type: EVENT_TYPES.GIT_MERGE,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: msg,
        event_json: extra.json ? JSON.stringify(extra.json) : undefined,
      });
    };

    const mergeBlockers = wiId == null ? [] : listCrossWiMergeBlockers(wiId);
    if (mergeBlockers.length > 0) {
      const blockers = mergeBlockers.map((blocker) => {
        const source = blocker.source_work_item;
        const label = source
          ? `WI#${source.id} (${source.status}${source.merge_state ? `/${source.merge_state}` : ""})`
          : `WI#${blocker.source_work_item_id} (missing)`;
        const paths = blocker.paths.length > 0 ? `: ${blocker.paths.join(", ")}` : "";
        return `${label}${paths}`;
      });
      const message = `Merge deferred: WI#${wiId} depends on upstream merge ${blockers.join("; ")}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          deferred: true,
          blockers: mergeBlockers.map((blocker) => ({
            source_work_item_id: blocker.source_work_item_id,
            paths: blocker.paths,
            source_status: blocker.source_work_item?.status || null,
            source_merge_state: blocker.source_work_item?.merge_state || null,
            reason: blocker.reason,
          })),
        },
      });
      return { ok: false, deferred: true, message, blockers: mergeBlockers };
    }

    const sourceDirty = sourceWorktreeDirtyState(wiId);
    if (sourceDirty && sourceDirty.trackedFiles.length > 0) {
      const message = `Merge refused: WI#${wiId} worktree has ${sourceDirty.trackedFiles.length} unresolved dirty file(s) before merging ${branch}`;
      log(message, {
        json: {
          branch,
          target: targetBranch,
          source_dirty: true,
          worktree: sourceDirty.wtDir,
          dirty_count: sourceDirty.trackedFiles.length,
          dirty_files: sourceDirty.trackedFiles.slice(0, 50),
          untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
        },
      });
      return {
        ok: false,
        dirty: true,
        sourceDirty: true,
        message,
        wtDir: sourceDirty.wtDir,
        dirtyFiles: sourceDirty.trackedFiles.slice(0, 50),
      };
    }
    if (sourceDirty) {
      // Untracked-only leftovers cannot reach the squash merge — it stages only
      // the branch's commits — so they don't gate it. Post-merge cleanup
      // force-removes the worktree, making the snapshot taken here the only
      // surviving copy; refuse the merge if it cannot be written.
      let snapshotRef = null;
      try {
        snapshotRef = preserveDirtyWorktreeSnapshot(sourceDirty.wtDir, projectDir, {
          reason: "untracked-leftovers",
          branchName: branch,
          wiId,
          onMsg: (msg) => log(msg, { json: { branch, worktree: sourceDirty.wtDir } }),
        });
      } catch {
        snapshotRef = null;
      }
      if (!snapshotRef) {
        const message = `Merge refused: could not snapshot ${sourceDirty.untrackedFiles.length} untracked leftover file(s) in WI#${wiId} worktree before merging ${branch}`;
        log(message, {
          json: {
            branch,
            target: targetBranch,
            source_dirty: true,
            worktree: sourceDirty.wtDir,
            untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
          },
        });
        return {
          ok: false,
          dirty: true,
          sourceDirty: true,
          message,
          wtDir: sourceDirty.wtDir,
          dirtyFiles: sourceDirty.untrackedFiles.slice(0, 50),
        };
      }
      log(`Proceeding with merge of ${branch} despite ${sourceDirty.untrackedFiles.length} untracked leftover file(s) in WI#${wiId} worktree; preserved at ${snapshotRef}`, {
        json: {
          branch,
          target: targetBranch,
          worktree: sourceDirty.wtDir,
          untracked_files: sourceDirty.untrackedFiles.slice(0, 50),
          snapshot_ref: String(snapshotRef),
        },
      });
    }

    let currentBranch = null;
    let autoStash = null;

    try {
      // Pre-flight: clean up any stale merge state (MERGE_HEAD from aborted merge)
      let hasMergeHead = false;
      try {
        gitMergeExec(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
        hasMergeHead = true;
      } catch {
        hasMergeHead = false;
      }
      if (hasMergeHead) {
        log(`Found stale MERGE_HEAD — cleaning up before merge of ${branch}`);
        try { gitMergeExec(["merge", "--abort"], cwd); } catch {
          gitMergeExec(["reset", "--merge"], cwd);
        }
      }

      // Pre-flight: clean up unmerged index entries (left by failed stash pop)
      // These have no MERGE_HEAD but leave conflict markers in the working tree.
      // Accept the current HEAD version and move on. Never drop a stash here:
      // stale conflict cleanup cannot know which stash, if any, caused it.
      try {
        const unmerged = gitMergeExec(["diff", "--name-only", "--diff-filter=U"], cwd);
        if (unmerged.length > 0) {
          const files = unmerged.split("\n").filter(Boolean);
          log(`Found ${files.length} unmerged path(s) from stale stash pop — resetting to HEAD and leaving stash stack untouched`, { json: { files } });
          for (const f of files) {
            gitMergeExec(["checkout", "HEAD", "--", f], cwd);
          }
        }
      } catch { /* git diff failed — proceed anyway */ }

      currentBranch = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const sweptInferTsconfig = sweepOrphanedInferTsconfig(cwd);
      if (sweptInferTsconfig) {
        log(`Removed orphaned SCIP infer-tsconfig placeholder before merging ${branch}`, {
          json: {
            branch,
            target: targetBranch,
            path: "tsconfig.json",
            original_branch: currentBranch,
          },
        });
      }
      const status = gitMergeExec(["status", "--porcelain", "--untracked-files=all"], cwd);
      const dirtyFiles = status
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !isRuntimePorcelainLine(line, cwd));
      if (dirtyFiles.length > 0) {
        const message = `Merge refused: target worktree has ${dirtyFiles.length} uncommitted change(s) before merging ${branch}`;
        log(message, {
          json: {
            branch,
            target: targetBranch,
            dirty: true,
            dirty_count: dirtyFiles.length,
            dirty_files: dirtyFiles.slice(0, 50),
            original_branch: currentBranch,
          },
        });
        return {
          ok: false,
          dirty: true,
          message,
          dirtyFiles: dirtyFiles.slice(0, 50),
        };
      }

      // Checkout target branch if not already on it
      if (currentBranch !== targetBranch) {
        log(`Checking out ${targetBranch} (was on ${currentBranch})`, { json: { from: currentBranch, to: targetBranch } });
        try {
          gitMergeExec(["checkout", targetBranch], cwd);
        } catch (checkoutErr) {
          const checkoutText = String(checkoutErr?.stderr || checkoutErr?.stdout || checkoutErr?.message || "");
          const overwriteMatch = checkoutText.match(/would be overwritten/i);
          if (overwriteMatch) {
            const checkoutBlockers = parseCheckoutOverwritePaths(checkoutErr);
            if (checkoutBlockers.length === 0) {
              const message = `Merge refused: checkout to ${targetBranch} was blocked, but no safe untracked path list could be parsed`;
              log(message, { json: { branch, target: targetBranch, error: firstGitLine(checkoutErr) } });
              return { ok: false, dirty: true, message };
            }

            let snapshotRef = null;
            try {
              snapshotRef = preserveDirtyWorktreeSnapshot(cwd, projectDir, {
                reason: `target-checkout-overwrite-${targetBranch}`,
                branchName: currentBranch,
                wiId,
                onMsg: (msg) => log(msg, { json: { branch, target: targetBranch } }),
              });
            } catch (snapshotErr) {
              const message = `Merge refused: could not snapshot checkout-blocking untracked files before switching to ${targetBranch}`;
              log(message, {
                json: {
                  branch,
                  target: targetBranch,
                  checkout_blockers: checkoutBlockers.slice(0, 50),
                  error: firstGitLine(snapshotErr),
                },
              });
              return { ok: false, dirty: true, message, dirtyFiles: checkoutBlockers.slice(0, 50) };
            }
            if (!snapshotRef) {
              const message = `Merge refused: checkout-blocking untracked files were not snapshotted before switching to ${targetBranch}`;
              log(message, {
                json: {
                  branch,
                  target: targetBranch,
                  checkout_blockers: checkoutBlockers.slice(0, 50),
                },
              });
              return { ok: false, dirty: true, message, dirtyFiles: checkoutBlockers.slice(0, 50) };
            }

            log(`Checkout blocked by conflicting untracked files — snapshotted and cleaning named paths`, {
              json: {
                branch,
                target: targetBranch,
                checkout_blockers: checkoutBlockers.slice(0, 50),
                snapshot_ref: snapshotLabel(snapshotRef),
                error: firstGitLine(checkoutErr),
              },
            });
            gitMergeExec(["clean", "-fd", "--", ...checkoutBlockers], cwd);
            gitMergeExec(["checkout", targetBranch], cwd);
          } else {
            throw checkoutErr;
          }
        }
      }

      // Merge the WI branch as a squash to avoid retry/fix-of-fix commit noise on main.
      const preMergeHead = (() => {
        try { return gitMergeExec(["rev-parse", "HEAD"], cwd); } catch { return null; }
      })();
      log(`Squash-merging ${branch} into ${targetBranch}`, { json: { branch, target: targetBranch } });
      let mergeHash = null;
      let mergeStep = "merge";
      let mergeCreated = false;

      // Execute the squash + (optional) commit sequence and return the new
      // HEAD. Extracted so the untracked-overwrite recovery path can re-run
      // the same body after snapshotting and cleaning blockers.
      const attemptSquashMerge = (label = "merge") => {
        mergeStep = "merge";
        emitMergePhase(onPhase, "merge", `${label === "merge" ? "Merging" : "Retrying merge of"} ${branch} into ${targetBranch}`, { branch, target: targetBranch });
        gitMergeExec(["merge", "--squash", branch], cwd);
        mergeStep = "diff";
        const staged = gitMergeExec(["diff", "--cached", "--name-only"], cwd);
        const stagedFiles = staged.split("\n").map((line) => line.trim()).filter(Boolean);
        if (stagedFiles.length > 0) {
          log(`Creating squash merge commit for ${branch} into ${targetBranch}`, {
            json: {
              branch,
              target: targetBranch,
              staged_count: stagedFiles.length,
              staged_files: stagedFiles.slice(0, 50),
            },
          });
          emitMergePhase(onPhase, "atlas-indexing", `ATLAS indexing ${branch}`, { branch, target: targetBranch });
          mergeStep = "commit";
          gitMergeExec(["commit", "-m", expectedSquashSubject(branch, targetBranch)], cwd);
          mergeCreated = true;
          mergeStep = "postcommit";
        } else {
          log(`No staged changes after squash merge of ${branch}; branch likely already integrated`, {
            json: { branch, target: targetBranch },
          });
          cleanupSquashMessage(cwd);
        }
        return gitMergeExec(["rev-parse", "HEAD"], cwd);
      };

      try {
        mergeHash = attemptSquashMerge();
      } catch (mergeErr) {
        let finalMergeErr = mergeErr;
        // `git merge --squash` can fail BEFORE touching the index when an
        // untracked file would be overwritten. The pre-checkout snapshot
        // path doesn't catch this because no checkout occurred (we were
        // already on targetBranch). Mirror that recovery here: snapshot
        // the blockers, clean the named paths only, and retry once.
        const mergeErrText = String(mergeErr?.stderr || mergeErr?.stdout || mergeErr?.message || "");
        const untrackedBlocked = mergeStep === "merge"
          && /untracked working tree files would be overwritten by merge/i.test(mergeErrText);
        if (untrackedBlocked) {
          const blockers = parseOverwritePaths(mergeErr);
          if (blockers.length > 0) {
            let snapshotRef = null;
            try {
              snapshotRef = preserveDirtyWorktreeSnapshot(cwd, projectDir, {
                reason: `target-checkout-overwrite-${targetBranch}`,
                branchName: currentBranch,
                wiId,
                onMsg: (msg) => log(msg, { json: { branch, target: targetBranch } }),
              });
            } catch (snapshotErr) {
              log(`Merge refused: could not snapshot merge-blocking untracked files before merging ${branch}`, {
                json: {
                  branch,
                  target: targetBranch,
                  merge_blockers: blockers.slice(0, 50),
                  error: firstGitLine(snapshotErr),
                },
              });
            }
            if (snapshotRef) {
              log(`Merge blocked by conflicting untracked files — snapshotted and cleaning named paths`, {
                json: {
                  branch,
                  target: targetBranch,
                  merge_blockers: blockers.slice(0, 50),
                  snapshot_ref: snapshotLabel(snapshotRef),
                  error: firstGitLine(mergeErr),
                },
              });
              try {
                gitMergeExec(["clean", "-fd", "--", ...blockers], cwd);
                mergeHash = attemptSquashMerge("retry");
              } catch (retryErr) {
                finalMergeErr = retryErr;
              }
            }
          }
        }

        if (mergeHash != null) {
          // Recovery succeeded — drop into the post-merge success block.
        } else {
        const error = firstGitLine(finalMergeErr);
        const timedOut = isGitTimeoutError(finalMergeErr);
        if (timedOut) {
          const recovered = recoverTimedOutMerge(branch, cwd, log, onPhase, { step: mergeStep, targetBranch });
          if (recovered?.ok) {
            emitAtlasMainAdvancedAfterMerge({
              wiId,
              branchName: branch,
              targetBranch,
              mergeHash: recovered.mergeHash,
              cwd,
              source: "merge",
            });
            return recovered;
          }
        }
        const failureMessage = timedOut
          ? `Merge timed out: ${branch} into ${targetBranch} after ${GIT_MERGE_TIMEOUT_MS}ms — aborting`
          : `Merge failed: ${branch} into ${targetBranch} — aborting`;
        log(failureMessage, {
          json: {
            branch,
            target: targetBranch,
            error,
            timed_out: timedOut,
            timeout_ms: timedOut ? GIT_MERGE_TIMEOUT_MS : null,
          },
        });
        // Abort the failed merge so the tree is clean — fall back to reset --merge
        try { gitMergeExec(["merge", "--abort"], cwd); } catch {
          try { gitMergeExec(["reset", "--merge"], cwd); } catch { /* last resort */ }
        }
        // Restore original branch if we switched
        if (currentBranch !== targetBranch) {
          try { gitMergeExec(["checkout", currentBranch], cwd); } catch { /* keep original merge error */ }
        }
        const restoreWarning = autoStash
          ? restoreAutoStash(cwd, autoStash, log, `failed merge of ${branch}`)
          : null;
        return {
          ok: false,
          timedOut,
          message: `${timedOut ? "Merge timed out" : "Merge failed"}: ${error}${restoreWarning ? `; ${restoreWarning}` : ""}`,
          stashPopWarning: restoreWarning,
        };
        }
      }

      // Defensive fallback for older callers/tests that may still set autoStash:
      // a restore conflict after the merge commit is a failed merge workflow, not
      // a silently recoverable success.
      let stashPopWarning = null;
      if (autoStash) {
        stashPopWarning = restoreAutoStash(cwd, autoStash, log, `merging ${branch}`);
        if (stashPopWarning) {
          return {
            ok: false,
            message: `Merge completed but auto-stash restore failed: ${stashPopWarning}`,
            stashPopWarning,
            mergeHash,
          };
        }
      }

      log(`Merged ${branch} into ${targetBranch} at ${mergeHash}`, { json: { branch, target: targetBranch, merge_hash: mergeHash } });
      if (mergeCreated || (preMergeHead && mergeHash && mergeHash !== preMergeHead)) {
        emitAtlasMainAdvancedAfterMerge({
          wiId,
          branchName: branch,
          targetBranch,
          mergeHash,
          cwd,
          source: "merge",
        });
      }
      return {
        ok: true,
        message: `Merged ${branch} into ${targetBranch}`,
        stashPopWarning,
        mergeHash,
        targetBranch,
      };
    } catch (err) {
      log(`Merge setup failed: ${firstGitLine(err)}`, { json: { branch, error: firstGitLine(err) } });
      // Restore original branch if we ended up on targetBranch unexpectedly
      try {
        const nowOn = gitMergeExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (currentBranch && nowOn === targetBranch && nowOn !== currentBranch) {
          gitMergeExec(["checkout", currentBranch], cwd);
        }
      } catch { /* best effort — don't mask the original error */ }
      const restoreWarning = autoStash
        ? restoreAutoStash(cwd, autoStash, log, `setup failure for ${branch}`)
        : null;
      return { ok: false, message: `Merge failed: ${firstGitLine(err)}${restoreWarning ? `; ${restoreWarning}` : ""}`, stashPopWarning: restoreWarning, targetBranch };
    }
  }

  function gitMergeToTargetAsync(branch, cwd, {
    wiId = null,
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    return runGitWorkflowTaskOffMainThread("gitMergeToTarget", { branch, cwd, wiId }, { onPhase, signal, timeoutMs });
  }

  async function mergeIterativePassToTarget(wi, {
    passNumber = null,
    reason = "iterative pass",
    display = null,
    onPhase = null,
  } = {}) {
    const branchName = String(wi?.branch_name || "").trim();
    if (!branchName) return { ok: true, skipped: true, reason: "no_branch" };

    const targetBranch = currentTargetBranch();
    let sourceBranchTip = null;
    try {
      sourceBranchTip = execFileSync("git", ["rev-parse", branchName], {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    } catch {
      sourceBranchTip = null;
    }

    const say = (message) => {
      if (display) display.addEvent(message);
      else console.log(message);
    };

    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(`Merging iterative pass for WI#${wi.id}`);
    }
    const passLabel = passNumber ?? "?";
    say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: merging pass ${passLabel} into ${targetBranch} before next loop`);

    const result = await gitMergeToTargetAsync(branchName, projectDir, {
      wiId: wi.id,
      onPhase: onPhase || ((event = {}) => {
        if (event.phase === "atlas-indexing") {
          if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS indexing iterative pass for WI#${wi.id}`);
          if (!display) say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: ATLAS post-merge indexing`);
        } else if (event.phase === "retry") {
          if (typeof display?.setRunPhase === "function") display.setRunPhase(`Retrying iterative merge for WI#${wi.id}`);
          say(`  ${C.yellow}[iterate]${C.reset} WI#${wi.id}: retrying pass merge`);
        } else if (event.phase === "merge" && typeof display?.setRunPhase === "function") {
          display.setRunPhase(`Merging iterative pass for WI#${wi.id}`);
        }
      }),
    });

    if (!result.ok) return { ...result, targetBranch, sourceBranch: branchName, sourceBranchTip };

    const mergeHash = result.mergeHash || null;
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_ITERATION_PASS_MERGED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Merged iterative pass ${passLabel} from ${branchName} into ${targetBranch}${mergeHash ? ` at ${mergeHash}` : ""}`,
      event_json: JSON.stringify({
        branch: branchName,
        target_branch: targetBranch,
        merge_hash: mergeHash,
        source_branch_tip: sourceBranchTip,
        pass: passNumber,
        reason,
      }),
    });
    await refreshAtlasMainAfterMerge({
      wiId: wi.id,
      branchName,
      targetBranch,
      mergeHash,
      onPhase,
      source: "iterative_merge",
    });

    say(`  ${C.green}[iterate]${C.reset} WI#${wi.id}: pass ${passLabel} merged into ${targetBranch}${mergeHash ? ` (${mergeHash.slice(0, 8)})` : ""}`);
    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(`Merged iterative pass for WI#${wi.id}`);
    }
    return {
      ...result,
      targetBranch,
      sourceBranch: branchName,
      sourceBranchTip,
    };
  }

  function gitBranchExists(branchName, cwd) {
    try {
      execFileSync("git", ["rev-parse", "--verify", branchName], { cwd, encoding: "utf-8", stdio: "pipe", timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  function sameFsPath(a, b) {
    if (!a || !b) return false;
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  function isManagedWiWorktreePath(worktreePath, wiId) {
    if (wiId == null) return false;
    const resolved = path.resolve(worktreePath);
    const root = worktreeRoot(projectDir);
    if (!sameFsPath(path.dirname(resolved), root)) return false;
    const dirName = path.basename(resolved);
    const canonicalName = `wi-${wiId}`;
    return dirName === canonicalName || dirName.startsWith(`${canonicalName}-`);
  }

  function uniqueFsPaths(paths) {
    const result = [];
    for (const candidate of paths) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      if (!result.some((existing) => sameFsPath(existing, resolved))) result.push(resolved);
    }
    return result;
  }

  function gitTopLevelPath(cwd) {
    try {
      return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd, encoding: "utf-8", stdio: "pipe", timeout: 3000,
      }).trim());
    } catch {
      return path.resolve(cwd);
    }
  }

  function gitWorktreePathsForBranch(branchName, cwd) {
    const paths = [];
    try {
      const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd, encoding: "utf-8", stdio: "pipe", timeout: 10000,
      });
      let currentPath = null;
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length).trim();
          continue;
        }
        if (currentPath && line.trim() === `branch refs/heads/${branchName}`) {
          paths.push(currentPath);
        }
        if (line.trim() === "") currentPath = null;
      }
    } catch {
      // best effort; branch deletion will surface failure if a worktree remains
    }
    return paths;
  }

  function gitWorktreeRemove(worktreePath, cwd) {
    const target = path.resolve(worktreePath);
    const projectRoot = path.resolve(cwd);
    const mainRoot = gitTopLevelPath(cwd);
    if (sameFsPath(target, projectRoot) || sameFsPath(target, mainRoot)) {
      return false;
    }

    let removed = false;
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd, encoding: "utf-8", stdio: "pipe", timeout: GIT_OPERATION_TIMEOUT_MS });
      removed = true;
    } catch {
      try { execSync("git worktree prune", { cwd, encoding: "utf-8", stdio: "pipe", timeout: GIT_OPERATION_TIMEOUT_MS }); } catch { /* best effort */ }
    }
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, FORCE_REMOVE_OPTIONS);
        removed = true;
      } catch {
        // best effort; caller can decide whether branch state is safe to clear
      }
    }
    try { execSync("git worktree prune", { cwd, encoding: "utf-8", stdio: "pipe", timeout: GIT_OPERATION_TIMEOUT_MS }); } catch { /* best effort */ }
    return removed || !fs.existsSync(worktreePath);
  }

  function gitWorktreePorcelain(worktreePath) {
    return execSync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
  }

  function logWorktreeSnapshotCleanupFailure(wi, wtDir, message, extra = {}) {
    logEvent({
      work_item_id: wi?.id ?? null,
      event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: JSON.stringify({
        worktree_path: wtDir,
        branch: wi?.branch_name || null,
        ...extra,
      }),
    });
  }

  function logExternalWorktreeCleanupSkipped(wi, branchName, worktreePaths) {
    const paths = uniqueFsPaths(worktreePaths);
    if (paths.length === 0) return;
    logEvent({
      work_item_id: wi?.id ?? null,
      event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Skipped external worktree cleanup for ${branchName}; keeping branch metadata on WI#${wi?.id ?? "?"}`,
      event_json: JSON.stringify({
        branch: branchName,
        external_worktree_paths: paths,
        managed_root: worktreeRoot(projectDir),
      }),
    });
  }

  /**
   * Snapshot any dirty state and remove the worktree directory only — preserves the
   * branch (and its commits) so the user can retry a failed merge or re-approve.
   * Mirrors boot GC behavior (snapshot-then-remove), without touching the branch.
   */
  function snapshotAndRemoveWorktreeOnly(wi, reason) {
    if (!wi) return;
    const canonical = canonicalWorktreePath(projectDir, wi.id);
    const legacy = findLegacyWorktreeForWi(projectDir, wi.id);
    const candidates = [canonical];
    if (legacy && legacy !== canonical) candidates.push(legacy);

    for (const wtDir of candidates) {
      if (!fs.existsSync(wtDir)) continue;
      withWorktreeLock(wtDir, projectDir, () => {
        let snapshotSucceeded = false;
        let snapshotFailed = false;
        let status = "";
        try {
          status = gitWorktreePorcelain(wtDir);
          if (status) {
            const snapshotRef = preserveDirtyWorktreeSnapshot(wtDir, projectDir, {
              reason,
              branchName: wi.branch_name || null,
              wiId: wi.id,
              onMsg: (msg) => logEvent({
                work_item_id: wi.id,
                event_type: EVENT_TYPES.WORKTREE_SNAPSHOT_WARNING,
                actor_type: EVENT_ACTORS.SYSTEM,
                message: msg,
                event_json: JSON.stringify({ worktree_path: wtDir, branch: wi.branch_name || null }),
              }),
            });
            snapshotSucceeded = !!snapshotRef;
          }
        } catch (err) {
          snapshotFailed = true;
          logWorktreeSnapshotCleanupFailure(
            wi,
            wtDir,
            `Could not snapshot worktree before cleanup; leaving worktree on disk: ${err?.message || String(err)}`,
            { reason, error: err?.message || String(err) },
          );
        }

        let verifiedClean = false;
        try {
          verifiedClean = gitWorktreePorcelain(wtDir) === "";
        } catch (err) {
          if (!snapshotSucceeded) {
            logWorktreeSnapshotCleanupFailure(
              wi,
              wtDir,
              `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`,
              { reason, error: err?.message || String(err), snapshot_failed: snapshotFailed },
            );
          }
        }

        if (!snapshotSucceeded && !verifiedClean) {
          if (!snapshotFailed) {
            logWorktreeSnapshotCleanupFailure(
              wi,
              wtDir,
              "Worktree cleanup skipped because dirty state was not snapshotted and worktree is not clean",
              { reason, porcelain: status },
            );
          }
          return;
        }

        gitWorktreeRemove(wtDir, projectDir);
      });
    }
    try { execSync("git worktree prune", { cwd: projectDir, encoding: "utf-8", stdio: "pipe", timeout: 10000 }); } catch { /* best effort */ }
  }

  /** Clean up a WI's branch and worktree. Uses canonical wi-{id} path and also reaps any legacy slug-suffixed worktree. */
  function cleanupWiBranch(wi, { clearMergeState = false } = {}) {
    const targetBranch = currentTargetBranch();
    if (!wi.branch_name) return true;

    const canonical = canonicalWorktreePath(projectDir, wi.id);
    const legacy = findLegacyWorktreeForWi(projectDir, wi.id);
    const branchName = wi.branch_name;
    const candidates = [];
    const addCandidate = (candidate) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (!candidates.some((existing) => sameFsPath(existing, resolved))) candidates.push(resolved);
    };
    const skippedExternalWorktrees = [];
    const addManagedCandidate = (candidate) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (!isManagedWiWorktreePath(resolved, wi.id)) {
        if (!skippedExternalWorktrees.some((existing) => sameFsPath(existing, resolved))) {
          skippedExternalWorktrees.push(resolved);
        }
        return;
      }
      addCandidate(resolved);
    };

    // 1. Remove worktree(s) first (branch delete fails if checked out)
    if (fs.existsSync(canonical)) addManagedCandidate(canonical);
    if (legacy && !sameFsPath(legacy, canonical) && fs.existsSync(legacy)) addManagedCandidate(legacy);
    for (const wtPath of gitWorktreePathsForBranch(branchName, projectDir)) addManagedCandidate(wtPath);
    disposeWorkItemAtlasGraph({ projectDir: projectDir, workItemId: wi.id });
    for (const wtPath of candidates) {
      disposeWorkItemAtlasGraph({ projectDir: projectDir, workItemId: wi.id, worktreePath: wtPath });
      gitWorktreeRemove(wtPath, projectDir);
    }
    try { execSync("git worktree prune", { cwd: projectDir, encoding: "utf-8", stdio: "pipe", timeout: 10000 }); } catch { /* best effort */ }
    const remainingExternalWorktrees = gitWorktreePathsForBranch(branchName, projectDir)
      .filter((wtPath) => !isManagedWiWorktreePath(wtPath, wi.id));
    if (remainingExternalWorktrees.length > 0) {
      logExternalWorktreeCleanupSkipped(wi, branchName, [
        ...skippedExternalWorktrees,
        ...remainingExternalWorktrees,
      ]);
      return false;
    }
    // 2. Delete branch
    const deleteResult = deleteBranchPreservingTip(projectDir, branchName, {
      targetBranch: targetBranch,
      reason: clearMergeState ? "wi-branch-discard" : "wi-branch-cleanup",
      wiId: wi.id,
      onMsg: (msg) => logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.GIT_BRANCH_PRESERVED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: msg,
        event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch }),
      }),
    });
    const branchDeleted = deleteResult.ok;
    const branchStillExists = gitBranchExists(branchName, projectDir);
    if (!branchDeleted || branchStillExists) {
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.GIT_BRANCH_CLEANUP_FAILED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Could not delete branch ${branchName}; keeping branch metadata on WI#${wi.id}`,
        event_json: JSON.stringify({ branch: branchName, candidates, delete_result: deleteResult }),
      });
      return false;
    }
    // 3. Clear branch info from WI record (only reset merge_state on rejection/deletion)
    const db = getDb();
    db.prepare(`UPDATE work_items SET branch_name = NULL, merge_base_hash = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), wi.id);
    if (clearMergeState) setMergeState(wi.id, null);
    if (isAtlasV2EmissionEnabled()) {
      emitAtlasV2WiCleanup({
        payload: {
          wi_id: Number(wi.id),
          branch: String(branchName || ""),
          disposition: clearMergeState ? "abandoned" : "merged",
        },
        onError: () => { /* outbox failure must not block cleanup */ },
      });
    }
    return true;
  }

  function cleanupWiBranchAsync(wi, {
    clearMergeState = false,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    return runGitWorkflowTaskOffMainThread("cleanupWiBranch", { wi, clearMergeState }, { signal, timeoutMs });
  }

  function snapshotAndRemoveWorktreeOnlyAsync(wi, reason, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("snapshotAndRemoveWorktreeOnly", { wi, reason }, workerOptions);
  }

  function listEndOfRunMergeableWorkItems() {
    return listWorkItems(["complete"])
      .filter(wi => wi.branch_name && wi.merge_state !== "merged")
      .filter((wi) => !isIterativeWorkItemActive(wi))
      .filter((wi) => autoMerge || shouldAutoApproveIterativeWorkItem(wi));
  }

  function hasAutoMergeableCompletedWorkItems() {
    return listEndOfRunMergeableWorkItems()
      .some((wi) => wi.merge_state !== "merge_failed");
  }

  let autoMergeCompletedWorkItemsPromise = null;

  async function autoMergeCompletedWorkItemsImpl({ display = null, reason = "run wrap-up", runGc = true } = {}) {
    refreshWorkItemStatuses(AUTO_MERGE_STATUS_RECONCILE_STATUSES);
    const mergeable = listEndOfRunMergeableWorkItems();

    const say = (message) => {
      if (display) display.addEvent(message);
      else console.log(message);
    };

    if (mergeable.length > 0) {
      if (typeof display?.setRunPhase === "function") {
        display.setRunPhase(`Auto-merging ${mergeable.length} completed work item branch${mergeable.length === 1 ? "" : "es"}`);
      }
      say(`  ${C.cyan}[git]${C.reset} Auto-merging ${mergeable.length} completed work item branch(es) at ${reason}`);
    }

    let mergedCount = 0;
    let pendingMergeable = mergeable;
    let mergePass = 0;
    while (pendingMergeable.length > 0) {
      mergePass += 1;
      let mergedThisPass = 0;
      const deferredIds = new Set();
      for (const wi of pendingMergeable) {
        const targetBranch = currentTargetBranch();
        const branchName = wi.branch_name;
        if (typeof display?.setRunPhase === "function") {
          display.setRunPhase(`Merging WI#${wi.id} into ${targetBranch}`);
        }
        const result = await gitMergeToTargetAsync(branchName, projectDir, {
          wiId: wi.id,
          onPhase(event = {}) {
            if (event.phase === "atlas-indexing") {
              if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS indexing WI#${wi.id}`);
              if (!display) say(`  ${C.cyan}[git]${C.reset} WI#${wi.id}: ATLAS post-commit indexing`);
            } else if (event.phase === "retry") {
              if (typeof display?.setRunPhase === "function") display.setRunPhase(`Retrying merge for WI#${wi.id}`);
              say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: retrying merge`);
            } else if (event.phase === "merge") {
              if (typeof display?.setRunPhase === "function") display.setRunPhase(`Merging WI#${wi.id} into ${targetBranch}`);
            }
          },
        });
        if (result.ok) {
          const mergeHash = result.mergeHash || "(unknown)";
          const autoApproveReason = shouldAutoApproveIterativeWorkItem(wi) && !autoMerge ? "iterate_auto_merge" : "auto_merge";
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: "Auto-approved for end-of-run merge",
            event_json: JSON.stringify({ approval_type: autoApproveReason, reason }),
          });
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Auto-merged ${branchName} into ${targetBranch} at ${mergeHash}`,
            event_json: JSON.stringify({ branch: branchName, merge_hash: mergeHash, target_branch: targetBranch, reason }),
          });
          setMergeState(wi.id, "merged");
          let atlasFollowupOk = true;
          try {
            await refreshAtlasMainAfterMerge({
              wiId: wi.id,
              branchName,
              targetBranch,
              mergeHash,
              onPhase: (event = {}) => {
                if (event.phase === "atlas-indexing") {
                  if (typeof display?.setRunPhase === "function") display.setRunPhase(`ATLAS finalizing WI#${wi.id}`);
                  if (!display) say(`  ${C.cyan}[git]${C.reset} WI#${wi.id}: ATLAS final merge indexing`);
                }
              },
              source: "auto_merge",
            });
          } catch (err) {
            atlasFollowupOk = false;
            say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ATLAS finalization failed after merge: ${err?.message || err}`);
          }
          let cleanupOk = false;
          try {
            cleanupOk = await cleanupWiBranchAsync(wi);
          } catch (err) {
            say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: branch cleanup failed after merge: ${err?.message || err}`);
          }
          const postMergeSuffix = cleanupOk && atlasFollowupOk
            ? ""
            : ` ${C.yellow}(post-merge follow-up needs attention)${C.reset}`;
          say(`  ${C.green}[git]${C.reset} WI#${wi.id}: merged ${branchName} (${mergeHash.slice(0, 8)})${postMergeSuffix}`);
          if (typeof display?.setRunPhase === "function") {
            display.setRunPhase(`Merged WI#${wi.id}`);
          }
          mergedCount++;
          mergedThisPass++;
        } else if (result.deferred) {
          deferredIds.add(wi.id);
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_DEFERRED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: result.message,
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          say(`  ${C.yellow}[git]${C.reset} WI#${wi.id}: ${result.message}`);
        } else {
          setMergeState(wi.id, "merge_failed");
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORK_ITEM_MERGE_FAILED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Auto-merge failed for ${branchName}: ${result.message}`,
            event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch, reason }),
          });
          // Jobs are done; the worktree is no longer useful. Snapshot any dirt and
          // remove the directory, but keep the branch so a manual retry is possible.
          await snapshotAndRemoveWorktreeOnlyAsync(wi, "merge-failed");
          say(`  ${C.red}[git]${C.reset} WI#${wi.id}: ${result.message}`);
        }
      }
      if (deferredIds.size === 0 || mergedThisPass === 0) break;
      pendingMergeable = listEndOfRunMergeableWorkItems()
        .filter((wi) => deferredIds.has(wi.id));
      if (pendingMergeable.length > 0) {
        say(`  ${C.cyan}[git]${C.reset} Retrying ${pendingMergeable.length} deferred work item merge(s) after upstream progress`);
      }
      if (mergePass >= mergeable.length + 1) break;
    }

    // End-of-wrap-up safety net: reap any worktrees for WIs that went terminal
    // during the run but weren't eligible for auto-merge (e.g. status=failed,
    // canceled, or complete-but-pending-review). Mirrors boot GC semantics —
    // snapshots dirty state before removing, preserves worktrees for WIs that
    // still hold a bench (active jobs or pending human input).
    if (runGc) {
      try {
        if (typeof display?.setRunPhase === "function") {
          display.setRunPhase(mergedCount > 0 ? "Checking merged worktrees" : "Checking completed worktrees");
        }
        await gcWorktreesAsync(projectDir, (msg) => say(`  ${C.dim}[gc]${C.reset} ${msg}`));
      } catch (err) {
        say(`  ${C.yellow}[gc]${C.reset} worktree sweep failed: ${err?.message || err}`);
      }
    }

    if (typeof display?.setRunPhase === "function") {
      display.setRunPhase(mergedCount > 0
        ? `${mergedCount} work item${mergedCount === 1 ? "" : "s"} merged; preparing push prompt`
        : "Wrap-up complete");
    }

    return mergedCount;
  }

  async function autoMergeCompletedWorkItems(args = {}) {
    const prior = autoMergeCompletedWorkItemsPromise;
    const queued = (prior || Promise.resolve())
      .catch(() => {})
      .then(() => autoMergeCompletedWorkItemsImpl(args).catch((err) => {
        // Auto-merge is best-effort run wrap-up. A native-git/heartbeat failure
        // here (e.g. resolveTargetBranch during the merge loop) must NOT escape
        // as an unhandledRejection — that exits the orchestrator and aborts the
        // whole wrap-up. Log and report zero merges; nothing already committed
        // is lost, and the WIs stay mergeable for the next wrap-up / review.
        try {
          console.log(`  ${C.yellow}[git]${C.reset} Auto-merge skipped (wrap-up error): ${err?.message || err}`);
        } catch { /* best effort: never let logging crash wrap-up */ }
        return 0;
      }));
    const tracked = queued.finally(() => {
      if (autoMergeCompletedWorkItemsPromise === tracked) {
        autoMergeCompletedWorkItemsPromise = null;
      }
    });
    autoMergeCompletedWorkItemsPromise = tracked;
    return queued;
  }

  return {
    auditWorktreeState,
    collectDirtyState,
    collectDirtyStateAsync,
    ensureCleanTargetBranch,
    ensureCleanTargetBranchAsync,
    guardStartupDirtyTree,
    guardStartupDirtyTreeAsync,
    guardStartupDirtyTreeInWorker,
    notifyDirtyState,
    offerPush,
    startupWorktreeCleanup,
    gitDiffStat,
    gitDiffStatAsync,
    gitMergeToTarget,
    gitMergeToTargetAsync,
    mergeIterativePassToTarget,
    gitBranchExists,
    gitWorktreePathsForBranch,
    gitWorktreeRemove,
    cleanupWiBranch,
    cleanupWiBranchAsync,
    snapshotAndRemoveWorktreeOnlyAsync,
    autoMergeCompletedWorkItems,
    hasAutoMergeableCompletedWorkItems,
    // Exposed for tests — internal helper that decides whether a git
    // porcelain line refers to a posse-runtime-managed file.
    _isRuntimePorcelainLine: isRuntimePorcelainLine,
    _sweepOrphanedInferTsconfig: sweepOrphanedInferTsconfig,
    _sweepOrphanedInferTsconfigAsync: sweepOrphanedInferTsconfigAsync,
    _currentTargetBranch: currentTargetBranch,
    _collectDirtyState: collectDirtyState,
    _collectPushOfferState: collectPushOfferState,
    _executePush: executePush,
    _snapshotAndRemoveWorktreeOnly: snapshotAndRemoveWorktreeOnly,
  };
}
