// @ts-check
//
// Path canonicalization for ATLAS v2. Every path that enters the ledger or
// a view must pass through these helpers. See contracts/schemas.js header
// for the precise definition of the canonical form.

import path from "path";

/**
 * Normalize an input string to the canonical ATLAS v2 repo-relative form,
 * or return "" if the input cannot be coerced safely (absolute path,
 * escapes the repo, empty after trim, etc.). Callers must check for ""
 * and skip/reject.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRepoPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  // Convert backslashes to forward slashes first so Windows-style inputs work.
  const slashed = trimmed.replace(/\\/g, "/");
  // Strip leading "./" repeatedly.
  let stripped = slashed;
  while (stripped.startsWith("./")) stripped = stripped.slice(2);
  // Collapse trailing slashes.
  stripped = stripped.replace(/\/+$/, "");
  if (!stripped || stripped === "." || stripped === "..") return "";
  if (stripped.startsWith("../")) return "";
  if (path.posix.isAbsolute(stripped)) return "";
  // Detect Windows-absolute even after slash conversion (e.g. "C:/...").
  if (/^[a-zA-Z]:\//.test(stripped)) return "";
  // No interior "/.." segments.
  if (stripped.split("/").some((seg) => seg === "..")) return "";
  return stripped;
}

/**
 * Returns true if `value` is already in canonical form. Intended for
 * assertions at trust boundaries — producers normalize, consumers can
 * assert.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isCanonicalRepoPath(value) {
  if (typeof value !== "string") return false;
  return value === normalizeRepoPath(value) && value.length > 0;
}

/**
 * Convert an absolute path + repo root into a canonical repo-relative
 * path. Returns "" on any condition that would yield a non-canonical
 * result (path escapes root, exact equal to root, etc.).
 *
 * @param {string} absPath
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoRelativeFromAbsolute(absPath, repoRoot) {
  if (!absPath || !repoRoot) return "";
  const rel = path.relative(path.resolve(repoRoot), path.resolve(absPath));
  return normalizeRepoPath(rel);
}
