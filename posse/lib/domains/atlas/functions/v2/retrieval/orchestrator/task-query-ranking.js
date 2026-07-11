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

import { tokenizeForRanking } from "./tokens.js";

/** @typedef {import("../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("./rrf.js").FusedEntry<ViewSymbol>} FusedSymbolEntry */

/**
 * Weight of the task-overlap bonus, applied PROPORTIONALLY to the entry's own
 * fused score (score += score * weight * overlapRatio). Proportional scaling
 * is what makes this a genuine tiebreaker: it reorders near-ties (adjacent
 * RRF ranks differ by a few percent) but cannot vault a deep-ranked symbol
 * over the top hits — the old flat +0.05 bonus was ~3x a rank-1 RRF score
 * (1/(k+1) with k=60), so "tiebreaker" silently dominated the fused order.
 */
const TASK_BONUS_WEIGHT = 0.25;

/**
 * Scoring core: the bonus math and the deterministic re-sort, applied once the
 * caller has gathered task + per-symbol token sets from the daemon tokenizer.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {Set<string>} taskTokens
 * @param {Set<string>[]} symbolTokenSets one per `fused` entry, same order
 * @returns {FusedSymbolEntry[]}
 */
function applyTaskBonusesAndSort(fused, taskTokens, symbolTokenSets) {
  for (let i = 0; i < fused.length; i += 1) {
    const entry = fused[i];
    const symbolTokens = symbolTokenSets[i];
    if (symbolTokens.size === 0) continue;
    const overlap = intersectionSize(taskTokens, symbolTokens);
    if (overlap === 0) continue;
    // Normalize by the symbol's token count: a symbol named exactly the
    // task keyword should bonus more than a long qualified name that
    // happens to contain it.
    const overlapRatio = overlap / symbolTokens.size;
    const bonus = entry.score * TASK_BONUS_WEIGHT * overlapRatio;
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
 * Re-rank fused entries with task-query overlap as a tiebreaker. Mutates
 * `fused` in place and returns it.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {string | undefined} taskText
 * @returns {Promise<FusedSymbolEntry[]>}
 */
export async function applyTaskQueryRanking(fused, taskText) {
  if (!taskText || typeof taskText !== "string") return fused;
  const taskTokens = await tokenSet(taskText);
  if (taskTokens.size === 0) return fused;
  const symbolTokenSets = await Promise.all(fused.map((entry) => symbolTokenSet(entry.payload)));
  return applyTaskBonusesAndSort(fused, taskTokens, symbolTokenSets);
}

/**
 * @param {string} text
 * @returns {Promise<Set<string>>}
 */
async function tokenSet(text) {
  const out = new Set();
  for (const t of await tokenizeForRanking(text)) out.add(t);
  return out;
}

/**
 * @param {ViewSymbol} sym
 * @returns {Promise<Set<string>>}
 */
async function symbolTokenSet(sym) {
  const out = new Set();
  const [nameTokens, qualifiedTokens] = await Promise.all([
    tokenizeForRanking(sym.name || ""),
    sym.qualified_name ? tokenizeForRanking(sym.qualified_name) : Promise.resolve([]),
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
