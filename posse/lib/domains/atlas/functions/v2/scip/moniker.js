// @ts-check
//
// SCIP parsed-symbol → external_symbols row tuple. The Ledger.upsertExternalSymbol
// API already sentinel-normalizes null/'' but we do it here too so callers
// can compare hash-stable tuples without going through SQLite.

import { externalDisplayName, descriptorsToQualifiedName } from "./symbol-parser.js";

/** @typedef {import("./symbol-parser.js").ScipParsedSymbol} ScipParsedSymbol */

/**
 * @typedef {Object} ScipExternalMoniker
 * @property {string} scheme
 * @property {string} manager
 * @property {string} package_name
 * @property {string} package_version
 * @property {string} descriptor
 * @property {string} display_name
 * @property {string} qualified_name
 */

/**
 * Produce the external-symbol tuple from a parsed SCIP symbol. The
 * `descriptor` field is the raw concatenated descriptor portion of the
 * SCIP symbol string (everything after the last space in the input), so
 * it round-trips exactly when re-emitted.
 *
 * @param {ScipParsedSymbol} parsed
 * @returns {ScipExternalMoniker}
 */
export function monikerFromParsedSymbol(parsed) {
  if (parsed.local) {
    throw new RangeError("monikerFromParsedSymbol: local symbols are not external monikers");
  }
  return {
    scheme: parsed.scheme,
    manager: parsed.manager,
    package_name: parsed.package_name,
    package_version: parsed.package_version,
    descriptor: extractDescriptorTail(parsed.raw),
    display_name: externalDisplayName(parsed),
    qualified_name: descriptorsToQualifiedName(parsed.descriptors),
  };
}

/**
 * Walk the raw symbol string and return the substring after the fourth
 * space (i.e. everything from the start of the descriptors). Falls back
 * to the raw input when the symbol doesn't have the expected
 * `scheme manager package version descriptor` shape.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractDescriptorTail(raw) {
  const cursor = { s: String(raw || ""), i: 0 };
  for (let field = 0; field < 4; field++) {
    skipPackageField(cursor);
    if (cursor.s[cursor.i] !== " ") return raw;
    cursor.i++;
  }
  return cursor.s.slice(cursor.i);
}

function skipPackageField(cursor) {
  while (cursor.i < cursor.s.length) {
    if (cursor.s[cursor.i] === " ") {
      if (cursor.s[cursor.i + 1] === " ") {
        cursor.i += 2;
        continue;
      }
      return;
    }
    cursor.i++;
  }
}
