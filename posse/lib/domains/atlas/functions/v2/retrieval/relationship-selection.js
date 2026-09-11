// @ts-check

import { symbolIdOf } from "./cards.js";

const EDGE_TO_RELATIONSHIP = Object.freeze({
  calls: "caller",
  references: "reference",
});
const RELATIONSHIP_ORDER = Object.freeze({ caller: 0, reference: 1 });

/**
 * Turn path-qualified storage rows into the neutral, bounded entry list used
 * by the compact caller projection. Selection and deduplication happen before
 * presentation bounds, and a symbol under both relationships remains two
 * entries.
 *
 * @param {unknown} rows
 * @param {{
 *   relationships: ("caller" | "reference")[],
 *   offset?: number,
 *   limit?: number,
 *   indexVersion: string,
 *   indexIncomplete?: boolean,
 * }} options
 */
export function selectIncomingRelationshipEntries(rows, options) {
  const selected = new Set(Array.isArray(options?.relationships) ? options.relationships : []);
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = normalizeRelationshipEntry(row);
    if (!entry || !selected.has(entry.relationship)) continue;
    const key = JSON.stringify([entry.relationship, entry.file, entry.symbolId]);
    if (!groups.has(key)) groups.set(key, entry);
  }
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const ordered = [...groups.values()].sort((left, right) => (
    RELATIONSHIP_ORDER[left.relationship] - RELATIONSHIP_ORDER[right.relationship]
    || compare(left.file, right.file)
    || compare(left.symbolId, right.symbolId)
    || compare(left.name, right.name)
  ));
  const offset = nonNegativeInteger(options?.offset, 0);
  const limit = clampInteger(options?.limit, 20, 1, 100);
  const entries = ordered.slice(offset, offset + limit);
  const returned = entries.length;
  const hasMore = offset + returned < ordered.length;
  return {
    entries,
    meta: {
      pagination: {
        offset,
        limit,
        returned,
        hasMore,
        nextOffset: hasMore ? offset + returned : null,
        indexVersion: String(options?.indexVersion || ""),
      },
      indexIncomplete: options?.indexIncomplete === true,
    },
  };
}

/** @param {any} row */
function normalizeRelationshipEntry(row) {
  if (!row || typeof row !== "object") return null;
  const relationship = row.relationship === "calls" || row.relationship === "references"
    ? EDGE_TO_RELATIONSHIP[row.relationship]
    : row.relationship;
  if (relationship !== "caller" && relationship !== "reference") return null;
  const symbol = row.symbol && typeof row.symbol === "object" ? row.symbol : null;
  const file = String(row.file || symbol?.repo_rel_path || "").trim();
  const symbolId = String(row.symbolId || (symbol ? symbolIdOf(symbol) : "")).trim();
  const name = String(
    row.name || symbol?.qualified_name || symbol?.name || "",
  ).trim();
  if (!file || !symbolId || !name) return null;
  return { relationship, file, symbolId, name };
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}
