import { finalReviewIdentity } from "../functions/final-review-authority.js";
// FinalReviewRuntime — both sides of final_review.
//
// TrackedProviderClient registers each dev/fix agent call that was issued the
// tool, with a closure that runs the reviewer as a child provider call of that
// agent. The developer's final_review call runs the task's declared tests,
// builds the snapshot and waits for the reviewer's report. The reviewer
// reports with the same tool and waits in it: when the developer revises and
// calls again, the reviewer's waiting call returns only what changed since its
// report, so neither side starts over. The reviewer is released when the
// developer's call ends or the attempt's reviews are spent. One review runs at
// a time per agent call; an attempt has a fixed number of reviews.

import { getJob, getWorkItem } from "../../queue/functions/index.js";
import { getAgentCallById } from "../../queue/functions/agent-calls.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import {
  FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT,
  FINAL_REVIEW_OBSERVATIONS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_REVIEWER_STATUS,
  FINAL_REVIEW_TEST_TIMEOUT_MS,
} from "../../../catalog/final-review.js";
import {
  resolveFrozenTestPlan,
  runFrozenTestPlanOnce,
} from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  collectScopedChange,
  diffSinceReview,
  finalReviewInstructions,
  renderFinalReviewEvidence,
  renderFinalReviewRevision,
  snapshotReviewedFiles,
} from "../functions/final-review-snapshot.js";
import {
  changedTestPlan,
  finalReviewCheckFindings,
  lineageTestFiles,
  mergeCheckFindings,
  runChangedFileChecks,
} from "../functions/final-review-checks.js";
import {
  finalReviewResultFromReport,
  finalReviewResultFromVerdict,
  finalReviewResultsForAttempt,
} from "../functions/final-review-result.js";

const REVIEWER_DONE_INSTRUCTION = "The developer has finished with this review. End now with your terminal handoff carrying your latest verdict.";

