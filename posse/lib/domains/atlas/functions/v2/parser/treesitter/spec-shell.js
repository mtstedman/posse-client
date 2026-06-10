// @ts-check
//
// Shell (bash) spec for the tree-sitter walker. Captures function
// declarations and `source` / `.` includes.

import { firstChildOfType, firstDescendant } from "./walker.js";

/** @typedef {import("./walker.js").LanguageSpec} LanguageSpec */
/** @typedef {import("./walker.js").TsNode} TsNode */
/** @typedef {import("./walker.js").SymbolMatch} SymbolMatch */
/** @typedef {import("./walker.js").EdgeMatch} EdgeMatch */

/** @returns {LanguageSpec} */
export function shellSpec() {
  return {
    lang: "sh",
    symbolOf,
    edgesOf,
    skipChildrenOfTypes: new Set(["string", "heredoc_body", "comment"]),
  };
}

/**
 * @param {TsNode} node
 * @returns {SymbolMatch | null}
 */
function symbolOf(node) {
  if (node.type !== "function_definition") return null;
  // `function foo` → first non-keyword child is the name (word).
  // `foo() { ... }` → first child is the name (word).
  const name = firstChildOfType(node, "word");
  if (!name) return null;
  return {
    kind: "function",
    name: name.text,
    signature: signatureUpTo(node, ["compound_statement", "subshell"]),
  };
}

/**
 * @param {TsNode} node
 * @returns {EdgeMatch[] | null}
 */
function edgesOf(node) {
  if (node.type !== "command") return null;
  const cmd = firstChildOfType(node, "command_name");
  if (!cmd) return null;
  const cmdWord = cmd.firstChild;
  if (!cmdWord || cmdWord.type !== "word") return null;
  const verb = cmdWord.text;
  const edges = /** @type {EdgeMatch[]} */ ([
    { kind: "calls", to_name: verb, confidence: 60 },
  ]);
  if (verb !== "source" && verb !== ".") return edges;
  // First word after command_name is the path being sourced.
  // bash grammar exposes argument words as direct children of `command`.
  let foundCmd = false;
  for (const c of node.children) {
    if (c === cmd) {
      foundCmd = true;
      continue;
    }
    if (!foundCmd) continue;
    if (c.type === "word") {
      edges.push({ kind: "imports", to_name: c.text, confidence: 80, moduleLevel: true });
      return edges;
    }
    if (c.type === "string") {
      const inner = firstDescendant(c, "string_content");
      if (inner) {
        edges.push({ kind: "imports", to_name: inner.text, confidence: 80, moduleLevel: true });
        return edges;
      }
    }
  }
  return edges;
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
