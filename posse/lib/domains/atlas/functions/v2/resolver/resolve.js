// @ts-check
//
// Edge resolver. Takes the materialized edges in a view (most still
// have `to_global_id = NULL` because the parser only set `to_name`)
// and binds them to concrete targets using:
//
//   1. IMPORT-DIRECT — import-aware: if the file imports `to_name` from
//      module M, look up M in path_to_blob and find the symbol named
//      `to_name` in that file. Confidence ~0.85.
//
//   2. NAME-RESOLVED — qualified-name: if the parser emitted `to_name` as a
//      qualified name (e.g. "Greeter::hello"), the global qualified
//      index gives a direct hit. Confidence ~0.92.
//
//   3. HEURISTIC — global simple-name match: if exactly one symbol in
//      the entire view bears this name, bind to it. Multiple matches
//      → bind to first with ambiguity penalty applied.
//
//   4. UNRESOLVED — otherwise leave `to_global_id = NULL`. Confidence
//      drops to ~0.2.
//
// Mirrors atlas-mcp's resolveCallTarget priority order so cross-tool
// shadow diffs land on the same bindings.

import { buildNameIndexes, lookupByName, lookupByQualifiedName } from "./name-index.js";
import { buildImportContexts, resolveModulePathCandidates } from "./import-context.js";
import { calibrateResolutionConfidence, toEdgeConfidence } from "./confidence.js";
import { buildFileContexts } from "./call-context.js";
import { adapterFor } from "./adapters/registry.js";
import { isBuiltinCall } from "./builtins.js";

/** @typedef {import("./name-index.js").NameCandidate} NameCandidate */
/** @typedef {import("./name-index.js").NameIndexes} NameIndexes */
/** @typedef {import("./import-context.js").FileImportContext} FileImportContext */

/**
 * @typedef {Object} ResolverInput
 * @property {Iterable<NameCandidate & { name: string }>} allSymbols
 *   Every symbol in the view, used to build the name indexes.
 * @property {Iterable<{
 *   repo_rel_path: string,
 *   to_name: string,
 *   to_module: string | null,
 *   kind: string,
 *   confidence?: number,
 *   lang?: string,
 * }>} importEdges
 *   Just the kind="imports" edges with to_module set. Used to build
 *   per-file import contexts.
 * @property {Map<string, string>} pathToBlob
 *   Snapshot of `repo_rel_path → content_hash`. Used to translate
 *   module specifiers (after extension probing) into the candidate
 *   target file.
 */

/**
 * @typedef {Object} EdgeToResolve
 * @property {number} edge_rowid           Identifier so the caller can update the row.
 * @property {string} repo_rel_path        File the edge lives in.
 * @property {string} to_name              Reference target name (raw from parser).
 * @property {string | null} to_module     Source-module string for imports; null otherwise.
 * @property {string} kind
 * @property {number} from_global_id       Where the edge originates.
 * @property {string} [lang]               Language of the source file. Used to dispatch to per-language adapter.
 */

/**
 * @typedef {Object} EdgeResolution
 * @property {number} edge_rowid
 * @property {number | null} to_global_id  Bound target (null = stayed unresolved).
 * @property {number} confidence           0..100, EdgeRow.confidence column.
 * @property {string} strategy             Resolution strategy label.
 */

/**
 * Run the resolver pass over the supplied unresolved edges and return
 * the binding decisions. Pure: doesn't touch any database — the caller
 * applies the resolutions via UPDATE.
 *
 * @param {ResolverInput & { unresolved: Iterable<EdgeToResolve> }} args
 * @returns {EdgeResolution[]}
 */
export function resolveEdges(args) {
  // Materialize the iterables: we need to iterate allSymbols and
  // importEdges twice (once for name index, once for per-file contexts).
  const symbols = Array.from(args.allSymbols);
  const imports = Array.from(args.importEdges);
  const nameIdx = buildNameIndexes(symbols);
  const importCtxs = buildImportContexts(imports);
  const fileCtxs = buildFileContexts({
    allSymbols: symbols,
    importEdges: imports,
    pathToBlob: args.pathToBlob,
    nameIdx,
  });
  /** @type {EdgeResolution[]} */
  const out = [];
  for (const edge of args.unresolved) {
    out.push(resolveOne(edge, {
      nameIdx,
      importCtxs,
      pathToBlob: args.pathToBlob,
      fileCtxs,
    }));
  }
  return out;
}

