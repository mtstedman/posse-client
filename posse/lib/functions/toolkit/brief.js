import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { TOOL_BRIEF_DEFAULT_EXTENSIONS } from "../../catalog/files.js";
import { createWorkspaceSkipDirs } from "../../domains/runtime/functions/workspace-skip.js";
import { isSensitiveEnvFileOrTargetPath } from "../../domains/runtime/functions/sensitive-paths.js";

export { TOOL_PULL_BRIEF } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

const DEFAULT_SKIP_DIRS = createWorkspaceSkipDirs(["vendor"]);

const DEFAULT_EXTENSIONS = TOOL_BRIEF_DEFAULT_EXTENSIONS;

const STOP_WORDS = new Set([
  "the", "and", "or", "for", "with", "from", "into", "your", "this", "that", "where", "what", "how", "when",
  "does", "work", "using", "used", "are", "is", "was", "were", "can", "could", "should", "would", "about",
  "token", "file", "files", "code", "repo", "project", "endpoint", "flow",
]);


function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

function isSafeRelativePath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return false;
  if (path.isAbsolute(normalized)) return false;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  return true;
}

function tokenizeQuery(query) {
  return normalizePath(query)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function shouldSkipPath(fullPath, skipDirs) {
  const normalized = normalizePath(fullPath);
  return Array.from(skipDirs).some((entry) => normalized.includes(`/${entry}/`) || normalized.endsWith(`/${entry}`));
}

function buildPathScore(relPath, queryTokens, missingHints) {
  const lower = relPath.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) score += 6;
  }
  for (const hint of missingHints) {
    const normalizedHint = hint.toLowerCase();
    if (lower.includes(normalizedHint)) score += 20;
  }
  if (lower.includes("/api/")) score += 2;
  if (lower.includes("middleware")) score += 3;
  return score;
}

function buildSnippetScore(line, queryTokens, missingHints) {
  const lower = line.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) score += 2;
  }
  for (const hint of missingHints) {
    if (lower.includes(hint.toLowerCase())) score += 8;
  }
  return score;
}

function parseImportSpecifiers(content = "") {
  const text = String(content || "");
  const specs = [];
  const addSpec = (raw) => {
    const spec = String(raw || "").trim();
    if (!spec) return;
    if (!spec.startsWith(".") && !spec.startsWith("/")) return;
    if (!specs.includes(spec)) specs.push(spec);
  };

  const importRegex = /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = importRegex.exec(text))) addSpec(match[1]);
  while ((match = dynamicImportRegex.exec(text))) addSpec(match[1]);
  while ((match = requireRegex.exec(text))) addSpec(match[1]);
  return specs;
}

function resolveRelativeImportToPath(importerRelPath, specifier, includeExt = DEFAULT_EXTENSIONS) {
  const importerDir = path.posix.dirname(importerRelPath.replace(/\\/g, "/"));
  const resolvedBase = path.posix.normalize(path.posix.join(importerDir, specifier));
  const candidates = [resolvedBase];
  for (const ext of includeExt) {
    candidates.push(`${resolvedBase}${ext}`);
    candidates.push(path.posix.join(resolvedBase, `index${ext}`));
  }
  return candidates;
}

