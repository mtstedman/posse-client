// @ts-check
//
// Shared ATLAS path hygiene helpers. These are intentionally conservative:
// generated-path penalties can hide source files from default retrieval.

const GENERATED_PATH_RE = /(^|\/)(routeTree\.gen\.ts|generated|dist|build|coverage|\.next)(\/|$)/i;
const GENERATED_FILE_RE = /(^|\/).*\.generated\.[^.]+$/i;
const GEN_FILE_RE = /(^|\/).*\.gen\.[cm]?[jt]sx?$/i;
const HASHED_JS_RE = /(^|\/)[^/]+-([A-Za-z0-9_]{6,})\.js$/;
const ASSET_CHUNK_RE = /(^|\/)assets\/chunk\.[cm]?[jt]sx?$/i;

/**
 * @param {string} repoRelPath
 * @returns {boolean}
 */
export function isGeneratedPath(repoRelPath) {
  const p = String(repoRelPath || "").replace(/\\/g, "/");
  if (GENERATED_PATH_RE.test(p)) return true;
  if (GENERATED_FILE_RE.test(p)) return true;
  if (GEN_FILE_RE.test(p)) return true;
  if (ASSET_CHUNK_RE.test(p)) return true;
  const hashed = HASHED_JS_RE.exec(p);
  return !!hashed && isHashLikeSuffix(hashed[2]);
}

/**
 * @param {string} suffix
 * @returns {boolean}
 */
export function isHashLikeSuffix(suffix) {
  const text = String(suffix || "");
  if (!text) return false;
  if (text.length >= 8 && /[a-z]/.test(text) && /[A-Z]/.test(text)) return true;
  return /^[a-f0-9]{6,}$/i.test(text) && /\d/.test(text) && /[a-f]/i.test(text);
}
