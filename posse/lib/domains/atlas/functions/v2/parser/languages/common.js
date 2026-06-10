// @ts-check
//
// Shared helpers for language-specific parsers. All extractor modules
// import from here to keep symbol/edge construction uniform.

import { sha256Hex } from "../../hash.js";

/** @typedef {import("../../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../../contracts/schemas.js").SymbolKind} SymbolKind */
/** @typedef {import("../../contracts/schemas.js").EdgeKind} EdgeKind */
/** @typedef {import("../../contracts/schemas.js").SymbolVisibility} SymbolVisibility */

/**
 * Build a SymbolRow with required defaults and validated fields. Callers
 * may omit `signature_hash` to have it derived from the trimmed
 * signature string.
 *
 * @param {{
 *   content_hash: string,
 *   local_id: number,
 *   kind: SymbolKind,
 *   name: string,
 *   qualified_name?: string | null,
 *   parent_local_id?: number | null,
 *   repo_rel_path: string,
 *   lang: string,
 *   range_start: number,
 *   range_end: number,
 *   range_start_line?: number,
 *   range_end_line?: number,
 *   signature?: string,
 *   signature_hash?: string,
 *   visibility?: SymbolVisibility | null,
 *   doc?: string | null,
 * }} input
 * @returns {SymbolRow}
 */
export function makeSymbol(input) {
  const sigText = input.signature ?? `${input.kind} ${input.name}`;
  const signature_hash = input.signature_hash ?? sha256Hex(sigText);
  return /** @type {SymbolRow} */ ({
    content_hash: input.content_hash,
    local_id: input.local_id,
    kind: input.kind,
    name: input.name,
    qualified_name: input.qualified_name ?? null,
    parent_local_id: input.parent_local_id ?? null,
    repo_rel_path: input.repo_rel_path,
    lang: input.lang,
    range_start: input.range_start,
    range_end: input.range_end,
    // Leave undefined when the caller did not supply lines; parseBuffer's
    // attachLineRanges pass fills them from source offsets before ingest.
    range_start_line: input.range_start_line,
    range_end_line: input.range_end_line,
    signature_hash,
    // Persist the raw signature text alongside its hash so downstream
    // consumers (encoder, semantic search, code cards) get human-readable
    // signatures without re-parsing the source. Parser walker already
    // truncates `signature` at 200 chars so storage is bounded.
    signature_text: input.signature ?? null,
    visibility: input.visibility ?? null,
    doc: input.doc ?? null,
  });
}

/**
 * @param {{
 *   from_content_hash: string,
 *   from_local_id: number,
 *   edge_id: number,
 *   to_name: string,
 *   to_module?: string | null,
 *   kind: EdgeKind,
 *   range_start: number,
 *   range_end: number,
 *   range_start_line?: number,
 *   range_end_line?: number,
 *   confidence?: number,
 *   to_content_hash?: string | null,
 *   to_local_id?: number | null,
 * }} input
 * @returns {EdgeRow}
 */
export function makeEdge(input) {
  return /** @type {EdgeRow} */ ({
    from_content_hash: input.from_content_hash,
    from_local_id: input.from_local_id,
    edge_id: input.edge_id,
    to_content_hash: input.to_content_hash ?? null,
    to_local_id: input.to_local_id ?? null,
    to_name: input.to_name,
    to_module: input.to_module ?? null,
    kind: input.kind,
    range_start: input.range_start,
    range_end: input.range_end,
    range_start_line: input.range_start_line,
    range_end_line: input.range_end_line,
    confidence: input.confidence ?? 50,
  });
}

/**
 * Walk all matches of a global regex over a string using the native
 * String.matchAll() iterator. Yields each match plus its start/end
 * CHARACTER offsets (JS string indices, the same units SymbolRow's
 * `range_start` / `range_end` are documented in). For pure-ASCII source
 * these are identical to byte offsets; multibyte characters (UTF-8
 * encoded non-ASCII letters, emoji, etc.) shift them.
 *
 * @param {RegExp} pattern
 * @param {string} text
 * @returns {Generator<{ match: RegExpMatchArray, start: number, end: number }>}
 */
