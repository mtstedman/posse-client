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

/**
 * Turn the embedding backend on for a descriptive symbol.search query. An
 * explicit `semantic` value, and a search explicitly scoped to names, are
 * left as the caller wrote them.
 *
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
export function withDescriptiveSearchSemantic(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (args.semantic != null) return args;
  if (String(args.scope || "").trim().toLowerCase() === "name") return args;
  return isDescriptiveSearchQuery(args.query) ? { ...args, semantic: true } : args;
}
