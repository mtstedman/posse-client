// lib/shared/format/functions/display-paths.js
//
// Canonical helpers for paths shown to agents and humans: tool results, error
// text, prompts, and structured result fields. Consolidates the per-module
// relativization helpers that previously lived in protected-paths.js
// (relativePathFromCwd), toolkit/ripgrep.js (normalizeRelPath),
// toolkit/scoped-runners.js (relPath), and deterministic-mcp/source-file-gate.js
// (normalizeAbsolutePath).
//
// Display formatting only. Scope and lock *comparison* keeps its own rules in
// lib/shared/scope/functions/path.js — normPath lowercases on Windows so NTFS
// case variants collide, which must never appear in displayed paths. Never use
// these helpers for authorization decisions.
//
// Windows handling is driven by the value, not the host platform: payloads and
// DB rows written on Windows (drive-letter or UNC roots) must still resolve
// when the orchestrator processes them on Linux/macOS, so any Windows-rooted
// input selects path.win32 explicitly.

import path from "node:path";

const WINDOWS_PATH_ROOT_RE = /^[a-zA-Z]:[\\/]|^\\\\/;

// hasWindowsPathRoot("C:\\dev\\x") → true
// hasWindowsPathRoot("\\\\server\\share") → true (UNC)
// hasWindowsPathRoot("/home/x") → false
export function hasWindowsPathRoot(value) {
  return WINDOWS_PATH_ROOT_RE.test(String(value || ""));
}

// Separator normalization only — no resolution, no trimming of segments.
export function normalizeDisplaySlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function pathApiFor(...values) {
  return values.some((value) => hasWindowsPathRoot(value)) ? path.win32 : path;
}

function resolveWithRoot(cwd, value) {
  const raw = String(value || "").trim();
  const root = String(cwd || "").trim();
  if (!raw || !root) return null;
  const api = pathApiFor(raw, root);
  const resolvedRoot = api.resolve(root);
  const resolved = api.isAbsolute(raw) || hasWindowsPathRoot(raw)
    ? api.resolve(raw)
    : api.resolve(resolvedRoot, raw);
  return { api, resolvedRoot, resolved };
}

/**
 * Strict root-relative conversion: the forward-slashed path of `value` inside
 * `cwd`, or null when the value is empty, equals the root, or falls outside
 * it. The null contract doubles as an outside-root filter — callers that must
 * drop or reject escapees rely on it.
 *
 * @param {string} cwd
 * @param {string} value absolute path, or relative (resolved against cwd)
 * @returns {string|null}
 */
// toRepoRelativePath("/repo", "/repo/src/a.js") → "src/a.js"
// toRepoRelativePath("/repo", "src/a.js") → "src/a.js"
// toRepoRelativePath("/repo", "/repo") → null (root itself)
// toRepoRelativePath("/repo", "/other/a.js") → null (outside)
// toRepoRelativePath("C:\\repo", "C:\\repo\\src\\a.js") → "src/a.js"
export function toRepoRelativePath(cwd, value) {
  const ctx = resolveWithRoot(cwd, value);
  return ctx ? repoRelativeFromContext(ctx) : null;
}

