// @ts-check

import { tokenizeForRanking } from "./tokens.js";

const SEMANTIC_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

/**
 * Produce a compact semantic probe from the raw query. Returning null tells the
 * caller the normalized probe would be redundant.
 *
 * @param {string} query
 * @returns {Promise<string | null>}
 */
export async function normalizedSemanticQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) return null;
  const seen = new Set();
  const tokens = [];
  for (const token of await tokenizeForRanking(raw)) {
    const normalized = String(token || "").toLowerCase();
    if (!normalized || SEMANTIC_STOP_WORDS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(normalized);
    if (tokens.length >= 32) break;
  }
  const normalized = tokens.join(" ");
  if (!normalized || normalized === raw.toLowerCase().replace(/\s+/g, " ")) return null;
  return normalized;
}

/**
 * Merge raw and normalized vector ranks without comparing backend score scales.
 *
 * @param {any} raw
 * @param {any} normalized
 * @returns {any}
 */
export function combineVectorResults(raw, normalized) {
  if (!normalized) return raw;
  if (!raw) return normalized;
  const sources = [raw, normalized].filter((result) => result?.ok === true);
  if (sources.length === 0) return raw;
  const fused = new Map();
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    for (const entry of sources[sourceIndex].entries || []) {
      if (!entry?.id) continue;
      const current = fused.get(entry.id) || {
        id: entry.id,
        payload: entry.payload,
        score: 0,
        bestRank: Number.POSITIVE_INFINITY,
        sourceIndex,
      };
      const rank = Math.max(1, Number(entry.rank) || 1);
      current.score += 1 / (60 + rank);
      current.bestRank = Math.min(current.bestRank, rank);
      fused.set(entry.id, current);
    }
  }
  const ordered = [...fused.values()].sort((left, right) => right.score - left.score
    || left.bestRank - right.bestRank
    || left.sourceIndex - right.sourceIndex
    || left.id.localeCompare(right.id));
  return {
    ok: true,
    entries: ordered.map((entry, index) => ({ id: entry.id, rank: index + 1, payload: entry.payload })),
    raw: ordered.map((entry) => entry.payload),
    total: ordered.length,
  };
}
