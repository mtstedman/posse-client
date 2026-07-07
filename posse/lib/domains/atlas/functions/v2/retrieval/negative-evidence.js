// @ts-check
//
// Negative-evidence package: cheap, deterministic decoy/stub/offline-candidate
// hints that ride alongside exact retrieval calls. This is intentionally a
// helper, not a separate model-facing rung: it annotates calls that already
// resolved the primary files so agents can prove which same-name artifacts are
// not the live path.

import fs from "fs";
import path from "path";

const MAX_SCAN_PATHS = 5000;
const MAX_CANDIDATES = 80;
const MAX_CONTENT_PROBES = 200;
const MAX_READ_BYTES = 1024 * 1024;
const COMMON_TERMS = new Set([
  "app",
  "bin",
  "code",
  "core",
  "data",
  "dist",
  "file",
  "files",
  "index",
  "lib",
  "main",
  "node",
  "src",
  "test",
  "tests",
  "util",
  "utils",
]);

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   repoRoot?: string,
 *   paths?: string[],
 *   requested?: string[],
 *   terms?: string[],
 *   symbolsByPath?: Map<string, import("../contracts/api.js").ViewSymbol[]>,
 *   pathAmbiguity?: Record<string, unknown> | null,
 *   maxFiles?: number,
 * }} args
 * @returns {Record<string, unknown> | null}
 */
export function buildNegativeEvidence({
  view,
  repoRoot,
  paths = [],
  requested = [],
  terms = [],
  symbolsByPath,
  pathAmbiguity = null,
  maxFiles = MAX_SCAN_PATHS,
}) {
  const selected = new Set(paths.map(normalizeRepoPath).filter(Boolean));
  const focusTerms = collectTerms({ paths, requested, terms, symbolsByPath });
  const candidates = new Map();
  const cap = clampInt(maxFiles, MAX_SCAN_PATHS, 1, MAX_SCAN_PATHS);
  let truncated = false;

  mergePathAmbiguityCandidates(candidates, pathAmbiguity, selected);

  const indexed = listIndexedPaths(view, cap);
  truncated = indexed.truncated;
  const root = resolveRepoRoot(view, repoRoot);
  let contentProbes = 0;
  for (const repoPath of indexed.paths) {
    if (selected.has(repoPath)) continue;
    if (!pathLooksRelevant(repoPath, focusTerms)) continue;
    const classification = classifyPath(repoPath, root ? statFor(root, repoPath) : null);
    const matchedTerms = matchedPathTerms(repoPath, focusTerms);
    let site = null;
    let evidence = null;
    if (root && contentProbes < MAX_CONTENT_PROBES) {
      const match = findContentMatch(root, repoPath, focusTerms);
      contentProbes += 1;
      if (match) {
        site = `${repoPath}:${match.line}`;
        evidence = match.text;
      }
    }
    addCandidate(candidates, {
      path: repoPath,
      classification,
      reason: reasonForClassification(classification, "matched_focus_term"),
      matchedTerms,
      site,
      evidence,
      sources: ["index"],
    }, selected);
  }

  const rows = [...candidates.values()]
    .sort((a, b) => classificationRank(a.classification) - classificationRank(b.classification) || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATES);

  if (rows.length === 0) return null;
  const warnings = [];
  if (rows.some((row) => row.classification === "root_stub" || row.classification === "zero_byte_stub")) {
    warnings.push("Negative evidence: stub/zero-byte candidates were detected near the selected path(s).");
  }
  if (rows.some((row) => row.classification === "test_only" || row.classification === "offline_script" || row.classification === "docs_only")) {
    warnings.push("Negative evidence: same-name test/script/doc candidates may be decoys rather than live runtime paths.");
  }

  return {
    candidates: rows,
    metrics: {
      candidateCount: rows.length,
      scannedPathCount: indexed.paths.length,
      termCount: focusTerms.size,
      contentProbeCount: contentProbes,
      truncated: truncated || candidates.size > rows.length,
    },
    warnings,
  };
}

