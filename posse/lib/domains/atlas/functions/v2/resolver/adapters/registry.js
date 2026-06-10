// @ts-check
//
// Adapter registry. The main resolver looks up the adapter for the
// language of the call's source file; missing adapters fall through
// to the generic ladder.
//
// Adding a new language adapter:
//   1. Implement it under ./<lang>.js exposing a factory function.
//   2. Register it here.
//   3. Add fixture tests in test/test-atlas-v2-resolver-adapters.test.js.

import { typescriptAdapter } from "./typescript.js";
import { phpAdapter } from "./php.js";
import { pythonAdapter } from "./python.js";
import { goAdapter } from "./go.js";
import { jvmAdapter } from "./jvm.js";
import { rustAdapter } from "./rust.js";
import { csharpAdapter } from "./csharp.js";
import { cppAdapter } from "./cpp.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */

/**
 * Lazy-build the per-language adapter map. Adapters are pure functions
 * with no per-instance state (callers pass context fresh each call),
 * so a singleton per language is fine.
 */
let CACHE = null;

/**
 * @returns {Map<string, CallResolutionAdapter>}
 */
function adapterMap() {
  if (CACHE) return CACHE;
  CACHE = new Map();
  // TS and JS share the same adapter (TS grammar handles both).
  CACHE.set("ts", typescriptAdapter("ts"));
  CACHE.set("tsx", typescriptAdapter("tsx"));
  CACHE.set("js", typescriptAdapter("js"));
  CACHE.set("php", phpAdapter());
  CACHE.set("py", pythonAdapter());
  CACHE.set("go", goAdapter());
  // Java and Kotlin share the same adapter (both target the JVM and
  // have the same call-site shapes the adapter cares about).
  CACHE.set("java", jvmAdapter("java"));
  CACHE.set("kt", jvmAdapter("kt"));
  CACHE.set("rs", rustAdapter());
  CACHE.set("cs", csharpAdapter());
  CACHE.set("cpp", cppAdapter("cpp"));
  CACHE.set("c", cppAdapter("c"));
  return CACHE;
}

/**
 * Look up the adapter for a language tag, or null.
 *
 * @param {string} lang
 * @returns {CallResolutionAdapter | null}
 */
export function adapterFor(lang) {
  return adapterMap().get(lang) || null;
}

/**
 * True when ATLAS has language-specific call-resolution semantics for `lang`.
 *
 * @param {string} lang
 * @returns {boolean}
 */
export function hasLanguageSemantics(lang) {
  return adapterFor(String(lang || "").trim().toLowerCase()) != null;
}

/**
 * @returns {string[]}
 */
export function semanticLanguageTags() {
  return [...adapterMap().keys()];
}

/**
 * Test-only: drop the singleton cache so swapping adapters in tests
 * doesn't stick.
 */
export function __resetAdapterRegistryForTests() {
  CACHE = null;
}
