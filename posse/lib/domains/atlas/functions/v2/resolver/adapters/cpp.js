// @ts-check
//
// C / C++ call-resolution adapter.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `std::cout`, `std::vector::push_back`, `boost::shared_ptr` —
//     stdlib scope prefix; never bind to a repo symbol.
//   - `this->method` / `this.method` — same-file lookup. Some
//     extractors emit field-access as `.`; we handle both.
//   - `Class::method` where Class is a namespace import — bind via
//     namespaceImports map.
//   - bare `foo()` matching a direct import — bind to imported symbol.
//
// The tree-sitter spec preserves dotted/scoped call chains, so receiver
// and stdlib-prefix cases fire in production.

import {
  CPP_STDLIB_NAMESPACES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/**
 * @param {"c" | "cpp"} lang
 * @returns {CallResolutionAdapter}
 */
export function cppAdapter(lang) {
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
  // Strip C++ pointer-deref arrow into a dot so we can use one
  // identifier-split path. `this->method` → `this.method`.
  const raw = (ctx.call.calleeIdentifier || "").trim();
  if (!raw) return null;
  const identifier = raw.replace(/->/g, ".");

  // Scope-resolution operator: a::b::c.
  if (identifier.includes("::")) {
    const parts = identifier.split("::");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    if (CPP_STDLIB_NAMESPACES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_cpp_stdlib",
      };
    }

    const nsMap = ctx.namespaceImports.get(prefix);
    if (nsMap && nsMap.has(member)) {
      const candidate = nsMap.get(member);
      if (candidate) {
        return {
          symbolId: candidate.global_id,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    return null;
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    if (prefix === "this") {
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
