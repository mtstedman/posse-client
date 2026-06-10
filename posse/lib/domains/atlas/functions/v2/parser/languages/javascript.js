// @ts-check
//
// JavaScript / TypeScript symbol extractor.
//
// Tree-sitter backed via the shared walker. The previous regex
// implementation lived here; we kept its name + ABI
// (`extract({ args, lang })`) so the language registry doesn't change.
//
// Behavior parity targets atlas-mcp's TypeScriptAdapter
// (extractSymbols + extractImports + extractCalls) — same node types,
// same edge kinds. Differences are bugs.

import { extractWithTreeSitter } from "../treesitter/walker.js";
import { jsSpec } from "../treesitter/spec-javascript.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */

/**
 * @param {{
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 *   lang: "js" | "ts",
 *   parserLang?: "js" | "ts" | "tsx",
 * }} args
 * @returns {{ symbols: SymbolRow[], edges: EdgeRow[] }}
 */
export function extract(args) {
  const spec = jsSpec(args.lang);
  return extractWithTreeSitter({
    content_hash: args.content_hash,
    repo_rel_path: args.repo_rel_path,
    source: args.source,
    spec: {
      ...spec,
      parserLang: args.parserLang || args.lang,
    },
  });
}
