// @ts-check
//
// C# call-resolution adapter.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `base` — never resolvable; `base.Method` best-effort binds to
//     the same-file method name when unambiguous.
//   - `Console.WriteLine`, `Math.Floor`, `String.Format`, ... — dotted
//     call whose prefix is a BCL type; never bind.
//   - `this.Method` — same-file lookup.
//   - `X.Member()` where X is a namespace import — bind via
//     namespaceImports map.
//   - bare `Foo()` matching a direct import — bind to imported symbol.

import {
  CSHARP_BUILTIN_NAMESPACES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/** @returns {CallResolutionAdapter} */
export function csharpAdapter() {
  return {
    lang: "cs",
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

  // Bare `base` — never resolvable.
  if (identifier === "base") {
    return {
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      confidence: 0,
      reason: "base_call",
    };
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    // BCL type as receiver: Console.WriteLine, Math.Floor, etc.
    if (CSHARP_BUILTIN_NAMESPACES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_bcl",
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

    if (prefix === "this" || prefix === "base") {
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
