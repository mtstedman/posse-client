import crypto from "node:crypto";

export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps.
// The model sees no total budget; it receives one final-window warning with a
// full batched turn left to close named coverage gaps and prepare synthesis.
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
// Physical executions remain a fail-safe behind logical exploration units even
// when concurrent emissions or mapped-symbol follow-ups consume fewer units.
// Atlas325 showed this rail, not the unit ceiling, closes most wide tasks:
// four batched reads per turn reach 30 physical calls in seven or eight turns.
// The ceiling is therefore an explicit, validated policy value. The default
// is 26 after Atlas361 preserved Correct quality while crossing 50% matched
// Terra cost savings; a declared treatment may raise it through the environment or the
// `research_synthesis_max_physical_calls` account setting. Session owners
// snapshot the effective value once per session so reservations, admission,
// closing warnings, and telemetry all use one number.
export const DEFAULT_RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS = 26;
export const RESEARCH_SYNTHESIS_MIN_PHYSICAL_CALLS = RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS
  + RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS;
export const RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS_LIMIT = 200;

// Validate one candidate physical ceiling. Returns null for anything that is
// not a safe integer inside the closed range; callers fall back explicitly so
// an invalid experiment value can never silently widen or collapse the rail.
export function validateResearchSynthesisPhysicalCallCeiling(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "number") {
    const text = String(value).trim();
    if (!/^[0-9]{1,6}$/.test(text)) return null;
    value = Number(text);
  }
  const parsed = value;
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < RESEARCH_SYNTHESIS_MIN_PHYSICAL_CALLS
    || parsed > RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS_LIMIT) return null;
  return parsed;
}

const configuredPhysicalCallCeiling = validateResearchSynthesisPhysicalCallCeiling(
  process.env.POSSE_RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS,
);
// Process-level effective ceiling (environment or default). Session owners
// layer the account setting on top through the gate-settings resolver.
export const RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS = configuredPhysicalCallCeiling
  ?? DEFAULT_RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;

/**
 * Immutable per-session snapshot of every research admission limit. Consumers
 * must read limits from one snapshot rather than mixing module constants with
 * a session-specific physical ceiling.
 *
 * @param {{ maxPhysicalCalls?: number | string | null }} [overrides]
 */
export function researchSynthesisPolicySnapshot({ maxPhysicalCalls = null } = {}) {
  return Object.freeze({
    minExplorationSteps: RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS,
    staleExplorationSteps: RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS,
    maxExplorationSteps: RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
    maxPhysicalCalls: validateResearchSynthesisPhysicalCallCeiling(maxPhysicalCalls)
      ?? RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS,
    curtainCallRemainingSteps: RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
    defaultMaxPhysicalCalls: DEFAULT_RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS,
  });
}

