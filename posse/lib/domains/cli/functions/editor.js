import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

function shellWords(value) {
  const input = String(value || "");
  const words = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) words.push(current);
  return words;
}

export function parseEditorCommand(value) {
  const parts = shellWords(value);
  return { cmd: parts[0] || "", args: parts.slice(1) };
}

function pathKey(value, pathApi = path) {
  return pathApi.normalize(String(value || "")).toLowerCase();
}

function uniqueExisting(candidates, existsSyncFn = fs.existsSync, pathApi = path) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = pathKey(candidate, pathApi);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSyncFn(candidate)) out.push(candidate);
  }
  return out;
}

function codeExeFromWindowsShim(shimPath) {
  const p = path.win32;
  const clean = String(shimPath || "").trim().replace(/^"|"$/g, "");
  const base = p.basename(clean).toLowerCase();
  if (base === "code.exe" || base === "code - insiders.exe") return clean;
  if (base === "code" || base === "code.cmd") {
    const installRoot = p.resolve(p.dirname(clean), "..");
    return p.join(installRoot, "Code.exe");
  }
  return null;
}

function hasWindowsPathShape(value) {
  return /^[a-z]:/i.test(value) || /[\\/]/.test(value);
}

function isWindowsCodeCommand(command) {
  const base = path.win32.basename(String(command || "").trim().replace(/^"|"$/g, "")).toLowerCase();
  return base === "code" || base === "code.cmd" || base === "code.exe" || base === "code - insiders.exe";
}

function withWaitArg(args) {
  return args.some((arg) => arg === "-w" || arg === "--wait")
    ? args
    : ["--wait", ...args];
}

function whereLines(command, execFileSyncFn) {
  try {
    const output = execFileSyncFn("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function findWindowsVsCodeExecutable({
  env = process.env,
  execFileSyncFn = execFileSync,
  existsSyncFn = fs.existsSync,
} = {}) {
  const p = path.win32;
  const candidates = [];
  const add = (value) => { if (value) candidates.push(value); };

  add(env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"));
  add(env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"));
  add(env.ProgramFiles && p.join(env.ProgramFiles, "Microsoft VS Code", "Code.exe"));
  add(env.PROGRAMFILES && p.join(env.PROGRAMFILES, "Microsoft VS Code", "Code.exe"));
  add(env["ProgramFiles(x86)"] && p.join(env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"));
  add(env["PROGRAMFILES(X86)"] && p.join(env["PROGRAMFILES(X86)"], "Microsoft VS Code", "Code.exe"));

  for (const entry of [...whereLines("code", execFileSyncFn), ...whereLines("code.cmd", execFileSyncFn), ...whereLines("Code.exe", execFileSyncFn)]) {
    add(codeExeFromWindowsShim(entry));
  }

  return uniqueExisting(candidates, existsSyncFn, p)[0] || "";
}

export function resolveEditorCommand({
  env = process.env,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  existsSyncFn = fs.existsSync,
} = {}) {
  const explicit = env.EDITOR || env.VISUAL;
  if (explicit) {
    if (platform === "win32") {
      const parsed = parseEditorCommand(explicit);
      if (isWindowsCodeCommand(parsed.cmd)) {
        const explicitCodeExe = hasWindowsPathShape(parsed.cmd)
          ? codeExeFromWindowsShim(parsed.cmd)
          : "";
        const codeExe = (explicitCodeExe && existsSyncFn(explicitCodeExe))
          ? explicitCodeExe
          : findWindowsVsCodeExecutable({ env, execFileSyncFn, existsSyncFn });
        if (codeExe) return [`"${codeExe}"`, ...withWaitArg(parsed.args)].join(" ");
      }
    }
    return explicit;
  }

  if (platform === "win32") {
    const codeExe = findWindowsVsCodeExecutable({ env, execFileSyncFn, existsSyncFn });
    if (codeExe) return `"${codeExe}" --wait`;
    return "notepad";
  }

  try {
    execFileSyncFn("which", ["code"], { stdio: "ignore" });
    return "code --wait";
  } catch {
    return "nano";
  }
}

export function editorCommandLabel(commandValue) {
  const { cmd } = parseEditorCommand(commandValue);
  if (!cmd) return "editor";
  const base = path.basename(cmd) === cmd ? path.win32.basename(cmd) : path.basename(cmd);
  return base.replace(/\.(exe|cmd|bat)$/i, "") || cmd;
}
