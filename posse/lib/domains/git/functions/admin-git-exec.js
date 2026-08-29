// Minimal direct system-Git adapter for operator/admin and self-update paths.
// Keep this module dependency-free so `posse update` can fast-forward and
// repair native npm addons before any SQLite-backed application graph loads.

import { execFile, execFileSync } from "node:child_process";

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
  env = undefined,
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
      env,
      stdio: ["pipe", "pipe", "pipe"],
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
  env = undefined,
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
      env,
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
