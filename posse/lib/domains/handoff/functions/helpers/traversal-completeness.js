// Traversal completion directive helpers for research/dev handoffs.

import crypto from "node:crypto";
import { AGENT_HANDOFF_LIMITS } from "../../../../catalog/handoff.js";

export const DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS = 1600;
export const MIN_TRAVERSAL_COMPLETION_MAX_CHARS = 180;

export const TRAVERSAL_COMPLETION_LANES = Object.freeze([
  Object.freeze({
    id: "default_precedence",
    terms: Object.freeze(["default", "precedence", "order", "ordering", "override", "winning", "first", "last"]),
    minimum: 2,
    requiredAny: Object.freeze(["default", "precedence", "ordering", "override", "winning"]),
  }),
  Object.freeze({
    id: "ordered_control_flow",
    terms: Object.freeze(["trace", "flow", "through", "dispatch", "validation", "invoke", "error", "return"]),
    minimum: 2,
    requiredAny: Object.freeze(["trace", "through", "dispatch", "validation", "invoke"]),
  }),
  Object.freeze({
    id: "registry_dispatch",
    terms: Object.freeze(["registry", "registration", "descriptor", "route", "alias", "dispatch"]),
    minimum: 2,
    requiredAny: Object.freeze(["registry", "registration", "descriptor", "route"]),
  }),
  Object.freeze({
    id: "lifecycle_resource",
    terms: Object.freeze(["lifecycle", "generation", "completion", "save", "reconcile", "fallback", "resource", "cleanup"]),
    minimum: 2,
    requiredAny: Object.freeze(["lifecycle", "generation", "completion", "save", "reconcile", "resource", "cleanup"]),
  }),
]);

export const TRAVERSAL_COMPLETION_TRIGGER_TERMS = Object.freeze([
  ...new Set(TRAVERSAL_COMPLETION_LANES.flatMap((lane) => lane.terms)),
]);

const TRAVERSAL_COMPLETION_MODE_VALUES = new Set(["off", "shadow", "on"]);
const TRAVERSAL_COMPLETION_RECIPIENTS = new Set(["researcher"]);
const TRAVERSAL_COMPLETION_JOB_TYPES = new Set(["research"]);

const TRAVERSAL_COMPLETION_DIRECTIVE_HEADING = "Task-derived completion ledger:";

// Coverage IDs are not report claims: multiple atomic requirements may point
// to the same evidence-backed claim. Do not collapse an explicit focus list to
// the report's smaller narrative claim allowance.
const TRAVERSAL_COMPLETION_REQUIREMENT_LIMIT = AGENT_HANDOFF_LIMITS.maxCompletionRequirements;
const TRAVERSAL_COMPLETION_SOURCE_CLAUSE_LIMIT = TRAVERSAL_COMPLETION_REQUIREMENT_LIMIT * 2;
const TRAVERSAL_COMPLETION_REQUIREMENT_MAX_CHARS = 480;
const TRAVERSAL_COMPLETION_LEDGER_HEADING = "Terminal coverage ledger (report each ID exactly once as supported or unresolved):";
const FAILURE_ACCOUNTING_ACTION_RE = /\b(?:separate|distinguish|trace|explain|cover|identify|report|describe|document)\w*\b/iu;
const FAILURE_ACCOUNTING_TERM_PATTERNS = Object.freeze([
  /\b(?:errors?|failures?)\b/iu,
  /\brejections?\b/iu,
  /\brecover(?:y|ies|able|ed|ing)?\b/iu,
  /\bretr(?:y|ies|ied|ying)\b/iu,
  /\bfallbacks?\b|\bfall(?:s|ing)? back\b/iu,
  /\bshort[- ]circuit(?:s|ed|ing)?\b/iu,
  /\bterminal(?:ly)?\b/iu,
]);

function traversalRequirementFacets(text) {
  const clause = String(text || "");
  const requestedTerms = FAILURE_ACCOUNTING_TERM_PATTERNS
    .filter((pattern) => pattern.test(clause))
    .length;
  return !/^Required adversarial trace:/iu.test(clause)
    && FAILURE_ACCOUNTING_ACTION_RE.test(clause)
    && requestedTerms >= 2
    ? ["failure_mechanisms"]
    : [];
}

