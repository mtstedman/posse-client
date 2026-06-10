// @ts-check
//
// Python call-resolution adapter.
//
// Cases handled (vs the generic 3-strategy ladder):
//   - `super()` — never resolvable; `super.method()` best-effort binds
//     to the same-file method name when unambiguous.
//   - `print`, `len`, `range`, `str`, ... — bare builtin call, bail.
//   - `os.path.join`, `json.loads`, `re.match` — dotted call whose
//     prefix is a stdlib module; never bind.
//   - `self.method` / `cls.method` — bind to a same-file symbol.
//   - `X.member()` where X is a namespace import — bind via
//     namespaceImports map.
//   - bare `foo()` matching a direct import — bind to imported symbol.
//
// The tree-sitter spec preserves dotted call chains (`self.method`,
// `os.path.join`) so these receiver cases fire in production.

import {
  PYTHON_BUILTIN_NAMES,
  PYTHON_STDLIB_MODULES,
} from "../builtins.js";

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

const PY_SELF_PREFIXES = new Set(["self", "cls"]);

/** @returns {CallResolutionAdapter} */
export function pythonAdapter() {
  return {
    lang: "py",
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

  // Bare `super()` — never a repo binding.
  if (identifier === "super" || identifier === "super()") {
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

    // Stdlib module prefix: os.path, json.loads, sys.argv, re.match…
    if (PYTHON_STDLIB_MODULES.has(prefix)) {
      return {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_stdlib",
      };
    }

    // Namespace alias (`import json as j`, `from x import y as Y`).
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

    // self.method / cls.method / super.method — same-file lookup.
    if (PY_SELF_PREFIXES.has(prefix) || prefix === "super") {
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

  // Bare builtin: print, len, range, str, ...
  if (PYTHON_BUILTIN_NAMES.has(identifier)) {
    return {
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      confidence: 0,
      reason: "builtin_name",
    };
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
