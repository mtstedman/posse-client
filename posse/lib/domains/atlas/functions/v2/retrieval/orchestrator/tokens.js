// @ts-check
//
// Tokenizer shared by task-query-ranking. Splits on punctuation,
// camelCase, and underscores; lowercases; drops common English /
// programming stop-words.
//
// Kept tiny and intentional. The tokenizer doesn't need to be precise —
// task-query ranking is a tiebreaker, not a primary signal.

import { runAtlasNativeOperation } from "../../native/invoke.js";
import { nativeBinaries } from "../../../../../../classes/tools/BinaryManager.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "for", "with", "at",
  "by", "from", "as", "this", "that", "it", "its", "we", "us", "our",
  // Tasks often include verbs like these — they're rarely meaningful
  // for symbol matching.
  "fix", "add", "remove", "make", "do", "use", "set", "get",
  "code",
  // Common single-letter or one-character noise post-split.
  "i", "n", "s", "t", "m", "d",
]);

const MIN_TOKEN_LEN = 2;

/**
 * Tokenize for ranking. Splits camelCase ("getUserById" → "get",
 * "user", "by", "id"), underscores, dots, dashes, and whitespace.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeForRanking(input) {
  if (nativeBinaries.shouldUse("atlas")) {
    return /** @type {string[]} */ (runAtlasNativeOperation({ op: "tokenize", input }));
  }
  return tokenizeForRankingNode(input);
}

/** @param {string} input @returns {string[]} */
function tokenizeForRankingNode(input) {
  if (typeof input !== "string" || input.length === 0) return [];
  // First split camelCase by inserting spaces before uppercase runs.
  const broken = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // Then split on non-alphanumeric.
  /** @type {string[]} */
  const out = [];
  for (const piece of broken.split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(lower)) continue;
    out.push(lower);
  }
  return out;
}