function mergePathAmbiguityCandidates(candidates, pathAmbiguity, selected) {
  if (!pathAmbiguity || typeof pathAmbiguity !== "object") return;
  const stubs = Array.isArray(pathAmbiguity.zeroByteStubs) ? pathAmbiguity.zeroByteStubs : [];
  for (const stub of stubs) {
    const repoPath = normalizeRepoPath(stub?.path);
    if (!repoPath || selected.has(repoPath)) continue;
    const classification = String(stub?.reason || "").includes("root") ? "root_stub" : "zero_byte_stub";
    addCandidate(candidates, {
      path: repoPath,
      classification,
      reason: reasonForClassification(classification, "path_ambiguity"),
      matchedTerms: [],
      site: null,
      evidence: null,
      byteSize: Number.isFinite(Number(stub?.byteSize)) ? Number(stub.byteSize) : null,
      sources: Array.isArray(stub?.sources) ? stub.sources : ["pathAmbiguity"],
    }, selected);
  }
  const groups = Array.isArray(pathAmbiguity.duplicateBasenames) ? pathAmbiguity.duplicateBasenames : [];
  for (const group of groups) {
    const paths = Array.isArray(group?.paths) ? group.paths : [];
    for (const rawPath of paths) {
      const repoPath = normalizeRepoPath(rawPath);
      if (!repoPath || selected.has(repoPath)) continue;
      const classification = Array.isArray(group?.zeroBytePaths) && group.zeroBytePaths.includes(repoPath)
        ? (rootLevel(repoPath) ? "root_stub" : "zero_byte_stub")
        : classifyPath(repoPath, null);
      addCandidate(candidates, {
        path: repoPath,
        classification,
        reason: reasonForClassification(classification, "duplicate_basename"),
        matchedTerms: [String(group?.stem || group?.basename || "").toLowerCase()].filter(Boolean),
        site: null,
        evidence: null,
        sources: Array.isArray(group?.sources) ? group.sources : ["pathAmbiguity"],
      }, selected);
    }
  }
}

function collectTerms({ paths, requested, terms, symbolsByPath }) {
  const out = new Set();
  for (const value of [...paths, ...requested, ...terms]) addTermVariants(out, value);
  if (symbolsByPath instanceof Map) {
    for (const symbols of symbolsByPath.values()) {
      for (const symbol of symbols || []) {
        addTermVariants(out, symbol?.name);
        addTermVariants(out, symbol?.qualified_name);
      }
    }
  }
  return out;
}

function addTermVariants(out, value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (!text) return;
  for (const part of [text, path.posix.basename(text), ...text.split(/[./_-]+/g)]) {
    const normalized = String(part || "").toLowerCase().replace(/[^a-z0-9_$]+/g, "");
    if (normalized.length < 4 || COMMON_TERMS.has(normalized)) continue;
    out.add(normalized);
  }
}

function listIndexedPaths(view, maxFiles) {
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) {
    const paths = [...new Set(view.query.allSymbols({ limit: maxFiles }).map((symbol) => normalizeRepoPath(symbol.repo_rel_path)).filter(Boolean))]
      .sort();
    return { paths, truncated: paths.length >= maxFiles };
  }
  const rows = db.prepare("SELECT repo_rel_path FROM path_to_blob ORDER BY repo_rel_path LIMIT ?").all(maxFiles + 1);
  return {
    paths: rows.slice(0, maxFiles).map((row) => normalizeRepoPath(row.repo_rel_path)).filter(Boolean),
    truncated: rows.length > maxFiles,
  };
}

function pathLooksRelevant(repoPath, terms) {
  if (terms.size === 0) return isSuspiciousPath(repoPath);
  const haystack = repoPath.toLowerCase();
  return [...terms].some((term) => haystack.includes(term));
}

function matchedPathTerms(repoPath, terms) {
  const haystack = repoPath.toLowerCase();
  return [...terms].filter((term) => haystack.includes(term)).slice(0, 12);
}

function findContentMatch(repoRoot, repoPath, terms) {
  if (terms.size === 0) return null;
  const abs = resolveUnderRoot(repoRoot, repoPath);
  if (!abs) return null;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    if ([...terms].some((term) => lower.includes(term))) {
      return { line: i + 1, text: lines[i].trim().slice(0, 240) };
    }
  }
  return null;
}

