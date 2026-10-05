// FinalReviewRuntime — the owner side of a dev/fix agent's final_review call.
//
// TrackedProviderClient registers each dev/fix agent call that was issued the
// tool, with a closure that runs the reviewer as a child provider call of that
// agent. A final_review call then looks up its own agent call's registration:
// it runs the task's declared tests on the current workspace, builds the
// snapshot, runs the reviewer, records the result durably for the handoff gate
// and returns it. One review runs at a time per agent call; an attempt has a
// fixed number of reviews.

import { getJob, getWorkItem } from "../../queue/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT,
  FINAL_REVIEW_OBSERVATIONS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_TEST_TIMEOUT_MS,
} from "../../../catalog/final-review.js";
import {
  resolveFrozenTestPlan,
  runFrozenTestPlanOnce,
} from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  collectScopedChange,
  finalReviewInstructions,
  renderFinalReviewEvidence,
} from "../functions/final-review-snapshot.js";
import {
  finalReviewResultFromVerdict,
  finalReviewResultsForAttempt,
} from "../functions/final-review-result.js";

function finalReviewError(code, message) {
  return Object.assign(new Error(message), { code });
}

export class FinalReviewRuntime {
  constructor({
    collectChange = collectScopedChange,
    resolveTestPlan = resolveFrozenTestPlan,
    runTestPlan = runFrozenTestPlanOnce,
    record = recordObservation,
  } = {}) {
    this.parents = new Map();
    this.collectChange = collectChange;
    this.resolveTestPlan = resolveTestPlan;
    this.runTestPlan = runTestPlan;
    this.record = record;
  }

  /**
   * @param {{ agentCallId: number, jobId: number, workItemId: number, attemptId: number, cwd: string, runReview: (input: { instructions: string, evidence: string }) => Promise<{ verdict: any, claims?: any[], agentCallId?: number | null }> }} parent
   * @returns {() => void} unregister
   */
  registerParent(parent) {
    const agentCallId = Number(parent?.agentCallId);
    if (!Number.isSafeInteger(agentCallId) || agentCallId <= 0 || typeof parent?.runReview !== "function") {
      throw new Error("FinalReviewRuntime.registerParent requires agentCallId and runReview");
    }
    const entry = { ...parent, agentCallId, inFlight: false };
    this.parents.set(agentCallId, entry);
    this.record({
      work_item_id: parent.workItemId ?? null,
      job_id: parent.jobId ?? null,
      attempt_id: parent.attemptId ?? null,
      observation_type: FINAL_REVIEW_OBSERVATIONS.ISSUED,
      summary: `final_review issued to agent call #${agentCallId}`,
      detail: { agent_call_id: agentCallId },
    });
    return () => {
      if (this.parents.get(agentCallId) === entry) this.parents.delete(agentCallId);
    };
  }

  async execute({ agentCallId } = {}) {
    const parent = this.parents.get(Number(agentCallId));
    if (!parent) {
      throw finalReviewError("FINAL_REVIEW_UNAVAILABLE", "final_review is not available for this agent call; hand off when the change is complete.");
    }
    if (parent.inFlight) {
      throw finalReviewError("FINAL_REVIEW_IN_PROGRESS", "A final review is already running for this agent call; wait for its result.");
    }
    const prior = finalReviewResultsForAttempt({ jobId: parent.jobId, attemptId: parent.attemptId });
    if (prior.length >= FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT) {
      return {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `This attempt's ${FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT} final reviews are used; hand off when the change is complete.`,
        reviews_remaining: 0,
      };
    }
    parent.inFlight = true;
    const startedAt = Date.now();
    let result;
    let testRun = null;
    let change = null;
    let reviewerCallId = null;
    try {
      const job = getJob(parent.jobId);
      if (!job) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", `Job #${parent.jobId} no longer exists`);
      const payload = parseJobPayload(job);
      const workItem = getWorkItem(job.work_item_id);
      testRun = await this.runTestPlan(this.resolveTestPlan(job, payload, { cwd: parent.cwd }), {
        cwd: parent.cwd,
        timeoutMs: FINAL_REVIEW_TEST_TIMEOUT_MS,
      });
      change = await this.collectChange(parent.cwd, payload);
      const evidence = renderFinalReviewEvidence({ job, workItem, payload, change, testRun });
      const review = await parent.runReview({ instructions: finalReviewInstructions(), evidence });
      reviewerCallId = review?.agentCallId ?? null;
      result = finalReviewResultFromVerdict(review?.verdict, { claims: review?.claims || [] });
    } catch (error) {
      // The review could not run: never hold the handoff on it.
      result = {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `The final review could not run (${String(error?.message || error).slice(0, 300)}); hand off when the change is complete.`,
      };
    } finally {
      parent.inFlight = false;
    }
    const reviewsRemaining = Math.max(0, FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT - prior.length - 1);
    const response = {
      ...result,
      declared_tests: testRun
        ? { command: testRun.command || null, status: testRun.status || null, reason: testRun.reason || null }
        : null,
      changed_files: Array.isArray(change?.files) ? change.files.map((file) => file.path) : [],
      reviews_remaining: reviewsRemaining,
    };
    this.record({
      work_item_id: parent.workItemId ?? null,
      job_id: parent.jobId ?? null,
      attempt_id: parent.attemptId ?? null,
      observation_type: FINAL_REVIEW_OBSERVATIONS.RESULT,
      summary: `final_review ${result.outcome}${result.findings?.length ? ` (${result.findings.length} finding(s))` : ""}`,
      detail: {
        agent_call_id: parent.agentCallId,
        attempt_id: parent.attemptId ?? null,
        outcome: result.outcome,
        finding_count: result.findings?.length || 0,
        reason: result.reason || null,
        reviewer_agent_call_id: reviewerCallId,
        test_status: testRun?.status || null,
        change_digest: change?.digest || null,
        changed_file_count: Array.isArray(change?.files) ? change.files.length : 0,
        duration_ms: Date.now() - startedAt,
      },
    });
    return response;
  }
}

export const finalReviewRuntime = new FinalReviewRuntime();

export function executeFinalReview(_args = {}, { context = {} } = {}) {
  return finalReviewRuntime.execute({ agentCallId: context.agentCallId });
}
