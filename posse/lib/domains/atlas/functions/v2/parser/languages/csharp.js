// @ts-check
import { extractWithTreeSitter } from "../treesitter/walker.js";
import { csharpSpec } from "../treesitter/spec-csharp.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */

/**
 * @param {{ content_hash: string, repo_rel_path: string, source: string }} args
 * @returns {{ symbols: SymbolRow[], edges: EdgeRow[] }}
 */
export function extract(args) {
  return extractWithTreeSitter({ ...args, spec: csharpSpec() });
}