export function* scanAll(pattern, text) {
  if (!pattern.global) {
    throw new TypeError("scanAll: pattern must be global (/g)");
  }
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    yield { match, start, end };
  }
}

/**
 * Strip block and line comments from a source string while preserving
 * length (replaces comment bytes with spaces). Keeps offsets stable so
 * symbol ranges measured against the stripped text still match the
 * original source.
 *
 * Handles JS/TS/Java/C/C++/C#/Go/Rust/Kotlin style. Does not understand
 * Python triple-quoted strings or shell `#` comments — those languages
 * use their own stripper.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCStyleComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (!inSingle && !inDouble && !inTemplate) {
      if (c === "/" && c2 === "*") {
        out += "  ";
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          out += src[i] === "\n" ? "\n" : " ";
          i++;
        }
        if (i < n) {
          out += "  ";
          i += 2;
        }
        continue;
      }
      if (c === "/" && c2 === "/") {
        out += "  ";
        i += 2;
        while (i < n && src[i] !== "\n") {
          out += " ";
          i++;
        }
        continue;
      }
    }
    if (c === "\\" && i + 1 < n && (inSingle || inDouble || inTemplate)) {
      out += c + src[i + 1];
      i += 2;
      continue;
    }
    if (!inDouble && !inTemplate && c === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === "`") inTemplate = !inTemplate;
    out += c;
    i++;
  }
  return out;
}

/**
 * Like stripCStyleComments but for `#`-comment / triple-quoted languages
 * (Python). Preserves byte offsets.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripPythonComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inSingle = false;
  let inDouble = false;
  let inTriple = /** @type {null | '"""' | "'''"} */ (null);
  while (i < n) {
    const c = src[i];
    if (inTriple) {
      if (src.startsWith(inTriple, i)) {
        out += inTriple;
        i += 3;
        inTriple = null;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (src.startsWith('"""', i)) {
        out += '"""';
        i += 3;
        inTriple = '"""';
        continue;
      }
      if (src.startsWith("'''", i)) {
        out += "'''";
        i += 3;
        inTriple = "'''";
        continue;
      }
      if (c === "#") {
        out += " ";
        i += 1;
        while (i < n && src[i] !== "\n") {
          out += " ";
          i++;
        }
        continue;
      }
    }
    if (c === "\\" && i + 1 < n && (inSingle || inDouble)) {
      out += c + src[i + 1];
      i += 2;
      continue;
    }
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    out += c;
    i++;
  }
  return out;
}

/**
 * Find the matching `}` for an opening `{` at `start` in `text`. Returns
 * the offset of the closing `}`, or -1 if not found.
 *
 * String contents (single-quote, double-quote, and template literals)
 * are tracked so a `"}"` inside a literal doesn't close the body
 * prematurely. Comments are still expected to be stripped beforehand —
 * the caller passes `ctx.stripped` from `createExtractor` for that.
 *
 * Languages without template literals (`/Java/C#/Go/Python`) get template
 * tracking for free; the backtick never appears in their syntax outside
 * a string, so toggling on it is a no-op there.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
export function matchBraceEnd(text, start) {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    // Skip the next character on a backslash escape inside any string —
    // matters for `"\""`, `'\''`, and `` `\`` ``.
    if (c === "\\" && (inSingle || inDouble || inTemplate)) {
      i++;
      continue;
    }
    if (!inDouble && !inTemplate && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && c === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Build an extraction context that holds the running symbol/edge lists
 * plus the per-extractor counters and a sentinel-rewiring finalizer.
 *
 * Every language extractor follows the same pattern: maintain
 * `nextLocalId`, `nextEdgeId`, push SymbolRows and EdgeRows, then call
 * `rewireFromIds` to bind module-level imports to a real `from_local_id`
 * before returning. Centralizing it here eliminates 11× duplicated
 * `addSymbol` / `addEdge` / `rewireFromIds` blocks across the language
 * files — adding a new language is now "write the regex matchers
 * against `ctx`".
 *
 * Modeled on posse's BaseProvider/BaseRole abstract-base-class pattern:
 * a shared template that captures the boilerplate, with the
 * language-specific work delegated to the caller. Function-shaped
 * because extraction is a stateless transform — no instance lifecycle.
 *
 * Usage in a language file:
 *
 *   export function extract(args) {
 *     const ctx = createExtractor({ ...args, lang: "go" });
 *     for (const { match, start, end } of scanAll(funcRe, ctx.stripped)) {
 *       ctx.addSymbol({ kind: "function", name: match[1], ... });
 *     }
 *     return ctx.finalize();
 *   }
 *
 * @param {{
 *   content_hash: string,
 *   repo_rel_path: string,
 *   source: string,
 *   lang: string,
 *   stripComments?: (src: string) => string,
 * }} args
 */