function classifyPath(repoPath, stat) {
  const text = normalizeRepoPath(repoPath);
  const lower = text.toLowerCase();
  if (rootLevel(text) && stat?.size === 0) return "root_stub";
  if (stat?.size === 0) return "zero_byte_stub";
  if (/(^|\/)(__tests__|test|tests|spec|specs|fixtures?|mocks?)(\/|$)/.test(lower) || /(\.|-)(test|spec)\.[a-z0-9]+$/.test(lower)) return "test_only";
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(lower) || /(^|\/)(readme|changelog|notes?)\b/.test(lower) || /\.(md|mdx|rst|txt)$/.test(lower)) return "docs_only";
  if (/(^|\/)(scripts?|tools?|bin|dev|examples?)(\/|$)/.test(lower)) return "offline_script";
  if (/(^|\/)(migrations?|schema|sql)(\/|$)/.test(lower) || /\.(sql)$/.test(lower)) return "migration_only";
  if (/(^|\/)(dist|build|coverage|generated|vendor|out)(\/|$)/.test(lower) || /\.(min|bundle)\./.test(lower) || /\.(bak|old|orig)$/.test(lower)) return "backup_generated";
  if (rootLevel(text)) return "root_file";
  return "ambiguous";
}

function isSuspiciousPath(repoPath) {
  return classifyPath(repoPath, null) !== "ambiguous";
}

function reasonForClassification(classification, source) {
  const prefix = source === "duplicate_basename"
    ? "same basename as selected/indexed code"
    : source === "path_ambiguity"
      ? "surfaced by path ambiguity"
      : "matched selected path/symbol terms";
  const suffix = {
    root_stub: "root-level stub candidate",
    zero_byte_stub: "zero-byte stub candidate",
    test_only: "test/fixture path",
    docs_only: "documentation-only path",
    offline_script: "script/tooling path",
    migration_only: "migration/schema path",
    backup_generated: "generated/backup path",
    root_file: "root-level same-name file",
    ambiguous: "same-name path needing deployment/config proof",
  }[classification] || "candidate path";
  return `${prefix}; ${suffix}`;
}

function classificationRank(classification) {
  return {
    root_stub: 0,
    zero_byte_stub: 1,
    test_only: 2,
    offline_script: 3,
    docs_only: 4,
    migration_only: 5,
    backup_generated: 6,
    root_file: 7,
    ambiguous: 8,
  }[classification] ?? 99;
}

function addCandidate(candidates, candidate, selected) {
  const repoPath = normalizeRepoPath(candidate.path);
  if (!repoPath || selected.has(repoPath)) return;
  const existing = candidates.get(repoPath);
  if (existing) {
    existing.sources = [...new Set([...(existing.sources || []), ...(candidate.sources || [])])].sort();
    existing.matchedTerms = [...new Set([...(existing.matchedTerms || []), ...(candidate.matchedTerms || [])])].filter(Boolean).sort();
    if (!existing.site && candidate.site) existing.site = candidate.site;
    if (!existing.evidence && candidate.evidence) existing.evidence = candidate.evidence;
    if (existing.byteSize == null && candidate.byteSize != null) existing.byteSize = candidate.byteSize;
    if (classificationRank(candidate.classification) < classificationRank(existing.classification)) {
      existing.classification = candidate.classification;
      existing.reason = candidate.reason;
    }
    return;
  }
  candidates.set(repoPath, {
    path: repoPath,
    classification: candidate.classification || "ambiguous",
    reason: candidate.reason || "same-name candidate",
    matchedTerms: [...new Set(candidate.matchedTerms || [])].filter(Boolean).sort(),
    site: candidate.site || null,
    evidence: candidate.evidence || null,
    byteSize: candidate.byteSize ?? null,
    sources: [...new Set(candidate.sources || [])].sort(),
  });
}

function statFor(repoRoot, repoPath) {
  const abs = resolveUnderRoot(repoRoot, repoPath);
  if (!abs) return null;
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
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
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized) return "";
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, normalized);
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

function rootLevel(repoPath) {
  return !normalizeRepoPath(repoPath).includes("/");
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
