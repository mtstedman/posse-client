// @ts-check
//
// Task-query re-ranking. The plain RRF + feedback pipeline ranks each
// symbol relative to the search `query` string. But callers often have
// additional context — the original `taskText` ("debug the auth bug
// where login spins forever") — that we can use to nudge results toward
// symbols whose qualified names mention task vocabulary.
//
// v1 implementation is a token-overlap heuristic. It's good enough to
// promote `auth.login` over `auth.logout` when the task mentions login.
// A future revision can swap in semantic similarity once embeddings are
// stable (Workstream H).

import { tokenizeForRanking, tokenizeForRankingAsync } from "./tokens.js";

/** @typedef {import("../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("./rrf.js").FusedEntry<ViewSymbol>} FusedSymbolEntry */

/**
 * Scale applied to task-overlap bonus. Held small intentionally — the
 * orchestrator's RRF order is authoritative; this is a tiebreaker, not
 * an override.
 */
const TASK_BONUS_SCALE = 0.05;

/**
 * Re-rank fused entries with task-query overlap as a tiebreaker. Mutates
 * `fused` in place and returns it.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {string | undefined} taskText
 * @returns {FusedSymbolEntry[]}
 */
export function applyTaskQueryRanking(fused, taskText) {
  if (!taskText || typeof taskText !== "string") return fused;
  const taskTokens = tokenSet(taskText);
  if (taskTokens.size === 0) return fused;
  for (const entry of fused) {
    const sym = entry.payload;
    const symbolTokens = symbolTokenSet(sym);
    if (symbolTokens.size === 0) continue;
    const overlap = intersectionSize(taskTokens, symbolTokens);
    if (overlap === 0) continue;
    // Normalize by the symbol's token count: a symbol named exactly the
    // task keyword should bonus more than a long qualified name that
    // happens to contain it.
    const overlapRatio = overlap / symbolTokens.size;
    const bonus = TASK_BONUS_SCALE * overlapRatio;
    entry.score += bonus;
    /** @type {any} */ (entry).taskRanking = { overlap, overlapRatio, bonus };
  }
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  return fused;
}

/**
 * Async daemon-backed variant for retrieval paths that are already async.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {string | undefined} taskText
 * @returns {Promise<FusedSymbolEntry[]>}
 */
export async function applyTaskQueryRankingAsync(fused, taskText) {
  if (!taskText || typeof taskText !== "string") return fused;
  const taskTokens = await tokenSetAsync(taskText);
  if (taskTokens.size === 0) return fused;
  const symbolTokenSets = await Promise.all(fused.map((entry) => symbolTokenSetAsync(entry.payload)));
  for (let i = 0; i < fused.length; i += 1) {
    const entry = fused[i];
    const symbolTokens = symbolTokenSets[i];
    if (symbolTokens.size === 0) continue;
    const overlap = intersectionSize(taskTokens, symbolTokens);
    if (overlap === 0) continue;
    const overlapRatio = overlap / symbolTokens.size;
    const bonus = TASK_BONUS_SCALE * overlapRatio;
    entry.score += bonus;
    /** @type {any} */ (entry).taskRanking = { overlap, overlapRatio, bonus };
  }
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  return fused;
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenSet(text) {
  const out = new Set();
  for (const t of tokenizeForRanking(text)) out.add(t);
  return out;
}

/**
 * @param {string} text
 * @returns {Promise<Set<string>>}
 */
async function tokenSetAsync(text) {
  const out = new Set();
  for (const t of await tokenizeForRankingAsync(text)) out.add(t);
  return out;
}

/**
 * @param {ViewSymbol} sym
 * @returns {Set<string>}
 */
function symbolTokenSet(sym) {
  const out = new Set();
  for (const t of tokenizeForRanking(sym.name || "")) out.add(t);
  if (sym.qualified_name) {
    for (const t of tokenizeForRanking(sym.qualified_name)) out.add(t);
  }
  return out;
}

/**
 * @param {ViewSymbol} sym
 * @returns {Promise<Set<string>>}
 */
async function symbolTokenSetAsync(sym) {
  const out = new Set();
  const [nameTokens, qualifiedTokens] = await Promise.all([
    tokenizeForRankingAsync(sym.name || ""),
    sym.qualified_name ? tokenizeForRankingAsync(sym.qualified_name) : Promise.resolve([]),
  ]);
  for (const t of nameTokens) out.add(t);
  for (const t of qualifiedTokens) out.add(t);
  return out;
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function intersectionSize(a, b) {
  // Iterate the smaller set for cheaper lookups.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n++;
  return n;
}
