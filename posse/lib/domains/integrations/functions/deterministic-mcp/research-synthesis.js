import crypto from "node:crypto";

export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps.
// The model sees no total budget; it receives one final-window warning only
// when at most two targeted evidence calls remain.
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
// Physical executions remain a fixed fail-safe even when concurrent emissions
// or mapped-symbol follow-ups consume fewer logical exploration units.
export const RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS = 30;
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 2;
// Atlas137: close at the base ceiling. Eligibility for a future extension may
// be observed, but it never changes admission in this release.
export const RESEARCH_SYNTHESIS_CEILING_EXTENSION_STEPS = 0;
export const RESEARCH_SYNTHESIS_FRESH_NOVELTY_MAX_STALE_STEPS = 1;
export const RESEARCH_EARLY_FETCH_SYNTHESIS_AUDIT_BATCHES = 2;
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
} = {}) {
  const steps = Math.max(0, Number(explorationSteps) || 0);
  const calls = Math.max(0, Number(callSteps) || 0);
  const stale = Math.max(0, Number(staleSteps) || 0);
  const explorationCeiling = researchSynthesisExplorationCeiling({ staleSteps: stale });
  const unitCeilingReached = steps >= explorationCeiling;
  const physicalCallCeilingReached = calls >= RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;
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

export function buildResearchCitationFetchGateText({ reason = "before_synthesis" } = {}) {
  if (reason === "budget_exhausted") {
    return [
      "FINAL TRAVERSAL BATCH ALREADY USED: the one synthesis-phase atlas.traverse_ref batch has completed.",
      "Do not call another tool. Submit the best-supported terminal report using the evidence already gathered.",
    ].join("\n");
  }
  return [
    "TRAVERSAL_REF NOT ELIGIBLE: early stored-result traversal is limited to explicit traversal_ref or next_traversal_ref capabilities for omitted, bounded, cursor, survey, or otherwise unseen payloads.",
    "Do not traverse evidence_ref content already delivered in full. Evidence refs are usable for citation or handoff in the current context; only an explicit traversal capability advertises unseen content. A successful traversal promotes that same ref to evidence and returns a different opaque continuation only if more remains.",
    "During exploration, wait to accumulate at least two eligible traversal refs before traversing. Use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

export function buildResearchEarlyFetchBatchingText() {
  return [
    "TRAVERSAL BATCHING CHECKPOINT: this exploration traversal contained one ref.",
    "Do not traverse another singleton merely because an evidence_ref is visible. Accumulate at least two eligible traversal refs; use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

export function buildResearchEarlyFetchSynthesisAuditText({ fetchBatches = 0 } = {}) {
  return [
    `SYNTHESIS AUDIT: ${Math.max(0, Number(fetchBatches) || 0)} exploration traversal batches have been used.`,
    "Compare the gathered evidence with every requested flow, branch, and boundary. If each material item has direct support, synthesize now instead of gathering corroboration.",
    "Before handoff, map every asserted branch condition and precedence rule to a delivered evidence ref. Split, remove, or make one targeted lookup for any unmatched assertion; never validate against task text or an answer key.",
    "If a material gap remains, make only the highest-value targeted lookup and accumulate any further traversal refs into one batch.",
  ].join("\n");
}

export function buildResearchFinalFetchBatchText() {
  return [
    "FINAL TRAVERSAL BATCH COMPLETE.",
    "No further discovery or stored-result traversal calls are available. Call agent_handoff now with the terminal researcher report synthesized from the gathered evidence; do not end the turn with prose alone.",
  ].join("\n");
}

export function buildResearchStopCheckpointText() {
  // Coverage remains in telemetry/session state for diagnostics, but exposing
  // a lane-by-lane ledger made the model expand its task and seek exhaustive
  // corroboration. Keep the model-visible checkpoint stop-first and bounded.
  return [
    "If the gathered evidence supports the requested result, synthesize now.",
    "Otherwise issue every currently known answer-critical missing target as independent calls in one parallel response. Do not seek corroboration or reread covered files.",
  ].join("\n");
}

export function buildResearchMidpointAuditText({ coverage = {} } = {}) {
  void coverage;
  return [
    "EVIDENCE CHECKPOINT: wrap up as soon as the gathered evidence supports the requested result.",
    buildResearchStopCheckpointText(),
  ].join("\n");
}

export function buildResearchCurtainCallText({
  explorationSteps = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
} = {}) {
  const remainingCalls = Math.max(
    0,
    RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS - Number(explorationSteps || 0),
  );
  return [
    `FINAL EVIDENCE WINDOW: You have ${remainingCalls} exploration call${remainingCalls === 1 ? "" : "s"} left before required closeout.`,
    "Do not spend them merely because they are available. If the current evidence is sufficient, synthesize now; otherwise use them only for answer-critical gaps.",
  ].join("\n");
}

export function buildResearchSynthesisRequiredText({
  explorationSteps = 0,
  staleSteps = 0,
  absoluteCeilingReached = true,
  explorationCeiling = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
  coverage = {},
} = {}) {
  void coverage;
  void explorationSteps;
  void explorationCeiling;
  void staleSteps;
  const stopReason = absoluteCeilingReached
    ? "deterministic_research_tool_ceiling"
    : "deterministic_synthesize_now_no_novel_evidence";
  return [
    "RESEARCH CLOSEOUT REQUIRED.",
    absoluteCeilingReached
      ? "The evidence-gathering window is closed."
      : "Recent exploration is no longer producing new relevant evidence.",
    `No further discovery calls are available. If essential unseen stored evidence remains, issue one final batched atlas.traverse_ref call containing all eligible traversal refs. After that response—or immediately if no such evidence remains—call agent_handoff with the best-supported terminal researcher report and stop_reason=${stopReason}; do not end the turn with prose alone.`,
  ].join("\n");
}
