// @ts-check
//
// Per-file import context derived from `kind="imports"` edges with a
// non-null `to_module`. The resolver consults this when binding
// unresolved call/reference edges: if `to_name` matches a name that
// was imported into this file, the import's target module tells us
// which file the symbol lives in.
//
// Mirrors atlas-mcp's `importedNameToSymbolIds` plus `namespaceImports`
// maps that get passed to BaseAdapter.resolveCall.

/** @typedef {import("../contracts/api.js").ViewEdge} ViewEdge */

/**
 * @typedef {Object} ImportBinding
 * @property {string} localName        How the import is referenced in this file ("Foo" / namespace alias "X").
 * @property {string} module           Source-module string (e.g. "./bar.js", "std::fmt::Display").
 * @property {string} originalName     The name as exported from `module` (usually same as localName; differs for aliased imports).
 */

/**
 * @typedef {Object} FileImportContext
 * @property {Map<string, ImportBinding>} namedImports
 *   Map from local name to its import binding. `import { Foo as F }` →
 *   namedImports.get("F") = { localName: "F", module: ..., originalName: "Foo" }.
 */

/**
 * Build a `repo_rel_path → FileImportContext` map from the view's
 * import-kind edges. Edges without a `to_module` (e.g. PHP qualified
 * imports that don't carry a separable module string) are skipped —
 * the resolver falls back to global heuristic search for those.
 *
 * @param {Iterable<{ repo_rel_path: string, to_name: string, to_module: string | null, kind: string }>} importEdges
 * @returns {Map<string, FileImportContext>}
 */
export function buildImportContexts(importEdges) {
  /** @type {Map<string, FileImportContext>} */
  const out = new Map();
  for (const e of importEdges) {
    if (e.kind !== "imports") continue;
    if (!e.to_module) continue;
    const moduleRef = parseImportModuleRef(e.to_module);
    const path = e.repo_rel_path;
    let ctx = out.get(path);
    if (!ctx) {
      ctx = { namedImports: new Map() };
      out.set(path, ctx);
    }
    ctx.namedImports.set(e.to_name, {
      localName: e.to_name,
      module: moduleRef.module,
      originalName: moduleRef.originalName ?? e.to_name,
    });
  }
  return out;
}

/**
 * Named imports can encode the exported binding as "module#originalName"
 * while keeping EdgeRow stable. Bare side-effect/default/namespace imports
 * continue to use the module string unchanged.
 *
 * @param {string} raw
 * @returns {{ module: string, originalName: string | null }}
 */
export function parseImportModuleRef(raw) {
  const idx = raw.lastIndexOf("#");
  if (idx <= 0 || idx === raw.length - 1) {
    return { module: raw, originalName: null };
  }
  return {
    module: raw.slice(0, idx),
    originalName: raw.slice(idx + 1),
  };
}

/**
 * Resolve a module specifier from an import statement against the
 * importing file's path, producing the canonical repo-relative path of
 * the imported file (best effort). Returns null when the specifier is
 * a bare package name (`"react"`, `"fmt"`) — those don't map to a
 * source file in the repo.
 *
 * Rules:
 *   - "./foo" or "../foo" → resolved relative to importingFile's dir.
 *   - "/abs" → treated as repo-absolute (rare).
 *   - bare "fmt" / "react" → null (external).
 *
 * Extensions are NOT appended here; the caller pairs the result
 * against `path_to_blob` and tries common extensions (.ts/.tsx/.js…)
 * if the literal path isn't in the map.
 *
 * @param {string} importingFile        Canonical repo-relative path.
 * @param {string} specifier            Raw module string as written.
 * @returns {string | null}
 */
export function resolveModuleSpecifier(importingFile, specifier) {
  if (!specifier) return null;
  if (specifier.startsWith(".")) {
    return joinAndNormalize(parentDir(importingFile), specifier);
  }
  if (specifier.startsWith("/")) {
    return normalizeRel(specifier.slice(1));
  }
  // Bare specifier (npm package, std lib, etc.) — not a repo file.
  return null;
}

/**
 * @param {string} p
 * @returns {string}
 */
function parentDir(p) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

/**
 * @param {string} base
 * @param {string} rel
 * @returns {string | null}
 */
function joinAndNormalize(base, rel) {
  const segments = (base ? base.split("/") : []).concat(rel.split("/"));
  /** @type {string[]} */
  const stack = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join("/");
}

/**
 * @param {string} p
 */
function normalizeRel(p) {
  return joinAndNormalize("", p);
}

/**
 * Candidate file extensions to try when the specifier didn't include
 * one. Order reflects priority — earliest match wins. Driven by what
 * resolver path-lookup tries against path_to_blob.
 */
export const RESOLVABLE_EXTENSIONS = Object.freeze(
  /** @type {readonly string[]} */ ([
    "",       // exact match (specifier already had an extension)
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".d.ts",
    ".py",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
    "/index.mjs",
    "/index.cjs",
    "/__init__.py",
  ]),
);
