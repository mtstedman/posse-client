// @ts-check
//
// Generic tree-sitter walker. Per-language adapters supply a
// `LanguageSpec` describing which AST node types map to which
// SymbolKind, how to pull names out of those nodes, and how to derive
// edges from inheritance + import nodes. The walker handles tree
// traversal, parent attribution, and the createExtractor handoff
// uniformly so language files stay declarative.
//
// This is the ATLAS v2 equivalent of atlas-mcp's extractSymbols +
// extractImports + extractCalls pipeline, fused into one walk.

import { parserFor } from "./loader.js";
import { createExtractor } from "../languages/common.js";
import { logAtlasError } from "../../verbose-errors.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */
/** @typedef {import("../../contracts/schemas.js").EdgeKind} EdgeKind */

/** A subset of tree-sitter's SyntaxNode we actually use. */
/**
 * @typedef {Object} TsNode
 * @property {string} type
 * @property {string} text
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {{ row: number, column: number }} startPosition
 * @property {{ row: number, column: number }} endPosition
 * @property {TsNode | null} parent
 * @property {TsNode[]} children
 * @property {TsNode | null} firstChild
 * @property {TsNode | null} lastChild
 * @property {number} childCount
 * @property {boolean} [hasError]
 * @property {(name: string) => TsNode | null} childForFieldName
 * @property {(field: string) => TsNode[]} childrenForFieldName
 */

/**
 * @typedef {Object} SymbolMatch
 * @property {SymbolKind} kind
 * @property {string} name
 * @property {string | null} [qualified_name]
 * @property {SymbolVisibility | null} [visibility]
 * @property {string | null} [doc]
 * @property {string} [signature]
 * @property {TsNode} [bodyNode]            Inner block whose byte-range scopes nested members.
 * @property {string | null} [parentName]
 *   Override for parent_local_id resolution. When set, the walker looks
 *   up the most recently emitted symbol with this `name` and uses its
 *   `local_id` as the new symbol's parent_local_id. Used by Rust to
 *   attribute `impl Trait for Type { fn method(...) }` methods to the
 *   target struct even though the impl block isn't itself a container.
 */

/**
 * @typedef {Object} EdgeMatch
 * @property {EdgeKind} kind
 * @property {string} to_name
 * @property {string | null} [to_module]
 *   Source-module string for import edges. Threaded into EdgeRow so the
 *   resolver pass can bind the imported name to a concrete target.
 * @property {number} [confidence]
 * @property {boolean} [moduleLevel]        True when the edge has no enclosing symbol yet.
 * @property {string} [fromName]            Symbol name that should own this edge, resolved after traversal if needed.
 */

/**
 * Per-language adapter spec. Each callback receives the tree-sitter
 * node and returns either a SymbolMatch, an EdgeMatch array, or null.
 * The walker assembles them into SymbolRow/EdgeRow via createExtractor.
 *
 * @typedef {Object} LanguageSpec
 * @property {string} lang                                Lowercase tag matching SymbolRow.lang.
 * @property {string} [parserLang]                        Tree-sitter grammar tag when it differs from emitted lang.
 * @property {(src: string) => string} [stripComments]    Defaults to identity (tree-sitter handles comments).
 * @property {(node: TsNode, source: string) => SymbolMatch | null} symbolOf
 *   Return the symbol metadata for this node, or null to skip.
 *   Called for every node visited; return null fast on uninteresting types.
 * @property {(node: TsNode, source: string) => EdgeMatch[] | null} [edgesOf]
 *   Return any edges this node should produce (extends/implements/imports/calls).
 * @property {Set<string>} [skipChildrenOfTypes]
 *   Optional optimization: don't recurse into bodies of these node types.
 *   Used for, e.g., string literals or comments where tree-sitter still
 *   exposes children we don't care about.
 */

/**
 * Walk a tree-sitter tree, emitting SymbolRow/EdgeRow into the shared
 * createExtractor context.
 *
 * @param {{
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 *   spec: LanguageSpec,
 * }} args
 * @returns {{ symbols: SymbolRow[], edges: EdgeRow[], hasError: boolean }}
 */