function finalReviewError(code, message) {
  return Object.assign(new Error(message), { code });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function finalReviewParentOf(agentCallId) {
  const row = getAgentCallById(agentCallId);
  return row?.child_kind === AGENT_CALL_CHILD_KINDS.FINAL_REVIEW ? row.parent_agent_call_id : null;
}

export class FinalReviewRuntime {
  constructor({
    collectChange = collectScopedChange,
    identify = finalReviewIdentity,
    resolveTestPlan = resolveFrozenTestPlan,
    runTestPlan = runFrozenTestPlanOnce,
    snapshotFiles = snapshotReviewedFiles,
    lookupReviewerParent = finalReviewParentOf,
    record = recordObservation,
    runChecks = runChangedFileChecks,
    lineageTests = lineageTestFiles,
  } = {}) {
    this.parents = new Map();
    this.identify = identify;
    this.collectChange = collectChange;
    this.resolveTestPlan = resolveTestPlan;
    this.runTestPlan = runTestPlan;
    this.snapshotFiles = snapshotFiles;
    this.lookupReviewerParent = lookupReviewerParent;
    this.record = record;
    this.runChecks = runChecks;
    this.lineageTests = lineageTests;
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
    const entry = { ...parent, agentCallId, inFlight: false, reviewer: null };
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
      // The developer's call ended (handoff, failure or dead letter): a
      // waiting reviewer finishes instead of waiting out its deadline.
      this.#release(entry);
      if (this.parents.get(agentCallId) === entry) this.parents.delete(agentCallId);
    };
  }

  async execute({ agentCallId, args = {} } = {}) {
    const callId = Number(agentCallId);
    const parent = this.parents.get(callId);
    if (parent) return await this.#developerReview(parent);
    const reviewed = this.#parentReviewedBy(callId);
    if (reviewed?.entry) return await this.#reviewerReport(reviewed.entry, callId, args);
    // A final-review child whose developer already finished: tell it to end.
    if (reviewed?.orphan) return { status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION };
    throw finalReviewError("FINAL_REVIEW_UNAVAILABLE", "final_review is not available for this agent call; hand off when the change is complete.");
  }

  #parentReviewedBy(callId) {
    if (!Number.isSafeInteger(callId) || callId <= 0) return null;
    for (const entry of this.parents.values()) {
      if (entry.reviewer && entry.reviewer.agentCallId === callId) return { entry };
    }
    let parentId = null;
    try {
      parentId = Number(this.lookupReviewerParent(callId));
    } catch {
      return null;
    }
    if (!Number.isSafeInteger(parentId) || parentId <= 0) return null;
    const entry = this.parents.get(parentId);
    if (!entry?.reviewer || entry.reviewer.ended || entry.reviewer.agentCallId != null) return { orphan: true };
    entry.reviewer.agentCallId = callId;
    return { entry };
  }

  async #developerReview(parent) {
    if (parent.inFlight) {
      throw finalReviewError("FINAL_REVIEW_IN_PROGRESS", "A final review is already running for this agent call; wait for its result.");
    }
    const prior = finalReviewResultsForAttempt({ jobId: parent.jobId, attemptId: parent.attemptId });
    if (prior.length >= FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT) {
      this.#release(parent);
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
    let changedTestRun = null;
    let checks = null;
    let change = null;
    let reviewerCallId = null;
    let reviewIdentity = null;
    let mode = "fresh";
    try {
      const job = getJob(parent.jobId);
      if (!job) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", `Job #${parent.jobId} no longer exists`);
      const payload = parseJobPayload(job);
      const workItem = getWorkItem(job.work_item_id);
      const declaredPlan = this.resolveTestPlan(job, payload, { cwd: parent.cwd });
      testRun = await this.runTestPlan(declaredPlan, {
        cwd: parent.cwd,
        timeoutMs: FINAL_REVIEW_TEST_TIMEOUT_MS,
      });
      change = await this.collectChange(parent.cwd, payload);
      // The assessment after handoff runs these too; running them here lets
      // the developer fix what they find in the same attempt. The change is
      // the lineage's, as in the post-change receipt: a fix also runs the test
      // files its root committed.
      const changedPlan = changedTestPlan(job, payload, change, declaredPlan, {
        cwd: parent.cwd,
        resolvePlan: this.resolveTestPlan,
        lineagePaths: await this.lineageTests(job, payload, parent.cwd),
      });
      changedTestRun = changedPlan
        ? await this.runTestPlan(changedPlan, { cwd: parent.cwd, timeoutMs: FINAL_REVIEW_TEST_TIMEOUT_MS })
        : null;
      checks = this.runChecks(parent.cwd, change);
      try { reviewIdentity = await this.identify(parent.cwd, payload); } catch { /* unavailable identities cannot authorize assessment */ }
      const session = parent.reviewer;
      let outcome;
      if (session && !session.ended && session.parked) {
        // The reviewer is waiting in its own final_review call: hand it only
        // what changed since its report.
        mode = "revision";
        const snapshot = this.snapshotFiles(parent.cwd, payload, change, { alsoPaths: [...session.snapshot.keys()] });
        const delta = diffSinceReview(session.snapshot, snapshot, change);
        session.revision += 1;
        session.pendingSnapshot = snapshot;
        outcome = this.#awaitReport(session);
        const parked = session.parked;
        session.parked = null;
        parked.resolve({
          status: FINAL_REVIEW_REVIEWER_STATUS.REVISED,
          revision: session.revision,
          review: renderFinalReviewRevision({ revision: session.revision, testRun, delta, changedTestRun, checks }),
        });
      } else {
        const evidence = renderFinalReviewEvidence({ job, workItem, payload, change, testRun, changedTestRun, checks });
        const fresh = this.#startReviewer(parent, {
          instructions: finalReviewInstructions(),
          evidence,
          snapshot: this.snapshotFiles(parent.cwd, payload, change),
        });
        outcome = this.#awaitReport(fresh);
      }
      ({ result, reviewerCallId } = await outcome);
      result = mergeCheckFindings(result, finalReviewCheckFindings({ checks, changedTestRun }));
      if ([testRun, changedTestRun].some((run) => run && ["infrastructure_error", "unavailable", "invalid"].includes(run.status))) {
        result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Required test verification could not run; repair the test runner before completing this change." };
      }
      if (!reviewIdentity) {
        result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Cannot bind final review to the scoped workspace; verification is blocked." };
      } else if (reviewIdentity !== await this.identify(parent.cwd, payload)) {
        result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Scoped files changed during review; review the current change again." };
      }
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
    if (reviewsRemaining === 0) this.#release(parent);
    const response = {
      ...result,
      declared_tests: testRun
        ? { command: testRun.command || null, status: testRun.status || null, reason: testRun.reason || null }
        : null,
      changed_tests: changedTestRun
        ? { command: changedTestRun.command || null, status: changedTestRun.status || null, reason: changedTestRun.reason || null }
        : null,
      changed_file_checks: checks ? { status: checks.status, summary: checks.summary || null } : null,
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
        review_identity: reviewIdentity,
        summary: result.summary || null,
        finding_count: result.findings?.length || 0,
        reason: result.reason || null,
        reviewer_agent_call_id: reviewerCallId,
        review_mode: mode,
        test_status: testRun?.status || null,
        changed_tests_status: changedTestRun?.status || null,
        changed_file_checks_status: checks?.status || null,
        change_digest: change?.digest || null,
        changed_file_count: Array.isArray(change?.files) ? change.files.length : 0,
        duration_ms: Date.now() - startedAt,
      },
    });
    return response;
  }

  #startReviewer(parent, { instructions, evidence, snapshot }) {
    const session = {
      agentCallId: null,
      ended: false,
      released: false,
      awaitingReport: null,
      parked: null,
      snapshot: null,
      pendingSnapshot: snapshot,
      revision: 0,
      run: null,
    };
    parent.reviewer = session;
    session.run = Promise.resolve()
      .then(() => parent.runReview({ instructions, evidence }))
      .then((review) => ({ review }), (error) => ({ error }))
      .then((ended) => {
        session.ended = true;
        if (parent.reviewer === session) parent.reviewer = null;
        return ended;
      });
    return session;
  }

  // The reviewer's next report, or — when it ends without one, as a reviewer
  // without the tool does — the verdict from its terminal handoff.
  #awaitReport(session) {
    const report = deferred();
    session.awaitingReport = report;
    return Promise.race([
      report.promise,
      session.run.then((ended) => {
        if (ended.error) throw ended.error;
        return {
          result: finalReviewResultFromVerdict(ended.review?.verdict, { claims: ended.review?.claims || [] }),
          reviewerCallId: ended.review?.agentCallId ?? session.agentCallId ?? null,
        };
      }),
    ]);
  }

  async #reviewerReport(parent, callId, args) {
    const session = parent.reviewer;
    if (!session || session.released) {
      return { status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION };
    }
    const waiting = session.awaitingReport;
    if (!waiting) {
      return { status: "not_waiting", error: "Your report was already delivered; wait in final_review for the developer's revision." };
    }
    const mapped = finalReviewResultFromReport(args);
    if (mapped.error) return { status: "invalid_report", error: mapped.error };
    session.awaitingReport = null;
    session.snapshot = session.pendingSnapshot;
    session.pendingSnapshot = null;
    const parked = deferred();
    session.parked = parked;
    waiting.resolve({ result: mapped, reviewerCallId: callId });
    return await parked.promise;
  }

  #release(parent) {
    const session = parent?.reviewer;
    if (!session) return;
    session.released = true;
    if (session.parked) {
      const parked = session.parked;
      session.parked = null;
      parked.resolve({ status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION });
    }
    parent.reviewer = null;
  }
}

export const finalReviewRuntime = new FinalReviewRuntime();

export function executeFinalReview(args = {}, { context = {} } = {}) {
  return finalReviewRuntime.execute({ agentCallId: context.agentCallId, args: args || {} });
}
