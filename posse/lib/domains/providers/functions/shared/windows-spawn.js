// lib/domains/providers/functions/shared/windows-spawn.js
//
// Shared Windows process-spawn helpers used by the Claude and Codex CLI
// providers. These build a cmd.exe command line for non-.exe launchers on
// Windows and terminate spawned process trees cross-platform.

import {
  terminateSpawnedProcessTree,
  trackSpawnedProcess as trackSpawnedProcessLedger,
} from "../../../../shared/platform/functions/spawned-process.js";

const ownedProcessGroups = new WeakSet();

export function trackSpawnedProcess(proc, bin, context = {}) {
  if (context.processGroup === true && proc && typeof proc === "object") {
    ownedProcessGroups.add(proc);
    let cleaned = false;
    const cleanOwnedGroup = () => {
      if (cleaned) return;
      cleaned = true;
      // A provider can exit before an uncooperative descendant. Once the
      // provider itself is gone, no child in its owned group may outlive it.
      terminateSpawnedProcessTree(proc, {
        force: true,
        platform: process.platform,
        processGroup: true,
      });
    };
    try { proc.once?.("exit", cleanOwnedGroup); } catch {}
    try { proc.once?.("close", cleanOwnedGroup); } catch {}
  }
  return trackSpawnedProcessLedger(proc, bin, context);
}

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

export function terminateSpawnedProcess(proc, { force = false, platform = process.platform } = {}) {
  return terminateSpawnedProcessTree(proc, {
    force,
    platform,
    processGroup: platform !== "win32" && ownedProcessGroups.has(proc),
  });
}
