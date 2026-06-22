// lib/domains/git/classes/Repo.js
//
// Small value/service object around a git working directory. This is the first
// strangler step for moving worker git helpers behind an explicit domain API.

import { execFile as defaultExecFileAsync, execFileSync } from "node:child_process";
import path from "node:path";
import { AsyncGateBusyError, AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "../functions/native/invoke.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const GIT_READ_ONLY_COMMANDS = new Set([
  "blame",
  "cat-file",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);
const GIT_GLOBAL_FLAGS = new Set([
  "-p",
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
  "--paginate",
]);
const GIT_GLOBAL_OPTIONS_WITH_EQUALS = [
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--work-tree=",
];
const GIT_BRANCH_MUTATING_FLAGS = new Set([
  "-c",
  "-C",
  "-d",
  "-D",
  "-f",
  "-m",
  "-M",
  "--copy",
  "--create-reflog",
  "--delete",
  "--edit-description",
  "--force",
  "--move",
  "--no-create-reflog",
  "--no-track",
  "--set-upstream-to",
  "--track",
  "--unset-upstream",
]);
const GIT_BRANCH_READ_FLAGS = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "--all",
  "--color",
  "--column",
  "--contains",
  "--format",
  "--ignore-case",
  "--list",
  "--merged",
  "--no-color",
  "--no-column",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--remotes",
  "--show-current",
  "--sort",
  "--verbose",
]);
const GIT_BRANCH_READ_OPTIONS_WITH_VALUE = new Set([
  "--color",
  "--column",
  "--contains",
  "--format",
  "--merged",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--sort",
]);
const GIT_CONFIG_READ_FLAGS = new Set([
  "-l",
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
]);
const GIT_CONFIG_WRITE_FLAGS = new Set([
  "--add",
  "--remove-section",
  "--rename-section",
  "--replace-all",
  "--set",
  "--unset",
  "--unset-all",
]);
const GIT_CONFIG_OPTIONS_WITH_VALUE = new Set([
  "--blob",
  "--file",
  "--type",
]);

function normalizeGitArgs(cmdOrArgs) {
  if (Array.isArray(cmdOrArgs)) return cmdOrArgs.map((arg) => String(arg));
  // Reject string-form input. Whitespace-splitting a freeform string is a
  // foot-gun: any argument containing a space (a path, branch name,
  // template, commit message) would silently split into multiple argv
  // entries. All call sites pass argv arrays — see P2.6 in
  // docs/dev/ for the migration. Throw with a clear hint so a future
  // contributor cannot reintroduce the pattern.
  throw new TypeError(
    `gitExec/gitExecAsync require an argv array, got ${typeof cmdOrArgs}: ` +
    `${JSON.stringify(cmdOrArgs)}. Drop the leading "git" and pass each ` +
    `argument as a separate array element, e.g. ["rev-parse", "--show-toplevel"].`,
  );
}

