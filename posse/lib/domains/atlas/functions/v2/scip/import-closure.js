// @ts-check
//
// Size of what a JavaScript/TypeScript document imports.
//
// The TypeScript indexer loads every file a document transitively imports
// before it indexes the document, and its memory follows that closure rather
// than the document: a few hundred bytes that re-export a directory of large
// modules cost gigabytes. The stager measures the closure before it starts an
// indexer, so such a document is staged on its own up front instead of being
// discovered by exhausting the indexer and bisecting the batch.
//
// Only relative specifiers are followed. Package imports and path aliases are
// not resolved, so the result is a lower bound; a closure it misses still
// reaches the stager's memory-exhaustion recovery.

import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// `./x.js` in TypeScript source names the file compiled from `./x.ts`.
const COMPILED_EXTENSION_SOURCES = new Map([[".js", [".ts", ".tsx"]], [".mjs", [".mts"]], [".cjs", [".cts"]]]);
const RELATIVE_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\1/gu;

/**
 * Relative module specifiers named by static imports, re-exports, dynamic
 * imports and `require` calls with a literal argument.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function relativeImportSpecifiers(text) {
  const specifiers = new Set();
  for (const match of String(text || "").matchAll(RELATIVE_SPECIFIER_RE)) specifiers.add(match[2]);
  return [...specifiers];
}

/**
 * @typedef {Map<string, { size: number, imports: string[] }>} ImportGraphCache
 */

/**
 * Bytes of the files `repoRelPath` transitively imports, not counting the
 * document itself. The walk stops as soon as the total passes `limit`, so the
 * result is exact below the limit and merely "more than the limit" above it.
 *
 * @param {{ repoRoot: string, repoRelPath: string, limit?: number, cache?: ImportGraphCache }} input
 * @returns {Promise<number>}
 */
export async function importClosureBytes({ repoRoot, repoRelPath, limit = Infinity, cache = new Map() }) {
  const root = path.resolve(repoRoot);
  const start = path.join(root, repoRelPath);
  const seen = new Set([start]);
  const pending = [...(await importGraphNode(start, root, cache)).imports];
  let total = 0;
  while (pending.length > 0 && total <= limit) {
    const file = /** @type {string} */ (pending.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    const node = await importGraphNode(file, root, cache);
    total += node.size;
    for (const imported of node.imports) {
      if (!seen.has(imported)) pending.push(imported);
    }
  }
  return total;
}

/**
 * @param {string} file
 * @param {string} root
 * @param {ImportGraphCache} cache
 */
async function importGraphNode(file, root, cache) {
  const cached = cache.get(file);
  if (cached) return cached;
  /** @type {{ size: number, imports: string[] }} */
  const node = { size: 0, imports: [] };
  cache.set(file, node);
  let text;
  try {
    const bytes = await fs.promises.readFile(file);
    node.size = bytes.length;
    text = bytes.toString("utf8");
  } catch {
    return node;
  }
  for (const specifier of relativeImportSpecifiers(text)) {
    const resolved = resolveRelativeImport(path.resolve(path.dirname(file), specifier), root);
    if (resolved && resolved !== file) node.imports.push(resolved);
  }
  return node;
}

/**
 * @param {string} base
 * @param {string} root
 * @returns {string | null}
 */
function resolveRelativeImport(base, root) {
  if (base !== root && !base.startsWith(root + path.sep)) return null;
  const extension = path.extname(base).toLowerCase();
  const stem = extension ? base.slice(0, -extension.length) : base;
  const candidates = [
    base,
    ...(COMPILED_EXTENSION_SOURCES.get(extension) || []).map((source) => stem + source),
    ...SOURCE_EXTENSIONS.map((source) => base + source),
    ...SOURCE_EXTENSIONS.map((source) => path.join(base, `index${source}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not this candidate */ }
  }
  return null;
}
