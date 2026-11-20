// @ts-check
//
// Search results that point into the symbol index.
//
// A text search is how agents look things up, whatever else they are given.
// Two small additions let the result lead on to the index instead of to
// another read:
//
//  - a match inside a declaration names it ("in requiredSlug:"), so the next
//    call can address that declaration by name;
//  - a repository-wide search for exactly one name the index defines says
//    where it is defined and how many indexed callers it has, so finding its
//    uses is one symbol.callers call instead of opening each hit.
//
// Nothing here changes a match line. Every lookup is best effort: a file whose
// indexed copy differs from what is on disk gets no names, and any failure
// leaves the result as it was.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Kinds that wrap a file or package rather than a declaration worth naming. */
const CONTAINER_KINDS = new Set(["module", "namespace", "package", "file", "program"]);
/** Kinds a "defined at" line may name. */
const DEFINITION_KINDS = new Set([
  "function", "method", "class", "interface", "trait", "enum", "struct", "type", "constructor",
]);
const MAX_NAMED_FILES = 20;
const MAX_NAME_CHARS = 80;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * @typedef {{ global_id?: number, content_hash?: string, local_id?: number, kind?: string, name?: string,
 *   qualified_name?: string | null, repo_rel_path?: string, range_start_line?: number, range_end_line?: number }} IndexSymbol
 * @typedef {{
 *   symbolsInFile: (repoRelPath: string) => Promise<IndexSymbol[]>,
 *   contentHashForPath: (repoRelPath: string) => Promise<string | null>,
 *   findSymbol: (name: string) => Promise<IndexSymbol[]>,
 *   callerCount: (symbol: IndexSymbol) => Promise<number>,
 * }} SymbolSource
 */

function isNamedDeclaration(/** @type {IndexSymbol} */ symbol) {
  const name = String(symbol?.name || "");
  if (!name || name.startsWith("<")) return false;
  if (CONTAINER_KINDS.has(String(symbol?.kind || "").toLowerCase())) return false;
  const start = Number(symbol?.range_start_line);
  const end = Number(symbol?.range_end_line);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start;
}

function displayName(/** @type {IndexSymbol} */ symbol) {
  const qualified = String(symbol?.qualified_name || "");
  return qualified && qualified.length <= MAX_NAME_CHARS ? qualified : String(symbol?.name || "");
}

/** The innermost named declaration holding each line. */
function enclosingNames(/** @type {IndexSymbol[]} */ symbols) {
  const spans = symbols.filter(isNamedDeclaration)
    .map((symbol) => ({ start: Number(symbol.range_start_line), end: Number(symbol.range_end_line), name: displayName(symbol) }))
    .sort((left, right) => (left.end - left.start) - (right.end - right.start) || left.start - right.start);
  return (/** @type {number} */ line) => spans.find((span) => line >= span.start && line <= span.end)?.name || null;
}

/**
 * Insert "in <declaration>:" before each run of rendered lines that sits in a
 * different declaration, and "top level:" when a run leaves one. A file whose
 * matches are all outside declarations is left untouched.
 *
 * @param {string} text Grouped search output (`File: path` headers, `> 41\t...` rows).
 * @param {Map<string, (line: number) => string | null>} namesByFile Display path to line lookup.
 */
export function nameEnclosingDeclarations(text, namesByFile) {
  const rows = String(text).split("\n");
  /** @type {string[]} */
  const out = [];
  let lookup = null;
  let current = undefined;
  let fileHasNames = false;
  /** @type {Array<{ index: number, name: string | null }>} */
  let pending = [];
  const flushFile = () => {
    if (!fileHasNames) { pending = []; return; }
    // Insert headers from the end so earlier indexes stay valid.
    for (const entry of pending.reverse()) out.splice(entry.index, 0, entry.name ? `  in ${entry.name}:` : "  top level:");
    pending = [];
  };
  for (const row of rows) {
    const header = /^File:\s+(\S[\s\S]*?)\s*$/u.exec(row);
    if (header) {
      flushFile();
      lookup = namesByFile.get(header[1]) || null;
      current = undefined;
      fileHasNames = false;
      out.push(row);
      continue;
    }
    const line = /^[>\s]\s(\d+)\t/u.exec(row);
    if (lookup && line) {
      const name = lookup(Number(line[1]));
      if (name) fileHasNames = true;
      if (name !== current && (name || current)) pending.push({ index: out.length, name });
      current = name;
    }
    out.push(row);
  }
  flushFile();
  return out.join("\n");
}

