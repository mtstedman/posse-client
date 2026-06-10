// @ts-check
//
// JavaScript / TypeScript spec for the tree-sitter walker. Mirrors
// atlas-mcp's `extractSymbols.js` shape (function/class/interface/
// type-alias/enum/const/method/property) plus `extractImports.js`
// (import statements) and `extractCalls.js` (call references).
//
// The TS grammar covers all four JS extensions (.ts/.tsx/.js/.jsx)
// because TypeScript is a superset; we just pass `ts` or `js` as the
// SymbolRow.lang depending on the file.

import { firstChildOfType, firstDescendant, childrenOfType } from "./walker.js";
import { isLocallyShadowed } from "./scope-shadow.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */
/** @typedef {import("../../contracts/schemas.js").EdgeKind} EdgeKind */

/**
 * @param {"ts" | "js"} lang
 * @returns {LanguageSpec}
 */
export function jsSpec(lang) {
  /** @type {Set<string>} */
  const importedNames = new Set();
  return {
    lang,
    symbolOf,
    edgesOf: (node, source) => edgesOf(node, source, importedNames),
    // Tree-sitter exposes children of string/regex/template literals;
    // we skip recursing into them to keep the walk linear.
    skipChildrenOfTypes: new Set([
      "string",
      "template_string",
      "regex",
      "comment",
    ]),
  };
}

const SYMBOL_TYPES = new Set([
  // Declarations.
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "internal_module",
  "module",
  // Class members.
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "public_field_definition",
  // Variable / lexical with initializer that's a function-like.
  "variable_declarator",
]);

const JS_SCOPE_NODE_TYPES = new Set([
  "program",
  "statement_block",
  "function_declaration",
  "generator_function_declaration",
  "function",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_body",
  "catch_clause",
]);

/**
 * @param {TsNode} node
 * @param {string} source
 * @returns {SymbolMatch | null}
 */
function symbolOf(node, source) {
  if (!SYMBOL_TYPES.has(node.type)) return null;

  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      return {
        kind: "function",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
      };
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, "class_body");
      return {
        kind: "class",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
        bodyNode: body ?? undefined,
      };
    }
    case "interface_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, ["interface_body", "object_type"]);
      return {
        kind: "interface",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
        bodyNode: body ?? undefined,
      };
    }
    case "type_alias_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      return {
        kind: "type",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
      };
    }
    case "enum_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, "enum_body");
      return {
        kind: "enum",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
        bodyNode: body ?? undefined,
      };
    }
    case "internal_module":
    case "module": {
      const name = nameOf(node);
      if (!name) return null;
      const body = firstChildOfType(node, ["statement_block", "block"]);
      return {
        kind: "namespace",
        name,
        signature: signatureFrom(node, source),
        bodyNode: body ?? undefined,
      };
    }
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature": {
      const name = nameOf(node);
      if (!name) return null;
      const visibility = methodVisibility(node);
      return {
        kind: "method",
        name,
        signature: signatureFrom(node, source),
        visibility,
      };
    }
    case "public_field_definition": {
      const name = nameOf(node);
      if (!name) return null;
      // Field with a function-like initializer is treated as a method;
      // anything else lands as a `var` so we don't lose the declaration.
      const init = firstDescendant(node, [
        "arrow_function",
        "function_expression",
        "function",
      ]);
      return {
        kind: init ? "method" : "var",
        name,
        signature: signatureFrom(node, source),
        visibility: methodVisibility(node),
      };
    }
    case "variable_declarator": {
      const name = nameOf(node);
      if (!name) return null;
      const value = node.childForFieldName?.("value") ?? null;
      if (!value) return null;
      // Only emit when the binding *is* a function. Plain `const x = 1`
      // is captured by the lexical_declaration walk below — falling
      // through to the variable_declarator only when the parent is a
      // top-level lexical_declaration would double-count; instead we
      // restrict to "looks like a function" here.
      const isFn =
        value.type === "arrow_function" ||
        value.type === "function_expression" ||
        value.type === "function" ||
        value.type === "generator_function";
      if (!isFn) {
        // Top-level lexical const/let/var: emit as a const/var/let when
        // the binding is at module scope. Determined by walking up to
        // the lexical_declaration.
        const declParent = node.parent;
        if (!declParent) return null;
        const declType = declParent.type;
        if (declType !== "lexical_declaration" && declType !== "variable_declaration") {
          return null;
        }
        // Only top-level (program-or-export_statement parent).
        const grand = declParent.parent;
        if (!grand) return null;
        if (
          grand.type !== "program" &&
          grand.type !== "export_statement"
        ) {
          return null;
        }
        const kw = firstChildOfType(declParent, ["const", "let", "var"]);
        const kind = /** @type {SymbolKind} */ (
          kw?.type === "const" ? "const" : "var"
        );
        return {
          kind,
          name,
          signature: signatureFrom(node, source),
          visibility: visibilityFromExportContext(declParent),
        };
      }
      return {
        kind: "function",
        name,
        signature: signatureFrom(node, source),
        visibility: visibilityFromExportContext(node),
      };
    }
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function nameOf(node) {
  const named = node.childForFieldName?.("name") ?? null;
  if (named) {
    if (named.type === "property_identifier" || named.type === "type_identifier" || named.type === "identifier") {
      return named.text;
    }
    // PrivateName (#foo): tree-sitter gives a private_property_identifier.
    if (named.type === "private_property_identifier") return named.text;
    // Sometimes the name field returns a complex node; take its first
    // identifier-shaped descendant.
    const inner = firstDescendant(named, [
      "identifier",
      "property_identifier",
      "type_identifier",
    ]);
    if (inner) return inner.text;
  }
  // variable_declarator stores the binding under "name" but in older
  // grammars it might be a direct child identifier.
  const direct = firstChildOfType(node, [
    "identifier",
    "property_identifier",
    "type_identifier",
  ]);
  return direct ? direct.text : null;
}

