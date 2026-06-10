// @ts-check
//
// Rust spec for the tree-sitter walker. Mirrors atlas-mcp's Rust adapter.

import { firstChildOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */

/**
 * Rust's `impl Trait for Type { fn method(...) {...} }` block contains
 * methods that should be parented to `Type` (the struct/enum the
 * methods belong to), with qualified_name `Type::method`. The walker
 * doesn't know about this because the impl block isn't itself a
 * symbol — it just changes how methods are attributed.
 *
 * The spec maintains a per-extract map: implTargetByEndOffset. When
 * the walker enters a `function_item` we look up the smallest enclosing
 * impl block via the offsets we've recorded and use its target name.
 *
 * @returns {LanguageSpec}
 */
export function rustSpec() {
  /** @type {{ target: string, endIndex: number, startIndex: number }[]} */
  const implStack = [];
  /** @type {Set<string>} */
  const importedNames = new Set();

  return {
    lang: "rs",
    symbolOf: (node, source) => symbolOf(node, source, implStack),
    edgesOf: (node, source) => edgesOf(node, source, implStack, importedNames),
    skipChildrenOfTypes: new Set(["string_literal", "raw_string_literal", "line_comment", "block_comment"]),
  };
}

const RUST_SCOPE_NODE_TYPES = new Set([
  "source_file",
  "declaration_list",
  "block",
  "function_item",
  "closure_expression",
  "impl_item",
  "trait_item",
]);

/** @typedef {{ target: string, endIndex: number, startIndex: number }} ImplFrame */

/**
 * @param {TsNode} node
 * @param {string} _source
 * @param {ImplFrame[]} implStack
 * @returns {SymbolMatch | null}
 */
function symbolOf(node, _source, implStack) {
  // Pop frames we've walked past so impl-target lookup is correct.
  while (implStack.length > 0 && node.startIndex >= implStack[implStack.length - 1].endIndex) {
    implStack.pop();
  }
  switch (node.type) {
    case "function_item":
    case "function_signature_item": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const implFrame = implStack.length > 0 ? implStack[implStack.length - 1] : null;
      const inImpl = !!implFrame;
      const inTrait = !implFrame && hasAncestor(node, "trait_item");
      const traitName = inTrait ? ancestorTypeName(node, "trait_item") : null;
      const isMethod = inImpl || inTrait;
      return {
        kind: isMethod ? "method" : "function",
        name: id.text,
        // impl Trait for Greeter { fn hello() } → qualified_name "Greeter::hello",
        // parent_local_id resolved by the walker via parentName.
        qualified_name: implFrame ? `${implFrame.target}::${id.text}` : traitName ? `${traitName}::${id.text}` : null,
        parentName: implFrame ? implFrame.target : null,
        signature: signatureUpTo(node, "block"),
        visibility: visibilityOf(node),
      };
    }
    case "struct_item": {
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "field_declaration_list");
      return {
        kind: "struct",
        name: id.text,
        signature: signatureUpTo(node, ["field_declaration_list", ";"]),
        visibility: visibilityOf(node),
        bodyNode: body ?? undefined,
      };
    }
    case "enum_item": {
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "enum_variant_list");
      return {
        kind: "enum",
        name: id.text,
        signature: signatureUpTo(node, "enum_variant_list"),
        visibility: visibilityOf(node),
        bodyNode: body ?? undefined,
      };
    }
    case "trait_item": {
      const id = firstChildOfType(node, "type_identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "trait",
        name: id.text,
        signature: signatureUpTo(node, "declaration_list"),
        visibility: visibilityOf(node),
        bodyNode: body ?? undefined,
      };
    }
    case "mod_item": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      const body = firstChildOfType(node, "declaration_list");
      return {
        kind: "module",
        name: id.text,
        signature: signatureUpTo(node, "declaration_list"),
        visibility: visibilityOf(node),
        bodyNode: body ?? undefined,
      };
    }
    case "const_item":
    case "static_item": {
      const id = firstChildOfType(node, "identifier");
      if (!id) return null;
      return {
        kind: "const",
        name: id.text,
        signature: signatureUpTo(node, ";"),
        visibility: visibilityOf(node),
      };
    }
    case "impl_item": {
      // `impl X for Y { ... }` — emit no symbol but capture an implements
      // edge in edgesOf. We don't push impl as a container because methods
      // inside it should be parented to the *target* type, but we don't have
      // a SymbolRow for an external type. Methods inside impl land as
      // `method` with qualified_name `Y::method` (matching atlas-mcp).
      return null;
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @param {string} _source
 * @param {ImplFrame[]} implStack
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[] | null}
 */
