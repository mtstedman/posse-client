// The `bash` tool used by the worker. Wraps spawnSync (preferred -
// argv-form, no shell injection surface) with a shell fallback
// for commands that genuinely need shell features (pipes,
// redirection, &&) or fall through ENOENT on Windows where PATH
// resolution behaves differently than on POSIX. Windows fallback runs
// through PowerShell so provider-visible shell guidance and aliases like
// `cat`/`ls` match the runtime. MutationPolicy gates
// every invocation against the job's allowed scope before the
// process is spawned.

import { execFileSync, execSync, spawnSync } from "child_process";
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

function powershellEncodedCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function splitTopLevelOperator(command, operator) {
  const text = String(command || "");
  let quote = null;
  for (let i = 0; i <= text.length - operator.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (text.slice(i, i + operator.length) !== operator) continue;
    const left = text.slice(0, i).trim();
    const right = text.slice(i + operator.length).trim();
    if (!left || !right) return null;
    return [left, right];
  }
  return null;
}

function splitTopLevelPipes(command) {
  const text = String(command || "");
  const parts = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== "|") continue;
    if (text[i + 1] === "|") {
      i += 1;
      continue;
    }
    parts.push(text.slice(start, i).trim());
    start = i + 1;
  }
  parts.push(text.slice(start).trim());
  return parts.every(Boolean) ? parts : [text.trim()];
}

function powershellSingleQuoted(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function headCountFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "head") return null;
  if (tokens.length === 1) return 10;
  if (tokens[1] === "-n" && /^\d+$/.test(String(tokens[2] || ""))) return Number(tokens[2]);
  const compact = String(tokens[1] || "").match(/^-n?(\d+)$/);
  if (compact) return Number(compact[1]);
  return null;
}

function tailCountFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "tail") return null;
  if (tokens.length === 1) return 10;
  if (tokens[1] === "-n" && /^\d+$/.test(String(tokens[2] || ""))) return Number(tokens[2]);
  const compact = String(tokens[1] || "").match(/^-n?(\d+)$/);
  if (compact) return Number(compact[1]);
  return null;
}

function wcLineCountFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "wc") return null;
  return tokens.includes("-l") ? true : null;
}

function grepFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "grep") return null;
  let caseInsensitive = false;
  let pattern = null;
  const files = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-e" || token === "--regexp") {
      pattern = tokens[index + 1] || null;
      index += 1;
      continue;
    }
    if (token === "-i" || token === "--ignore-case") {
      caseInsensitive = true;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token)) {
      if (token.includes("i")) caseInsensitive = true;
      continue;
    }
    if (pattern == null) {
      pattern = token;
      continue;
    }
    files.push(token);
  }
  return pattern ? { pattern, caseInsensitive, files } : null;
}

function selectStringCommand({ pattern, caseInsensitive = false, files = [] } = {}) {
  const pathPart = files.length > 0
    ? ` -Path ${files.map(powershellSingleQuoted).join(", ")}`
    : "";
  const casePart = caseInsensitive ? "" : " -CaseSensitive";
  return `Select-String${pathPart} -Pattern ${powershellSingleQuoted(pattern)}${casePart}`;
}

function headFileFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "head") return null;
  let index = 1;
  if (tokens[index] === "-n") {
    index += 2;
  } else if (/^-n?\d+$/.test(String(tokens[index] || ""))) {
    index += 1;
  }
  return tokens[index] || null;
}

function tailFileFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens[0] !== "tail") return null;
  let index = 1;
  if (tokens[index] === "-n") {
    index += 2;
  } else if (/^-n?\d+$/.test(String(tokens[index] || ""))) {
    index += 1;
  }
  return tokens[index] || null;
}

function numberedContentCommand(file) {
  const literal = powershellSingleQuoted(file);
  return `& { $i = 0; Get-Content -LiteralPath ${literal} | ForEach-Object { $i++; "{0,6}\\t{1}" -f $i, $_ } }`;
}

function catFilesFromTokens(tokens) {
  if (!Array.isArray(tokens) || (tokens[0] !== "cat" && tokens[0] !== "type")) return null;
  if (tokens[1] === "-n") return null;
  if (tokens.slice(1).some((token) => /^(?:\||\|\||&&|;|>|>>|<|2>&1|\d?>&\d?)$/.test(String(token || "")))) {
    return null;
  }
  const files = tokens.slice(1).filter(Boolean);
  return files.length > 0 ? files : null;
}

function contentCommandForFiles(files = []) {
  return `Get-Content -LiteralPath ${files.map(powershellSingleQuoted).join(", ")}`;
}

function fileInfoCommand(file) {
  const literal = powershellSingleQuoted(file);
  return `& { $p = ${literal}; if (Test-Path -LiteralPath $p -PathType Container) { "{0}: directory" -f $p } elseif (Test-Path -LiteralPath $p -PathType Leaf) { $item = Get-Item -LiteralPath $p; "{0}: regular file, {1} bytes" -f $p, $item.Length } else { "file: cannot open ''{0}'' (No such file or directory)" -f $p; exit 1 } }`;
}

