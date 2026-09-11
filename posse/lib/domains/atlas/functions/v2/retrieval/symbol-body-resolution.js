// @ts-check

import { symbolIdOf } from "./cards.js";
import { normalizedQualifiedIdentifier } from "./identifier-resolution.js";

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */

const CALLABLE_KINDS = new Set(["function", "method"]);
const DECLARATION_KINDS = new Set([
  "interface",
  "type",
  "type_alias",
]);

function sourceLines(source) {
  return String(source || "").split(/\r?\n/u);
}

export function symbolSourceText(source, symbol) {
  const startLine = Math.max(1, Number(symbol?.range_start_line) || 1);
  const endLine = Math.max(startLine, Number(symbol?.range_end_line) || startLine);
  return sourceLines(source).slice(startLine - 1, endLine).join("\n").trim();
}

function hasLeadingPythonOverloadDecorator(text) {
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith("@")) return false;
    if (/^@(?:typing\.)?overload\b/u.test(trimmed)) return true;
  }
  return false;
}

function isPythonDeclaration(text) {
  if (hasLeadingPythonOverloadDecorator(text)) return true;
  if (/:\s*\.\.\.\s*$/u.test(text)) return true;
  const lines = text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("@") && !line.startsWith("#"));
  return lines.length > 0 && /^(?:\.\.\.|pass)$/u.test(lines.at(-1) || "");
}

function pythonTargetIsOverload(target, source) {
  const text = symbolSourceText(source, target);
  if (hasLeadingPythonOverloadDecorator(text)) return true;
  const startLine = Math.max(1, Number(target?.range_start_line) || 1);
  return /^\s*@(?:typing\.)?overload\s*$/u.test(sourceLines(source)[startLine - 2] || "");
}

/**
 * Classify only syntax-proven declaration shapes. Unknown syntax remains
 * implementation-shaped so symbol.get never redirects a real body merely
 * because it is short.
 *
 * @param {ViewSymbol | null | undefined} symbol
 * @param {string} source
 * @returns {"declaration" | "implementation"}
 */
