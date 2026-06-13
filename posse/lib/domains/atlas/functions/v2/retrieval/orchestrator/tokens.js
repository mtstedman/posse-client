// @ts-check
//
// Tokenizer shared by task-query-ranking. Splits on punctuation,
// camelCase, and underscores; lowercases; drops common English /
// programming stop-words.
//
// The tokenizer doesn't need to be precise — task-query ranking is a
// tiebreaker, not a primary signal. The split/stop-word logic is owned by
// the native posse-atlas binary — the only implementation path.

import { runAtlasNativeOperation } from "../../native/invoke.js";

// Memo for tokenize results. Task-query ranking tokenizes 1-2 strings PER
// fused symbol per query, and each sync native call is a full process spawn
// since the sync bridge was removed — without the memo one ranking pass costs
// dozens of spawns. Inputs are short symbol names that repeat heavily within
// and across queries in a session, so a small bounded map absorbs almost all
// of it. Tokenization is pure (same input → same tokens), so caching is safe.
const TOKENIZE_MEMO_MAX = 4096;
/** @type {Map<string, string[]>} */
const TOKENIZE_MEMO = new Map();

/**
 * Tokenize for ranking. Splits camelCase ("getUserById" → "get",
 * "user", "by", "id"), underscores, dots, dashes, and whitespace.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeForRanking(input) {
  const key = String(input ?? "");
  const cached = TOKENIZE_MEMO.get(key);
  if (cached) return cached.slice();
  const tokens = /** @type {string[]} */ (runAtlasNativeOperation({ op: "tokenize", input: key }));
  if (TOKENIZE_MEMO.size >= TOKENIZE_MEMO_MAX) {
    // Drop the oldest entry (Map preserves insertion order) — cheap bound,
    // no LRU bookkeeping needed for a tiebreaker-quality cache.
    const oldest = TOKENIZE_MEMO.keys().next().value;
    if (oldest !== undefined) TOKENIZE_MEMO.delete(oldest);
  }
  TOKENIZE_MEMO.set(key, Array.isArray(tokens) ? tokens : []);
  return Array.isArray(tokens) ? tokens.slice() : [];
}
