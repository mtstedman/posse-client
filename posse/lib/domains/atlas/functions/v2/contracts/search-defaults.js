// @ts-check
//
// symbol.search runs its embedding backend only when a call asks for it with
// `semantic: true`, and agents do not ask: across a 40-cell research run every
// search was lexical, while the conceptual lookups went to regex alternations
// of guessed names. A query worded as a description is the case embeddings
// exist for, so it gets them unless the call says otherwise. A query made of
// identifiers stays lexical: an exact name is best answered exactly.

const PLAIN_WORD = /^[a-z]{3,}$/u;
const QUERY_TOKEN = /[^\s,;]+/gu;

/**
 * True when a search query reads as a description rather than a list of
 * identifiers: at least two terms, one of them an ordinary lowercase word.
 * `Router.dispatch handleError` names declarations; `route matching order`
 * and `ObjectUtils assign` describe what to find.
 *
 * @param {unknown} query
 * @returns {boolean}
 */
export function isDescriptiveSearchQuery(query) {
  const tokens = String(query || "").match(QUERY_TOKEN) || [];
  return tokens.length >= 2 && tokens.some((token) => PLAIN_WORD.test(token));
}

// The lexical and graph backends are both seeded from the query's words, so in
// an even fusion a described query is outvoted two to one by name overlap and
// the nearest embeddings never reach the result. Two votes per vector hit let
// them through; a native binary that predates the argument ignores it.
export const DESCRIPTIVE_SEARCH_VECTOR_EVIDENCE_WEIGHT = 2;

/**
 * Turn the embedding backend on for a descriptive symbol.search query, with
 * the vector weight that lets its hits surface. An explicit `semantic` value,
 * and a search explicitly scoped to names, are left as the caller wrote them;
 * so is an explicit weight.
 *
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
export function withDescriptiveSearchSemantic(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (args.semantic != null) return args;
  if (String(args.scope || "").trim().toLowerCase() === "name") return args;
  if (!isDescriptiveSearchQuery(args.query)) return args;
  return {
    ...args,
    semantic: true,
    ...(args.vectorEvidenceWeight == null ? { vectorEvidenceWeight: DESCRIPTIVE_SEARCH_VECTOR_EVIDENCE_WEIGHT } : {}),
  };
}
