// lib/domains/worker/functions/helpers/dead-letter.js
//
// Retry/dead-letter flow and fast-failure provider diagnostics extracted from
// worker.js to keep execution orchestration focused.

import { ROLE_DRIVEN_JOB_TYPES } from "../../../../catalog/job.js";
import {
  applyDelegation,
  createJob,
  getArtifacts,
  getAttempts,
  getJob,
  getDependents,
  getSetting,
  logEvent,
  rewireDependency,
  storeArtifact,
  updateJobProvider,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { C } from "../../../../shared/format/functions/colors.js";
import {
  buildPromptExcerpt,
  getErrorDetails,
  isPermanentProviderConfigError,
  isTurnBudgetExhaustedDetails,
  retryingAttemptWording,
} from "./diagnostics.js";
import { refreshAndExtractInsights } from "./insights.js";
import { spawnResearchAfterPreflight } from "./pipeline-continuation.js";
import { RetryPolicy } from "../../../../shared/policies/classes/RetryPolicy.js";
import { tierModelName } from "../../../providers/functions/provider.js";
import { escalateModelTier } from "../../../providers/functions/shared/turns.js";
import { providerRoleForJobType } from "../../../providers/functions/roles.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { isTransientCommitInfraFailure } from "./commit-infra.js";

const MAX_STALL_EXHAUSTED_RECOVERY_RETRIES = 1;

function shortJobTitle(job) {
  const title = String(job?.title || "");
  if (/^improvement\s*:/i.test(title)) {
    return title.replace(/^improvement\s*:\s*/i, "[I] ");
  }
  return title;
}

function buildAttemptSummary(jobId) {
  try {
    const attempts = getAttempts(jobId);
    if (attempts.length === 0) return "No attempt records found.";

    return attempts.map((attempt) => {
      const status = attempt.status || "unknown";
      const model = attempt.model_name || "default";
      const duration = attempt.duration_ms ? `${(attempt.duration_ms / 1000).toFixed(0)}s` : "?";
      const err = attempt.error_text
        ? attempt.error_text.split("\n").slice(0, 3).join("\n  ").slice(0, 300)
        : null;

      let line = `Attempt ${attempt.attempt_number} [${status}] (model: ${model}, duration: ${duration})`;
      if (err) line += `\n  Error: ${err}`;
      if (attempt.notes) line += `\n  Notes: ${attempt.notes.slice(0, 150)}`;
      return line;
    }).join("\n\n").slice(0, 2000);
  } catch (err) {
    return `(Error building attempt summary: ${err.message})`;
  }
}

function providerSettingRoleForJobType(jobType = "") {
  const normalized = String(jobType || "").toLowerCase();
  if (normalized === "fix") return "dev";
  if (normalized === "assess") return "assessor";
  if (normalized === "research") return "researcher";
  if (normalized === "plan") return "planner";
  if (normalized === "artificer") return "artificer";
  if (normalized === "summarize") return "summarize";
  if (normalized === "delegate") return "delegate";
  return "dev";
}

function stallRecoveryRetryCount(job) {
  const payload = parseJobPayload(job);
  const value = Number(payload?._dead_letter_recovery?.stall_recovery_count || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function recoveryIsUnattended(worker) {
  if (worker?.nonInteractive) return true;
  if (process.env.POSSE_AB_HARNESS || process.env.POSSE_AB_CELL || process.env.POSSE_AB_ARM) return true;
  return !(worker?.display && typeof worker.display.askQuestions === "function");
}

function unattendedRecoveryReason(worker) {
  if (worker?.nonInteractive) return "non-interactive run";
  if (process.env.POSSE_AB_HARNESS || process.env.POSSE_AB_CELL || process.env.POSSE_AB_ARM) return "harness run";
  return "no interactive TUI";
}

function emitUnattendedRecoverySkipped(worker, job, label, details = {}) {
  const reason = unattendedRecoveryReason(worker);
  worker?.emit?.(
    job.id,
    `${C.yellow}[recovery] WI#${job.work_item_id} ${label} dead-lettered; recovery human_input skipped (${reason})${C.reset}`,
  );
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY,
    actor_type: EVENT_ACTORS.WORKER,
    message: `${label} dead-letter recovery skipped (${reason})`,
    event_json: JSON.stringify({
      suppressed: true,
      reason,
      ...details,
    }),
  });
}

function currentProviderSettingSummary(job) {
  const role = providerSettingRoleForJobType(job?.job_type || "");
  const key = `provider_${role}`;
  let dbValue = null;
  try {
    dbValue = getSetting(key);
  } catch {
    dbValue = null;
  }
  const effective = dbValue || "claude";
  const source = dbValue ? "DB" : "default";
  return { role, key, effective, source, dbValue };
}

function isLikelySpawnFailureMessage(message) {
  const text = String(message || "");
  return (
    /failed to spawn|spawn enoent|spawn eacces/i.test(text) ||
    /system cannot find the path specified/i.test(text) ||
    /is not recognized as an internal or external command/i.test(text) ||
    /cannot find the file specified/i.test(text)
  );
}

function buildFastFailureProviderHint(job, attempts = []) {
  const failed = Array.isArray(attempts) ? attempts.filter((attempt) => attempt?.status === "failed") : [];
  if (failed.length < 3) return "";
  const recent = failed.slice(-3);
  if (!recent.every((attempt) => Number.isFinite(Number(attempt?.duration_ms)) && Number(attempt.duration_ms) < 1000)) return "";
  const repeatKeys = recent
    .map((attempt) => getErrorDetails(attempt?.error_text || "").repeatKey)
    .filter(Boolean);
  if (repeatKeys.length !== 3 || new Set(repeatKeys).size !== 1) return "";
  const latestError = String(recent[recent.length - 1]?.error_text || "");
  if (!isLikelySpawnFailureMessage(latestError)) return "";

  const provider = currentProviderSettingSummary(job);
  const dbPart = provider.dbValue ? `${provider.key}=${provider.dbValue} (DB)` : `${provider.key}=<unset> (DB)`;
  return [
    "Repeated fast failures suggest a provider spawn/config issue (3 attempts <1000ms with identical error).",
    `Current setting: ${provider.key}=${provider.effective} (effective source: ${provider.source}; ${dbPart}).`,
    `If needed, switch provider now with: posse admin set ${provider.key} claude`,
  ].join("\n");
}

function buildPermanentProviderConfigHint(job, errorDetails = null) {
  const provider = currentProviderSettingSummary(job);
  const role = providerRoleForJobType(job?.job_type) || provider.role || "dev";
  let model = null;
  try {
    model = tierModelName(job?.model_tier || "standard", {
      role,
      providerName: job?.provider || undefined,
    });
  } catch {
    model = null;
  }
  return [
    "The final error matches a provider authentication, credential, model access, or unsupported-model configuration failure. Retrying the same settings is not expected to help.",
    `Current setting: ${provider.key}=${provider.effective} (effective source: ${provider.source}).`,
    model ? `Resolved model for ${role}/${job?.model_tier || "standard"}: ${model}.` : null,
    errorDetails?.summary ? `Error summary: ${errorDetails.summary}` : null,
    "Fix the credential/model setting or choose a provider/model with access before retrying.",
  ].filter(Boolean).join("\n");
}

function hasConsecutiveFastFailures(attempts = [], {
  minFailures = 3,
  maxDurationMs = 5000,
} = {}) {
  const failed = Array.isArray(attempts)
    ? attempts.filter((attempt) => attempt?.status === "failed")
    : [];
  if (failed.length < minFailures) return false;
  const recent = failed.slice(-minFailures);
  return recent.every((attempt) => {
    const duration = Number(attempt?.duration_ms);
    return Number.isFinite(duration) && duration > 0 && duration < maxDurationMs;
  });
}

export function spawnDeadLetterRecoveryForDependents(worker, job, freshJob = null, {
  reasonText = "exhausted all retries and was dead-lettered",
  providerHint = null,
  context = null,
} = {}) {
  const dependents = getDependents(job.id);
  const isRecoveryJob = job.job_type === "human_input" || (job.title && job.title.startsWith("Dead-letter recovery:"));
  if (dependents.length === 0 || isRecoveryJob) {
    return { spawned: false, recoveryJob: null, dependents, isRecoveryJob, suppressed: false };
  }
  if (recoveryIsUnattended(worker)) {
    emitUnattendedRecoverySkipped(worker, job, "Dependent job", {
      dependent_count: dependents.length,
      recovery_kind: "dead_letter_recovery",
    });
    return { spawned: false, recoveryJob: null, dependents, isRecoveryJob, suppressed: true };
  }

  const attemptHistory = buildAttemptSummary(job.id);
  const resolvedProviderHint = providerHint ?? buildFastFailureProviderHint(job, getAttempts(job.id));
  const attemptCount = Number(freshJob?.attempt_count ?? job?.attempt_count ?? 0);
  const recoveryJob = createJob({
    work_item_id: job.work_item_id,
    job_type: "human_input",
    title: `Dead-letter recovery: ${job.title.slice(0, 80)}`,
    parent_job_id: job.id,
    priority: "urgent",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      review_type: "dead_letter_recovery",
      questions: [
        `Job #${job.id} "${job.title}" ${reasonText}.\n\n--- ATTEMPT HISTORY ---\n${attemptHistory}\n\n${dependents.length} downstream job(s) depend on this. What should we do?\n- Provide specific instructions for a retry\n- Retry with a different provider (claude/openai/codex/grok)\n- Skip this job and unblock dependents\n- Simplify the task scope${resolvedProviderHint ? `\n\n--- PROVIDER DIAGNOSTICS ---\n${resolvedProviderHint}` : ""}`,
      ],
      context: context || `This job has been dead-lettered after ${attemptCount} attempts. Its ${dependents.length} downstream dependent(s) are temporarily gated on this recovery job. A retry answer will spawn a replacement job and rewire dependents to that retry; only an explicit skip/unblock answer lets dependents proceed without a retry.`,
    }),
  });
  for (const dependent of dependents) {
    rewireDependency(dependent.job_id, job.id, recoveryJob.id, dependent.dependency_kind);
  }
  worker.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} spawned human_input #${recoveryJob.id} — ${dependents.length} dep(s) rewired${C.reset}`);
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Dead-letter recovery: spawned human_input #${recoveryJob.id}, rewired ${dependents.length} dependent(s)`,
  });

  return { spawned: true, recoveryJob, dependents, isRecoveryJob, suppressed: false };
}

