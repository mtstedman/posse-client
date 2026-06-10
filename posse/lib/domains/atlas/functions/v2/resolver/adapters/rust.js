// @ts-check
//
// Rust call-resolution adapter.
//
// Rust uses `::` as the path separator and `.` as the field/method
// access operator. The adapter handles both.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `std::fs::read`, `core::mem::swap`, `alloc::vec::Vec::new` —
//     stdlib path prefix, bail.
//   - `Self::method`, `self.method` — same-file lookup.
//   - `super::module::foo`, `crate::module::foo` — language pseudo
//     paths; the resolver doesn't model module trees so bail rather
//     than mis-bind.
//   - `Mod::Item` where Mod is a namespace import — bind via
//     namespaceImports map.
//   - bare `foo()` matching a direct import — bind to imported symbol.
//
// The tree-sitter spec preserves scoped/method calls, so `::` and `.`
// receiver cases fire in production.

import {
  RUST_STDLIB_PREFIXES,
  RUST_SELF_KEYWORDS,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/** @returns {CallResolutionAdapter} */
export function rustAdapter() {
  return {
    lang: "rs",
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

  // Path-style call: a::b::c.
  if (identifier.includes("::")) {
    const parts = identifier.split("::");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    // Stdlib: std::, core::, alloc::, proc_macro::, test::
    if (RUST_STDLIB_PREFIXES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_rust_stdlib",
      };
    }

    // self / Self / super / crate — pseudo-paths.
    if (RUST_SELF_KEYWORDS.has(prefix)) {
      // Self::method → same-file lookup.
      if ((prefix === "Self" || prefix === "self") && parts.length === 2) {
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
      if (prefix === "Self" || prefix === "self") {
        return {
          symbolId: null,
          isResolved: false,
          strategy: "unresolved",
          confidence: 0,
          reason: "rust_self_chain",
        };
      }
      // super::/crate:: are valid repo paths but we don't model module
      // trees yet. Mark as adapter-claimed so we don't mis-bind via the
      // generic ladder.
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "rust_pseudo_path",
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

    return null;
  }

  // Dotted method call: receiver.method. We can't resolve typed
  // receivers, but `self.method` lands here when emitted dotted.
  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    if (prefix === "self") {
      if (parts.length === 2) {
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
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "rust_self_chain",
      };
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
