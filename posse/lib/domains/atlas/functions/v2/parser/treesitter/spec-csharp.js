// @ts-check
//
// C# spec for the tree-sitter walker. Mirrors atlas-mcp's C# adapter.

import { firstChildOfType, childrenOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */

/** @returns {LanguageSpec} */
export function csharpSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "cs",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set([
      "string_literal",
      "verbatim_string_literal",
      "interpolated_string_expression",
      "comment",
    ]),
  };
}

const CSHARP_SCOPE_NODE_TYPES = new Set([
  "compilation_unit",
  "namespace_declaration",
  "file_scoped_namespace_declaration",
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "block",
  "method_declaration",
  "constructor_declaration",
  "lambda_expression",
  "anonymous_method_expression",
  "catch_clause",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "namespace_declaration":
    case "file_scoped_namespace_declaration": {
      const name = qualifiedNameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "namespace",
        name: name.split(".").pop() || name,
        qualified_name: name,
        signature: signatureUpTo(node, ["declaration_list", ";"]),
        bodyNode: body ?? undefined,
      };
    }
    case "class_declaration":
    case "interface_declaration":
    case "struct_declaration":
    case "enum_declaration":
    case "record_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const kind =
        node.type === "interface_declaration" ? "interface"
        : node.type === "struct_declaration" ? "struct"
        : node.type === "enum_declaration" ? "enum"
        : "class";
      const body = firstChildOfType(node, ["declaration_list", "enum_member_declaration_list"]);
      return {
        kind: /** @type {import("../../contracts/schemas.js").SymbolKind} */ (kind),
        name: id.text,
        signature: signatureUpTo(node, ["declaration_list", "enum_member_declaration_list", "{"]),
        visibility: modifierVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "method_declaration":
    case "constructor_declaration":
    case "destructor_declaration":
    case "operator_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: "method",
        name: id.text,
        signature: signatureUpTo(node, ["block", "arrow_expression_clause", ";"]),
        visibility: modifierVisibility(node),
      };
    }
    case "property_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: "var",
        name: id.text,
        signature: signatureUpTo(node, ["accessor_list", "arrow_expression_clause", ";"]),
        visibility: modifierVisibility(node),
      };
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[] | null}
 */
function edgesOf(node, importedNames) {
  switch (node.type) {
    case "base_list": {
      // C# base-list syntax like `Foo : Bar, IBaz` doesn't distinguish base
      // class from interfaces (a single `:` followed by a comma-separated
      // list of types). We emit every entry as `extends`. Downstream
      // consumers that need class-vs-interface can look at the target
      // symbol's kind.
      /** @type {EdgeMatch[]} */
      const out = [];
      for (const t of childrenOfType(node, ["identifier", "generic_name", "qualified_name"])) {
        const name = lastTypeName(t);
        if (!name) continue;
        out.push({ kind: "extends", to_name: name, confidence: 70 });
      }
      return out.length > 0 ? out : null;
    }
    case "using_directive": {
      const target = firstChildOfType(node, ["identifier", "qualified_name", "name_equals"]);
      if (!target) return null;
      const name = lastIdentifierIn(target);
      const localName = usingLocalName(node, name);
      if (localName) importedNames.add(localName);
      return name ? [{ kind: "imports", to_name: name, confidence: 85, moduleLevel: true }] : null;
    }
    case "invocation_expression": {
      const fn = node.childForFieldName?.("function") ?? null;
      if (!fn) return null;
      const name = calleeName(fn);
      if (fn.type === "identifier" && name && importedNames.has(name) && isLocallyShadowed(node, name, {
        scopeNodeTypes: CSHARP_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      return name ? [{ kind: "calls", to_name: name, confidence: 60 }] : null;
    }
    case "object_creation_expression": {
      const t = node.childForFieldName?.("type") ?? null;
      if (!t) return null;
      const name = lastTypeName(t);
      return name ? [{ kind: "calls", to_name: name, confidence: 70 }] : null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @param {string | null} fallback
 * @returns {string | null}
 */
function usingLocalName(node, fallback) {
  const alias = firstChildOfType(node, "name_equals");
  if (!alias) return fallback;
  const id = firstDescendant(alias, "identifier");
  return id ? id.text : fallback;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "namespace_declaration":
    case "file_scoped_namespace_declaration":
      return qualifiedNameOf(node)?.split(".").pop() || null;
    case "class_declaration":
    case "interface_declaration":
    case "struct_declaration":
    case "enum_declaration":
    case "record_declaration":
    case "method_declaration":
    case "constructor_declaration":
    case "destructor_declaration":
    case "operator_declaration":
    case "variable_declarator":
    case "parameter": {
      const id = firstChildOfType(node, "identifier") ?? firstDescendant(node, "identifier");
      return id ? id.text : null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @returns {SymbolVisibility | null}
 */
function modifierVisibility(node) {
  for (const c of node.children) {
    if (c.type !== "modifier") continue;
    const t = c.text;
    if (t === "public" || t === "private" || t === "protected" || t === "internal") {
      return /** @type {SymbolVisibility} */ (t === "internal" ? "internal" : t);
    }
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function qualifiedNameOf(node) {
  const q = firstChildOfType(node, ["qualified_name", "identifier"]);
  if (!q) return null;
  return q.type === "identifier" ? q.text : q.text;
}

/**
 * @param {TsNode} typeNode
 * @returns {string | null}
 */
function lastTypeName(typeNode) {
  if (typeNode.type === "identifier") return typeNode.text;
  if (typeNode.type === "generic_name") {
    const id = firstChildOfType(typeNode, "identifier");
    return id ? id.text : null;
  }
  if (typeNode.type === "qualified_name") {
    const ids = childrenOfType(typeNode, ["identifier", "generic_name"]);
    if (ids.length > 0) return lastTypeName(ids[ids.length - 1]);
  }
  const inner = firstDescendant(typeNode, "identifier");
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_access_expression") {
    return node.text.replace(/\s+/g, "");
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function lastIdentifierIn(node) {
  if (node.type === "identifier") return node.text;
  // DFS pushing children in reverse so popping yields source order.
  // The last collected identifier is the rightmost in source.
  /** @type {TsNode[]} */
  const ids = [];
  /** @type {TsNode[]} */
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === "identifier") ids.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return ids.length > 0 ? ids[ids.length - 1].text : null;
}

/**
 * @param {TsNode} node
 * @param {string | string[]} terminator
 */
function signatureUpTo(node, terminator) {
  const targets = Array.isArray(terminator) ? new Set(terminator) : new Set([terminator]);
  const term = node.children.find((c) => targets.has(c.type));
  if (!term) return node.text.split("\n")[0].slice(0, 200);
  return node.text.slice(0, term.startIndex - node.startIndex).trim();
}
