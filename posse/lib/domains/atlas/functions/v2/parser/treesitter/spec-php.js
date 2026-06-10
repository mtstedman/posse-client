// @ts-check
//
// PHP spec for the tree-sitter walker.

import { firstChildOfType, childrenOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */

/** @returns {LanguageSpec} */
export function phpSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "php",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set([
      "string",
      "encapsed_string",
      "heredoc",
      "comment",
    ]),
  };
}

const PHP_SCOPE_NODE_TYPES = new Set([
  "program",
  "namespace_definition",
  "compound_statement",
  "function_definition",
  "method_declaration",
  "class_declaration",
  "interface_declaration",
  "trait_declaration",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "namespace_definition": {
      const ns = firstChildOfType(node, "namespace_name");
      if (!ns) return null;
      const parts = childrenOfType(ns, "name").map((c) => c.text);
      const full = parts.join("\\");
      const short = parts[parts.length - 1] || full;
      return {
        kind: "namespace",
        name: short,
        qualified_name: full,
        signature: signatureUpTo(node, [";", "compound_statement"]),
      };
    }
    case "class_declaration": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "class",
        name: id.text,
        signature: signatureUpTo(node, "declaration_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "interface_declaration": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "interface",
        name: id.text,
        signature: signatureUpTo(node, "declaration_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "trait_declaration": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "trait",
        name: id.text,
        signature: signatureUpTo(node, "declaration_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "enum_declaration": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      const body = firstChildOfType(node, "enum_declaration_list");
      return {
        kind: "enum",
        name: id.text,
        signature: signatureUpTo(node, "enum_declaration_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "function_definition": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      return {
        kind: "function",
        name: id.text,
        signature: signatureUpTo(node, "compound_statement"),
      };
    }
    case "method_declaration": {
      const id = firstChildOfType(node, "name");
      if (!id) return null;
      // Find the enclosing class/interface/trait to build the
      // qualified_name with PHP's `::` separator (the convention atlas-mcp
      // and the test suite use).
      const owner = findEnclosingDeclaration(node);
      return {
        kind: "method",
        name: id.text,
        qualified_name: owner ? `${owner}::${id.text}` : null,
        signature: signatureUpTo(node, ["compound_statement", ";"]),
        visibility: methodVisibility(node),
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
    case "base_clause": {
      // `extends Base` for both class and interface (PHP interfaces can extend
      // multiple). The walker emits this edge attributed to the enclosing
      // declaration via container stack.
      /** @type {EdgeMatch[]} */
      const out = [];
      for (const n of childrenOfType(node, ["name", "qualified_name"])) {
        const name = lastNamePartIn(n);
        if (name) out.push({ kind: "extends", to_name: name, confidence: 90 });
      }
      return out.length > 0 ? out : null;
    }
    case "class_interface_clause": {
      /** @type {EdgeMatch[]} */
      const out = [];
      for (const n of childrenOfType(node, ["name", "qualified_name"])) {
        const name = lastNamePartIn(n);
        if (name) out.push({ kind: "implements", to_name: name, confidence: 90 });
      }
      return out.length > 0 ? out : null;
    }
    case "namespace_use_declaration":
      return useEdges(node, importedNames);
    case "function_call_expression":
    case "object_creation_expression":
    case "member_call_expression":
    case "scoped_call_expression": {
      const fn = node.childForFieldName?.("function") ?? node.childForFieldName?.("name") ?? null;
      if (!fn) return null;
      const name = callName(node, fn);
      if (name && !/[.:\\]/.test(name) && importedNames.has(name) && isLocallyShadowed(node, name, {
        scopeNodeTypes: PHP_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      return name ? [{ kind: "calls", to_name: name, confidence: 60 }] : null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[]}
 */
function useEdges(node, importedNames) {
  /** @type {EdgeMatch[]} */
  const out = [];
  // `use Foo\Bar`              → namespace_use_clause > qualified_name > name(last)
  // `use Foo\{Bar, Baz}`       → namespace_use_group > namespace_use_clause(s)
  /** @type {TsNode[]} */
  const stack = [];
  for (const c of node.children) if (c.type === "namespace_use_clause" || c.type === "namespace_use_group") stack.push(c);
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.type === "namespace_use_group") {
      for (const c of cur.children) if (c.type === "namespace_use_clause") stack.push(c);
      continue;
    }
    // namespace_use_clause: take the LAST name.
    const last = lastNamePartIn(cur);
    const localName = namespaceUseLocalName(cur, last);
    if (localName) importedNames.add(localName);
    if (last) out.push({ kind: "imports", to_name: last, confidence: 85, moduleLevel: true });
  }
  return out;
}

/**
 * @param {TsNode} node
 * @param {string | null} fallback
 * @returns {string | null}
 */
function namespaceUseLocalName(node, fallback) {
  const alias = firstChildOfType(node, "namespace_aliasing_clause");
  if (!alias) return fallback;
  const id = firstDescendant(alias, "name");
  return id ? id.text : fallback;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "namespace_definition": {
      const ns = firstChildOfType(node, "namespace_name");
      if (!ns) return null;
      const parts = childrenOfType(ns, "name").map((c) => c.text);
      return parts[parts.length - 1] || null;
    }
    case "class_declaration":
    case "interface_declaration":
    case "trait_declaration":
    case "enum_declaration":
    case "function_definition":
    case "method_declaration": {
      const id = firstChildOfType(node, "name");
      return id ? id.text : null;
    }
    default:
      return null;
  }
}

/**
 * Walk up from a method_declaration to find the enclosing
 * class/interface/trait declaration's name.
 *
 * @param {TsNode} node
 * @returns {string | null}
 */
function findEnclosingDeclaration(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "class_declaration" || cur.type === "interface_declaration" || cur.type === "trait_declaration") {
      const id = firstChildOfType(cur, "name");
      return id ? id.text : null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {SymbolVisibility | null}
 */
function methodVisibility(node) {
  const mods = firstChildOfType(node, "modifier_list") ?? firstChildOfType(node, "visibility_modifier");
  if (!mods) return null;
  if (mods.type === "visibility_modifier") {
    const t = mods.text;
    if (t === "public" || t === "private" || t === "protected") return t;
  }
  for (const c of mods.children) {
    if (c.type === "visibility_modifier") {
      const t = c.text;
      if (t === "public" || t === "private" || t === "protected") return /** @type {SymbolVisibility} */ (t);
    }
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function lastNamePartIn(node) {
  if (node.type === "name") return node.text;
  const names = [];
  /** @type {TsNode[]} */
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === "name") names.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return names.length > 0 ? names[names.length - 1].text : null;
}

/**
 * @param {TsNode} callNode
 * @param {TsNode} nameNode
 * @returns {string | null}
 */
function callName(callNode, nameNode) {
  if (callNode.type === "member_call_expression") {
    const object = callNode.childForFieldName?.("object") ?? null;
    const objectName = object ? calleeName(object) : null;
    const member = calleeName(nameNode);
    return objectName && member ? `${objectName}.${member}` : member;
  }
  if (callNode.type === "scoped_call_expression") {
    const member = calleeName(nameNode);
    const scope = callNode.children.find((c) => c !== nameNode && c.type !== "::" && c.type !== "arguments");
    const scopeName = scope ? calleeName(scope) : null;
    return scopeName && member ? `${scopeName}::${member}` : member;
  }
  return calleeName(nameNode);
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "name") return node.text;
  if (node.type === "variable_name" || node.type === "relative_scope") return node.text;
  if (node.type === "qualified_name") return lastNamePartIn(node);
  if (node.type === "member_access_expression") {
    const field = node.childForFieldName?.("name") ?? null;
    return field ? field.text : null;
  }
  const inner = firstDescendant(node, "name");
  return inner ? inner.text : null;
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