function normalizePipedWindowsCommand(command) {
  const parts = splitTopLevelPipes(command);
  if (parts.length < 2) return command;
  const lastTokens = parseCommandLine(parts[parts.length - 1]);
  const headCount = headCountFromTokens(lastTokens);
  if (headCount != null) {
    const prefix = parts.slice(0, -1).map(normalizeStandaloneWindowsCommand).join(" | ");
    return `${prefix} | Select-Object -First ${headCount}`;
  }
  const tailCount = tailCountFromTokens(lastTokens);
  if (tailCount != null) {
    const prefix = parts.slice(0, -1).map(normalizeStandaloneWindowsCommand).join(" | ");
    return `${prefix} | Select-Object -Last ${tailCount}`;
  }
  if (wcLineCountFromTokens(lastTokens)) {
    const prefix = parts.slice(0, -1).map(normalizeStandaloneWindowsCommand).join(" | ");
    return `(${prefix} | Measure-Object -Line).Lines`;
  }
  const grep = grepFromTokens(lastTokens);
  if (grep) {
    const prefix = parts.slice(0, -1).map(normalizeStandaloneWindowsCommand).join(" | ");
    return `${prefix} | ${selectStringCommand(grep)}`;
  }
  return parts.map(normalizeStandaloneWindowsCommand).join(" | ");
}

function normalizeStandaloneWindowsCommand(command) {
  const tokens = parseCommandLine(command);
  if (!tokens?.length) return command;
  if (tokens[0] === "wc" && tokens.includes("-l")) {
    const file = tokens.find((token, index) => index > 0 && token !== "-l");
    if (file) return `(Get-Content -LiteralPath ${powershellSingleQuoted(file)} | Measure-Object -Line).Lines`;
  }
  if (tokens[0] === "head") {
    const count = headCountFromTokens(tokens);
    const file = headFileFromTokens(tokens);
    if (count != null && file) {
      return `Get-Content -LiteralPath ${powershellSingleQuoted(file)} | Select-Object -First ${count}`;
    }
  }
  if (tokens[0] === "tail") {
    const count = tailCountFromTokens(tokens);
    const file = tailFileFromTokens(tokens);
    if (count != null && file) {
      return `Get-Content -LiteralPath ${powershellSingleQuoted(file)} | Select-Object -Last ${count}`;
    }
  }
  if ((tokens[0] === "cat" || tokens[0] === "type") && tokens[1] === "-n" && tokens[2]) {
    return numberedContentCommand(tokens[2]);
  }
  const catFiles = catFilesFromTokens(tokens);
  if (catFiles) return contentCommandForFiles(catFiles);
  if (tokens[0] === "file" && tokens.length === 2) {
    return fileInfoCommand(tokens[1]);
  }
  const grep = grepFromTokens(tokens);
  if (grep) return selectStringCommand(grep);
  return command;
}

function normalizeWindowsShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return text;
  const orSplit = splitTopLevelOperator(text, "||");
  if (orSplit) {
    return `& { ${normalizeWindowsShellCommand(orSplit[0])}; if (-not $?) { ${normalizeWindowsShellCommand(orSplit[1])} } }`;
  }
  const andSplit = splitTopLevelOperator(text, "&&");
  if (andSplit) {
    return `& { ${normalizeWindowsShellCommand(andSplit[0])}; if ($?) { ${normalizeWindowsShellCommand(andSplit[1])} } }`;
  }
  return normalizeStandaloneWindowsCommand(normalizePipedWindowsCommand(text));
}

function powershellFallbackCommand(command) {
  const normalized = normalizeWindowsShellCommand(command);
  if (!normalized) return normalized;
  return `$ProgressPreference = 'SilentlyContinue'; $InformationPreference = 'SilentlyContinue'; ${normalized}`;
}

function execBashWithShell(command, {
  cwd,
  timeout,
  maxBuffer,
  env,
  platform = process.platform,
  execSyncImpl,
  execFileSyncImpl,
}) {
  const shellBody = platform === "win32" ? powershellFallbackCommand(command) : command;
  if (platform === "win32") {
    return execFileSyncImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      powershellEncodedCommand(shellBody),
    ], {
      cwd,
      env,
      encoding: "utf-8",
      timeout,
      maxBuffer,
      windowsHide: true,
    });
  }
  return execSyncImpl(shellBody, {
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
  execFileSyncImpl = execFileSync,
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
          return execBashWithShell(command, { cwd, timeout, maxBuffer, env, platform, execSyncImpl, execFileSyncImpl });
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

  return execBashWithShell(command, { cwd, timeout, maxBuffer, env, platform, execSyncImpl, execFileSyncImpl });
}

export function createBashExecutor({
  env = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  execSyncImpl = execSync,
  execFileSyncImpl = execFileSync,
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
        execFileSyncImpl,
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
  powershellEncodedCommand,
  normalizeWindowsShellCommand,
  execBashWithShell,
  execBashCommand,
};
