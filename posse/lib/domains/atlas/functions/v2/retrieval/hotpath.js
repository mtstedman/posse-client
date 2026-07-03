// @ts-check
//
// AST-backed code.lens matcher. It scopes symbol requests to the target
// declaration and matches identifier usages first, so lexical noise inside
// comments/strings does not look like executable dependency evidence. An
// identifier the AST pass cannot find is rescued by a second pass over the
// skipped string/comment nodes and tagged matchKind "text" — string-dispatch
// code (`$action === 'create'`) must never produce a confident false
// "missing" verdict.

import {
  findNodesByType,
  lineForIndex,
  parseRetrievalAst,
  smallestNodeCoveringRange,
} from "./ast.js";
import { redactSecretsLines, redactSecretsLinesAsync } from "./redaction.js";

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-results.js").CodeHotPathData} CodeHotPathData */
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
  "lexical_declaration",
  "variable_declaration",
]);

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
  "field_identifier",
  // PHP tree-sitter uses `name` for declarations, calls, type names, and the
  // child identifier inside `$variable_name`; literals are named separately.
  "name",
  "variable_name",
  "qualified_name",
  "boolean",
  "null",
]);

const TEXT_MATCH_CAP_PER_IDENT = 5;

const SKIP_TYPES = new Set([
  "comment",
  "string",
  "string_fragment",
  "template_string",
  "template_substitution",
  "raw_string_literal",
  "interpreted_string_literal",
  "char_literal",
  "string_literal",
]);

/**
 * @param {{
 *   repoRoot?: string,
 *   file: string,
 *   source: string,
 *   target?: ViewSymbol | null,
 *   identifiers: string[],
 *   contextLines?: number,
 * }} args
 * @returns {{
 *   ok: true,
 *   matches: CodeHotPathData["matches"],
 *   identifiersFound: string[],
 *   identifiersFoundInText?: string[],
 *   identifiersMissing: string[],
 *   etagSeed: string,
 * } | {
 *   ok: false,
 *   reason: string,
 * }}
 */
export function buildAstHotPath(args) {
  return buildAstHotPathWithRedactor(args, redactSecretsLines);
}

/**
 * @param {{
 *   repoRoot?: string,
 *   file: string,
 *   source: string,
 *   target?: ViewSymbol | null,
 *   identifiers: string[],
 *   contextLines?: number,
 * }} args
 * @returns {Promise<{
 *   ok: true,
 *   matches: CodeHotPathData["matches"],
 *   identifiersFound: string[],
 *   identifiersFoundInText?: string[],
 *   identifiersMissing: string[],
 *   etagSeed: string,
 * } | {
 *   ok: false,
 *   reason: string,
 * }>}
 */
export async function buildAstHotPathAsync(args) {
  return await buildAstHotPathWithRedactor(args, redactSecretsLinesAsync);
}

