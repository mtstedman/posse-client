import fs from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { isInsideRoot } from "./fs-safety.js";
import { getRuntimeRoot } from "./paths.js";

export const POSSE_RUNTIME_IGNORE_HEADER = "# Posse runtime (auto-added)";
const execFileAsync = promisify(execFile);

const RUNTIME_DB_GLOBS = [
  "*.db",
  "*.db-shm",
  "*.db-wal",
  "*.db-journal",
  "*.sqlite",
  "*.sqlite-shm",
  "*.sqlite-wal",
  "*.sqlite-journal",
  "*.sqlite3",
  "*.sqlite3-shm",
  "*.sqlite3-wal",
  "*.sqlite3-journal",
];

const GENERATED_CACHE_GLOBS = [
  "# Common generated test/runtime artifacts",
  "__pycache__/",
  "*.py[cod]",
  "*$py.class",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".coverage",
  ".coverage.*",
  "htmlcov/",
];

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function asDirectoryPattern(value) {
  const normalized = toPosix(value).replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized ? `${normalized}/` : null;
}

function relativeDirectoryPattern(anchorDir, targetDir) {
  const anchor = path.resolve(anchorDir);
  const target = path.resolve(targetDir);
  const rel = path.relative(anchor, target);
  if (!rel || rel === ".") return null;
  if (!isInsideRoot(target, anchor, { allowEqual: false, followSymlinks: false })) return null;
  return asDirectoryPattern(rel);
}

function appendMissingLines(filePath, entries) {
  const wanted = entries.filter(Boolean);
  if (wanted.length === 0) return { changed: false, missing: [] };

  let existing = "";
  try { existing = fs.readFileSync(filePath, "utf-8"); } catch { /* file may not exist yet */ }

  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = wanted.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return { changed: false, missing: [] };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(filePath, `${prefix}${missing.join("\n")}\n`, "utf-8");
  return { changed: true, missing };
}

async function appendMissingLinesAsync(filePath, entries) {
  const wanted = entries.filter(Boolean);
  if (wanted.length === 0) return { changed: false, missing: [] };

  let existing = "";
  try { existing = await fs.promises.readFile(filePath, "utf-8"); } catch { /* file may not exist yet */ }

  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = wanted.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) return { changed: false, missing: [] };

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.promises.appendFile(filePath, `${prefix}${missing.join("\n")}\n`, "utf-8");
  return { changed: true, missing };
}

export function buildPosseRuntimeIgnoreEntries(projectDir, {
  anchorDir = projectDir,
  includeHeader = true,
} = {}) {
  const projectRoot = path.resolve(projectDir || process.cwd());
  const anchor = path.resolve(anchorDir || projectRoot);
  const entries = [];
  if (includeHeader) entries.push(POSSE_RUNTIME_IGNORE_HEADER);

  const runtimeRoot = getRuntimeRoot(projectRoot, projectRoot);
  const directoryTargets = [
    path.join(projectRoot, ".posse"),
    runtimeRoot,
    path.join(projectRoot, ".posse-worktrees"),
    path.join(projectRoot, ".posse-test-suites"),
    // Legacy runtime locations used by older repos/runs. Keep ignoring them so
    // upgraded projects do not accidentally commit stale DBs or artifacts.
    path.join(projectRoot, "db"),
    path.join(projectRoot, "resources"),
    path.join(projectRoot, "logs"),
  ];

  for (const target of directoryTargets) {
    const rel = relativeDirectoryPattern(anchor, target);
    if (rel) entries.push(rel);
  }

  entries.push(...RUNTIME_DB_GLOBS);
  entries.push(...GENERATED_CACHE_GLOBS);
  return [...new Set(entries)];
}

export function ensurePosseRuntimeGitignore(projectDir, {
  updateManagedBlock = false,
} = {}) {
  const projectRoot = path.resolve(projectDir || process.cwd());
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (!updateManagedBlock) {
    try {
      const existing = fs.readFileSync(gitignorePath, "utf-8");
      const hasManagedHeader = existing
        .split(/\r?\n/)
        .some((line) => line.trim() === POSSE_RUNTIME_IGNORE_HEADER);
      if (hasManagedHeader) {
        return { changed: false, missing: [], skipped: "managed_block_present" };
      }
    } catch {
      // file may not exist yet; fall through and create managed entries once
    }
  }
  const entries = buildPosseRuntimeIgnoreEntries(projectRoot, { anchorDir: projectRoot });
  return appendMissingLines(gitignorePath, entries);
}

export async function ensurePosseRuntimeGitignoreAsync(projectDir, {
  updateManagedBlock = false,
} = {}) {
  const projectRoot = path.resolve(projectDir || process.cwd());
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (!updateManagedBlock) {
    try {
      const existing = await fs.promises.readFile(gitignorePath, "utf-8");
      const hasManagedHeader = existing
        .split(/\r?\n/)
        .some((line) => line.trim() === POSSE_RUNTIME_IGNORE_HEADER);
      if (hasManagedHeader) {
        return { changed: false, missing: [], skipped: "managed_block_present" };
      }
    } catch {
      // file may not exist yet; fall through and create managed entries once
    }
  }
  const entries = buildPosseRuntimeIgnoreEntries(projectRoot, { anchorDir: projectRoot });
  return await appendMissingLinesAsync(gitignorePath, entries);
}

