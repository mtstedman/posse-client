// Pure researcher-prefetch policy. Inputs are deliberately restricted to the
// task fields rendered to the researcher plus ATLAS tree metadata. Do not add
// grader output, reference answers, expected files, or benchmark-only hints.

const MAX_VISIBLE_TASK_CHARS = 2_000;
const MAX_FOCUS_TASK_CHARS = 1_200;
const MAX_FOCUS_CLAUSES = 5;

const GENERIC_FOCUS_TERMS = new Set([
  "accuracy", "analyze", "answer", "applicable", "behavior", "code", "complete",
  "correct", "describe", "detail", "determine", "explain", "file", "files",
  "find", "implementation", "improve", "include", "information", "identify",
  "investigate", "provide", "read", "relevant", "repository", "research",
  "result", "review", "source", "task", "trace", "understand", "where",
]);

const PATH_TOKEN_RE = /(?:^|[\s([{"'`])((?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,15})?)(?=$|[\s)\]},:;"'`]|:\d)/gu;
const BACKTICK_IDENTIFIER_RE = /`([A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)*)`/gu;
const STRUCTURED_IDENTIFIER_RE = /\b(?:[A-Za-z_$][\w$]*[.#:][A-Za-z_$][\w$]*|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*)\b/gu;

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function uniqueStrings(values, maxItems = 64) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function taskTerms(value) {
  return normalizeText(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9_]{2,}/g) || [];
}

function substantiveTerms(value) {
  return uniqueStrings(taskTerms(value).filter((term) => (
    term.length >= 4 && !GENERIC_FOCUS_TERMS.has(term)
  )));
}

function explicitPaths(value) {
  const out = [];
  const text = normalizeText(value);
  let match;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((match = PATH_TOKEN_RE.exec(text)) && out.length < 32) {
    const path = String(match[1] || "").replace(/\\/g, "/").replace(/[.,;:]+$/g, "");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

function explicitIdentifiers(value) {
  const text = normalizeText(value);
  const out = [];
  for (const pattern of [BACKTICK_IDENTIFIER_RE, STRUCTURED_IDENTIFIER_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) && out.length < 48) {
      const identifier = String(match[1] || match[0] || "").trim();
      if (identifier && !out.includes(identifier)) out.push(identifier);
    }
  }
  return out;
}

function visibleSegments(packet = {}) {
  const raw = packet?._raw_payload || {};
  return [
    { source: "task_spec", text: raw.task_spec, weight: 5 },
    { source: "title", text: packet?.title, weight: 4 },
    ...(Array.isArray(packet?.success_criteria) ? packet.success_criteria : [])
      .map((text) => ({ source: "success_criteria", text, weight: 3 })),
    { source: "project_context", text: packet?.project_context, weight: 2 },
  ].map((entry) => ({ ...entry, text: normalizeText(entry.text) }))
    .filter((entry) => entry.text);
}

function splitClauses(segment) {
  return normalizeText(segment?.text)
    .split(/\n+|(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z])/gu)
    .map((text) => normalizeText(text))
    .filter(Boolean)
    .map((text, index) => ({ source: segment.source, weight: segment.weight, text, index }));
}

function scoredClause(clause) {
  const paths = explicitPaths(clause.text);
  const identifiers = explicitIdentifiers(clause.text);
  const terms = substantiveTerms(clause.text);
  return {
    ...clause,
    score: clause.weight + (paths.length * 12) + (identifiers.length * 8) + Math.min(8, terms.length),
    signalCount: paths.length + identifiers.length + terms.length,
  };
}

function focusTextFor(segments) {
  const clauses = segments.flatMap(splitClauses).map(scoredClause);
  const selected = clauses
    .filter((clause) => clause.signalCount > 0)
    .sort((a, b) => b.score - a.score || b.weight - a.weight || a.index - b.index)
    .slice(0, MAX_FOCUS_CLAUSES);
  const fallback = selected.length > 0 ? selected : clauses.slice(0, 1);
  return fallback
    .sort((a, b) => segments.findIndex((entry) => entry.source === a.source)
      - segments.findIndex((entry) => entry.source === b.source) || a.index - b.index)
    .map((clause) => clause.text)
    .join("\n")
    .slice(0, MAX_FOCUS_TASK_CHARS);
}

export function buildResearcherVisibleTaskProjection(packet = {}) {
  const segments = visibleSegments(packet);
  const visibleText = uniqueStrings(segments.map((entry) => entry.text))
    .join("\n\n")
    .slice(0, MAX_VISIBLE_TASK_CHARS);
  const focusText = focusTextFor(segments) || visibleText.slice(0, MAX_FOCUS_TASK_CHARS);
  const paths = explicitPaths(visibleText);
  const identifiers = explicitIdentifiers(visibleText);
  const terms = substantiveTerms(focusText);
  const confidence = paths.length > 0 || identifiers.length > 0
    ? "high"
    : terms.length >= 3
      ? "medium"
      : "low";
  return {
    visibleText,
    focusText,
    confidence,
    explicitPaths: paths,
    explicitIdentifiers: identifiers,
    substantiveTerms: terms,
    sources: uniqueStrings(segments.map((entry) => entry.source)),
  };
}

export function normalizeResearchPrefetchFocusMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["off", "shadow", "on"].includes(mode) ? mode : "on";
}

export function chooseResearcherPrefetchLane({ focus = {}, treeScope = null, contextAllowed = false } = {}) {
  const candidateCount = Array.isArray(treeScope?.candidateFiles)
    ? treeScope.candidateFiles.length
    : Number(treeScope?.candidateFileCount || 0);
  const surveyAvailable = treeScope?.ok === true && candidateCount > 0;
  const treeConfidence = String(treeScope?.confidence || "").trim().toLowerCase();
  const scopeRisk = String(treeScope?.scopeRisk || "").trim().toLowerCase();
  const explicitAnchor = (Array.isArray(focus?.explicitPaths) && focus.explicitPaths.length > 0)
    || (Array.isArray(focus?.explicitIdentifiers) && focus.explicitIdentifiers.length > 0);
  const reliableTree = ["medium", "high"].includes(treeConfidence) && scopeRisk !== "high";

  if (surveyAvailable && (explicitAnchor || reliableTree)) {
    return { lane: "survey", reason: explicitAnchor ? "visible_explicit_anchor" : "reliable_tree_scope" };
  }
  if (contextAllowed) {
    return {
      lane: "context",
      reason: surveyAvailable ? "tree_scope_low_confidence" : "survey_unavailable",
    };
  }
  if (surveyAvailable) return { lane: "survey", reason: "context_unavailable_fallback" };
  return { lane: "none", reason: "no_prefetch_lane_available" };
}
