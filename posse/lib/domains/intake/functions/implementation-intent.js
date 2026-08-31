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
  "surface",
  "show",
  "display",
  "expose",
  "split",
  "separate",
  "move",
  "rename",
  "wire",
  "connect",
  "integrate",
  "embed",
  "incorporate",
  "enable",
  "disable",
]);

const NEGATED_VERB_PREFIX_RE =
  /\b(?:do\s+not|don't|dont|never|no\s+need\s+to)\b[^.!?\r\n]{0,80}$/iu;
const CLAUSE_SEPARATOR_RE = /[,;—]|\b(?:but|however|instead)\b/iu;
const PASSIVE_REQUIREMENT_RE =
  /\b(?:should|must|needs?\s+to|ought\s+to|has\s+to|have\s+to)\b/iu;
const SELF_DIRECTED_REQUIREMENT_RE =
  /\b(?:should|must|can|could|would|will|do|does)\s+(?:i|we)\b/iu;
const EXPLICIT_REPO_WORK_RE =
  /\b(?:dev(?:elopment)?|coding|implementation)\s+(?:job|task|work)\b|\b(?:job|task|work)\s+(?:is\s+)?(?:dev(?:elopment)?|coding|implementation)\b/iu;

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

export function hasExplicitRepoWorkIntent(text) {
  return EXPLICIT_REPO_WORK_RE.test(String(text || ""));
}

export function hasPassiveRepoRequirementIntent(text) {
  const sentences = String(text || "").match(/[^.!?\r\n]+[.!?\r\n]*/gu) || [String(text || "")];
  return sentences.some((sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.endsWith("?")) return false;
    if (SELF_DIRECTED_REQUIREMENT_RE.test(trimmed)) return false;
    return PASSIVE_REQUIREMENT_RE.test(trimmed);
  });
}