/**
 * @param {EdgeToResolve} edge
 * @param {{
 *   nameIdx: NameIndexes,
 *   importCtxs: Map<string, FileImportContext>,
 *   pathToBlob: Map<string, string>,
 *   fileCtxs: Map<string, import("./call-context.js").PerFileContext>,
 * }} ctx
 * @returns {EdgeResolution}
 */
function resolveOne(edge, ctx) {
  const lookup = lookupNamesForEdge(edge);

  // 0. Per-language adapter. Adapters claim language-specific cases
  //    (this.method, builtin.member, $this::method, etc.) and may
  //    also DENY binding for cases that should never resolve (e.g.
  //    Math.floor) — returning a CallResolution with symbolId=null
  //    means "I claimed this, leave it unresolved with low confidence."
  //    Returning `null` (no opinion) falls through to the ladder.
  if (edge.lang && edge.kind === "calls") {
    const adapter = adapterFor(edge.lang);
    if (adapter) {
      const fileCtx = ctx.fileCtxs.get(edge.repo_rel_path);
      if (fileCtx) {
        const decision = adapter.resolveCall({
          call: {
            calleeIdentifier: edge.to_name,
            repo_rel_path: edge.repo_rel_path,
            from_global_id: edge.from_global_id,
          },
          importedNameToSymbolIds: fileCtx.importedNameToSymbolIds,
          namespaceImports: fileCtx.namespaceImports,
          nameToSymbolIds: fileCtx.nameToSymbolIds,
        });
        if (decision) return finalizeAdapterDecision(edge, decision);
      }
    }
  }

  // 1. Qualified-name shortcut. The parser sometimes emits `to_name`
  // in qualified form ("Greeter::hello", "Box.greet"). If we get a
  // single qualified-name hit, that's the strongest possible bind.
  for (const name of lookup.qualifiedNames) {
    if (name.includes(".") || name.includes("::")) {
      const hits = lookupByQualifiedName(ctx.nameIdx, name);
      if (hits.length === 1) {
        return finalize(edge, hits[0], "name-resolved", 1);
      }
      if (hits.length > 1) {
        return finalize(edge, hits[0], "name-resolved", hits.length);
      }
    }
  }

  // 2. Import-aware exact: if this file imports `to_name` from
  // a known module that resolves to a file in path_to_blob, find
  // the symbol with that name in that file.
  const fileCtx = ctx.importCtxs.get(edge.repo_rel_path);
  if (fileCtx) {
    for (const name of lookup.importNames) {
      const binding = fileCtx.namedImports.get(name);
      if (binding) {
        const targetPath = resolveModulePathToFile(
          edge.repo_rel_path,
          binding.module,
          ctx.pathToBlob,
        );
        if (targetPath) {
          const candidates = lookupByName(ctx.nameIdx, binding.originalName)
            .filter((c) => c.repo_rel_path === targetPath);
          if (candidates.length >= 1) {
            return finalize(edge, candidates[0], "import-direct", candidates.length);
          }
        }
      }
    }
  }

  // 3. Heuristic global name match.
  const candidates = firstCandidateSet(ctx.nameIdx, lookup.simpleNames);
  if (candidates.length === 0) {
    if (lookup.builtinNames.some((name) => isBuiltinCall(name))) {
      return finalizeAdapterDecision(edge, {
        symbolId: null,
        isResolved: false,
        strategy: "unresolved",
        confidence: 0,
        reason: "builtin_call",
      });
    }
    return unresolved(edge);
  }
  // Prefer same-file candidate when one exists — fewer false positives
  // for common names like "hello" or "init".
  const sameFile = candidates.find((c) => c.repo_rel_path === edge.repo_rel_path);
  if (sameFile) {
    return finalize(edge, sameFile, "name-resolved", candidates.length);
  }
  // Take the first cross-file candidate; ambiguity penalty kicks in.
  return finalize(edge, candidates[0], "heuristic", candidates.length);
}

/**
 * @typedef {Object} LookupNames
 * @property {string[]} qualifiedNames
 * @property {string[]} importNames
 * @property {string[]} simpleNames
 * @property {string[]} builtinNames
 */