function buildAstHotPathWithRedactor(args, redactLines) {
  const parsed = parseRetrievalAst({
    repoRoot: args.repoRoot,
    file: args.file,
    source: args.source,
  });
  if (!parsed.ok) {
    const failed = /** @type {{ ok: false, errorCode: string }} */ (parsed);
    return { ok: false, reason: failed.errorCode };
  }
  if (parsed.doc.hasError) return { ok: false, reason: "syntax_error" };
  const doc = parsed.doc;
  const scope = args.target ? scopeNodeForTarget(doc, args.target) : doc.root;
  const wanted = new Set(args.identifiers);
  const found = new Set();
  const seen = new Set();
  const lines = doc.source.split(/\r?\n/);
  const contextLines = typeof args.contextLines === "number" ? args.contextLines : 2;
  /** @type {CodeHotPathData["matches"]} */
  const matches = [];

  /** @type {Array<{ line: number, ident: string }>} */
  const rawMatches = [];
  walkAstSubtree(scope, (node) => {
    if (SKIP_TYPES.has(node.type)) return false;
    if (!IDENTIFIER_TYPES.has(node.type)) return;
    const ident = identifierTexts(node).find((candidate) => wanted.has(candidate));
    if (!ident) return;
    const line = lineForIndex(doc.lineStarts, node.startIndex);
    const key = `${ident}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.add(ident);
    rawMatches.push({ line, ident });
  });

  // Rescue pass: identifiers the AST pass could not find anywhere may still
  // live inside the skipped string/comment nodes (string-dispatch code,
  // config keys, template interpolation). A confident false "missing" is the
  // hazard being prevented, but the rescue must not recreate envelope bloat:
  // string hits emit at most TEXT_MATCH_CAP_PER_IDENT match lines each, and
  // comment-only hits are reported in identifiersFoundInText without match
  // entries (comment mentions are not dependency evidence, just presence).
  const textFound = new Set();
  /** @type {Array<{ line: number, ident: string }>} */
  const textRawMatches = [];
  const missingAfterAst = args.identifiers.filter((ident) => !found.has(ident));
  if (missingAfterAst.length > 0) {
    const perIdentLines = new Map(missingAfterAst.map((ident) => [ident, 0]));
    const patterns = missingAfterAst.map((ident) => ({
      ident,
      re: new RegExp(`\\b${escapeRegExpText(ident)}\\b`, "g"),
    }));
    walkAstSubtree(scope, (node) => {
      if (!SKIP_TYPES.has(node.type)) return;
      const isComment = node.type === "comment";
      const text = String(node.text || "");
      if (text) {
        for (const { ident, re } of patterns) {
          re.lastIndex = 0;
          for (let hit = re.exec(text); hit; hit = re.exec(text)) {
            textFound.add(ident);
            if (isComment) break;
            const line = lineForIndex(doc.lineStarts, node.startIndex + hit.index);
            const key = `${ident}:${line}`;
            if (seen.has(key)) continue;
            const emitted = perIdentLines.get(ident) || 0;
            if (emitted >= TEXT_MATCH_CAP_PER_IDENT) break;
            seen.add(key);
            perIdentLines.set(ident, emitted + 1);
            textRawMatches.push({ line, ident });
          }
        }
      }
      return false;
    });
  }

  // One native redaction call for the whole source instead of one per matched
  // line plus one per context line (each sync call is a process spawn).
  const redactedLines = rawMatches.length + textRawMatches.length > 0 ? redactLines(lines) : lines;
  return mapMaybePromise(redactedLines, (resolvedLines) => {
    for (const { line, ident } of rawMatches) {
      matches.push({
        repo_rel_path: args.file,
        line,
        text: resolvedLines[line - 1] || "",
        identifier: ident,
        context: {
          before: resolvedLines.slice(Math.max(0, line - 1 - contextLines), line - 1),
          after: resolvedLines.slice(line, Math.min(lines.length, line + contextLines)),
        },
      });
    }
    for (const { line, ident } of textRawMatches) {
      matches.push({
        repo_rel_path: args.file,
        line,
        text: resolvedLines[line - 1] || "",
        identifier: ident,
        matchKind: "text",
        context: {
          before: resolvedLines.slice(Math.max(0, line - 1 - contextLines), line - 1),
          after: resolvedLines.slice(line, Math.min(lines.length, line + contextLines)),
        },
      });
    }

    matches.sort((a, b) => a.line - b.line || a.identifier.localeCompare(b.identifier));
    const identifiersFound = [...found].sort();
    return {
      ok: true,
      matches,
      identifiersFound,
      ...(textFound.size > 0 ? { identifiersFoundInText: [...textFound].sort() } : {}),
      identifiersMissing: args.identifiers.filter((ident) => !found.has(ident) && !textFound.has(ident)).sort(),
      etagSeed: `ast:${doc.lang}:${scope.startIndex}-${scope.endIndex}:${matches.length}`,
    };
  });
}

function mapMaybePromise(value, map) {
  if (value && typeof /** @type {any} */ (value).then === "function") {
    return /** @type {any} */ (value).then(map);
  }
  return map(value);
}

/**
 * @param {RetrievalAstDocument} doc
 * @param {ViewSymbol} target
 * @returns {TsNode}
 */
function scopeNodeForTarget(doc, target) {
  const wantedNames = new Set([
    target.name,
    target.qualified_name || "",
    ...String(target.qualified_name || "").split(".").slice(-1),
  ].filter(Boolean));
  const declarations = findNodesByType(doc, DECLARATION_TYPES);
  const candidates = declarations
    .filter((node) => node.startIndex <= target.range_start && node.endIndex >= target.range_start)
    .filter((node) => declarationNames(node).some((name) => wantedNames.has(name)));
  if (candidates.length > 0) {
    return candidates.sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
  }
  return declarationAncestorOrSelf(
    smallestNodeCoveringRange(doc, target.range_start, Math.max(target.range_start + 1, target.range_end), { namedOnly: true }),
  );
}

/**
 * @param {TsNode} node
 * @returns {TsNode}
 */
function declarationAncestorOrSelf(node) {
  let current = node;
  while (current.parent) {
    if (DECLARATION_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return current;
}

/**
 * @param {TsNode} node
 * @returns {string[]}
 */
function declarationNames(node) {
  const names = [];
  const direct = node.childForFieldName?.("name");
  if (direct?.text) names.push(cleanNodeName(direct.text));
  walkAstSubtree(node, (child) => {
    if (child === node) return;
    if (child.type !== "variable_declarator") return false;
    const varName = child.childForFieldName?.("name");
    if (varName?.text) names.push(cleanNodeName(varName.text));
    return false;
  });
  return [...new Set(names.filter(Boolean))];
}

/**
 * @param {TsNode} node
 * @param {(node: TsNode) => false | void} visitor
 */
function walkAstSubtree(node, visitor) {
  const visit = (current) => {
    const result = visitor(current);
    if (result === false) return;
    for (const child of current.children || []) visit(child);
  };
  visit(node);
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanNodeName(value) {
  return String(value || "").replace(/^#/, "").trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExpText(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {TsNode} node
 * @returns {string[]}
 */
function identifierTexts(node) {
  const raw = String(node.text || "").trim();
  if (!raw) return [];
  const out = [raw];
  if (node.type === "variable_name" && raw.startsWith("$")) {
    out.push(raw.slice(1));
  }
  return [...new Set(out.filter(Boolean))];
}
