// @ts-check
//
// Build per-file CallResolutionContext maps once per resolver pass.
//
// Three maps each adapter cares about:
//
//   1. importedNameToSymbolIds — "Foo" → list of NameCandidate for files
//      this one imports Foo from. Populated from import edges that
//      already have to_module + a resolved target file.
//
//   2. namespaceImports — "X" → (member name → NameCandidate). Built
//      from `import * as X from "./bar"` style imports. The inner map
//      covers every exported symbol of bar.ts keyed by its name.
//
//   3. nameToSymbolIds — every symbol DEFINED in this file. Adapter
//      uses it for `this.method` / `$this->method` resolution.
//
// All three are built in one pass over the view's symbols + edges so
// the per-file lookups are O(1) inside adapters.

import {
  parseImportModuleRef,
  resolveModuleSpecifier,
  RESOLVABLE_EXTENSIONS,
} from "./import-context.js";

/** @typedef {import("./name-index.js").NameCandidate} NameCandidate */
/** @typedef {import("./name-index.js").NameIndexes} NameIndexes */
/** @typedef {import("./adapters/types.js").CallResolutionContext} CallResolutionContext */

/**
 * @typedef {Object} PerFileContext
 * @property {Map<string, NameCandidate[]>} importedNameToSymbolIds
 * @property {Map<string, Map<string, NameCandidate>>} namespaceImports
 * @property {Map<string, NameCandidate[]>} nameToSymbolIds
 */

/**
 * Build a `repo_rel_path → PerFileContext` map.
 *
 * @param {{
 *   allSymbols: Iterable<NameCandidate & { name: string }>,
 *   importEdges: Iterable<{
 *     repo_rel_path: string,
 *     to_name: string,
 *     to_module: string | null,
 *     kind: string,
 *     confidence?: number,
 *     lang?: string,
 *   }>,
 *   pathToBlob: Map<string, string>,
 *   nameIdx: NameIndexes,
 * }} args
 * @returns {Map<string, PerFileContext>}
 */
export function buildFileContexts(args) {
  const { allSymbols, importEdges, pathToBlob, nameIdx } = args;

  // First pass: per-file nameToSymbolIds (every symbol in the file).
  /** @type {Map<string, Map<string, NameCandidate[]>>} */
  const nameByFile = new Map();
  /** @type {Map<string, Map<string, NameCandidate>>} */
  const symbolsByTargetFile = new Map();
  for (const sym of allSymbols) {
    let bucket = nameByFile.get(sym.repo_rel_path);
    if (!bucket) {
      bucket = new Map();
      nameByFile.set(sym.repo_rel_path, bucket);
    }
    const list = bucket.get(sym.name);
    if (list) list.push(sym);
    else bucket.set(sym.name, [sym]);

    let targetBucket = symbolsByTargetFile.get(sym.repo_rel_path);
    if (!targetBucket) {
      targetBucket = new Map();
      symbolsByTargetFile.set(sym.repo_rel_path, targetBucket);
    }
    if (!targetBucket.has(sym.name)) targetBucket.set(sym.name, sym);
  }

  // Second pass: imports per file.
  /** @type {Map<string, PerFileContext>} */
  const out = new Map();
  /**
   * Resolve to_module against pathToBlob → target file. Same logic as
   * the resolver's own moduleResolution; centralized here so the
   * adapters see pre-resolved candidates.
   *
   * @param {string} importingFile
   * @param {string} module
   * @returns {string | null}
   */
  const resolveTargetFile = (importingFile, module) => {
    const base = resolveModuleSpecifier(importingFile, module);
    if (!base) return null;
    const candidates = [base];
    const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
    if (stripped !== base) candidates.push(stripped);
    for (const cand of candidates) {
      for (const ext of RESOLVABLE_EXTENSIONS) {
        const hit = `${cand}${ext}`;
        if (pathToBlob.has(hit)) return hit;
      }
    }
    return null;
  };

  for (const e of importEdges) {
    if (e.kind !== "imports") continue;
    if (!e.to_module) continue;
    const moduleRef = parseImportModuleRef(e.to_module);
    let ctx = out.get(e.repo_rel_path);
    if (!ctx) {
      ctx = {
        importedNameToSymbolIds: new Map(),
        namespaceImports: new Map(),
        nameToSymbolIds: new Map(),
      };
      out.set(e.repo_rel_path, ctx);
    }

    const targetFile = resolveTargetFile(e.repo_rel_path, moduleRef.module);
    if (!targetFile) continue;

    // Resolve `to_name` against the target file's symbol table. The
    // generic name-index already knows every (name → candidates); we
    // filter by repo_rel_path to keep only those that live in the
    // import's target file.
    const exportedName = moduleRef.originalName ?? e.to_name;
    const candidates = nameIdx.byName.get(exportedName) || [];
    const inTarget = candidates.filter((c) => c.repo_rel_path === targetFile);

    if (inTarget.length > 0) {
      // Existing entry → append; otherwise create. Multiple imports of
      // the same name (e.g. two `import { Foo }` lines) are unusual but
      // tolerated.
      const existing = ctx.importedNameToSymbolIds.get(e.to_name);
      if (existing) existing.push(...inTarget);
      else ctx.importedNameToSymbolIds.set(e.to_name, [...inTarget]);
    }

    if (isJsNamespaceLikeImport(e)) {
      const exported = symbolsByTargetFile.get(targetFile);
      if (exported && exported.size > 0) {
        const existingNs = ctx.namespaceImports.get(e.to_name) ?? new Map();
        for (const [name, candidate] of exported) {
          if (!existingNs.has(name)) existingNs.set(name, candidate);
        }
        ctx.namespaceImports.set(e.to_name, existingNs);
      }
    }
  }

  // Third pass: ensure every file with symbols has a context entry
  // populated for nameToSymbolIds even when it has no imports. This
  // lets `this.method` / `$this->method` resolution work in files
  // that don't import anything.
  for (const [path, bucket] of nameByFile) {
    let ctx = out.get(path);
    if (!ctx) {
      ctx = {
        importedNameToSymbolIds: new Map(),
        namespaceImports: new Map(),
        nameToSymbolIds: new Map(),
      };
      out.set(path, ctx);
    }
    ctx.nameToSymbolIds = bucket;
  }

  return out;
}

/**
 * JS/TS import edges carry a tiny confidence convention from the parser:
 * namespace imports use 85, default imports use 88, named imports use 90.
 * This gives adapters the namespace/default maps they need without a
 * ledger schema migration.
 *
 * @param {{ confidence?: number, lang?: string }} edge
 * @returns {boolean}
 */
function isJsNamespaceLikeImport(edge) {
  if (edge.lang !== "ts" && edge.lang !== "js" && edge.lang !== "tsx") return false;
  return edge.confidence === 85 || edge.confidence === 88;
}
