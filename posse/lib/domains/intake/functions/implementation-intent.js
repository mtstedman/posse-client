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

// A named source file, or a code noun as the object of a creation or mutation
// verb, marks repository work even when report words sit nearby ("write unit
// tests for the report generator", "create a CSV export endpoint").
const SOURCE_FILE_RE =
  /(?:^|[\s"'`(<[])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:c|cc|cjs|cpp|cs|css|cxx|dart|ex|exs|go|h|hpp|java|js|jsx|kt|kts|less|lua|mjs|php|py|rb|rs|sass|scala|scss|sh|sql|svelte|swift|ts|tsx|vue|zig))(?=$|[\s"'`)\]>,;:!?]|\.(?:\s|$))/giu;
// "Node.js"-style product names are not files.
const DOT_JS_PRODUCT_RE =
  /^(?:alpine|angular|backbone|chart|d3|ember|express|next|node|nuxt|p5|react|solid|three|vue)\.js$/u;
const CODE_TASK_VERBS = Object.freeze([
  ...REPO_MUTATION_VERBS,
  "write",
  "rewrite",
  "create",
  "generate",
  "make",
  "prepare",
  "draft",
  "produce",
  "compile",
  "export",
  "deliver",
  "scaffold",
]);
const CODE_NOUN_RE =
  /^(?:tests?|specs?|endpoints?|functions?|methods?|scripts?|components?|modules?|class(?:es)?|apis?|parsers?|handlers?|hooks?|routes?|controllers?|migrations?|middlewares?)$/u;
const OBJECT_STOP_WORDS = new Set([
  "about", "across", "after", "and", "are", "as", "at", "be", "because", "before", "but", "by",
  "for", "from", "if", "in", "into", "is", "of", "on", "onto", "or", "over", "per", "so", "than",
  "that", "then", "through", "to", "under", "using", "via", "was", "were", "when", "where",
  "which", "while", "who", "whose", "with", "within", "without",
]);
const DETERMINERS = new Set(["a", "an", "the", "this", "that", "these", "those", "all", "each", "every", "my", "our", "your", "its", "their"]);
// After one of these, a participle opens a description of the document, not a
// longer name for it ("a report listing failing tests" asks for a report).
const REPORT_NOUN_RE =
  /^(?:reports?|summar(?:y|ies)|write-?ups?|analys[ie]s|briefs?|csvs?|spreadsheets?|documents?|docs?|lists?|tables?|overviews?|audits?)$/u;
const MAX_OBJECT_WORDS = 8;

function verbForms(verb) {
  const forms = [verb, `${verb}s`, `${verb}es`, `${verb}ing`];
  if (verb.endsWith("e")) forms.push(`${verb.slice(0, -1)}ing`);
  if (/[^aeiou][aeiou][bdgmnprt]$/u.test(verb)) forms.push(`${verb}${verb.at(-1)}ing`);
  return forms;
}

const CODE_TASK_VERB_RE = new RegExp(
  `\\b(?:${[...new Set(CODE_TASK_VERBS.flatMap(verbForms))].join("|")})\\b`,
  "giu",
);

function namesSourceFile(text) {
  for (const match of String(text || "").matchAll(SOURCE_FILE_RE)) {
    const file = match[1];
    if (file.includes("/") || !DOT_JS_PRODUCT_RE.test(file.toLowerCase())) return true;
  }
  return false;
}

// The object's head noun is its last word before a preposition, relative
// pronoun, clause punctuation, or a participle that opens a trailing phrase
// ("a report summarizing the parser" has the head "report").
function objectHeadIsCodeNoun(rest) {
  const tokens = String(rest || "").split(/\s+/u).filter(Boolean);
  const words = [];
  for (let index = 0; index < tokens.length && words.length < MAX_OBJECT_WORDS; index += 1) {
    const word = tokens[index].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!word || OBJECT_STOP_WORDS.has(word)) break;
    const next = String(tokens[index + 1] || "").replace(/^[^\p{L}\p{N}]+/u, "");
    if (words.length > 0 && /ing$/u.test(word)
      && (!next || DETERMINERS.has(next) || words.some((seen) => REPORT_NOUN_RE.test(seen)))) break;
    words.push(word);
    if (/[^\p{L}\p{N}]$/u.test(tokens[index])) break;
  }
  return words.length > 0 && CODE_NOUN_RE.test(words.at(-1));
}

/** True when a creation or mutation verb's object is a code noun. */
export function hasCodeObjectIntent(text) {
  const source = String(text || "").toLowerCase();
  const sentences = source.split(/(?<=[.!?])\s+|[\r\n]+/u);
  return sentences.some((sentence) => (
    sentence.split(CLAUSE_SEPARATOR_RE).some((clause) => {
      for (const match of clause.matchAll(CODE_TASK_VERB_RE)) {
        if (NEGATED_VERB_PREFIX_RE.test(clause.slice(0, match.index))) continue;
        if (objectHeadIsCodeNoun(clause.slice(match.index + match[0].length))) return true;
      }
      return false;
    })
  ));
}

/** True when the request names a source file or gives a verb a code-noun object. */
export function hasCodeTaskIntent(text) {
  return namesSourceFile(String(text || "").toLowerCase()) || hasCodeObjectIntent(text);
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
