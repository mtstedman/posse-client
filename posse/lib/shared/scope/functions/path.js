// Shared scope path utilities.
//
// Single authoritative module for path normalization and scope checking.
// Replaces five separate isUnderRoot implementations and three normPath
// duplicates across worker.js, openai.js, assessor.js, and scheduler.js.

import path from "node:path";
export {
  isInsideRoot,
  isPathInside,
  resolvePathWithin,
} from "../../../domains/runtime/functions/fs-safety.js";

/**
 * Normalize a path for scope comparison.
 * - Converts backslashes to forward slashes
 * - Strips leading "./"
 * - Trims whitespace
 * - Returns empty string for null/undefined
 *
 * @param {string} p
 * @returns {string}
 */
// normPath("src\\providers\\foo.js") → "src/providers/foo.js"
// normPath("./src/file.js") → "src/file.js"
// normPath(null) → ""
// normPath(undefined) → ""
// normPath("  src/file.js  ") → "src/file.js"
// On Windows the result is lowercased so scope/lock comparisons treat
// "src/Foo.js" and "src/foo.js" as the same file (NTFS is case-insensitive).
// Without this, two jobs scoping the same file with different casing do not
// detect each other in file_locks and can write concurrently.
export function normPath(p) {
  if (p == null) return "";
  const value = pathValue(p);
  if (value == null) return "";
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/").trim());
  const stripped = normalized.replace(/^\.\//, "");
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function pathValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  for (const key of ["path", "file", "file_path", "filepath"]) {
    const candidate = value[key];
    if (candidate != null && String(candidate).trim()) return candidate;
  }
  return null;
}

/**
 * Pre-process an array of create_roots into normalized relative paths
 * suitable for isUnderRoot.
 *
 * 1. Filters out falsy values, ".", and empty strings
 * 2. Applies normPath to each root
 * 3. Strips trailing slashes
 * 4. Converts absolute paths to relative using path.relative(cwd, root)
 * 5. If the relative result is "" or "." (root equals cwd), replaces with "*"
 *
 * @param {string[]} roots
 * @param {string} [cwd=process.cwd()]
 * @returns {string[]}
 */
// normalizeRoots(["C:/dev/project/out"], "C:/dev/project") → ["out"]
// normalizeRoots(["C:/dev/project"], "C:/dev/project") → ["*"]
// normalizeRoots(["./src", "", ".", null], "/any") → ["src"]
export function normalizeRoots(roots, cwd = process.cwd()) {
  if (!Array.isArray(roots)) return [];
  return roots
    .map(r => {
      if (!r) return "";
      const raw = String(r).trim();
      const isAbsolute = path.isAbsolute(raw);
      if (raw === ".") return "*";
      let n = normPath(r);
      // Strip trailing slash
      n = n.replace(/\/+$/, "");
      // Convert absolute paths to relative
      if (isAbsolute) {
        n = normPath(path.relative(cwd, r));
        // Strip trailing slash again after relative conversion
        n = n.replace(/\/+$/, "");
      }
      if (n === ".." || n.startsWith("../") || path.isAbsolute(n)) return "";
      // Root equals cwd → wildcard sentinel
      if (n === "" || n === ".") return "*";
      return n;
    })
    .filter(r => r !== "");
}

function isCwdOrDescendantPath(filePath) {
  return filePath === "" || filePath === "." || (
    !filePath.startsWith("../")
    && filePath !== ".."
    && !path.isAbsolute(filePath)
  );
}

/**
 * Check if a normalized file path falls within any of the given root
 * directories. The roots MUST be pre-processed by normalizeRoots.
 *
 * Matching rules (in order):
 *   1. If any root is "*", return true (wildcard — root equals cwd)
 *   2. Prefix match: filePath starts with root + "/"
 *   3. Exact match: filePath === root (handles file at root path itself)
 *
 * The filePath argument should already be normalized via normPath.
 * This function does NOT normalize internally — callers must normalize
 * before calling. This keeps the function pure and fast.
 *
 * @param {string} filePath - Normalized file path
 * @param {string[]} normalizedRoots - Roots from normalizeRoots()
 * @returns {boolean}
 */
// isUnderRoot("src/providers/foo.js", ["src/providers"]) → true (prefix)
// isUnderRoot("output", ["output"]) → true (exact match)
// isUnderRoot("anything.js", ["*"]) → true (wildcard)
// isUnderRoot("other/file.js", ["src/providers"]) → false
export function isUnderRoot(filePath, normalizedRoots) {
  for (const root of normalizedRoots) {
    if (root === "*") return isCwdOrDescendantPath(filePath);
    const prefix = root + "/";
    if (filePath.startsWith(prefix)) return true;
    if (filePath === root) return true;
  }
  return false;
}

export function rootsOverlap(leftRoot, rightRoot) {
  if (!leftRoot || !rightRoot) return false;
  if (leftRoot === "*" && rightRoot === "*") return true;
  if (leftRoot === "*") return isCwdOrDescendantPath(rightRoot);
  if (rightRoot === "*") return isCwdOrDescendantPath(leftRoot);
  return isUnderRoot(leftRoot, [rightRoot]) || isUnderRoot(rightRoot, [leftRoot]);
}
