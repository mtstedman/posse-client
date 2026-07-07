// @ts-check
//
// Path ambiguity package: duplicate basenames, root stubs, and zero-byte
// decoys surfaced alongside retrieval results that already mention paths.

import fs from "fs";
import path from "path";

const MAX_SCAN_PATHS = 5000;
const MAX_GROUPS = 40;
const IGNORED_FS_DIRS = new Set([
  ".git",
  ".posse",
  ".posse-worktrees",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   repoRoot?: string,
 *   paths?: string[],
 *   requested?: string[],
 *   terms?: string[],
 *   maxFiles?: number,
 * }} args
 * @returns {Record<string, unknown> | null}
 */
export function buildPathAmbiguity({ view, repoRoot, paths = [], requested = [], terms = [], maxFiles = MAX_SCAN_PATHS }) {
  const root = resolveRepoRoot(view, repoRoot);
  const focusPaths = [...new Set(paths.map(normalizeRepoPath).filter(Boolean))];
  const requestedPaths = [...new Set(requested.map(normalizeRepoPath).filter(Boolean))];
  const focusTerms = normalizeTerms([...terms, ...focusPaths, ...requestedPaths]);
  const candidates = new Map();
  const cap = clampInt(maxFiles, MAX_SCAN_PATHS, 1, MAX_SCAN_PATHS);
  let truncated = false;

  if (root) {
    for (const repoPath of listRootFiles(root)) addCandidate(candidates, repoPath, "filesystem");
    for (const repoPath of requestedPaths) {
      const result = collectFilesystemProbePaths({ repoRoot: root, repoPath, maxFiles: Math.max(0, cap - candidates.size) });
      truncated = truncated || result.truncated;
      for (const childPath of result.paths) addCandidate(candidates, childPath, "filesystem");
    }
  }

  const indexed = listIndexedPaths(view, requestedPaths, cap);
  truncated = truncated || indexed.truncated;
  for (const repoPath of indexed.paths) addCandidate(candidates, repoPath, "index");
  if (root) hydrateFilesystemStats(candidates, root);

  const groups = buildBasenameGroups([...candidates.values()], focusTerms, new Set(focusPaths));
  const zeroByteStubs = [...candidates.values()]
    .filter((candidate) => candidate.zeroByte && shouldSurfaceZeroByte(candidate.path, focusTerms, groups))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_GROUPS)
    .map((candidate) => ({
      path: candidate.path,
      byteSize: candidate.byteSize,
      reason: rootLevel(candidate.path) ? "zero_byte_root_stub" : "zero_byte_stub",
      sources: [...candidate.sources].sort(),
    }));

  const duplicateBasenames = groups
    .filter((group) => group.paths.length > 1)
    .slice(0, MAX_GROUPS);

  if (duplicateBasenames.length === 0 && zeroByteStubs.length === 0) return null;

  const warnings = [];
  if (duplicateBasenames.length > 0) {
    warnings.push(`Path ambiguity: ${duplicateBasenames.length} duplicate basename group(s) may be decoys.`);
  }
  if (zeroByteStubs.length > 0) {
    warnings.push(`Path ambiguity: ${zeroByteStubs.length} zero-byte stub file(s) detected.`);
  }

  return {
    duplicateBasenames,
    zeroByteStubs,
    terms: [...focusTerms],
    scannedPathCount: candidates.size,
    truncated: candidates.size >= cap || truncated,
    warnings,
  };
}

function listIndexedPaths(view, requested, maxFiles) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) {
    const paths = [...new Set(view.query.allSymbols({ limit: maxFiles }).map((symbol) => normalizeRepoPath(symbol.repo_rel_path)).filter(Boolean))]
      .sort();
    return { paths, truncated: paths.length >= maxFiles };
  }
  if (requested.length > 0) {
    const paths = collectIndexedRequestedPaths({ view, requested, maxFiles });
    const basenames = new Set(paths.map((repoPath) => path.posix.basename(repoPath).toLowerCase()));
    const allRows = db.prepare("SELECT repo_rel_path FROM path_to_blob ORDER BY repo_rel_path LIMIT ?").all(maxFiles + 1);
    const allPaths = allRows.map((row) => normalizeRepoPath(row.repo_rel_path)).filter(Boolean);
    return {
      paths: [...new Set([
        ...paths,
        ...allPaths.filter((repoPath) => basenames.has(path.posix.basename(repoPath).toLowerCase())),
      ])].slice(0, maxFiles),
      truncated: allRows.length > maxFiles,
    };
  }
  const rows = db.prepare("SELECT repo_rel_path FROM path_to_blob ORDER BY repo_rel_path LIMIT ?").all(maxFiles + 1);
  return {
    paths: rows.slice(0, maxFiles).map((row) => normalizeRepoPath(row.repo_rel_path)).filter(Boolean),
    truncated: rows.length > maxFiles,
  };
}

function collectIndexedRequestedPaths({ view, requested, maxFiles }) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  const seen = new Set();
  const paths = [];
  const push = (repoPath) => {
    const normalized = normalizeRepoPath(repoPath);
    if (!normalized || seen.has(normalized) || paths.length >= maxFiles) return;
    seen.add(normalized);
    paths.push(normalized);
  };
  for (const entry of requested) {
    if (!db) {
      if (view.query.symbolsInFile(entry).length > 0) push(entry);
      continue;
    }
    const isFile = !!db.prepare("SELECT 1 FROM path_to_blob WHERE repo_rel_path = ?").get(entry);
    if (isFile) {
      push(entry);
      continue;
    }
    const rows = db.prepare(
      "SELECT repo_rel_path FROM path_to_blob WHERE repo_rel_path LIKE ? ORDER BY repo_rel_path LIMIT ?",
    ).all(`${entry}/%`, maxFiles + 1);
    for (const row of rows) push(row.repo_rel_path);
  }
  return paths;
}

