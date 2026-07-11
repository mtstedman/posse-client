// @ts-check
//
// Language registry. Maps file extensions and language tags to the
// extractor that produces SymbolRow/EdgeRow arrays from a source string.
//
// Every entry in `LANGUAGES` must produce SymbolRow.lang values matching
// its `tag` field. Languages with `native: true` are owned by the Rust
// binary's `parser.parseBuffer` (their JS extractors were deleted at
// cutover, parity-gated per language against real corpora); adapter.js
// routes them through parseBufferNative and never calls `extract`.
// Porting one of the remaining JS languages: mirror its spec in
// atlas_core/src/parse_extract/, corpus-gate it with
// diffParseBufferNativeParity, flip it to `native: true`, then delete the
// JS spec in the same change.

/** @type {(tag: string) => never} */
const nativeOnly = (tag) => {
  throw new Error(`languages/index: lang "${tag}" is native-only; adapter.js must route it through parseBufferNative`);
};

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
 * @property {boolean} [native]           True when extraction is owned by the Rust binary's parser.parseBuffer; `extract` must never be called.
 */

/** @type {LanguageDescriptor[]} */
export const LANGUAGES = [
  {
    tag: "ts",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    extract: () => nativeOnly("ts"),
    supported: true,
    native: true,
  },
  {
    tag: "js",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    extract: () => nativeOnly("js"),
    supported: true,
    native: true,
  },
  { tag: "py", extensions: [".py", ".pyi"], extract: () => nativeOnly("py"), supported: true, native: true },
  { tag: "go", extensions: [".go"], extract: () => nativeOnly("go"), supported: true, native: true },
  { tag: "rs", extensions: [".rs"], extract: () => nativeOnly("rs"), supported: true, native: true },
  { tag: "java", extensions: [".java"], extract: () => nativeOnly("java"), supported: true, native: true },
  { tag: "cs", extensions: [".cs"], extract: () => nativeOnly("cs"), supported: true, native: true },
  {
    tag: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    extract: () => nativeOnly("cpp"),
    supported: true,
    native: true,
  },
  { tag: "c", extensions: [".c", ".h"], extract: () => nativeOnly("c"), supported: true, native: true },
  { tag: "php", extensions: [".php"], extract: () => nativeOnly("php"), supported: true, native: true },
  { tag: "kt", extensions: [".kt", ".kts"], extract: () => nativeOnly("kt"), supported: true, native: true },
  { tag: "sh", extensions: [".sh", ".bash"], extract: () => nativeOnly("sh"), supported: true, native: true },
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

