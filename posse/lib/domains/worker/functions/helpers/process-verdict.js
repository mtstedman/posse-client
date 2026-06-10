import {
  runInTransaction,
  setAssessorVerdict,
  logEvent,
  updateJobStatus,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import {
  normalizeAssessorConfidence,
  prepareVerdictForDispatch,
} from "./verdict-shared.js";
import { handle as handleBlocked } from "./verdicts/blocked.js";
import { handle as handleFail } from "./verdicts/fail.js";
import {
  handle as handleNeedsReview,
  handleParseError,
  handleUnknownVerdict,
} from "./verdicts/needs_review.js";
import { handle as handleNeedsReplan } from "./verdicts/needs_replan.js";
import { handle as handlePass } from "./verdicts/pass.js";
import { spawnFromRole } from "../spawn-guard.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const ASSESSOR_SPAWN_ROLE = Object.freeze({
  role: "assessor",
});

/**
 * Process an assessor verdict: update job status and spawn follow-up jobs.
 *
 * @param {object} job - The assessed job
 * @param {object} verdict - Result from assessResult()
 * @returns {object} { action, spawnedJobs }
 */
export function processVerdict(job, verdict, { emit = null, autoApprove = false, leaseToken = null } = {}) {
  const emitLog = emit || ((msg) => console.log(`  ${msg}`));
  const spawnedJobs = [];
  const spawnFromAssessor = (outcome, jobType, payload) =>
    spawnFromRole(ASSESSOR_SPAWN_ROLE, outcome, jobType, payload);

  const prepared = prepareVerdictForDispatch(job, verdict);
  verdict = prepared.verdict;
  const normalizedConfidence = normalizeAssessorConfidence(verdict.confidence, {
    fallback: verdict.verdict === "parse_error" ? null : "medium",
    allowNone: true,
  });
  verdict = {
    ...verdict,
    confidence: normalizedConfidence || "none",
  };

  // Map parse_error to valid DB values (CHECK constraint only allows
  // pass/fail/blocked/needs_replan/needs_review/not_assessed).
  const dbVerdict = verdict.verdict === "parse_error" ? "needs_review" : verdict.verdict;
  const dbConfidence = normalizedConfidence;

  let verdictRecorded = false;
  const recordAssessorVerdict = () => {
    if (verdictRecorded) return true;
    const changed = setAssessorVerdict(
      job.id,
      dbVerdict,
      dbConfidence,
      leaseToken != null ? { leaseToken, allowReleasedLease: true } : {},
    );
    if (!changed) return false;
    verdictRecorded = true;
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Verdict: ${verdict.verdict} (${verdict.confidence}) - ${verdict.reasons.join("; ")}`,
      event_json: JSON.stringify(verdict),
    });
    return true;
  };

  const reasonBrief = verdict.reasons.length > 0
    ? ` - ${verdict.reasons[0].slice(0, 120)}`
    : "";

  const isFromSuggestion = !!parseJobPayload(job).from_suggestion;

  const ctx = {
    autoApprove,
    desiredOutputs: prepared.desiredOutputs,
    emitLog,
    isFromSuggestion,
    reasonBrief,
    leaseToken,
    recordAssessorVerdict,
    spawnedJobs,
    spawnFromAssessor,
    updateJobStatus: (status) => runInTransaction(() => {
      const changed = updateJobStatus(
        job.id,
        status,
        leaseToken != null ? { leaseToken } : {},
      );
      if (!changed) return false;
      if (!recordAssessorVerdict()) {
        throw new Error(`Unable to record assessor verdict for job #${job.id} after status ${status}`);
      }
      return true;
    }),
  };

  switch (verdict.verdict) {
    case "pass":
      handlePass(job, verdict, ctx);
      break;
    case "fail":
      handleFail(job, verdict, ctx);
      break;
    case "blocked":
      handleBlocked(job, verdict, ctx);
      break;
    case "needs_review":
      handleNeedsReview(job, verdict, ctx);
      break;
    case "needs_replan":
      handleNeedsReplan(job, verdict, ctx);
      break;
    case "parse_error":
      handleParseError(job, verdict, ctx);
      break;
    default:
      handleUnknownVerdict(job, verdict, ctx);
      break;
  }

  return { action: verdict.verdict, spawnedJobs };
}
