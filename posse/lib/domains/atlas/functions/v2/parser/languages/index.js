// @ts-check
//
// Native parser language metadata. Extraction is owned entirely by
// posse-atlas; the Node registry only resolves tags and extensions.

/**
 * @typedef {Object} LanguageDescriptor
 * @property {string} tag                 Lowercase language tag, matches SymbolRow.lang.
 * @property {string[]} extensions        Lowercase, leading "." preserved (e.g. ".ts").
 * @property {boolean} supported
 */

/** @type {LanguageDescriptor[]} */
export const LANGUAGES = [
  {
    tag: "ts",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    supported: true,
  },
  {
    tag: "js",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    supported: true,
  },
  { tag: "py", extensions: [".py", ".pyi"], supported: true },
  { tag: "go", extensions: [".go"], supported: true },
  { tag: "rs", extensions: [".rs"], supported: true },
  { tag: "java", extensions: [".java"], supported: true },
  { tag: "cs", extensions: [".cs"], supported: true },
  {
    tag: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    supported: true,
  },
  { tag: "c", extensions: [".c", ".h"], supported: true },
  { tag: "php", extensions: [".php"], supported: true },
  { tag: "kt", extensions: [".kt", ".kts"], supported: true },
  { tag: "sh", extensions: [".sh", ".bash"], supported: true },
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