function explicitTraversalRequirementText(packet = {}) {
  const payload = packet?._raw_payload && typeof packet._raw_payload === "object"
    ? packet._raw_payload
    : {};
  return [
    payload.task_spec,
    payload.instructions,
    payload.fix_instructions,
    payload.description,
    payload.request,
    payload.question,
    payload.prompt,
    ...(!payload.task_spec ? [packet.project_context, payload.project_context] : []),
    ...(Array.isArray(packet.success_criteria) ? packet.success_criteria : []),
    ...(Array.isArray(payload.success_criteria) ? payload.success_criteria : []),
  ].filter((value) => typeof value === "string" && value.trim());
}

function normalizedRequirementClause(value) {
  return String(value || "")
    .replace(/^\s*(?:[-*+]\s+|\(\d+\)\s+|\d+[.)]\s+)/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, TRAVERSAL_COMPLETION_REQUIREMENT_MAX_CHARS);
}

function atomicSlashFocusClauses(value) {
  const focus = String(value || "").trim();
  const match = /^(?<items>[a-z0-9_-]+(?:\/[a-z0-9_-]+){1,})(?<suffix>\s+(?:layers?|versions?|variants?|entries|exports?))$/iu.exec(focus);
  if (!match?.groups?.items) return [focus];
  const suffix = String(match.groups.suffix || "");
  return match.groups.items.split("/").map((item) => `${item}${suffix}`);
}

function atomicNamedFocusClauses(value) {
  const clause = String(value || "").trim();
  const match = clause.match(/^(?<lead>.+?)\bacross\s+(?<inventory>.+?)[.!?]?$/iu);
  if (!match?.groups) return [clause];
  const focuses = match.groups.inventory
    .replace(/[.!?]+$/u, "")
    .split(/\s*,\s*/u)
    .map((entry) => entry.replace(/^(?:and|or)\s+/iu, "").trim())
    .filter(Boolean)
    .flatMap(atomicSlashFocusClauses);
  if (focuses.length < 3) return [clause];
  // Preserve the author's clause verbatim and add only author-named substrings
  // as focus identities. Do not manufacture a benchmark-shaped restatement.
  return {
    core: clause,
    focuses,
  };
}

const STATE_OBLIGATION_ACTION_RE = /^(?<action>enumerate|separate|identify|trace|explain|describe|document)\w*\s+(?<inventory>.+?)(?<punctuation>[;.!?]?)$/iu;
const STATE_OBLIGATION_TERM_RE = /\b(?:state|mutat\w*|precedence|cache\w*|ownership|transfer\w*|shar\w*|invalidat\w*|cleanup|lifecycle|queues?|timers?|reentran\w*)\b/iu;

// A compound state deliverable is not one evidence state. If the task author
// explicitly enumerates three or more state/lifecycle concerns, give each
// concern its own terminal identity so proving (for example) mutation cannot
// silently close an unresearched cache or cleanup obligation. Keep this
// syntax-led and task-derived: no repository or benchmark vocabulary belongs
// here.
function atomicStateObligationClauses(value) {
  const clause = String(value || "").trim();
  const match = STATE_OBLIGATION_ACTION_RE.exec(clause);
  if (!match?.groups?.inventory) return [clause];
  const focuses = match.groups.inventory
    .replace(/[;.!?]+$/u, "")
    .split(/\s*,\s*|\s+(?:and|or)\s+/iu)
    .map((entry) => entry.replace(/^(?:and|or)\s+/iu, "").trim())
    .filter(Boolean);
  if (focuses.length < 3 || focuses.filter((focus) => STATE_OBLIGATION_TERM_RE.test(focus)).length < 3) {
    return [clause];
  }
  const punctuation = match.groups.punctuation || "";
  return focuses.map((focus) => `${match.groups.action} ${focus}${punctuation}`);
}

function isProceduralTraversalConstraint(value) {
  const clause = String(value || "").replace(/[.;:]$/u, "").trim();
  return /^read[- ]only(?:,\s*do not (?:modify|edit|change)(?: the)? files?(?: or execute tests)?)?$/iu.test(clause)
    || /^do not (?:modify|edit|change)(?: the)? files?(?: or execute tests)?$/iu.test(clause)
    || /^do not (?:execute|run) tests?$/iu.test(clause)
    || /^test execution (?:belongs|is assigned) to another agent\b.*\boutside\b.*\bresearch\b/iu.test(clause)
    || /^test execution is outside (?:this|the) research(?: comparison)?$/iu.test(clause)
    || /^use implementation source and inspect focused\b.*\bonly where\b/iu.test(clause)
    || /^use implementation source\b.*\b(?:read[- ]only|do not modify files|do not execute tests)\b/iu.test(clause);
}

