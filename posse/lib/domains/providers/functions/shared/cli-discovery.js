import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const WINDOWS_COMMAND_EXTS = [".exe", ".cmd", ".bat", ".com", ""];

export function splitPathEntries(pathValue, delimiter = path.delimiter) {
  return String(pathValue || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pathApiForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pushUnique(list, value, { caseInsensitive = process.platform === "win32" } = {}) {
  const text = String(value || "").trim();
  if (!text) return;
  const normalized = caseInsensitive ? text.toLowerCase() : text;
  if (list.some((entry) => (caseInsensitive ? entry.toLowerCase() : entry) === normalized)) return;
  list.push(text);
}

function npmGlobalPrefix({ execFileSyncImpl = execFileSync } = {}) {
  try {
    return String(execFileSyncImpl("npm", ["prefix", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 2000,
    }) || "").trim();
  } catch {
    return "";
  }
}

export function commonCommandDirs({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  npmPrefix = undefined,
  execFileSyncImpl = execFileSync,
} = {}) {
  const dirs = [];
  const prefix = npmPrefix === undefined ? npmGlobalPrefix({ execFileSyncImpl }) : npmPrefix;
  const pathApi = pathApiForPlatform(platform);
  const caseInsensitive = platform === "win32";

  if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    pushUnique(dirs, prefix, { caseInsensitive });
    pushUnique(dirs, pathApi.join(programFiles, "nodejs"), { caseInsensitive });
    pushUnique(dirs, pathApi.join(programFilesX86, "nodejs"), { caseInsensitive });
    pushUnique(dirs, env.ProgramData ? pathApi.join(env.ProgramData, "npm") : "C:\\ProgramData\\npm", { caseInsensitive });
    pushUnique(dirs, env.APPDATA ? pathApi.join(env.APPDATA, "npm") : "", { caseInsensitive });
    pushUnique(dirs, env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, "Programs", "nodejs") : "", { caseInsensitive });
    pushUnique(dirs, env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps") : "", { caseInsensitive });
    return dirs;
  }

  pushUnique(dirs, prefix ? pathApi.join(prefix, "bin") : "", { caseInsensitive });
  pushUnique(dirs, prefix, { caseInsensitive });
  pushUnique(dirs, "/usr/local/bin", { caseInsensitive });
  pushUnique(dirs, "/opt/homebrew/bin", { caseInsensitive });
  pushUnique(dirs, "/usr/bin", { caseInsensitive });
  pushUnique(dirs, "/bin", { caseInsensitive });
  pushUnique(dirs, homeDir ? pathApi.join(homeDir, ".npm-global", "bin") : "", { caseInsensitive });
  pushUnique(dirs, homeDir ? pathApi.join(homeDir, ".local", "bin") : "", { caseInsensitive });
  return dirs;
}

function lookupCommandOutput(commandBase, { platform, execFileSyncImpl }) {
  try {
    const command = platform === "win32" ? "where.exe" : "which";
    const args = platform === "win32" ? [commandBase] : ["-a", commandBase];
    return String(execFileSyncImpl(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 2000,
    }) || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function discoverCommandCandidates(commandBase, {
  env = process.env,
  envPath = null,
  platform = process.platform,
  homeDir = os.homedir(),
  includePath = true,
  includeLookup = true,
  includeCommonDirs = true,
  extraDirs = [],
  extraPaths = [],
  protectedPath = null,
  existsSyncImpl = fs.existsSync,
  execFileSyncImpl = execFileSync,
  npmPrefix = undefined,
} = {}) {
  const candidates = [];
  const isProtected = typeof protectedPath === "function" ? protectedPath : () => false;
  const pathApi = pathApiForPlatform(platform);
  const caseInsensitive = platform === "win32";
  const addPath = (candidate) => {
    const text = String(candidate || "").trim();
    if (!text || isProtected(text)) return;
    try {
      if (!existsSyncImpl(text)) return;
    } catch {
      return;
    }
    pushUnique(candidates, text, { caseInsensitive });
  };
  const addDirCandidates = (dir) => {
    const baseDir = String(dir || "").trim();
    if (!baseDir) return;
    const exts = platform === "win32" ? WINDOWS_COMMAND_EXTS : [""];
    for (const ext of exts) addPath(pathApi.join(baseDir, `${commandBase}${ext}`));
  };

  for (const candidate of extraPaths) addPath(candidate);
  if (includePath) {
    for (const dir of splitPathEntries(envPath ?? env.PATH ?? env.Path ?? "", platform === "win32" ? ";" : path.delimiter)) {
      addDirCandidates(dir);
    }
  }
  if (includeCommonDirs) {
    for (const dir of commonCommandDirs({ env, homeDir, platform, npmPrefix, execFileSyncImpl })) addDirCandidates(dir);
  }
  for (const dir of extraDirs) addDirCandidates(dir);
  if (includeLookup) {
    for (const candidate of lookupCommandOutput(commandBase, { platform, execFileSyncImpl })) addPath(candidate);
  }
  return candidates;
}
