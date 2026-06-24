// @ts-check
//
// AST-backed code.skeleton renderer. It keeps declaration text and elides
// bodies so callers can inspect structure without escalating to raw windows.

import {
  findNodesByType,
  lineRangeForNode,
  parseRetrievalAst,
  sourceLines,
} from "./ast.js";

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../parser/treesitter/walker.js").TsNode} TsNode */
/** @typedef {import("./ast.js").RetrievalAstDocument} RetrievalAstDocument */

const DECLARATION_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
  "abstract_class_declaration",
  "interface_declaration",
  "enum_declaration",
  "type_alias_declaration",
  "lexical_declaration",
  "variable_declaration",
  "const_declaration",
  "field_declaration",
]);

const BODY_TYPES = new Set([
  "statement_block",
  "class_body",
  "declaration_list",
  "block",
  "function_body",
]);

const CLASS_LIKE_DECLARATION_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "abstract_class_declaration",
  "interface_declaration",
  "enum_declaration",
]);

/**
 * @param {{
 *   repoRoot?: string,
 *   file: string,
 *   source: string,
 *   symbols: ViewSymbol[],
 *   identifiersToFind?: string[],
 *   maxLines?: number,
 *   maxTokens?: number,
 * }} args
 * @returns {{
 *   ok: true,
 *   content: string,
 *   startLine: number,
 *   endLine: number,
 *   truncated: boolean,
 *   selectedSymbols: ViewSymbol[],
 *   etagSeed: string,
 * } | {
 *   ok: false,
 *   reason: string,
 *   selectedSymbols: ViewSymbol[],
 * }}
 */
export function buildAstSkeleton(args) {
  const selectedSymbols = selectSkeletonSymbols(args.symbols, args.identifiersToFind);
  const parsed = parseRetrievalAst({
    repoRoot: args.repoRoot,
    file: args.file,
    source: args.source,
  });
  if (!parsed.ok) {
    const failed = /** @type {{ ok: false, errorCode: string }} */ (parsed);
    return { ok: false, reason: failed.errorCode, selectedSymbols };
  }
  if (parsed.doc.hasError) return { ok: false, reason: "syntax_error", selectedSymbols };

  const names = new Set();
  for (const sym of selectedSymbols) {
    names.add(sym.name);
    if (sym.qualified_name) names.add(sym.qualified_name);
    const qparts = String(sym.qualified_name || "").split(".");
    if (qparts.length > 1) names.add(qparts[qparts.length - 1]);
  }
  const requireNameMatch = names.size > 0;
  const nodes = topLevelSelectedDeclarations(parsed.doc, names, requireNameMatch);
  if (nodes.length === 0) {
    return {
      ok: true,
      content: "",
      startLine: 1,
      endLine: 1,
      truncated: false,
      selectedSymbols,
      etagSeed: `ast:${parsed.doc.lang}:empty`,
    };
  }

  const rendered = [];
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = 1;
  for (const node of nodes) {
    const range = lineRangeForNode(parsed.doc, node);
    startLine = Math.min(startLine, range.startLine);
    endLine = Math.max(endLine, range.endLine);
    rendered.push(renderDeclaration(parsed.doc, node, names, requireNameMatch));
  }

  return limitSkeleton({
    content: rendered.filter(Boolean).join("\n\n"),
    startLine: Number.isFinite(startLine) ? startLine : 1,
    endLine,
    maxLines: args.maxLines,
    maxTokens: args.maxTokens,
    selectedSymbols,
    etagSeed: `ast:${parsed.doc.lang}:${nodes.map((node) => `${node.startIndex}-${node.endIndex}`).join(",")}`,
  });
}

/**
 * @param {ViewSymbol[]} symbols
 * @param {string[] | undefined} identifiersToFind
 * @returns {ViewSymbol[]}
 */
