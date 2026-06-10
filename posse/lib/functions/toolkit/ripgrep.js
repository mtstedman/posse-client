// ripgrep invocation + glob-to-regex translation + .gitignore
// plumbing for the search_files tool. The actual rg spawn happens in
// createDeterministicToolkit; this module owns the supporting
// transforms.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SEARCH_BINARY_SNIFF_BYTES = 8 * 1024;

export function escapeRegexLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeRelPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function findBraceClose(pattern, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(content) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") {
      current += ch;
      if (i + 1 < content.length) {
        current += content[i + 1];
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function globPatternToRegexSource(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (i + 1 < pattern.length) {
        out += escapeRegexLiteral(pattern[i + 1]);
        i++;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          out += "(?:.*/)?";
          i++;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "{") {
      const endIdx = findBraceClose(pattern, i);
      if (endIdx > i + 1) {
        const content = pattern.slice(i + 1, endIdx);
        const alts = splitBraceAlternatives(content);
        if (alts.length > 1) {
          out += `(?:${alts.map((alt) => globPatternToRegexSource(alt)).join("|")})`;
          i = endIdx;
          continue;
        }
      }
      out += "\\{";
      continue;
    }
    if (ch === "}") {
      out += "\\}";
      continue;
    }
    out += escapeRegexLiteral(ch);
  }
  return out;
}

export function globToRegex(pattern) {
  return new RegExp(`^${globPatternToRegexSource(String(pattern || ""))}$`);
}

export function resolveRipgrepCommand() {
  return "rg";
}

export function formatRipgrepRequirementError(command, error) {
  const code = error?.code || "unknown";
  if (code === "ENOENT") {
    return `Error: search_files requires ripgrep (rg), but "${command}" was not found. Install ripgrep and ensure it is available on PATH.`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Error: search_files requires executable ripgrep (rg), but "${command}" could not be run (${code}). Fix permissions or ensure rg on PATH is executable.`;
  }
  return `Error: search_files requires ripgrep (rg), but "${command}" failed to start (${error?.message || code}). Install ripgrep and ensure it is available on PATH.`;
}

export function compactRipgrepStderr(stderr) {
  return String(stderr || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ");
}

export function normalizedGlob(value) {
  return normalizeRelPath(String(value || "").trim());
}

export function isWorkspaceRootIgnoredByGit(cwd) {
  try {
    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (rootResult.status !== 0) return false;
    const repoRoot = String(rootResult.stdout || "").trim();
    if (!repoRoot) return false;
    const rel = normalizeRelPath(path.relative(repoRoot, path.resolve(cwd)));
    if (!rel || rel === ".") return false;
    const ignoredResult = spawnSync("git", ["check-ignore", "-q", "--", rel], {
      cwd: repoRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    return ignoredResult.status === 0;
  } catch {
    return false;
  }
}

export function makeGitIgnoreChecker(cwd) {
  if (isWorkspaceRootIgnoredByGit(cwd)) return () => false;
  const cache = new Map();
  return function isGitIgnored(absPath) {
    const rel = normalizeRelPath(path.relative(cwd, absPath));
    if (!rel || rel === ".") return false;
    if (cache.has(rel)) return cache.get(rel);
    let ignored = false;
    try {
      const result = spawnSync("git", ["check-ignore", "-q", "--", rel], {
        cwd,
        stdio: "ignore",
        windowsHide: true,
      });
      ignored = result.status === 0;
    } catch {
      ignored = false;
    }
    cache.set(rel, ignored);
    return ignored;
  };
}

export function addRipgrepSkipGlobs(rgArgs, skipDirs) {
  for (const dir of skipDirs || []) {
    const normalized = normalizedGlob(dir).replace(/^\/+|\/+$/g, "");
    if (!normalized) continue;
    rgArgs.push("--glob", `!${normalized}/**`);
    rgArgs.push("--glob", `!**/${normalized}/**`);
  }
  rgArgs.push("--glob", "!.env*");
  rgArgs.push("--glob", "!**/.env*");
}

export function addAgentHiddenRipgrepGlobs(rgArgs) {
  rgArgs.push("--glob", "!config/**");
  rgArgs.push("--glob", "!.gitignore");
  rgArgs.push("--glob", "!**/.gitignore");
}

function firstMatchedLine(text) {
  return String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/)[0] ?? "";
}

function readLinesForContext(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    cache.set(filePath, lines);
    return lines;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}

export function shouldSkipRipgrepMatchedFile(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  let skip = false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > SEARCH_MAX_FILE_BYTES) {
      skip = true;
    } else {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(SEARCH_BINARY_SNIFF_BYTES, stat.size));
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        skip = buf.subarray(0, read).indexOf(0) !== -1;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    skip = true;
  }
  cache.set(filePath, skip);
  return skip;
}

export function parseRipgrepJsonMatches(stdout, rootPath, outputMode, beforeContext, afterContext, { isSensitivePath = () => false } = {}) {
  const filesWithMatches = new Set();
  const fileMatchCounts = new Map();
  const contentRows = [];
  const lineCache = new Map();
  const skipCache = new Map();
  const needsContext = beforeContext > 0 || afterContext > 0;

  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match") continue;
    const data = event.data || {};
    const rawPath = data.path?.text;
    if (!rawPath) continue;

    const filePath = path.resolve(rootPath, rawPath);
    if (isSensitivePath(filePath)) continue;
    if (shouldSkipRipgrepMatchedFile(filePath, skipCache)) continue;

    const lineNo = Math.max(1, Number(data.line_number) || 1);
    const submatches = Array.isArray(data.submatches) ? data.submatches : [];
    const matchCount = Math.max(1, submatches.length);

    filesWithMatches.add(filePath);
    fileMatchCounts.set(filePath, (fileMatchCounts.get(filePath) || 0) + matchCount);

    if (outputMode !== "content") continue;

    const before = [];
    const after = [];
    if (needsContext) {
      const lines = readLinesForContext(filePath, lineCache);
      if (lines) {
        const idx = Math.max(0, lineNo - 1);
        for (let i = Math.max(0, idx - beforeContext); i < idx; i++) {
          before.push({ line: i + 1, text: lines[i] ?? "" });
        }
        for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + afterContext); i++) {
          after.push({ line: i + 1, text: lines[i] ?? "" });
        }
      }
    }

    contentRows.push({
      file: filePath,
      line: lineNo,
      text: firstMatchedLine(data.lines?.text),
      before,
      after,
    });
  }

  return { filesWithMatches, fileMatchCounts, contentRows };
}
