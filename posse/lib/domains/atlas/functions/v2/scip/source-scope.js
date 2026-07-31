// @ts-check

import path from "node:path";
import { languageTagForExtension } from "../language-tag.js";
import { resolveLanguage } from "../parser/languages/index.js";
import { scipBasenameSourceLanguages } from "../scip-progress.js";

/**
 * Restrict an artifact's coverage declaration to paths owned by its source
 * languages. Inputs may be source tags (`ts`, `py`) or configured indexer
 * identities (`typescript`, `python`). An empty/unknown language list carries
 * no explicit scope; decoded SCIP document languages remain the safe fallback.
 *
 * @param {string[]} paths
 * @param {string[]} sourceLanguages
 * @returns {string[]}
 */
export function scopePathsForScipSourceLanguages(paths, sourceLanguages) {
  const values = Array.isArray(paths) ? paths.map((value) => String(value || "")).filter(Boolean) : [];
  const languages = normalizedSourceLanguageTags(sourceLanguages);
  if (languages.size === 0) return [];
  return values.filter((repoRelPath) => {
    const language = languageTagForExtension(path.extname(repoRelPath).toLowerCase());
    return language ? languages.has(language) : false;
  });
}

/**
 * Attach an artifact's explicit path scope to decoded coverage. Startup
 * snapshots are provisional because a current restage still follows; they may
 * contribute present documents but must not make irreversible absence claims.
 *
 * @param {{
 *   documents: Array<{ repo_rel_path: string, content_hash: string }>,
 *   source_languages: string[],
 *   scope_paths?: string[],
 *   [key: string]: any,
 * }} coverage
 * @param {{ scopePaths?: string[], terminalizeAbsent?: boolean }} [opts]
 * @returns {{
 *   documents: Array<{ repo_rel_path: string, content_hash: string }>,
 *   source_languages: string[],
 *   scope_paths?: string[],
 *   [key: string]: any,
 * }}
 */
export function scipCoverageForIntake(coverage, opts = {}) {
  if (opts.terminalizeAbsent === false) {
    return {
      ...coverage,
      source_languages: [],
      scope_paths: [],
    };
  }
  const scopePaths = (Array.isArray(opts.scopePaths) ? opts.scopePaths : [])
    .map((repoRelPath) => String(repoRelPath || ""))
    .filter(Boolean);
  return {
    ...coverage,
    ...(scopePaths.length > 0 ? { scope_paths: scopePaths } : {}),
  };
}

function normalizedSourceLanguageTags(sourceLanguages) {
  const languages = new Set();
  for (const value of Array.isArray(sourceLanguages) ? sourceLanguages : []) {
    const language = String(value || "").trim().toLowerCase();
    if (!language) continue;
    const descriptor = resolveLanguage(language);
    if (descriptor?.tag === language) {
      languages.add(language);
      continue;
    }
    for (const tag of scipBasenameSourceLanguages(`${language}.scip`)) languages.add(tag);
  }
  return languages;
}
