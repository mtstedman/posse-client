import { getDb } from "../../../shared/storage/functions/index.js";

const SOURCE_SELECTION_OBSERVATION = "research.source_selection";
const SOURCE_COVERAGE_OBSERVATION = "source.coverage";
const HEADROOM_DECISION_OBSERVATION = "context.headroom_decision";
const HEADROOM_ACTUAL_OBSERVATION = "context.headroom_actual";
const LOGICAL_OUTCOMES = new Set(["executed", "covered", "blocked"]);
const REASON_CLASSES = new Set(["suppression", "reaccess", "headroom"]);

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function incrementReason(target, value) {
  const reason = String(value || "unknown").trim() || "unknown";
  target[reason] = (target[reason] || 0) + 1;
}

function canonicalAccountingContributionCounts(accounting = null) {
  return {
    exactUsageCalls: count(accounting?.exactUsageCalls),
    inexactUsageCalls: count(accounting?.inexactUsageCalls),
    exactCostCalls: count(accounting?.exactCostCalls),
    estimatedCostCalls: count(accounting?.estimatedCostCalls),
    unknownCostCalls: count(accounting?.unknownCostCalls),
    costPrecision: accounting?.costPrecision || "unknown",
    knownCostUsd: Number.isFinite(Number(accounting?.knownCostUsd))
      ? Math.max(0, Number(accounting.knownCostUsd))
      : 0,
  };
}

/**
 * Fold Atlas137's explicit durable observation contract. Logical source
 * selections are counted only from research.source_selection rows; tool.atlas
 * rows and source.coverage regions are deliberately not treated as selections
 * because one tool call can contain many items and one item can store several
 * coverage regions.
 */
export function foldAtlas137AcceptanceTelemetry({
  observations = [],
  physicalProviderCalls = 0,
  accounting = null,
} = {}) {
  const logical = { attempted: 0, executed: 0, covered: 0, blocked: 0, novel: 0 };
  const evidenceCharacters = { returned: 0, stored: 0, measuredSelections: 0 };
  const reasons = { suppression: {}, reaccess: {}, headroom: {} };
  const headroom = {
    decisions: 0,
    allowed: 0,
    blocked: 0,
    failOpen: 0,
    observations: 0,
    predictedTokens: 0,
    actualTokens: 0,
    predictionErrorTokens: 0,
  };
  let selectionRows = 0;
  let missingAttemptIdentityRows = 0;
  const legacyCoverage = [];

  for (const row of observations || []) {
    const type = String(row?.observation_type || row?.type || "");
    const detail = jsonObject(row?.detail_json ?? row?.detail);
    if (type === SOURCE_SELECTION_OBSERVATION) {
      selectionRows += 1;
      if (row?.attempt_id == null && row?.attempt == null) missingAttemptIdentityRows += 1;
      const outcome = String(detail.outcome || "").trim().toLowerCase();
      logical.attempted += 1;
      if (LOGICAL_OUTCOMES.has(outcome)) logical[outcome] += 1;
      if (detail.novel_source === true) logical.novel += 1;
      evidenceCharacters.returned += count(detail.returned_chars);
      evidenceCharacters.stored += count(detail.stored_chars);
      evidenceCharacters.measuredSelections += 1;
      const reasonClass = String(detail.reason_class || "").trim().toLowerCase();
      if (REASON_CLASSES.has(reasonClass)) incrementReason(reasons[reasonClass], detail.reason);
      continue;
    }
    if (type === SOURCE_COVERAGE_OBSERVATION) {
      legacyCoverage.push(detail);
      continue;
    }
    if (type === HEADROOM_DECISION_OBSERVATION) {
      headroom.decisions += 1;
      const decision = String(detail.decision || "").trim().toLowerCase();
      if (decision === "allowed") headroom.allowed += 1;
      else if (decision === "blocked") headroom.blocked += 1;
      else if (decision === "fail_open") headroom.failOpen += 1;
      incrementReason(reasons.headroom, detail.reason);
      continue;
    }
    if (type === HEADROOM_ACTUAL_OBSERVATION) {
      const predicted = Number(detail.predicted_next_request_tokens);
      const actual = Number(detail.actual_request_context_tokens);
      const error = Number(detail.prediction_error_tokens);
      if (Number.isFinite(predicted) && Number.isFinite(actual)) {
        headroom.observations += 1;
        headroom.predictedTokens += Math.max(0, predicted);
        headroom.actualTokens += Math.max(0, actual);
        if (Number.isFinite(error)) headroom.predictionErrorTokens += error;
      }
    }
  }

  // Compatibility-only character fallback for runs recorded before the
  // per-selection observation contract. It does not fabricate logical counts.
  if (selectionRows === 0) {
    for (const detail of legacyCoverage) {
      evidenceCharacters.returned += count(detail.returned_chars);
      evidenceCharacters.stored += count(detail.stored_chars);
    }
  }

  return {
    physicalProviderCalls: count(physicalProviderCalls),
    logicalSelections: logical,
    evidenceCharacters,
    reasons,
    headroom,
    accounting: canonicalAccountingContributionCounts(accounting),
    compatibility: {
      logicalSelectionSource: selectionRows > 0 ? "research.source_selection.v1" : "unavailable_legacy",
      evidenceCharacterSource: selectionRows > 0 ? "research.source_selection.v1" : "source.coverage.legacy",
      missingAttemptIdentityRows,
    },
  };
}

export function getAtlas137AcceptanceTelemetry({
  workItemId,
  physicalProviderCalls = 0,
  accounting = null,
  db = getDb(),
} = {}) {
  const id = Number(workItemId);
  if (!Number.isInteger(id) || id <= 0) {
    return foldAtlas137AcceptanceTelemetry({ physicalProviderCalls, accounting });
  }
  let observations = [];
  try {
    observations = db.prepare(`
      SELECT attempt_id, observation_type, detail_json
      FROM job_observations
      WHERE work_item_id = ?
        AND observation_type IN (?, ?, ?, ?)
      ORDER BY id ASC
    `).all(
      id,
      SOURCE_SELECTION_OBSERVATION,
      SOURCE_COVERAGE_OBSERVATION,
      HEADROOM_DECISION_OBSERVATION,
      HEADROOM_ACTUAL_OBSERVATION,
    );
  } catch {
    // Compatibility databases may not have job_observations yet.
  }
  return foldAtlas137AcceptanceTelemetry({ observations, physicalProviderCalls, accounting });
}
