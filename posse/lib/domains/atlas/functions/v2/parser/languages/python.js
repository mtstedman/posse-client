// @ts-check
//
// Python symbol extractor. Tree-sitter backed via the shared walker.
// Mirrors atlas-mcp's Python adapter.

import { extractWithTreeSitter } from "../treesitter/walker.js";
import { pythonSpec } from "../treesitter/spec-python.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */

/**
 * @param {{
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 * }} args
 * @returns {{ symbols: SymbolRow[], edges: EdgeRow[] }}
 */
export function extract(args) {
  return extractWithTreeSitter({
    content_hash: args.content_hash,
    repo_rel_path: args.repo_rel_path,
    source: args.source,
    spec: pythonSpec(),
  });
}