/**
 * Trim a declaration node's full text to its header (everything up to
 * the first `{` or `;`).
 *
 * @param {TsNode} node
 * @param {string} _source
 * @returns {string}
 */
function signatureFrom(node, _source) {
  const text = node.text;
  const brace = text.indexOf("{");
  const semi = text.indexOf(";");
  let end = text.length;
  if (brace >= 0) end = Math.min(end, brace);
  if (semi >= 0) end = Math.min(end, semi);
  return text.slice(0, end).trim();
}

/**
 * Visibility derived from whether the declaration sits under an
 * `export_statement`. Mirrors atlas-mcp's `isExported` walk.
 *
 * @param {TsNode} node
 * @returns {SymbolVisibility | null}
 */
function visibilityFromExportContext(node) {
  let cur = /** @type {TsNode | null} */ (node);
  while (cur) {
    if (cur.type === "export_statement") return "public";
    cur = cur.parent;
  }
  return null;
}

/**
 * Method-level visibility: look for `accessibility_modifier` among the
 * method's siblings (TS-only construct; absent for plain JS).
 *
 * @param {TsNode} node
 * @returns {SymbolVisibility | null}
 */
function methodVisibility(node) {
  const mod = firstChildOfType(node, "accessibility_modifier");
  if (!mod) return null;
  const t = mod.text;
  if (t === "public" || t === "private" || t === "protected") return t;
  return null;
}

/**
 * Emit edges from extends/implements clauses, import statements, and
 * call expressions. The walker handles attribution to the enclosing
 * symbol.
 *
 * @param {TsNode} node
 * @param {string} _source
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[] | null}
 */
function edgesOf(node, _source, importedNames) {
  switch (node.type) {
    case "class_heritage":
      return heritageEdges(node);
    case "extends_clause":
    case "extends_type_clause":
    case "implements_clause":
      return clauseEdges(node);
    case "import_statement":
      return importEdges(node, importedNames);
    case "call_expression":
    case "new_expression":
      return callEdges(node, importedNames);
    default:
      return null;
  }
}

/**
 * `class Foo extends Bar implements I1, I2` produces a `class_heritage`
 * node whose children are the extends/implements clauses.
 *
 * @param {TsNode} node
 * @returns {EdgeMatch[]}
 */
