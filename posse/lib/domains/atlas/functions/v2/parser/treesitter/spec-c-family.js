// @ts-check
//
// Shared spec for C and C++. Tree-sitter exposes distinct grammars
// (tree-sitter-c vs tree-sitter-cpp) but they share most node types
// for the cross-section we care about — typedef/struct/enum/function.
// C++ adds class_specifier and base_class_clause.

import { firstChildOfType, firstDescendant, childrenOfType } from "./walker.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */

/**
 * @param {"c" | "cpp"} lang
 * @returns {LanguageSpec}
 */
export function cFamilySpec(lang) {
  return {
    lang,
    symbolOf: (node) => symbolOf(node, lang),
    edgesOf,
    skipChildrenOfTypes: new Set([
      "string_literal",
      "concatenated_string",
      "comment",
      "preproc_arg",
    ]),
  };
}

/**
 * @param {TsNode} node
 * @param {"c" | "cpp"} lang
 * @returns {SymbolMatch | null}
 */
function symbolOf(node, lang) {
  switch (node.type) {
    case "function_definition": {
      const declarator = firstChildOfType(node, "function_declarator")
        ?? firstDescendant(node, "function_declarator");
      if (!declarator) return null;
      const id = firstChildOfType(declarator, ["identifier", "field_identifier", "destructor_name"]);
      if (!id) return null;
      const name = id.text.replace(/^~/, "~"); // keep destructor tilde
      const isMethod = lang === "cpp" && hasAncestor(node, "field_declaration_list");
      return {
        kind: isMethod ? "method" : "function",
        name,
        signature: signatureUpTo(node, "compound_statement"),
      };
    }
    case "class_specifier":
    case "struct_specifier": {
      // C++ class { ... } / class Foo { ... }
      // C struct Foo { ... } / typedef struct Foo { ... } X;
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "field_declaration_list");
      // C struct emits as `struct`, C++ class emits as `class`, C++ struct also `struct`.
      /** @type {SymbolKind} */
      const kind = node.type === "class_specifier" ? "class" : "struct";
      return {
        kind,
        name: id.text,
        signature: signatureUpTo(node, "field_declaration_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "enum_specifier": {
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "enumerator_list");
      return {
        kind: "enum",
        name: id.text,
        signature: signatureUpTo(node, "enumerator_list"),
        bodyNode: body ?? undefined,
      };
    }
    case "type_definition": {
      // typedef <stuff> Name; — the alias name is the last type_identifier
      // child after the declared type. We grab the last one in source order.
      const ids = childrenOfType(node, "type_identifier");
      if (ids.length === 0) return null;
      const name = ids[ids.length - 1].text;
      return {
        kind: "type",
        name,
        signature: node.text.split("\n")[0].slice(0, 200).trim(),
      };
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @returns {EdgeMatch[] | null}
 */
function edgesOf(node) {
  switch (node.type) {
    case "base_class_clause": {
      /** @type {EdgeMatch[]} */
      const out = [];
      for (const t of childrenOfType(node, ["type_identifier", "template_type", "qualified_identifier"])) {
        const name = lastTypeName(t);
        if (name) out.push({ kind: "extends", to_name: name, confidence: 85 });
      }
      return out.length > 0 ? out : null;
    }
    case "preproc_include": {
      // #include <foo.h> / "foo.h"
      const lit = firstChildOfType(node, ["system_lib_string", "string_literal"]);
      if (!lit) return null;
      const raw = lit.text;
      const inner = raw.replace(/^[<"]|[>"]$/g, "");
      return [{ kind: "imports", to_name: inner, confidence: 80, moduleLevel: true }];
    }
    case "call_expression": {
      const fn = node.childForFieldName?.("function") ?? null;
      if (!fn) return null;
      const name = calleeName(fn);
      return name ? [{ kind: "calls", to_name: name, confidence: 55 }] : null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} typeNode
 * @returns {string | null}
 */
function lastTypeName(typeNode) {
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "template_type") {
    const id = firstChildOfType(typeNode, "type_identifier");
    return id ? id.text : null;
  }
  if (typeNode.type === "qualified_identifier") {
    const ids = childrenOfType(typeNode, "type_identifier");
    if (ids.length > 0) return ids[ids.length - 1].text;
  }
  const inner = firstDescendant(typeNode, "type_identifier");
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression") {
    return node.text.replace(/\s+/g, "");
  }
  if (node.type === "qualified_identifier") {
    return node.text.replace(/\s+/g, "");
  }
  return null;
}

/**
 * @param {TsNode} node
 * @param {string} type
 * @returns {boolean}
 */
function hasAncestor(node, type) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === type) return true;
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
