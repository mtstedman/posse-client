import { finalReviewVerificationIdentity } from "../functions/final-review-verification.js";
import { runChangedFileChecksAsync } from "../functions/final-review-checks-async.js";
import { emptyMaterializedPathsForJob } from "../../handoff/functions/helpers/file-materialization.js";
import { isAdvisoryTestResult } from "../../worker/functions/helpers/verification-outcome.js";
import { renderTestStrictness } from "../../settings/functions/test-strictness.js";
import { testRunDiagnostics } from "../../worker/functions/helpers/test-failure-evidence.js";
import { finalReviewContractIdentity, finalReviewIdentity } from "../functions/final-review-authority.js";
import { finalReviewFindingCorrection } from "../functions/final-review-boundaries.js";
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
  FINAL_REVIEW_MAX_DETERMINISTIC_ROUNDS,
  FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS,
  FINAL_REVIEW_MAX_INVALID_REPORTS,
  FINAL_REVIEW_OBSERVATIONS,
  FINAL_REVIEW_OUTCOMES,
  FINAL_REVIEW_REVIEW_MODES,
  FINAL_REVIEW_REVIEWER_MIN_ROUND_MS,
  FINAL_REVIEW_REVIEWER_PARK_MS,
  FINAL_REVIEW_REVIEWER_STATUS,
  FINAL_REVIEW_REVIEWER_WALL_MS,
  FINAL_REVIEW_REVISION_MIN_REMAINING_MS,
  FINAL_REVIEW_TEST_TIMEOUT_MS,
  FINAL_REVIEW_TIMEOUT_MS,
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
} from "../functions/final-review-checks.js";
import {
  finalReviewDeterministicRetriesLeft,
  finalReviewInfrastructureRetriesLeft,
  finalReviewResultFromReport,
  finalReviewResultFromVerdict,
  finalReviewResultsForAttempt,
  finalReviewCompletedForCall,
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
    verificationIdentity = finalReviewVerificationIdentity,
    resolveTestPlan = resolveFrozenTestPlan,
    runTestPlan = runFrozenTestPlanOnce,
    snapshotFiles = snapshotReviewedFiles,
    lookupReviewerParent = finalReviewParentOf,
    record = recordObservation,
    runChecks = runChangedFileChecksAsync,
    lineageTests = lineageTestFiles,
    reviewerParkMs = FINAL_REVIEW_REVIEWER_PARK_MS,
    reviewerWallMs = FINAL_REVIEW_REVIEWER_WALL_MS,
    reviewTimeoutMs = FINAL_REVIEW_TIMEOUT_MS,
    reviewerMinRoundMs = FINAL_REVIEW_REVIEWER_MIN_ROUND_MS,
    completePass = completeFinalReview,
    checkFindingBoundary = finalReviewFindingCorrection,
    now = Date.now,
  } = {}) {
    this.parents = new Map();
    this.identify = identify;
    this.verificationIdentity = verificationIdentity;
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
    this.reviewTimeoutMs = reviewTimeoutMs;
    // The reviewer's floor within a round, never more than a quarter of the
    // round so a shortened round still funds its stages (catalog: 10 of 40 min).
    this.reviewerMinRoundMs = Math.min(reviewerMinRoundMs, Math.floor(reviewTimeoutMs / 4));
    this.completePass = completePass;
    this.checkFindingBoundary = checkFindingBoundary;
    // The round clock; tests inject one to drive stage budgets.
    this.now = now;
  }

  /**
   * @param {{ agentCallId: number, jobId: number, workItemId: number, attemptId: number, cwd: string, runReview: (input: { instructions: string, evidence: string, abortSignal: AbortSignal, onAgentCallCreated: (id: number) => void }) => Promise<{ verdict: any, claims?: any[], agentCallId?: number | null }> }} parent
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
    if (parent?.completed || finalReviewCompletedForCall(callId)) {
      throw finalReviewError("FINAL_REVIEW_TERMINAL", "Final review completed; this agent call is complete and cannot run more tools.");
    }
    if (parent) {
      if (parent.inFlight) {
        throw finalReviewError("FINAL_REVIEW_IN_PROGRESS", "A final review is already running for this agent call; wait for its result.");
      }
      // Own the entire round, including identity reads and durable recording.
      parent.inFlight = true;
      if (Object.hasOwn(args, "blocker")) {
        try {
          signal?.throwIfAborted();
          if (typeof args.blocker !== "string" || !args.blocker.trim() || args.blocker.length > 1000) {
            throw finalReviewError("FINAL_REVIEW_INVALID_REPORT", "blocker must be a non-empty string of at most 1000 characters.");
          }
          if (Object.hasOwn(args, "verdict") || Object.hasOwn(args, "findings")) {
            throw finalReviewError("FINAL_REVIEW_INVALID_REPORT", "A developer blocker cannot include a reviewer verdict or findings.");
          }
          const blocker = args.blocker.trim();
          const response = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, reason: blocker, findings: [], developer_blocked: true };
          this.completePass({ agentCallId: parent.agentCallId, reviewerAgentCallId: parent.reviewer?.agentCallId,
            cwd: parent.cwd, blocker, recordResult: () => {
              if (this.record({ job_id: parent.jobId, work_item_id: parent.workItemId ?? null,
                attempt_id: parent.attemptId, observation_type: FINAL_REVIEW_OBSERVATIONS.RESULT,
                summary: `final_review BLOCKED: ${blocker}`, detail: { ...response, agent_call_id: parent.agentCallId,
                  attempt_id: parent.attemptId, reviewer_agent_call_id: parent.reviewer?.agentCallId ?? null,
                  review_identity: null } }) === false) {
                throw new Error("Could not persist the blocked final-review result");
              }
            } });
          parent.completed = true;
          parent.pendingReview = null;
          parent.reviewer?.controller.abort();
          this.#release(parent);
          return response;
        } finally { parent.inFlight = false; }
      }
      const reviewSignal = AbortSignal.any([parent.controller.signal,
        AbortSignal.timeout(this.reviewTimeoutMs), ...(signal ? [signal] : [])]);
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
    if (parent.pendingReview) {
      const pending = parent.pendingReview;
      if ((pending.response.outcome === FINAL_REVIEW_OUTCOMES.PASS || pending.verificationBlocked)
        && (!currentIdentity || currentIdentity !== pending.observation.detail.review_identity
          || !sameCompletionReport(completionReport, pending.response.completion_report))) {
        const reason = "The candidate changed before its passing review could be saved; review the current change again.";
        pending.observation.summary = reason;
        pending.response = { ...pending.response, outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, reason };
        pending.observation.detail = { ...pending.observation.detail, outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, reason };
        pending.verificationBlocked = false;
        delete pending.observation.detail.verification_blocked;
      }
      return this.#saveReview(parent, pending);
    }
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
    if (finalReviewDeterministicRetriesLeft(prior) === 0) {
      this.#release(parent);
      return {
        outcome: FINAL_REVIEW_OUTCOMES.BLOCKED,
        findings: [],
        reason: `This attempt's ${FINAL_REVIEW_MAX_DETERMINISTIC_ROUNDS} deterministic verification rounds are used; hand off for assessment of the current candidate. Existing failures are not approved.`,
        reviews_remaining: finalReviewReviewsRemaining(prior),
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
    const startedAt = this.now();
    // Each stage before the reviewer draws its timeout from what remains of
    // the round above the reviewer's floor, capped at the per-stage limit. A
    // stage the budget cannot fund ends the round as infrastructure rather
    // than running into the round wall with the reviewer unstarted.
    const stageTimeoutMs = (stage) => {
      const remainingMs = this.reviewTimeoutMs - (this.now() - startedAt) - this.reviewerMinRoundMs;
      if (remainingMs <= 0) {
        throw finalReviewError("FINAL_REVIEW_ROUND_BUDGET",
          `the round budget cannot fund ${stage} and still leave the reviewer ${Math.ceil(this.reviewerMinRoundMs / 1000)} s`);
      }
      return Math.min(FINAL_REVIEW_TEST_TIMEOUT_MS, remainingMs);
    };
    let result;
    let testRun = null;
    let declaredPlan = null;
    let changedPlan = null;
    let verificationIdentity = null;
    let changedTestRun = null;
    let checks = null;
    let change = null;
    let reviewerCallId = null;
    let reviewIdentity = null;
    let mode = MODES.FRESH;
    let verdictObtained = false;
    let verificationCandidateValid = false;
    try {
      const job = getJob(parent.jobId);
      if (!job) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", `Job #${parent.jobId} no longer exists`);
      const payload = parseJobPayload(job);
      const contractIdentity = finalReviewContractIdentity(parent.cwd, payload);
      // A changed runner transcript is not an implementation revision. Compare
      // the full scoped bytes and task contract before spending another check
      // or reviewer call, including when the first submission had no diff.
      // Any earlier rejection of these exact bytes counts, not only the last:
      // reverting to a rejected candidate never buys a new verdict.
      try { reviewIdentity = await this.identify(parent.cwd, payload, { jobId: job.id }); } catch { /* ordinary review reports unavailable identity */ }
      signal.throwIfAborted();
      if (!reviewIdentity) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", "Cannot bind final review to the scoped workspace; verification is blocked.");
      const currentCandidateIdentity = async () => {
        const currentJob = getJob(parent.jobId);
        if (!currentJob) throw finalReviewError("FINAL_REVIEW_CONTEXT_MISSING", "The reviewed job no longer exists.");
        return this.identify(parent.cwd, parseJobPayload(currentJob), { jobId: job.id });
      };
      const assertCandidateUnchanged = async () => {
        const current = await currentCandidateIdentity();
        signal.throwIfAborted();
        if (current !== reviewIdentity) throw finalReviewError("FINAL_REVIEW_CANDIDATE_CHANGED", "Scoped files changed during verification; review the current candidate again.");
      };
      const rejected = reviewIdentity ? semanticPrior.findLast((review) =>
        review.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS && review.review_identity === reviewIdentity
        && sameCompletionReport(completionReport, review.completion_report)) : null;
      if (rejected) return this.#returnUnchangedReview(parent, rejected, prior);
      const workItem = getWorkItem(job.work_item_id);
      declaredPlan = this.resolveTestPlan(job, payload, { cwd: parent.cwd });
      verificationIdentity = await this.verificationIdentity(parent.cwd, { payload: parseJobPayload(getJob(parent.jobId)) });
      testRun = await this.runTestPlan(declaredPlan, {
        cwd: parent.cwd,
        timeoutMs: stageTimeoutMs("the declared tests"),
        signal,
      });
      signal.throwIfAborted();
      await assertCandidateUnchanged();
      const placeholders = new Set(await emptyMaterializedPathsForJob(job.id,
        payload.scope_generation ?? payload._materialization_generation ?? 1, parent.cwd));
      change = await this.collectChange(parent.cwd, payload, { ignorePaths: placeholders });
      // The assessment after handoff runs these too; running them here lets
      // the developer fix what they find in the same attempt. The change is
      // the lineage's, as in the post-change receipt: a fix also runs the test
      // files its root committed.
      const lineage = await this.lineageTests(job, payload, parent.cwd);
      const lineagePaths = Array.isArray(lineage) ? lineage : Array.isArray(lineage?.paths) ? lineage.paths : [];
      changedPlan = changedTestPlan(job, payload, change, declaredPlan, {
        cwd: parent.cwd,
        resolvePlan: this.resolveTestPlan,
        lineagePaths: lineagePaths.filter((file) => !placeholders.has(file)),
      });
      signal.throwIfAborted();
      changedTestRun = changedPlan
        ? await this.runTestPlan(changedPlan, { cwd: parent.cwd, timeoutMs: stageTimeoutMs("the changed tests"), signal })
        : null;
      signal.throwIfAborted();
      checks = await this.runChecks(parent.cwd, change, { signal, jobId: job.id, timeoutMs: stageTimeoutMs("the changed-file checks") });
      await assertCandidateUnchanged();
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
        if (session && session.contractIdentity !== contractIdentity) {
          // A delta assumes the old contract. Scope approvals and changed
          // requirements need a newly composed reviewer with current policy.
          this.#release(parent);
          session = null;
        }
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
            contractIdentity,
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
          // Terminal-only reviewers cannot correct a report in-session. Treat
          // an unserviceable report as bounded reviewer infrastructure failure.
          const correction = reported.validated ? null
            : await this.checkFindingBoundary(reported.result, { job, payload, cwd: parent.cwd });
          if (correction) {
            mode = MODES.INFRASTRUCTURE;
            result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: correction };
          } else {
            verdictObtained = true;
            result = mergeCheckFindings(reported.result, deterministicFindings);
          }
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
        } else if (reviewIdentity !== await currentCandidateIdentity()) {
          result = { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "Scoped files changed during review; review the current change again." };
        } else verificationCandidateValid = true;
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
    if (verificationIdentity && verificationIdentity !== await this.verificationIdentity(parent.cwd, { payload: parseJobPayload(getJob(parent.jobId)) })) verificationIdentity = null;
    const recorded = [...prior, { review_mode: mode }];
    const reviewsRemaining = finalReviewReviewsRemaining(recorded);
    if (mode === MODES.DETERMINISTIC && finalReviewDeterministicRetriesLeft(recorded) === 0) {
      result = { ...result, reason: "This attempt's deterministic verification rounds are used; hand off for assessment. These findings remain unresolved." };
      this.#release(parent);
    }
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
    const observation = {
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
        verification_evidence: verificationIdentity ? {
          identity: verificationIdentity, declared_plan: declaredPlan, declared_tests: testRun,
          changed_plan: changedPlan, changed_tests: changedTestRun, scoped_checks: checks,
        } : null,
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
        duration_ms: this.now() - startedAt,
      },
    };
    return this.#saveReview(parent, { response, observation, failures: 0,
      verificationBlocked: response.outcome === FINAL_REVIEW_OUTCOMES.BLOCKED && verdictObtained && verificationCandidateValid
        && [MODES.FRESH, MODES.REVISION].includes(mode) });
  }

  #saveReview(parent, pending) {
    const { response, observation } = pending;
    const blocked = () => ({ ...response, outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, summary: null,
      persistence_error: pending.error || null,
      reason: pending.failures < FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS
        ? "The review result could not be saved. Call final_review once more to retry saving it; no new reviewer will run."
        : "The review result could not be saved after bounded retries. Hand off with status BLOCKED and report the persistence failure; do not request another review." });
    if (pending.failures >= FINAL_REVIEW_MAX_INFRASTRUCTURE_ROUNDS) return blocked();
    parent.pendingReview = pending;
    const recordResult = () => {
      if (this.record(observation) === false) throw new Error("Could not persist the final-review result");
    };
    try {
      const verificationBlocked = pending.verificationBlocked === true;
      if (response.outcome === FINAL_REVIEW_OUTCOMES.PASS || verificationBlocked) {
        // Pass authority and completion must commit together. A failed write
        // retains this exact result for a bounded save retry, not a new model.
        // A semantic block also ends this implementation attempt. Save its
        // COMPLETE delivery and needs_review verdict before stopping either
        // model; the authoritative assessment then opens the operator gate.
        if (verificationBlocked) observation.detail.verification_blocked = true;
        this.completePass({ agentCallId: parent.agentCallId,
          reviewerAgentCallId: observation.detail.reviewer_agent_call_id,
          verifiedNoChange: !verificationBlocked && observation.detail.changed_file_count === 0,
          verificationBlocked: verificationBlocked ? response.reason || "Required verification is unavailable." : null,
          cwd: parent.cwd, summary: response.summary, recordResult });
        parent.completed = true;
        this.#release(parent);
      } else recordResult();
      parent.pendingReview = null;
      return response;
    } catch (error) {
      pending.error = String(error?.message || error).slice(0, 300);
      pending.failures++;
      this.#release(parent);
      return blocked();
    }
  }

  #returnUnchangedReview(parent, rejected, prior) {
    const latest = semanticFinalReviewResults(prior).at(-1);
    const reason = latest?.id === rejected.id
      ? "The scoped code is unchanged since the failed final review. Existing findings remain; no second review was run. Hand off for repair when ready."
      : "The scoped code matches a candidate an earlier final review rejected. Its findings remain; no new review was run. Hand off for repair when ready.";
    const result = { outcome: FINAL_REVIEW_OUTCOMES.FINDINGS,
      reason, findings: rejected.findings || [],
      reviews_remaining: finalReviewReviewsRemaining(prior) };
    const observation = { work_item_id: parent.workItemId ?? null, job_id: parent.jobId,
      attempt_id: parent.attemptId, observation_type: FINAL_REVIEW_OBSERVATIONS.RESULT,
      summary: reason, detail: { ...result, agent_call_id: parent.agentCallId,
        review_identity: rejected.review_identity, reviewer_agent_call_id: rejected.reviewer_agent_call_id,
        review_mode: MODES.UNCHANGED, completion_report: rejected.completion_report || null,
        previous_review_id: rejected.id } };
    this.#release(parent);
    return this.#saveReview(parent, { response: result, observation, failures: 0 });
  }

  #startReviewer(parent, { instructions, evidence, snapshot, contractIdentity }) {
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
      invalidReports: 0,
      validatingReport: false,
      contractIdentity,
      run: null,
      wallTimer: null,
    };
    parent.reviewer = session;
    // Cover setup as well as provider execution, including a provider that
    // ignores cancellation. The owner must always settle the developer's wait.
    session.wallTimer = setTimeout(() => {
      if (parent.reviewer === session) {
        this.#release(parent, "the reviewer reached its time limit before reporting");
        session.controller.abort();
      }
    }, this.reviewerWallMs);
    session.wallTimer.unref?.();
    session.run = Promise.resolve()
      .then(() => {
        session.controller.signal.throwIfAborted();
        return parent.runReview({ instructions, evidence, abortSignal: session.controller.signal,
          onAgentCallCreated: (id) => {
            // Bind before the child can use tools, including a child whose
            // setup finishes after its session was released or replaced.
            if (session.released || session.ended) {
              parent.retiredReviewerCalls.add(id);
              session.controller.abort();
              return;
            }
            if (session.agentCallId != null && session.agentCallId !== id) {
              parent.retiredReviewerCalls.add(session.agentCallId);
              if (session.waitingForRevision || session.revisionExpected) {
                // Provider fallback starts from the original prompt, without
                // the prior review conversation. It cannot judge a delta that
                // assumes that lost context; the next round needs a full view.
                parent.retiredReviewerCalls.add(id);
                this.#release(parent, "the reviewer provider changed after reporting; a fresh review of the current candidate is required");
                session.controller.abort();
                return;
              }
            }
            session.agentCallId = id;
          },
        });
      })
      .then((review) => ({ review }), (error) => ({ error }))
      .then((ended) => {
        // The reviewer ended (its terminal handoff, a provider error, its
        // wall): a call it left parked answers done, and the developer's next
        // call starts a fresh reviewer.
        session.ended = true;
        clearTimeout(session.wallTimer);
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
        // Unparsable or empty reviewer output is no verdict on the work: a
        // bounded infrastructure round, not a semantic block that ends the
        // developer's attempt. A parsed needs_review remains semantic.
        const verdict = ended.review?.verdict;
        const decision = verdict && typeof verdict === "object" && !Array.isArray(verdict)
          ? String(verdict.verdict || "").trim() : "";
        if (!decision) return {
          infrastructure: true,
          result: { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason: "the reviewer returned no verdict" },
          reviewerCallId,
        };
        return {
          result: finalReviewResultFromVerdict(verdict, { claims: ended.review?.claims || [] }),
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
    if (session.revisionExpected && !session.revisionDelivered) {
      return { status: "not_waiting", error: "Wait for the revised candidate before reporting on it." };
    }
    const waiting = session.awaitingReport;
    if (!waiting) {
      if (session.waitingForRevision) return this.#parkReviewer(session, { signal });
      return { status: "not_waiting", error: "Your report was already delivered; wait in final_review for the developer's revision." };
    }
    if (session.validatingReport) {
      return { status: "not_waiting", error: "A review report is already being validated; wait for that call to return." };
    }
    const mapped = finalReviewResultFromReport(args);
    let reportError = mapped.error;
    if (!reportError && mapped.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS) {
      session.validatingReport = true;
      try {
        const job = getJob(parent.jobId);
        reportError = await this.checkFindingBoundary(mapped, { job, payload: parseJobPayload(job), cwd: parent.cwd });
      } catch (error) {
        // An unavailable guard cannot turn an unvalidated report into repair
        // authority, nor leave the developer waiting without a bounded exit.
        if (parent.reviewer === session) this.#release(parent, `review finding validation could not run (${String(error?.message || error).slice(0, 200)})`);
      } finally {
        session.validatingReport = false;
      }
      if (session.released || session.ended || parent.reviewer !== session) {
        return { status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION };
      }
    }
    if (reportError) {
      session.invalidReports++;
      if (session.invalidReports >= FINAL_REVIEW_MAX_INVALID_REPORTS) {
        this.#release(parent, "the reviewer repeatedly returned an invalid report");
        return { status: FINAL_REVIEW_REVIEWER_STATUS.DONE, instruction: REVIEWER_DONE_INSTRUCTION, error: reportError };
      }
      return { status: "invalid_report", error: reportError };
    }
    session.invalidReports = 0;
    session.awaitingReport = null;
    session.snapshot = session.pendingSnapshot;
    session.pendingSnapshot = null;
    session.waitingForRevision = true;
    waiting.resolve({ result: mapped, reviewerCallId: callId, validated: true });
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

  #release(parent, reason = "the reviewer session was released before reporting") {
    const session = parent?.reviewer;
    if (!session) return;
    session.released = true;
    clearTimeout(session.wallTimer);
    if (session.agentCallId != null) parent.retiredReviewerCalls.add(session.agentCallId);
    if (session.awaitingReport) {
      const report = session.awaitingReport;
      session.awaitingReport = null;
      report.resolve({ infrastructure: true, reviewerCallId: session.agentCallId,
        result: { outcome: FINAL_REVIEW_OUTCOMES.BLOCKED, findings: [], reason } });
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
