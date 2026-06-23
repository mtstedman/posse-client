// @ts-check
//
// ATLAS v2 language-tag helper. Pure mapping from a file extension to the
// source-language tag used by ATLAS progress reporting. Intentionally
// preserves JS vs TS (`js` vs `ts`) even when a single SCIP indexer process
// covers both.

import { resolveLanguage } from "./parser/languages/index.js";

/**
 * Map a file extension (with leading dot, lowercased) to the source-language
 * tag used by ATLAS progress.
 *
 * @param {string} ext
 * @returns {string | null}
 */
export function languageTagForExtension(ext) {
  if (!ext) return null;
  const descriptor = resolveLanguage(ext);
  return descriptor?.tag || null;
}
