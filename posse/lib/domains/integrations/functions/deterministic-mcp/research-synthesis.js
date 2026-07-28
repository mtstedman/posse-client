export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps;
// the curtain call reserves the final five calls for targeted closure.
const DEFAULT_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS = 30;
const configuredExplorationCeiling = Number(
  process.env.POSSE_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
);
export const RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS =
  Number.isSafeInteger(configuredExplorationCeiling)
    && configuredExplorationCeiling
      >= RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS
        + RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS
  ? configuredExplorationCeiling
  : DEFAULT_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS;
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 5;
const RESEARCH_COVERAGE_CHECKLIST_MAX_ITEMS = 20;
const RESEARCH_COVERAGE_CHECKLIST_ITEM_MAX_CHARS = 260;
const RESEARCH_COVERAGE_PRIORITY_MAX_ITEMS = 8;

const COVERAGE_GENERIC_IDENTIFIER_TOKENS = new Set([
  "build",
  "builder",
  "create",
  "fn",
  "function",
  "get",
  "impl",
  "load",
  "make",
  "method",
  "parse",
  "print",
  "pub",
  "read",
  "run",
  "set",
  "write",
]);

const COVERAGE_LABEL_STOP_TOKENS = new Set([
  "choice",
  "effect",
  "effects",
  "file",
  "files",
  "handler",
  "handlers",
  "status",
]);

const COVERAGE_TOKEN_ALIASES = new Map([
  ["arg", "argument"],
  ["args", "argument"],
  ["arguments", "argument"],
  ["async", "asynchronous"],
  ["exitcode", "exit"],
  ["globs", "glob"],
  ["matcher", "engine"],
  ["matching", "match"],
  ["overrides", "override"],
  ["pcre2", "engine"],
  ["pipes", "pipe"],
  ["printers", "printer"],
  ["regex", "engine"],
  ["sorted", "sort"],
  ["sorting", "sort"],
  ["statistics", "stat"],
  ["stats", "stat"],
  ["sync", "synchronous"],
  ["types", "type"],
]);

const NON_EXPLORATION_ATLAS_ACTIONS = new Set([
  "buffer.push",
  "create.ref",
  "fetch.ref",
  "file.write",
  "index.refresh",
  "policy.set",
  "runtime.execute",
  "scip.ingest",
]);

export function normalizeResearchAtlasAction(action) {
  return String(action || "")
    .replace(/^tools\./, "")
    .replace(/^atlas\./, "")
    .replace(/^atlas_/, "")
    .replace(/_/g, ".");
}

export function isResearchAtlasCitationFetchAction(action) {
  return normalizeResearchAtlasAction(action) === "fetch.ref";
}

export function isResearchAtlasExplorationAction(action) {
  const normalized = normalizeResearchAtlasAction(action);
  return !!normalized
    && !normalized.startsWith("memory.")
    && !NON_EXPLORATION_ATLAS_ACTIONS.has(normalized);
}

export function buildResearchCitationFetchGateText({ reason = "before_synthesis" } = {}) {
  if (reason === "budget_exhausted") {
    return [
      "CITATION FETCH BUDGET EXHAUSTED: the one synthesis-phase atlas.fetch_ref call has already been used.",
      "Do not fetch another ref or reopen discovery. Return the answer using the evidence already gathered.",
    ].join("\n");
  }
  return [
    "CITATION FETCH DEFERRED: atlas.fetch_ref is reserved for the synthesis phase.",
    "atlas.fetch_ref is not a research-budget workaround. After RESEARCH CLOSEOUT REQUIRED, the runtime may admit one exact retrieval of a ref surfaced before the curtain call, only when its stored payload is essential to a final claim. It does not reopen discovery or permit another producer-tool call.",
  ].join("\n");
}