export function createExtractor(args) {
  const {
    content_hash,
    repo_rel_path,
    source,
    lang,
    stripComments = stripCStyleComments,
  } = args;

  /** @type {SymbolRow[]} */
  const symbols = [];
  /** @type {EdgeRow[]} */
  const edges = [];
  let nextLocalId = 0;
  let nextEdgeId = 0;

  return {
    /** The raw source as supplied by the caller. */
    source,
    /** Comment-stripped, byte-offset-preserving copy. */
    stripped: stripComments(source),
    /** Read-only view of the rows accumulated so far. */
    get symbols() {
      return symbols;
    },
    get edges() {
      return edges;
    },
    /** Module-level sentinel passed when an edge has no enclosing symbol. */
    MODULE_LEVEL: -1,

    /**
     * Push a new symbol. The extractor auto-fills content_hash, local_id,
     * repo_rel_path, and lang; callers only specify the language-specific
     * fields.
     *
     * @param {Omit<Parameters<typeof makeSymbol>[0], "content_hash" | "local_id" | "repo_rel_path" | "lang">} input
     * @returns {SymbolRow}
     */
    addSymbol(input) {
      const sym = makeSymbol({
        content_hash,
        local_id: nextLocalId++,
        repo_rel_path,
        lang,
        ...input,
      });
      symbols.push(sym);
      return sym;
    },

    /**
     * Push a new edge. Caller supplies `from_local_id` (use
     * `MODULE_LEVEL` for module-scope edges that will be rewired during
     * finalize). The extractor auto-fills content_hash and edge_id.
     *
     * @param {Omit<Parameters<typeof makeEdge>[0], "from_content_hash" | "edge_id">} input
     * @returns {EdgeRow}
     */
    addEdge(input) {
      const edge = makeEdge({
        from_content_hash: content_hash,
        edge_id: nextEdgeId++,
        ...input,
      });
      edges.push(edge);
      return edge;
    },

    /**
     * Resolve module-level edge sentinels (`from_local_id === -1`) to
     * the first top-level symbol if one exists, otherwise drop those
     * edges entirely. Renumbers `edge_id` so the output is dense.
     *
     * Returns the final ParseResult-shaped payload.
     *
     * @returns {{ symbols: SymbolRow[], edges: EdgeRow[] }}
     */
    finalize() {
      const firstTopLevel = symbols.find((s) => s.parent_local_id == null);
      if (firstTopLevel) {
        for (const e of edges) if (e.from_local_id === -1) e.from_local_id = firstTopLevel.local_id;
      } else {
        for (let i = edges.length - 1; i >= 0; i--) {
          if (edges[i].from_local_id === -1) edges.splice(i, 1);
        }
      }
      edges.forEach((e, i) => (e.edge_id = i));
      return { symbols, edges };
    },
  };
}

