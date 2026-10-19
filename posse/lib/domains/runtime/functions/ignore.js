import fs from "fs";
import path from "path";
import { isInsideRoot } from "./fs-safety.js";
import { getRuntimeRoot } from "./paths.js";
import { gitExec, gitExecAsync } from "../../git/functions/utils.js";

export const POSSE_RUNTIME_IGNORE_HEADER = "# Posse runtime (auto-added)";

const POSSE_RUNTIME_PATH_SEGMENTS = new Set([
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
]);

// Bossy owns these deliberately versioned repository configuration surfaces.
// Everything else below a .posse directory is runtime state by default, so a
// newly-added cache/database/control path fails closed without catalog churn.
const POSSE_VERSIONED_CONFIG_NAMESPACES = new Set(["skills", "deploy"]);

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
  ".phpunit.cache/",
  ".phpunit.result.cache",
];

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

/**
 * Runtime control paths are reserved at every repository depth. Treat the
 * names case-insensitively so a branch authored on Linux cannot poison a
 * Windows checkout with a differently-cased variant.
 */
export function isPosseRuntimePath(value) {
  const normalized = toPosix(value)
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!POSSE_RUNTIME_PATH_SEGMENTS.has(segment)) continue;
    if (segment === ".posse" && POSSE_VERSIONED_CONFIG_NAMESPACES.has(segments[index + 1])) {
      continue;
    }
    return true;
  }
  return false;
}

export function filterPosseRuntimePaths(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(isPosseRuntimePath))];
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

// Runtime state once lived in root db/, resources/ and logs/ directories; it
// is all under .posse/ now. Those rules hid application source such as
// Laravel's resources/views and db/migrations, so they are retired. Only the
// generated run directly after the runtime directories is removed.
export const RETIRED_RUNTIME_DIRECTORY_RULES = new Set(["db/", "resources/", "logs/", "/db/", "/resources/", "/logs/"]);

function removeRetiredRuntimeDirectoryRules(content) {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== ".posse-test-suites/") continue;
    let end = index + 1;
    while (end < lines.length && RETIRED_RUNTIME_DIRECTORY_RULES.has(lines[end].trim())) end += 1;
    if (end > index + 1) lines.splice(index + 1, end - index - 1);
  }
  return lines.join("\n");
}

// Older excludes had no ownership header. Repair only a complete generated
// sequence, leaving isolated/user-authored rules and surrounding text intact.
function repairLegacyRuntimeExcludes(content, entries) {
  content = removeRetiredRuntimeDirectoryRules(content);
  const legacy = entries.map((entry) => entry.startsWith("/") ? entry.slice(1) : entry);
  const lines = content.split("\n");
  for (let start = 0; start <= lines.length - legacy.length; start += 1) {
    if (!legacy.every((entry, offset) => lines[start + offset].trim() === entry)) continue;
    for (let offset = 0; offset < legacy.length; offset += 1) {
      if (legacy[offset] === entries[offset]) continue;
      lines[start + offset] = lines[start + offset].replace(legacy[offset], entries[offset]);
    }
  }
  return lines.join("\n");
}

function appendMissingLines(filePath, entries, { repairLegacyExclude = false } = {}) {
  const wanted = entries.filter(Boolean);
  if (wanted.length === 0) return { changed: false, missing: [] };

  let existing = "";
  try { existing = fs.readFileSync(filePath, "utf-8"); } catch { /* file may not exist yet */ }
  const original = existing;
  if (repairLegacyExclude) existing = repairLegacyRuntimeExcludes(existing, wanted);

  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = wanted.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0 && existing === original) return { changed: false, missing: [] };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const suffix = missing.length > 0 ? `${prefix}${missing.join("\n")}\n` : "";
  if (existing !== original) fs.writeFileSync(filePath, existing + suffix, "utf-8");
  else fs.appendFileSync(filePath, suffix, "utf-8");
  return { changed: true, missing };
}

