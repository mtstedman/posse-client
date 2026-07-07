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
 * Resolve a module/import string into concrete candidate repo paths. This
 * extends the JS/TS resolver with the same repo-local native-language cases
 * the extractors emit: Rust module paths, C/C++ header includes, Go/PHP
 * package paths, and additional source/header extensions.
 *
 * @param {string} importingFile
 * @param {string} specifier
 * @param {Map<string, string>} [pathToBlob]
 * @returns {string[]}
 */
export function resolveModulePathCandidates(importingFile, specifier, pathToBlob) {
  const raw = String(specifier || "").trim();
  if (!raw) return [];
  /** @type {string[]} */
  const bases = [];
  const jsBase = resolveModuleSpecifier(importingFile, raw);
  if (jsBase) {
    bases.push(jsBase);
  } else {
    bases.push(...nativeModuleSpecifierBases(importingFile, raw, pathToBlob));
  }
  const out = [];
  const seen = new Set();
  for (const base of bases) {
    for (const candidateBase of candidateBases(base)) {
      for (const ext of RESOLVABLE_EXTENSIONS) {
        const candidate = normalizeRel(`${candidateBase}${ext}`);
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }
  return out;
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
 * @param {string} base
 * @returns {string[]}
 */
function candidateBases(base) {
  const normalized = normalizeRel(base);
  if (!normalized) return [];
  const out = [normalized];
  const stripped = normalized.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|d\.ts)$/i, "");
  if (stripped !== normalized) out.push(stripped);
  return out;
}

/**
 * @param {string} importingFile
 * @param {string} specifier
 * @param {Map<string, string> | undefined} pathToBlob
 * @returns {string[]}
 */
function nativeModuleSpecifierBases(importingFile, specifier, pathToBlob) {
  const out = [];
  const raw = stripImportQuotes(specifier);
  if (!raw) return out;

  out.push(...rustModuleBases(importingFile, raw, pathToBlob));

  if (looksLikeRepoLocalInclude(raw)) {
    out.push(joinAndNormalize(parentDir(importingFile), raw));
  }

  if (raw.includes("\\")) {
    out.push(...phpNamespaceBases(raw));
  }

  if (raw.includes("/") && !raw.startsWith("@") && hasRepoCandidate(raw, pathToBlob)) {
    out.push(raw);
  }

  return unique(out.filter(Boolean).map((entry) => String(entry)));
}

/**
 * @param {string} importingFile
 * @param {string} raw
 * @param {Map<string, string> | undefined} pathToBlob
 * @returns {string[]}
 */
function rustModuleBases(importingFile, raw, pathToBlob) {
  if (!raw.includes("::")) return [];
  const parts = raw.split("::").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const head = parts[0];
  if (head === "crate") {
    const tail = parts.slice(1).join("/");
    return rustSourceRoots(importingFile, pathToBlob).map((root) => root ? `${root}/${tail}` : tail);
  }
  if (head === "self") {
    return [joinAndNormalize(parentDir(importingFile), parts.slice(1).join("/"))].filter(Boolean);
  }
  if (head === "super") {
    let base = parentDir(importingFile);
    let idx = 0;
    while (parts[idx] === "super") {
      if (idx > 0) base = parentDir(base);
      idx++;
    }
    return [joinAndNormalize(base, parts.slice(idx).join("/"))].filter(Boolean);
  }
  return [];
}

/**
 * @param {string} importingFile
 * @param {Map<string, string> | undefined} pathToBlob
 * @returns {string[]}
 */
function rustSourceRoots(importingFile, pathToBlob) {
  const out = [];
  const srcIdx = importingFile.lastIndexOf("/src/");
  if (srcIdx >= 0) out.push(importingFile.slice(0, srcIdx + 4));
  if (importingFile.startsWith("src/") || importingFile === "src/lib.rs" || importingFile === "src/main.rs") {
    out.push("src");
  }
  if (pathToBlob?.has("Cargo.toml")) out.push("src");
  out.push("");
  return unique(out);
}

/**
 * @param {string} raw
 */
function phpNamespaceBases(raw) {
  const slash = raw.replace(/^\\+/, "").replace(/\\+/g, "/");
  const withoutRoot = slash.replace(/^(App|Tests|Src)\//, "");
  return unique([
    slash,
    `src/${withoutRoot}`,
    `app/${withoutRoot}`,
  ]);
}

/**
 * @param {string} raw
 */
function stripImportQuotes(raw) {
  return raw.replace(/^["'<]+|["'>]+$/g, "").trim();
}

/**
 * @param {string} raw
 */
function looksLikeRepoLocalInclude(raw) {
  return /\.(h|hh|hpp|hxx|c|cc|cpp|cxx|go|rs|php|java|kt|kts|cs)$/i.test(raw);
}

/**
 * @param {string} base
 * @param {Map<string, string> | undefined} pathToBlob
 */
function hasRepoCandidate(base, pathToBlob) {
  if (!pathToBlob || pathToBlob.size === 0) return true;
  for (const candidateBase of candidateBases(base)) {
    for (const ext of RESOLVABLE_EXTENSIONS) {
      const candidate = normalizeRel(`${candidateBase}${ext}`);
      if (candidate && pathToBlob.has(candidate)) return true;
    }
  }
  return false;
}

/**
 * @template T
 * @param {T[]} values
 * @returns {T[]}
 */
function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".d.ts",
    ".py",
    ".pyi",
    ".rs",
    ".go",
    ".php",
    ".java",
    ".kt",
    ".kts",
    ".cs",
    ".c",
    ".h",
    ".hpp",
    ".hh",
    ".hxx",
    ".cpp",
    ".cc",
    ".cxx",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
    "/index.mjs",
    "/index.cjs",
    "/__init__.py",
    "/mod.rs",
    "/index.php",
  ]),
);
