// @ts-check
//
// Thin JS adapter for Rust-owned deterministic evidence helpers. JS gathers
// ATLAS view rows; Rust owns scanning and decoy/negative-evidence policy.

import { runAtlasNativeMethodAsync } from "../native/invoke.js";

const MAX_NATIVE_EVIDENCE_PATHS = 5000;

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   repoRoot?: string,
 *   paths?: string[],
 *   requested?: string[],
 *   terms?: string[],
 *   symbolsByPath?: Map<string, import("../contracts/api.js").ViewSymbol[]>,
 *   maxFiles?: number,
 * }} args
 * @returns {Promise<Record<string, unknown>>}
 */
export async function nativePathEvidence({
  view,
  repoRoot,
  paths = [],
  requested = [],
  terms = [],
  symbolsByPath,
  maxFiles = MAX_NATIVE_EVIDENCE_PATHS,
}) {
  return /** @type {Record<string, unknown>} */ (await runAtlasNativeMethodAsync("path-evidence", {
    repoRoot: await resolveRepoRoot(view, repoRoot),
    selectedPaths: normalizePathList(paths),
    requestedPaths: normalizePathList(requested),
    terms: normalizeStringList(terms),
    symbolTerms: collectSymbolTerms(symbolsByPath),
    indexedPaths: await collectNativeEvidenceIndexedPaths(view, maxFiles),
    maxFiles,
  }));
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   repoRoot?: string,
 *   files?: string[],
 *   selectedPaths?: string[],
 *   requested?: string[],
 *   maxFiles?: number,
 *   prefixTruncated?: boolean,
 * }} args
 * @returns {Promise<Record<string, unknown>>}
 */
export async function nativeCodeDb({
  view,
  repoRoot,
  files = [],
  selectedPaths = [],
  requested = [],
  maxFiles = 64,
  prefixTruncated = false,
}) {
  return /** @type {Record<string, unknown>} */ (await runAtlasNativeMethodAsync("code-db", {
    repoRoot: await resolveRepoRoot(view, repoRoot),
    files: normalizePathList(files),
    selectedPaths: normalizePathList(selectedPaths),
    requestedPaths: normalizePathList(requested),
    indexedPaths: await collectNativeEvidenceIndexedPaths(view, MAX_NATIVE_EVIDENCE_PATHS),
    maxFiles,
    prefixTruncated: Boolean(prefixTruncated),
  }));
}

/**
 * @param {import("../contracts/api.js").View} view
 * @param {number} maxFiles
 */
export async function collectNativeEvidenceIndexedPaths(view, maxFiles = MAX_NATIVE_EVIDENCE_PATHS) {
  const cap = clampInt(maxFiles, MAX_NATIVE_EVIDENCE_PATHS, 1, MAX_NATIVE_EVIDENCE_PATHS);
  return view?.query && typeof view.query.indexedPaths === "function"
    ? normalizePathList(await view.query.indexedPaths({ limit: cap }))
    : [];
}

/**
 * @param {import("../contracts/api.js").View} view
 * @param {string | undefined} repoRoot
 */
async function resolveRepoRoot(view, repoRoot) {
  const explicit = String(repoRoot || "").trim();
  if (explicit) return explicit;
  if (typeof view?.meta === "function") {
    const meta = /** @type {any} */ (await view.meta());
    return String(meta?.repo_root || "").trim();
  }
  return "";
}

/**
 * @param {Map<string, import("../contracts/api.js").ViewSymbol[]> | undefined} symbolsByPath
 */
function collectSymbolTerms(symbolsByPath) {
  if (!(symbolsByPath instanceof Map)) return [];
  const out = [];
  for (const symbols of symbolsByPath.values()) {
    for (const symbol of symbols || []) {
      out.push(symbol?.name, symbol?.qualified_name);
    }
  }
  return normalizeStringList(out);
}

/**
 * @param {unknown[]} values
 */
function normalizePathList(values) {
  return [...new Set(values.map(normalizeRepoPath).filter(Boolean))].sort();
}

/**
 * @param {unknown[]} values
 */
function normalizeStringList(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
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

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