export function buildTraversalCompletionRequirements(packet = {}) {
  const seen = new Set();
  const clauses = [];
  for (const source of explicitTraversalRequirementText(packet)) {
    const candidates = source
      // Numbered deliverables are semantic boundaries even when the author
      // omitted a newline after the heading or used semicolons between them.
      .replace(/\bDeliverables:\s*/giu, "\n")
      .replace(/\s+(?=\(\d+\)\s+)/gu, "\n")
      .split(/(?:\r?\n)+|(?<=[.!?;])\s+/u)
      .map(normalizedRequirementClause)
      .filter((clause) => clause.length >= 8 && !isProceduralTraversalConstraint(clause));
    for (const clause of candidates) {
      const key = clause.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clauses.push(clause);
      if (clauses.length >= TRAVERSAL_COMPLETION_SOURCE_CLAUSE_LIMIT) break;
    }
    if (clauses.length >= TRAVERSAL_COMPLETION_SOURCE_CLAUSE_LIMIT) break;
  }
  if (clauses.length === 0 && typeof packet.title === "string" && packet.title.trim()) {
    clauses.push(normalizedRequirementClause(packet.title));
  }
  const atomicFocuses = [];
  const coreClauses = clauses.flatMap((clause) => {
    const atomized = atomicNamedFocusClauses(clause);
    if (Array.isArray(atomized)) return atomized.flatMap(atomicStateObligationClauses);
    atomicFocuses.push(...atomized.focuses);
    return [atomized.core];
  });
  const atomized = [...coreClauses, ...atomicFocuses];
  // If atomization would crowd out later explicit clauses, retain the author's
  // compound wording instead. Late deliverables are more valuable than a
  // partial focus inventory.
  const boundedClauses = (atomized.length <= TRAVERSAL_COMPLETION_REQUIREMENT_LIMIT
    ? atomized
    : clauses).slice(0, TRAVERSAL_COMPLETION_REQUIREMENT_LIMIT);
  return boundedClauses.map((text, index) => {
    const facets = traversalRequirementFacets(text);
    return {
      id: `R${String(index + 1).padStart(2, "0")}`,
      text,
      digest: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
      ...(facets.length > 0 ? { facets } : {}),
    };
  });
}

export function normalizeTraversalCompletionMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TRAVERSAL_COMPLETION_MODE_VALUES.has(normalized) ? normalized : "off";
}

export function normalizeTraversalCompletionMaxChars(value, fallback = DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function collectTraversalCompletionTaskText(packet = {}) {
  const payload = packet?._raw_payload && typeof packet._raw_payload === "object" ? packet._raw_payload : {};
  const parts = [];
  const push = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (typeof value === "object") return;
    const text = String(value).trim();
    if (text) parts.push(text);
  };

  push(packet.title);
  push(packet.job_type);
  push(packet.recipient);
  push(payload.title);
  push(payload.task_spec);
  push(payload.instructions);
  push(payload.fix_instructions);
  push(payload.description);
  push(payload.request);
  push(payload.question);
  push(payload.prompt);
  push(packet.project_context);
  push(packet.instructions);
  push(packet.success_criteria);
  push(payload.success_criteria);

  return parts.join("\n");
}

export function classifyTraversalCompletionTask(packet = {}) {
  const recipient = String(packet?.recipient || "").trim().toLowerCase();
  const jobType = String(packet?.job_type || "").trim().toLowerCase();
  const roleEligible = TRAVERSAL_COMPLETION_RECIPIENTS.has(recipient)
    || TRAVERSAL_COMPLETION_JOB_TYPES.has(jobType);

  if (!roleEligible) {
    return { triggered: false, matchedTerms: [], matchedLanes: [], taskTextChars: 0 };
  }

  const text = collectTraversalCompletionTaskText(packet);
  const lower = text.toLowerCase();
  const termPresent = (term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  };
  const matchedLanes = [];
  const matchedTerms = new Set();
  for (const lane of TRAVERSAL_COMPLETION_LANES) {
    const terms = lane.terms.filter(termPresent);
    if (terms.length < lane.minimum) continue;
    if (lane.requiredAny && !lane.requiredAny.some((term) => terms.includes(term))) continue;
    matchedLanes.push(lane.id);
    for (const term of terms) matchedTerms.add(term);
  }

  return {
    triggered: matchedLanes.length > 0,
    matchedTerms: [...matchedTerms],
    matchedLanes,
    taskTextChars: text.length,
  };
}

