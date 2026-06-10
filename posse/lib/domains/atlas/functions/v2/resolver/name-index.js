// @ts-check
//
// Global name index — maps simple symbol name → list of candidate
// `(global_id, content_hash, local_id, repo_rel_path)` rows across an
// entire view. The resolver consults this when import-aware resolution
// fails so we can still bind by heuristic name match (with an
// ambiguity penalty proportional to the candidate count).
//
// Built once per resolver pass from `SELECT name, global_id, ... FROM
// symbols`. Cheap enough to recompute on every view build; we don't
// persist the index.

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */

/**
 * @typedef {Object} NameCandidate
 * @property {number} global_id
 * @property {string} content_hash
 * @property {number} local_id
 * @property {string} repo_rel_path
 * @property {string} kind
 * @property {string | null} qualified_name
 */

/** @typedef {Map<string, NameCandidate[]>} NameIndex */

/**
 * @typedef {Object} NameIndexes
 * @property {NameIndex} byName            Simple-name lookup ("Greeter" → candidates).
 * @property {NameIndex} byQualifiedName   Qualified-name lookup ("Greeter.hello" → candidates).
 *   Used when the parser emits `to_name` already in qualified form.
 */

/**
 * Build a NameIndexes from a tuple-stream of (name, qualified_name,
 * global_id, content_hash, local_id, repo_rel_path, kind) rows. The
 * caller provides an iterable so this function works for both a live
 * sqlite cursor and an in-memory array (used by tests).
 *
 * @param {Iterable<NameCandidate & { name: string }>} rows
 * @returns {NameIndexes}
 */
export function buildNameIndexes(rows) {
  /** @type {NameIndex} */
  const byName = new Map();
  /** @type {NameIndex} */
  const byQualifiedName = new Map();

  for (const row of rows) {
    const candidate = {
      global_id: row.global_id,
      content_hash: row.content_hash,
      local_id: row.local_id,
      repo_rel_path: row.repo_rel_path,
      kind: row.kind,
      qualified_name: row.qualified_name ?? null,
    };
    const existing = byName.get(row.name);
    if (existing) existing.push(candidate);
    else byName.set(row.name, [candidate]);

    if (row.qualified_name) {
      const q = byQualifiedName.get(row.qualified_name);
      if (q) q.push(candidate);
      else byQualifiedName.set(row.qualified_name, [candidate]);
    }
  }
  return { byName, byQualifiedName };
}

/**
 * Look up candidates by simple name. Returns an empty array when no
 * symbol with this name exists.
 *
 * @param {NameIndexes} idx
 * @param {string} name
 * @returns {NameCandidate[]}
 */
export function lookupByName(idx, name) {
  return idx.byName.get(name) || [];
}

/**
 * Look up by qualified name (e.g. `Greeter.hello` or `Greeter::hello`).
 *
 * @param {NameIndexes} idx
 * @param {string} qname
 * @returns {NameCandidate[]}
 */
export function lookupByQualifiedName(idx, qname) {
  return idx.byQualifiedName.get(qname) || [];
}