/** The single identifier a search looks for, or null when it is anything else. */
export function exactSearchedName(pattern) {
  const core = String(pattern || "").trim()
    .replace(/^\^/u, "").replace(/\$$/u, "")
    .replace(/^\\b/u, "").replace(/\\b$/u, "")
    .replace(/^\(\?:?/u, "(").replace(/^\((.*)\)$/u, "$1");
  return IDENTIFIER_RE.test(core) ? core : null;
}

/**
 * One line for a repository-wide search of exactly one defined name.
 *
 * @param {IndexSymbol[]} definitions Exact-name declarations from the index.
 * @param {number | null} callers Indexed caller count of a single definition, or null to leave callers out.
 * @param {((symbolId: string) => string | null) | null} [symbolFor] The session's short handle for a symbol ID.
 */
export function definitionLine(name, definitions, callers, symbolFor = null) {
  if (definitions.length === 0) return "";
  const where = (/** @type {IndexSymbol} */ symbol) => `${symbol.repo_rel_path}:${symbol.range_start_line} (${symbol.kind})`;
  if (definitions.length > 1) {
    return `${name} is defined in ${definitions.length} places: ${definitions.slice(0, 3).map(where).join(", ")}.`;
  }
  const [symbol] = definitions;
  if (callers == null) return `${name} is defined at ${where(symbol)}.`;
  if (callers === 0) return `${name} is defined at ${where(symbol)}; it has no indexed callers.`;
  const symbolId = `${symbol.content_hash}:${symbol.local_id}`;
  const selector = (typeof symbolFor === "function" && symbolFor(symbolId)) || symbolId;
  return `${name} is defined at ${where(symbol)}; symbol.callers with symbols ["${selector}"] lists its ${callers} caller${callers === 1 ? "" : "s"}.`;
}

function sha256Hex(/** @type {Buffer} */ bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Add the symbol hints to one search result text.
 *
 * @param {string} text
 * @param {{
 *   args: { pattern?: string, path?: string },
 *   cwd: string,
 *   readRoot: string,
 *   source: SymbolSource,
 *   callersIssued: boolean,
 *   symbolFor?: ((symbolId: string) => string | null) | null,
 * }} options
 * @returns {Promise<string>}
 */
export async function withSearchSymbolHints(text, { args, cwd, readRoot, source, callersIssued, symbolFor = null }) {
  const toRepoPath = (/** @type {string} */ displayPath) => {
    const relative = path.relative(readRoot, path.resolve(cwd, displayPath)).split(path.sep).join("/");
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
  };
  let annotated = String(text);
  const files = [...new Set([...annotated.matchAll(/^File:\s+(\S[^\n]*?)\s*$/gmu)].map((match) => match[1]))]
    .slice(0, MAX_NAMED_FILES);
  /** @type {Map<string, (line: number) => string | null>} */
  const namesByFile = new Map();
  for (const displayPath of files) {
    const repoPath = toRepoPath(displayPath);
    if (!repoPath) continue;
    try {
      const indexed = await source.contentHashForPath(repoPath);
      if (!indexed) continue;
      const onDisk = sha256Hex(fs.readFileSync(path.resolve(cwd, displayPath)));
      // Line numbers from an older copy of the file would name the wrong code.
      if (indexed !== onDisk) continue;
      namesByFile.set(displayPath, enclosingNames(await source.symbolsInFile(repoPath)));
    } catch { /* this file simply gets no names */ }
  }
  if (namesByFile.size > 0) annotated = nameEnclosingDeclarations(annotated, namesByFile);

  const searchedPath = String(args?.path || "");
  const name = exactSearchedName(args?.pattern);
  const treeWide = !searchedPath || !path.extname(searchedPath);
  if (!name || !treeWide) return annotated;
  try {
    const definitions = (await source.findSymbol(name))
      .filter((symbol) => symbol?.name === name && DEFINITION_KINDS.has(String(symbol?.kind || "").toLowerCase()));
    if (definitions.length === 0) return annotated;
    const callers = definitions.length === 1 && callersIssued ? await source.callerCount(definitions[0]) : null;
    const line = definitionLine(name, definitions, callers, symbolFor);
    return line ? `${line}\n${annotated}` : annotated;
  } catch {
    return annotated;
  }
}