function boundedCoverageItem(value) {
  const item = String(value || "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!item) return "";
  return item.length <= RESEARCH_COVERAGE_CHECKLIST_ITEM_MAX_CHARS
    ? item
    : `${item.slice(0, RESEARCH_COVERAGE_CHECKLIST_ITEM_MAX_CHARS - 3).trimEnd()}...`;
}

function isTestExecutionCriterion(value) {
  const item = String(value || "").toLowerCase();
  return /\b(?:run|runs|running|execute|executes|executing)\b.{0,50}\btests?\b/.test(item)
    || /\btests?\b.{0,50}\b(?:pass|passes|passing|green|succeed|succeeds)\b/.test(item);
}

function expandNamedFocusAreaItem(value) {
  const item = boundedCoverageItem(value);
  const match = /^(?:covers?|addresses?)\s+every\s+named\s+focus\s+areas?\s*:\s*(.+)$/i.exec(item);
  if (!match) return [item];
  const areas = match[1]
    .split(/\s*,\s*(?:and\s+)?|\s+\band\b\s+/i)
    .map((area) => boundedCoverageItem(area))
    .filter(Boolean);
  const expanded = areas.flatMap((area) => {
    const components = area
      .split(/\s*\/\s*/)
      .map((component) => boundedCoverageItem(component))
      .filter(Boolean);
    if (components.length <= 1) return [`Cover named focus area: ${area}`];
    return components.map(
      (component) => `Cover named focus area component: ${component} (from "${area}")`,
    );
  });
  return expanded.length > 1 ? expanded : [item];
}

function uniqueCoverageItems(items) {
  const seen = new Set();
  const result = [];
  for (const candidate of items) {
    for (const item of expandNamedFocusAreaItem(candidate)) {
      const key = item.toLowerCase();
      if (!item || seen.has(key) || isTestExecutionCriterion(item)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= RESEARCH_COVERAGE_CHECKLIST_MAX_ITEMS) return result;
    }
  }
  return result;
}

export function extractResearchCoverageChecklist(taskText = "") {
  const text = String(taskText || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];

  const assigned = /(?:^|\n)\s*Assigned goals:\s*\n([\s\S]*?)(?=\n\s*\n|$)/i.exec(text)?.[1] || "";
  const assignedItems = assigned
    .split("\n")
    .filter((line) => /^\s*[-*]\s+\S/.test(line));
  if (assignedItems.length > 0) return uniqueCoverageItems(assignedItems);

  const deliverables = /\bDeliverables:\s*([\s\S]*?)(?=\n\s*\n|$)/i.exec(text)?.[1] || "";
  if (!deliverables) return [];
  return uniqueCoverageItems(
    deliverables
      .split(/(?:^|[;])\s*(?=\(\d+\))/)
      .map((item) => item.replace(/^\(\d+\)\s*/, "")),
  );
}

function namedFocusAreaLabel(item) {
  const component = /^Cover named focus area component:\s*(.+?)\s+\(from\s+"/i.exec(item)?.[1];
  if (component) return component;
  return /^Cover named focus area:\s*(.+)$/i.exec(item)?.[1] || "";
}

function coverageTokens(value) {
  const splitCamelCase = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return splitCamelCase
    .split(/[^a-z0-9]+/)
    .map((token) => COVERAGE_TOKEN_ALIASES.get(token) || token)
    .filter(Boolean);
}

function coverageLabelTokens(label) {
  return coverageTokens(label)
    .filter((token) => !COVERAGE_LABEL_STOP_TOKENS.has(token));
}

function directResearchRequestTarget(event) {
  if (!event || event.ok !== true || event.empty === true) return null;
  const action = normalizeResearchAtlasAction(event.action);
  if (action !== "code.window" && action !== "code.lens") return null;
  const args = event.args && typeof event.args === "object" ? event.args : {};
  const rawIdentifiers = args.identifiersToFind ?? args.identifiers_to_find ?? args.identifiers;
  const identifiers = [
    ...(Array.isArray(rawIdentifiers)
      ? rawIdentifiers
      : typeof rawIdentifiers === "string"
        ? rawIdentifiers.split(/\s*[,;]\s*/)
        : []),
    args.identifier,
    args.symbol,
    args.symbolName,
  ].filter((value) => typeof value === "string" && value.trim());
  const identifierTokenSets = identifiers.map((identifier) => {
    const tokens = coverageTokens(identifier);
    const materialTokens = tokens.filter(
      (token) => !COVERAGE_GENERIC_IDENTIFIER_TOKENS.has(token),
    );
    return materialTokens.length > 0 ? materialTokens : tokens;
  });
  const pathTokens = coverageTokens(args.file || args.path || "");
  return {
    identifierTokenSets,
    pathTokens,
  };
}

function focusRequestSignal(label, explorationRequests) {
  const required = [...new Set(coverageLabelTokens(label))];
  if (required.length === 0) return { strength: 0, count: 0 };
  let strength = 0;
  let count = 0;
  for (const event of explorationRequests || []) {
    const target = directResearchRequestTarget(event);
    if (!target) continue;
    let eventStrength = 0;
    for (const identifierTokens of target.identifierTokenSets) {
      const hits = required.filter((token) => identifierTokens.includes(token)).length;
      if (hits === required.length) {
        const extraTokens = identifierTokens.filter((token) => !required.includes(token));
        eventStrength = Math.max(eventStrength, extraTokens.length === 0 ? 2 : 1);
      } else if (hits > 0) {
        eventStrength = Math.max(eventStrength, 1);
      }
    }
    if (eventStrength === 0) {
      const pathHits = required.filter((token) => target.pathTokens.includes(token)).length;
      if (pathHits === required.length) eventStrength = 2;
      else if (pathHits > 0) eventStrength = 1;
    }
    if (eventStrength > 0) {
      strength = Math.max(strength, eventStrength);
      count++;
    }
  }
  return { strength, count };
}

export function buildResearchCoveragePriorityText({
  taskText = "",
  explorationRequests = [],
} = {}) {
  const focusAreas = extractResearchCoverageChecklist(taskText)
    .map((item, index) => ({
      index,
      label: namedFocusAreaLabel(item),
    }))
    .filter(({ label }) => !!label)
    .map(({ index, label }) => ({
      index,
      label,
      ...focusRequestSignal(label, explorationRequests),
    }));
  if (focusAreas.length === 0) return "";

  const undercovered = focusAreas
    .filter(({ strength }) => strength < 2)
    .sort((left, right) => (
      left.strength - right.strength
      || left.count - right.count
      || left.index - right.index
    ))
    .slice(0, RESEARCH_COVERAGE_PRIORITY_MAX_ITEMS);
  if (undercovered.length === 0) {
    return [
      "REQUEST-HISTORY COVERAGE PRIORITY: every named focus area has at least one exact direct-target signal.",
      "This lexical signal is not proof of evidence completeness. Use your evidence audit to revisit a row only when its governing body or branch is still missing.",
    ].join("\n");
  }
  const nextZeroSignal = undercovered.find(({ strength }) => strength === 0);

  return [
    "REQUEST-HISTORY UNDERCOVERAGE PRIORITY (conservative lexical signal, not proof):",
    ...undercovered.map(({ label, strength, count }, index) => (
      `${index + 1}. ${label} — ${
        strength === 0
          ? "no successful direct body request targeted this mechanism"
          : `${count} related-only direct target signal${count === 1 ? "" : "s"}; no exact mechanism target`
      }`
    )),
    nextZeroSignal
      ? `NEXT-CALL REQUIREMENT: "${nextZeroSignal.label}" has no successful direct target. Unless evidence already gathered contains its exact governing body or boundary, target this row next; you may skip it only when you can cite that exact evidence in the final report.`
      : null,
    nextZeroSignal
      ? "A named mechanism owned by another or downstream subsystem is still required coverage: retrieve its actual owner or the exact handoff boundary. Do not classify it as out of scope or reserve it as a limitation merely because the current subsystem does not implement it."
      : null,
    "Prefer an item near the top when your gathered evidence does not already contain its exact governing body. If the evidence really does close it, skip it and take the next listed gap; do not treat this request-history signal as a grading rule.",
  ].filter(Boolean).join("\n");
}

function buildResearchCoverageChecklistText(taskText, { explorationAvailable = true } = {}) {
  const items = extractResearchCoverageChecklist(taskText);
  if (items.length === 0) {
    return [
      explorationAvailable
        ? "FINAL COVERAGE AUDIT: re-read the assigned task and use the remaining call only for its highest-confidence missing source-body or branch evidence."
        : "FINAL COVERAGE AUDIT: re-read the assigned task and visibly address each requested deliverable from the evidence already gathered.",
      "Do not revisit a supported mechanism. Broad topology, symbol names, and nearby code are not substitutes for the governing helper body.",
    ].join("\n");
  }
  return [
    "DETERMINISTIC COVERAGE CHECKLIST (derived from the assigned task; every item is required):",
    ...items.map((item, index) => `${index + 1}. ${item}`),
    "Privately mark each item supported or unsupported from evidence already gathered. Use remaining calls one-per-unsupported-item, highest materiality first. A broad result, symbol name, or nearby helper is not exact body/branch evidence.",
  ].join("\n");
}

export function buildResearchCoverageStartText({ taskText = "" } = {}) {
  const checklist = buildResearchCoverageChecklistText(taskText);
  return [
    "RESEARCH EVIDENCE PLAN: use the deterministic checklist below from the start of exploration.",
    checklist,
    "Treat every named focus-area row as an independent evidence obligation. Before broadening or revisiting a supported path, obtain the exact governing body or branch for an unsupported row.",
  ].join("\n");
}

export function buildResearchMidpointAuditText({
  taskText = "",
  explorationRequests = [],
} = {}) {
  return [
    "RESEARCH MIDPOINT AUDIT: half of the exploration budget is now used.",
    buildResearchCoverageChecklistText(taskText),
    buildResearchCoveragePriorityText({ taskText, explorationRequests }),
    "Pause before deepening the current trail. Identify every checklist row that still lacks its exact governing helper body, precedence branch, failure path, or lifecycle boundary.",
    "Continue flexibly with the highest-materiality unsupported row. Do not follow a fixed file order, and do not spend another call on a mechanism that already has exact evidence while a named focus area remains unsupported.",
  ].filter(Boolean).join("\n");
}

export function buildResearchCurtainCallText({
  explorationSteps = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
  taskText = "",
  explorationRequests = [],
} = {}) {
  const remainingCalls = Math.max(
    0,
    RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS - Number(explorationSteps || 0),
  );
  return [
    `RESEARCH CURTAIN CALL: ${remainingCalls} targeted exploration call${remainingCalls === 1 ? "" : "s"} ${remainingCalls === 1 ? "remains" : "remain"} before mandatory closeout.`,
    buildResearchCoverageChecklistText(taskText),
    buildResearchCoveragePriorityText({ taskText, explorationRequests }),
    "Use each remaining call only to close an exact unsupported checklist item with the governing helper body, precedence branch, failure path, or lifecycle boundary. Do not start a new research branch, repeat an earlier search/read, or use atlas.fetch_ref as a discovery workaround.",
    "A search-only result does not close an evidence gap. When the file and helper name are already known, do not spend a remaining call on symbol.search, code.skeleton, code.structure, or another locator: open the governing body directly with code.window or code.lens. With one call left, never locate evidence that would require a later call to read.",
    "For code.window or code.lens, target exactly one named mechanism and pass exactly one identifiersToFind entry per remaining call. Bundling identifiers can omit the load-bearing body while appearing complete.",
    "Do not leave a named focus area unsupported while spending a call on an already-supported area. Do not stop early merely to report a limitation that an available exact call can close.",
    "When a named area belongs to a downstream or adjacent subsystem, close it by retrieving the actual owner or exact handoff boundary; subsystem placement does not make an assigned focus area optional.",
    "Then stop tool use and synthesize the final report with the information already gathered.",
  ].filter(Boolean).join("\n");
}

export function buildResearchSynthesisRequiredText({
  explorationSteps = 0,
  staleSteps = 0,
  absoluteCeilingReached = true,
  taskText = "",
} = {}) {
  const stopReason = absoluteCeilingReached
    ? "deterministic_research_tool_ceiling"
    : "deterministic_synthesize_now_no_novel_evidence";
  return [
    "RESEARCH CLOSEOUT REQUIRED: deterministic exploration limit reached.",
    absoluteCeilingReached
      ? `Exploration calls: ${explorationSteps}; absolute ceiling: ${RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS}.`
      : `Exploration calls: ${explorationSteps}; no new relevant file in the last ${staleSteps} exploration calls.`,
    buildResearchCoverageChecklistText(taskText, { explorationAvailable: false }),
    "No further discovery calls are available. Use the remaining model turns to synthesize the best-supported final research report from the information already gathered and complete the terminal handoff.",
    "Before answering, audit every requested deliverable and visibly address every checklist item. Use exact evidence already gathered; only name a specific unresolved gap under Limitations when the required source was genuinely unavailable. Do not emit empty sections, placeholder bullets, or unsupported completion claims.",
    "TERMINAL REPORT PACKING: researcher.report.v1 accepts at most 12 claim objects, each with a `claim` string no longer than 1,000 characters. Plan the packet once: combine related mechanisms and reserve at least one claim for required cross-cutting conclusions instead of letting mechanism sections consume every slot. When the task asks for false simplifications, put at least three explicit `False: ... because ...` cases in that claim. When it asks for a prefetched ATLAS-context grade, include that verdict there too. Submit object claims within the field cap on the first attempt; do not submit string claims or oversize prose and then repair them.",
    "Do not use atlas.fetch_ref or another full tool call to extend research. The only runtime exception is one exact retrieval of a ref surfaced before the curtain call when its stored payload is already known to be essential to a final claim; it does not reopen discovery.",
    `Include files/symbols consulted, why each mattered, unknowns, and stop_reason=${stopReason}.`,
  ].join("\n");
}
