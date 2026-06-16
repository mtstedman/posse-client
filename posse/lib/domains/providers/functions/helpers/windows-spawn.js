// lib/domains/providers/functions/helpers/windows-spawn.js
//
// Shared Windows process-spawn helpers used by the Claude and Codex CLI
// providers. These build a cmd.exe command line for non-.exe launchers on
// Windows and terminate spawned process trees cross-platform.

import { spawn } from "child_process";

export function quoteWindowsArg(arg) {
  const value = String(arg == null ? "" : arg);
  // Quote on whitespace, quotes, OR cmd metacharacters. This builds a cmd.exe
  // /c command line (windowsVerbatimArguments:true), so an unquoted & | < > ^
  // ( ) would be interpreted by cmd and split/redirect the command. Double
  // quotes neutralize them; CommandLineToArgvW in the target strips the quotes.
  // (%VAR% still expands even when quoted — cmd has no reliable command-line
  // escape for it; .exe-preferred resolution keeps this route off the hot
  // path.) (B20)
  if (!/[\s"&|<>^()%]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function quoteWindowsCommand(command) {
  const value = String(command == null ? "" : command);
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function buildWindowsSpawn(command, args) {
  if (process.platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false };
  }
  if (/\.exe$/i.test(String(command || ""))) {
    return { command, args, windowsVerbatimArguments: false };
  }

  const cmdExe = process.env.ComSpec || "C:\\WINDOWS\\System32\\cmd.exe";
  const commandLine = [quoteWindowsCommand(command), ...args.map(quoteWindowsArg)].join(" ");
  return {
    command: cmdExe,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

export function terminateSpawnedProcess(proc, { force = false } = {}) {
  if (!proc || proc.exitCode != null || proc.killed) return;
  if (process.platform === "win32") {
    try {
      const taskkillArgs = ["/pid", String(proc.pid), "/T"];
      if (force) taskkillArgs.push("/F");
      const killer = spawn("taskkill", taskkillArgs, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref?.();
      return;
    } catch {
      // Fall through to proc.kill best-effort.
    }
  }
  try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
}