function gitGateKey(cwd) {
  const normalized = path.resolve(String(cwd || process.cwd())).replace(/\\/g, "/");
  return `git:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

class GitResourceGate extends AsyncResourceGate {
  normalizeKey(cwd) {
    return gitGateKey(cwd);
  }
}

const GIT_GATE = new GitResourceGate({ name: "git protected asset" });

function gitCommandArgs(args = []) {
  const argv = args.map((arg) => String(arg));
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    if (arg === "--") return argv.slice(index + 1);
    if (!arg.startsWith("-")) break;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-c") && arg.length > 2) {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_EQUALS.some((prefix) => arg.startsWith(prefix))) {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function optionName(arg) {
  const text = String(arg || "");
  const eq = text.indexOf("=");
  return eq === -1 ? text : text.slice(0, eq);
}

function branchOptionTakesSeparateValue(arg) {
  return GIT_BRANCH_READ_OPTIONS_WITH_VALUE.has(arg) && !String(arg).includes("=");
}

function isReadOnlyBranchArgs(args = []) {
  if (args.length === 0) return true;
  let sawReadIntent = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    const name = optionName(arg);
    if (GIT_BRANCH_MUTATING_FLAGS.has(name)) return false;
    if (GIT_BRANCH_READ_FLAGS.has(name)) {
      sawReadIntent = true;
      if (branchOptionTakesSeparateValue(name)) i += 1;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!sawReadIntent) return false;
  }
  return sawReadIntent;
}

function configOptionTakesSeparateValue(arg) {
  return GIT_CONFIG_OPTIONS_WITH_VALUE.has(arg) && !String(arg).includes("=");
}

function isReadOnlyConfigArgs(args = []) {
  let sawNonOptionBeforeReadAction = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    const name = optionName(arg);
    if (GIT_CONFIG_WRITE_FLAGS.has(name)) return false;
    if (GIT_CONFIG_READ_FLAGS.has(name)) return !sawNonOptionBeforeReadAction;
    if (configOptionTakesSeparateValue(name)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    sawNonOptionBeforeReadAction = true;
  }
  return false;
}

export function isGitReadOnlyArgs(args = []) {
  const command = gitCommandArgs(args);
  const cmd = String(command[0] || "");
  let result = false;
  if (cmd === "branch") result = isReadOnlyBranchArgs(command.slice(1));
  else if (cmd === "config") result = isReadOnlyConfigArgs(command.slice(1));
  else result = GIT_READ_ONLY_COMMANDS.has(cmd);
  return result;
}

function gitGateModeForArgs(gitArgs, gateMode) {
  return gateMode === "blocking" || gateMode === "non-blocking"
    ? gateMode
    : (isGitReadOnlyArgs(gitArgs) ? "non-blocking" : "blocking");
}

function gitGateLabel(gitArgs) {
  return `git ${gitArgs.slice(0, 3).join(" ") || "command"}`;
}

function gitGateStateForCwd(cwd) {
  const key = GIT_GATE.normalizeKey(cwd);
  return GIT_GATE.snapshot().keys.find((state) => state.key === key) || null;
}

function nativeAsyncOptions(options = {}) {
  return {
    ...(options.nativeParity || {}),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
}

function gitExecFailure(command, result) {
  const stderr = String(result?.stderr || "");
  const stdout = String(result?.stdout || "");
  const detail = (stderr || stdout || `git ${command.join(" ")} failed`).trim();
  const error = new Error(detail);
  error.code = result?.status ?? 1;
  error.status = result?.status ?? 1;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function gitNativeRead(cwd, gitArgs, options, run) {
  return GIT_GATE.read(cwd, run, { label: gitGateLabel(gitArgs) });
}

function assertSyncGitGateAvailable(cwd, mode, label) {
  const state = gitGateStateForCwd(cwd);
  if (!state) return;
  const activeReaders = Number(state.activeReaders) || 0;
  const activeWriter = Boolean(state.activeWriter);
  const pendingReaders = Number(state.pendingReaders) || 0;
  const pendingWriters = Number(state.pendingWriters) || 0;
  const conflict = mode === "blocking"
    ? activeWriter || activeReaders > 0 || pendingReaders > 0 || pendingWriters > 0
    : activeWriter || pendingWriters > 0;
  if (!conflict) return;
  const err = new AsyncGateBusyError(
    `${GIT_GATE.name} is busy; sync ${label} cannot safely bypass the gate`,
    { key: state.key, label },
  );
  err.code = "ASYNC_GATE_BUSY";
  err.mode = mode;
  err.activeReaders = activeReaders;
  err.activeWriter = activeWriter;
  err.pendingReaders = pendingReaders;
  err.pendingWriters = pendingWriters;
  throw err;
}

export class Repo {
  constructor(cwd, {
    execFile = execFileSync,
    execFileAsync = defaultExecFileAsync,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!cwd || typeof cwd !== "string") {
      throw new Error("Repo requires cwd");
    }
    if (typeof execFile !== "function") {
      throw new Error("Repo requires execFile function");
    }
    if (typeof execFileAsync !== "function") {
      throw new Error("Repo requires execFileAsync function");
    }

    this.cwd = path.resolve(cwd);
    this.execFile = execFile;
    this.execFileAsync = execFileAsync;
    this.timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  exec(cmdOrArgs, {
    cwd = this.cwd,
    trim = true,
    input = undefined,
    maxBuffer = 1024 * 1024 * 16,
    gate = true,
    gateMode = "auto",
  } = {}) {
    const gitArgs = normalizeGitArgs(cmdOrArgs);
    if (gate !== false) {
      const mode = gitGateModeForArgs(gitArgs, gateMode);
      assertSyncGitGateAvailable(cwd, mode, gitGateLabel(gitArgs));
    }
    const output = this.execFile("git", gitArgs, {
      cwd,
      encoding: "utf-8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: this.timeoutMs,
      maxBuffer,
    });
    return trim ? String(output).trim() : String(output);
  }

  execAsync(cmdOrArgs, {
    cwd = this.cwd,
    trim = true,
    input = undefined,
    signal = undefined,
    env = undefined,
    timeoutMs = this.timeoutMs,
    gate = true,
    gateMode = "auto",
    barrierKey = null,
    nativeParity = {},
  } = {}) {
    const gitArgs = normalizeGitArgs(cmdOrArgs);
    const readOnly = isGitReadOnlyArgs(gitArgs);
    const useNativeRead = readOnly && nativeParity?.disabled !== true;
    const maxCaptureBytes = 1024 * 1024 * 16;
    const runNativeRead = async () => {
      const result = await runGitNativeMethodAsync(
        "git.exec",
        { cwd, args: gitArgs, input: input ?? null, trim, maxCaptureBytes },
        { ...nativeParity, signal, timeoutMs },
      );
      if (!result?.ok) throw gitExecFailure(gitArgs, result);
      return String(result.stdout ?? "");
    };
    const runNodeGit = () => new Promise((resolve, reject) => {
      let child = null;
      try {
        const execOptions = {
          cwd,
          encoding: "utf-8",
          input,
          env,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: maxCaptureBytes,
        };
        if (signal) execOptions.signal = signal;
        child = this.execFileAsync("git", gitArgs, {
          ...execOptions,
        }, (error, stdout, stderr) => {
          if (error) {
            if (stdout != null && error.stdout == null) error.stdout = stdout;
            if (stderr != null && error.stderr == null) error.stderr = stderr;
            reject(error);
            return;
          }
          const result = trim ? String(stdout || "").trim() : String(stdout || "");
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
      if (signal?.aborted && child?.kill) {
        try { child.kill(); } catch { /* ignore */ }
      }
    });
    const run = useNativeRead ? runNativeRead : runNodeGit;
    if (gate === false) return run();
    const mode = gitGateModeForArgs(gitArgs, gateMode);
    const label = gitGateLabel(gitArgs);
    return mode === "blocking"
      ? GIT_GATE.write(cwd, run, { label, waitMs: timeoutMs, barrierKey })
      : GIT_GATE.read(cwd, run, { label });
  }

  currentHash(ref = "HEAD", nativeParity = {}) {
    return runGitNativeMethod("git.currentHash", { cwd: this.cwd, refName: ref }, nativeParity);
  }

  currentHashAsync(ref = "HEAD", options = {}) {
    return gitNativeRead(
      this.cwd,
      ["rev-parse", ref],
      options,
      () => runGitNativeMethodAsync(
        "git.currentHash",
        { cwd: this.cwd, refName: ref },
        nativeAsyncOptions(options),
      ),
    );
  }

  currentBranch(nativeParity = {}) {
    return runGitNativeMethod("git.currentBranch", { cwd: this.cwd }, nativeParity);
  }

  currentBranchAsync(options = {}) {
    return gitNativeRead(
      this.cwd,
      ["branch", "--show-current"],
      options,
      () => runGitNativeMethodAsync("git.currentBranch", { cwd: this.cwd }, nativeAsyncOptions(options)),
    );
  }

  statusPorcelain(args = [], nativeParity = {}) {
    return runGitNativeMethod("git.statusPorcelain", { cwd: this.cwd, args }, nativeParity);
  }

  statusPorcelainAsync(args = [], options = {}) {
    return gitNativeRead(
      this.cwd,
      ["status", "--porcelain", ...args],
      options,
      () => runGitNativeMethodAsync("git.statusPorcelain", { cwd: this.cwd, args }, nativeAsyncOptions(options)),
    );
  }

  hasChanges(args = [], nativeParity = {}) {
    return runGitNativeMethod("git.hasChanges", { cwd: this.cwd, args }, nativeParity);
  }

  async hasChangesAsync(args = [], options = {}) {
    return await gitNativeRead(
      this.cwd,
      ["status", "--porcelain", ...args],
      options,
      () => runGitNativeMethodAsync("git.hasChanges", { cwd: this.cwd, args }, nativeAsyncOptions(options)),
    );
  }

  branchExists(branchName, nativeParity = {}) {
    return runGitNativeMethod("git.localBranchExists", { cwd: this.cwd, branchName: String(branchName || "") }, nativeParity);
  }

  async branchExistsAsync(branchName, options = {}) {
    return await gitNativeRead(
      this.cwd,
      ["rev-parse", "--verify", branchName || ""],
      options,
      () => runGitNativeMethodAsync(
        "git.localBranchExists",
        { cwd: this.cwd, branchName: String(branchName || "") },
        nativeAsyncOptions(options),
      ),
    );
  }

  mergeBase(left = "HEAD", right = "HEAD", nativeParity = {}) {
    return runGitNativeMethod("git.mergeBase", { cwd: this.cwd, left, right }, nativeParity);
  }

  mergeBaseAsync(left = "HEAD", right = "HEAD", options = {}) {
    return gitNativeRead(
      this.cwd,
      ["merge-base", left, right],
      options,
      () => runGitNativeMethodAsync(
        "git.mergeBase",
        { cwd: this.cwd, left, right },
        nativeAsyncOptions(options),
      ),
    );
  }

  isAncestor(ancestor, descendant, nativeParity = {}) {
    return runGitNativeMethod("git.isAncestor", { cwd: this.cwd, ancestor, descendant }, nativeParity);
  }

  async isAncestorAsync(ancestor, descendant, options = {}) {
    return await gitNativeRead(
      this.cwd,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      options,
      () => runGitNativeMethodAsync(
        "git.isAncestor",
        { cwd: this.cwd, ancestor, descendant },
        nativeAsyncOptions(options),
      ),
    );
  }

  worktree(args = []) {
    return this.exec(["worktree", ...args]);
  }

  worktreeAsync(args = [], options = {}) {
    return this.execAsync(["worktree", ...args], options);
  }

  withCwd(cwd) {
    return new Repo(cwd, {
      execFile: this.execFile,
      execFileAsync: this.execFileAsync,
      timeoutMs: this.timeoutMs,
    });
  }
}

export function gitGateReleaseKey(cwd) {
  return GIT_GATE.blockingReleaseKey(cwd);
}

export function waitForGitGateRelease(cwdOrBarrierKey, opts = {}) {
  return GIT_GATE.awaitBarrier(cwdOrBarrierKey, opts);
}

export function gitGateSnapshot() {
  return GIT_GATE.snapshot();
}