export function extractWithTreeSitter(args) {
  const { content_hash, repo_rel_path, source, spec } = args;
  const parser = parserFor(spec.parserLang || spec.lang);
  if (!parser) {
    return { symbols: [], edges: [], hasError: false };
  }

  const ctx = createExtractor({
    content_hash,
    repo_rel_path,
    source,
    lang: spec.lang,
    stripComments: spec.stripComments ?? ((s) => s),
  });

  const tree = parser.parse(source);
  const hasError = Boolean(/** @type {TsNode} */ (tree.rootNode).hasError);
  if (hasError) {
    logAtlasError(
      `[atlas-v2 parser] tree-sitter parse error for ${repo_rel_path} (${spec.lang}); continuing with partial extraction`,
      new Error("tree-sitter parse error"),
    );
  }

  /**
   * Stack of (symbol, bodyEnd) entries representing the path from root
   * to the current node. The TOP element's symbol becomes the
   * parent_local_id of any new symbol whose body has not yet closed.
   */
  /** @type {{ sym: SymbolRow, bodyEnd: number, name: string, isType: boolean }[]} */
  const containerStack = [];

  /**
   * Index by simple name for parentName lookups (Rust impl-block fns
   * need to find their target struct by name even though it's not the
   * current container).
   */
  /** @type {Map<string, SymbolRow>} */
  const symbolsByName = new Map();

  /** @type {{ child: SymbolRow, parentName: string }[]} */
  const pendingParentNames = [];

  /** @type {{ node: TsNode, match: EdgeMatch }[]} */
  const pendingEdgeFromNames = [];

  /**
   * @param {TsNode} node
   * @param {EdgeMatch} match
   * @param {number} fromLid
   */
  const addEdgeMatch = (node, match, fromLid) => {
    if (match.fromName) {
      const found = symbolsByName.get(match.fromName);
      if (!found) {
        pendingEdgeFromNames.push({ node, match });
        return;
      }
      fromLid = found.local_id;
    } else if (match.moduleLevel) {
      fromLid = ctx.MODULE_LEVEL;
    }
    ctx.addEdge({
      from_local_id: fromLid,
      to_name: match.to_name,
      to_module: match.to_module ?? null,
      kind: match.kind,
      range_start: node.startIndex,
      range_end: node.endIndex,
      confidence: match.confidence ?? 80,
    });
  };

  /**
   * @param {TsNode} node
   */
  const visit = (node) => {
    // Pop containers we have walked past.
    while (containerStack.length > 0 && node.startIndex >= containerStack[containerStack.length - 1].bodyEnd) {
      containerStack.pop();
    }

    let symMatch = null;
    try {
      symMatch = spec.symbolOf(node, source);
    } catch {
      symMatch = null;
    }
    /** @type {SymbolRow | null} */
    let createdSym = null;
    if (symMatch) {
      const parent = containerStack.length > 0 ? containerStack[containerStack.length - 1] : null;
      // Resolve parent_local_id, in priority order:
      //   1. Explicit override from the spec (symMatch.parentName) — used
      //      by Rust to attribute impl-block methods to the target struct.
      //   2. The current container, when it's a type-like container.
      //   3. null (top-level symbol).
      let parentLocalId = null;
      let pendingParentName = null;
      if (symMatch.parentName) {
        const found = symbolsByName.get(symMatch.parentName);
        if (found) parentLocalId = found.local_id;
        else pendingParentName = symMatch.parentName;
      } else if (parent && parent.isType) {
        parentLocalId = parent.sym.local_id;
      }
      const qname = symMatch.qualified_name
        ?? (parent && symMatch.kind !== "class" && symMatch.kind !== "interface" && symMatch.kind !== "struct" && symMatch.kind !== "enum" && symMatch.kind !== "module" && symMatch.kind !== "namespace"
          ? `${parent.name}.${symMatch.name}`
          : null);
      createdSym = ctx.addSymbol({
        kind: symMatch.kind,
        name: symMatch.name,
        qualified_name: qname,
        parent_local_id: parentLocalId,
        range_start: node.startIndex,
        range_end: node.endIndex,
        signature: symMatch.signature ?? node.text.split("\n")[0]?.slice(0, 200) ?? "",
        visibility: symMatch.visibility ?? null,
        doc: symMatch.doc ?? null,
      });
      if (pendingParentName) {
        pendingParentNames.push({ child: createdSym, parentName: pendingParentName });
      }
      // Index by name for future parentName lookups. Keep the FIRST
      // symbol with each name as the canonical parent (later same-name
      // shadows are typically methods inside that class).
      if (!symbolsByName.has(symMatch.name)) {
        symbolsByName.set(symMatch.name, createdSym);
      }
      // Push as a container if it has a body. The walker continues
      // descending; children inside its body get parented.
      const body = symMatch.bodyNode ?? node;
      const isType = isContainerKind(symMatch.kind);
      containerStack.push({
        sym: createdSym,
        bodyEnd: body.endIndex,
        name: symMatch.name,
        isType,
      });
    }

    if (spec.edgesOf) {
      let edgeMatches = null;
      try {
        edgeMatches = spec.edgesOf(node, source);
      } catch {
        edgeMatches = null;
      }
      if (edgeMatches && edgeMatches.length > 0) {
        const fromLid = createdSym
          ? createdSym.local_id
          : containerStack.length > 0
            ? containerStack[containerStack.length - 1].sym.local_id
            : ctx.MODULE_LEVEL;
        for (const e of edgeMatches) {
          addEdgeMatch(node, e, fromLid);
        }
      }
    }

    if (spec.skipChildrenOfTypes?.has(node.type)) return;
    for (const child of node.children) visit(child);
  };

  visit(tree.rootNode);

  for (const pending of pendingParentNames) {
    const found = symbolsByName.get(pending.parentName);
    if (found) pending.child.parent_local_id = found.local_id;
  }

  for (const pending of pendingEdgeFromNames) {
    const found = symbolsByName.get(pending.match.fromName ?? "");
    if (!found) continue;
    addEdgeMatch(pending.node, pending.match, found.local_id);
  }

  return { ...ctx.finalize(), hasError };
}

