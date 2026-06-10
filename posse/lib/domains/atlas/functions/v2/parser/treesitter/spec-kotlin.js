// @ts-check
//
// Kotlin spec for the tree-sitter walker.

import { firstChildOfType, childrenOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */

/** @returns {LanguageSpec} */
export function kotlinSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "kt",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set(["string_literal", "comment", "shebang_line"]),
  };
}

const KOTLIN_SCOPE_NODE_TYPES = new Set([
  "source_file",
  "class_body",
  "function_declaration",
  "function_body",
  "statements",
  "lambda_literal",
  "control_structure_body",
  "catch_block",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "object_declaration": {
      const id = firstChildOfType(node, ["type_identifier", "simple_identifier"]);
      if (!id) return null;
      const body = firstChildOfType(node, "class_body");
      return {
        kind: "namespace",
        name: id.text,
        signature: signatureUpTo(node, "class_body"),
        visibility: kotlinVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "class_declaration": {
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      // Determine class vs interface vs object by the leading keyword.
      const head = node.firstChild;
      let kind = /** @type {import("../../contracts/schemas.js").SymbolKind} */ ("class");
      if (head?.type === "interface" || nodeStartsWithKeyword(node, "interface")) kind = "interface";
      else if (head?.type === "object" || nodeStartsWithKeyword(node, "object")) kind = "namespace";
      const body = firstChildOfType(node, "class_body");
      return {
        kind,
        name: id.text,
        signature: signatureUpTo(node, "class_body"),
        visibility: kotlinVisibility(node),
        bodyNode: body ?? undefined,
      };
    }
    case "function_declaration": {
      const id = firstChildOfType(node, "simple_identifier");
      if (!id) return null;
      // Tree-sitter doesn't distinguish method vs free fn directly; the
      // walker's container stack gives us the right answer via parent attribution.
      // We still tag as method when the ancestor includes a class_body.
      const isMethod = hasAncestor(node, "class_body");
      return {
        kind: isMethod ? "method" : "function",
        name: id.text,
        signature: signatureUpTo(node, "function_body"),
        visibility: kotlinVisibility(node),
      };
    }
    case "property_declaration": {
      // val/var ANSWER = 42 — only emit at file scope or class scope.
      // Locals inside function bodies live under a `function_body` /
      // `statements` ancestor and should be dropped.
      if (hasAncestor(node, ["function_body", "statements", "control_structure_body"])) return null;
      const decl = firstChildOfType(node, "variable_declaration");
      if (!decl) return null;
      const id = firstChildOfType(decl, "simple_identifier");
      if (!id) return null;
      const binding = firstChildOfType(node, "binding_pattern_kind");
      const isVal = binding?.firstChild?.type === "val";
      return {
        kind: isVal ? "const" : "var",
        name: id.text,
        signature: signatureUpTo(node, ["=", ";"]),
        visibility: kotlinVisibility(node),
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
    case "delegation_specifier": {
      // `: Base(), Greeting` — list of delegation specifiers separated by ",".
      // Each specifier is either a constructor_invocation (Base()) or a
      // bare user_type (Greeting). Kotlin doesn't lexically distinguish
      // class vs interface here; emit as extends.
      const inv = firstChildOfType(node, "constructor_invocation");
      const target = inv ? firstChildOfType(inv, "user_type") : firstChildOfType(node, "user_type");
      if (!target) return null;
      const id = firstChildOfType(target, "type_identifier");
      if (!id) return null;
      return [{ kind: "extends", to_name: id.text, confidence: 80 }];
    }
    case "import_header": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      // Take the LAST simple_identifier in source order.
      const ids = childrenOfType(id, "simple_identifier");
      const name = ids.length > 0 ? ids[ids.length - 1].text : null;
      if (!name || name === "*") return null;
      importedNames.add(name);
      return [{ kind: "imports", to_name: name, confidence: 85, moduleLevel: true }];
    }
    case "call_expression": {
      const callee = node.firstChild;
      if (!callee) return null;
      const name = calleeName(callee);
      if (callee.type === "simple_identifier" && name && importedNames.has(name) && isLocallyShadowed(node, name, {
        scopeNodeTypes: KOTLIN_SCOPE_NODE_TYPES,
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
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "object_declaration": {
      const id = firstChildOfType(node, ["type_identifier", "simple_identifier"]);
      return id ? id.text : null;
    }
    case "class_declaration": {
      const id = firstChildOfType(node, "type_identifier");
      return id ? id.text : null;
    }
    case "function_declaration": {
      const id = firstChildOfType(node, "simple_identifier");
      return id ? id.text : null;
    }
    case "property_declaration":
    case "variable_declaration":
    case "parameter":
    case "catch_block": {
      const id = firstDescendant(node, "simple_identifier");
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
function kotlinVisibility(node) {
  const mods = firstChildOfType(node, "modifiers");
  if (!mods) return null;
  for (const c of mods.children) {
    if (c.type === "visibility_modifier") {
      const t = c.text;
      if (t === "public" || t === "private" || t === "protected" || t === "internal") {
        return /** @type {SymbolVisibility} */ (t);
      }
    }
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "simple_identifier") return node.text;
  if (node.type === "navigation_expression") {
    return node.text.replace(/\s+/g, "");
  }
  return null;
}

/**
 * @param {TsNode} node
 * @param {string} kw
 */
function nodeStartsWithKeyword(node, kw) {
  for (const c of node.children) {
    if (c.type === "modifiers") continue;
    return c.type === kw;
  }
  return false;
}

/**
 * @param {TsNode} node
 * @param {string | string[]} types
 */
function hasAncestor(node, types) {
  const targets = Array.isArray(types) ? new Set(types) : new Set([types]);
  let cur = node.parent;
  while (cur) {
    if (targets.has(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
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