export function symbolBodyKind(symbol, source) {
  const text = symbolSourceText(source, symbol);
  const kind = String(symbol?.kind || "").toLowerCase();
  const lang = String(symbol?.lang || "").toLowerCase();
  const file = String(symbol?.repo_rel_path || "").toLowerCase();
  if (!text) return "declaration";
  if (DECLARATION_KINDS.has(kind) || file.endsWith(".d.ts") || file.endsWith(".pyi")) {
    return "declaration";
  }
  if (/^\s*(?:export\s+)?(?:\{[^}]*\}|\*)\s+from\s+["'][^"']+["']\s*;?\s*$/su.test(text)) {
    return "declaration";
  }
  if (["ts", "tsx", "js", "jsx"].includes(lang)) {
    if (/^\s*(?:export\s+)?(?:declare\s+|abstract\s+)?(?:interface|type)\b/u.test(text)) {
      return "declaration";
    }
    if (CALLABLE_KINDS.has(kind)) {
      // A number of compiler indexes bound object/class methods at the opening
      // brace and omit the body from the symbol range. An opening brace or an
      // expression arrow is still syntax proof of an implementation; only a
      // callable with no body marker is declaration-shaped.
      if (!/\{/u.test(text) && !/=>/u.test(text)) return "declaration";
    }
  }
  if (lang === "python" || lang === "py") {
    // Class ranges can contain nested overloads or abstract methods. Those do
    // not make the class itself a declaration-only body.
    if (CALLABLE_KINDS.has(kind)
      && (isPythonDeclaration(text) || pythonTargetIsOverload(symbol, source))) {
      return "declaration";
    }
  }
  if (lang === "rust" || lang === "rs") {
    if (CALLABLE_KINDS.has(kind) && /;\s*$/u.test(text) && !/\{/u.test(text)) {
      return "declaration";
    }
  }
  return "implementation";
}

function compatibleImplementationCandidate(target, candidate, source) {
  if (!candidate || candidate === target) return false;
  if (candidate.repo_rel_path !== target.repo_rel_path || candidate.name !== target.name) return false;
  const targetKind = String(target.kind || "").toLowerCase();
  const candidateKind = String(candidate.kind || "").toLowerCase();
  if (targetKind !== candidateKind
    && !(CALLABLE_KINDS.has(targetKind) && CALLABLE_KINDS.has(candidateKind))) return false;
  return symbolBodyKind(candidate, source) === "implementation";
}

function sameLogicalBearer(target, candidate) {
  const targetName = normalizedQualifiedIdentifier(target?.qualified_name || target?.name);
  const candidateName = normalizedQualifiedIdentifier(candidate?.qualified_name || candidate?.name);
  return Boolean(targetName && candidateName && targetName === candidateName);
}

function typeScriptOverloadGapContainsOnlyTrivia(target, candidate, symbols, source) {
  const targetEnd = Math.max(1, Number(target?.range_end_line) || 1);
  const candidateStart = Math.max(1, Number(candidate?.range_start_line) || 1);
  if (candidateStart <= targetEnd) return false;
  if (candidateStart === targetEnd + 1) return true;
  const coveredLines = new Set();
  for (const sibling of Array.isArray(symbols) ? symbols : []) {
    const start = Math.max(1, Number(sibling?.range_start_line) || 1);
    const end = Math.max(start, Number(sibling?.range_end_line) || start);
    if (sibling?.name !== target?.name
      || start <= targetEnd
      || end >= candidateStart
      || symbolBodyKind(sibling, source) !== "declaration") continue;
    for (let line = start; line <= end; line += 1) coveredLines.add(line);
  }
  const intervening = sourceLines(source)
    .slice(targetEnd, candidateStart - 1)
    .filter((_line, index) => !coveredLines.has(targetEnd + index + 1))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .trim();
  return intervening.length === 0;
}

function pythonOverloadGapContainsOnlyDeclarations(target, candidate, symbols, source) {
  const targetEnd = Math.max(1, Number(target?.range_end_line) || 1);
  const candidateStart = Math.max(1, Number(candidate?.range_start_line) || 1);
  if (candidateStart <= targetEnd) return false;
  const coveredLines = new Set();
  for (const sibling of Array.isArray(symbols) ? symbols : []) {
    const start = Math.max(1, Number(sibling?.range_start_line) || 1);
    const end = Math.max(start, Number(sibling?.range_end_line) || start);
    if (sibling?.name !== target?.name
      || start <= targetEnd
      || end >= candidateStart
      || symbolBodyKind(sibling, source) !== "declaration") continue;
    for (let line = start; line <= end; line += 1) coveredLines.add(line);
  }
  const intervening = sourceLines(source)
    .slice(targetEnd, candidateStart - 1)
    .filter((_line, index) => !coveredLines.has(targetEnd + index + 1))
    .join("\n")
    .replace(/^\s*@(?:typing\.)?overload\s*$/gmu, "")
    .replace(/^\s*#[^\n]*$/gmu, "")
    .trim();
  return intervening.length === 0;
}

/**
 * Resolve a declaration address to a syntax-proven same-file implementation.
 * A non-unique or unproven match is returned as a candidate, never guessed.
 *
 * @param {ViewSymbol | null | undefined} target
 * @param {ViewSymbol[]} symbols
 * @param {string} source
 */
export function resolveSymbolBodyTarget(target, symbols, source) {
  if (!target) return { target, bodyKind: "declaration", implementationCandidates: [] };
  const bodyKind = symbolBodyKind(target, source);
  if (bodyKind === "implementation") {
    return { target, bodyKind, implementationCandidates: [] };
  }
  const candidates = (Array.isArray(symbols) ? symbols : [])
    .filter((candidate) => compatibleImplementationCandidate(target, candidate, source))
    .sort((left, right) => (
      (Number(left.range_start_line) || 0) - (Number(right.range_start_line) || 0)
      || (Number(left.range_end_line) || 0) - (Number(right.range_end_line) || 0)
      || (Number(left.global_id) || 0) - (Number(right.global_id) || 0)
    ));
  const lang = String(target.lang || "").toLowerCase();
  let implementation = null;
  let resolutionKind = "same_file_unique_implementation";
  if (["ts", "tsx"].includes(lang) && CALLABLE_KINDS.has(String(target.kind || "").toLowerCase())) {
    const proven = candidates.filter((candidate) => (
      (Number(candidate.range_start_line) || 0) > (Number(target.range_start_line) || 0)
      && typeScriptOverloadGapContainsOnlyTrivia(target, candidate, symbols, source)
    ));
    if (proven.length === 1) {
      implementation = proven[0];
      resolutionKind = "same_file_typescript_overload";
    }
  } else if (["python", "py"].includes(lang)
    && CALLABLE_KINDS.has(String(target.kind || "").toLowerCase())
    && pythonTargetIsOverload(target, source)) {
    const proven = candidates.filter((candidate) => (
      (Number(candidate.range_start_line) || 0) > (Number(target.range_start_line) || 0)
      && pythonOverloadGapContainsOnlyDeclarations(target, candidate, symbols, source)
    ));
    if (proven.length === 1) {
      implementation = proven[0];
      resolutionKind = "same_file_python_overload";
    }
  } else {
    const proven = candidates.filter((candidate) => sameLogicalBearer(target, candidate));
    if (proven.length === 1) implementation = proven[0];
  }
  const implementationCandidates = candidates.slice(0, 20).map((candidate) => ({
    symbolId: symbolIdOf(candidate),
    name: String(candidate.qualified_name || candidate.name || ""),
    file: String(candidate.repo_rel_path || ""),
    startLine: Math.max(1, Number(candidate.range_start_line) || 1),
    endLine: Math.max(1, Number(candidate.range_end_line) || Number(candidate.range_start_line) || 1),
  }));
  if (!implementation) return { target, bodyKind, implementationCandidates };
  return {
    target: implementation,
    bodyKind: "implementation",
    implementationCandidates,
    implementationResolution: {
      kind: resolutionKind,
      requestedSymbolId: symbolIdOf(target),
      implementationSymbolId: symbolIdOf(implementation),
      name: String(implementation.qualified_name || implementation.name || ""),
    },
  };
}
