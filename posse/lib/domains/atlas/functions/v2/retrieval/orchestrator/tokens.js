// @ts-check
//
// Tokenizer shared by task-query-ranking. Splits on punctuation,
// camelCase, and underscores; lowercases; drops common English /
// programming stop-words.
//
// The tokenizer doesn't need to be precise — task-query ranking is a
// tiebreaker, not a primary signal. The split/stop-word logic is owned by
// the native posse-atlas binary — the only implementation path.

import { runAtlasNativeOperation, runAtlasNativeOperationAsync } from "../../native/invoke.js";

// Memo for tokenize results. Task-query ranking tokenizes 1-2 strings PER
// fused symbol per query, and each sync native call is a full process spawn
// since the sync bridge was removed — without the memo one ranking pass costs
// dozens of spawns. Inputs are short symbol names that repeat heavily within
// and across queries in a session, so a small bounded map absorbs almost all
// of it. Tokenization is pure (same input → same tokens), so caching is safe.
const TOKENIZE_MEMO_MAX = 4096;
/** @type {Map<string, string[]>} */
const TOKENIZE_MEMO = new Map();
/** @type {Map<string, Promise<string[]>>} */
const TOKENIZE_INFLIGHT = new Map();

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
  let tokens;
  try {
    tokens = /** @type {string[]} */ (runAtlasNativeOperation({ op: "tokenize", input: key }));
  } catch {
    // Native binary unavailable: degrade to the JS splitter rather than fail
    // the whole search — ranking is a tiebreaker, and the orchestrator's
    // contract is downgrade-not-throw. Deliberately NOT memoized so native
    // quality returns as soon as the binary does.
    return tokenizeJsFallback(key);
  }
  memoizeTokens(key, tokens);
  return Array.isArray(tokens) ? tokens.slice() : [];
}

/**
 * Rough JS approximation of the native tokenizer (camelCase / underscore /
 * punctuation split, lowercase, short-token drop). Only used when the native
 * binary is unavailable.
 *
 * @param {string} input
 * @returns {string[]}
 */
function tokenizeJsFallback(input) {
  return String(input || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
}

/**
 * Async daemon-backed tokenizer for retrieval paths that are already async.
 *
 * @param {string} input
 * @returns {Promise<string[]>}
 */
export async function tokenizeForRankingAsync(input) {
  const key = String(input ?? "");
  const cached = TOKENIZE_MEMO.get(key);
  if (cached) return cached.slice();
  let inFlight = TOKENIZE_INFLIGHT.get(key);
  if (!inFlight) {
    inFlight = runAtlasNativeOperationAsync({ op: "tokenize", input: key })
      .then((tokens) => {
        memoizeTokens(key, tokens);
        return Array.isArray(tokens) ? tokens.slice() : [];
      })
      // Same degrade-not-throw fallback as the sync path; not memoized so
      // native quality returns with the daemon.
      .catch(() => tokenizeJsFallback(key))
      .finally(() => {
        if (TOKENIZE_INFLIGHT.get(key) === inFlight) TOKENIZE_INFLIGHT.delete(key);
      });
    TOKENIZE_INFLIGHT.set(key, inFlight);
  }
  const tokens = await inFlight;
  return tokens.slice();
}

function memoizeTokens(key, tokens) {
  if (TOKENIZE_MEMO.size >= TOKENIZE_MEMO_MAX) {
    // Drop the oldest entry (Map preserves insertion order) — cheap bound,
    // no LRU bookkeeping needed for a tiebreaker-quality cache.
    const oldest = TOKENIZE_MEMO.keys().next().value;
    if (oldest !== undefined) TOKENIZE_MEMO.delete(oldest);
  }
  TOKENIZE_MEMO.set(key, Array.isArray(tokens) ? tokens : []);
}
