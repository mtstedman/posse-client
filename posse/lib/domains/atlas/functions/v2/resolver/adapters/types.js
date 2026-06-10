// @ts-check
//
// Per-language call-resolution adapter contract.
//
// Each language adapter implements `resolveCall(ctx) → CallResolution`
// to bind a call site to a concrete symbol using language-specific
// semantics that the generic resolver ladder doesn't capture.
//
// Cases the generic resolver misses:
//   - JS/TS `this.method` — needs to look in the enclosing class's methods
//   - JS/TS `Math.floor`, `console.log`, `fs.readFile` — should NEVER resolve
//   - JS/TS `import * as X` namespace prefix — needs namespace map
//   - PHP `$this->method`, `self::method`, `static::method`, `parent::method`
//   - PHP namespace-qualified `Acme\Foo::bar()`
//
// The adapter returns a CallResolution OR null to indicate "I have no
// opinion; fall through to the generic ladder." This lets adapters
// stay focused on language-specific cases and inherit the generic
// fallback automatically.

/** @typedef {import("../name-index.js").NameCandidate} NameCandidate */

/**
 * Per-file context an adapter inspects when resolving a call.
 *
 * Mirrors atlas-mcp's CallResolutionContext shape so adapter ports are
 * line-for-line translations rather than re-architecting.
 *
 * @typedef {Object} CallResolutionContext
 * @property {Object} call                                   The call site being resolved.
 * @property {string} call.calleeIdentifier                  The text as it appears in source: "foo", "this.bar", "Math.floor", "self::create".
 * @property {string} call.repo_rel_path                     File the call lives in.
 * @property {number} call.from_global_id                    The view-local global_id of the enclosing symbol.
 *
 * @property {Map<string, NameCandidate[]>} importedNameToSymbolIds
 *   Per-file: bare imported name → candidates. `import { Foo } from "./bar"`
 *   yields `importedNameToSymbolIds.get("Foo") = [<NameCandidate for Foo
 *   in bar.ts>]`. Built from the resolver's already-bound import edges.
 *
 * @property {Map<string, Map<string, NameCandidate>>} namespaceImports
 *   Per-file: namespace alias → (member name → NameCandidate). For
 *   `import * as X from "./bar"` the inner map covers every exported
 *   symbol of bar.ts keyed by its name. Used to bind `X.foo()`.
 *
 * @property {Map<string, NameCandidate[]>} nameToSymbolIds
 *   Symbols defined in the same file as the call. Used to bind
 *   `this.method` (TS) / `$this->method` (PHP) without leaving the
 *   file scope.
 */

/**
 * Adapter return — same shape as atlas-mcp's AdapterResolvedCall.
 *
 * @typedef {Object} CallResolution
 * @property {number | null} symbolId                Bound symbol's global_id, or null when truly unresolvable (e.g. a builtin).
 * @property {boolean} isResolved
 * @property {"exact" | "name-resolved" | "import-direct" | "heuristic" | "unresolved"} strategy
 * @property {number} confidence                     0..1 — adapter's baseline; calibrate via confidence.js before writing.
 * @property {number} [candidateCount]               Optional. If set, calibrator applies ambiguity penalty.
 * @property {string} [reason]                       Optional diagnostic: "builtin_skip", "super_call", "namespace_member", etc.
 */

/**
 * Per-language call-resolution adapter.
 *
 * @typedef {Object} CallResolutionAdapter
 * @property {string} lang                                              Lowercase language tag matching SymbolRow.lang.
 * @property {(ctx: CallResolutionContext) => CallResolution | null} resolveCall
 *   Return a CallResolution for the call, or null to fall through to
 *   the generic resolver ladder. Returning a CallResolution with
 *   `symbolId: null` means "the adapter knows this can't resolve" —
 *   e.g. a builtin call — and the generic ladder is also skipped.
 */