/**
 * Kinds that scope nested member definitions. Methods inside classes
 * get parent_local_id; functions inside a module do not.
 *
 * @param {SymbolKind} kind
 * @returns {boolean}
 */
function isContainerKind(kind) {
  return (
    kind === "class" ||
    kind === "interface" ||
    kind === "struct" ||
    kind === "trait" ||
    kind === "enum" ||
    kind === "namespace" ||
    kind === "module"
  );
}

/**
 * Helper: find the first descendant of `node` with one of the given
 * `types`. Used by language specs to locate name nodes when the
 * field-name accessor isn't sufficient.
 *
 * @param {TsNode} node
 * @param {string | string[]} types
 * @returns {TsNode | null}
 */
export function firstDescendant(node, types) {
  const targets = Array.isArray(types) ? new Set(types) : new Set([types]);
  /** @type {TsNode[]} */
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (targets.has(n.type)) return n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return null;
}

/**
 * Helper: first DIRECT child of `node` matching one of `types`.
 *
 * @param {TsNode} node
 * @param {string | string[]} types
 * @returns {TsNode | null}
 */
export function firstChildOfType(node, types) {
  const targets = Array.isArray(types) ? new Set(types) : new Set([types]);
  for (const c of node.children) if (targets.has(c.type)) return c;
  return null;
}

/**
 * Helper: collect all direct children of `node` matching `types`.
 *
 * @param {TsNode} node
 * @param {string | string[]} types
 * @returns {TsNode[]}
 */
export function childrenOfType(node, types) {
  const targets = Array.isArray(types) ? new Set(types) : new Set([types]);
  /** @type {TsNode[]} */
  const out = [];
  for (const c of node.children) if (targets.has(c.type)) out.push(c);
  return out;
}
