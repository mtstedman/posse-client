import { emptyMaterializedPathsForJob } from "../../handoff/functions/helpers/file-materialization.js";
import { isAdvisoryTestResult } from "../../worker/functions/helpers/verification-outcome.js";
import { renderTestStrictness } from "../../settings/functions/test-strictness.js";
import { testRunDiagnostics } from "../../worker/functions/helpers/test-failure-evidence.js";
import { finalReviewIdentity } from "../functions/final-review-authority.js";
import { completeFinalReview } from "../functions/final-review-completion.js";
import { finalReviewLogSummary } from "../functions/final-review-log-summary.js";
// FinalReviewRuntime — both sides of final_review.
//
// TrackedProviderClient registers each dev/fix agent call that was issued the
// tool, with a closure that runs the reviewer as a child provider call of that
// agent. The developer's final_review call runs the task's declared tests,
// builds the snapshot and waits for the reviewer's report. The reviewer
// reports with the same tool and waits in it: when the developer revises and
// calls again, the reviewer's waiting call returns only what changed since its
// report, so neither side starts over. An accepted pass saves completion and
// stops both provider calls. The reviewer is also released when the
// developer's call ends or the attempt's reviews are spent. One review runs at
// a time per agent call; an attempt has a fixed number of reviews.

import { getJob, getWorkItem } from "../../queue/functions/index.js";
import { getAgentCallById } from "../../queue/functions/agent-calls.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import {
  FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT,
  FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS,
  FINAL_REVIEW_OBSERVATIONS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_REVIEW_MODES,
  FINAL_REVIEW_REVIEWER_PARK_MS,
  FINAL_REVIEW_REVIEWER_STATUS,
  FINAL_REVIEW_REVIEWER_WALL_MS,
  FINAL_REVIEW_REVISION_MIN_REMAINING_MS,
  FINAL_REVIEW_TEST_TIMEOUT_MS,
} from "../../../catalog/final-review.js";
import {
  resolveFrozenTestPlan,
  runFrozenTestPlanOnce,
} from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  collectScopedChange,
  diffSinceReview,
  finalReviewCoreInstructions,
  renderFinalReviewEvidence,
  renderFinalReviewRevision,
  snapshotReviewedFiles,
} from "../functions/final-review-snapshot.js";
import {
  addedTestFiles,
  changedTestPlan,
  finalReviewCheckFindings,
  lineageTestFiles,
  mergeCheckFindings,
  runChangedFileChecks,
} from "../functions/final-review-checks.js";
import {
  finalReviewInfrastructureRetriesLeft,
  finalReviewResultFromReport,
  finalReviewResultFromVerdict,
  finalReviewResultsForAttempt,
  finalReviewPassedForCall,
  finalReviewReviewsRemaining,
  repeatedDeterministicReview,
  semanticFinalReviewResults,
} from "../functions/final-review-result.js";

const REVIEWER_DONE_INSTRUCTION = "The developer has finished with this review. End now with your terminal handoff carrying your latest verdict.";
const REVIEWER_WAITING_INSTRUCTION = "The developer is still working. Call final_review again to wait for the revision.";
const MODES = FINAL_REVIEW_REVIEW_MODES;

function finalReviewError(code, message) {
  return Object.assign(new Error(message), { code });
}

function completionReportFromArgs(args) {
  const report = args?.completion_report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const summary = String(report.summary || "").trim().slice(0, 4000);
  if (!summary) return null;
  const verification = (Array.isArray(report.verification) ? report.verification : [])
    .map(item => String(item || "").trim().slice(0, 300)).filter(Boolean).slice(0, 8);
  return { summary, verification };
}

