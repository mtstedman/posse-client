// @ts-check
//
// Python spec for the tree-sitter walker.
//
// Mirrors atlas-mcp's Python adapter (class/function/method/assignment/
// decorated-symbol/import-from/import). Module-level `FOO = ...` with
// an uppercase name → `const`; lowercase top-level assignment → `var`.

import { firstChildOfType, childrenOfType, firstDescendant } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */

/** @returns {LanguageSpec} */
export function pythonSpec() {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang: "py",
    symbolOf,
    edgesOf: (node) => edgesOf(node, importedNames),
    skipChildrenOfTypes: new Set(["string", "comment"]),
  };
}

const PY_SCOPE_NODE_TYPES = new Set([
  "module",
  "block",
  "function_definition",
  "async_function_definition",
  "lambda",
  "class_definition",
]);

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  switch (node.type) {
    case "class_definition": {
      const name = nameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, "block");
      return {
        kind: "class",
        name,
        signature: classSignature(node),
        bodyNode: body ?? undefined,
      };
    }
    case "function_definition":
    case "async_function_definition": {
      const name = nameOf(node);
      if (!name) return null;
      const isMethod = nearestFunctionOrClassAncestor(node) === "class_definition";
      return {
        kind: isMethod ? "method" : "function",
        name,
        signature: signatureFrom(node),
      };
    }
    case "decorated_definition": {
      // Decorated def/class — recurse into the inner def to extract,
      // but suppress double-emission by returning null here (walker
      // visits children automatically).
      return null;
    }
    case "assignment": {
      // Top-level (module-scope) ALL_CAPS_NAME = ... → const.
      // Anything inside a class body would normally be a class
      // attribute; we lean toward function/method extraction and
      // ignore attribute-style assignments for v1.
      const left = node.firstChild;
      if (!left) return null;
      if (left.type !== "identifier") return null;
      const name = left.text;
      // Only module-level — assignment.parent must be expression_statement,
      // whose parent must be `module` (top-level).
      const stmt = node.parent;
      if (!stmt || stmt.type !== "expression_statement") return null;
      const mod = stmt.parent;
      if (!mod || mod.type !== "module") return null;
      // Uppercase ALL_CAPS → const; otherwise skip (we don't track
      // arbitrary top-level vars in v1).
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return null;
      return {
        kind: "const",
        name,
        signature: node.text.split("=")[0].trim(),
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
    case "class_definition":
      return baseClassEdges(node);
    case "import_statement":
      return importStatementEdges(node, importedNames);
    case "import_from_statement":
      return importFromEdges(node, importedNames);
    case "call": {
      const fn = node.firstChild;
      if (!fn) return null;
      const callee = calleeName(fn);
      if (!callee) return null;
      if (fn.type === "identifier" && importedNames.has(callee) && isLocallyShadowed(node, callee, {
        scopeNodeTypes: PY_SCOPE_NODE_TYPES,
        bindingNameOf,
      })) {
        return [];
      }
      return [{ kind: "calls", to_name: callee, confidence: 60 }];
    }
    default:
      return null;
  }
}

/**
 * `class Foo(Base1, Base2):` — bases live in the `argument_list`.
 *
 * @param {TsNode} node
 * @returns {EdgeMatch[] | null}
 */
function baseClassEdges(node) {
  const args = firstChildOfType(node, "argument_list");
  if (!args) return null;
  /** @type {EdgeMatch[]} */
  const out = [];
  for (const child of args.children) {
    if (child.type === "identifier" || child.type === "attribute") {
      out.push({
        kind: "extends",
        to_name: lastIdentifierIn(child),
        confidence: 90,
      });
    }
    // `metaclass=X` keyword args are `keyword_argument`; ignore them.
  }
  return out.length > 0 ? out : null;
}

/**
 * `import a.b.c [as alias]`. Emit one edge per import, using the LAST
 * segment of the dotted name as `to_name` (matches atlas-mcp).
 *
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[]}
 */
function importStatementEdges(node, importedNames) {
  /** @type {EdgeMatch[]} */
  const out = [];
  for (const child of node.children) {
    if (child.type === "dotted_name" || child.type === "aliased_import") {
      const localName = importStatementLocalName(child);
      if (localName) importedNames.add(localName);
      const target = child.type === "aliased_import"
        ? firstChildOfType(child, "dotted_name")
        : child;
      if (!target) continue;
      const fullModule = target.text;
      const ids = childrenOfType(target, "identifier");
      const last = ids.length > 0 ? ids[ids.length - 1].text : null;
      if (last) {
        out.push({
          kind: "imports",
          to_name: last,
          // For `import a.b.c`, the module is the full dotted path.
          // For Python, this lets the resolver find the right symbol.
          to_module: fullModule,
          confidence: 85,
          moduleLevel: true,
        });
      }
    }
  }
  return out;
}

/**
 * `from pkg import Foo, Bar as B, *`.
 *
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[]}
 */
