// @ts-check
//
// Language registry. Maps file extensions and language tags to the
// extractor that produces SymbolRow/EdgeRow arrays from a source string.
//
// Every entry in `LANGUAGES` must produce SymbolRow.lang values matching
// its `tag` field. Adding a language: add an entry here, write the
// extractor under ./<lang>.js, and add a fixture to
// test/fixtures/atlas-v2-parser/.

import { extract as extractJsTs } from "./javascript.js";
import { extract as extractPython } from "./python.js";
import { extract as extractGo } from "./go.js";
import { extract as extractRust } from "./rust.js";
import { extract as extractJava } from "./java.js";
import { extract as extractCSharp } from "./csharp.js";
import { extract as extractPhp } from "./php.js";
import { extract as extractKotlin } from "./kotlin.js";
import { extract as extractShell } from "./shell.js";
import { extract as extractC } from "./c.js";
import { extract as extractCpp } from "./cpp.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */

/**
 * @typedef {(args: {
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 * }) => { symbols: SymbolRow[], edges: EdgeRow[], hasError?: boolean }} ExtractFn
 */

/**
 * @typedef {Object} LanguageDescriptor
 * @property {string} tag                 Lowercase language tag, matches SymbolRow.lang.
 * @property {string[]} extensions        Lowercase, leading "." preserved (e.g. ".ts").
 * @property {ExtractFn} extract
 * @property {boolean} supported          False for placeholder languages that throw.
 */

/** @type {LanguageDescriptor[]} */
export const LANGUAGES = [
  {
    tag: "ts",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    extract: (args) => extractJsTs({ ...args, lang: "ts", parserLang: jsParserLangForPath(args.repo_rel_path, "ts") }),
    supported: true,
  },
  {
    tag: "js",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    extract: (args) => extractJsTs({ ...args, lang: "js", parserLang: jsParserLangForPath(args.repo_rel_path, "js") }),
    supported: true,
  },
  { tag: "py", extensions: [".py", ".pyi"], extract: extractPython, supported: true },
  { tag: "go", extensions: [".go"], extract: extractGo, supported: true },
  { tag: "rs", extensions: [".rs"], extract: extractRust, supported: true },
  { tag: "java", extensions: [".java"], extract: extractJava, supported: true },
  { tag: "cs", extensions: [".cs"], extract: extractCSharp, supported: true },
  {
    tag: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    extract: extractCpp,
    supported: true,
  },
  { tag: "c", extensions: [".c", ".h"], extract: extractC, supported: true },
  { tag: "php", extensions: [".php"], extract: extractPhp, supported: true },
  { tag: "kt", extensions: [".kt", ".kts"], extract: extractKotlin, supported: true },
  { tag: "sh", extensions: [".sh", ".bash"], extract: extractShell, supported: true },
];

/** Lower-cased extension → descriptor index. Built once at import. */
const extIndex = (() => {
  /** @type {Map<string, LanguageDescriptor>} */
  const m = new Map();
  for (const d of LANGUAGES) for (const e of d.extensions) m.set(e, d);
  return m;
})();

const tagIndex = (() => {
  /** @type {Map<string, LanguageDescriptor>} */
  const m = new Map();
  for (const d of LANGUAGES) m.set(d.tag, d);
  return m;
})();

/**
 * Resolve a descriptor by either a file extension (".ts") or a language
 * tag ("ts"). Returns null when neither matches a registered entry.
 *
 * @param {string} extOrLang
 * @returns {LanguageDescriptor | null}
 */
export function resolveLanguage(extOrLang) {
  if (!extOrLang) return null;
  const lower = extOrLang.toLowerCase();
  if (lower.startsWith(".")) return extIndex.get(lower) ?? null;
  return tagIndex.get(lower) ?? extIndex.get(`.${lower}`) ?? null;
}

/**
 * @returns {string[]}
 */
export function supportedLanguageTags() {
  return LANGUAGES.filter((d) => d.supported).map((d) => d.tag);
}

/**
 * @returns {string[]}
 */
export function allRegisteredLanguageTags() {
  return LANGUAGES.map((d) => d.tag);
}

/**
 * JSX-bearing files need the TSX grammar even when the public ATLAS language
 * tag remains "ts" or "js".
 *
 * @param {string} repoRelPath
 * @param {"js" | "ts"} fallback
 * @returns {"js" | "ts" | "tsx"}
 */
function jsParserLangForPath(repoRelPath, fallback) {
  const lower = String(repoRelPath || "").toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "tsx";
  return fallback;
}