/**
 * `sym` is optional because some callers — notably Kotlin's
 * primary-constructor-parameter range list — only need offset bounds for
 * the boolean containment check that `findEnclosingBody` performs. Other
 * callers that look up `result.sym` (Java method attribution, etc) pass
 * a populated `sym` and read it back unchanged.
 *
 * @template T
 * @typedef {{ sym?: T, bodyStart: number, bodyEnd: number }} BodySpan
 */

/**
 * Find the innermost entry in a list of body byte-ranges that contains
 * the given offset. Used by C-family / Java / C# / Kotlin / PHP / Rust
 * extractors to attribute method declarations to the smallest
 * containing class/struct/impl body.
 *
 * @template T
 * @param {BodySpan<T>[]} spans
 * @param {number} offset
 * @returns {BodySpan<T> | null}
 */
export function findEnclosingBody(spans, offset) {
  let best = null;
  for (const t of spans) {
    if (offset >= t.bodyStart && offset <= t.bodyEnd) {
      if (!best || t.bodyEnd - t.bodyStart < best.bodyEnd - best.bodyStart) {
        best = t;
      }
    }
  }
  return best;
}

/**
 * Inclusive line number (1-based) for a byte offset. Useful for
 * debugging or producing SymbolLocation later; not used in SymbolRow
 * itself.
 *
 * @param {string} src
 * @param {number} offset
 * @returns {number}
 */
export function lineNumberAt(src, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  const limit = Math.min(offset, src.length);
  for (let i = 0; i < limit; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Attach 1-based `range_start_line` / `range_end_line` to every row in
 * `rows`, deriving them from `range_start` / `range_end` against `source`.
 * Scans the source once to build a sorted newline-offset table, then uses
 * binary search per row — O(N + R log N) for N bytes and R rows.
 *
 * `range_end` is exclusive, so the end-line is the line of the last
 * character actually inside the range. Empty ranges (`end === start`) end
 * on the same line they start on.
 *
 * Rows that already carry numeric line columns are left as-is. This lets
 * a parser supply its own (e.g. tree-sitter knows lines directly) and
 * still pass through this helper unchanged.
 *
 * @param {string} source
 * @param {Array<{ range_start: number, range_end: number, range_start_line?: number, range_end_line?: number }>} rows
 * @returns {void}
 */
export function attachLineRanges(source, rows) {
  if (!rows || rows.length === 0) return;
  const newlines = buildNewlineTable(source);
  for (const row of rows) {
    if (
      Number.isInteger(row.range_start_line) &&
      Number.isInteger(row.range_end_line)
    ) {
      continue;
    }
    const start = Math.max(0, Number(row.range_start) || 0);
    const endRaw = Number(row.range_end);
    const end = Number.isFinite(endRaw) ? Math.max(start, endRaw) : start;
    // For range_end_line we want the line of the LAST char in the range,
    // not the line of the byte immediately after the range — otherwise a
    // declaration ending exactly on a newline would over-count by one.
    const endProbe = end > start ? end - 1 : start;
    row.range_start_line = lineFor(newlines, start);
    row.range_end_line = lineFor(newlines, endProbe);
  }
}

/**
 * Build an ascending list of newline character offsets in `source`. The
 * line containing offset `k` is `1 + countNewlinesBefore(k)`.
 *
 * @param {string} source
 * @returns {number[]}
 */
function buildNewlineTable(source) {
  /** @type {number[]} */
  const out = [];
  if (typeof source !== "string" || source.length === 0) return out;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) out.push(i);
  }
  return out;
}

/**
 * @param {number[]} newlines  Sorted ascending list of newline offsets.
 * @param {number} offset
 * @returns {number}
 */
function lineFor(newlines, offset) {
  if (offset <= 0 || newlines.length === 0) return 1;
  // Binary search for the first newline at or past `offset`.
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (newlines[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}
