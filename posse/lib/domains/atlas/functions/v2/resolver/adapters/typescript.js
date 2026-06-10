// @ts-check
//
// TypeScript / JavaScript call-resolution adapter.
//
// Ported from atlas-mcp's TypeScriptAdapter.resolveCall. Same priority
// order so shadow diffs against atlas-mcp don't flag adapter-routed
// resolutions as divergences.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `new Foo()` — strip the `new`, then treat as `Foo()`.
//   - `super()` — never resolvable; `super.x()` best-effort binds to
//     the same-file method name when unambiguous.
//   - `Math.floor`, `JSON.stringify` etc. — dotted call into a
//     builtin global; never bind.
//   - `fs.readFile`, `path.join` etc. — dotted call into a Node
//     builtin module; never bind.
//   - `X.member()` where X is a namespace import — bind via
//     namespaceImports map (placeholder until import_kind is wired).
//   - `this.method()` — bind to a same-file method with this name.
//   - `foo()` where foo is a direct import — bind to the imported
//     symbol exactly when there's a single candidate.

import {
  BUILTIN_GLOBAL_NAMESPACES,
  NODE_BUILTIN_MODULE_NAMES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/**
 * @param {string} lang  "ts" or "js"
 * @returns {CallResolutionAdapter}
 */
export function typescriptAdapter(lang) {
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
  const identifier = (ctx.call.calleeIdentifier || "").replace(/^new\s+/, "").trim();
  if (!identifier) return null;

  // Bare `super()` — never a repo binding. Returning a
  // CallResolution with symbolId=null tells the caller "the adapter
  // claimed this; don't fall through to the generic ladder."
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

    // Builtin global namespace: Math.floor, JSON.stringify, console.log, etc.
    if (BUILTIN_GLOBAL_NAMESPACES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_global",
      };
    }

    // Node builtin module used as namespace: fs.readFile, path.join, etc.
    if (NODE_BUILTIN_MODULE_NAMES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_node_module",
      };
    }

    // `import * as X from "..."` then `X.member()` — look up member
    // in the namespace map.
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

    // `this.method` / `super.method` — look up member in same-file
    // symbols. This is deliberately a heuristic: without type info we
    // cannot prove which base class owns `super.method`.
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

    // Dotted but didn't match any adapter-known pattern → fall through.
    return null;
  }

  // Bare identifier — try the direct-import map.
  const imported = ctx.importedNameToSymbolIds.get(identifier);
  if (imported && imported.length === 1) {
    return {
      symbolId: imported[0].global_id,
      isResolved: true,
      strategy: "exact",
      confidence: 0.88,
    };
  }

  // Not adapter-known → generic ladder.
  return null;
}