function sameCompletionReport(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
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
    reviewerParkMs = FINAL_REVIEW_REVIEWER_PARK_MS,
    reviewerWallMs = FINAL_REVIEW_REVIEWER_WALL_MS,
    completePass = completeFinalReview,
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
    this.reviewerParkMs = reviewerParkMs;
    // The reviewer's own wall (final-review-reviewer.js); a parked reviewer
    // close to it is not handed a revision.
    this.reviewerWallMs = reviewerWallMs;
    this.completePass = completePass;
  }

  /**
   * @param {{ agentCallId: number, jobId: number, workItemId: number, attemptId: number, cwd: string, runReview: (input: { instructions: string, evidence: string, abortSignal: AbortSignal }) => Promise<{ verdict: any, claims?: any[], agentCallId?: number | null }> }} parent
   * @returns {() => void} unregister
   */
  registerParent(parent) {
    const agentCallId = Number(parent?.agentCallId);
    if (!Number.isSafeInteger(agentCallId) || agentCallId <= 0 || typeof parent?.runReview !== "function") {
      throw new Error("FinalReviewRuntime.registerParent requires agentCallId and runReview");
    }
    const entry = { ...parent, agentCallId, inFlight: false, reviewer: null, controller: new AbortController(), retiredReviewerCalls: new Set() };
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
      entry.controller.abort();
      this.#release(entry);
      if (this.parents.get(agentCallId) === entry) this.parents.delete(agentCallId);
    };
  }

  hasParkedReviewerCall(agentCallId) {
    const id = Number(agentCallId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    for (const parent of this.parents.values()) {
      if (parent.reviewer?.agentCallId === id && parent.reviewer.parked && !parent.reviewer.ended) return true;
    }
    return false;
  }

  /** `signal` aborts when the caller's tool call dies (its client disconnected). */
  async execute({ agentCallId, args = {}, signal = null } = {}) {
    const callId = Number(agentCallId);
    const parent = this.parents.get(callId);
    if (parent?.completed || finalReviewPassedForCall(callId)) {
      throw finalReviewError("FINAL_REVIEW_TERMINAL", "Final review passed; this agent call is complete and cannot run more tools.");
    }
    if (parent) {
      if (parent.inFlight) {
        throw finalReviewError("FINAL_REVIEW_IN_PROGRESS", "A final review is already running for this agent call; wait for its result.");
      }
      // Own the entire round, including identity reads and durable recording.
      parent.inFlight = true;
      const reviewSignal = signal ? AbortSignal.any([signal, parent.controller.signal]) : parent.controller.signal;
      const cancel = () => this.#release(parent);
      reviewSignal.addEventListener("abort", cancel, { once: true });
      try {
        if (reviewSignal.aborted) cancel();
        reviewSignal.throwIfAborted();
        return await this.#developerReview(parent, args, reviewSignal);
      } finally {
        reviewSignal.removeEventListener("abort", cancel);
        parent.inFlight = false;
      }
    }
    const reviewed = this.#parentReviewedBy(callId);
    if (reviewed?.entry) return await this.#reviewerReport(reviewed.entry, callId, args, { signal });
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
    if (!entry?.reviewer || entry.retiredReviewerCalls.has(callId) || entry.reviewer.ended || entry.reviewer.agentCallId != null) return { orphan: true };
    entry.reviewer.agentCallId = callId;
    return { entry };
  }

  async #developerReview(parent, args, signal) {
    const prior = finalReviewResultsForAttempt({ jobId: parent.jobId, attemptId: parent.attemptId });
    const semanticPrior = semanticFinalReviewResults(prior);
    if (Object.hasOwn(args, "completion_report")) parent.completionReport = completionReportFromArgs(args);
    const completionReport = parent.completionReport || null;
    let currentIdentity = null;
    try {
      const job = getJob(parent.jobId);
      if (job) currentIdentity = await this.identify(parent.cwd, parseJobPayload(job), { jobId: job.id });
    } catch { /* a fresh review will report the identity failure */ }
    signal.throwIfAborted();
    const unchanged = prior.at(-1);
    if (unchanged?.review_mode === MODES.UNCHANGED && currentIdentity === unchanged.review_identity
      && sameCompletionReport(completionReport, unchanged.completion_report)) {
      this.#release(parent);
      return { outcome: FINAL_REVIEW_OUTCOMES.FINDINGS, findings: unchanged.findings || [],
        reason: unchanged.reason, reviews_remaining: finalReviewReviewsRemaining(prior) };
    }
    const repeated = repeatedDeterministicReview(prior, currentIdentity);
    if (repeated && currentIdentity) {
      this.#release(parent);
      return { outcome: FINAL_REVIEW_OUTCOMES.FINDINGS, findings: repeated.findings || [],
        reason: "The same deterministic failure was observed twice on unchanged work; hand off so the existing recovery path can act on it.",
        reviews_remaining: finalReviewReviewsRemaining(prior) };
    }
    if (semanticPrior.length >= FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT) {
      this.#release(parent);
      return {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `This attempt's ${FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT} final reviews are used; hand off when the change is complete.`,
        reviews_remaining: 0,
      };
    }
    if (finalReviewInfrastructureRetriesLeft(prior) === 0) {
      this.#release(parent);
      return {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `The final review could not run ${FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS} times in this attempt; hand off when the change is complete, and the assessment will verify it.`,
        reviews_remaining: finalReviewReviewsRemaining(prior),
      };
    }
    const startedAt = Date.now();
    let result;
    let testRun = null;
    let changedTestRun = null;
    let checks = null;
    let change = null;
    let reviewerCallId = null;
    let reviewIdentity = null;
    let mode = MODES.FRESH;
    let verdictObtained = false;
    try {
      const job = getJob(parent.jobId);
      if (!job) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", `Job #${parent.jobId} no longer exists`);
      const payload = parseJobPayload(job);
      // A changed runner transcript is not an implementation revision. Compare
      // the full scoped bytes and task contract before spending another check
      // or reviewer call, including when the first submission had no diff.
      // Any earlier rejection of these exact bytes counts, not only the last:
      // reverting to a rejected candidate never buys a new verdict.
      try { reviewIdentity = await this.identify(parent.cwd, payload, { jobId: job.id }); } catch { /* ordinary review reports unavailable identity */ }
      signal.throwIfAborted();
      const rejected = reviewIdentity ? semanticPrior.findLast((review) =>
        review.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS && review.review_identity === reviewIdentity
        && sameCompletionReport(completionReport, review.completion_report)) : null;
      if (rejected) return this.#returnUnchangedReview(parent, rejected, prior);
      const workItem = getWorkItem(job.work_item_id);
      const declaredPlan = this.resolveTestPlan(job, payload, { cwd: parent.cwd });
      testRun = await this.runTestPlan(declaredPlan, {
        cwd: parent.cwd,
        timeoutMs: FINAL_REVIEW_TEST_TIMEOUT_MS,
      });
      signal.throwIfAborted();
      const placeholders = new Set(await emptyMaterializedPathsForJob(job.id,
        payload.scope_generation ?? payload._materialization_generation ?? 1, parent.cwd));
      change = await this.collectChange(parent.cwd, payload, { ignorePaths: placeholders });
      // The assessment after handoff runs these too; running them here lets
      // the developer fix what they find in the same attempt. The change is
      // the lineage's, as in the post-change receipt: a fix also runs the test
      // files its root committed.
      const lineage = await this.lineageTests(job, payload, parent.cwd);
      const lineagePaths = Array.isArray(lineage) ? lineage : Array.isArray(lineage?.paths) ? lineage.paths : [];
      const changedPlan = changedTestPlan(job, payload, change, declaredPlan, {
        cwd: parent.cwd,
        resolvePlan: this.resolveTestPlan,
        lineagePaths: lineagePaths.filter((file) => !placeholders.has(file)),
      });
      signal.throwIfAborted();
      changedTestRun = changedPlan
        ? await this.runTestPlan(changedPlan, { cwd: parent.cwd, timeoutMs: FINAL_REVIEW_TEST_TIMEOUT_MS })
        : null;
      signal.throwIfAborted();
      checks = this.runChecks(parent.cwd, change);
      try { reviewIdentity = await this.identify(parent.cwd, payload, { jobId: job.id }); } catch { reviewIdentity = null; /* unavailable identities cannot authorize assessment */ }
      signal.throwIfAborted();
      // Only failures the change provably introduced skip the reviewer; any
      // other failure is evidence it judges.
      const deterministicFindings = finalReviewCheckFindings({ checks, changedTestRun,
        addedTestPaths: addedTestFiles(change, lineage) });
      if (deterministicFindings.length > 0) {
        // These failures are actionable without a semantic judgment. Return
        // them to the developer and retain the review budget for its repair.
        mode = MODES.DETERMINISTIC;
        result = { outcome: FINAL_REVIEW_OUTCOMES.FINDINGS, findings: deterministicFindings };
      } else {
        let session = parent.reviewer;
        if (session && !session.ended && session.waitingForRevision
          && (session.startedAt ?? 0) + this.reviewerWallMs - Date.now() < FINAL_REVIEW_REVISION_MIN_REMAINING_MS) {
          // Too little of the parked reviewer's wall is left to judge a
          // revision: release it and judge the change with a fresh reviewer.
          this.#release(parent);
          session = null;
        }
        let outcome;
        if (session && !session.ended && session.waitingForRevision) {
          // The reviewer is waiting in its own final_review call: hand it only
          // what changed since its report.
          mode = MODES.REVISION;
          const snapshot = this.snapshotFiles(parent.cwd, payload, change, { alsoPaths: [...session.snapshot.keys()] });
          const delta = diffSinceReview(session.snapshot, snapshot, change);
          session.revision += 1;
          session.pendingSnapshot = snapshot;
          session.revisionExpected = true;
          // Set only when the reviewer's call actually takes the revision.
          session.revisionDelivered = false;
          outcome = this.#awaitReport(session);
          const revision = {
            status: FINAL_REVIEW_REVIEWER_STATUS.REVISED,
            revision: session.revision,
            review: [renderTestStrictness({ projectDir: parent.cwd }),
              renderFinalReviewRevision({ revision: session.revision, testRun, delta, changedTestRun, checks, completionReport })].join("\n\n"),
          };
          const parked = session.parked;
          session.parked = null;
          if (parked) parked.resolve(revision);
          else session.pendingRevision = revision;
        } else {
          const evidence = [renderTestStrictness({ projectDir: parent.cwd }),
            renderFinalReviewEvidence({ job, workItem, payload, change, testRun, changedTestRun, checks, completionReport })].join("\n\n");
          const fresh = this.#startReviewer(parent, {
            instructions: finalReviewCoreInstructions(),
            evidence,
            snapshot: this.snapshotFiles(parent.cwd, payload, change),
          });
          outcome = this.#awaitReport(fresh);
        }
        const reported = await outcome;
        signal.throwIfAborted();
        reviewerCallId = reported.reviewerCallId;
        if (reported.infrastructure) {
          mode = MODES.INFRASTRUCTURE;
          result = reported.result;
        } else {
          verdictObtained = true;
          result = mergeCheckFindings(reported.result, deterministicFindings);
        }
      }
      if (mode !== MODES.INFRASTRUCTURE) {
        if (result.outcome === FINAL_REVIEW_OUTCOMES.PASS
          && !isAdvisoryTestResult(changedTestRun, { projectDir: parent.cwd })
          && ["unavailable", "infrastructure_error", "invalid", "timed_out", "skipped"].includes(changedTestRun?.status)) {
          result = { ...result, outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
            reason: `Changed tests did not establish complete coverage (${changedTestRun.reason || changedTestRun.status}); restore their verification prerequisites.` };
        }
        if (!reviewIdentity) {
          result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Cannot bind final review to the scoped workspace; verification is blocked." };
        } else if (reviewIdentity !== await this.identify(parent.cwd, payload, { jobId: job.id })) {
          result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Scoped files changed during review; review the current change again." };
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      // No reviewer verdict: an infrastructure round, which spends no review.
      if (!verdictObtained) mode = MODES.INFRASTRUCTURE;
      result = {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `The final review could not run (${String(error?.message || error).slice(0, 300)})`,
      };
    }
    const recorded = [...prior, { review_mode: mode }];
    const reviewsRemaining = finalReviewReviewsRemaining(recorded);
    if (mode === MODES.INFRASTRUCTURE) {
      this.#release(parent);
      // The handoff waits for a bounded number of these rounds, then proceeds
      // to the ordinary assessment.
      result = { ...result, reason: `${result.reason}; ${finalReviewInfrastructureRetriesLeft(recorded) > 0
        ? "call final_review again"
        : "hand off when the change is complete, and the assessment will verify it"}.` };
    }
    if (reviewsRemaining === 0) this.#release(parent);
    const response = {
      ...result,
      declared_tests: testRunDiagnostics(testRun),
      changed_tests: testRunDiagnostics(changedTestRun),
      changed_file_checks: checks ? { status: checks.status, summary: checks.summary || null } : null,
      changed_files: Array.isArray(change?.files) ? change.files.map((file) => file.path) : [],
      completion_report: completionReport,
      reviews_remaining: reviewsRemaining,
    };
    this.record({
      work_item_id: parent.workItemId ?? null,
      job_id: parent.jobId ?? null,
      attempt_id: parent.attemptId ?? null,
      observation_type: FINAL_REVIEW_OBSERVATIONS.RESULT,
      summary: finalReviewLogSummary({ result }),
      detail: {
        agent_call_id: parent.agentCallId,
        attempt_id: parent.attemptId ?? null,
        outcome: result.outcome,
        review_identity: reviewIdentity,
        completion_report: completionReport,
        summary: result.summary || null,
        finding_count: result.findings?.length || 0,
        findings: result.findings || [],
        repair: result.repair || null,
        declared_tests: response.declared_tests,
        changed_tests: response.changed_tests,
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
    if (result.outcome === FINAL_REVIEW_OUTCOMES.PASS) {
      parent.completed = true;
      this.#release(parent);
      this.completePass({ agentCallId: parent.agentCallId, reviewerAgentCallId: reviewerCallId,
        cwd: parent.cwd, summary: result.summary });
    }
    return response;
  }

  #returnUnchangedReview(parent, rejected, prior) {
    const latest = semanticFinalReviewResults(prior).at(-1);
    const reason = latest?.id === rejected.id
      ? "The scoped code is unchanged since the failed final review. Existing findings remain; no second review was run. Hand off for repair when ready."
      : "The scoped code matches a candidate an earlier final review rejected. Its findings remain; no new review was run. Hand off for repair when ready.";
    const result = { outcome: FINAL_REVIEW_OUTCOMES.FINDINGS,
      reason, findings: rejected.findings || [],
      reviews_remaining: finalReviewReviewsRemaining(prior) };
    this.record({ work_item_id: parent.workItemId ?? null, job_id: parent.jobId,
      attempt_id: parent.attemptId, observation_type: FINAL_REVIEW_OBSERVATIONS.RESULT,
      summary: reason, detail: { ...result, agent_call_id: parent.agentCallId,
        review_identity: rejected.review_identity, reviewer_agent_call_id: rejected.reviewer_agent_call_id,
        review_mode: MODES.UNCHANGED, completion_report: rejected.completion_report || null,
        previous_review_id: rejected.id } });
    this.#release(parent);
    return result;
  }

  #startReviewer(parent, { instructions, evidence, snapshot }) {
    const session = {
      controller: new AbortController(),
      agentCallId: null,
      startedAt: Date.now(),
      ended: false,
      released: false,
      awaitingReport: null,
      parked: null,
      pendingRevision: null,
      waitingForRevision: false,
      revisionExpected: false,
      revisionDelivered: false,
      snapshot: null,
      pendingSnapshot: snapshot,
      revision: 0,
      run: null,
    };
    parent.reviewer = session;
    session.run = Promise.resolve()
      .then(() => {
        session.controller.signal.throwIfAborted();
        return parent.runReview({ instructions, evidence, abortSignal: session.controller.signal });
      })
      .then((review) => ({ review }), (error) => ({ error }))
      .then((ended) => {
        // The reviewer ended (its terminal handoff, a provider error, its
        // wall): a call it left parked answers done, and the developer's next
        // call starts a fresh reviewer.
        session.ended = true;
        const endedCallId = ended.review?.agentCallId ?? session.agentCallId;
        if (endedCallId != null) parent.retiredReviewerCalls.add(endedCallId);
        session.pendingRevision = null;
        session.awaitingReport = null;
        if (session.parked) {
          const parked = session.parked;
          session.parked = null;
          parked.resolve({ status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION });
        }
        if (parent.reviewer === session) parent.reviewer = null;
        return ended;
      });
    return session;
  }

  // The reviewer's next report, or — when it ends without one, as a reviewer
  // without the tool does — the verdict from its terminal handoff. A reviewer
  // handed a revision must report on it with final_review: its terminal
  // verdict may predate the revision, so it never authorizes the revised
  // candidate, and the round obtained no verdict.
  #awaitReport(session) {
    const report = deferred();
    session.awaitingReport = report;
    return Promise.race([
      report.promise,
      session.run.then((ended) => {
        if (ended.error) throw ended.error;
        const reviewerCallId = ended.review?.agentCallId ?? session.agentCallId ?? null;
        if (session.revisionExpected) return {
          infrastructure: true,
          result: { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [],
            reason: session.revisionDelivered
              ? "the reviewer ended without reporting on the revised candidate"
              : "the reviewer ended before receiving the revised candidate" },
          reviewerCallId,
        };
        return {
          result: finalReviewResultFromVerdict(ended.review?.verdict, { claims: ended.review?.claims || [] }),
          reviewerCallId,
        };
      }),
    ]);
  }

  async #reviewerReport(parent, callId, args, { signal = null } = {}) {
    const session = parent.reviewer;
    if (!session || session.released || session.ended) {
      return { status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION };
    }
    if (session.pendingRevision) {
      const revision = session.pendingRevision;
      session.pendingRevision = null;
      session.revisionDelivered = true;
      return revision;
    }
    const waiting = session.awaitingReport;
    if (!waiting) {
      if (session.waitingForRevision) return this.#parkReviewer(session, { signal });
      return { status: "not_waiting", error: "Your report was already delivered; wait in final_review for the developer's revision." };
    }
    const mapped = finalReviewResultFromReport(args);
    if (mapped.error) return { status: "invalid_report", error: mapped.error };
    session.awaitingReport = null;
    session.snapshot = session.pendingSnapshot;
    session.pendingSnapshot = null;
    session.waitingForRevision = true;
    waiting.resolve({ result: mapped, reviewerCallId: callId });
    return this.#parkReviewer(session, { signal });
  }

  // The reviewer waits in its final_review call for the developer's revision.
  // The wait ends with the revision, a periodic "still working" before the
  // client's deadline, or done on release. When the call itself dies (its
  // client disconnected), it is unparked so a later revision waits for the
  // reviewer's next call instead of resolving into nothing.
  async #parkReviewer(session, { signal = null } = {}) {
    if (session.parked) {
      return { status: "not_waiting", error: "A final_review call is already waiting for the developer's revision; wait for that call to return." };
    }
    const parked = deferred();
    session.parked = parked;
    const unpark = (value) => {
      if (session.parked !== parked) return;
      session.parked = null;
      parked.resolve(value);
    };
    const waiting = { status: FINAL_REVIEW_REVIEWER_STATUS.WAITING, instruction: REVIEWER_WAITING_INSTRUCTION };
    const timer = setTimeout(() => unpark(waiting), this.reviewerParkMs);
    const cancel = () => unpark(waiting);
    if (signal?.aborted) cancel();
    else signal?.addEventListener?.("abort", cancel, { once: true });
    try {
      const value = await parked.promise;
      if (value?.status === FINAL_REVIEW_REVIEWER_STATUS.REVISED) {
        if (signal?.aborted) {
          // Resolved into a call that died before returning it: keep it for
          // the reviewer's next call.
          if (!session.ended && !session.released && !session.pendingRevision) session.pendingRevision = value;
        } else {
          session.revisionDelivered = true;
        }
      }
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", cancel);
    }
  }

  #release(parent) {
    const session = parent?.reviewer;
    if (!session) return;
    session.released = true;
    if (session.agentCallId != null) parent.retiredReviewerCalls.add(session.agentCallId);
    if (session.awaitingReport) {
      const report = session.awaitingReport;
      session.awaitingReport = null;
      report.resolve({ infrastructure: true, reviewerCallId: session.agentCallId,
        result: { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "the reviewer session was released before reporting" } });
      session.controller.abort();
    }
    if (session.parked) {
      const parked = session.parked;
      session.parked = null;
      parked.resolve({ status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION });
    }
    parent.reviewer = null;
  }
}

export const finalReviewRuntime = new FinalReviewRuntime();

export function executeFinalReview(args = {}, { context = {}, signal = null } = {}) {
  return finalReviewRuntime.execute({ agentCallId: context.agentCallId, args: args || {}, signal });
}
