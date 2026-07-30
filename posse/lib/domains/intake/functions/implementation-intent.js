const REPO_MUTATION_VERBS = Object.freeze([
  "fix",
  "implement",
  "change",
  "update",
  "modify",
  "edit",
  "refactor",
  "add",
  "remove",
  "delete",
  "migrate",
  "build",
  "repair",
  "replace",
  "clean",
]);

const NEGATED_VERB_PREFIX_RE =
  /\b(?:do\s+not|don't|dont|never|no\s+need\s+to)\b[^.!?\r\n]{0,80}$/iu;
const CLAUSE_SEPARATOR_RE = /[,;—]|\b(?:but|however|instead)\b/iu;

export function hasUnnegatedVerbIntent(text, verbs) {
  const alternatives = [...new Set((verbs || []).map((verb) => String(verb || "").trim()).filter(Boolean))]
    .map((verb) => verb.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (alternatives.length === 0) return false;
  const pattern = `\\b(?:${alternatives.join("|")})\\b`;
  const sentences = String(text || "").match(/[^.!?\r\n]+[.!?\r\n]*/gu) || [String(text || "")];
  return sentences.some((sentence) => (
    sentence.split(CLAUSE_SEPARATOR_RE).some((clause) => {
      for (const match of clause.matchAll(new RegExp(pattern, "giu"))) {
        const prefix = clause.slice(0, match.index);
        if (!NEGATED_VERB_PREFIX_RE.test(prefix)) return true;
      }
      return false;
    })
  ));
}

export function hasRepoMutationIntent(
  text,
  { includeCreate = false, includeCompletion = false } = {},
) {
  const verbs = [
    ...REPO_MUTATION_VERBS,
    ...(includeCreate ? ["create"] : []),
    ...(includeCompletion ? ["complete", "correct"] : []),
  ];
  return hasUnnegatedVerbIntent(text, verbs);
}