/**
 * The parser now preserves full receiver text (`b.greet`,
 * `helpers.runTask`, `Self::new`) for adapters. Generic fallback should
 * still try the final member name to match atlas-mcp's last-identifier
 * behavior.
 *
 * @param {EdgeToResolve} edge
 * @returns {LookupNames}
 */
function lookupNamesForEdge(edge) {
  if (edge.kind !== "calls") {
    return {
      qualifiedNames: uniqueNames([edge.to_name]),
      importNames: uniqueNames([edge.to_name]),
      simpleNames: uniqueNames([edge.to_name]),
      builtinNames: uniqueNames([edge.to_name]),
    };
  }

  const cleaned = cleanCallTarget(edge.to_name);
  const last = lastIdentifier(cleaned);
  return {
    qualifiedNames: uniqueNames([cleaned]),
    importNames: uniqueNames([cleaned, last]),
    simpleNames: uniqueNames([last, cleaned]),
    builtinNames: uniqueNames([cleaned, last]),
  };
}

/**
 * @param {NameIndexes} nameIdx
 * @param {string[]} names
 * @returns {NameCandidate[]}
 */
function firstCandidateSet(nameIdx, names) {
  for (const name of names) {
    const candidates = lookupByName(nameIdx, name);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

/**
 * @param {string} target
 * @returns {string}
 */
function cleanCallTarget(target) {
  return (target || "").replace(/^new\s+/, "").trim();
}

/**
 * @param {string} target
 * @returns {string}
 */
function lastIdentifier(target) {
  const normalized = cleanCallTarget(target).replace(/->/g, ".");
  const parts = normalized.split(/::|\./).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

/**
 * @param {Array<string | null | undefined>} names
 * @returns {string[]}
 */
function uniqueNames(names) {
  const out = [];
  const seen = new Set();
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * @param {EdgeToResolve} edge
 * @param {NameCandidate} target
 * @param {"scip-resolved" | "name-resolved" | "import-direct" | "exact" | "heuristic" | "unresolved"} strategy
 * @param {number} candidateCount
 * @returns {EdgeResolution}
 */
function finalize(edge, target, strategy, candidateCount) {
  const { confidence } = calibrateResolutionConfidence({
    isResolved: true,
    strategy,
    candidateCount,
  });
  return {
    edge_rowid: edge.edge_rowid,
    to_global_id: target.global_id,
    confidence: toEdgeConfidence(confidence),
    strategy,
  };
}

/**
 * Convert an adapter's CallResolution into the EdgeResolution shape
 * the writer consumes. Calibrates confidence to honor any
 * candidateCount ambiguity penalty the adapter declared.
 *
 * @param {EdgeToResolve} edge
 * @param {import("./adapters/types.js").CallResolution} decision
 * @returns {EdgeResolution}
 */
function finalizeAdapterDecision(edge, decision) {
  const { confidence, strategy } = calibrateResolutionConfidence({
    isResolved: decision.isResolved,
    strategy: decision.strategy,
    baseConfidence: decision.confidence,
    candidateCount: decision.candidateCount,
  });
  return {
    edge_rowid: edge.edge_rowid,
    to_global_id: decision.symbolId,
    confidence: toEdgeConfidence(confidence),
    strategy,
  };
}

/**
 * @param {EdgeToResolve} edge
 * @returns {EdgeResolution}
 */
function unresolved(edge) {
  const { confidence } = calibrateResolutionConfidence({
    isResolved: false,
    strategy: "unresolved",
  });
  return {
    edge_rowid: edge.edge_rowid,
    to_global_id: null,
    confidence: toEdgeConfidence(confidence),
    strategy: "unresolved",
  };
}

/**
 * Convert a module specifier to a concrete file path by trying common
 * extensions against path_to_blob. Returns the first hit or null.
 *
 * @param {string} importingFile
 * @param {string} specifier
 * @param {Map<string, string>} pathToBlob
 * @returns {string | null}
 */
function resolveModulePathToFile(importingFile, specifier, pathToBlob) {
  for (const candidate of resolveModulePathCandidates(importingFile, specifier, pathToBlob)) {
    if (pathToBlob.has(candidate)) return candidate;
  }
  return null;
}
