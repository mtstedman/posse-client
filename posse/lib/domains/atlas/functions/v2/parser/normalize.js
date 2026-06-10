// @ts-check
//
// Parser-side path normalization. Thin wrapper over the repo-wide
// `paths.js` helpers, exposed at the parser boundary so language adapters
// have a single import for canonical-path operations.
//
// Producers (language adapters) MUST normalize every path they emit
// through these helpers. Consumers (Indexer, View builder, retrieval)
// rely on every SymbolRow/EdgeRow carrying canonical paths.

import path from "path";
import {
  normalizeRepoPath,
  isCanonicalRepoPath,
  repoRelativeFromAbsolute,
} from "../paths.js";

export { normalizeRepoPath, isCanonicalRepoPath, repoRelativeFromAbsolute };

/**
 * Assert that `value` is a canonical repo-relative path, throwing a
 * descriptive RangeError otherwise. Use at producer boundaries where a
 * non-canonical path is a programmer error rather than user input.
 *
 * @param {string} value
 * @param {string} [label]   Optional label for the error message.
 * @returns {string}
 */
export function assertCanonical(value, label = "path") {
  if (!isCanonicalRepoPath(value)) {
    throw new RangeError(
      `${label} must be a canonical repo-relative path, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Resolve `absPath` relative to `repoRoot` and return the canonical form,
 * throwing if it would not be valid (escapes root, equals root, absolute
 * after relative-resolve, etc.). The throwing variant is appropriate at
 * the adapter boundary where the input came from a trusted caller.
 *
 * @param {string} absPath
 * @param {string} repoRoot
 * @returns {string}
 */
export function canonicalRepoPathOrThrow(absPath, repoRoot) {
  if (!absPath || typeof absPath !== "string") {
    throw new RangeError("canonicalRepoPathOrThrow: absPath is required");
  }
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new RangeError("canonicalRepoPathOrThrow: repoRoot is required");
  }
  const resolved = path.resolve(absPath);
  const root = path.resolve(repoRoot);
  if (resolved === root) {
    throw new RangeError(
      `canonicalRepoPathOrThrow: path equals repoRoot (${JSON.stringify(absPath)})`,
    );
  }
  const rel = repoRelativeFromAbsolute(resolved, root);
  if (!rel) {
    throw new RangeError(
      `canonicalRepoPathOrThrow: ${JSON.stringify(absPath)} is not inside ${JSON.stringify(repoRoot)}`,
    );
  }
  return rel;
}
