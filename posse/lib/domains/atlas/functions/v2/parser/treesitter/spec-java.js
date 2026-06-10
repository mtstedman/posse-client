// @ts-check
//
// Java spec for the tree-sitter walker. Mirrors atlas-mcp's Java adapter.

import { firstChildOfType, firstDescendant, childrenOfType } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */

/** @returns {LanguageSpec} */
export function javaSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "java",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set(["string_literal", "character_literal", "line_comment", "block_comment"]),
  };
}

const JAVA_SCOPE_NODE_TYPES = new Set([
  "program",
  "class_body",
  "interface_body",
  "enum_body",
  "block",
  "method_declaration",
  "constructor_declaration",
  "lambda_expression",
  "catch_clause",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "class_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "class_body");
      return {
        kind: "class",
        name: id.text,
        signature: signatureUpTo(node, "class_body"),
        visibility: modifierVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "interface_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "interface_body");
      return {
        kind: "interface",
        name: id.text,
        signature: signatureUpTo(node, "interface_body"),
        visibility: modifierVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "enum_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "enum_body");
      return {
        kind: "enum",
        name: id.text,
        signature: signatureUpTo(node, "enum_body"),
        visibility: modifierVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "method_declaration":
    case "constructor_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: "method",
        name: id.text,
        signature: signatureUpTo(node, ["block", ";"]),
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
    case "superclass": {
      // `extends Base`
      const t = firstChildOfType(node, ["type_identifier", "generic_type", "scoped_type_identifier"]);
      if (!t) return null;
      const name = lastTypeName(t);
      return name ? [{ kind: "extends", to_name: name, confidence: 90 }] : null;
    }
    case "super_interfaces": {
      // `implements I1, I2`
      const list = firstChildOfType(node, "type_list");
      if (!list) return null;
      /** @type {EdgeMatch[]} */
      const edges = [];
      for (const t of childrenOfType(list, ["type_identifier", "generic_type", "scoped_type_identifier"])) {
        const name = lastTypeName(t);
        if (name) edges.push({ kind: "implements", to_name: name, confidence: 90 });
      }
      return edges;
    }
    case "extends_interfaces": {
      // interface extends interface — Java grammar uses this.
      const list = firstChildOfType(node, "type_list");
      if (!list) return null;
      /** @type {EdgeMatch[]} */
      const edges = [];
      for (const t of childrenOfType(list, ["type_identifier", "generic_type", "scoped_type_identifier"])) {
        const name = lastTypeName(t);
        if (name) edges.push({ kind: "extends", to_name: name, confidence: 90 });
      }
      return edges;
    }
    case "import_declaration": {
      // `import a.b.C;` → last segment as imported name.
      const scoped = firstChildOfType(node, ["scoped_identifier", "identifier"]);
      if (!scoped) return null;
      const name = lastIdentifierIn(scoped);
      if (name) importedNames.add(name);
      return name ? [{ kind: "imports", to_name: name, confidence: 85, moduleLevel: true }] : null;
    }
    case "method_invocation": {
      const name = node.childForFieldName?.("name") ?? null;
      if (!name) return null;
      const object = node.childForFieldName?.("object") ?? null;
      if (!object && importedNames.has(name.text) && isLocallyShadowed(node, name.text, {
        scopeNodeTypes: JAVA_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      const objectName = object ? expressionName(object) : null;
      return [{ kind: "calls", to_name: objectName ? `${objectName}.${name.text}` : name.text, confidence: 60 }];
    }
    case "object_creation_expression": {
      // `new Foo(...)` → calls Foo
      const t = firstChildOfType(node, ["type_identifier", "scoped_type_identifier", "generic_type"]);
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
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "class_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "method_declaration":
    case "constructor_declaration": {
      const id = firstChildOfType(node, "identifier");
      return id ? id.text : null;
    }
    case "variable_declarator":
    case "formal_parameter":
    case "catch_formal_parameter": {
      const id = firstChildOfType(node, "identifier") ?? firstDescendant(node, "identifier");
      return id ? id.text : null;
    }
    case "enhanced_for_statement": {
      const id = firstDescendant(node, "identifier");
      return id ? id.text : null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function expressionName(node) {
  if (
    node.type === "identifier" ||
    node.type === "type_identifier" ||
    node.type === "this" ||
    node.type === "super"
  ) {
    return node.text;
  }
  if (node.type === "field_access") {
    const object = node.childForFieldName?.("object") ?? null;
    const field = node.childForFieldName?.("field") ?? null;
    if (!field) return null;
    const prefix = object ? expressionName(object) : null;
    return prefix ? `${prefix}.${field.text}` : field.text;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {SymbolVisibility | null}
 */
function modifierVisibility(node) {
  const mods = firstChildOfType(node, "modifiers");
  if (!mods) return null;
  for (const c of mods.children) {
    if (c.type === "public" || c.type === "private" || c.type === "protected") {
      return /** @type {SymbolVisibility} */ (c.type);
    }
  }
  return null;
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

/**
 * @param {TsNode} typeNode
 * @returns {string | null}
 */
function lastTypeName(typeNode) {
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type") {
    const inner = firstChildOfType(typeNode, ["type_identifier", "scoped_type_identifier"]);
    if (inner) return lastTypeName(inner);
  }
  if (typeNode.type === "scoped_type_identifier") {
    const ids = childrenOfType(typeNode, ["identifier", "type_identifier"]);
    return ids.length > 0 ? ids[ids.length - 1].text : null;
  }
  const inner = firstDescendant(typeNode, ["type_identifier", "identifier"]);
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function lastIdentifierIn(node) {
  // Iterative DFS that pushes children in reverse so popping yields
  // source order. The collected list is therefore already in source
  // order; the LAST element is the rightmost identifier.
  /** @type {TsNode[]} */
  const ids = [];
  /** @type {TsNode[]} */
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === "identifier" || n.type === "asterisk") ids.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  const last = ids.length > 0 ? ids[ids.length - 1] : null;
  if (!last) return null;
  if (last.type === "asterisk") return null;
  return last.text;
}