function repoRelativeFromContext(ctx) {
  const rel = ctx.api.relative(ctx.resolvedRoot, ctx.resolved).replace(/\\/g, "/");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || ctx.api.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Lenient display conversion: root-relative inside `cwd`, "." for the root
 * itself, and the forward-slashed absolute path outside it (authorized
 * external roots stay canonical). Returns "" only for empty input.
 *
 * @param {string} cwd
 * @param {string} value
 * @returns {string}
 */
// toDisplayPath("/repo", "/repo/src/a.js") → "src/a.js"
// toDisplayPath("/repo", "/repo") → "."
// toDisplayPath("/repo", "/other/a.js") → "/other/a.js"
// toDisplayPath(null, "C:\\x\\a.js") → "C:/x/a.js"
export function toDisplayPath(cwd, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const ctx = resolveWithRoot(cwd, raw);
  if (!ctx) return normalizeDisplaySlashes(raw);
  if (ctx.resolved === ctx.resolvedRoot) return ".";
  const rel = repoRelativeFromContext(ctx);
  return rel != null ? rel : normalizeDisplaySlashes(ctx.resolved);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite absolute references to `cwd` inside free-form text — fs error
 * messages (ENOENT: ... open '/abs/...'), subprocess stderr, linter output —
 * to root-relative form. `cwd`-prefixed paths lose the prefix; a bare mention
 * of the root becomes ".". Paths under *other* roots (siblings, tmpdir) are
 * left untouched; deciding their fate belongs to the call site, not a blanket
 * scrubber.
 *
 * @param {string} text
 * @param {string} cwd
 * @returns {string}
 */
// sanitizeAbsolutePathsInText("ENOENT: open '/repo/src/a.js'", "/repo")
//   → "ENOENT: open 'src/a.js'"
// sanitizeAbsolutePathsInText("in /repo", "/repo") → "in ."
// sanitizeAbsolutePathsInText("in /repo-wt2/a.js", "/repo") → unchanged
// sanitizeAbsolutePathsInText("in /repo.git", "/repo") → unchanged (dot sibling)
// JSON-stringified text round-trips: a "\n" or "\"" escape after the root is
// never treated as a path separator.
const sanitizePatternsByRoot = new Map();

function sanitizePatternsFor(root) {
  let patterns = sanitizePatternsByRoot.get(root);
  if (patterns) return patterns;
  const api = pathApiFor(root);
  const resolvedRoot = api.resolve(root);
  const winRoot = hasWindowsPathRoot(resolvedRoot);
  const jsonEscapedVariant = winRoot
    ? normalizeDisplaySlashes(resolvedRoot).replace(/\//g, "\\\\")
    : null;
  const variants = new Set([root, resolvedRoot, normalizeDisplaySlashes(resolvedRoot)]);
  if (winRoot) {
    variants.add(normalizeDisplaySlashes(resolvedRoot).replace(/\//g, "\\"));
    // JSON-serialized text escapes backslashes; cover that form so scrubbing a
    // stringified payload works too.
    variants.add(jsonEscapedVariant);
  }
  const flags = winRoot ? "gi" : "g";
  patterns = [...variants].filter(Boolean).sort((a, b) => b.length - a.length).map((variant) => {
    const escaped = escapeRegExp(variant);
    // Separator set matches the variant's own form: a lone backslash after a
    // POSIX or JSON-escaped root is a JSON escape sequence (\n, \"), and
    // consuming it corrupts stringified payloads.
    const separator = variant === jsonEscapedVariant
      ? "(?:\\\\\\\\|/)+"
      : winRoot ? "[\\\\/]+" : "/+";
    return {
      // Prefix of a longer path: drop the root and its separator.
      prefix: new RegExp(`${escaped}${separator}`, flags),
      // Bare mention of the root (followed by a delimiter, not a sibling like
      // /repo-wt2): becomes ".". A "." only delimits as punctuation — when a
      // word character follows it names a sibling like /repo.git. A backslash
      // delimits so JSON-escaped delimiters (\n, \") after the root count.
      bare: new RegExp(`${escaped}(?=[\\s"'\`)\\]}>,;:]|\\.(?![\\w-])|\\\\|$)`, flags),
    };
  });
  // Roots are session-constant in practice; the cap only guards pathological
  // callers cycling many distinct roots.
  if (sanitizePatternsByRoot.size >= 64) sanitizePatternsByRoot.clear();
  sanitizePatternsByRoot.set(root, patterns);
  return patterns;
}

export function sanitizeAbsolutePathsInText(text, cwd) {
  const value = String(text ?? "");
  const root = String(cwd || "").trim();
  if (!value || !root) return value;
  let out = value;
  for (const { prefix, bare } of sanitizePatternsFor(root)) {
    out = out.replace(prefix, "");
    out = out.replace(bare, ".");
  }
  return out;
}
