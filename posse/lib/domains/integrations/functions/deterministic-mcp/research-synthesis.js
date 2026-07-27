export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps;
// the curtain call still reserves the final two calls for targeted closure.
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
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 2;
const RESEARCH_COVERAGE_CHECKLIST_MAX_ITEMS = 12;
const RESEARCH_COVERAGE_CHECKLIST_ITEM_MAX_CHARS = 260;

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

function uniqueCoverageItems(items) {
  const seen = new Set();
  const result = [];
  for (const candidate of items) {
    const item = boundedCoverageItem(candidate);
    const key = item.toLowerCase();
    if (!item || seen.has(key) || isTestExecutionCriterion(item)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= RESEARCH_COVERAGE_CHECKLIST_MAX_ITEMS) break;
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

export function buildResearchCurtainCallText({
  explorationSteps = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
  taskText = "",
} = {}) {
  const remainingCalls = Math.max(
    0,
    RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS - Number(explorationSteps || 0),
  );
  return [
    `RESEARCH CURTAIN CALL: ${remainingCalls} targeted exploration call${remainingCalls === 1 ? "" : "s"} ${remainingCalls === 1 ? "remains" : "remain"} before mandatory closeout.`,
    buildResearchCoverageChecklistText(taskText),
    "Use each remaining call only to close an exact unsupported checklist item with the governing helper body, precedence branch, failure path, or lifecycle boundary. Do not start a new research branch, repeat an earlier search/read, or use atlas.fetch_ref as a discovery workaround.",
    "Do not leave a named focus area unsupported while spending a call on an already-supported area. Do not stop early merely to report a limitation that an available exact call can close.",
    "Then stop tool use and synthesize the final report with the information already gathered.",
  ].join("\n");
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
    "Do not use atlas.fetch_ref or another full tool call to extend research. The only runtime exception is one exact retrieval of a ref surfaced before the curtain call when its stored payload is already known to be essential to a final claim; it does not reopen discovery.",
    `Include files/symbols consulted, why each mattered, unknowns, and stop_reason=${stopReason}.`,
  ].join("\n");
}