export function renderTraversalCompletionDirective({
  maxChars = DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS,
  requirements = [],
} = {}) {
  const cap = normalizeTraversalCompletionMaxChars(maxChars);
  const heading = TRAVERSAL_COMPLETION_DIRECTIVE_HEADING;
  const idOnlyLedger = requirements.map((entry) => `- ${entry.id}:`);
  const fixedDirectiveChars = [
    heading,
    TRAVERSAL_COMPLETION_LEDGER_HEADING,
    ...idOnlyLedger,
  ].filter((part) => part !== "").join("\n").length;
  // Reserve enough room to keep every task-authored ID visible, then expand
  // the copied requirement excerpts within the configured bound.
  const initialExcerptChars = requirements.length > 0
    ? Math.max(0, Math.min(20, Math.floor(
        (cap - fixedDirectiveChars - requirements.length - 4) / requirements.length,
      )))
    : 0;
  const excerptLengths = requirements.map((entry) => Math.min(initialExcerptChars, entry.text.length));
  const requirementTextFor = () => requirements.length > 0
    ? [TRAVERSAL_COMPLETION_LEDGER_HEADING, ...requirements.map((entry, index) => (
        excerptLengths[index] > 0
          ? `- ${entry.id}: ${entry.text.slice(0, excerptLengths[index])}`
          : `- ${entry.id}:`
      ))].join("\n")
    : "";
  const render = () => [heading, requirementTextFor()]
    .filter((part) => part !== "")
    .join("\n");
  // Short standalone requirements are usually task-authored focus leaves.
  // Finish those labels before widening generic task/deliverable clauses so
  // the bounded ledger preserves the most discriminating ID bindings.
  let remaining = Math.max(0, cap - render().length);
  const excerptPriority = requirements
    .map((entry, index) => ({ index, length: entry.text.length }))
    .sort((left, right) => left.length - right.length || left.index - right.index)
    .map((entry) => entry.index);
  for (const index of excerptPriority) {
    if (remaining <= 0) break;
    const available = requirements[index].text.length - excerptLengths[index];
    const added = Math.min(available, remaining);
    excerptLengths[index] += added;
    remaining -= added;
  }
  const text = render();
  if (text.length <= cap) return text;
  if (cap <= 3) return text.slice(0, cap);
  return `${text.slice(0, cap - 3)}...`;
}

function traversalCompletionMinimumChars(requirements = []) {
  if (requirements.length === 0) return MIN_TRAVERSAL_COMPLETION_MAX_CHARS;
  const heading = TRAVERSAL_COMPLETION_DIRECTIVE_HEADING;
  const ledgerChars = [
    heading,
    TRAVERSAL_COMPLETION_LEDGER_HEADING,
    ...requirements.map((entry) => `- ${entry.id}:`),
  ].join("\n").length;
  // renderTraversalCompletionDirective reserves the final three characters
  // for its truncation marker. Never attach a directive that would truncate
  // an authoritative requirement ID.
  return Math.max(MIN_TRAVERSAL_COMPLETION_MAX_CHARS, ledgerChars + 3);
}

export function buildTraversalCompletionCheck(packet = {}, opts = {}) {
  const mode = normalizeTraversalCompletionMode(opts.mode);
  const maxChars = normalizeTraversalCompletionMaxChars(opts.maxChars);
  const classification = classifyTraversalCompletionTask(packet);
  const requirements = classification.triggered
    ? buildTraversalCompletionRequirements(packet)
    : [];
  const minimumChars = traversalCompletionMinimumChars(requirements);
  const misconfigured = classification.triggered
    && mode !== "off"
    && maxChars < minimumChars;
  const text = classification.triggered && mode !== "off" && !misconfigured
    ? renderTraversalCompletionDirective({ maxChars, requirements })
    : "";

  return {
    mode,
    triggered: classification.triggered,
    matched_terms: classification.matchedTerms,
    matched_lanes: classification.matchedLanes,
    requirements,
    requirements_digest: requirements.length > 0
      ? crypto.createHash("sha256").update(JSON.stringify(requirements), "utf8").digest("hex")
      : null,
    task_text_chars: classification.taskTextChars,
    max_chars: maxChars,
    minimum_chars: minimumChars,
    rendered_chars: text.length,
    text,
    misconfigured,
    attach: mode === "on" && classification.triggered && !misconfigured,
    shadow: mode === "shadow" && classification.triggered && !misconfigured,
  };
}
