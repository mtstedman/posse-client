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

/**
 * Tokenize for ranking. Splits camelCase ("getUserById" → "get",
 * "user", "by", "id"), underscores, dots, dashes, and whitespace.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeForRanking(input) {
  return /** @type {string[]} */ (runAtlasNativeOperation({ op: "tokenize", input }));
}