function gatherRecentGitPaths(cwd, maxCommits = 10, gitLogImpl = execFileSync) {
  try {
    const output = gitLogImpl("git", [
      "log",
      "--name-only",
      "--pretty=format:",
      `-n`,
      String(maxCommits),
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const lines = String(output || "")
      .split(/\r?\n/)
      .map((line) => normalizePath(line))
      .filter(Boolean)
      .filter((line) => !line.startsWith("fatal:"));
    return new Set(lines);
  } catch {
    return new Set();
  }
}

function gatherCandidateFiles(rootDir, includeExt, skipDirs, maxCandidates) {
  const out = [];
  function walk(current) {
    if (out.length >= maxCandidates) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxCandidates) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!includeExt.has(ext)) continue;
      if (shouldSkipPath(full, skipDirs)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function createBriefEntry({
  absPath,
  relPath,
  snippets,
  pathScore,
  hitScore,
  dependencyScore = 0,
  recencyScore = 0,
  importSpecifiers = [],
}) {
  return {
    path: relPath,
    score: pathScore + hitScore + dependencyScore + recencyScore,
    hit_score: hitScore,
    path_score: pathScore,
    dependency_score: dependencyScore,
    recency_score: recencyScore,
    import_specifiers: importSpecifiers,
    snippets,
  };
}

export function createPullBriefExecutor(safePathImpl, { skipDirs = DEFAULT_SKIP_DIRS, gitLogImpl = execFileSync } = {}) {
  if (typeof safePathImpl !== "function") {
    throw new Error("createPullBriefExecutor requires safePath.");
  }

  return function execPullBrief(args = {}, cwd, scopePredicates) {
    const mode = String(args.mode || "gap_fill").trim().toLowerCase();
    const query = String(args.query || "").trim();
    if (!query) return "Error: pull_brief requires query.";
    if (mode !== "gap_fill" && mode !== "tree_pull") {
      return "Error: pull_brief mode must be 'gap_fill' or 'tree_pull'.";
    }

    const queryTokens = tokenizeQuery(query);
    const missingHints = Array.isArray(args.missing)
      ? args.missing.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 20)
      : [];
    const maxFiles = clampInt(args.max_files, 1, 30, 12);
    const maxLinesPerFile = clampInt(args.max_lines_per_file, 1, 80, 8);
    const includeExt = new Set(
      Array.isArray(args.include_ext) && args.include_ext.length > 0
        ? args.include_ext.map((ext) => String(ext || "").toLowerCase().trim()).filter((ext) => ext.startsWith("."))
        : Array.from(DEFAULT_EXTENSIONS),
    );

    const seedPaths = Array.isArray(args.seed_paths) ? args.seed_paths.slice(0, 30) : [];
    const candidateAbsPaths = [];
    for (const seed of seedPaths) {
      if (!isSafeRelativePath(seed)) continue;
      try {
        const abs = safePathImpl(cwd, seed, scopePredicates);
        if (isSensitiveEnvFileOrTargetPath(abs)) continue;
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) candidateAbsPaths.push(abs);
      } catch {
        // ignore out-of-scope seeds
      }
    }

    const maxCandidates = mode === "tree_pull" ? 2500 : 1200;
    const scannedCandidates = gatherCandidateFiles(cwd, includeExt, skipDirs, maxCandidates);
    const allCandidates = [...new Set([...candidateAbsPaths, ...scannedCandidates])];

    const recencySet = gatherRecentGitPaths(cwd, 10, gitLogImpl);
    const entries = [];
    for (const absPath of allCandidates) {
      let content = "";
      try {
        if (isSensitiveEnvFileOrTargetPath(absPath)) continue;
        const stat = fs.statSync(absPath);
        if (stat.size > 1024 * 512) continue;
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      const relPath = normalizePath(path.relative(cwd, absPath));
      const pathScore = buildPathScore(relPath, queryTokens, missingHints);
      const lines = content.split(/\r?\n/);
      const hits = [];
      let totalHitScore = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const score = buildSnippetScore(line, queryTokens, missingHints);
        if (score <= 0) continue;
        totalHitScore += score;
        if (hits.length < maxLinesPerFile) {
          hits.push({
            line: i + 1,
            text: line.trim().slice(0, 320),
            score,
          });
        }
      }

      const importSpecifiers = parseImportSpecifiers(content);
      if (mode === "gap_fill" && pathScore <= 0 && totalHitScore <= 0) continue;

      entries.push(createBriefEntry({
        absPath,
        relPath,
        snippets: hits,
        pathScore,
        hitScore: totalHitScore,
        importSpecifiers,
        dependencyScore: 0,
        recencyScore: recencySet.has(relPath) ? 4 : 0,
      }));
    }

    const seedMatchedPaths = new Set(entries
      .filter((entry) => (entry.path_score + entry.hit_score) > 0)
      .map((entry) => entry.path));

    for (const entry of entries) {
      if (!Array.isArray(entry.importSpecifiers) || entry.importSpecifiers.length === 0) continue;
      for (const specifier of entry.importSpecifiers) {
        const candidates = resolveRelativeImportToPath(entry.path, specifier, includeExt);
        const touchesSeed = candidates.some((candidate) => seedMatchedPaths.has(candidate));
        if (!touchesSeed) continue;
        entry.dependencyScore += 8;
      }
      entry.score = entry.path_score + entry.hit_score + entry.dependencyScore + entry.recencyScore;
    }

    entries.sort((a, b) => b.score - a.score);
    const selected = entries.slice(0, maxFiles);
    const matchedMissing = missingHints.filter((hint) =>
      selected.some((entry) => entry.path.toLowerCase().includes(hint.toLowerCase())),
    );

    const response = {
      mode,
      query,
      token_hints: queryTokens,
      limits: {
        max_files: maxFiles,
        max_lines_per_file: maxLinesPerFile,
      },
      matched_missing: matchedMissing,
      files: selected,
      summary: {
        candidates_scanned: allCandidates.length,
        files_returned: selected.length,
        recent_git_paths: recencySet.size,
      },
    };
    return JSON.stringify(response, null, 2);
  };
}

export function __testIsSafeRelativePath(value) {
  return isSafeRelativePath(value);
}
