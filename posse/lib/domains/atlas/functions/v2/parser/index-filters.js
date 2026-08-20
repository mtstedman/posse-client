// @ts-check
//
// Filters applied before the parser sees a file. The goal is to keep
// minified, bundled, or otherwise garbage-symbol-dense files out of the
// ATLAS index — those files contribute thousands of opaque one-letter
// symbols that drown out signal from real code under any lexical encoder.
//
// Two filter layers:
//   * Path-glob skip (cheap; runs at directory-walk time).
//   * Content heuristic (runs at index time on a small leading sample
//     of the file). Used to catch bundles with non-obvious names.
//   * Size ceiling (runs after stat, before full read/parse) for generated
//     or pathological files that otherwise block synchronous tree-sitter work.

const DEFAULT_PATH_PATTERNS = [
  /(^|[\\/])[^/\\]+\.min\.(js|css|mjs|cjs)$/i,
  /(^|[\\/])[^/\\]+-min\.(js|css|mjs|cjs)$/i,
  /(^|[\\/])[^/\\]+\.bundle\.(js|css|mjs|cjs)$/i,
  /(^|[\\/])[^/\\]+-bundle\.(js|css|mjs|cjs)$/i,
  /(^|[\\/])[^/\\]+\.bundle\.[a-z0-9_-]{6,}\.(js|css)$/i,
];
const HASH_NAMED_BUNDLE_RE = /(^|[\\/])(?:dist|bundle)-([A-Za-z0-9_]{6,})\.(js|mjs|cjs)$/i;

// Checked-in golden compiler output is source-shaped but is not source. These
// files commonly concatenate the original fixture, emitted JavaScript, and
// declaration output into one parse unit, producing duplicate symbols and
// synthetic helper noise. Keep this deliberately narrower than a generic
// test/fixture exclusion: ordinary tests remain useful ATLAS evidence.
const GENERATED_GOLDEN_SOURCE_PATHS = [
  /(^|[\\/])tests?[\\/]baselines?[\\/]reference(?:[\\/]|$)/i,
];

// Folded into the view build fingerprint so an installation that gains a new
// source-artifact policy cannot keep serving an exact-OID view built under the
// previous inclusion rules.
export const ATLAS_SOURCE_INDEX_POLICY_VERSION = "source-index-v2-generated-golden";

/**
 * True when a tracked, source-extension file is actually checked-in generated
 * golden output. This is an indexing disposition, not a retrieval prior.
 *
 * @param {string} repoRelPath
 * @returns {boolean}
 */
export function isGeneratedSourceArtifactPath(repoRelPath) {
  if (typeof repoRelPath !== "string" || repoRelPath.length === 0) return false;
  return GENERATED_GOLDEN_SOURCE_PATHS.some((pattern) => pattern.test(repoRelPath));
}

/**
 * Cheap path check — does this filename look like a build output? Runs
 * at directory walk time so we never even stat the file's content.
 *
 * @param {string} repoRelPath Repo-relative path, forward-slash form.
 * @returns {boolean}
 */
export function isLikelyMinifiedPath(repoRelPath) {
  if (typeof repoRelPath !== "string" || repoRelPath.length === 0) return false;
  for (const re of DEFAULT_PATH_PATTERNS) {
    if (re.test(repoRelPath)) return true;
  }
  const hashedBundle = HASH_NAMED_BUNDLE_RE.exec(repoRelPath);
  if (hashedBundle && isHashLikeSuffix(hashedBundle[2])) return true;
  return false;
}

/**
 * @param {string} suffix
 */
function isHashLikeSuffix(suffix) {
  return /\d/.test(suffix) || (suffix.length >= 8 && /[a-z]/.test(suffix) && /[A-Z]/.test(suffix));
}

/**
 * Heuristic check on a leading sample of a file's content. Picks up
 * minified/bundled files that don't follow a `.min.` naming convention.
 *
 * Thresholds are intentionally lenient — we want to skip "single 50KB
 * line of obfuscated JS" but keep "a JSON file with 500-char lines of
 * data." Calibrate by both max and mean: minified bundles fail both.
 *
 * @param {Buffer | string} sample The first ~16KB of the file is plenty.
 * @param {{ maxLineLength?: number, meanLineLength?: number }} [opts]
 * @returns {{ minified: boolean, maxLineLen: number, meanLineLen: number, lineCount: number }}
 */
export function inspectSampleForMinified(sample, opts = {}) {
  const maxLineLength = Number.isFinite(opts.maxLineLength) ? /** @type {number} */ (opts.maxLineLength) : 1000;
  const meanLineLength = Number.isFinite(opts.meanLineLength) ? /** @type {number} */ (opts.meanLineLength) : 300;
  const text = typeof sample === "string" ? sample : sample.toString("utf8");
  let lineCount = 0;
  let maxLineLen = 0;
  let total = 0;
  let runStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      const len = i - runStart - (i > 0 && text.charCodeAt(i - 1) === 13 ? 1 : 0);
      if (len > maxLineLen) maxLineLen = len;
      total += Math.max(0, len);
      lineCount++;
      runStart = i + 1;
    }
  }
  const meanLineLen = lineCount > 0 ? total / lineCount : 0;
  return {
    minified: maxLineLen > maxLineLength || meanLineLen > meanLineLength,
    maxLineLen,
    meanLineLen,
    lineCount,
  };
}

/**
 * Recommended sample size for `inspectSampleForMinified`. 16KB is enough
 * to characterize line shape without paying full-file read cost.
 */
export const MINIFIED_SAMPLE_BYTES = 16 * 1024;

/**
 * Minification checks are a resource guard. Files smaller than the inspection
 * window are cheaper to parse than to permanently exclude, even when a valid
 * fixture or declaration contains one unusually long line.
 *
 * @param {number} byteSize
 */
export function shouldInspectForMinification(byteSize) {
  return Number.isFinite(Number(byteSize)) && Number(byteSize) >= MINIFIED_SAMPLE_BYTES;
}

const MINIFIED_CONTENT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/**
 * The density heuristic models minified JavaScript. Applying it to PHP/TS
 * templates and declaration fixtures mistakes legitimate generated strings
 * and type expressions for bundles.
 *
 * @param {string} repoRelPath
 * @param {number} byteSize
 */
export function shouldInspectSourceForMinification(repoRelPath, byteSize) {
  const normalized = String(repoRelPath || "").replace(/\\/gu, "/");
  const dot = normalized.lastIndexOf(".");
  const extension = dot >= 0 ? normalized.slice(dot).toLowerCase() : "";
  return MINIFIED_CONTENT_EXTENSIONS.has(extension) && shouldInspectForMinification(byteSize);
}

/**
 * Hard ceiling for tree-sitter indexing. Files larger than this are normally
 * generated artifacts or data blobs; skipping them keeps warm jobs responsive.
 */
export const MAX_PARSE_FILE_BYTES = 16 * 1024 * 1024;

/**
 * @param {number} byteSize
 */
export function isOversizedForParsing(byteSize) {
  return Number.isFinite(Number(byteSize)) && Number(byteSize) > MAX_PARSE_FILE_BYTES;
}
