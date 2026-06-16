// @ts-check
//
// ATLAS v2 view FTS helpers — build safe FTS5 MATCH queries for symbol
// search. Pure string transforms lifted out of the View class.

/**
 * Escape an FTS5 term so punctuation in user input does not blow up the
 * MATCH grammar. Wraps in double quotes and escapes internal quotes.
 *
 * @param {string} term
 * @returns {string}
 */
function escapeFtsTerm(term) {
  const s = String(term || "").trim();
  if (!s) return '""';
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {unknown} value
 * @returns {"name" | "body" | "either"}
 */
export function normalizeSearchScope(value) {
  return value === "name" || value === "body" || value === "either" ? value : "either";
}

/**
 * @param {string} term
 * @param {{ fuzzy: boolean, scope: "name" | "body" | "either" }} opts
 * @returns {string}
 */
export function ftsQueryForTerm(term, opts) {
  const quoted = `${escapeFtsTerm(term)}${opts.fuzzy ? "*" : ""}`;
  if (opts.scope === "body") return `body_identifiers:${quoted}`;
  if (opts.scope === "name") return `name:${quoted} OR qualified_name:${quoted}`;
  return quoted;
}