function gitOutput(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

async function gitOutputAsync(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });
  return String(stdout || "").trim();
}

function fastInfoExcludePath(projectRoot) {
  // For a normal (non-worktree) repo the exclude file lives at a deterministic
  // path. Resolving it without spawning git saves two cold git invocations per
  // CLI call — a hot path that runs on every command.
  const gitPath = path.join(projectRoot, ".git");
  let stat;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (!stat.isDirectory()) return null;
  return path.join(gitPath, "info", "exclude");
}

async function fastInfoExcludePathAsync(projectRoot) {
  const gitPath = path.join(projectRoot, ".git");
  let stat;
  try { stat = await fs.promises.stat(gitPath); } catch { return null; }
  if (!stat.isDirectory()) return null;
  return path.join(gitPath, "info", "exclude");
}

function allEntriesPresent(excludeFile, entries) {
  let existing;
  try { existing = fs.readFileSync(excludeFile, "utf-8"); } catch { return false; }
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return entries.every((entry) => existingLines.has(entry));
}

async function allEntriesPresentAsync(excludeFile, entries) {
  let existing;
  try { existing = await fs.promises.readFile(excludeFile, "utf-8"); } catch { return false; }
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return entries.every((entry) => existingLines.has(entry));
}

export function ensurePosseGitInfoExclude(projectDir) {
  const projectRoot = path.resolve(projectDir || process.cwd());

  // Fast path: ordinary repo at projectRoot with all entries already written.
  // Skips the two git rev-parse subprocesses entirely on the steady-state path.
  const fastExclude = fastInfoExcludePath(projectRoot);
  if (fastExclude) {
    const fastEntries = buildPosseRuntimeIgnoreEntries(projectRoot, {
      anchorDir: projectRoot,
      includeHeader: false,
    });
    if (allEntriesPresent(fastExclude, fastEntries)) {
      return { changed: false, missing: [], skipped: "already_present" };
    }
  }

  try {
    const repoRoot = path.resolve(gitOutput(["rev-parse", "--show-toplevel"], projectRoot));
    const commonDirRaw = gitOutput(["rev-parse", "--git-common-dir"], repoRoot);
    if (!commonDirRaw) return { changed: false, missing: [], skipped: "no_common_dir" };

    const commonDir = path.isAbsolute(commonDirRaw)
      ? commonDirRaw
      : path.resolve(repoRoot, commonDirRaw);
    const excludeFile = path.join(commonDir, "info", "exclude");
    const entries = buildPosseRuntimeIgnoreEntries(projectRoot, {
      anchorDir: repoRoot,
      includeHeader: false,
    });
    return appendMissingLines(excludeFile, entries);
  } catch (err) {
    return { changed: false, missing: [], skipped: err?.message || String(err) };
  }
}

export async function ensurePosseGitInfoExcludeAsync(projectDir) {
  const projectRoot = path.resolve(projectDir || process.cwd());

  const fastExclude = await fastInfoExcludePathAsync(projectRoot);
  if (fastExclude) {
    const fastEntries = buildPosseRuntimeIgnoreEntries(projectRoot, {
      anchorDir: projectRoot,
      includeHeader: false,
    });
    if (await allEntriesPresentAsync(fastExclude, fastEntries)) {
      return { changed: false, missing: [], skipped: "already_present" };
    }
  }

  try {
    const repoRoot = path.resolve(await gitOutputAsync(["rev-parse", "--show-toplevel"], projectRoot));
    const commonDirRaw = await gitOutputAsync(["rev-parse", "--git-common-dir"], repoRoot);
    if (!commonDirRaw) return { changed: false, missing: [], skipped: "no_common_dir" };

    const commonDir = path.isAbsolute(commonDirRaw)
      ? commonDirRaw
      : path.resolve(repoRoot, commonDirRaw);
    const excludeFile = path.join(commonDir, "info", "exclude");
    const entries = buildPosseRuntimeIgnoreEntries(projectRoot, {
      anchorDir: repoRoot,
      includeHeader: false,
    });
    return await appendMissingLinesAsync(excludeFile, entries);
  } catch (err) {
    return { changed: false, missing: [], skipped: err?.message || String(err) };
  }
}

export function ensurePosseRuntimeIgnores(projectDir, {
  gitignore = true,
  gitInfoExclude = true,
  updateManagedGitignoreBlock = false,
} = {}) {
  const result = {};
  if (gitignore) {
    result.gitignore = ensurePosseRuntimeGitignore(projectDir, {
      updateManagedBlock: updateManagedGitignoreBlock,
    });
  }
  if (gitInfoExclude) result.gitInfoExclude = ensurePosseGitInfoExclude(projectDir);
  return result;
}

export async function ensurePosseRuntimeIgnoresAsync(projectDir, {
  gitignore = true,
  gitInfoExclude = true,
  updateManagedGitignoreBlock = false,
} = {}) {
  const result = {};
  const tasks = [];
  if (gitignore) {
    tasks.push(ensurePosseRuntimeGitignoreAsync(projectDir, {
      updateManagedBlock: updateManagedGitignoreBlock,
    }).then((value) => { result.gitignore = value; }));
  }
  if (gitInfoExclude) {
    tasks.push(ensurePosseGitInfoExcludeAsync(projectDir)
      .then((value) => { result.gitInfoExclude = value; }));
  }
  await Promise.all(tasks);
  return result;
}
