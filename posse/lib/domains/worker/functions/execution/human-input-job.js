import { processVerdict } from "../helpers/process-verdict.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import {
  addDependency,
  clearStallResume,
  completeAttempt,
  createJob,
  getDependents,
  getEvents,
  getJob,
  getAttempts,
  extendJobMaxAttempts,
  incrementAndCreateAttempt,
  logEvent,
  rewireDependency,
  setAttemptCommitHash,
  storeArtifact,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import { withWorktreeLockAsync, worktreePath } from "../../../git/functions/worktree.js";
import { findStallStashAsync, gitExecAsync } from "../../../git/functions/utils.js";
import {
  applyPartialWorkTurnExtension,
  commitScopedPartialWorkAsync,
} from "../helpers/partial-work.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
import { getAssessmentInternalRetryLimit } from "../helpers/assessment-shared.js";
import { refreshAndExtractInsights } from "../helpers/insights.js";
import { logAttemptSkippedStaleLease } from "./attempt-logging.js";
import {
  buildDeadLetterRetryPayload,
  classifyApprovalAnswer,
  classifyBlockedRecoveryAnswer,
  classifyDeadLetterRecoveryAnswer,
  classifyPartialWorkRecoveryAnswer,
  classifyReviewAnswer,
  extractHumanAnswers,
  extractHumanAnswerText,
  incomingDependenciesForRecoveryRetry,
} from "./human-review.js";
import {
  isBogusResearchPlaceholderPayload,
  latestArtifactText,
} from "./job-helpers.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

async function dropPartialWorkStashAsync(worker, origJob, wtPath) {
  return await withWorktreeLockAsync(wtPath, worker.projectDir, async () => {
    const stashRef = await findStallStashAsync(origJob.id, wtPath);
    if (stashRef) await gitExecAsync(["stash", "drop", stashRef], wtPath);
    clearStallResume(origJob.id);
    return stashRef || null;
  });
}

