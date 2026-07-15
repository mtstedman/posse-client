// @ts-check
//
// Parser boundary for the Rust-owned ATLAS v2 parsing core.

import { isCanonicalRepoPath } from "./normalize.js";
import {
  LANGUAGES,
  resolveLanguage,
} from "./languages/index.js";

/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */

import { parseBufferNative } from "../native/parser.js";

/**
 * Parse a pre-read content buffer through the native parser.
 *
 * `lang` overrides the language inferred from the path extension.
 *
 * @param {{
 *   bytes: Buffer | string,
 *   repo_rel_path: string,
 *   lang?: string,
 * }} args
 * @returns {Promise<ParseResult>}
 */
export async function parseBuffer(args) {
  const { bytes, repo_rel_path } = args;
  if (!isCanonicalRepoPath(repo_rel_path)) {
    throw new RangeError(
      `parseBuffer: repo_rel_path must be canonical, got ${JSON.stringify(repo_rel_path)}`,
    );
  }
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const lang = args.lang ?? inferLangFromPath(repo_rel_path);
  const descriptor = resolveLanguage(lang);
  if (!descriptor) {
    throw new Error(`parseBuffer: unsupported language "${lang}" for ${repo_rel_path}`);
  }
  return parseBufferNative({ bytes: buf, repo_rel_path, lang: descriptor.tag });
}

/**
 * Infer a language tag from a canonical repo-relative path's extension.
 * Throws when the extension is not registered.
 *
 * @param {string} repo_rel_path
 * @returns {string}
 */
function inferLangFromPath(repo_rel_path) {
  const dot = repo_rel_path.lastIndexOf(".");
  const ext = dot >= 0 ? repo_rel_path.slice(dot).toLowerCase() : "";
  const descriptor = resolveLanguage(ext);
  if (!descriptor) {
    throw new Error(
      `inferLangFromPath: no language for extension "${ext}" (path: ${repo_rel_path})`,
    );
  }
  return descriptor.tag;
}

/**
 * Lower-level export for callers that want to inspect or extend the
 * registry from outside the parser module.
 */
export { LANGUAGES };