function isTurnBudgetExhaustedError(errorDetails = null) {
  return isTurnBudgetExhaustedDetails(errorDetails);
}

function nextTier(currentTier = "standard") {
  if (currentTier === "cheap") return "standard";
  if (currentTier === "standard") return "strong";
  return currentTier || "standard";
}

function applyResearchTurnBudgetRetryMode(payload, freshJob, errorDetails) {
  let changed = false;
  const setPayloadValue = (key, value) => {
    if (payload[key] !== value) {
      payload[key] = value;
      changed = true;
    }
  };

  setPayloadValue("_research_retry_synthesis", true);
  setPayloadValue("deepthink", false);
  setPayloadValue("deepthink_budget", "low");
  setPayloadValue("research_budget", "low");

  const marker = "RESEARCH TURN-BUDGET RETRY MODE:";
  const existingInstructions = String(payload.instructions || payload.task_spec || freshJob.title || "").trim();
  if (!existingInstructions.includes(marker)) {
    const retryBlock = [
      marker,
      "The previous research attempt exhausted its turn/tool budget. Do not retry the same broad exploration shape.",
      "Synthesize a partial, evidence-backed brief from prior attempt context and any already available evidence.",
      "If a targeted verification read is essential, keep it minimal; otherwise stop reading and return the brief now.",
      "Include files/symbols consulted, why each matters, unknowns, and stop_reason=turn_budget_retry_partial_synthesis.",
      errorDetails?.summary ? `Previous stop reason: ${errorDetails.summary}` : null,
    ].filter(Boolean).join("\n");
    payload.instructions = [existingInstructions, retryBlock].filter(Boolean).join("\n\n");
    changed = true;
  }

  return changed;
}