function effectiveMaxPhysicalCalls(value) {
  return validateResearchSynthesisPhysicalCallCeiling(value) ?? RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;
}
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 6;
// Atlas137: close at the base ceiling. Eligibility for a future extension may
// be observed, but it never changes admission in this release.
export const RESEARCH_SYNTHESIS_CEILING_EXTENSION_STEPS = 0;
export const RESEARCH_SYNTHESIS_FRESH_NOVELTY_MAX_STALE_STEPS = 1;
// Exploration-time traversal remains available for omitted or bounded stored
// payloads. The gate only becomes terminal after closeout has admitted one
// final batched traverse_ref request.
export const RESEARCH_CITATION_FETCH_GATE_ENABLED = true;
const NON_EXPLORATION_ATLAS_ACTIONS = new Set([
  "buffer.push",
  "create.ref",
  "fetch.ref",
  "traverse.ref",
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
  return ["fetch.ref", "traverse.ref"].includes(normalizeResearchAtlasAction(action));
}

export function isResearchAtlasExplorationAction(action) {
  const normalized = normalizeResearchAtlasAction(action);
  return !!normalized
    && !normalized.startsWith("memory.")
    && !NON_EXPLORATION_ATLAS_ACTIONS.has(normalized);
}

// The effective hard stop for exploration. Atlas137 fixes the extension at
// zero; staleSteps remains in the signature for compatibility and telemetry.
export function researchSynthesisExplorationCeiling({ staleSteps = 0 } = {}) {
  const stale = Math.max(0, Number(staleSteps) || 0);
  return RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    + (stale <= RESEARCH_SYNTHESIS_FRESH_NOVELTY_MAX_STALE_STEPS
      ? RESEARCH_SYNTHESIS_CEILING_EXTENSION_STEPS
      : 0);
}

export function researchSynthesisDecision({
  explorationSteps = 0,
  callSteps = 0,
  staleSteps = 0,
  synthesisRequired = false,
  maxPhysicalCalls = null,
} = {}) {
  const steps = Math.max(0, Number(explorationSteps) || 0);
  const calls = Math.max(0, Number(callSteps) || 0);
  const stale = Math.max(0, Number(staleSteps) || 0);
  const explorationCeiling = researchSynthesisExplorationCeiling({ staleSteps: stale });
  const physicalCallCeiling = effectiveMaxPhysicalCalls(maxPhysicalCalls);
  const unitCeilingReached = steps >= explorationCeiling;
  const physicalCallCeilingReached = calls >= physicalCallCeiling;
  const absoluteCeilingReached = unitCeilingReached || physicalCallCeilingReached;
  const staleCeilingReached = steps >= RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS
    && stale >= RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS;
  const required = synthesisRequired === true || absoluteCeilingReached || staleCeilingReached;
  return {
    required,
    absoluteCeilingReached,
    staleCeilingReached,
    explorationSteps: steps,
    callSteps: calls,
    staleSteps: stale,
    explorationCeiling,
    physicalCallCeiling,
    reason: physicalCallCeilingReached
      ? "physical_call_ceiling"
      : (unitCeilingReached
        ? "exploration_ceiling"
        : (staleCeilingReached ? "stale_evidence" : (synthesisRequired ? "already_required" : null))),
  };
}

// Novelty for native exploration reads (read_file, search_files, ...): the
// first successful, non-empty call with a given signature counts as novel
// evidence; empty results and exact repeats advance the stale streak instead. In-memory by design — a
// gateway restart re-credits at most one duplicate per signature, which errs
// toward keeping the evidence window open rather than closing it early.
//
// RS-1: the signature is scoped, not global. `scopeKey` carries the runtime
// research-session owner and its repository identity, so identical arguments
// issued by two different sessions (or against two different working
// directories) are independent evidence events. The result digest is part of
// the signature too: re-reading the same selector after the content changed is
// new evidence, not an exact repeat.
// F3: a gateway control response that explicitly withholds evidence is not
// evidence, and its text carries volatile fields (elapsed milliseconds). Both
// reasons keep it out of the digest: digesting it would make every suppressed
// duplicate hash novel and defeat the staleness gate entirely.
export const NATIVE_DUPLICATE_READ_SUPPRESSED_PREFIX = "Duplicate read suppressed:";

function nativeExplorationResultHasEvidence(resultText) {
  const text = String(resultText ?? "").trim();
  if (!text) return false;
  if (text.startsWith(NATIVE_DUPLICATE_READ_SUPPRESSED_PREFIX)) return false;
  return !/^(?:No files found\.|No matches found\.)$/i.test(text);
}

export function nativeExplorationResultDigest(resultText) {
  if (resultText === undefined) return "";
  return crypto.createHash("sha256").update(String(resultText ?? ""), "utf8").digest("hex").slice(0, 24);
}

export function nativeExplorationNoveltySignature({
  scopeKey = "",
  toolName = "",
  args = null,
  resultText = undefined,
} = {}) {
  let serializedArgs;
  try {
    serializedArgs = JSON.stringify(args ?? null);
  } catch {
    serializedArgs = "unserializable";
  }
  return [
    String(scopeKey || ""),
    String(toolName || ""),
    serializedArgs,
    nativeExplorationResultDigest(resultText),
  ].join("|");
}

export function createNativeExplorationNoveltyTracker({ maxEntries = 1024, scopeKey = "" } = {}) {
  const scope = String(scopeKey || "");
  const seen = new Set();
  return {
    scopeKey: scope,
    isNovel(toolName, args, resultText = undefined) {
      if (resultText !== undefined && !nativeExplorationResultHasEvidence(resultText)) {
        return false;
      }
      const signature = nativeExplorationNoveltySignature({
        scopeKey: scope,
        toolName,
        args,
        resultText,
      });
      if (seen.has(signature)) return false;
      if (seen.size < maxEntries) seen.add(signature);
      return true;
    },
  };
}

// Guided texts name the handoff tool as the provider exposes it; callers pass
// the rendered name and the canonical name remains the fallback.
function handoffName(handoffToolName) {
  return String(handoffToolName || "").trim() || "agent_handoff";
}

export function buildResearchCitationFetchGateText({ reason = "before_synthesis", handoffToolName = "" } = {}) {
  const handoff = handoffName(handoffToolName);
  if (reason === "physical_call_ceiling") {
    return [
      "RESEARCH TOOL GATE CLOSED.",
      "The deterministic physical work-call ceiling has been reached; stored-result traversal is not exempt.",
      `Do not call another tool. Call ${handoff} with the terminal researcher report.`,
    ].join("\n");
  }
  if (reason === "budget_exhausted") {
    return [
      "FINAL TRAVERSAL BATCH ALREADY USED: the one synthesis-phase atlas.traverse_ref batch has completed.",
      `Do not call another tool. Call ${handoff} with the terminal researcher report.`,
    ].join("\n");
  }
  return [
    "TRAVERSAL_REF NOT ELIGIBLE: early stored-result traversal is limited to explicit traversal_ref capabilities for omitted, bounded, cursor, survey, or otherwise unseen payloads.",
    "Do not traverse evidence_ref content already delivered in full. Evidence refs are usable for citation or handoff in the current context; only an explicit traversal capability advertises unseen content. A successful traversal promotes that same ref to evidence and returns a different opaque continuation only if more remains.",
    "During exploration, wait to accumulate at least two eligible traversal refs before traversing. Use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

// Unguided runs suppress research advice, not admission state. This states
// the exhaustion fact once, on the result that consumed the last slot, and
// never discloses the total budget or a countdown. It names the handoff tool
// exactly as the provider exposes it (Codex: tools_agent_handoff), because a
// bare "agent_handoff" left one Atlas497 researcher ending its turn in prose.
export const RESEARCH_WORK_BUDGET_EXHAUSTED_PREFIX = "RESEARCH WORK BUDGET EXHAUSTED:";

export function buildResearchWorkBudgetExhaustedText({ handoffToolName = "" } = {}) {
  const fact = `${RESEARCH_WORK_BUDGET_EXHAUSTED_PREFIX} the retrieval work budget is fully used. Further retrieval and traversal calls will return blocked without executing.`;
  const tool = String(handoffToolName || "").trim();
  if (!tool) return fact;
  return `${fact} Next step: call the ${tool} tool with your terminal researcher report. Do not end the turn with prose alone.`;
}

// A plain remaining-call count, stated once while calls are left. It carries
// no handoff instruction: "BUDGET CLOSING ... Next step: call agent_handoff"
// read as an order to stop (Atlas528/530 handed off with calls unspent), while
// no count at all sent 28 of 40 Atlas531 cells into the ceiling with whole
// parallel batches blocked (93 wasted calls, cost +13%).
export const RESEARCH_WORK_BUDGET_REMAINING_PREFIX = "RESEARCH WORK BUDGET:";

export function buildResearchWorkBudgetRemainingText({ remaining = 0 } = {}) {
  const left = Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 0;
  return `${RESEARCH_WORK_BUDGET_REMAINING_PREFIX} ${left} retrieval ${left === 1 ? "call remains" : "calls remain"}. Calls beyond that return blocked without executing.`;
}

export function buildResearchEarlyFetchBatchingText() {
  return [
    "TRAVERSAL BATCHING CHECKPOINT: this exploration traversal contained one ref.",
    "Do not traverse another singleton merely because an evidence_ref is visible. Accumulate at least two eligible traversal refs; use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

export function buildResearchFinalFetchBatchText({ handoffToolName = "" } = {}) {
  return [
    "FINAL TRAVERSAL BATCH COMPLETE.",
    `No further discovery or stored-result traversal calls are available. Call ${handoffName(handoffToolName)} now with the terminal researcher report; do not end the turn with prose alone.`,
  ].join("\n");
}

export function buildResearchCurtainCallText({
  explorationSteps = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
  callSteps = 0,
  maxPhysicalCalls = null,
  handoffToolName = "",
} = {}) {
  // Logical exploration units and physical calls have independent ceilings.
  // Passing a physical count as explorationSteps can announce zero remaining
  // while admission still permits targeted reads (for example, 7/18 and 28/30).
  // The physical ceiling is the session's snapshot, never a module constant,
  // so a raised experimental rail reports the same window it enforces.
  void explorationSteps;
  void callSteps;
  void maxPhysicalCalls;
  return `RESEARCH CLOSEOUT: Remaining capacity is a safety margin, not a target. If every requested conclusion has controlling evidence, call ${handoffName(handoffToolName)} now. Otherwise identify the specific unsupported fact and issue all independent reads needed for it together in one turn.`;
}

export function buildResearchFinalSlotLimitText({ remainingCalls = 0, handoffToolName = "" } = {}) {
  const remaining = Math.max(0, Math.min(3, Number(remainingCalls) || 0));
  if (remaining <= 0) return "";
  return `RESEARCH FINAL CLOSEOUT: Finish the specific unsupported conclusion, then call ${handoffName(handoffToolName)}. Do not use remaining capacity as a reading target.`;
}

export function buildResearchSynthesisRequiredText({
  explorationSteps = 0,
  staleSteps = 0,
  absoluteCeilingReached = true,
  explorationCeiling = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
  finalTraversalAvailable = true,
  coverage = {},
  handoffToolName = "",
} = {}) {
  void coverage;
  const handoff = handoffName(handoffToolName);
  void explorationSteps;
  void explorationCeiling;
  void staleSteps;
  const stopReason = absoluteCeilingReached
    ? "deterministic_research_tool_ceiling"
    : "deterministic_synthesize_now_no_novel_evidence";
  return [
    "RESEARCH TOOL GATE CLOSED.",
    absoluteCeilingReached
      ? "The deterministic discovery-call ceiling has been reached."
      : "The deterministic no-novelty gate has closed discovery.",
    finalTraversalAvailable
      ? `No further discovery calls are available. If eligible unseen traversal refs remain, one final batched atlas.traverse_ref call is available. After that response—or immediately if no eligible refs remain—call ${handoff} with the terminal researcher report and stop_reason=${stopReason}; do not end the turn with prose alone.`
      : `The physical work-call ceiling is reached, so no further discovery or traversal call is available. Call ${handoff} now with the terminal researcher report and stop_reason=${stopReason}; do not end the turn with prose alone.`,
  ].join("\n");
}