function heritageEdges(node) {
  /** @type {EdgeMatch[]} */
  const out = [];
  for (const child of node.children) {
    if (child.type === "extends_clause" || child.type === "implements_clause") {
      out.push(...clauseEdges(child));
    }
  }
  return out;
}

/**
 * @param {TsNode} node
 * @returns {EdgeMatch[]}
 */
function clauseEdges(node) {
  /** @type {EdgeMatch[]} */
  const edges = [];
  /** @type {EdgeKind} */
  const kind = /** @type {any} */ (
    node.type === "implements_clause" ? "implements" : "extends"
  );
  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "nested_type_identifier" ||
      child.type === "generic_type"
    ) {
      const baseName = extractTypeName(child);
      if (baseName) edges.push({ kind, to_name: baseName, confidence: 90 });
    }
  }
  return edges;
}

/**
 * `import { Foo, Bar } from "./x"` / `import Foo from "./x"` /
 * `import * as Foo from "./x"`.
 *
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[]}
 */
function importEdges(node, importedNames) {
  /** @type {EdgeMatch[]} */
  const edges = [];
  const clause = firstChildOfType(node, "import_clause");
  // The from-string is the last `string` child of `import_statement`.
  // Tree-sitter gives us `string` as a node whose first child is the
  // opening quote and a `string_fragment` carries the text.
  const sourceStr = firstChildOfType(node, "string");
  const sourceModule = sourceStr ? stripQuotes(sourceStr.text) : null;
  if (!clause) {
    // Bare `import "./side-effect"` — no name binding, but we still
    // emit an edge so the import is visible. to_name is the module
    // path itself.
    if (sourceModule) {
      edges.push({
        kind: "imports",
        to_name: sourceModule,
        to_module: sourceModule,
        confidence: 80,
        moduleLevel: true,
      });
    }
    return edges;
  }
  for (const child of clause.children) {
    if (child.type === "identifier") {
      // Default import: `import Foo from "..."`.
      importedNames.add(child.text);
      edges.push({
        kind: "imports",
        to_name: child.text,
        to_module: sourceModule,
        // 88 distinguishes default imports from named imports in the
        // resolver context builder without widening the EdgeRow schema.
        confidence: 88,
        moduleLevel: true,
      });
    } else if (child.type === "namespace_import") {
      const id = firstChildOfType(child, "identifier");
      if (id) {
        importedNames.add(id.text);
        edges.push({
          kind: "imports",
          to_name: id.text,
          to_module: sourceModule,
          confidence: 85,
          moduleLevel: true,
        });
      }
    } else if (child.type === "named_imports") {
      for (const spec of childrenOfType(child, "import_specifier")) {
        const localName = importSpecifierLocalName(spec);
        if (localName) importedNames.add(localName);
        const importedName = importSpecifierImportedName(spec);
        if (localName && importedName) edges.push({
          kind: "imports",
          to_name: localName,
          to_module: importModuleWithOriginalName(sourceModule, importedName, localName),
          confidence: 90,
          moduleLevel: true,
        });
      }
    }
  }
  return edges;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function stripQuotes(text) {
  if (!text || text.length < 2) return null;
  const f = text[0];
  const l = text[text.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'") || (f === "`" && l === "`")) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Local binding name for `import { Foo as Bar }` is `Bar`; for
 * `import { Foo }` it is `Foo`. The resolver still stores only one
 * edge name, but the shadow guard needs the name visible in this file.
 *
 * @param {TsNode} spec
 * @returns {string | null}
 */
function importSpecifierLocalName(spec) {
  const alias = spec.childForFieldName?.("alias") ?? null;
  if (alias && isIdentifierNode(alias)) return alias.text;
  const name = spec.childForFieldName?.("name") ?? null;
  if (name && isIdentifierNode(name)) return name.text;
  const ids = childrenOfType(spec, ["identifier", "property_identifier"]);
  return ids.length > 0 ? ids[ids.length - 1].text : null;
}

/**
 * Exported binding name for `import { Foo as Bar }` is `Foo`; for
 * `import { Foo }` it is also `Foo`.
 *
 * @param {TsNode} spec
 * @returns {string | null}
 */
function importSpecifierImportedName(spec) {
  const name = spec.childForFieldName?.("name") ?? null;
  if (name && isIdentifierNode(name)) return name.text;
  const ids = childrenOfType(spec, ["identifier", "property_identifier"]);
  return ids.length > 0 ? ids[0].text : null;
}

/**
 * Keep the EdgeRow schema stable by packing aliased import provenance into
 * to_module. Resolver import contexts unpack this back into originalName.
 *
 * @param {string | null} sourceModule
 * @param {string} importedName
 * @param {string} localName
 * @returns {string | null}
 */
function importModuleWithOriginalName(sourceModule, importedName, localName) {
  if (!sourceModule) return sourceModule;
  if (importedName === localName) return sourceModule;
  return `${sourceModule}#${importedName}`;
}

/**
 * `foo()` / `Bar.baz()` / `new Quux()`. Confidence is heuristic: we
 * don't resolve the binding here — the resolver pass at view-build
 * time does that.
 *
 * @param {TsNode} node
 * @param {Set<string>} importedNames
 * @returns {EdgeMatch[]}
 */
function callEdges(node, importedNames) {
  const fn = node.childForFieldName?.("function") ?? node.childForFieldName?.("constructor") ?? null;
  if (!fn) return [];
  const name = calleeNameOf(fn);
  if (!name) return [];
  if (isIdentifierNode(fn) && importedNames.has(name) && isLocallyShadowed(node, name, {
    scopeNodeTypes: JS_SCOPE_NODE_TYPES,
    bindingNameOf,
  })) {
    return [];
  }
  return [{ kind: "calls", to_name: name, confidence: 60 }];
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function calleeNameOf(node) {
  if (isIdentifierNode(node)) return node.text;
  if (node.type === "member_expression") {
    const object = node.childForFieldName?.("object") ?? null;
    const prop = node.childForFieldName?.("property") ?? null;
    if (!prop || !isIdentifierNode(prop)) return null;
    const objectName = object ? memberObjectName(object) : null;
    return objectName ? `${objectName}.${prop.text}` : prop.text;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function memberObjectName(node) {
  if (isIdentifierNode(node) || node.type === "this" || node.type === "super") {
    return node.text;
  }
  if (node.type === "member_expression") {
    const object = node.childForFieldName?.("object") ?? null;
    const prop = node.childForFieldName?.("property") ?? null;
    if (!prop || !isIdentifierNode(prop)) return null;
    const prefix = object ? memberObjectName(object) : null;
    return prefix ? `${prefix}.${prop.text}` : prop.text;
  }
  return null;
}

/**
 * @param {TsNode} node
 * @returns {boolean}
 */
function isIdentifierNode(node) {
  return (
    node.type === "identifier" ||
    node.type === "property_identifier" ||
    node.type === "private_property_identifier"
  );
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function extractTypeName(node) {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") {
    const named = firstChildOfType(node, ["identifier", "type_identifier"]);
    if (named) return named.text;
  }
  if (node.type === "nested_type_identifier") {
    // Foo.Bar — pull the last segment.
    const ids = childrenOfType(node, ["identifier", "type_identifier"]);
    if (ids.length > 0) return ids[ids.length - 1].text;
  }
  // Fall back to first identifier descendant.
  const inner = firstDescendant(node, ["identifier", "type_identifier"]);
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingNameOf(node) {
  switch (node.type) {
    case "variable_declarator": {
      const binding = node.childForFieldName?.("name") ?? null;
      return binding ? bindingIdentifierName(binding) : null;
    }
    case "required_parameter":
    case "optional_parameter":
    case "formal_parameter":
    case "rest_pattern":
    case "catch_clause": {
      const binding = firstDescendant(node, "identifier");
      return binding ? binding.text : null;
    }
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration":
      return nameOf(node);
    default:
      return null;
  }
}

/**
 * @param {TsNode} node
 * @returns {string | null}
 */
function bindingIdentifierName(node) {
  if (isIdentifierNode(node)) return node.text;
  const inner = firstDescendant(node, [
    "identifier",
    "property_identifier",
    "private_property_identifier",
  ]);
  return inner ? inner.text : null;
}

/**
 * @param {TsNode} node
 * @returns {boolean}
 */
