// Generic lifecycle-oriented survey expansion policy. This module only plans
// bounded exact-body fetches from the assignment and a code.survey result; it
// does not know benchmark cells, answer keys, or expected verdicts.

import { normalizeAtlasIdentifier } from "../../../atlas/functions/v2/contracts/identifiers.js";

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
  parsing: ["parse", "parser", "parsing", "tokenize"],
  phase: ["phase", "stage"],
  progress: ["advance", "progress"],
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
const EXECUTABLE_SYMBOL_KIND_RE = /^(?:constructor|function|method)$/i;
const CLASS_SYMBOL_KIND_RE = /^class$/i;
const MAX_TARGETS_PER_FILE = 2;
const MAX_ESTIMATED_BODY_LINES = 160;
const FOCUS_STOP_TERMS = new Set([
  "across", "applicable", "aspect", "boundaries", "branch", "branches", "code",
  "deliverable", "deliverables", "describe", "explain", "file", "identify", "internal",
  "ordered", "public", "read", "reconstruct", "repository", "state", "trace", "where",
]);

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

function symbolLine(symbol, ...keys) {
  for (const key of keys) {
    const value = Number(symbol?.[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function matchTaskFocus(value, { taskFamilies, taskTerms, taskPhrase }) {
  const phrase = normalizedPhrase(value);
  const valueFamilies = familiesFor(value);
  const sharedFamilies = [...valueFamilies].filter((family) => taskFamilies.has(family));
  const sharedTerms = [...new Set(splitTerms(value)
    .filter((term) => term.length >= 4 && !FOCUS_STOP_TERMS.has(term) && taskTerms.has(term)))];
  const explicitlyNamed = phrase.length >= 4 && taskPhrase.includes(` ${phrase} `);
  return { phrase, sharedFamilies, sharedTerms, explicitlyNamed };
}

function reportedSymbolSpan(symbol) {
  const startLine = symbolLine(symbol, "line", "startLine", "start_line");
  const explicitEnd = symbolLine(symbol, "endLine", "end_line");
  if (startLine && explicitEnd && explicitEnd >= startLine) {
    return { startLine, endLine: explicitEnd, estimatedLines: explicitEnd - startLine + 1 };
  }
  // File-mode code.survey rows are capped and graph-ranked, not a complete
  // lexical inventory. The next returned row therefore cannot prove where
  // this executable ends. A symbol-level follow-up supplies the opaque ID used
  // for an exact AST-bounded code.window.
  return { startLine, endLine: null, estimatedLines: null };
}

function focusLanesFor({ direct, anchor, fileFocus }) {
  const lanes = [];
  if (anchor?.explicitlyNamed) lanes.push(`anchor:${anchor.phrase}`);
  for (const family of anchor?.sharedFamilies || []) lanes.push(`family:${family}`);
  for (const term of anchor?.sharedTerms || []) lanes.push(`term:${term}`);
  if (direct.explicitlyNamed) lanes.push(`symbol:${direct.phrase}`);
  for (const family of direct.sharedFamilies) lanes.push(`family:${family}`);
  for (const term of direct.sharedTerms) lanes.push(`term:${term}`);
  for (const family of fileFocus.sharedFamilies) lanes.push(`family:${family}`);
  for (const term of fileFocus.sharedTerms) lanes.push(`term:${term}`);
  return [...new Set(lanes)];
}

function classAnchorForSymbol(symbol, identity, classSymbols, classAnchors) {
  if (classAnchors.length === 0) return null;
  const normalizedIdentity = normalizedPhrase(identity);
  const symbolStart = symbolLine(symbol, "line", "startLine", "start_line");
  for (const anchor of classAnchors) {
    if (normalizedIdentity.startsWith(`${anchor.phrase} `)) return anchor;
    const anchorStart = symbolLine(anchor.symbol, "line", "startLine", "start_line");
    const anchorEnd = symbolLine(anchor.symbol, "endLine", "end_line");
    if (symbolStart && anchorStart && anchorEnd && symbolStart >= anchorStart && symbolStart <= anchorEnd) return anchor;
  }
  return classSymbols.length === 1 ? classAnchors[0] : null;
}

export function resolveLifecycleSurveyTargetSymbolIds(targets, files) {
  const filesByPath = new Map((Array.isArray(files) ? files : []).map((file) => [
    String(file?.path || "").replace(/\\/g, "/").toLowerCase(),
    file,
  ]));
  return (Array.isArray(targets) ? targets : []).map((target) => {
    const file = filesByPath.get(String(target?.file || "").replace(/\\/g, "/").toLowerCase());
    const surveyName = String(target?.surveyName || target?.symbol || "").trim().toLowerCase();
    const candidates = (Array.isArray(file?.symbols) ? file.symbols : []).filter((symbol) => (
      String(symbol?.name || "").trim().toLowerCase() === surveyName
      && String(symbol?.symbolId || symbol?.symbol_id || "").trim()
    ));
    const completeSelectorEligible = file
      ? file?.truncated !== true && candidates.length === 1
      : target?.completeSelectorEligible === true;
    if (target?.symbolId) return { ...target, completeSelectorEligible };
    const exactLine = Number(target?.startLine) > 0
      ? candidates.find((symbol) => Number(symbol?.line ?? symbol?.startLine ?? symbol?.start_line) === Number(target.startLine))
      : null;
    const resolved = exactLine || (candidates.length === 1 ? candidates[0] : null);
    const symbolId = String(resolved?.symbolId || resolved?.symbol_id || "").trim();
    return symbolId
      ? { ...target, symbolId, completeSelectorEligible }
      : { ...target, completeSelectorEligible: false };
  });
}

/**
 * Select task-matched lifecycle/hook bodies from a code.survey result.
 * Returns an inactive plan for ordinary questions or when no surveyed symbol
 * has a concrete lexical/family relationship to the assignment.
 */
export function planLifecycleSurveyExpansion(taskText, files, {
  maxBodies = 3,
  focusAdmission = null,
} = {}) {
  const taskFamilies = familiesFor(taskText);
  const boundedMax = Math.max(0, Math.min(4, Math.floor(Number(maxBodies) || 0)));
  if (taskFamilies.size === 0 || boundedMax === 0) {
    return { active: false, reason: "no_lifecycle_intent", targets: [] };
  }

  const taskTerms = new Set(splitTerms(taskText));
  const taskPhrase = ` ${normalizedPhrase(taskText)} `;
  const focusedIdentifiers = new Set((Array.isArray(focusAdmission?.explicitIdentifiers)
    ? focusAdmission.explicitIdentifiers
    : []).map(normalizedPhrase).filter(Boolean));
  const focusedPaths = new Set((Array.isArray(focusAdmission?.explicitPaths)
    ? focusAdmission.explicitPaths
    : []).map((value) => String(value || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean));
  const candidates = [];
  let focusGateRejected = 0;
  let order = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file?.path || "").trim().replace(/\\/g, "/");
    if (!filePath || NON_PRODUCTION_PATH_RE.test(filePath)) continue;
    const symbols = Array.isArray(file?.symbols) ? file.symbols : [];
    const focusContext = { taskFamilies, taskTerms, taskPhrase };
    const fileFocus = matchTaskFocus(filePath, focusContext);
    const classSymbols = symbols
      .filter((symbol) => CLASS_SYMBOL_KIND_RE.test(String(symbol?.kind || "").trim()));
    const classAnchors = classSymbols
      .map((symbol) => ({ symbol, ...matchTaskFocus(symbolIdentity(symbol), focusContext) }))
      // A generic shared class suffix (Service, Handler, Manager) is not
      // enough to establish ownership. File focus can still rank that area,
      // while class anchoring requires an exact name or semantic family.
      .filter((anchor) => anchor.explicitlyNamed || anchor.sharedFamilies.length > 0)
      .sort((a, b) => (
        Number(b.explicitlyNamed) - Number(a.explicitlyNamed)
        || b.sharedFamilies.length - a.sharedFamilies.length
        || b.sharedTerms.length - a.sharedTerms.length
      ));
    for (const symbol of symbols) {
      const name = symbolIdentity(symbol);
      const kind = String(symbol?.kind || "").trim();
      if (!name || !EXECUTABLE_SYMBOL_KIND_RE.test(kind)) continue;
      const identifier = normalizeAtlasIdentifier(symbol?.name || name);
      if (!identifier) continue;
      const anchor = classAnchorForSymbol(symbol, name, classSymbols, classAnchors);
      // Match the executable's own name here. Qualified owner names are used
      // above for class association; counting them again as a direct method
      // match can project one named class onto a sibling class in the file.
      const direct = matchTaskFocus(symbol?.name || name, focusContext);
      const hasFileFocus = fileFocus.sharedFamilies.length > 0 || fileFocus.sharedTerms.length > 0;
      // A matching filename can orient free functions, but it cannot establish
      // which class owns an unqualified method in a multi-class survey. Class
      // members must match directly or belong to a verified named anchor.
      const fileFocusEligible = hasFileFocus && classSymbols.length === 0;
      if (!direct.explicitlyNamed && direct.sharedFamilies.length === 0 && direct.sharedTerms.length === 0 && !anchor && !fileFocusEligible) continue;
      if (focusAdmission?.enabled === true) {
        const explicitlyAnchored = focusedIdentifiers.has(direct.phrase)
          || (anchor?.phrase ? focusedIdentifiers.has(anchor.phrase) : false)
          || focusedPaths.has(filePath.toLowerCase());
        const convergedTerms = new Set([
          ...direct.sharedTerms,
          ...(anchor?.sharedTerms || []),
          ...fileFocus.sharedTerms,
        ]);
        const confidenceAllows = String(focusAdmission.treeConfidence || "").toLowerCase() === "high"
          && String(focusAdmission.scopeRisk || "").toLowerCase() !== "high"
          && convergedTerms.size >= 2;
        if (!explicitlyAnchored && !confidenceAllows) {
          focusGateRejected += 1;
          continue;
        }
      }
      const span = reportedSymbolSpan(symbol);
      if (span.estimatedLines != null && span.estimatedLines > MAX_ESTIMATED_BODY_LINES) continue;
      const focuses = focusLanesFor({ direct, anchor, fileFocus });
      if (focuses.length === 0) continue;
      const anchorScore = anchor
        ? Math.min(70, (anchor.explicitlyNamed ? 100 : 0) + (anchor.sharedFamilies.length * 30) + (anchor.sharedTerms.length * 10))
        : 0;
      const directScore = (direct.explicitlyNamed ? 100 : 0)
        + (direct.sharedFamilies.length * 30)
        + (direct.sharedTerms.length * 10);
      const fileScore = (fileFocus.sharedFamilies.length * 10) + (fileFocus.sharedTerms.length * 5);
      // Unknown spans are risky under a hard body budget: without a following
      // or explicit end line, code.window falls back to a broad 120-line
      // envelope. Keep them eligible when they are the only strong match, but
      // prefer a bounded concrete member whenever one exists.
      const spanPenalty = span.estimatedLines == null ? 20 : Math.ceil(span.estimatedLines / 3);

      candidates.push({
        file: filePath,
        symbol: name,
        surveyName: String(symbol?.name || name).trim(),
        identifier,
        symbolId: symbol?.symbolId || symbol?.symbol_id || null,
        kind,
        families: direct.sharedFamilies,
        focuses,
        primaryFocus: focuses[0],
        reason: direct.explicitlyNamed || direct.sharedFamilies.length > 0 || direct.sharedTerms.length > 0
          ? "direct_executable_match"
          : anchor
            ? "named_class_anchor_member"
            : "named_file_focus_member",
        score: directScore + anchorScore + fileScore - spanPenalty,
        ...span,
        order: order++,
      });
    }
  }

  candidates.sort((a, b) => (
    b.score - a.score
    || (a.estimatedLines ?? Number.MAX_SAFE_INTEGER) - (b.estimatedLines ?? Number.MAX_SAFE_INTEGER)
    || a.order - b.order
    || a.file.localeCompare(b.file)
  ));
  const perFile = new Map();
  const seen = new Set();
  const coveredFocuses = new Set();
  const targets = [];
  const select = (candidate) => {
    const key = `${candidate.file.toLowerCase()}\0${candidate.symbol.toLowerCase()}`;
    const count = perFile.get(candidate.file.toLowerCase()) || 0;
    if (seen.has(key) || count >= MAX_TARGETS_PER_FILE) return false;
    seen.add(key);
    perFile.set(candidate.file.toLowerCase(), count + 1);
    targets.push(candidate);
    for (const focus of candidate.focuses) coveredFocuses.add(focus);
    return true;
  };
  for (const candidate of candidates) {
    if (targets.length >= boundedMax) break;
    if (candidate.primaryFocus && coveredFocuses.has(candidate.primaryFocus)) continue;
    select(candidate);
  }
  for (const candidate of candidates) {
    if (targets.length >= boundedMax) break;
    select(candidate);
  }

  return {
    active: targets.length > 0,
    reason: targets.length > 0
      ? "task_matched_lifecycle_symbols"
      : focusGateRejected > 0
        ? "lifecycle_matches_below_focus_confidence"
        : "no_matching_survey_symbols",
    taskFamilies: [...taskFamilies].sort(),
    focusLanes: [...coveredFocuses],
    focusGateRejected,
    targets,
  };
}
