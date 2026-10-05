// The final review's result and its durable record, and the handoff gate that
// reads that record. The record is the only state the gate trusts: it is read
// by the owner and by the MCP child process alike.

import { getDb } from "../../../shared/storage/functions/index.js";
import { getToolMetadataRegistry } from "../../../shared/tools/functions/tool-suites.js";
import { getToolCatalogEntry } from "../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import {
  FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT,
  FINAL_REVIEW_MAX_FINDINGS,
  FINAL_REVIEW_OBSERVATIONS,
  FINAL_REVIEW_OUTCOMES,
} from "../../../catalog/final-review.js";

function claimEvidence(claim) {
  if (!claim || typeof claim !== "object") return null;
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : claim.evidence ? [claim.evidence] : [];
  const rendered = evidence.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).filter(Boolean);
  return rendered.length > 0 ? rendered.join("; ").slice(0, 600) : null;
}

/**
 * Map the reviewer's assessor verdict to the tool result. pass passes; fail
 * lists one finding per reason; anything else (needs_review, needs_replan, no
 * verdict) is blocked: the review could not judge the work, which never holds
 * the handoff.
 */
export function finalReviewResultFromVerdict(verdict, { claims = [] } = {}) {
  const decision = String(verdict?.verdict || "").trim().toLowerCase();
  const reasons = (Array.isArray(verdict?.reasons) ? verdict.reasons : [])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean);
  if (decision === "pass") {
    return { outcome: FINAL_REVIEW_OUTCOMES.PASS, findings: [], summary: reasons[0] || "The change meets the task contract." };
  }
  if (decision === "fail" && reasons.length > 0) {
    return {
      outcome: FINAL_REVIEW_OUTCOMES.FINDINGS,
      findings: reasons.slice(0, FINAL_REVIEW_MAX_FINDINGS).map((reason, index) => ({
        severity: "high",
        criterion: reason.slice(0, 1000),
        evidence: claimEvidence(claims[index]),
        suggested_verification: null,
      })),
    };
  }
  return {
    outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
    findings: [],
    reason: reasons[0] || `the reviewer returned ${decision || "no verdict"}`,
  };
}

function parseDetail(row) {
  try {
    const detail = JSON.parse(String(row?.detail_json || "{}"));
    return detail && typeof detail === "object" ? detail : {};
  } catch {
    return {};
  }
}

let mutatingObservationTypes = null;
function mutatingToolObservationTypes() {
  if (!mutatingObservationTypes) {
    mutatingObservationTypes = [...new Set(getToolMetadataRegistry().all()
      .filter((entry) => entry.suite === "tools" && entry.mutatesWorktree)
      .map((entry) => getToolCatalogEntry(entry.name)?.observation?.type)
      .filter(Boolean))];
  }
  return mutatingObservationTypes;
}

/** Final review results recorded for one implementation attempt, oldest first. */
export function finalReviewResultsForAttempt({ jobId, attemptId, db = getDb() }) {
  if (!jobId || !attemptId) return [];
  return db.prepare(`
    SELECT id, detail_json
    FROM job_observations
    WHERE job_id = ? AND attempt_id = ? AND observation_type = ?
    ORDER BY id ASC
  `).all(jobId, attemptId, FINAL_REVIEW_OBSERVATIONS.RESULT)
    .map((row) => ({ id: Number(row.id), ...parseDetail(row) }));
}

export function finalReviewIssuedTo({ jobId, agentCallId, db = getDb() }) {
  if (!jobId || !agentCallId) return false;
  return db.prepare(`
    SELECT detail_json FROM job_observations WHERE job_id = ? AND observation_type = ?
  `).all(jobId, FINAL_REVIEW_OBSERVATIONS.ISSUED)
    .some((row) => Number(parseDetail(row).agent_call_id) === Number(agentCallId));
}

function editedSince({ jobId, agentCallId, afterObservationId, db }) {
  const types = mutatingToolObservationTypes();
  if (types.length === 0) return false;
  return db.prepare(`
    SELECT detail_json
    FROM job_observations
    WHERE job_id = ? AND id > ? AND observation_type IN (${types.map(() => "?").join(",")})
  `).all(jobId, afterObservationId, ...types).some((row) => {
    const detail = parseDetail(row);
    return Number(detail.agent_call_id) === Number(agentCallId) && detail.ok !== false;
  });
}

/**
 * Why a COMPLETE handoff must wait for the final review, or null when it may
 * proceed: the call was not issued the tool, the latest review passed and the
 * change was not edited since, a review could not run, or the attempt's
 * reviews are used up.
 */
export function finalReviewHandoffHold({ jobId, attemptId, agentCallId, db = getDb() }) {
  if (!finalReviewIssuedTo({ jobId, agentCallId, db })) return null;
  const results = finalReviewResultsForAttempt({ jobId, attemptId, db });
  if (results.some((result) => result.outcome === FINAL_REVIEW_OUTCOMES.BLOCKED)) return null;
  if (results.length >= FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT) return null;
  const latest = results.at(-1);
  if (!latest) {
    return "Call final_review before a COMPLETE handoff: it runs the task's declared tests and an independent review of the change.";
  }
  if (latest.outcome === FINAL_REVIEW_OUTCOMES.PASS) {
    if (!editedSince({ jobId, agentCallId, afterObservationId: latest.id, db })) return null;
    return "The change was edited after its final review passed; call final_review again before the COMPLETE handoff.";
  }
  return "The last final review returned findings; fix them and call final_review again before the COMPLETE handoff.";
}
