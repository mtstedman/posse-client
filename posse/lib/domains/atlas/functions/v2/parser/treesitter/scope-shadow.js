// @ts-check
//
// Conservative local-shadow detection for heuristic call edges. When a
// call's bare callee name also appears as an imported name, a local
// binding with the same name should suppress the cross-file call edge.

/** @typedef {import("./walker.js").TsNode} TsNode */

const DEFAULT_SKIP_NODE_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "import_header",
  "import_spec",
  "using_directive",
  "namespace_use_declaration",
  "use_declaration",
]);

/**
 * @typedef {Object} ScopeShadowOptions
 * @property {Set<string>} scopeNodeTypes
 * @property {(node: TsNode) => string | string[] | null} bindingNameOf
 * @property {Set<string>} [skipNodeTypes]
 */

/**
 * True when `name` is bound by an enclosing lexical scope before/around
 * `callNode`. We deliberately do not try to resolve the local target; this is
 * only a guard against silently emitting an edge to an imported symbol when a
 * local binding shadows it.
 *
 * @param {TsNode} callNode
 * @param {string} name
 * @param {ScopeShadowOptions} options
 * @returns {boolean}
 */
export function isLocallyShadowed(callNode, name, options) {
  if (!name) return false;
  let cur = callNode.parent;
  while (cur) {
    if (options.scopeNodeTypes.has(cur.type) && scopeHasBinding(cur, name, callNode, options)) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * @param {TsNode} scope
 * @param {string} name
 * @param {TsNode} callNode
 * @param {ScopeShadowOptions} options
 * @returns {boolean}
 */
function scopeHasBinding(scope, name, callNode, options) {
  const skipNodeTypes = options.skipNodeTypes ?? DEFAULT_SKIP_NODE_TYPES;

  /** @param {TsNode} node @returns {boolean} */
  const visit = (node) => {
    if (skipNodeTypes.has(node.type)) return false;
    if (bindingMatches(options.bindingNameOf(node), name)) return true;
    if (node !== scope && options.scopeNodeTypes.has(node.type) && !containsNode(node, callNode)) {
      return false;
    }

    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };

  for (const child of scope.children) {
    if (visit(child)) return true;
  }
  return false;
}

/**
 * @param {string | string[] | null} binding
 * @param {string} name
 * @returns {boolean}
 */
function bindingMatches(binding, name) {
  if (Array.isArray(binding)) return binding.includes(name);
  return binding === name;
}

/**
 * @param {TsNode} container
 * @param {TsNode} node
 * @returns {boolean}
 */
export function containsNode(container, node) {
  return container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;
}