export async function runHumanInputJob(worker, job, { leaseToken, abortSignal = null } = {}) {
  const payload = worker.parsePayload(job);
  const attempt = incrementAndCreateAttempt(job.id, leaseToken, "human", "human", null);
  if (!attempt) {
    logAttemptSkippedStaleLease(job, "human", "Skipped human_input attempt because the lease was stale or expired");
    worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} - lease lost${C.reset}`);
    return;
  }

  const startTime = Date.now();
  try {
    if (isBogusResearchPlaceholderPayload(payload) && payload.original_job_id) {
      const origJob = getJob(payload.original_job_id);
      const originalResearchOutput = origJob && origJob.job_type === "research"
        ? latestArtifactText(origJob.id, ["response", "summary"])
        : "";
      const dependents = getDependents(job.id);
      for (const dep of dependents) {
        const depJob = getJob(dep.job_id);
        if (!depJob) continue;
        if (TERMINAL_JOB_STATUS_SET.has(depJob.status)) continue;
        await worker._setJobRowStatus(depJob, "canceled");
      }
      const autoNote = JSON.stringify({
        auto_resolved: true,
        reason: "Ignored stale generic researcher placeholder question",
      });
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        artifact_type: "response",
        content_long: autoNote,
      });
      completeAttempt(attempt.attempt.id, {
        status: "succeeded",
        duration_ms: Date.now() - startTime,
        output_chars: autoNote.length,
      });
      worker.emit(job.id, `${C.yellow}[human] Ignored stale placeholder researcher question for job #${payload.original_job_id}${C.reset}`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.attempt.id,
        event_type: EVENT_TYPES.JOB_PLACEHOLDER_QUESTION_IGNORED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Ignored stale generic researcher placeholder; canceled ${dependents.length} dependent(s)`,
      });
      worker._releaseLease(job, leaseToken, "succeeded");
      if (origJob && origJob.job_type === "research" && originalResearchOutput) {
        worker._spawnPlanAfterResearch(origJob, originalResearchOutput);
      }
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }

    const output = await worker._humanInputHandler(job, abortSignal);
    worker._throwIfKilled(job.id);

    if (output === null) {
      completeAttempt(attempt.attempt.id, {
        status: "interrupted",
        duration_ms: Date.now() - startTime,
        error_text: "Parked: waiting for human input (no display)",
      });
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.attempt.id,
      artifact_type: "response",
      content_long: output || "(human input collected)",
    });
    completeAttempt(attempt.attempt.id, {
      status: "succeeded",
      duration_ms: Date.now() - startTime,
      output_chars: (output || "").length,
    });

    let finalHumanStatus = "succeeded";
    let handledReviewDecision = false;
    let leaseReleased = false;
    const releaseHumanLease = (status) => {
      const released = worker._releaseLease(job, leaseToken, status);
      if (released !== false) leaseReleased = true;
      return released;
    };
    try {
    if (Array.isArray(payload.file_requests) && payload.file_requests.length > 0) {
      const answers = extractHumanAnswers(output);
      const lastAnswer = answers.length > 0 ? extractHumanAnswerText(answers[answers.length - 1]) : "";
      const decision = classifyApprovalAnswer(lastAnswer);
      const dependents = getDependents(job.id);

      if (decision === "rejected") {
        finalHumanStatus = "failed";
        for (const dep of dependents) {
          const depJob = getJob(dep.job_id);
          if (!depJob) continue;
          if (TERMINAL_JOB_STATUS_SET.has(depJob.status)) continue;
          await worker._setJobRowStatus(depJob, "canceled");
        }
        worker.emit(job.id, `${C.yellow}[human] File creation rejected - canceled ${dependents.length} gated dependent(s)${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_FILE_REQUEST_REJECTED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Rejected file creation gate for ${payload.file_requests.length} file(s)`,
          event_json: JSON.stringify({ file_requests: payload.file_requests }),
        });
      } else if (decision === "approved") {
        worker.emit(job.id, `${C.green}[human] File creation approved - ${dependents.length} gated dependent(s) can proceed${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_FILE_REQUEST_APPROVED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Approved file creation gate for ${payload.file_requests.length} file(s)`,
          event_json: JSON.stringify({ file_requests: payload.file_requests }),
        });
      }
    }

    if (payload.original_job_id && payload.review_type === "partial_work_recovery") {
      const origJob = getJob(payload.original_job_id);
      const answers = extractHumanAnswers(output);
      const lastAnswer = answers.length > 0 ? extractHumanAnswerText(answers[answers.length - 1]) : "";
      const decision = classifyPartialWorkRecoveryAnswer(lastAnswer);
      handledReviewDecision = true;

      if (!origJob) {
        finalHumanStatus = "failed";
        worker.emit(job.id, `${C.yellow}[human] Partial-work recovery could not find original job #${payload.original_job_id}${C.reset}`);
      } else if (decision === "extend") {
        const extension = applyPartialWorkTurnExtension(origJob, {
          humanAnswer: lastAnswer,
          maxTurnsOverride: payload.suggested_max_turns || null,
          recoveryJobId: job.id,
        });
        await worker._setJobRowStatus(origJob, "queued");
        worker.emit(job.id, `${C.cyan}[human] Partial work for job #${origJob.id} will resume with maxTurns=${extension.maxTurns}${C.reset}`);
      } else if (decision === "commit") {
        const wtPath = worktreePath(worker.projectDir, origJob.work_item_id);
        const restored = await worker.applyStallStashAsync(origJob, wtPath);
        if (!restored) {
          finalHumanStatus = "failed";
          worker.emit(job.id, `${C.yellow}[human] Partial-work commit requested but no restorable stash was found for job #${origJob.id}${C.reset}`);
        } else {
          const origAttempts = getAttempts(origJob.id);
          const latestOrigAttempt = origAttempts.length > 0 ? origAttempts[origAttempts.length - 1] : null;
          const partialOutput = [
            `Human chose to commit partial work from recovery job #${job.id}.`,
            "",
            restored,
          ].join("\n");
          const partialCommit = await commitScopedPartialWorkAsync(worker, origJob, latestOrigAttempt ? { id: latestOrigAttempt.id } : null, wtPath, {
            reason: `human partial-work recovery #${job.id}: commit`,
            output: partialOutput,
          });
          if (!partialCommit.committed) {
            finalHumanStatus = "failed";
            worker.emit(job.id, `${C.yellow}[human] Partial-work commit found no in-scope files to commit for job #${origJob.id}${C.reset}`);
          } else {
            if (latestOrigAttempt?.id) setAttemptCommitHash(latestOrigAttempt.id, partialCommit.committedHash);
            storeArtifact({
              work_item_id: origJob.work_item_id,
              job_id: origJob.id,
              attempt_id: latestOrigAttempt?.id || null,
              artifact_type: "response",
              content_long: partialOutput,
            });
            const freshOrigJob = getJob(origJob.id) || origJob;
            const origPayload = worker.parsePayload(freshOrigJob);
            delete origPayload._stall_resume;
            origPayload._assess_only = true;
            origPayload._partial_work_recovery = {
              ...(origPayload._partial_work_recovery || {}),
              recovery_job_id: job.id,
              action: "commit_for_assessment",
              commit_hash: partialCommit.committedHash,
            };
            updateJobPayload(origJob.id, JSON.stringify(origPayload));
            extendJobMaxAttempts(origJob.id, Number(freshOrigJob.attempt_count || origJob.attempt_count || 0) + 1);
            await worker._setJobRowStatus(origJob, "queued");
            worker.emit(job.id, `${C.cyan}[human] Partial work for job #${origJob.id} committed ${partialCommit.committedHash.slice(0, 8)} and queued for assessment${C.reset}`);
          }
        }
      } else if (decision === "revert") {
        const wtPath = worktreePath(worker.projectDir, origJob.work_item_id);
        let dropped = null;
        try {
          dropped = await dropPartialWorkStashAsync(worker, origJob, wtPath);
        } catch {
          dropped = null;
        }
        await worker._setJobRowStatus(origJob, "dead_letter");
        worker.emit(job.id, `${C.yellow}[human] Partial work for job #${origJob.id} discarded${dropped ? ` (${dropped})` : ""}; job dead-lettered${C.reset}`);
        logEvent({
          work_item_id: origJob.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_PARTIAL_WORK_REVERTED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human discarded partial-work stash via recovery job #${job.id}`,
          event_json: JSON.stringify({ recovery_job_id: job.id, stash_ref: dropped }),
        });
      } else {
        finalHumanStatus = "failed";
        worker.emit(job.id, `${C.yellow}[human] Partial-work recovery answer was not actionable; expected extend, commit, or revert${C.reset}`);
      }
    }

    if (payload.original_job_id && payload.review_type === "blocked_recovery") {
      const origJob = getJob(payload.original_job_id);
      const answers = extractHumanAnswers(output);
      const lastAnswer = answers.length > 0 ? extractHumanAnswerText(answers[answers.length - 1]) : "";
      const decision = classifyBlockedRecoveryAnswer(lastAnswer);
      handledReviewDecision = true;

      if (!origJob) {
        finalHumanStatus = "failed";
        worker.emit(job.id, `${C.yellow}[human] Blocked recovery could not find original job #${payload.original_job_id}${C.reset}`);
      } else if (decision === "retry") {
        const origPayload = worker.parsePayload(origJob);
        const recoveryNote = [
          `Blocked recovery from human_input job #${job.id}:`,
          String(lastAnswer || "").trim() || "(no additional instructions)",
        ].join("\n");
        if (typeof origPayload.task_spec === "string" && origPayload.task_spec.trim()) {
          origPayload.task_spec = `${origPayload.task_spec.trim()}\n\nBLOCKED RECOVERY GUIDANCE:\n${recoveryNote}`;
        } else {
          origPayload.task_spec = recoveryNote;
        }
        origPayload._blocked_recovery = {
          ...(origPayload._blocked_recovery || {}),
          recovery_job_id: job.id,
          action: "retry",
          human_answer: String(lastAnswer || ""),
        };
        updateJobPayload(origJob.id, JSON.stringify(origPayload));
        extendJobMaxAttempts(origJob.id, Number(origJob.attempt_count || 0) + 1);
        await worker._setJobRowStatus(origJob, "queued");
        worker.emit(job.id, `${C.cyan}[human] Blocked job #${origJob.id} queued for retry with human guidance${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_UNBLOCKED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human requested blocked-job retry via job #${job.id}`,
          event_json: JSON.stringify({ recovery_job_id: job.id, answer: lastAnswer }),
        });
      } else if (decision === "replan") {
        const emitFn = (msg) => worker.emit(job.id, msg);
        processVerdict(origJob, {
          verdict: "needs_replan",
          confidence: "high",
          reasons: [`Human requested replan for blocked job via recovery job #${job.id}: ${lastAnswer || "(no details)"}`],
          spawn_jobs: [],
          human_questions: [],
        }, { emit: emitFn, autoApprove: worker.autoApprove });
        worker.emit(job.id, `${C.cyan}[human] Blocked job #${origJob.id} routed to replan${C.reset}`);
      } else if (decision === "skip") {
        await worker._setJobRowStatus(origJob, "canceled");
        worker.emit(job.id, `${C.yellow}[human] Blocked recovery skipped job #${origJob.id}${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_REVIEW_SKIPPED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human skipped blocked job via recovery job #${job.id}`,
        });
      } else if (decision === "pass") {
        await worker._setJobRowStatus(origJob, "succeeded");
        worker.emit(job.id, `${C.green}[human] Blocked recovery marked job #${origJob.id} succeeded${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human passed blocked job via recovery job #${job.id}`,
        });
      } else if (decision === "fail") {
        await worker._setJobRowStatus(origJob, "failed");
        worker.emit(job.id, `${C.yellow}[human] Blocked recovery failed job #${origJob.id}${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human failed blocked job via recovery job #${job.id}`,
        });
      } else {
        finalHumanStatus = "failed";
        worker.emit(job.id, `${C.yellow}[human] Blocked recovery answer was not actionable; expected retry, skip, replan, pass, or fail${C.reset}`);
      }
    }

    if (payload.original_job_id && (payload.review_type === "dead_letter_recovery" || payload.review_type === "stall_exhausted_recovery")) {
      const origJob = getJob(payload.original_job_id);
      const answers = extractHumanAnswers(output);
      const lastAnswer = answers.length > 0 ? extractHumanAnswerText(answers[answers.length - 1]) : "";
      const decision = classifyDeadLetterRecoveryAnswer(lastAnswer);
      handledReviewDecision = true;

      if (decision.action === "skip") {
        worker.emit(job.id, `${C.yellow}[human] Dead-letter recovery skipped original job #${payload.original_job_id}; dependent job(s) can proceed${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: payload.original_job_id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY_SKIP,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human chose to skip dead-lettered job via recovery job #${job.id}`,
        });
      } else if (decision.action === "retry" && origJob) {
        const origPayload = worker.parsePayload(origJob);
        const retryPayload = buildDeadLetterRetryPayload(origJob, origPayload, lastAnswer, job.id, worker.projectDir, {
          recoveryType: payload.review_type,
        });
        const retryJob = createJob({
          work_item_id: job.work_item_id,
          job_type: origJob.job_type,
          title: `Retry: ${origJob.title.slice(0, 80)}`,
          parent_job_id: origJob.id,
          priority: "urgent",
          model_tier: origJob.model_tier || "standard",
          reasoning_effort: origJob.reasoning_effort || "medium",
          provider: decision.provider || origJob.provider || null,
          token_budget_input: origJob.token_budget_input || null,
          token_budget_output: origJob.token_budget_output || null,
          context_budget_chars: origJob.context_budget_chars || null,
          max_attempts: origJob.max_attempts || null,
          payload_json: JSON.stringify(retryPayload),
          planner_complexity_score: origJob.planner_complexity_score ?? null,
          planner_risk_score: origJob.planner_risk_score ?? null,
          planner_context_score: origJob.planner_context_score ?? null,
          planner_failure_cost_score: origJob.planner_failure_cost_score ?? null,
        });
        for (const dep of incomingDependenciesForRecoveryRetry(origJob, origPayload)) {
          addDependency(retryJob.id, dep.depends_on_job_id, dep.dependency_kind || "hard");
        }
        const dependents = getDependents(job.id);
        for (const dep of dependents) {
          rewireDependency(dep.job_id, job.id, retryJob.id, dep.dependency_kind);
        }
        worker.emit(job.id, `${C.cyan}[human] Dead-letter recovery spawned retry job #${retryJob.id}${decision.provider ? ` on ${decision.provider}` : ""}; rewired ${dependents.length} dependent(s)${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_DEAD_LETTER_RETRY_SPAWNED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human recovery job #${job.id} spawned retry job #${retryJob.id}${decision.provider ? ` on ${decision.provider}` : ""}`,
          event_json: JSON.stringify({
            recovery_job_id: job.id,
            retry_job_id: retryJob.id,
            provider: decision.provider || null,
            rewired_dependents: dependents.map((dep) => dep.job_id),
            answer: lastAnswer,
          }),
        });
      } else {
        finalHumanStatus = "failed";
        worker.emit(job.id, `${C.yellow}[human] Dead-letter recovery did not produce a retry; keeping dependent job(s) blocked${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: payload.original_job_id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY_FAILED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Human recovery job #${job.id} did not provide an actionable retry`,
        });
      }
    }
    releaseHumanLease(finalHumanStatus);

    if (!handledReviewDecision && payload.original_job_id && payload.review_type) {
      const origJob = getJob(payload.original_job_id);
      const answers = extractHumanAnswers(output);
      const lastAnswer = answers.length > 0 ? extractHumanAnswerText(answers[answers.length - 1]) : "";
      const reviewDecision = classifyReviewAnswer(lastAnswer);
      if (origJob) {
        if (reviewDecision === "pass") {
          await worker._setJobRowStatus(origJob, "succeeded");
          handledReviewDecision = true;
          worker.emit(job.id, `${C.green}[human] Review passed job #${origJob.id}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: origJob.id,
            attempt_id: attempt.attempt.id,
            event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Human review passed original job via job #${job.id}`,
          });
        } else if (reviewDecision === "fail") {
          await worker._setJobRowStatus(origJob, "failed");
          handledReviewDecision = true;
          worker.emit(job.id, `${C.yellow}[human] Review failed job #${origJob.id}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: origJob.id,
            attempt_id: attempt.attempt.id,
            event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Human review failed original job via job #${job.id}`,
          });
        } else if (payload.review_type === "assessment_transport_error" && reviewDecision === "retry") {
          const maxAssessRetries = getAssessmentInternalRetryLimit();
          const origEvents = getEvents(origJob.id, 50);
          const retryCount = origEvents.filter((event) => event.event_type === "job.review_retry_assessment").length;
          if (retryCount >= maxAssessRetries) {
            const retryLimitReview = createJob({
              work_item_id: job.work_item_id,
              job_type: "human_input",
              title: `Assessment retry limit: ${origJob.title.slice(0, 60)}`,
              parent_job_id: origJob.id,
              priority: "urgent",
              model_tier: "cheap",
              payload_json: JSON.stringify({
                original_job_id: origJob.id,
                review_type: "assessment_retry_limit",
                questions: ["Assessment retries are exhausted. Should this pass, fail, skip, or replan?"],
              }),
            });
            await worker._setJobRowStatus(origJob, "waiting_on_review");
            handledReviewDecision = true;
            worker.emit(job.id, `${C.yellow}[human] Assessment retry limit (${maxAssessRetries}) reached for job #${origJob.id} - spawned forced review job #${retryLimitReview.id}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: origJob.id,
              attempt_id: attempt.attempt.id,
              event_type: EVENT_TYPES.JOB_REVIEW_RETRY_LIMIT,
              actor_type: EVENT_ACTORS.WORKER,
              message: `Assessment retry limit reached - spawned forced-resolution review job #${retryLimitReview.id} for job #${origJob.id}`,
            });
            refreshAndExtractInsights(job.work_item_id);
            return;
          }
          const origPayload = worker.parsePayload(origJob);
          origPayload._assess_only = true;
          updateJobPayload(origJob.id, JSON.stringify(origPayload));
          await worker._setJobRowStatus(origJob, "queued");
          handledReviewDecision = true;
          worker.emit(job.id, `${C.cyan}[human] Review requested assessment retry (${retryCount + 1}/${maxAssessRetries}) for job #${origJob.id}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: origJob.id,
            attempt_id: attempt.attempt.id,
            event_type: EVENT_TYPES.JOB_REVIEW_RETRY_ASSESSMENT,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Human requested assessment retry (${retryCount + 1}/${maxAssessRetries}) via job #${job.id}`,
          });
        } else if (reviewDecision === "replan") {
          handledReviewDecision = true;
          const emitFn = (msg) => worker.emit(job.id, msg);
          processVerdict(origJob, {
            verdict: "needs_replan",
            confidence: "high",
            reasons: [`Human requested replan via review job #${job.id}`],
            spawn_jobs: [],
            human_questions: [],
          }, { emit: emitFn, autoApprove: worker.autoApprove });
        } else if (reviewDecision === "skip") {
          await worker._setJobRowStatus(origJob, "canceled");
          handledReviewDecision = true;
          worker.emit(job.id, `${C.yellow}[human] Review skipped job #${origJob.id}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: origJob.id,
            attempt_id: attempt.attempt.id,
            event_type: EVENT_TYPES.JOB_REVIEW_SKIPPED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Human skipped original job via review job #${job.id}`,
          });
        }
      }
    }

    if (payload.original_job_id && !handledReviewDecision) {
      const origJob = getJob(payload.original_job_id);
      const unblockable = new Set(["waiting_on_human", "waiting_on_review", "blocked", "awaiting_assessment"]);
      if (origJob && unblockable.has(origJob.status)) {
        await worker._setJobRowStatus(origJob, "queued");
        worker.emit(job.id, `${C.cyan}[human] Unblocked job #${origJob.id} - requeued${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: origJob.id,
          event_type: EVENT_TYPES.JOB_UNBLOCKED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Requeued after human input (job #${job.id})`,
        });
      }
    }
    refreshAndExtractInsights(job.work_item_id);
    } catch (postErr) {
      const message = postErr instanceof Error ? postErr.message : String(postErr);
      worker.emit(job.id, `${C.yellow}[human] Post-answer resolution failed after human input was recorded: ${message}${C.reset}`);
      try {
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.attempt.id,
          event_type: EVENT_TYPES.JOB_HUMAN_RESOLUTION_FAILED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Post-answer human-input resolution failed after attempt success: ${message}`,
        });
      } catch {
        // The original answer is already recorded; audit logging is best-effort.
      }
      if (!leaseReleased) {
        try { releaseHumanLease(finalHumanStatus); } catch { /* keep the succeeded attempt terminal */ }
      }
      try { refreshAndExtractInsights(job.work_item_id); } catch { /* best effort */ }
    }
  } catch (err) {
    if (worker._handleDeterministicInterruption(job, attempt.attempt.id, startTime, leaseToken, err)) {
      return;
    }

    completeAttempt(attempt.attempt.id, {
      status: "failed",
      duration_ms: Date.now() - startTime,
      error_text: err.message,
    });
    worker._retryOrFail(job, leaseToken, err.message);
  }
}
