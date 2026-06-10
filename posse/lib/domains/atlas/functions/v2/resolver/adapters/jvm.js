// @ts-check
//
// Shared Java/Kotlin call-resolution adapter.
//
// Java and Kotlin share enough call-site semantics that a single
// adapter, parameterized by the language tag, covers both. The two
// languages have the same `this.method` / `super.method` patterns and
// the same JDK builtin namespaces.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `super` — never resolvable; `super.method` best-effort binds to
//     the same-file method name when unambiguous.
//   - `System.out.println`, `Math.floor`, `Arrays.asList` — dotted
//     call whose prefix is a JDK builtin class; never bind.
//   - `java.util.Arrays.asList` — top-level Java package prefix; bail.
//   - `this.method` — same-file lookup.
//   - `X.member()` where X is a namespace import — bind via
//     namespaceImports map.
//   - bare `foo()` matching a direct import — bind to imported symbol.
//
// The tree-sitter specs preserve dotted method calls, so receiver
// semantics fire in production.

import {
  JAVA_BUILTIN_NAMESPACES,
  JAVA_LANG_PACKAGES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/**
 * @param {"java" | "kt"} lang
 * @returns {CallResolutionAdapter}
 */
export function jvmAdapter(lang) {
  return {
    lang,
    resolveCall,
  };
}

/**
 * @param {CallResolutionContext} ctx
 * @returns {CallResolution | null}
 */
function resolveCall(ctx) {
  const identifier = (ctx.call.calleeIdentifier || "").trim();
  if (!identifier) return null;

  // Bare `super` — never a repo binding.
  if (identifier === "super") {
    return {
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      confidence: 0,
      reason: "super_call",
    };
  }

  // Dotted call: prefix.member.
  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    // JDK builtin class: System.out, Math.floor, Arrays.asList…
    if (JAVA_BUILTIN_NAMESPACES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_jdk_class",
      };
    }

    // Top-level Java package: java.util.Arrays, javax.swing.JButton…
    if (JAVA_LANG_PACKAGES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_java_pkg",
      };
    }

    // Namespace import alias.
    const nsMap = ctx.namespaceImports.get(prefix);
    if (nsMap && nsMap.has(member)) {
      const candidate = nsMap.get(member);
      if (candidate) {
        return {
          symbolId: candidate.global_id,
          isResolved: true,
          strategy: "exact",
          confidence: 0.92,
        };
      }
    }

    // this.method / super.method — same-file lookup.
    if (prefix === "this" || prefix === "super") {
      const local = ctx.nameToSymbolIds.get(member);
      if (local && local.length === 1) {
        return {
          symbolId: local[0].global_id,
          isResolved: true,
          strategy: "heuristic",
          confidence: 0.78,
        };
      }
    }

    return null;
  }

  // Bare identifier — direct import.
  const imported = ctx.importedNameToSymbolIds.get(identifier);
  if (imported && imported.length === 1) {
    return {
      symbolId: imported[0].global_id,
      isResolved: true,
      strategy: "exact",
      confidence: 0.88,
    };
  }

  return null;
}