function tuneTurnBudgetRetry(worker, freshJob, errorDetails) {
  if (!freshJob?.id || !isTurnBudgetExhaustedError(errorDetails)) return { tuned: false };

  const payload = parseJobPayload(freshJob);

  const retryCount = Number.parseInt(String(payload._turn_budget_retry_count || 0), 10) || 0;
  if (retryCount >= 1) {
    worker.emit(
      freshJob.id,
      `${C.yellow}[retry-tuning]${C.reset} WI#${freshJob.work_item_id} job #${freshJob.id}: turn-budget retry tuning already applied; leaving payload/model unchanged`,
    );
    logEvent({
      work_item_id: freshJob.work_item_id,
      job_id: freshJob.id,
      event_type: EVENT_TYPES.JOB_TURN_BUDGET_RETRY_CAP_REACHED,
      actor_type: EVENT_ACTORS.WORKER,
      message: "Turn-budget retry tuning already applied; leaving payload/model unchanged",
      event_json: JSON.stringify({
        retry_count: retryCount,
      }),
    });
    return { tuned: false, retryCount, capped: true };
  }

  const nextRetryCount = Math.max(1, retryCount + 1);
  let payloadChanged = false;
  const isResearchJob = String(freshJob.job_type || "").toLowerCase() === "research";

  if (isResearchJob) {
    payloadChanged = applyResearchTurnBudgetRetryMode(payload, freshJob, errorDetails) || payloadChanged;
  } else if (ROLE_DRIVEN_JOB_TYPES.has(String(freshJob.job_type || "").toLowerCase())) {
    const currentBudget = String(payload.deepthink_budget || payload.research_budget || "").trim().toLowerCase();
    if (currentBudget !== "xhigh") {
      payload.deepthink_budget = "xhigh";
      payload.research_budget = "xhigh";
      payloadChanged = true;
    }
    if (payload.deepthink !== true) {
      payload.deepthink = true;
      payloadChanged = true;
    }
  } else {
    const currentBudget = String(payload.deepthink_budget || "").trim().toLowerCase();
    if (currentBudget !== "high" && currentBudget !== "xhigh") {
      payload.deepthink_budget = "high";
      payloadChanged = true;
    }
    if (payload.deepthink !== true) {
      payload.deepthink = true;
      payloadChanged = true;
    }
  }

  if (payload._turn_budget_retry_count !== nextRetryCount) {
    payload._turn_budget_retry_count = nextRetryCount;
    payloadChanged = true;
  }

  const prevTier = freshJob.model_tier || "standard";
  const bumpedTier = isResearchJob ? "cheap" : nextTier(prevTier);
  const tierChanged = bumpedTier !== prevTier;
  const modelCleared = isResearchJob && freshJob.model_name != null;

  if (payloadChanged) {
    updateJobPayload(freshJob.id, JSON.stringify(payload));
  }
  if (tierChanged || modelCleared) {
    applyDelegation(freshJob.id, {
      model_tier: bumpedTier,
      ...(isResearchJob ? { model: null } : {}),
    });
  }

  if (payloadChanged || tierChanged || modelCleared) {
    const budget = payload.deepthink_budget || payload.research_budget || null;
    worker.emit(
      freshJob.id,
      `${C.yellow}[retry-tuning]${C.reset} WI#${freshJob.work_item_id} job #${freshJob.id}: turn-budget retry tuning applied${tierChanged ? ` (${prevTier} -> ${bumpedTier})` : ""}${budget ? `, budget=${budget}` : ""}${modelCleared ? ", model=auto" : ""}`,
    );
    logEvent({
      work_item_id: freshJob.work_item_id,
      job_id: freshJob.id,
      event_type: EVENT_TYPES.JOB_TURN_BUDGET_RETRY_TUNED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Turn-budget retry tuning applied${tierChanged ? ` (${prevTier} -> ${bumpedTier})` : ""}${budget ? `, budget=${budget}` : ""}${modelCleared ? ", model=auto" : ""}`,
      event_json: JSON.stringify({
        previous_tier: prevTier,
        next_tier: bumpedTier,
        model_cleared: modelCleared,
        deepthink: payload.deepthink === true,
        deepthink_budget: budget,
        retry_count: nextRetryCount,
        research_retry_synthesis: isResearchJob,
      }),
    });
  }

  return {
    tuned: payloadChanged || tierChanged || modelCleared,
    payloadChanged,
    tierChanged,
    modelCleared,
    nextTier: bumpedTier,
    retryCount: nextRetryCount,
    researchRetrySynthesis: isResearchJob,
  };
}

export function retryOrFail(worker, job, leaseToken, errorOrMsg, { stallExhausted = false } = {}) {
  const freshJob = getJob(job.id);
  const errorDetails = getErrorDetails(errorOrMsg);
  const errSummary = errorDetails.summary || "unknown error";
  const errRepeatKey = errorDetails.repeatKey || errSummary;
  const turnBudgetExhausted = isTurnBudgetExhaustedError(errorDetails);
  const permanentProviderConfigError = isPermanentProviderConfigError(errorDetails);
  const transientCommitInfraFailure = isTransientCommitInfraFailure(errorOrMsg);

  if (worker.shuttingDown) {
    const released = worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    if (released) {
      worker.emit(job.id, `${C.dim}[worker] WI#${job.work_item_id} job #${job.id} interrupted by shutdown — requeuing${C.reset}`);
    }
    return;
  }

  if (!freshJob) {
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} disappeared before retry/dead-letter handling; assuming external cleanup${C.reset}`);
    return;
  }

  let sameErrorRepeat = false;
  let failedAttempts = [];
  if (permanentProviderConfigError) {
    worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: permanent provider configuration/model error — dead-lettering without retry${C.reset}`);
  } else if (!turnBudgetExhausted && freshJob.attempt_count >= 2) {
    const prevAttempts = getAttempts(job.id);
    failedAttempts = prevAttempts.filter((attempt) => attempt.status === "failed");
    if (failedAttempts.length >= 2) {
      const prev = failedAttempts[failedAttempts.length - 2];
      if (prev.error_text) {
        const prevRepeatKey = getErrorDetails(prev.error_text).repeatKey;
        if (prevRepeatKey === errRepeatKey) {
          sameErrorRepeat = true;
          worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: same error on consecutive attempts — dead-lettering (escalation won't help)${C.reset}`);
        }
      }
      if (!sameErrorRepeat && failedAttempts.length >= 3) {
        const recentErrors = failedAttempts
          .slice(-4)
          .map((attempt) => getErrorDetails(attempt.error_text || "").repeatKey)
          .filter(Boolean);
        recentErrors.push(errRepeatKey);
        const uniqueErrors = new Set(recentErrors.filter(Boolean));
        if (uniqueErrors.size <= 2 && uniqueErrors.size > 0) {
          sameErrorRepeat = true;
          worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: cycling between ${uniqueErrors.size} error(s) across ${failedAttempts.length + 1} attempts — dead-lettering${C.reset}`);
        }
      }
    }
  }

  // If the same-error guard fired but the next attempt would actually swap
  // models (e.g. a provider whose `standard` and `strong` tiers resolve to the
  // same model id, so only some tier bumps change the model), suppress the
  // dead-letter so the retry runs on a genuinely different model. Mirrors the
  // idempotency-guard pattern in Worker.js for identical-output retries.
  if (!permanentProviderConfigError && sameErrorRepeat && freshJob.attempt_count < freshJob.max_attempts && failedAttempts.length > 0) {
    const lastFailed = failedAttempts[failedAttempts.length - 1];
    const lastModel = lastFailed?.model_name || null;
    if (lastModel) {
      const role = providerRoleForJobType(freshJob.job_type) || "dev";
      const providerName = freshJob.provider || undefined;
      const resolveModel = (tier) => tierModelName(tier, { role, providerName });
      try {
        const nextTier = escalateModelTier(
          freshJob.model_tier || "standard",
          freshJob.attempt_count + 1,
          { resolveModel },
        );
        const nextModel = resolveModel(nextTier);
        if (nextModel && nextModel !== lastModel) {
          sameErrorRepeat = false;
          worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: same error repeated, but next attempt swaps model ${lastModel} -> ${nextModel} — allowing retry${C.reset}`);
        }
      } catch {
        // If model resolution throws (e.g. settings DB unavailable),
        // fall back to the original same-error dead-letter behavior
        // rather than silently masking the failure.
      }
    }
  }

  if (!permanentProviderConfigError && sameErrorRepeat && transientCommitInfraFailure && freshJob.attempt_count < freshJob.max_attempts) {
    sameErrorRepeat = false;
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: repeated transient git/native infrastructure fault — allowing bounded retry${C.reset}`);
  }

  if (permanentProviderConfigError || sameErrorRepeat || freshJob.attempt_count >= freshJob.max_attempts) {
    const reason = stallExhausted
      ? "stall retries exhausted"
      : (permanentProviderConfigError ? "permanent provider configuration/model error" : (sameErrorRepeat ? "same error repeated" : `exceeded max attempts (${freshJob.attempt_count}/${freshJob.max_attempts})`));
    log.error("worker", `Dead letter: ${job.job_type} #${job.id}`, { jobId: job.id, wiId: job.work_item_id, type: job.job_type, attempts: freshJob.attempt_count, error: errSummary, reason });
    jobLog("DEAD_LETTER", { wi: job.work_item_id, job: job.id, detail: `${job.job_type} "${shortJobTitle(job).slice(0, 50)}" — ${reason}: ${errSummary}` });
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      observation_type: "job.dead_letter",
      summary: `${reason}: ${errSummary}`,
      detail: { attempts: freshJob.attempt_count, max_attempts: freshJob.max_attempts, error: errorDetails.fullText, repeat_key: errRepeatKey, permanent_provider_config_error: permanentProviderConfigError },
    });
    worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id} ${reason} → dead_letter${C.reset}`);
    worker.emit(job.id, `${C.red}  → ${errSummary}${C.reset}`);
    try {
      const allAttempts = getAttempts(job.id);
      const promptArtifacts = getArtifacts(job.id, "prompt");
      const responseArtifacts = getArtifacts(job.id, "response");
      const lastPrompt = promptArtifacts.length > 0 ? promptArtifacts[promptArtifacts.length - 1].content_long : "";
      const lastResponse = responseArtifacts.length > 0 ? responseArtifacts[responseArtifacts.length - 1].content_long : "";
      const failureSummary = [
        `## Dead Letter: ${job.title}`,
        `**Job:** #${job.id} (${job.job_type}) | **WI:** #${job.work_item_id}`,
        `**Attempts:** ${freshJob.attempt_count}/${freshJob.max_attempts}`,
        `**Final Error:** ${errSummary}`,
        "",
        "### Attempt History",
        ...allAttempts.map((attempt) =>
          `- Attempt ${attempt.attempt_number} (${attempt.status}): ${attempt.error_text || "no error recorded"}`
        ),
        "",
        "### Last Prompt Excerpt",
        buildPromptExcerpt(lastPrompt),
        "",
        "### Last Response Excerpt",
        buildPromptExcerpt(lastResponse),
      ].join("\n");
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        artifact_type: "log",
        content_long: failureSummary,
      });
    } catch {
      // don't let artifact storage failure block recovery
    }

    if (job.job_type === "preflight") {
      const researchJob = spawnResearchAfterPreflight(worker, job, null, { fallbackReason: errSummary });
      worker.emit(job.id, `${C.yellow}[preflight]${C.reset} WI#${job.work_item_id}: preflight failed; fallback research job #${researchJob.id} queued`);
      worker._releaseLease(job, leaseToken, "dead_letter");
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }

    const providerHint = permanentProviderConfigError
      ? buildPermanentProviderConfigHint(job, errorDetails)
      : buildFastFailureProviderHint(job, getAttempts(job.id));
    const recovery = spawnDeadLetterRecoveryForDependents(worker, job, freshJob, { providerHint });
    const { dependents, isRecoveryJob } = recovery;
    const deadLetterPayload = parseJobPayload(job);
    const isOneshotLeaf = job.job_type === "dev" && (deadLetterPayload.oneshot === true || deadLetterPayload.oneshot_origin === true);
    if (!recovery.spawned && dependents.length === 0 && !isRecoveryJob && (job.job_type === "research" || isOneshotLeaf)) {
      if (recoveryIsUnattended(worker)) {
        emitUnattendedRecoverySkipped(worker, job, isOneshotLeaf ? "One-shot" : "Research", {
          recovery_kind: isOneshotLeaf ? "oneshot_dead_letter_recovery" : "research_dead_letter_recovery",
        });
      } else {
        const attemptHistory = buildAttemptSummary(job.id);
        const pipelineHeadLabel = isOneshotLeaf ? "One-shot dev job" : "Research job";
        const recoveryJob = createJob({
          work_item_id: job.work_item_id,
          job_type: "human_input",
          title: `${isOneshotLeaf ? "One-shot failed" : "Research failed"}: ${job.title.slice(0, 80)}`,
          parent_job_id: job.id,
          priority: "urgent",
          model_tier: "cheap",
          payload_json: JSON.stringify({
            original_job_id: job.id,
            review_type: isOneshotLeaf ? "oneshot_dead_letter_recovery" : "research_dead_letter_recovery",
            questions: [
              `${pipelineHeadLabel} #${job.id} "${job.title}" failed all attempts and was dead-lettered.\n\n--- ATTEMPT HISTORY ---\n${attemptHistory}\n\nThis is the pipeline head — nothing else can proceed until this is resolved.\nShould we retry with different parameters, retry with a different provider (claude/openai/codex/grok), simplify the scope, replan, or fix config/access first?${providerHint ? `\n\n--- PROVIDER DIAGNOSTICS ---\n${providerHint}` : ""}`,
            ],
            context: `This ${isOneshotLeaf ? "one-shot dev" : "research"} job is the pipeline head for the work item. No downstream jobs exist yet. The attempt history shows what went wrong on each try.`,
          }),
        });
        worker.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} ${isOneshotLeaf ? "one-shot" : "research"} dead-lettered — spawned human_input #${recoveryJob.id}${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY,
          actor_type: EVENT_ACTORS.WORKER,
          message: `${isOneshotLeaf ? "One-shot" : "Research"} dead-letter recovery: spawned human_input #${recoveryJob.id}`,
        });
      }
    } else if (dependents.length === 0 && !isRecoveryJob && stallExhausted) {
      const stallRecoveryCount = stallRecoveryRetryCount(job);
      if (stallRecoveryCount >= MAX_STALL_EXHAUSTED_RECOVERY_RETRIES) {
        worker.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} stall recovery cap reached for job #${job.id}; leaving dead-lettered${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          event_type: EVENT_TYPES.JOB_STALL_RECOVERY_CAP_REACHED,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Stall-exhausted recovery cap reached after ${stallRecoveryCount} retry prompt(s)`,
          event_json: JSON.stringify({
            stall_recovery_count: stallRecoveryCount,
            max_stall_recoveries: MAX_STALL_EXHAUSTED_RECOVERY_RETRIES,
          }),
        });
      } else {
        if (recoveryIsUnattended(worker)) {
          emitUnattendedRecoverySkipped(worker, job, "Stall", {
            recovery_kind: "stall_exhausted_recovery",
            stall_recovery_count: stallRecoveryCount,
          });
        } else {
          const attemptHistory = buildAttemptSummary(job.id);
          const recoveryJob = createJob({
            work_item_id: job.work_item_id,
            job_type: "human_input",
            title: `Stall recovery: ${job.title.slice(0, 80)}`,
            parent_job_id: job.id,
            priority: "urgent",
            model_tier: "cheap",
            payload_json: JSON.stringify({
              original_job_id: job.id,
              questions: [
                `Job #${job.id} "${job.title}" was dead-lettered after repeated stall kills.\n\n--- ATTEMPT HISTORY ---\n${attemptHistory}\n\nHow should we proceed?\n- Retry with a larger stall timeout\n- Retry with a different provider\n- Narrow/simplify scope\n- Skip this job`,
              ],
              context: `This job repeatedly stalled and exhausted the stall retry budget. It has no downstream dependents, so explicit operator guidance is needed before retrying.`,
              review_type: "stall_exhausted_recovery",
            }),
          });
          worker.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} stalled out — spawned human_input #${recoveryJob.id}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.JOB_DEAD_LETTER_RECOVERY,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Stall-exhausted recovery: spawned human_input #${recoveryJob.id}`,
            event_json: JSON.stringify({
              recovery_job_id: recoveryJob.id,
              stall_recovery_count: stallRecoveryCount,
              max_stall_recoveries: MAX_STALL_EXHAUSTED_RECOVERY_RETRIES,
            }),
          });
        }
      }
    }

    worker._releaseLease(job, leaseToken, "dead_letter");
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
  } else {
    if (turnBudgetExhausted) {
      tuneTurnBudgetRetry(worker, freshJob, errorDetails);
    }

    const retryPolicy = RetryPolicy.fromJob(freshJob);
    let backoffSec = retryPolicy.backoffFor(freshJob.attempt_count);
    if (turnBudgetExhausted) backoffSec = Math.min(backoffSec, 2);
    let circuitReroute = null;
    const failedAttempts = getAttempts(job.id).filter((attempt) => attempt.status === "failed");
    const executionProvider = job._executionProvider || freshJob.provider || job.provider || null;
    const providerPool = Array.isArray(job._allowedProviders)
      ? [...new Set(job._allowedProviders.filter(Boolean))]
      : [];
    if (
      executionProvider
      && providerPool.length > 1
      && !worker._isProviderCircuitOpen(executionProvider)
      && hasConsecutiveFastFailures(failedAttempts, { minFailures: 3, maxDurationMs: 5000 })
    ) {
      const fallbackProvider = worker._selectHealthyProviderFromPool(providerPool, executionProvider);
      const reason = `3 consecutive failed attempts under 5000ms for ${executionProvider}`;
      worker._openProviderCircuit(executionProvider, reason);
      recordObservation({
        work_item_id: job.work_item_id,
        job_id: job.id,
        observation_type: "provider.circuit_open",
        summary: `${executionProvider} marked unhealthy for this run`,
        detail: {
          reason,
          provider: executionProvider,
          provider_pool: providerPool,
        },
      });
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_PROVIDER_CIRCUIT_OPEN,
        actor_type: EVENT_ACTORS.WORKER,
        message: `${executionProvider} marked unhealthy for this run after consecutive fast failures`,
        event_json: JSON.stringify({
          provider: executionProvider,
          provider_pool: providerPool,
          reason,
        }),
      });
      if (fallbackProvider) {
        updateJobProvider(job.id, fallbackProvider, null);
        circuitReroute = { from: executionProvider, to: fallbackProvider };
        backoffSec = Math.min(backoffSec, 5);
        worker.emit(job.id, `${C.yellow}[circuit]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} fast-failed repeatedly; rerouting retry to ${fallbackProvider}`);
      } else {
        worker.emit(job.id, `${C.yellow}[circuit]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} fast-failed repeatedly; no healthy fallback provider configured`);
      }
    }
    const readyAt = new Date(Date.now() + backoffSec * 1000).toISOString();
    const retryWording = retryingAttemptWording(errorDetails);
    const retryLead = retryWording
      ? `${retryWording.displayVerb} (attempt ${freshJob.attempt_count}/${freshJob.max_attempts}), requeuing in ${backoffSec}s`
      : `failed (attempt ${freshJob.attempt_count}/${freshJob.max_attempts}), retrying in ${backoffSec}s`;
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${retryLead}${C.reset}`);
    worker.emit(job.id, `${C.yellow}  → ${errSummary}${C.reset}`);

    const retrySummary = retryWording
      ? `Attempt ${freshJob.attempt_count}/${freshJob.max_attempts} ${retryWording.summaryVerb}`
      : `Attempt ${freshJob.attempt_count}/${freshJob.max_attempts} failed`;
    jobLog("ATTEMPT_FAIL", { wi: job.work_item_id, job: job.id, detail: `attempt ${freshJob.attempt_count}/${freshJob.max_attempts}, retry in ${backoffSec}s - ${errSummary}` });
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      observation_type: "attempt.failed",
      summary: retrySummary,
      detail: { error: errorDetails.fullText, repeat_key: errRepeatKey, backoff_sec: backoffSec },
    });

    const retryEventMessage = retryWording
      ? `Attempt ${freshJob.attempt_count}/${freshJob.max_attempts} ${retryWording.eventVerb} - requeuing in ${backoffSec}s`
      : `Attempt ${freshJob.attempt_count}/${freshJob.max_attempts} failed - retrying in ${backoffSec}s`;
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ATTEMPT_FAILED,
      actor_type: EVENT_ACTORS.WORKER,
      message: retryEventMessage,
      event_json: JSON.stringify({
        attempt: freshJob.attempt_count,
        max_attempts: freshJob.max_attempts,
        error: errorDetails.fullText?.slice(0, 500) || null,
        repeat_key: errRepeatKey,
        backoff_sec: backoffSec,
        ready_at: readyAt,
        provider_reroute: circuitReroute,
        retry_reason: retryWording?.kind || null,
      }),
    });

    worker._releaseLease(job, leaseToken, "queued", { readyAt });
  }
}