async function appendMissingLinesAsync(filePath, entries, { repairLegacyExclude = false } = {}) {
  const wanted = entries.filter(Boolean);
  if (wanted.length === 0) return { changed: false, missing: [] };

  let existing = "";
  try { existing = await fs.promises.readFile(filePath, "utf-8"); } catch { /* file may not exist yet */ }
  const original = existing;
  if (repairLegacyExclude) existing = repairLegacyRuntimeExcludes(existing, wanted);

  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = wanted.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0 && existing === original) return { changed: false, missing: [] };

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const suffix = missing.length > 0 ? `${prefix}${missing.join("\n")}\n` : "";
  if (existing !== original) await fs.promises.writeFile(filePath, existing + suffix, "utf-8");
  else await fs.promises.appendFile(filePath, suffix, "utf-8");
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
  // Runtime artifacts are written separately to .git/info/exclude. Once a
  // repository has a HEAD, changing its project-owned .gitignore during startup dirties
  // read-only workflows and reproducible benchmark sleeves. New repositories
  // still receive the managed block so it can be part of their initial commit.
  if (!updateManagedBlock) {
    try {
      gitOutput(["rev-parse", "HEAD"], projectRoot);
      return { changed: false, missing: [], skipped: "head_exists" };
    } catch {
      // No repository/HEAD yet; preserve bootstrap behavior below.
    }
  }
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

export function isPosseRuntimeOnlyGitignoreContent(projectDir, content, {
  anchorDir = projectDir,
} = {}) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || !lines.includes(POSSE_RUNTIME_IGNORE_HEADER)) return false;

  const allowed = new Set([...buildPosseRuntimeIgnoreEntries(projectDir, { anchorDir }), ...RETIRED_RUNTIME_DIRECTORY_RULES]);
  return lines.every((line) => allowed.has(line));
}

// True when Posse wrote its managed block into the file, whether it created
// the file or appended the block to a user's existing rules.
export function hasPosseRuntimeIgnoreBlock(content) {
  return String(content || "")
    .split(/\r?\n/)
    .some((line) => line.trim() === POSSE_RUNTIME_IGNORE_HEADER);
}

export async function ensurePosseRuntimeGitignoreAsync(projectDir, {
  updateManagedBlock = false,
} = {}) {
  const projectRoot = path.resolve(projectDir || process.cwd());
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (!updateManagedBlock) {
    try {
      await gitOutputAsync(["rev-parse", "HEAD"], projectRoot);
      return { changed: false, missing: [], skipped: "head_exists" };
    } catch {
      // No repository/HEAD yet; preserve bootstrap behavior below.
    }
  }
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
  return gitExec(args, cwd, { timeoutMs: 30_000 }).trim();
}

async function gitOutputAsync(args, cwd) {
  return String(await gitExecAsync(args, cwd, { timeoutMs: 30_000 }) || "").trim();
}

// The bootstrap commit passes includeAppendedBlock: with no history to protect,
// it also records a user .gitignore that Posse appended its block to.
export async function stagePosseRuntimeGitignoreForInitialCommit(projectDir, {
  git = gitOutputAsync,
  includeAppendedBlock = false,
} = {}) {
  const projectRoot = path.resolve(projectDir || process.cwd());
  try {
    await git(["rev-parse", "--git-dir"], projectRoot);
  } catch {
    return { staged: false, skipped: "not_git_repo" };
  }

  try {
    await git(["rev-parse", "HEAD"], projectRoot);
    return { staged: false, skipped: "head_exists" };
  } catch {
    // No HEAD yet; this is the only state where bootstrap staging is needed.
  }

  const gitignorePath = path.join(projectRoot, ".gitignore");
  let content;
  try {
    content = await fs.promises.readFile(gitignorePath, "utf-8");
  } catch {
    return { staged: false, skipped: "missing" };
  }

  if (!isPosseRuntimeOnlyGitignoreContent(projectRoot, content)
    && !(includeAppendedBlock && hasPosseRuntimeIgnoreBlock(content))) {
    return { staged: false, skipped: "not_posse_runtime_only" };
  }

  await git(["add", "--", ".gitignore"], projectRoot);
  return { staged: true };
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
  if (repairLegacyRuntimeExcludes(existing, entries) !== existing) return false;
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return entries.every((entry) => existingLines.has(entry));
}

async function allEntriesPresentAsync(excludeFile, entries) {
  let existing;
  try { existing = await fs.promises.readFile(excludeFile, "utf-8"); } catch { return false; }
  if (repairLegacyRuntimeExcludes(existing, entries) !== existing) return false;
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
    return appendMissingLines(excludeFile, entries, { repairLegacyExclude: true });
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
    return await appendMissingLinesAsync(excludeFile, entries, { repairLegacyExclude: true });
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
