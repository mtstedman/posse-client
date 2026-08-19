// Generic lifecycle-oriented survey expansion policy. This module only plans
// bounded exact-body fetches from the assignment and a code.survey result; it
// does not know benchmark cells, answer keys, or expected verdicts.

const FAMILY_ALIASES = Object.freeze({
  abort: ["abort", "cancel"],
  callback: ["callback"],
  cleanup: ["cleanup", "close", "dispose", "finalize", "teardown"],
  dispatch: ["dispatch"],
  error: ["error", "fail", "reject"],
  handler: ["handle", "handler"],
  hijack: ["hijack"],
  hook: ["hook"],
  lifecycle: ["lifecycle"],
  middleware: ["middleware"],
  phase: ["phase", "stage"],
  registration: ["register", "registration"],
  response: ["reply", "respond", "response", "send"],
  route: ["route", "router", "routing"],
  serialization: ["serialize", "serialization"],
  validation: ["validate", "validation"],
});

const ALIAS_TO_FAMILY = new Map(
  Object.entries(FAMILY_ALIASES)
    .flatMap(([family, aliases]) => aliases.map((alias) => [alias, family])),
);

const NON_PRODUCTION_PATH_RE = /(?:^|\/)(?:benchmarks?|docs?|examples?|fixtures?|test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^.\/]+$/i;
const ELIGIBLE_SYMBOL_KIND_RE = /^(?:class|constructor|field|function|method|property|variable)$/i;
const MAX_TARGETS_PER_FILE = 2;

function splitTerms(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9_]*/g) || [];
}

function normalizedPhrase(value) {
  return splitTerms(value).join(" ");
}

function familiesFor(value) {
  const families = new Set();
  for (const term of splitTerms(value)) {
    for (const [alias, family] of ALIAS_TO_FAMILY) {
      if (
        term === alias
        || term === `${alias}s`
        || term === `${alias}es`
        || term === `${alias}ed`
        || term === `${alias}ing`
        || (alias.length >= 5 && term.startsWith(alias))
      ) families.add(family);
    }
  }
  return families;
}

function symbolIdentity(symbol) {
  return String(symbol?.qualifiedName || symbol?.qualified_name || symbol?.name || "").trim();
}

/**
 * Select task-matched lifecycle/hook bodies from a code.survey result.
 * Returns an inactive plan for ordinary questions or when no surveyed symbol
 * has a concrete lexical/family relationship to the assignment.
 */
export function planLifecycleSurveyExpansion(taskText, files, { maxBodies = 3 } = {}) {
  const taskFamilies = familiesFor(taskText);
  const boundedMax = Math.max(0, Math.min(4, Math.floor(Number(maxBodies) || 0)));
  if (taskFamilies.size === 0 || boundedMax === 0) {
    return { active: false, reason: "no_lifecycle_intent", targets: [] };
  }

  const taskTerms = new Set(splitTerms(taskText));
  const taskPhrase = ` ${normalizedPhrase(taskText)} `;
  const candidates = [];
  let order = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file?.path || "").trim().replace(/\\/g, "/");
    if (!filePath || NON_PRODUCTION_PATH_RE.test(filePath)) continue;
    for (const symbol of Array.isArray(file?.symbols) ? file.symbols : []) {
      const name = symbolIdentity(symbol);
      const kind = String(symbol?.kind || "").trim();
      if (!name || (kind && !ELIGIBLE_SYMBOL_KIND_RE.test(kind))) continue;
      const symbolTerms = splitTerms(name);
      const symbolFamilies = familiesFor(name);
      const sharedFamilies = [...symbolFamilies].filter((family) => taskFamilies.has(family));
      const sharedTerms = symbolTerms.filter((term) => term.length >= 4 && taskTerms.has(term));
      const exactPhrase = normalizedPhrase(name);
      const explicitlyNamed = exactPhrase.length >= 4 && taskPhrase.includes(` ${exactPhrase} `);
      if (!explicitlyNamed && sharedFamilies.length === 0) continue;

      candidates.push({
        file: filePath,
        symbol: name,
        identifier: String(symbol?.name || name).trim(),
        kind: kind || null,
        families: sharedFamilies,
        score: (explicitlyNamed ? 100 : 0) + (sharedFamilies.length * 30) + (sharedTerms.length * 10),
        order: order++,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order || a.file.localeCompare(b.file));
  const perFile = new Map();
  const seen = new Set();
  const targets = [];
  for (const candidate of candidates) {
    const key = `${candidate.file.toLowerCase()}\0${candidate.symbol.toLowerCase()}`;
    const count = perFile.get(candidate.file.toLowerCase()) || 0;
    if (seen.has(key) || count >= MAX_TARGETS_PER_FILE) continue;
    seen.add(key);
    perFile.set(candidate.file.toLowerCase(), count + 1);
    targets.push(candidate);
    if (targets.length >= boundedMax) break;
  }

  return {
    active: targets.length > 0,
    reason: targets.length > 0 ? "task_matched_lifecycle_symbols" : "no_matching_survey_symbols",
    taskFamilies: [...taskFamilies].sort(),
    targets,
  };
}
