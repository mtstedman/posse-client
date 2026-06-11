// @ts-check
//
// Shared SCIP language helpers for the admin selector, dependency installer,
// and indexer registry.

import {
  ATLAS_SCIP_LANGUAGE_OPTIONS,
  ATLAS_SCIP_LANGUAGE_VALUES,
  VALID_ATLAS_SCIP_LANGUAGES,
} from "../../../../../catalog/atlas.js";

export { ATLAS_SCIP_LANGUAGE_OPTIONS, ATLAS_SCIP_LANGUAGE_VALUES, VALID_ATLAS_SCIP_LANGUAGES };

const LANGUAGE_ALIASES = Object.freeze({
  js: "typescript",
  javascript: "typescript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  php: "php",
  golang: "go",
  go: "go",
  rs: "rust",
  rust: "rust",
  // Mirrors the Rust scip_language_alias map exactly.
  c: "clang",
  "c++": "clang",
  cc: "clang",
  cpp: "clang",
  cxx: "clang",
  clang: "clang",
  "scip-clang": "clang",
});

/**
 * Normalize user/admin-provided SCIP languages. Empty input means all
 * centrally-known languages, matching the historical "try every matching
 * indexer" behavior.
 *
 * @param {string[] | string | null | undefined} value
 * @param {{ defaultLanguages?: readonly string[] }} [opts]
 * @returns {string[]}
 */
export function normalizeScipLanguages(value, { defaultLanguages = ATLAS_SCIP_LANGUAGE_VALUES } = {}) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(",");
  const picked = [];
  for (const entry of raw) {
    const key = String(entry ?? "").trim().toLowerCase();
    if (!key) continue;
    const normalized = LANGUAGE_ALIASES[key] || key;
    if (!VALID_ATLAS_SCIP_LANGUAGES.has(normalized)) continue;
    if (!picked.includes(normalized)) picked.push(normalized);
  }
  return picked.length > 0 ? picked : Array.from(defaultLanguages);
}

/**
 * @param {string[] | string | null | undefined} value
 * @returns {string}
 */
export function formatScipLanguages(value) {
  return normalizeScipLanguages(value).join(",");
}
