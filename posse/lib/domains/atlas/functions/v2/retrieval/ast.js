// @ts-check
//
// Shared tree-sitter helpers for retrieval tools. Parser ingestion has its
// own walker because it emits ledger rows; this module is for read-time tools
// like code.skeleton and code.lens that need AST structure plus
// source/line utilities.

import fs from "fs";
import path from "path";
import { resolveLanguage } from "../parser/languages/index.js";
import { parserFor, loadFailureFor } from "../parser/treesitter/loader.js";
import { normalizeRepoPath } from "../paths.js";

/** @typedef {import("../parser/treesitter/walker.js").TsNode} TsNode */

/**
 * @typedef {Object} RetrievalAstDocument
 * @property {string} repoRelPath
 * @property {string} absPath
 * @property {string} lang
 * @property {string} source
 * @property {any} tree
 * @property {TsNode} root
 * @property {boolean} hasError
 * @property {number[]} lineStarts
 */

/**
 * @typedef {Object} RetrievalAstOk
 * @property {true} ok
 * @property {RetrievalAstDocument} doc
 */

/**
 * @typedef {Object} RetrievalAstError
 * @property {false} ok
 * @property {"invalid_path" | "unsupported_language" | "parser_unavailable" | "read_failed" | "parse_failed"} errorCode
 * @property {string} message
 * @property {string} [degradedReason]
 */

/**
 * @param {{
 *   repoRoot?: string,
 *   file: string,
 *   source?: string | Buffer,
 *   lang?: string,
 * }} args
 * @returns {RetrievalAstOk | RetrievalAstError}
 */
export function parseRetrievalAst(args) {
  const repoRelPath = normalizeRepoPath(args.file);
  if (!repoRelPath) {
    return {
      ok: false,
      errorCode: "invalid_path",
      message: `Invalid repo-relative path: ${JSON.stringify(args.file)}`,
    };
  }
  const absPath = args.repoRoot ? path.join(args.repoRoot, repoRelPath) : repoRelPath;
  const lang = resolveTreeSitterLang(repoRelPath, args.lang);
  if (!lang) {
    return {
      ok: false,
      errorCode: "unsupported_language",
      message: `No tree-sitter language is registered for ${repoRelPath}`,
    };
  }
  const parser = parserFor(lang);
  if (!parser) {
    const reason = loadFailureFor(lang) || "grammar_unavailable";
    return {
      ok: false,
      errorCode: "parser_unavailable",
      degradedReason: reason,
      message: `tree-sitter parser unavailable for lang=${lang}: ${reason}`,
    };
  }

  let source;
  try {
    source = args.source == null
      ? fs.readFileSync(absPath, "utf8")
      : Buffer.isBuffer(args.source)
        ? args.source.toString("utf8")
        : String(args.source);
  } catch (err) {
    return {
      ok: false,
      errorCode: "read_failed",
      message: `Could not read ${repoRelPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const tree = parser.parse(source);
    const root = /** @type {TsNode} */ (tree.rootNode);
    return {
      ok: true,
      doc: {
        repoRelPath,
        absPath,
        lang,
        source,
        tree,
        root,
        hasError: rootHasError(root),
        lineStarts: computeLineStarts(source),
      },
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "parse_failed",
      message: `Could not parse ${repoRelPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * @param {string} repoRelPath
 * @param {string} [lang]
 * @returns {string | null}
 */
export function resolveTreeSitterLang(repoRelPath, lang) {
  if (lang) {
    const normalized = String(lang).trim().toLowerCase();
    if (normalized) return normalized;
  }
  const ext = path.extname(repoRelPath).toLowerCase();
  if (ext === ".tsx") return "tsx";
  const descriptor = resolveLanguage(ext);
  return descriptor?.tag || null;
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {(node: TsNode) => false | void} visitor
 * @param {{ skipTypes?: Set<string> }} [opts]
 * @returns {void}
 */
export function walkAst(doc, visitor, opts = {}) {
  const skipTypes = opts.skipTypes || new Set();
  const visit = (node) => {
    const result = visitor(node);
    if (result === false || skipTypes.has(node.type)) return;
    for (const child of node.children || []) visit(child);
  };
  visit(doc.root);
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {string | Set<string> | string[]} types
 * @returns {TsNode[]}
 */
export function findNodesByType(doc, types) {
  const wanted = types instanceof Set ? types : new Set(Array.isArray(types) ? types : [types]);
  /** @type {TsNode[]} */
  const nodes = [];
  walkAst(doc, (node) => {
    if (wanted.has(node.type)) nodes.push(node);
  });
  return nodes;
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @returns {{ startLine: number, endLine: number }}
 */
export function lineRangeForNode(doc, node) {
  return {
    startLine: lineForIndex(doc.lineStarts, node.startIndex),
    endLine: lineForIndex(doc.lineStarts, Math.max(node.startIndex, node.endIndex - 1)),
  };
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {number} startLine
 * @param {number} endLine
 * @returns {string}
 */
export function sourceLines(doc, startLine, endLine) {
  const lines = doc.source.split(/\r?\n/);
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.floor(endLine));
  return lines.slice(start - 1, end).join("\n");
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @returns {string}
 */
export function nodeText(doc, node) {
  return doc.source.slice(node.startIndex, node.endIndex);
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {{ namedOnly?: boolean }} [opts]
 * @returns {TsNode}
 */
export function smallestNodeCoveringRange(doc, startIndex, endIndex, opts = {}) {
  const start = Math.max(0, Math.floor(startIndex));
  const end = Math.max(start, Math.floor(endIndex));
  let best = doc.root;
  walkAst(doc, (node) => {
    if (node.startIndex > start || node.endIndex < end) return false;
    if (opts.namedOnly && /** @type {any} */ (node).isNamed === false) return;
    const bestWidth = best.endIndex - best.startIndex;
    const nodeWidth = node.endIndex - node.startIndex;
    if (nodeWidth <= bestWidth) best = node;
  });
  return best;
}

/**
 * @param {string} source
 * @returns {number[]}
 */
export function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * @param {number[]} lineStarts
 * @param {number} index
 * @returns {number}
 */
export function lineForIndex(lineStarts, index) {
  const target = Math.max(0, Math.floor(index));
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= target) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

/**
 * @param {TsNode} root
 * @returns {boolean}
 */
function rootHasError(root) {
  return Boolean(/** @type {any} */ (root).hasError);
}
