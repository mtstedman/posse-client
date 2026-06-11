// @ts-check
//
// Lazy tree-sitter grammar loader.
//
// Each grammar package is a native module that costs ~5–50 MB resident
// memory after first load. We don't want to pull all 12 at import time
// for a process that only ever parses, say, TS. The loader caches one
// `Parser` instance per language tag and resolves the grammar object
// from whichever export shape the grammar package uses.

// @ts-ignore - tree-sitter's d.ts isn't a proper module declaration; we
// only use the default export at runtime.
import Parser from "tree-sitter";
import { createRequire } from "module";

const requireGrammar = createRequire(import.meta.url);

/** @typedef {string} LangTag */

/**
 * Maps our language tag → (grammar package name, export accessor).
 * The accessor is a function that takes the imported module and returns
 * the grammar object Parser.setLanguage() expects.
 *
 * @type {Record<LangTag, { pkg: string, pick: (m: any) => any }>}
 */
const GRAMMAR_REGISTRY = {
  // NOTE the split after the parser.parseBuffer cutover: ledger INGESTION
  // for ts/tsx/js/py/rs/php is native-only (their JS extractors are deleted;
  // the Rust binary carries those grammars at compile time). The node
  // grammars below remain ONLY for read-time AST tools — code.getSkeleton /
  // code.getHotPath / repo overview (retrieval/ast.js) — which still parse
  // live buffers in-process, plus the languages whose extraction has not
  // yet been ported (go/java/cs/cpp/c/kt/sh).
  ts: { pkg: "tree-sitter-typescript", pick: (m) => m.typescript ?? m.default?.typescript ?? m },
  tsx: { pkg: "tree-sitter-typescript", pick: (m) => m.tsx ?? m.default?.tsx ?? m },
  js: { pkg: "tree-sitter-javascript", pick: (m) => m.default ?? m },
  py: { pkg: "tree-sitter-python", pick: (m) => m.default ?? m },
  go: { pkg: "tree-sitter-go", pick: (m) => m.default ?? m },
  rs: { pkg: "tree-sitter-rust", pick: (m) => m.default ?? m },
  java: { pkg: "tree-sitter-java", pick: (m) => m.default ?? m },
  cs: { pkg: "tree-sitter-c-sharp", pick: (m) => m.default ?? m },
  cpp: { pkg: "tree-sitter-cpp", pick: (m) => m.default ?? m },
  c: { pkg: "tree-sitter-c", pick: (m) => m.default ?? m },
  php: { pkg: "tree-sitter-php", pick: (m) => m.php ?? m.default?.php ?? m },
  kt: { pkg: "tree-sitter-kotlin", pick: (m) => m.default ?? m },
  sh: { pkg: "tree-sitter-bash", pick: (m) => m.default ?? m },
};

/** @type {Map<LangTag, Parser>} */
const parserCache = new Map();

/** @type {Map<LangTag, string>} */
const loadFailures = new Map();

/** @type {Set<LangTag>} */
const warnedLoadFailures = new Set();

/**
 * Resolve and cache a Parser for the given language tag. Returns null
 * when the grammar package is not installed (the language is registered
 * as optional in package.json so an install failure for one grammar
 * doesn't break posse).
 *
 * @param {LangTag} lang
 * @returns {Parser | null}
 */
export function parserFor(lang) {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  if (loadFailures.has(lang)) return null;

  const entry = GRAMMAR_REGISTRY[lang];
  if (!entry) {
    loadFailures.set(lang, `unregistered language tag: ${lang}`);
    return null;
  }
  try {
    // Synchronous `require` would be cleaner here but ESM doesn't expose
    // it directly; createRequire(import.meta.url) is the standard idiom.
    const mod = loadGrammarModule(entry.pkg);
    const grammar = entry.pick(mod);
    if (!grammar) {
      const message = `grammar pick returned null for ${entry.pkg}`;
      loadFailures.set(lang, message);
      warnLoadFailureOnce(lang, entry.pkg, message);
      return null;
    }
    const parser = new Parser();
    parser.setLanguage(grammar);
    parserCache.set(lang, parser);
    return parser;
  } catch (err) {
    const message = String(/** @type {any} */ (err)?.message || err);
    loadFailures.set(lang, message);
    warnLoadFailureOnce(lang, entry.pkg, message);
    return null;
  }
}

/**
 * Diagnostic helper. Returns the load failure message for a language
 * the loader tried and failed to load; null when no attempt was made
 * or the load succeeded.
 *
 * @param {LangTag} lang
 * @returns {string | null}
 */
export function loadFailureFor(lang) {
  return loadFailures.get(lang) || null;
}

/**
 * Test-only: clear the parser cache + failure record. Used so per-test
 * grammar mocking works.
 */
export function __resetGrammarLoaderForTests() {
  parserCache.clear();
  loadFailures.clear();
  warnedLoadFailures.clear();
}

/**
 * Load a grammar package synchronously via createRequire. Centralized so
 * the import-style pattern lives in one place; switching to dynamic
 * import later only touches this function.
 *
 * @param {string} pkg
 * @returns {any}
 */
function loadGrammarModule(pkg) {
  return requireGrammar(pkg);
}

/**
 * Public registry inspection. Returns the language tags the loader
 * knows about regardless of whether the grammar is installed.
 *
 * @returns {LangTag[]}
 */
export function knownLanguageTags() {
  return Object.keys(GRAMMAR_REGISTRY);
}

/**
 * @param {LangTag} lang
 * @param {string} pkg
 * @param {string} message
 */
function warnLoadFailureOnce(lang, pkg, message) {
  if (warnedLoadFailures.has(lang)) return;
  warnedLoadFailures.add(lang);
  // eslint-disable-next-line no-console
  console.warn(
    `[atlas-v2] tree-sitter parser unavailable for lang=${lang} (${pkg}): ` +
    `${message}; indexing for this language will be incomplete until the native grammar loads.`,
  );
}
