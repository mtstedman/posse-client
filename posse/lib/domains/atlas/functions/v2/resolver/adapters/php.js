// @ts-check
//
// PHP call-resolution adapter.
//
// Ported from atlas-mcp's PhpAdapter.resolveCall. Same priority order so
// shadow diffs against atlas-mcp don't flag PHP resolutions as
// divergences.
//
// PHP-specific cases:
//   - `Foo::bar()` (static method or namespace::class form)
//   - `self::method`, `static::method`, `parent::method`, `$this::method`
//     → same-file lookup (the `self`-family stays inside the current class).
//   - `$this->method` is more idiomatic but parsed as `.` by some
//     extractors; the adapter handles both `::` and `.` paths.
//   - `Acme\Foo::bar` — qualified-namespace call; rare in idiomatic PHP
//     but supported via namespaceImports.
//   - Bare `function_call()` → check direct imports.

/** @typedef {import("./types.js").CallResolutionAdapter} CallResolutionAdapter */
/** @typedef {import("./types.js").CallResolutionContext} CallResolutionContext */
/** @typedef {import("./types.js").CallResolution} CallResolution */

/** Set of PHP `self`-family prefixes that route to same-file lookup. */
const PHP_SELF_PREFIXES = new Set(["$this", "self", "static", "parent"]);

/** @returns {CallResolutionAdapter} */
export function phpAdapter() {
  return {
    lang: "php",
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

  // Scope-resolution operator: A::b, self::create, $this::foo, Ns\\Cls::m.
  if (identifier.includes("::")) {
    const parts = identifier.split("::");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    // self/static/parent/$this → same-file lookup.
    if (PHP_SELF_PREFIXES.has(prefix)) {
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

    // Namespace::Class or Class member via namespace import.
    const ns = ctx.namespaceImports.get(prefix);
    if (ns && ns.has(member)) {
      const candidate = ns.get(member);
      if (candidate) {
        return {
          symbolId: candidate.global_id,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }
  }

  // Dotted form (some PHP parsers emit `$this.method`; handle it).
  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    const ns = ctx.namespaceImports.get(prefix);
    if (ns && ns.has(member)) {
      const candidate = ns.get(member);
      if (candidate) {
        return {
          symbolId: candidate.global_id,
          isResolved: true,
          strategy: "exact",
          confidence: 0.9,
        };
      }
    }

    if (PHP_SELF_PREFIXES.has(prefix)) {
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
  }

  // Bare call: function name. Try direct import.
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
