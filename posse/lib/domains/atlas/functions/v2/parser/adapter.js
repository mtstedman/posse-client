// @ts-check
//
// Parser parse functions — the contract-conformant ATLAS v2 parsing core.
//
// The boundary between the rest of ATLAS v2 and per-language extraction.
// Everything that needs to turn a file on disk (or a buffer in memory)
// into a ParseResult goes through these pure parsing functions.
//
// Load-bearing responsibilities:
//   - Read file bytes (or accept them) and compute `content_hash`.
//   - Resolve `repo_rel_path` from absolute path + repo root via
//     normalizeRepoPath. THIS is the path-rewriting that the plan
//     identifies as Workstream C's load-bearing change — every symbol
//     and edge that leaves this module carries a canonical repo path,
//     never an absolute one.
//   - Dispatch to the appropriate language extractor via the registry.
//   - Validate the output against the ParseResult contract.

import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "./normalize.js";
import {
  LANGUAGES,
  resolveLanguage,
} from "./languages/index.js";
import { attachLineRanges } from "./languages/common.js";
import { extractBodyIdentifiers } from "./body-identifiers.js";

/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */
/** @typedef {import("../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../contracts/schemas.js").EdgeRow} EdgeRow */

import { parseBufferNative } from "../native/parser.js";

export {
  diffParseBufferNativeParity,
  parseBufferNative,
} from "../native/parser.js";

/**
 * @param {SymbolRow[]} symbols
 * @returns {void}
 */
function assertSymbolsInvariant(symbols) {
  /** @type {Set<number>} */
  const allLocalIds = new Set();
  for (const s of symbols) {
    if (allLocalIds.has(s.local_id)) {
      throw new Error(`Parser produced duplicate local_id ${s.local_id}`);
    }
    allLocalIds.add(s.local_id);
  }
  for (const s of symbols) {
    if (!isCanonicalRepoPath(s.repo_rel_path)) {
      throw new Error(`Parser produced non-canonical path: ${JSON.stringify(s.repo_rel_path)}`);
    }
    if (s.parent_local_id != null && !allLocalIds.has(s.parent_local_id)) {
      throw new Error(
        `Parser produced parent_local_id ${s.parent_local_id} for child ${s.local_id} with no matching symbol`,
      );
    }
  }
}

/**
 * @param {EdgeRow[]} edges
 * @param {Set<number>} validLocalIds
 * @returns {void}
 */
function assertEdgesInvariant(edges, validLocalIds) {
  /** @type {Set<number>} */
  const seenEdgeIds = new Set();
  for (const e of edges) {
    if (seenEdgeIds.has(e.edge_id)) {
      throw new Error(`Parser produced duplicate edge_id ${e.edge_id}`);
    }
    seenEdgeIds.add(e.edge_id);
    if (!validLocalIds.has(e.from_local_id)) {
      throw new Error(
        `Parser produced edge with from_local_id ${e.from_local_id} that has no matching symbol`,
      );
    }
    if (!e.to_name) {
      throw new Error(`Parser produced edge with empty to_name`);
    }
  }
}

/**
 * Build a ParseResult from a pre-read content buffer. Useful for tests
 * and for callers that already have the bytes (avoiding a second read).
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
  const source = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const content_hash = sha256Hex(buf);
  const lang = args.lang ?? inferLangFromPath(repo_rel_path);
  const descriptor = resolveLanguage(lang);
  if (!descriptor) {
    throw new Error(`parseBuffer: unsupported language "${lang}" for ${repo_rel_path}`);
  }
  if (descriptor.native) {
    // Rust-owned extraction. The binary returns the COMPLETE ParseResult —
    // UTF-16 ranges, line numbers, signature hashes, body identifiers —
    // corpus-parity-gated against the deleted JS extractor per language.
    return parseBufferNative({ bytes: buf, repo_rel_path, lang: descriptor.tag });
  }
  const extracted = descriptor.extract({
    content_hash,
    repo_rel_path,
    source,
  });
  const { symbols, edges } = extracted;
  const hasError = extracted.hasError === true;
  // Attach real line anchors. Done here rather than in each language
  // extractor so adding a language can't accidentally regress the
  // line-number invariant — every SymbolRow/EdgeRow that leaves
  // parseBuffer carries `range_start_line` / `range_end_line`.
  attachLineRanges(source, symbols);
  attachLineRanges(source, edges);
  attachBodyIdentifiers(source, symbols);
  assertSymbolsInvariant(symbols);
  assertEdgesInvariant(edges, new Set(symbols.map((s) => s.local_id)));
  return {
    repo_rel_path,
    content_hash,
    lang: descriptor.tag,
    symbols,
    edges,
    hasError,
  };
}

/**
 * @param {string} source
 * @param {SymbolRow[]} symbols
 */
function attachBodyIdentifiers(source, symbols) {
  for (const symbol of symbols) {
    /** @type {any} */ (symbol).body_identifiers = extractBodyIdentifiers(
      source,
      symbol.range_start,
      symbol.range_end,
    );
  }
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