function edgesOf(node, _source, implStack, importedNames) {
  switch (node.type) {
    case "impl_item": {
      // Push a frame so children's symbolOf can attribute methods.
      const ids = node.children.filter((c) => c.type === "type_identifier" || c.type === "generic_type" || c.type === "scoped_type_identifier");
      const forKw = node.children.find((c) => c.type === "for");
      // With `impl Trait for Type`: ids[0]=Trait, ids[1]=Type.
      // Without `for`: ids[0]=Type (inherent impl).
      const targetIdx = forKw ? 1 : 0;
      let targetName = null;
      if (ids[targetIdx]) {
        targetName = identifierFromType(ids[targetIdx]);
        if (targetName) {
          implStack.push({ target: targetName, startIndex: node.startIndex, endIndex: node.endIndex });
        }
      }
      // `impl Trait for Type` → implements; `impl Type` (no for) → no edge.
      if (!forKw) return null;
      if (ids.length < 2) return null;
      const traitName = identifierFromType(ids[0]);
      if (!traitName) return null;
      if (!targetName) return null;
      return [{ kind: "implements", to_name: traitName, confidence: 90, fromName: targetName }];
    }
    case "use_declaration": {
      // use a::b::c [as d];  /  use a::{b, c::{d, e}};  /  use *;
      return useEdges(node, importedNames);
    }
    case "call_expression": {
      const callee = node.childForFieldName?.("function") ?? null;
      if (!callee) return null;
      const name = calleeName(callee);
      if (!name) return null;
      if (callee.type === "identifier" && importedNames.has(name) && isLocallyShadowed(node, name, {
        scopeNodeTypes: RUST_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      return [{ kind: "calls", to_name: name, confidence: 60 }];
    }
    case "macro_invocation": {
      const target = firstChildOfType(node, ["identifier", "scoped_identifier"]);
      const name = target ? calleeName(target) : null;
      return name ? [{ kind: "calls", to_name: `${name}!`, confidence: 60 }] : null;
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
  /** @param {string | null | undefined} name */
  const emit = (name) => {
    if (!name || isUsePseudoName(name)) return;
    importedNames.add(name);
    out.push({ kind: "imports", to_name: name, confidence: 85, moduleLevel: true });
  };
  for (const child of node.children) {
    if (child.type === "use" || child.type === ";") continue;
    collectUseBinding(child, null, emit);
  }
  return out;
}

/**
 * @param {TsNode} node
 * @param {string | null} selfName
 * @param {(name: string) => void} emit
 */
function collectUseBinding(node, selfName, emit) {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      emit(node.text);
      return;
    case "self":
      if (selfName) emit(selfName);
      return;
    case "crate":
    case "super":
      return;
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const name = lastPathSegment(node);
      if (name) emit(name);
      return;
    }
    case "use_as_clause": {
      const alias = lastDirectName(node);
      const fallback = lastPathSegment(node);
      if (alias || fallback) emit(alias ?? fallback);
      return;
    }
    case "scoped_use_list": {
      const list = firstChildOfType(node, "use_list");
      if (!list) return;
      collectUseBinding(list, scopedUsePrefixName(node, list) ?? selfName, emit);
      return;
    }
    case "use_list":
      for (const child of node.children) {
        if (child.type === "{" || child.type === "}" || child.type === ",") continue;
        collectUseBinding(child, selfName, emit);
      }
      return;
    case "use_wildcard":
      return;
    default:
      return;
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isUsePseudoName(name) {
  return name === "self" || name === "super" || name === "crate" || name === "std";
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function lastDirectName(node) {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (child.type === "identifier" || child.type === "type_identifier") return child.text;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function lastPathSegment(node) {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "self" || node.type === "super" || node.type === "crate") return node.type;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    const name = lastPathSegment(child);
    if (name) return name;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @param {TsNode} list
 * @returns {string | null}
 */
function scopedUsePrefixName(node, list) {
  const listIndex = node.children.indexOf(list);
  for (let i = listIndex - 1; i >= 0; i--) {
    const name = lastPathSegment(node.children[i]);
    if (name) return name;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "function_item":
    case "function_signature_item":
    case "const_item":
    case "static_item":
    case "mod_item": {
      const id = firstChildOfType(node, "identifier");
      return id ? id.text : null;
    }
    case "struct_item":
    case "enum_item":
    case "trait_item": {
      const id = firstChildOfType(node, "type_identifier");
      return id ? id.text : null;
    }
    case "let_declaration":
    case "parameter":
    case "closure_parameters": {
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
function calleeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "field_expression") {
    return node.text.replace(/\s+/g, "");
  }
  if (node.type === "scoped_identifier") {
    return node.text.replace(/\s+/g, "");
  }
  return null;
}

/**
 * @param {TsNode} typeNode
 * @returns {string | null}
 */
function identifierFromType(typeNode) {
  if (typeNode.type === "type_identifier") return typeNode.text;
  const inner = firstDescendant(typeNode, "type_identifier");
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {"public" | "private"}
 */
function visibilityOf(node) {
  return firstChildOfType(node, "visibility_modifier") ? "public" : "private";
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
 * @param {string} type
 * @returns {string | null}
 */
function ancestorTypeName(node, type) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === type) {
      const id = firstChildOfType(cur, "type_identifier");
      return id ? id.text : null;
    }
    cur = cur.parent;
  }
  return null;
}
