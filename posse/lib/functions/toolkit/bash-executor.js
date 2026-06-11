// The `bash` tool used by the worker. Wraps spawnSync (preferred —
// argv-form, no shell injection surface) with an execSync fallback
// for commands that genuinely need shell features (pipes,
// redirection, &&) or fall through ENOENT on Windows where PATH
// resolution behaves differently than on POSIX. MutationPolicy gates
// every invocation against the job's allowed scope before the
// process is spawned.

import { execSync, spawnSync } from "child_process";
import { MutationPolicy } from "../../shared/scope/classes/MutationPolicy.js";

const SHELL_OPERATOR_RE = /[;&|<>]/;
const SENSITIVE_SUBPROCESS_ENV_KEY_RE = /api[_-]?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|^posse_key$/i;

function scrubBashSubprocessEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (SENSITIVE_SUBPROCESS_ENV_KEY_RE.test(String(key || ""))) continue;
    env[key] = value;
  }
  return env;
}

function parseCommandLine(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    // Backslash only escapes characters this grammar treats specially
    // (quotes, whitespace, backslash); otherwise it is a literal so
    // Windows paths like src\foo.js survive tokenization intact.
    if (ch === "\\" && quote !== "'") {
      const next = command[i + 1];
      const escapable = quote === '"'
        ? next === '"' || next === "\\"
        : next === "'" || next === '"' || next === "\\" || (next !== undefined && /\s/.test(next));
      if (escapable) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function canUseArgvExecution(command) {
  return !SHELL_OPERATOR_RE.test(command);
}

function isMissingExecutableOnWindows(platform, error) {
  return platform === "win32" && error?.code === "ENOENT";
}

function execBashWithShell(command, { cwd, timeout, maxBuffer, env, execSyncImpl }) {
  return execSyncImpl(command, {
    cwd,
    env,
    encoding: "utf-8",
    timeout,
    maxBuffer,
    shell: true,
  });
}

function execBashCommand(command, {
  cwd,
  timeout,
  maxBuffer,
  env = scrubBashSubprocessEnv(),
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  execSyncImpl = execSync,
}) {
  if (canUseArgvExecution(command)) {
    const tokens = parseCommandLine(command);
    if (tokens?.length > 0) {
      const result = spawnSyncImpl(tokens[0], tokens.slice(1), {
        cwd,
        env,
        encoding: "utf-8",
        timeout,
        maxBuffer,
        shell: false,
        windowsHide: true,
      });
      if (result.error) {
        if (isMissingExecutableOnWindows(platform, result.error)) {
          return execBashWithShell(command, { cwd, timeout, maxBuffer, env, execSyncImpl });
        }
        const err = result.error;
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        err.status = result.status;
        throw err;
      }
      if (result.status !== 0) {
        const err = new Error(`Command exited with code ${result.status}`);
        err.status = result.status;
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        throw err;
      }
      return result.stdout || "";
    }
  }

  return execBashWithShell(command, { cwd, timeout, maxBuffer, env, execSyncImpl });
}

export function createBashExecutor({
  env = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  execSyncImpl = execSync,
} = {}) {
  return function execBash(args, cwd) {
    const cmd = args.command;
    const auth = new MutationPolicy({ cwd }).authorizeBash(cmd);
    if (!auth.ok) return auth.error;
    const timeout = Math.min(args.timeout || 60000, 120000);
    const maxBuffer = 1024 * 1024;
    try {
      const result = execBashCommand(cmd, {
        cwd,
        timeout,
        maxBuffer,
        env: scrubBashSubprocessEnv(env),
        platform,
        spawnSyncImpl,
        execSyncImpl,
      });
      const output = result.trim();
      return output.length > 50000
        ? `${output.slice(0, 50000)}\n... (output truncated at 50 KB)`
        : (output || "(no output)");
    } catch (err) {
      if (err.killed || err.code === "ETIMEDOUT") {
        return `Error: Command timed out after ${timeout / 1000}s and was killed.`;
      }
      const stdout = err.stdout ? err.stdout.toString().trim() : "";
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      return `Exit code: ${err.status || 1}\n${stdout}\n${stderr}`.trim();
    }
  };
}

// Exported only so callers (and tests) can use the same argv/shell
// fall-through logic without going through the MutationPolicy guard.
export {
  parseCommandLine,
  canUseArgvExecution,
  isMissingExecutableOnWindows,
  scrubBashSubprocessEnv,
  execBashWithShell,
  execBashCommand,
};