function importFromEdges(node, importedNames) {
  /** @type {EdgeMatch[]} */
  const out = [];
  // Source module is the FIRST dotted_name; subsequent ones (after the
  // `import` keyword) are the imported names.
  /** @type {string | null} */
  let sourceModule = null;
  let pastImportKeyword = false;
  for (const child of node.children) {
    if (child.type === "import") {
      pastImportKeyword = true;
      continue;
    }
    if (!pastImportKeyword) {
      if (child.type === "dotted_name" && sourceModule == null) {
        sourceModule = child.text;
      }
      continue;
    }
    if (child.type === "dotted_name") {
      const ids = childrenOfType(child, "identifier");
      const last = ids.length > 0 ? ids[ids.length - 1].text : null;
      if (last && last !== "*") {
        importedNames.add(last);
        out.push({
          kind: "imports",
          to_name: last,
          to_module: sourceModule,
          confidence: 90,
          moduleLevel: true,
        });
      }
    } else if (child.type === "aliased_import") {
      const inner = firstChildOfType(child, "dotted_name");
      if (inner) {
        const localName = importStatementLocalName(child);
        if (localName) importedNames.add(localName);
        const ids = childrenOfType(inner, "identifier");
        const last = ids.length > 0 ? ids[ids.length - 1].text : null;
        if (last) out.push({
          kind: "imports",
          to_name: last,
          to_module: sourceModule,
          confidence: 90,
          moduleLevel: true,
        });
      }
    } else if (child.type === "wildcard_import") {
      // `from x import *` — we can't enumerate names statically.
    }
  }
  return out;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function importStatementLocalName(node) {
  if (node.type === "aliased_import") {
    const alias = firstChildOfType(node, "identifier");
    if (alias) return alias.text;
  }
  const dotted = node.type === "dotted_name" ? node : firstChildOfType(node, "dotted_name");
  if (!dotted) return null;
  const ids = childrenOfType(dotted, "identifier");
  return ids.length > 0 ? ids[0].text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function nameOf(node) {
  // Both class_definition and function_definition store the name as a
  // direct `identifier` child after the keyword.
  const id = firstChildOfType(node, "identifier");
  return id ? id.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string}
 */
function signatureFrom(node) {
  // Take everything up to the `:` that introduces the suite block.
  const colon = node.children.find((c) => c.type === ":");
  if (colon) return node.text.slice(0, colon.startIndex - node.startIndex).trim();
  return node.text.split("\n")[0]?.slice(0, 200) ?? "";
}

/**
 * @param {TsNode} node
 * @returns {string}
 */
function classSignature(node) {
  // class Foo(Base):  → "class Foo(Base)"
  return signatureFrom(node);
}

/**
 * @param {TsNode} node
 * @returns {"function_definition" | "async_function_definition" | "class_definition" | null}
 */
function nearestFunctionOrClassAncestor(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === "function_definition" ||
      cur.type === "async_function_definition" ||
      cur.type === "class_definition"
    ) {
      return /** @type {any} */ (cur.type);
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "class_definition":
    case "function_definition":
    case "async_function_definition":
      return nameOf(node);
    case "assignment": {
      const left = node.firstChild;
      return left?.type === "identifier" ? left.text : null;
    }
    case "for_statement":
    case "with_item":
    case "except_clause": {
      const id = firstDescendant(node, "identifier");
      return id ? id.text : null;
    }
    case "identifier": {
      const parentType = node.parent?.type;
      if (
        parentType === "parameters" ||
        parentType === "typed_parameter" ||
        parentType === "default_parameter" ||
        parentType === "list_splat_pattern" ||
        parentType === "dictionary_splat_pattern"
      ) {
        return node.text;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Pull the last identifier from a dotted attribute or single
 * identifier. `foo.bar.Baz` → "Baz".
 *
 * @param {TsNode} node
 * @returns {string}
 */
function lastIdentifierIn(node) {
  if (node.type === "identifier") return node.text;
  const inner = firstDescendant(node, "identifier");
  if (!inner) return node.text;
  // DFS pushing children in reverse so popping yields source order.
  // Collected list is in source order; rightmost identifier is last.
  const ids = [];
  /** @type {TsNode[]} */
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === "identifier") ids.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return ids.length > 0 ? ids[ids.length - 1].text : inner.text;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    return attributeName(node);
  }
  return null;
}

/**
 * Preserve dotted receiver chains so the Python resolver adapter can
 * distinguish `self.format()` from a bare `format()` call.
 *
 * @param {TsNode} node
 * @returns {string | null}
 */
function attributeName(node) {
  if (node.type === "identifier") return node.text;
  if (node.type === "call" && node.text === "super()") return "super";
  if (node.type !== "attribute") return null;
  const object = node.childForFieldName?.("object") ?? null;
  const attr = node.childForFieldName?.("attribute") ?? null;
  if (!attr || attr.type !== "identifier") return null;
  const prefix = object ? attributeName(object) : null;
  return prefix ? `${prefix}.${attr.text}` : attr.text;
}
