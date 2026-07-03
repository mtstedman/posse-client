// lib/domains/git/classes/Repo.js
//
// Small value/service object around a git working directory. This is the first
// strangler step for moving worker git helpers behind an explicit domain API.

import path from "node:path";
import { AsyncGateBusyError, AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { nativeAsyncOptions, runGitNativeMethod, runGitNativeMethodAsync } from "../functions/native/invoke.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const GIT_READ_ONLY_COMMANDS = new Set([
  "blame",
  "cat-file",
  "check-ignore",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);
// Commands whose mutability depends on the subcommand. The empty string is
// the bare-command form (e.g. `git remote` lists, `git stash` pushes).
const GIT_SUBCOMMAND_READ_ONLY = new Map([
  ["notes", new Set(["", "list", "show"])],
  ["remote", new Set(["", "show", "get-url"])],
  ["stash", new Set(["list", "show"])],
  ["worktree", new Set(["list"])],
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

function isReadOnlySubcommandArgs(cmd, args = []) {
  const readOnlySubcommands = GIT_SUBCOMMAND_READ_ONLY.get(cmd);
  if (!readOnlySubcommands) return false;
  let subcommand = "";
  for (const raw of args) {
    const arg = String(raw || "");
    if (!arg || arg.startsWith("-")) continue;
    subcommand = arg;
    break;
  }
  return readOnlySubcommands.has(subcommand);
}

export function isGitReadOnlyArgs(args = []) {
  const command = gitCommandArgs(args);
  const cmd = String(command[0] || "");
  let result = false;
  if (cmd === "branch") result = isReadOnlyBranchArgs(command.slice(1));
  else if (cmd === "config") result = isReadOnlyConfigArgs(command.slice(1));
  else if (GIT_SUBCOMMAND_READ_ONLY.has(cmd)) result = isReadOnlySubcommandArgs(cmd, command.slice(1));
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

function gitExecFailure(command, result, { base64Stdout = false } = {}) {
  const stderr = String(result?.stderr || "");
  let stdout = String(result?.stdout || "");
  if (base64Stdout && stdout) {
    try { stdout = Buffer.from(stdout.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { /* keep raw */ }
  }
  const detail = (stderr || stdout || `git ${command.join(" ")} failed`).trim();
  const error = new Error(detail);
  error.code = result?.status ?? 1;
  error.status = result?.status ?? 1;
  error.stdout = stdout;
  error.stderr = stderr;
  // Marks "git itself ran and exited non-zero" — absent on gate-busy,
  // native-unavailable, and transport errors. See isGitCommandFailure.
  error.gitCommandFailed = true;
  return error;
}

/**
 * True when the error came from git running and exiting non-zero (the
 * pre-cutover child_process failure class). False for infrastructure
 * failures the native route introduced: sync gate busy (ASYNC_GATE_BUSY),
 * native binary unavailable (GIT_NATIVE_UNAVAILABLE), heartbeat/transport
 * errors. Callers whose catch blocks encode "git said no" semantics
 * (exit-code probes, fail-open guards) must not swallow the latter class.
 */
export function isGitCommandFailure(err) {
  return err?.gitCommandFailed === true;
}

function decodeNativeBase64Stdout(text, command) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    const error = new Error(
      `git ${command.join(" ")}: native git.exec returned non-base64 stdout for outputEncoding=base64; ` +
      "the posse-git binary on disk is likely stale (pre-outputEncoding protocol)",
    );
    error.code = "GIT_NATIVE_PROTOCOL_SKEW";
    throw error;
  }
  return Buffer.from(compact, "base64");
}

// Base64 inflates stdout by 4/3 and the JSON envelope adds framing; size the
// transport capture so payloads near maxCaptureBytes are not truncated at the
// spawn boundary (NativeBinary otherwise pins its default cap).
function envelopeMaxBufferFor(maxCaptureBytes) {
  return Math.ceil(maxCaptureBytes * 4 / 3) + 1024 * 1024;
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!cwd || typeof cwd !== "string") {
      throw new Error("Repo requires cwd");
    }

    this.cwd = path.resolve(cwd);
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
    timeoutMs = this.timeoutMs,
    nativeParity = {},
    encoding = "utf8",
  } = {}) {
    const gitArgs = normalizeGitArgs(cmdOrArgs);
    const wantBuffer = encoding === "buffer";
    if (gate !== false) {
      const mode = gitGateModeForArgs(gitArgs, gateMode);
      assertSyncGitGateAvailable(cwd, mode, gitGateLabel(gitArgs));
    }
    const result = runGitNativeMethod(
      "git.exec",
      {
        cwd,
        args: gitArgs,
        input: input ?? null,
        trim: wantBuffer ? false : trim,
        maxCaptureBytes: maxBuffer,
        timeoutMs,
        ...(wantBuffer ? { outputEncoding: "base64" } : {}),
      },
      { ...nativeParity, timeoutMs, maxBuffer: envelopeMaxBufferFor(maxBuffer) },
    );
    if (!result?.ok) throw gitExecFailure(gitArgs, result, { base64Stdout: wantBuffer });
    return wantBuffer
      ? decodeNativeBase64Stdout(result.stdout, gitArgs)
      : String(result.stdout ?? "");
  }

  execAsync(cmdOrArgs, {
    cwd = this.cwd,
    trim = true,
    input = undefined,
    signal = undefined,
    timeoutMs = this.timeoutMs,
    gate = true,
    gateMode = "auto",
    barrierKey = null,
    nativeParity = {},
    maxBuffer = 1024 * 1024 * 16,
    encoding = "utf8",
  } = {}) {
    const gitArgs = normalizeGitArgs(cmdOrArgs);
    const wantBuffer = encoding === "buffer";
    const runNativeGit = async () => {
      const result = await runGitNativeMethodAsync(
        "git.exec",
        {
          cwd,
          args: gitArgs,
          input: input ?? null,
          trim: wantBuffer ? false : trim,
          maxCaptureBytes: maxBuffer,
          timeoutMs,
          ...(wantBuffer ? { outputEncoding: "base64" } : {}),
        },
        { ...nativeParity, signal, timeoutMs, maxBuffer: envelopeMaxBufferFor(maxBuffer) },
      );
      if (!result?.ok) throw gitExecFailure(gitArgs, result, { base64Stdout: wantBuffer });
      return wantBuffer
        ? decodeNativeBase64Stdout(result.stdout, gitArgs)
        : String(result.stdout ?? "");
    };
    if (gate === false) return runNativeGit();
    const mode = gitGateModeForArgs(gitArgs, gateMode);
    const label = gitGateLabel(gitArgs);
    return mode === "blocking"
      ? GIT_GATE.write(cwd, runNativeGit, { label, waitMs: timeoutMs, barrierKey })
      : GIT_GATE.read(cwd, runNativeGit, { label });
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

  currentBranchAsync(options = {}) {
    return gitNativeRead(
      this.cwd,
      ["branch", "--show-current"],
      options,
      () => runGitNativeMethodAsync("git.currentBranch", { cwd: this.cwd }, nativeAsyncOptions(options)),
    );
  }

  statusPorcelainAsync(args = [], options = {}) {
    return gitNativeRead(
      this.cwd,
      ["status", "--porcelain", ...args],
      options,
      () => runGitNativeMethodAsync("git.statusPorcelain", { cwd: this.cwd, args }, nativeAsyncOptions(options)),
    );
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

  worktreeAsync(args = [], options = {}) {
    return this.execAsync(["worktree", ...args], options);
  }

  withCwd(cwd) {
    return new Repo(cwd, {
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