export function selectSkeletonSymbols(symbols, identifiersToFind) {
  const identifiers = normalizeIdentifiers(identifiersToFind);
  if (identifiers.length === 0) return symbols;
  return symbols.filter((sym) => identifiers.some((ident) => symbolMatchesIdentifier(sym, ident)));
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {Set<string>} names
 * @param {boolean} requireNameMatch
 * @returns {TsNode[]}
 */
function topLevelSelectedDeclarations(doc, names, requireNameMatch) {
  const declarations = findNodesByType(doc, DECLARATION_TYPES);
  /** @type {TsNode[]} */
  const selected = [];
  for (const node of declarations) {
    if (!declarationMatches(node, names, requireNameMatch)) continue;
    selected.push(outermostContainerDeclaration(node) || node);
  }
  const selectedSet = new Set(selected);
  return [...selectedSet]
    .filter((node) => !hasSelectedDeclarationAncestor(node, selectedSet))
    .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @param {Set<string>} names
 * @param {boolean} requireNameMatch
 * @returns {string}
 */
function renderDeclaration(doc, node, names, requireNameMatch) {
  const body = findBodyNode(node);
  if (!body) return oneLineDeclaration(doc, node);
  if (isContainerBody(node, body)) {
    return renderContainerDeclaration(doc, node, body, names, requireNameMatch);
  }
  return renderBodyElidedDeclaration(doc, node, body);
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @param {TsNode} body
 * @param {Set<string>} names
 * @param {boolean} requireNameMatch
 * @returns {string}
 */
function renderContainerDeclaration(doc, node, body, names, requireNameMatch) {
  const start = renderStartIndex(node);
  const lineIndent = indentAt(doc.source, start);
  const bodyOpener = openingToken(doc, body);
  const opener = doc.source.slice(start, body.startIndex + bodyOpener.length).trimEnd();
  const children = [];
  const filterMembers = requireNameMatch && !declarationMatches(node, names, true);
  for (const child of body.children || []) {
    if (!DECLARATION_TYPES.has(child.type)) continue;
    if (filterMembers && !declarationTreeMatches(child, names)) continue;
    const rendered = renderDeclaration(doc, child, names, filterMembers);
    if (rendered) children.push(rendered);
  }
  if (children.length === 0) children.push(`${lineIndent}  // ...`);
  const closing = closingToken(doc, body);
  return closing
    ? [opener, ...children, `${lineIndent}${closing}`].join("\n")
    : [opener, ...children].join("\n");
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @param {TsNode} body
 * @returns {string}
 */
function renderBodyElidedDeclaration(doc, node, body) {
  const start = renderStartIndex(node);
  const lineIndent = indentAt(doc.source, start);
  const bodyOpener = openingToken(doc, body);
  const opener = doc.source.slice(start, body.startIndex + bodyOpener.length).trimEnd();
  if (bodyOpener === "{") {
    return [
      opener,
      `${lineIndent}  // ...`,
      `${lineIndent}}`,
    ].join("\n");
  }
  return [
    `${opener}`,
    `${lineIndent}  ...`,
  ].join("\n");
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} node
 * @returns {string}
 */
function oneLineDeclaration(doc, node) {
  const start = renderStartIndex(node);
  const range = lineRangeForNode(doc, node);
  const text = sourceLines(doc, range.startLine, range.endLine).trimEnd();
  if (text.length <= 240) return text;
  return `${doc.source.slice(start, Math.min(node.endIndex, start + 237)).trimEnd()}...`;
}

/**
 * @param {TsNode} node
 * @param {Set<string>} names
 * @param {boolean} requireNameMatch
 * @returns {boolean}
 */
function declarationMatches(node, names, requireNameMatch) {
  if (!requireNameMatch) return true;
  return declarationNames(node).some((name) => names.has(name));
}

/**
 * @param {TsNode} node
 * @returns {TsNode | null}
 */
function outermostContainerDeclaration(node) {
  let parent = node.parent;
  let container = null;
  while (parent) {
    if (DECLARATION_TYPES.has(parent.type)) {
      const body = findBodyNode(parent);
      if (body && isContainerBody(parent, body)) {
        container = parent;
      }
    }
    parent = parent.parent;
  }
  return container;
}

/**
 * @param {TsNode} node
 * @param {TsNode} body
 * @returns {boolean}
 */
function isContainerBody(node, body) {
  return body.type === "class_body"
    || body.type === "declaration_list"
    || (body.type === "block" && CLASS_LIKE_DECLARATION_TYPES.has(node.type));
}

/**
 * @param {TsNode} node
 * @param {Set<string>} names
 * @returns {boolean}
 */
function declarationTreeMatches(node, names) {
  if (declarationMatches(node, names, true)) return true;
  let matched = false;
  walkAstNode(node, (child) => {
    if (child === node || !DECLARATION_TYPES.has(child.type)) return;
    if (declarationMatches(child, names, true)) {
      matched = true;
      return false;
    }
  });
  return matched;
}

/**
 * @param {TsNode} node
 * @returns {string[]}
 */
function declarationNames(node) {
  const names = [];
  const direct = node.childForFieldName?.("name");
  if (direct?.text) names.push(cleanNodeName(direct.text));
  walkAstNode(node, (child) => {
    if (child === node) return;
    if (child.type !== "variable_declarator" && child.type !== "short_var_declaration") return false;
    const varName = child.childForFieldName?.("name");
    if (varName?.text) names.push(cleanNodeName(varName.text));
    return false;
  });
  return [...new Set(names.filter(Boolean))];
}

/**
 * @param {TsNode} node
 * @param {Set<TsNode>} selected
 * @returns {boolean}
 */
function hasSelectedDeclarationAncestor(node, selected) {
  let parent = node.parent;
  while (parent) {
    if (selected.has(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

/**
 * @param {TsNode} node
 * @returns {TsNode | null}
 */
function findBodyNode(node) {
  const fieldBody = node.childForFieldName?.("body");
  if (fieldBody) return fieldBody;
  return (node.children || []).find((child) => BODY_TYPES.has(child.type)) || null;
}

/**
 * @param {TsNode} node
 * @returns {number}
 */
function renderStartIndex(node) {
  const parent = node.parent;
  if (parent && (parent.type === "export_statement" || parent.type === "decorated_definition")) {
    return parent.startIndex;
  }
  return node.startIndex;
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} body
 * @returns {string}
 */
function openingToken(doc, body) {
  const token = doc.source[body.startIndex] || "";
  if (token === "{" || token === ":") return token;
  return "";
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {TsNode} body
 * @returns {string}
 */
function closingToken(doc, body) {
  const token = doc.source[Math.max(body.startIndex, body.endIndex - 1)] || "";
  return token === "}" ? "}" : "";
}

/**
 * @param {string} source
 * @param {number} index
 * @returns {string}
 */
function indentAt(source, index) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, index));
  return match?.[0] || "";
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanNodeName(value) {
  return String(value || "").replace(/^#/, "").trim();
}

/**
 * @param {string[] | undefined} values
 * @returns {string[]}
 */
function normalizeIdentifiers(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))].slice(0, 50);
}

/**
 * @param {ViewSymbol} sym
 * @param {string} ident
 * @returns {boolean}
 */
function symbolMatchesIdentifier(sym, ident) {
  return sym.name === ident
    || sym.qualified_name === ident
    || String(sym.qualified_name || "").endsWith(`.${ident}`);
}

/**
 * @param {{
 *   content: string,
 *   startLine: number,
 *   endLine: number,
 *   maxLines?: number,
 *   maxTokens?: number,
 *   selectedSymbols: ViewSymbol[],
 *   etagSeed: string,
 * }} args
 * @returns {{
 *   ok: true,
 *   content: string,
 *   startLine: number,
 *   endLine: number,
 *   truncated: boolean,
 *   selectedSymbols: ViewSymbol[],
 *   etagSeed: string,
 * }}
 */
function limitSkeleton(args) {
  const maxLines = positiveInt(args.maxLines) || 200;
  const maxChars = (positiveInt(args.maxTokens) || 0) * 4;
  let lines = args.content.split(/\r?\n/);
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  let content = lines.join("\n");
  if (maxChars > 0 && content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }
  return {
    ok: true,
    content,
    startLine: args.startLine,
    endLine: truncated ? args.startLine + Math.max(1, countReturnedLines(content)) - 1 : args.endLine,
    truncated,
    selectedSymbols: args.selectedSymbols,
    etagSeed: args.etagSeed,
  };
}

function countReturnedLines(content) {
  if (content === "") return 0;
  return String(content || "").split(/\r?\n/).length;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * @param {TsNode} root
 * @param {(node: TsNode) => false | void} visitor
 * @returns {void}
 */
function walkAstNode(root, visitor) {
  const visit = (node) => {
    const result = visitor(node);
    if (result === false) return;
    for (const child of node.children || []) visit(child);
  };
  visit(root);
}