function collectFilesystemProbePaths({ repoRoot, repoPath, maxFiles }) {
  const normalized = normalizeRepoPath(repoPath);
  const abs = normalized ? resolveUnderRoot(repoRoot, normalized) : "";
  if (!abs || !fs.existsSync(abs)) return { paths: [], truncated: false };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { paths: [], truncated: false };
  }
  if (stat.isFile()) return { paths: [normalized], truncated: false };
  if (!stat.isDirectory()) return { paths: [], truncated: false };
  return walkRepoFiles(repoRoot, normalized, maxFiles);
}

function listRootFiles(repoRoot) {
  try {
    return fs.readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => normalizeRepoPath(entry.name))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function walkRepoFiles(repoRoot, startRel, maxFiles) {
  const paths = [];
  let truncated = false;
  const root = resolveUnderRoot(repoRoot, startRel);
  if (!root) return { paths, truncated };
  const visit = (dirAbs, dirRel) => {
    if (truncated) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isDirectory()) {
        if (IGNORED_FS_DIRS.has(entry.name)) continue;
        visit(path.join(dirAbs, entry.name), `${dirRel}/${entry.name}`.replace(/^\/+/, ""));
        continue;
      }
      if (!entry.isFile()) continue;
      if (paths.length >= maxFiles) {
        truncated = true;
        break;
      }
      paths.push(`${dirRel}/${entry.name}`.replace(/^\/+/, ""));
    }
  };
  visit(root, startRel);
  return { paths: paths.map(normalizeRepoPath).filter(Boolean), truncated };
}

function hydrateFilesystemStats(candidates, repoRoot) {
  for (const candidate of candidates.values()) {
    const abs = resolveUnderRoot(repoRoot, candidate.path);
    if (!abs) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      candidate.byteSize = stat.size;
      candidate.zeroByte = stat.size === 0;
    } catch {
      // Indexed paths may legitimately be absent from a dirty worktree.
    }
  }
}

function buildBasenameGroups(candidates, terms, focusPathSet) {
  const byBase = new Map();
  for (const candidate of candidates) {
    const base = path.posix.basename(candidate.path).toLowerCase();
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(candidate);
  }
  return [...byBase.entries()]
    .map(([basename, group]) => {
      const paths = group.map((candidate) => candidate.path).sort();
      const zeroBytePaths = group.filter((candidate) => candidate.zeroByte).map((candidate) => candidate.path).sort();
      const rootPaths = group.filter((candidate) => rootLevel(candidate.path)).map((candidate) => candidate.path).sort();
      const liveCandidates = group
        .filter((candidate) => !candidate.zeroByte && !rootLevel(candidate.path))
        .map((candidate) => candidate.path)
        .sort();
      const staleCandidates = [...new Set([...zeroBytePaths, ...rootPaths])].sort();
      return {
        basename,
        stem: basenameStem(basename),
        paths,
        zeroBytePaths,
        rootPaths,
        liveCandidates,
        staleCandidates,
        needsDeployProof: paths.length > 1 && (rootPaths.length > 0 || liveCandidates.length > 1),
        sources: [...new Set(group.flatMap((candidate) => [...candidate.sources]))].sort(),
      };
    })
    .filter((group) => {
      if (terms.has(group.basename) || terms.has(group.stem)) return true;
      if (group.paths.some((repoPath) => focusPathSet.has(repoPath))) return true;
      return group.zeroBytePaths.some(rootLevel);
    })
    .sort((a, b) => b.zeroBytePaths.length - a.zeroBytePaths.length || b.paths.length - a.paths.length || a.basename.localeCompare(b.basename));
}

function shouldSurfaceZeroByte(repoPath, terms, groups) {
  if (rootLevel(repoPath)) return true;
  if ([...terms].some((term) => termMatchesPath(term, repoPath))) return true;
  return groups.some((group) => group.zeroBytePaths.includes(repoPath));
}

function normalizeTerms(values) {
  const terms = new Set();
  for (const value of values) {
    const text = String(value ?? "").trim().replace(/\\/g, "/");
    if (!text) continue;
    const base = path.posix.basename(text).toLowerCase();
    if (!base || base === "." || base === "/") continue;
    terms.add(base);
    const ext = path.posix.extname(base);
    if (ext) terms.add(base.slice(0, -ext.length));
  }
  return terms;
}

function addCandidate(candidates, repoPath, source) {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized) return;
  const existing = candidates.get(normalized);
  if (existing) {
    existing.sources.add(source);
    return;
  }
  candidates.set(normalized, { path: normalized, sources: new Set([source]), byteSize: null, zeroByte: false });
}

function resolveRepoRoot(view, repoRoot) {
  const raw = repoRoot || (typeof view.meta === "function" ? /** @type {any} */ (view.meta()).repo_root : "");
  if (!raw) return "";
  try {
    const resolved = path.resolve(String(raw));
    return fs.existsSync(resolved) ? resolved : "";
  } catch {
    return "";
  }
}

function resolveUnderRoot(repoRoot, repoPath) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, repoPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return "";
  return resolved;
}

function normalizeRepoPath(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!text || text === "." || text.startsWith("../") || text.includes("/../") || /^[a-zA-Z]:\//.test(text)) return "";
  return text;
}

function basenameStem(basename) {
  const ext = path.posix.extname(basename);
  return ext ? basename.slice(0, -ext.length) : basename;
}

function termMatchesPath(term, repoPath) {
  const base = path.posix.basename(repoPath).toLowerCase();
  return term === base || term === basenameStem(base);
}

function rootLevel(repoPath) {
  return !normalizeRepoPath(repoPath).includes("/");
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
