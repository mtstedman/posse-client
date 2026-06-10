// @ts-check
//
// Go spec for the tree-sitter walker. Mirrors atlas-mcp's Go adapter.

import { firstChildOfType, childrenOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */

/** @returns {LanguageSpec} */
export function goSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "go",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set(["interpreted_string_literal", "raw_string_literal", "comment"]),
  };
}

const GO_SCOPE_NODE_TYPES = new Set([
  "source_file",
  "block",
  "function_declaration",
  "method_declaration",
  "func_literal",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "function_declaration": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: "function",
        name: id.text,
        signature: signatureUpTo(node, "block"),
        visibility: isCapitalized(id.text) ? "public" : "private",
      };
    }
    case "method_declaration": {
      const id = firstChildOfType(node, "field_identifier");
      if (!id) return null;
      const recvType = receiverTypeName(node);
      return {
        kind: "method",
        name: id.text,
        qualified_name: recvType ? `${recvType}.${id.text}` : null,
        signature: signatureUpTo(node, "block"),
        visibility: isCapitalized(id.text) ? "public" : "private",
      };
    }
    case "type_spec": {
      // type Foo struct {...} / type Foo interface {...} / type Foo = X
      // Only emit when at file scope; type_spec inside a function body
      // is a local type alias that doesn't belong in the symbol table.
      if (!isFileScope(node)) return null;
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, ["struct_type", "interface_type"]);
      let kind = /** @type {import("../../contracts/schemas.js").SymbolKind} */ ("type");
      if (body?.type === "struct_type") kind = "struct";
      else if (body?.type === "interface_type") kind = "interface";
      return {
        kind,
        name: id.text,
        signature: signatureUpTo(node, ["field_declaration_list", "method_spec_list"]),
        visibility: isCapitalized(id.text) ? "public" : "private",
        bodyNode: body ?? undefined,
      };
    }
    case "const_spec":
    case "var_spec": {
      // const A = 1 / const ( A = 1; B = 2 ) — emit one symbol per binding.
      // Function-local const/var (`const x = 1` inside a func body) is
      // also a const_spec/var_spec node, but it lives under a
      // short_var_declaration / block ancestor; skip those.
      if (!isFileScope(node)) return null;
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: node.type === "const_spec" ? "const" : "var",
        name: id.text,
        signature: node.text.split("\n")[0].slice(0, 200).trim(),
        visibility: isCapitalized(id.text) ? "public" : "private",
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
    case "import_spec": {
      // `_ "fmt"` / `m "fmt"` / `"fmt"`.
      const lit = firstChildOfType(node, ["interpreted_string_literal", "raw_string_literal"]);
      if (!lit) return null;
      const path = stripQuotes(lit.text);
      if (!path) return null;
      const localName = importLocalName(node, path);
      if (localName) importedNames.add(localName);
      return [{ kind: "imports", to_name: localName || importBaseName(path), to_module: path, confidence: 85, moduleLevel: true }];
    }
    case "call_expression": {
      const callee = node.childForFieldName?.("function") ?? null;
      if (!callee) return null;
      const name = calleeName(callee);
      if (!name) return null;
      const shadowName = callee.type === "selector_expression"
        ? selectorRootName(callee)
        : callee.type === "identifier"
          ? name
          : null;
      if (shadowName && importedNames.has(shadowName) && isLocallyShadowed(node, shadowName, {
        scopeNodeTypes: GO_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      return [{ kind: "calls", to_name: name, confidence: 60 }];
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @param {string} importPath
 * @returns {string | null}
 */
function importLocalName(node, importPath) {
  const alias = firstChildOfType(node, ["package_identifier", "identifier", "dot"]);
  if (alias && alias.type !== "dot" && alias.text !== "_") return alias.text;
  const base = importBaseName(importPath);
  return base && base !== "." && base !== "_" ? base : null;
}

/**
 * @param {string} importPath
 * @returns {string}
 */
function importBaseName(importPath) {
  const trimmed = importPath.replace(/\/v[1-9]\d*$/, "");
  const base = trimmed.split("/").pop() || importPath;
  return base.replace(/[^A-Za-z0-9_.$-].*$/, "") || importPath;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "function_declaration": {
      const id = firstChildOfType(node, "identifier");
      return id ? id.text : null;
    }
    case "method_declaration": {
      const id = firstChildOfType(node, "field_identifier");
      return id ? id.text : null;
    }
    case "type_spec": {
      const id = firstChildOfType(node, "type_identifier");
      return id ? id.text : null;
    }
    case "const_spec":
    case "var_spec":
    case "short_var_declaration":
    case "parameter_declaration": {
      const id = firstDescendant(node, ["identifier", "field_identifier"]);
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
function receiverTypeName(node) {
  // method_declaration has a parameter_list before the field_identifier
  // containing one parameter_declaration whose type is the receiver.
  const lists = childrenOfType(node, "parameter_list");
  if (lists.length === 0) return null;
  const recvList = lists[0];
  const decl = firstChildOfType(recvList, "parameter_declaration");
  if (!decl) return null;
  // Look for a type_identifier; if the receiver is a pointer_type, strip *.
  const ptr = firstChildOfType(decl, "pointer_type");
  if (ptr) {
    const id = firstChildOfType(ptr, "type_identifier") ?? firstDescendant(ptr, "type_identifier");
    return id ? id.text : null;
  }
  const id = firstChildOfType(decl, "type_identifier") ?? firstDescendant(decl, "type_identifier");
  return id ? id.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "selector_expression") {
    return selectorName(node);
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function selectorName(node) {
  if (node.type === "identifier" || node.type === "field_identifier") return node.text;
  if (node.type !== "selector_expression") return null;
  const operand = node.childForFieldName?.("operand") ?? null;
  const field = node.childForFieldName?.("field") ?? null;
  if (!field) return null;
  const prefix = operand ? selectorName(operand) : null;
  return prefix ? `${prefix}.${field.text}` : field.text;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function selectorRootName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type !== "selector_expression") return null;
  const operand = node.childForFieldName?.("operand") ?? null;
  return operand ? selectorRootName(operand) : null;
}

/**
 * @param {string} text
 */
function stripQuotes(text) {
  if (text.length < 2) return text;
  const f = text[0];
  const l = text[text.length - 1];
  if ((f === '"' && l === '"') || (f === "`" && l === "`")) return text.slice(1, -1);
  return text;
}

/**
 * @param {string} name
 */
function isCapitalized(name) {
  return /^[A-Z]/.test(name);
}

/**
 * True when `node` lives at file scope. Walks the ancestor chain
 * looking for a `block` (function body) before reaching `source_file`.
 * Used to filter out local `const x = 1` / `type localT int` that
 * shouldn't surface in the symbol table.
 *
 * @param {TsNode} node
 * @returns {boolean}
 */
function isFileScope(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "block") return false;
    if (cur.type === "source_file") return true;
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
