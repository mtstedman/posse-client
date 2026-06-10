// @ts-check
//
// Go call-resolution adapter.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `make`, `len`, `cap`, `append`, `new`, `panic`, ... — Go
//     predeclared identifiers, never repo symbols.
//   - `fmt.Println`, `strings.Split`, `os.Open` — dotted call whose
//     prefix is a stdlib package; never bind to a repo function.
//   - `X.member()` where X is a namespace import — bind via
//     namespaceImports map.
//   - bare `Foo()` matching a direct import — bind to imported symbol.
//
// Go doesn't have a `this`-style receiver keyword — method receivers
// are typed variables (`func (r *Foo) Bar()`), so call sites look like
// `r.Bar()` where `r` is whatever the caller named it. Resolving those
// needs type info we don't have, so we deliberately fall through
// rather than guess.
//
// The tree-sitter spec preserves dotted call chains, so package-prefix
// cases fire in production.

import {
  GO_BUILTIN_NAMES,
  GO_STDLIB_PACKAGES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/** @returns {CallResolutionAdapter} */
export function goAdapter() {
  return {
    lang: "go",
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

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    // Stdlib package: fmt.Println, strings.Split, os.Open…
    if (GO_STDLIB_PACKAGES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_stdlib_pkg",
      };
    }

    // Imported package alias used as namespace.
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

  // Bare builtin: make, len, append, panic, ...
  if (GO_BUILTIN_NAMES.has(identifier)) {
    return {
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      confidence: 0,
      reason: "builtin_name",
    };
  }

  // Bare identifier — same-package function. Treat as direct import.
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
