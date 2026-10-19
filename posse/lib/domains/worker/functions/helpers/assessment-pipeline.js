import { DETERMINISTIC_AUDIT_ROLE } from "../../../../catalog/worker-display.js";
import { assessmentDisplayMessage } from "../execution/display-sync.js";
import { diffPorcelainEntries } from "../../../git/functions/porcelain-diff.js";
import { authoritativeFinalReview, latestFinalReview } from "../../../assessment/functions/final-review-authority.js";
import { reserveFinalReviewContinuation } from "../../../assessment/functions/final-review-continuation.js";
// lib/domains/worker/functions/helpers/assessment-pipeline.js
//
// Post-execution assessment pipeline extracted from worker.js.

import path from "path";
import crypto from "crypto";
import { acquireAssessmentBarrier, beginAttachedAssessmentAttempt, completeAttempt, createJob, getArtifacts, getAttempts, getJob, getWorkItem, isLeaseValid, logEvent, setJobError, setAssessmentLifecycle, storeArtifact, updateJobPayload, updateJobStatus } from "../../../queue/functions/index.js";
import { getRecentArtifacts } from "../../../queue/functions/artifacts.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { isArtifactMode, buildManifest, validateManifestAgainstContract } from "../../../artifacts/functions/index.js";
import { harnessAssessorEffort, harnessAssessorProvider } from "./assessment-shared.js";
import { getProviderBackoff } from "../../../providers/functions/provider.js";
import { attachAssessmentDiffContextAsync, buildHandoffPacket, composePromptRemoteAware, handoff, renderAtlasHandoffSections } from "../../../handoff/functions/index.js";
import { isRetryableTerminalHandoffError } from "../../../handoff/functions/agent-handoff.js";
import { getAgentHandoffRecord } from "../../../handoff/functions/agent-handoff-records.js";
import { refreshAndExtractInsights } from "./insights.js";
import { renderBaselineSiblingRegression } from "./baseline-attribution.js";
import { renderBaselineTestDebt } from "./baseline-test-debt.js";
import { gitExecAsync, gitHasChangesAsync } from "../../../git/functions/utils.js";
import { listIgnoredRepoPaths } from "../../../git/functions/ignored-paths.js";
import { snapshotAndResetDirtyWorktreeAsync, stashDirtyWorktreeAsync } from "../../../git/functions/worktree.js";
import { ASSESSABLE_JOB_TYPES, ASSESSMENT_LIFECYCLE, JOB_ASSESSOR_MODEL_VERDICTS } from "../../../../catalog/job.js";
import { ASSESSMENT_VERDICT_OBSERVATION_TYPE } from "../../../../catalog/observation.js";
import { AGENT_HANDOFF_PROFILES } from "../../../../catalog/handoff.js";
import { PIXEL_VISUAL_EVIDENCE_TOOL_NAMES, UNSUCCESSFUL_VISUAL_TOOL_STATUSES } from "../../../../catalog/assessment.js";
import { effectiveArtifactTaskMode } from "../../../providers/functions/execution-routing.js";
import { artifactOutputClaimsReusableComplete, filterNewOrChangedManifestFiles, materializeFallbackArtifactOutput } from "./artifact-output.js";
import { scopedDeleteTargets } from "./mutation-guards.js";
import { sanitizeHumanQuestions } from "./human-question-classifier.js";
import { buildWorkflowModeBlock, getWorkItemWorkflowConfig } from "../../../intake/functions/hints.js";
import { isTestCollateralPath } from "../../../../shared/policies/functions/scope-auto-approval.js";
import { processVerdict } from "./process-verdict.js";
import { normalizeAssessorConfidence } from "./verdict-shared.js";
import { activeSiblingWriteLocks, siblingLockSummary } from "../../../queue/functions/sibling-locks.js";
import { siblingJobScopeOwners, siblingOwnedWorktreePaths } from "../../../queue/functions/file-locks.js";
import { getAtlasWarmJobCompletion, waitForAtlasWarmJobCompletion } from "../../../atlas/classes/v2/PipelineHooks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../../catalog/native-tools.js";
import { ASSESSMENT_FAILURE_CLASSES } from "../../../../catalog/human-input.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { runImmediateTransaction } from "../../../queue/functions/common.js";
import { persistPendingAssessmentFileRequests, shouldDeferAssessmentToFileRequestContinuation } from "./assessment-file-requests.js";
import { testRunScopeAttribution, ensurePostChangeTestReceipt, renderTestExecutionEvidence, postChangeTestLogSummary, testReceiptObservationDetail } from "./test-execution-receipt.js";
import { buildAssessmentTaskBoundary, classifySiblingOnlyAssessmentFailure, recordAssessmentBoundaryEvent, renderAssessmentTaskBoundary } from "./assessment-task-boundary.js";
import { classifyIgnoredPathOnlyAssessmentFailure, ignoredPathReviewVerdict, recordAssessmentIgnoredPathEvent, renderIgnoredPathCorrection } from "./assessment-ignored-paths.js";
import { killShellCommandProcessTree as killShellCommandProcessTreeImpl, runShellCommandAsync as runShellCommandAsyncImpl } from "./assessment-runner.js";
import { assessorCallBudgetStatus, getAssessorMaxToolCalls, isAssessorParseRetryBudgetExceeded as assessorTokenBudgetStatus, missingArtifactDeliverables, raiseAssessmentFallbackReadsForScope } from "../execution/assessment-policy.js";
import { ensureAssessmentScopedCheckEvidence } from "../../../assessment/functions/scoped-check-evidence.js";
import { prepareReviewedFileCompletion } from "../../../assessment/functions/reviewed-file-completion.js";
import { assessmentWorktreeDirtySummary, inspectAssessmentWorktreeReadiness, recordAssessmentWorktreeReadiness } from "./assessment-worktree-readiness.js";
import { ensureConfiguredVerification, renderConfiguredVerificationEvidence } from "./configured-verification.js";
import { repairTestDependencies } from "./test-dependency-repair.js";
import { renderTestStrictness } from "../../../settings/functions/test-strictness.js";
import { isBlockingVerificationInfrastructureOutcome, verificationInfrastructureError } from "./verification-outcome.js";

export { capVerdictForDeterministicTestRegression } from "./verdict-shared.js";
export {
  buildAssessmentTaskBoundary,
  classifySiblingOnlyAssessmentFailure,
  renderAssessmentTaskBoundary,
} from "./assessment-task-boundary.js";
import { workItemResearchRefsBlock } from "../../../research/functions/work-item-research-refs.js";
import { buildAssessmentFileSnapshots } from "../../../assessment/functions/assessment-file-snapshots.js";
import { mergeUniquePaths, findOutOfScopeCommittedFiles, buildCommittedScopeViolationVerdict, buildAssessmentProviderScope } from "../../../assessment/functions/assessment-scope.js";
import { buildLocalAssessmentEvidence, renderAssessmentDependencyDiffs } from "../../../assessment/functions/assessment-evidence.js";

export function taskAbAssessorTier(workItem) {
  let metadata = workItem?.metadata_json;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); }
    catch { return null; }
  }
  if (!metadata || typeof metadata !== "object" || metadata.ab_harness !== "task-ab") {
    return null;
  }
  const tier = String(metadata.ab_assessor_tier || "").trim().toLowerCase();
  return ["cheap", "standard", "strong"].includes(tier) ? tier : null;
}

export function effectiveAssessmentFallbackReads(requestedReads, issuedReads = null) {
  const requested = requestedReads == null ? Number.NaN : Number(requestedReads);
  let effective = Number.isFinite(requested) ? Math.max(0, requested) : null;
  const issued = issuedReads == null ? Number.NaN : Number(issuedReads);
  if (Number.isFinite(issued) && issued >= 0) {
    effective = effective == null ? issued : Math.min(effective, issued);
  }
  return effective;
}

function markAssessmentRetryAssessOnly(job, pendingFileRequests = null) {
  if (!job || !ASSESSABLE_JOB_TYPES.has(job.job_type)) return false;
  const payload = parseJobPayload(job);
  payload._assess_only = true;
  persistPendingAssessmentFileRequests(payload, pendingFileRequests);
  const nextPayloadJson = JSON.stringify(payload);
  updateJobPayload(job.id, nextPayloadJson);
  job.payload_json = nextPayloadJson;
  return true;
}

export function assessmentLifecycleStateFromOutcome(freshJob, verdict = null) {
  // processVerdict may deterministically cap a raw model pass to an effective
  // failure (for example, when required verification was rejected). The outer
  // job status is therefore authoritative whenever it is terminal; consulting
  // the raw verdict first produced assessment_passed + status=failed rows.
  if (freshJob?.status === "succeeded") return ASSESSMENT_LIFECYCLE.PASSED;
  if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
    return ASSESSMENT_LIFECYCLE.NEEDS_HUMAN;
  }
  if (freshJob?.status === "failed") return ASSESSMENT_LIFECYCLE.FAILED;
  if (verdict?.verdict === "pass") return ASSESSMENT_LIFECYCLE.PASSED;
  if (verdict?.verdict === "fail") return ASSESSMENT_LIFECYCLE.FAILED;
  return null;
}

export function assessmentVerdictFailureText(freshJob, verdict = null) {
  if (assessmentLifecycleStateFromOutcome(freshJob, verdict) !== ASSESSMENT_LIFECYCLE.FAILED) return null;
  const verdictName = String(verdict?.verdict || freshJob?.assessor_verdict || "failed").trim() || "failed";
  const reasons = (Array.isArray(verdict?.reasons) ? verdict.reasons : [])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean);
  const detail = reasons.length > 0 ? reasons.join("; ") : "No assessor reason was recorded.";
  return `Assessment verdict ${verdictName}: ${detail}`.slice(0, 4000);
}

export function updateAssessmentLifecycleFromVerdict(jobId, freshJob, verdict = null) {
  const state = assessmentLifecycleStateFromOutcome(freshJob, verdict);
  const error = assessmentVerdictFailureText(freshJob, verdict);
  if (state === ASSESSMENT_LIFECYCLE.PASSED || state === ASSESSMENT_LIFECYCLE.FAILED) {
    setAssessmentLifecycle(jobId, state, { error, completed: true });
  } else if (state === ASSESSMENT_LIFECYCLE.NEEDS_HUMAN) {
    setAssessmentLifecycle(jobId, state);
  }
  // Events and observations are retention-bounded. Keep the terminal reason
  // on the job row as well so a failed assessment remains diagnosable after
  // its detailed telemetry has been pruned.
  if (state === ASSESSMENT_LIFECYCLE.FAILED && error) setJobError(jobId, error);
  return { state, error };
}

// The attempt row is this execution's own; the job row may already belong to
// a new lease owner. A lost lease closes the attempt as interrupted and leaves
// the job untouched (the route below declines to write as well).
function recordAssessmentInfrastructureAttempt(job, leaseToken, attemptId, startTime, message) {
  if (!isLeaseValid(job.id, leaseToken)) {
    completeAttempt(attemptId, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: `Lease expired before the assessment infrastructure failure was recorded — ${message}`.slice(0, 4000),
    });
    return false;
  }
  completeAttempt(attemptId, {
    status: "succeeded",
    duration_ms: Date.now() - startTime,
    error_text: message,
  });
  setJobError(job.id, message);
  return true;
}

export function routeAssessmentInfrastructureFailure(worker, job, leaseToken, error, {
  pendingFileRequests = null,
  readyAt = null,
  failureClass = ASSESSMENT_FAILURE_CLASSES.INFRASTRUCTURE,
  question = null,
  operatorActionable = false,
} = {}) {
  // A delayed provider or runner result must not rewrite recovery state after
  // cancellation or another worker has taken ownership of this job.
  if (!isLeaseValid(job.id, leaseToken)) return { gated: false, infrastructureFailure: true, leaseLost: true };
  const message = String(error?.message || error || "Assessment unavailable");
  markAssessmentRetryAssessOnly(job, pendingFileRequests);
  const fresh = getJob(job.id) || job;
  const count = Number(fresh.assessment_attempt_count || 0);
  const max = Math.max(1, Number(fresh.assessment_max_attempts || 3));
  const gateImmediately = error?.assessmentGateImmediately === true;
  if (count >= max || gateImmediately) {
    const terminalProtocolFailure = isRetryableTerminalHandoffError(error);
    const diagnostic = `Assessment infrastructure exhausted after ${count}/${max} attempts: ${message}`;
    // Provider transport, protocol, and evidence-budget failures have no task
    // decision for a human to answer. Only callers enforcing an explicit
    // verification or worktree-integrity requirement may request a gate.
    const settled = runImmediateTransaction(getDb(), () => {
      if (!worker._releaseLease(job, leaseToken, operatorActionable ? "waiting_on_human" : "failed")) return false;
      const recoveryPayload = parseJobPayload(job);
      recoveryPayload._verification_blocked = {
        schema_version: 1,
        type: "verification_blocked",
        failure_class: failureClass,
        diagnostic,
        rerun_command: String(error?.rerun_command || "").trim() || null,
        verification_outcome: error?.verification_outcome || null,
      };
      updateJobPayload(job.id, JSON.stringify(recoveryPayload));
      setAssessmentLifecycle(job.id, operatorActionable ? ASSESSMENT_LIFECYCLE.NEEDS_HUMAN : ASSESSMENT_LIFECYCLE.FAILED, {
        error: diagnostic, completed: !operatorActionable,
      });
      setJobError(job.id, diagnostic);
      if (operatorActionable) createJob({
        work_item_id: job.work_item_id,
        job_type: "human_input",
        title: `Verification blocked: ${job.title.slice(0, 80)}`,
        parent_job_id: job.id,
        priority: "high",
        payload_json: JSON.stringify({
          original_job_id: job.id,
          review_type: "blocked_recovery",
          question_kind: "blocked_recovery",
          choices: WORK_ITEM_QUESTION_CHOICE_IDS.blocked_recovery,
          verification_failure_class: failureClass,
          questions: [question || `Assessment for job #${job.id} could not finish. Restore the runner or provider, then choose retry; or choose replan, explicit_waiver, or fail.`],
          context: [diagnostic, error?.rerun_command ? `Command: ${error.rerun_command}` : null]
            .filter(Boolean).join("\n").slice(0, 2000),
        }),
      });
      return true;
    });
    if (!settled) return { gated: false, infrastructureFailure: true, leaseLost: true };
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_INFRASTRUCTURE_EXHAUSTED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Assessment infrastructure exhausted after ${count}/${max} attempts; ${operatorActionable ? "preserved the job for operator recovery" : "failed closed without an operator gate"}`,
      event_json: JSON.stringify({
        attempts: count,
        max_attempts: max,
        terminal_protocol_failure: terminalProtocolFailure,
        error: message.slice(0, 2000),
        operator_actionable: operatorActionable,
        gated_immediately: gateImmediately,
        failure_class: failureClass,
      }),
    });
    worker.emit(job.id, `${C.yellow}[assessor] Assessment infrastructure exhausted; ${operatorActionable ? "job preserved for recovery" : "failed closed without an operator gate"}${C.reset}`);
    return {
      gated: operatorActionable,
      infrastructureFailure: true,
      terminalProtocolFailure,
    };
  }
  setAssessmentLifecycle(job.id, ASSESSMENT_LIFECYCLE.UNAVAILABLE, { error: message });
  worker._releaseLease(job, leaseToken, "queued", {
    readyAt: readyAt || new Date(Date.now() + 2_000).toISOString(),
  });
  return { gated: false };
}

/**
 * Classify terminal handoff failures against the independent assessment
 * budget. Implementation attempt accounting is deliberately irrelevant.
 */
export function assessmentTerminalHandoffRetryDecision(
  jobId,
  error,
) {
  const fresh = getJob(jobId);
  const failureCount = Number(fresh?.assessment_attempt_count || 0);
  const assessmentMaxAttempts = Math.max(
    1,
    Number(fresh?.assessment_max_attempts || 3),
  );
  if (!isRetryableTerminalHandoffError(error)) {
    return {
      retryable: false,
      retryAssessmentOnly: false,
      exhausted: false,
      failureCount,
      assessmentMaxAttempts,
    };
  }
  return {
    retryable: true,
    retryAssessmentOnly: true,
    exhausted: failureCount >= assessmentMaxAttempts,
    failureCount,
    assessmentMaxAttempts,
  };
}

function _looksLikeAssessorAccessLimitation(text) {
  const source = String(text || "").toLowerCase();
  if (!source) return false;
  return (
    source.includes("file-system access is blocked") ||
    source.includes("filesystem access is blocked") ||
    source.includes("enable read access") ||
    source.includes("provide the file contents") ||
    source.includes("provide the full diffs") ||
    source.includes("provide the diffs") ||
    source.includes("provide the content of") ||
    source.includes("full diffs or content") ||
    source.includes("diffs or content") ||
    source.includes("fallback read budget") ||
    source.includes("due to fallback read budget") ||
    source.includes("extend content read limits") ||
    source.includes("exact lines where") ||
    source.includes("cannot verify the claimed") ||
    source.includes("could not verify the actual committed files") ||
    source.includes("attempts to read files via the shell were rejected") ||
    source.includes("file-tool reads were canceled") ||
    source.includes("repo-read tool calls were canceled") ||
    /deterministic read(?:s)? (?:were|was) cancel(?:ed|led)/i.test(source)
  );
}

export function __testLooksLikeAssessorAccessLimitation(text) {
  return _looksLikeAssessorAccessLimitation(text);
}

function _addedScopedDiffText(scopedDiff = "") {
  return String(scopedDiff || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function _addedScopedTestDiffText(scopedDiff = "") {
  const added = [];
  let currentPath = "";
  for (const line of String(scopedDiff || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/.*?) (?:"?b\/)(.*?"?)$/.exec(line);
      currentPath = match ? match[1].replace(/^"|"$/g, "") : "";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim().split("\t", 1)[0];
      currentPath = rawPath === "/dev/null"
        ? ""
        : rawPath.replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++") && isTestCollateralPath(currentPath)) {
      added.push(line.slice(1));
    }
  }
  return added.join("\n");
}

function _disabledRequiredTestMarkers(scopedDiff = "") {
  const addedTests = _addedScopedTestDiffText(scopedDiff)
    || (!/^\+\+\+ /m.test(scopedDiff) ? _addedScopedDiffText(scopedDiff) : "");
  if (!addedTests) return [];
  // Remove comments and string contents while preserving literal truthiness.
  // A TODO comment or a fixture object is not a disabled test declaration.
  const literals = [];
  const code = addedTests.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (_all, literal) => {
      if (!literal) return " ";
      if (literal.length <= 2) return '""';
      const index = literals.push(literal.slice(0, 160)) - 1;
      return `"literal:${index}"`;
    },
  );
  const patterns = [
    /\b(?:describe|it|test)\.(?:skip|todo)\s*\(/gi,
    /\b(?:xdescribe|xit|xtest)\s*\(/gi,
    /@(?:pytest\.mark\.skip|unittest\.skip|Disabled)\b/gi,
    /\bpytest\.skip\s*\(/gi,
    /#\s*\[\s*ignore\s*\]/gi,
  ];
  const propertyMarkers = [...code.matchAll(/\b(?:test|it|describe)\s*\(\s*"[^"]*"\s*,\s*\{([^}]*)\}/g)]
    .flatMap(match => [...match[1].matchAll(/\b(?:todo|skip)\s*:\s*(true|"literal:\d+"|[1-9]\d*)\s*(?=[,}]|$)/g)]
      .map(property => property[0].replace(/"literal:(\d+)"/, (_match, index) => literals[Number(index)])));
  return [...new Set([
    ...patterns.flatMap(pattern => code.match(pattern) || []),
    ...propertyMarkers,
  ])];
}

function _buildDisabledRequiredTestsVerdict({ assessmentContext = null, taskSpec = "" } = {}) {
  const scopedDiff = assessmentContext?.scoped_git_diff || assessmentContext?.branch_net_diff || "";
  const markers = _disabledRequiredTestMarkers(scopedDiff);
  if (markers.length === 0) return null;
  const requirement = String(taskSpec || "");
  const requiresActiveTests = /\b(?:test|tests|testing|regression|coverage|assertion|assertions)\b/i.test(requirement);
  const explicitlyAllowsDisabledTests = /\b(?:allow|keep|preserve|create|add)\s+(?:(?:the|some|these|those|a|an)\s+)?(?:skipped|disabled|todo|ignored)\s+(?:tests?|coverage|assertions?|suites?)\b/i.test(requirement);
  if (!requiresActiveTests || explicitlyAllowsDisabledTests) return null;
  return {
    verdict: "fail",
    confidence: "high",
    reasons: [
      `Deterministic completion violation: required test work added disabled/TODO coverage (${markers.join(", ")}). Skipped required assertions do not satisfy the task even when the test command exits successfully.`,
    ],
    spawn_jobs: [],
    human_questions: [],
    suggestions: [],
    raw: "",
  };
}

export function __testBuildDisabledRequiredTestsVerdict(options = {}) {
  return _buildDisabledRequiredTestsVerdict(options);
}

// processVerdict can rewrite the assessor's verdict before recording it
// (confidence caps, low-confidence review routing, partial-deliverable
// acceptance). The ASSESSED log line and the assessment.verdict observation
// describe the recorded verdict; the assessor's own values ride along when
// they differ.
function _assessorVerdictDelta(verdict, effectiveVerdict) {
  const assessorVerdict = verdict?.verdict ?? null;
  const assessorConfidence = verdict?.confidence ?? null;
  if (assessorVerdict === (effectiveVerdict?.verdict ?? null)
    && assessorConfidence === (effectiveVerdict?.confidence ?? null)) return {};
  return { assessor_verdict: assessorVerdict, assessor_confidence: assessorConfidence };
}

function _looksLikeAssessorVerdictObject(value) {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.prototype.hasOwnProperty.call(value, "verdict")
      || Object.prototype.hasOwnProperty.call(value, "status")
      || Object.prototype.hasOwnProperty.call(value, "assessment")
      || Object.prototype.hasOwnProperty.call(value, "result")
    );
}

function imageAssessmentRequiresPixelEvidence(payload = {}) {
  if (String(payload?.task_mode || "").trim().toLowerCase() !== "image") return false;
  const criteria = Array.isArray(payload?.success_criteria) ? payload.success_criteria : [];
  const text = [payload?.task_spec, ...criteria]
    .map((value) => String(value || ""))
    .join("\n");
  return /\b(?:visual(?:ly)?|artwork|art direction|scene|depict(?:s|ed|ing)?|composition|layout|sty(?:le|led|ling)|theme|recognizable|copied|character|screenshot|readable at|look and feel|original (?:art|artwork|illustration|design|composition|layout|visual|scene))\b/i.test(text);
}

function pixelEvidenceToolName(use) {
  return String(use?.tool || use?.name || use?.tool_name || "")
    .trim()
    .toLowerCase()
    .split("__")
    .at(-1)
    .replace(/^tools[._]/, "");
}

// When the gateway ledger can answer for this agent call, the gateway's own
// view_image is judged by its recorded outcome there: a provider tool-use
// stream does not always carry a status (Claude's never does), so a refused
// view_image call would otherwise count as visual evidence.
function imageAssessmentHasPixelEvidence(toolUses = [], { ledgerAuthoritative = false } = {}) {
  return (Array.isArray(toolUses) ? toolUses : []).some((use) => {
    const normalizedName = pixelEvidenceToolName(use);
    if (ledgerAuthoritative && normalizedName === "view_image") return false;
    return PIXEL_VISUAL_EVIDENCE_TOOL_NAMES.includes(normalizedName)
      && !UNSUCCESSFUL_VISUAL_TOOL_STATUSES.includes(String(use?.status || "").trim().toLowerCase());
  });
}

// Successful view_image calls this agent call made, from the gateway's tool
// ledger (one finish row per call, with ok/outcome and the agent call id).
function viewImageSucceededInLedger({ attemptId, agentCallId, db = null } = {}) {
  const attempt = Number(attemptId);
  const agentCall = Number(agentCallId);
  if (!Number.isInteger(attempt) || attempt <= 0 || !Number.isInteger(agentCall) || agentCall <= 0) return false;
  let rows = [];
  try {
    rows = (db || getDb()).prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.view_image'
      ORDER BY id ASC
    `).all(attempt);
  } catch {
    return false;
  }
  return rows.some((row) => {
    let detail;
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { return false; }
    return Number(detail?.agent_call_id) === agentCall
      && detail?.phase === "finish"
      && detail?.ok === true
      && (!detail?.outcome || detail.outcome === "succeeded");
  });
}

export function assessorPixelEvidenceObserved({ toolUses = [], attemptId = null, agentCallId = null, db = null } = {}) {
  const ledgerAuthoritative = Number.isInteger(Number(attemptId)) && Number(attemptId) > 0
    && Number.isInteger(Number(agentCallId)) && Number(agentCallId) > 0;
  return imageAssessmentHasPixelEvidence(toolUses, { ledgerAuthoritative })
    || (ledgerAuthoritative && viewImageSucceededInLedger({ attemptId, agentCallId, db }));
}

function applyImageVisualEvidencePolicy({
  payload = {},
  verdict = null,
  toolUses = [],
  pixelEvidenceObserved = false,
} = {}) {
  if (!verdict || String(verdict.verdict || "").toLowerCase() !== "pass") return verdict;
  if (
    !imageAssessmentRequiresPixelEvidence(payload)
    || pixelEvidenceObserved
    || imageAssessmentHasPixelEvidence(toolUses)
  ) return verdict;
  return {
    ...verdict,
    verdict: "needs_review",
    confidence: "none",
    reasons: [
      "Automatic visual acceptance was withheld: artifact validation, dimensions, metadata, and OCR do not prove semantic scene matching, composition, style, originality, or copied-layout criteria without pixel-level inspection.",
      ..._normalizeAssessmentTextList(verdict.reasons),
    ],
    human_questions: [
      "Please visually inspect the generated image deliverables and confirm whether their scenes, composition, style, and originality satisfy the listed visual criteria.",
    ],
    spawn_jobs: [],
    _disable_internal_retry: true,
    _assessment_visual_review: true,
  };
}

export function __testApplyImageVisualEvidencePolicy(options = {}) {
  return applyImageVisualEvidencePolicy(options);
}

const ASSESSOR_VALID_VERDICTS = new Set(JOB_ASSESSOR_MODEL_VERDICTS);

function _isReusableAssessorVerdict(verdictJson, verdict) {
  return verdictJson?.repaired !== true
    && _looksLikeAssessorVerdictObject(verdict)
    && ASSESSOR_VALID_VERDICTS.has(verdict.verdict);
}

export function _normalizeAssessorVerdictShape(verdict, raw = "") {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return verdict;
  const rawVerdict = verdict.verdict ?? verdict.status ?? verdict.assessment ?? verdict.result ?? null;
  const normalizedVerdict = rawVerdict == null
    ? rawVerdict
    : String(rawVerdict).trim().toLowerCase();
  const normalized = {
    ...verdict,
    verdict: normalizedVerdict,
    confidence: normalizeAssessorConfidence(verdict.confidence, { fallback: "medium", allowNone: true }) || "none",
  };
  if (Array.isArray(normalized.reasons)) normalized.reasons = _normalizeAssessmentTextList(normalized.reasons);
  if (!Array.isArray(normalized.reasons) || normalized.reasons.length === 0) {
    const fallbackReason = normalized.summary || normalized.reason || normalized.notes;
    if (fallbackReason) {
      normalized.reasons = [_stringifyAssessmentText(fallbackReason)].filter(Boolean);
    }
  }
  if (!Array.isArray(normalized.spawn_jobs)) normalized.spawn_jobs = [];
  normalized.human_questions = _normalizeAssessmentTextList(normalized.human_questions);
  normalized.suggestions = _normalizeAssessmentTextList(normalized.suggestions);
  if (!normalized.raw && raw) normalized.raw = raw;
  return normalized;
}

function _stringifyAssessmentText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json != null) return json;
  } catch {
    // Fall through to String() for unusual in-process test values.
  }
  return String(value);
}

function _normalizeAssessmentTextList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(_stringifyAssessmentText)
    .map((item) => item.trim())
    .filter(Boolean);
}

function _hasTrustedScopedCheckFailure(assessmentContext) {
  const result = assessmentContext?.scoped_check_result;
  if (!result || result.status !== "failed") return false;
  if (result.verification_eligible !== true
    || result.coverage_complete !== true
    || result.verification_commit_relation !== "exact") {
    return false;
  }
  if (result.verification_outcome?.type !== "product_failed"
    || result.verification_outcome?.actionability !== "implementation") {
    return false;
  }
  const failures = Array.isArray(result.failures) ? result.failures : [];
  if (!failures.some((failure) => failure && (
    String(failure.message || "").trim()
    || String(failure.file || "").trim()
    || String(failure.check || "").trim()
  ))) {
    return false;
  }
  const baselineChecks = Object.values(result.baseline_attribution?.checks || {});
  return baselineChecks.some((check) => (
    check?.attributable === true && Number(check?.novel_failure_count) > 0
  ));
}

function stripInternalAssessmentPolicyPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const stripped = { ...payload };
  delete stripped._assess_model_tier;
  delete stripped._assess_model_name;
  delete stripped._assess_reasoning_effort;
  delete stripped._assess_pass_confidence_floor;
  delete stripped._execution_policy;
  return stripped;
}

function _buildAssessmentBoundaryBlock(job) {
  const taskBoundary = buildAssessmentTaskBoundary(job);
  return [
    `ASSESSMENT BOUNDARY:`,
    `Judge this job against the assigned TASK SPECIFICATION and its success criteria.`,
    `Use the original work-item objective to interpret and constrain the assigned task, but do not require this job to complete work assigned to other planned tasks.`,
    `Do not fail, block, or lower confidence because pending sibling or downstream jobs have not completed.`,
    `Only spawn a fix for a defect in the assigned task; missing work owned by other planned tasks is not this job's fix scope.`,
    taskBoundary ? renderAssessmentTaskBoundary(taskBoundary) : null,
  ].filter(Boolean).join("\n");
}

function _buildRemoteAssessmentInstructions({
  job,
  workItem,
  taskSpec = "",
  workflowModeBlock = "",
  verificationCapabilityBlock = "",
  atlasBlock = "",
  priorAssessmentFindings = "",
  historicalFinalReview = "",
  fallbackReads = null,
  researchRefsBlock = null,
} = {}) {
  return [
    Number.isFinite(Number(fallbackReads)) ? `Fallback read budget for this assessment attempt: ${Math.max(0, Number(fallbackReads))}.` : null,
    workflowModeBlock,
    verificationCapabilityBlock,
    researchRefsBlock || null,
    `If the bounded role result marks VERIFICATION_UNAVAILABLE, keep the completion status tied to product work. Treat the unavailable method as NOT_APPLICABLE when attached evidence or one obvious equivalent invocation establishes the criterion; it is not, by itself, a reason to block.`,
    atlasBlock || null,
    historicalFinalReview || null,
    priorAssessmentFindings ? `PRIOR ASSESSMENT FINDINGS (build on these; do not re-request the same evidence unless necessary):\n${priorAssessmentFindings}` : null,
    _buildAssessmentBoundaryBlock(job),
    ``,
    `ORIGINAL WORK ITEM OBJECTIVE:`,
    promptLiteral("TITLE", workItem?.title || ""),
    promptLiteral("DESCRIPTION", workItem?.description || "(none)"),
    ``,
    `TASK SPECIFICATION:`,
    taskSpec || `Title: ${job?.title || ""}`,
  ].filter(Boolean).join("\n");
}

function _buildVerificationCapabilityBlock(payload = {}, projectDir = null) {
  const contract = payload?.verification_contract && typeof payload.verification_contract === "object"
    ? payload.verification_contract
    : null;
  return [
    `VERIFICATION CAPABILITY CONTRACT:`,
    renderTestStrictness({ projectDir }),
    `Your issued tools plus the deterministic evidence attached to this prompt are the complete set of available verification methods for this attempt.`,
    `Use those assigned capabilities. Discard browser, lint, shell, or other verification options that are not callable through the issued tool surface and are not represented by deterministic verification evidence.`,
    `An unavailable optional method is NOT_APPLICABLE: do not lower confidence, fail, block, or ask a human merely because it cannot be run.`,
    `A configured test command is a verification recipe, not product behavior, unless the objective explicitly requires that literal invocation to work. If its launcher is unavailable, one obvious equivalent launcher or targeted invocation may establish the same criterion.`,
    `When a DETERMINISTIC TEST EXECUTION RECEIPT or DETERMINISTIC ASSESSOR TEST EXECUTION is attached, the orchestration layer already ran that frozen command outside model context. Treat the receipt as ground truth and do not rerun the command.`,
    `When a DETERMINISTIC CHANGED-FILE CHECK RECEIPT is attached, the harness already ran scoped lint, syntax, and available project typechecks for every listed changed file. Treat its per-file coverage and unavailable statuses as final for this attempt; do not rerun those checks through run_scoped_checks or shell.`,
    `The SCOPED GIT DIFF hunks are already surfaced evidence: judge and cite them directly. Open a changed file only for context the hunks do not show (callers, surrounding rules, imports), and take a bounded window or lens rather than the whole file. Reads past the allowance still execute but are advisory; render the verdict from what you have rather than returning needs_review over a read you chose not to make.`,
    `Do not request a repository file or human intervention solely to supply an executable alias or change test discovery after equivalent evidence proves the behavior.`,
    `If no equivalent evidence can establish a genuinely required criterion, return blocked once with the missing capability named. Do not retry the same assessment hoping the capability appears.`,
    contract ? `Task verification contract:\n${JSON.stringify(contract, null, 2)}` : null,
  ].filter(Boolean).join("\n");
}

function assessmentBudgetInfrastructureError(message, detail = {}, {
  retryable = true,
  gateImmediately = false,
} = {}) {
  const error = new Error(String(message || "Assessment budget exhausted"));
  error.code = "POSSE_ASSESSMENT_BUDGET_EXHAUSTED";
  error.assessmentRetryable = retryable;
  error.assessmentGateImmediately = gateImmediately;
  error.assessmentBudgetExhausted = true;
  error.assessmentBudgetDetail = detail;
  return error;
}

function assessorToolBudgetExhaustion(agentCallId, jobId = null) {
  const callId = Number(agentCallId);
  if (!Number.isInteger(callId) || callId <= 0) return null;
  try {
    const rows = getDb().prepare(`
      SELECT observation_type, summary, detail_json
      FROM job_observations
      WHERE job_id = ?
        AND observation_type LIKE 'tool.%'
      ORDER BY id DESC
      LIMIT 5000
    `).all(Number(jobId) || null);
    const blockedRequests = [];
    let exhaustion = null;
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
      if (Number(detail?.agent_call_id) !== callId || detail?.assessment_budget_exhausted !== true) continue;
      if (!exhaustion) {
        exhaustion = {
          observation_type: row.observation_type,
          reason: detail.assessment_budget_reason || "tool_budget_exhausted",
          used: Number(detail.assessment_budget_used) || null,
          cap: Number(detail.assessment_budget_cap) || null,
          tool: detail.tool_name || null,
        };
      }
      const request = {
        tool: detail.tool_name || null,
        args: detail.args && typeof detail.args === "object" ? detail.args : null,
        summary: String(row.summary || "").slice(0, 500) || null,
      };
      const key = JSON.stringify(request);
      if (!blockedRequests.some((entry) => JSON.stringify(entry) === key)) {
        blockedRequests.push(request);
      }
    }
    return exhaustion
      ? { ...exhaustion, blocked_requests: blockedRequests.slice(0, 12) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Assess the result of a completed job.
 *
 * @param {object} job - The job that was executed (dev, fix, etc.)
 * @param {string} output - The raw output from the worker
 * @param {object} opts
 * @param {boolean} opts.silent - Suppress console output
 * @param {boolean} opts.autoApprove - Pass through to callProvider
 * @returns {object} verdict: { verdict, confidence, reasons, spawn_jobs, human_questions }
 */
export async function assessResult(job, output, { silent = false, autoApprove = false, modelTier = "standard", reasoningEffort = "medium", cwd = null, projectDir = null, routedProviderName = null, agentDispatcher = null, assessmentContext = null, abortSignal = null, fallbackReads = null, priorAssessmentFindings = "", trackedCall = null, disableAtlas = false, remoteComposer = null, taskBoundaryRetryDepth = 0, ignoredPathRetryDepth = 0, attemptId = null, allowMutatingRunners = false } = {}) {
  const finalReview = await authoritativeFinalReview(job, parseJobPayload(job), cwd);
  if (finalReview) {
    const scopeFailure = buildCommittedScopeViolationVerdict(assessmentContext, cwd);
    if (scopeFailure) return scopeFailure;
    const payload = parseJobPayload(job);
    const disabledTests = _buildDisabledRequiredTestsVerdict({ assessmentContext, taskSpec: payload.root_task_spec || payload.original_task_spec || payload.task_spec || "" });
    if (disabledTests) return disabledTests;
    if (_hasTrustedScopedCheckFailure(assessmentContext)) {
      return { verdict: "fail", confidence: "high", reasons: assessmentContext.scoped_check_result.failures.map((failure) => failure.message || failure.file || failure.check), _disable_internal_retry: true };
    }
    return finalReview;
  }
  const continuation = await reserveFinalReviewContinuation(job, parseJobPayload(job), cwd);
  if (["exhausted", "candidate_changed", "canceled", "identity_unavailable"].includes(continuation.status)) {
    const reason = continuation.status === "exhausted"
      ? `Final-review verification continuation budget exhausted (${continuation.count}/${continuation.ceiling}) for this work item. The repaired candidate still needs a current review.`
      : continuation.status === "candidate_changed"
        ? "The candidate changed after its verification continuation was reserved; review the current candidate in a new bounded attempt."
        : continuation.status === "canceled"
          ? "The job was canceled before its verification continuation could run."
          : "The repaired candidate could not be bound to a workspace identity for verification continuation.";
    return { verdict: "needs_review", confidence: "none", reasons: [reason],
      spawn_jobs: [], human_questions: [], _disable_internal_retry: true,
      _assessment_infrastructure_review: true, _verification_blocked: true };
  }
  const previousFinalReview = latestFinalReview(job.id);
  const historicalFinalReview = previousFinalReview?.review_identity
    ? ["PREVIOUS FINAL REVIEW (historical evidence for an earlier candidate; inspect and verify the current change):",
      ...(["reserved", "reused"].includes(continuation.status)
        ? [`Verification continuation ${continuation.count}/${continuation.ceiling}; verify the current candidate before approving it.`] : []),
      `Outcome: ${previousFinalReview.outcome || "unknown"}`,
      ...(previousFinalReview.findings || []).map((finding) =>
        `- ${[finding.criterion, ...(finding.paths || [])].filter(Boolean).join(" — ")}`),
    ].join("\n")
    : "";

  const assessorProvider = String(
    routedProviderName
    || await agentDispatcher?.selectProvider?.({ role: "assessor", providerName: harnessAssessorProvider() })
    || "",
  ).trim();
  if (!assessorProvider) {
    const error = new Error("Assessment requires an assessor Provider route from the AgentDispatcher");
    error.code = "POSSE_AGENT_PROVIDER_ROUTE_REQUIRED";
    throw error;
  }
  // Gather context: the task spec (from payload or artifact)
  let taskSpec = "";
  let parsedJobPayload = parseJobPayload(job);
  const visibleJobPayload = stripInternalAssessmentPolicyPayload(parsedJobPayload);
  const verificationCapabilityBlock = _buildVerificationCapabilityBlock(visibleJobPayload, projectDir || cwd);
  const workItem = getWorkItem(job.work_item_id);
  // Assessment retries can re-enter through an assess-only path with the
  // developer tier in their payload. Re-apply the task A/B pin at the final
  // assessor call boundary so every observed grader remains identical.
  modelTier = taskAbAssessorTier(workItem) || modelTier;
  const workflowModeBlock = buildWorkflowModeBlock(getWorkItemWorkflowConfig(workItem), "assessor");
  if (Object.keys(visibleJobPayload).length > 0) {
    taskSpec = visibleJobPayload.task_spec || visibleJobPayload.instructions || JSON.stringify(visibleJobPayload, null, 2);
  } else if (job.payload_json) {
    taskSpec = String(job.payload_json);
  }
  const assessmentTaskMode = assessmentContext?.task_mode || effectiveArtifactTaskMode(job, parsedJobPayload);
  const artifactAssessmentRoute = !!disableAtlas || job.job_type === "artificer" || isArtifactMode(assessmentTaskMode);

  // Also check for task_spec artifacts
  const specArtifacts = getArtifacts(job.id, "task_spec");
  if (specArtifacts.length > 0) {
    const latest = specArtifacts[specArtifacts.length - 1];
    taskSpec = latest.content_long || latest.content_json || taskSpec;
  }

  const assessmentScopedDiff = assessmentContext?.scoped_git_diff
    ? `\nSCOPED GIT DIFF (COMPLETE FULL DIFF FOR ASSESSED TASK SCOPE — DO NOT RE-FETCH OR RECONSTRUCT):\n${assessmentContext.scoped_git_diff}\n`
    : "";
  const assessmentDependencyDiffs = renderAssessmentDependencyDiffs(assessmentContext);
  const diffPrefetchStatus = String(assessmentContext?.scoped_git_diff_status || "");
  const diffStatusNotice = diffPrefetchStatus === "over_inline_cap"
    ? [
        `SCOPED GIT DIFF OMITTED: diff exceeds inline cap (${assessmentContext?.scoped_git_diff_bytes ?? "unknown"} bytes).`,
        `Pull per-file diffs via git_history op=diff only for files relevant to the task specification.`,
        assessmentContext?.scoped_git_diff_stat ? `DIFF STAT:\n${assessmentContext.scoped_git_diff_stat}` : null,
      ].filter(Boolean).join("\n")
    : diffPrefetchStatus === "prefetch_failed"
      ? "SCOPED GIT DIFF PREFETCH FAILED. No change body was substituted; use targeted git_history verification if the attached narrative is insufficient."
      : "";
  const assessmentDiffNarrative = assessmentContext?.scoped_diff_narrative || diffStatusNotice
    ? `\nSCOPED DIFF NARRATIVE (compact summary of changed files and hunks):\n${[diffStatusNotice, assessmentContext?.scoped_diff_narrative].filter(Boolean).join("\n")}\n`
    : "";
  const assessmentFileSnapshots = assessmentScopedDiff || diffPrefetchStatus
    ? ""
    : buildAssessmentFileSnapshots({ cwd, assessmentContext, taskSpec });

  // Worker output is status context, never assessment proof. Prefer the
  // structured completion result and preserve it intact even when it exceeds
  // the 2000-character performance target. Never attach the preceding
  // tool-call stream. Legacy raw output remains a separately bounded tail
  // fallback because it has no structured completion boundary.
  const logMatch = output.match(/---\s*(DEV (?:RESULT|LOG)|ARTIFICER (?:RESULT|LOG)) START\s*---\s*([\s\S]*?)---\s*\1 END\s*---/i);
  let workerStatusOutput;
  if (logMatch) {
    workerStatusOutput = logMatch[2].trim();
  } else {
    const maxOutputChars = 20000;
    workerStatusOutput = output.length > maxOutputChars
      ? output.slice(-maxOutputChars) + `\n\n[... earlier output truncated — showing last ${maxOutputChars} chars ...]`
      : output;
  }

  // Build file verification data from ground truth (git, not dev claims)
  let fileVerification = "";
  if (assessmentContext) {
    const {
      task_mode = "code",
      manifest = null,
      contract_violations = null,
      contract_warnings = null,
      output_root = null,
      verified_no_change = false,
      branch_net_diff_detected = false,
      branch_net_diff_base = null,
      branch_net_diff_head = null,
      branch_net_diff_target = null,
      branch_net_diff_files = [],
      allowed_files = [],
      allowed_create_files = [],
      allowed_delete_files = [],
      allowed_create_roots = [],
      files_committed = [],
      files_committed_unknown = false,
      files_committed_error = null,
      merge_resolution_files = [],
      files_reverted = [],
      files_requested = [],
    } = assessmentContext;
    const sections = [];
    // Git never commits a declared path the repository ignores, so it is
    // absent from files_actually_committed by design.
    const ignoredScope = task_mode === "code" && cwd
      ? await listIgnoredRepoPaths(cwd, [...allowed_files, ...allowed_create_files, ...allowed_delete_files])
      : [];

    if (assessmentContext.task_ab_test_evidence) {
      sections.push(String(assessmentContext.task_ab_test_evidence));
    }
    const baselineSiblingRegression = renderBaselineSiblingRegression(parsedJobPayload);
    if (baselineSiblingRegression) sections.push(baselineSiblingRegression.trimEnd());
    const baselineTestDebt = renderBaselineTestDebt(parsedJobPayload);
    if (baselineTestDebt) sections.push(baselineTestDebt.trimEnd());

    // Task mode context
    if (task_mode !== "code") {
      sections.push(`task_mode: ${task_mode} — assess based on ${task_mode}-specific criteria (see your instructions)`);
      if (output_root) {
        sections.push(`output_root: ${output_root}`);
      }
    }

    if (verified_no_change) {
      sections.push("verified_no_change: true — the agent claims the requested end state was already present, so an empty files_actually_committed list is expected. Verify current file snapshots against the success criteria instead of failing solely because there is no commit.");
    }
    if (branch_net_diff_detected) {
      sections.push(`branch_net_diff_detected: true — this attempt made no new commit, but the WI branch already differs from ${branch_net_diff_target || "the merge target"} (${branch_net_diff_base || "unknown base"}..${branch_net_diff_head || "HEAD"}). Assess the branch state below instead of treating the job as a clean no-op.`);
      if (branch_net_diff_files.length > 0) {
        sections.push(`branch_net_diff_files: ${JSON.stringify(branch_net_diff_files)}`);
      }
    }

    // Manifest from artifact-mode jobs
    if (manifest && manifest.count > 0) {
      sections.push(`OUTPUT MANIFEST (${manifest.count} files, ${(manifest.totalSize / 1024).toFixed(1)} KB total):`);
      for (const f of manifest.files.slice(0, 20)) {
        sections.push(`  ${f.path} (${(f.size / 1024).toFixed(1)} KB, ${f.ext})`);
      }
      if (manifest.files.length > 20) {
        sections.push(`  ... and ${manifest.files.length - 20} more files`);
      }
    }

    // Contract violations (deterministic — ground truth)
    if (contract_violations && contract_violations.length > 0) {
      sections.push(`ARTIFACT CONTRACT VIOLATIONS (ground truth — deterministic failures):`);
      for (const v of contract_violations) {
        sections.push(`  - ${v}`);
      }
      sections.push(`These are deterministic failures — verdict MUST be "fail".`);
    }

    if (contract_warnings && contract_warnings.length > 0) {
      sections.push(`ARTIFACT CONTRACT WARNINGS (ground truth — informational only):`);
      for (const v of contract_warnings) {
        sections.push(`  - ${v}`);
      }
      sections.push(`These are NOT deterministic failures by themselves — do not fail solely for warnings.`);
    }

    // Show the full scope contract
    if (allowed_files.length > 0) {
      sections.push(`files_to_modify (edit existing): ${JSON.stringify(allowed_files)}`);
    }
    if (allowed_create_files.length > 0) {
      sections.push(`files_to_create (new files): ${JSON.stringify(allowed_create_files)}`);
    }
    if (allowed_delete_files.length > 0) {
      sections.push(`files_to_delete (system-deleted before execution): ${JSON.stringify(allowed_delete_files)}`);
    }
    if (allowed_create_roots.length > 0) {
      sections.push(`create_roots (free-write dirs): ${JSON.stringify(allowed_create_roots)}`);
    }
    if (ignoredScope.length > 0) {
      sections.push(`files_ignored_by_repository (declared scope paths the repository's ignore rules exclude; git never commits them, so they are absent from files_actually_committed by design; their workspace copies are local, uncommitted state, and generated files among them are rebuilt by the project's build or typecheck): ${JSON.stringify(ignoredScope.map((entry) => `${entry.path} (${entry.source})`))}`);
    }

    if (files_committed.length > 0) {
      sections.push(`files_actually_committed: ${JSON.stringify(files_committed)}`);
      if (merge_resolution_files.length > 0) {
        sections.push(`target_merge_resolution_files (changed on both sides of the harness's target-branch merge; resolving them was required, so they are in scope): ${JSON.stringify(merge_resolution_files)}`);
      }
      // Check for scope violations deterministically
      const outOfScope = findOutOfScopeCommittedFiles(files_committed, {
        allowedFiles: mergeUniquePaths(allowed_files, merge_resolution_files),
        allowedCreateFiles: allowed_create_files,
        allowedDeleteFiles: allowed_delete_files,
        allowedCreateRoots: allowed_create_roots,
        cwd,
      });
      if (outOfScope.length > 0) {
        sections.push(`DETERMINISTIC FAILURE — OUT-OF-SCOPE FILES COMMITTED: ${JSON.stringify(outOfScope)}`);
      }
    }
    if (files_committed_unknown === true) {
      const detail = files_committed_error ? ` (${String(files_committed_error).slice(0, 240)})` : "";
      sections.push(`DETERMINISTIC FAILURE — COMMITTED FILE SET UNKNOWN: git could not verify the actual committed files${detail}`);
    }
    if (files_reverted.length > 0) {
      sections.push(`⚠ files_reverted_by_system (attempted scope violations): ${JSON.stringify(files_reverted)}`);
    }
    if (files_requested.length > 0) {
      const reqList = files_requested.map(r => `${r.path} (${r.risk}) — ${r.reason || "no reason"}`);
      sections.push(`files_requested_via_pipeline: ${JSON.stringify(reqList)}`);
    }

    if (sections.length > 0) {
      const isArtifact = task_mode !== "code";
      const rules = isArtifact ? [
        `- This is an ARTIFACT task (${task_mode} mode) — success is based on OUTPUT MANIFEST, NOT git commits`,
        `- files_actually_committed will be EMPTY for artifact jobs — this is EXPECTED, not a failure`,
        `- Manifest paths are relative to output_root; verify deliverables under ${output_root || "the provided output_root"}`,
        `- Check the OUTPUT MANIFEST above: files must exist with correct formats and sizes`,
        `- If contract violations are listed above, verdict MUST be "fail"`,
        `- Contract warnings alone are not failures; extra outputs from retries/restarts should not force a fail`,
        `- If manifest shows valid output files, verdict should be "pass"`,
      ] : [
        `- Edited files must be in files_to_modify or under create_roots → otherwise FAIL`,
        `- Created files must be in files_to_create or under create_roots → otherwise FAIL`,
        `- Deleted files must be in files_to_delete → otherwise FAIL`,
        branch_net_diff_detected ? `- branch_net_diff_detected=true means a zero-commit attempt is being assessed against preexisting WI branch changes; verify that branch diff directly and fail destructive or out-of-scope branch state.` : null,
        verified_no_change ? `- verified_no_change=true means no commit is expected; judge whether the current scoped file snapshots already satisfy the task.` : null,
        `- If out-of-scope files were committed, verdict MUST be "fail"; file requests are follow-up scope and do not authorize the current commit.`,
        ignoredScope.length > 0 ? `- Paths in files_ignored_by_repository cannot be committed: do not fail because they are missing from files_actually_committed, do not require editing, regenerating or committing them, and do not treat their workspace copies as evidence of committed content; judge generated outputs by the scoped checks or build that regenerate them.` : null,
        `- If files_reverted is non-empty → the dev attempted out-of-scope edits that were ALREADY REVERTED by the system. Do NOT fail for this — it is informational only. Judge the task solely on whether the in-scope committed files satisfy the success criteria.`,
      ].filter(Boolean);
      if (files_requested.length > 0) {
        rules.push(`- files_requested_via_pipeline are LEGITIMATE — the system handles these via follow-up jobs. Do NOT treat as failures or incomplete work.`);
      }
      fileVerification = `\nFILE VERIFICATION DATA (from git — ground truth, not dev claims):\n${sections.join("\n")}\n\nScope rules:\n${rules.join("\n")}\n`;
    }
  }

  const deterministicScopeViolation = buildCommittedScopeViolationVerdict(assessmentContext, cwd);
  if (deterministicScopeViolation) {
    return deterministicScopeViolation;
  }
  const disabledRequiredTestsViolation = _buildDisabledRequiredTestsVerdict({ assessmentContext, taskSpec });
  if (disabledRequiredTestsViolation) {
    return disabledRequiredTestsViolation;
  }

  const providerScope = buildAssessmentProviderScope({ cwd, assessmentContext });

  // Resolve the assessor handoff packet before prompt composition. The packet
  // carries remote-prompt identity, stable scope/tool metadata, and ATLAS status.
  // It must not contain raw diff/snapshot evidence; that stays local and is
  // appended after remote compilation below.
  let atlasBlock = "";
  let assessorAtlasPrefetchStatus = null;
  let assessorPacket = null;
  let effectiveFallbackReads = effectiveAssessmentFallbackReads(fallbackReads);
  try {
    const packetPayload = {
      ...parsedJobPayload,
      task_spec: taskSpec || parsedJobPayload.task_spec || parsedJobPayload.instructions || job.title,
      files_to_modify: providerScope.scopedFiles.length > 0 ? providerScope.scopedFiles : (parsedJobPayload.files_to_modify || []),
      files_to_create: providerScope.createFiles.length > 0 ? providerScope.createFiles : (parsedJobPayload.files_to_create || []),
      files_to_delete: providerScope.deleteFiles.length > 0 ? providerScope.deleteFiles : (parsedJobPayload.files_to_delete || []),
      create_roots: providerScope.createRoots.length > 0 ? providerScope.createRoots : (parsedJobPayload.create_roots || []),
    };
    assessorPacket = buildHandoffPacket(job, {
      workItem,
      payload: packetPayload,
      role: "assessor",
      effectiveTier: modelTier,
      attemptCount: getAttempts(job.id).length + 1,
      maxAttempts: job.max_attempts || 3,
      lastError: null,
      cwd,
      reasoningEffort,
      disableAtlas: artifactAssessmentRoute || !!job._atlasDisabledForWorkItem,
      disableAtlasReason: artifactAssessmentRoute
        ? "artifact route"
        : (job._atlasDisabledForWorkItem ? "ATLAS evidence warm did not succeed" : null),
      context_hints: Number.isFinite(Number(fallbackReads))
        ? { allow_fallback_reads: Math.max(0, Number(fallbackReads)) }
        : {},
    });
    await handoff(assessorPacket, { providerName: assessorProvider });
    effectiveFallbackReads = effectiveAssessmentFallbackReads(
      effectiveFallbackReads,
      assessorPacket?.budgets?.fallback_reads_remaining,
    );
    if (!artifactAssessmentRoute) {
      atlasBlock = renderAtlasHandoffSections(assessorPacket) || "";
      assessorAtlasPrefetchStatus = assessorPacket?.atlas?.prefetchStatus || null;
    }
  } catch {
    atlasBlock = "";
    assessorAtlasPrefetchStatus = null;
  }

  const localAssessmentEvidencePacket = buildLocalAssessmentEvidence({
    fileVerification,
    scopedCheckEvidence: assessmentContext?.scoped_check_evidence || "",
    assessmentDiffNarrative,
    assessmentScopedDiff,
    assessmentDependencyDiffs,
    mergeResolutionEvidence: assessmentContext?.merge_resolution_evidence || "",
    assessmentFileSnapshots,
    workerStatusOutput,
  });
  const localAssessmentEvidence = localAssessmentEvidencePacket.text;
  const prompt = [
    `Assess this completed task. Check the actual files, not just the dev's claims.`,
    `Use the deterministic scope and test receipts plus the attached primary change view and any labeled read-only upstream contract diffs. If that bounded evidence cannot resolve a material criterion, use an issued read tool rather than requesting repository contents from the human.`,
    `If the bounded role result marks VERIFICATION_UNAVAILABLE, keep the completion status tied to product work. Treat the unavailable method as NOT_APPLICABLE when attached evidence or one obvious equivalent invocation establishes the criterion; it is not, by itself, a reason to block.`,
    Number.isFinite(Number(effectiveFallbackReads)) ? `Effective fallback read budget for this assessment attempt: ${Math.max(0, Number(effectiveFallbackReads))}.` : null,
    workflowModeBlock,
    verificationCapabilityBlock,
    atlasBlock || null,
    historicalFinalReview || null,
    priorAssessmentFindings ? `PRIOR ASSESSMENT FINDINGS (build on these; do not re-request the same evidence unless necessary):\n${priorAssessmentFindings}` : null,
    _buildAssessmentBoundaryBlock(job),
    ``,
    `ORIGINAL WORK ITEM OBJECTIVE:`,
    promptLiteral("TITLE", workItem?.title || ""),
    promptLiteral("DESCRIPTION", workItem?.description || "(none)"),
    ``,
    `TASK SPECIFICATION:`,
    taskSpec || `Title: ${job.title}`,
    localAssessmentEvidence,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `YOUR RESPONSE MUST BE ONLY A FENCED \`\`\`json VERDICT BLOCK.`,
    `NO PROSE. NO EXPLANATION. JUST THE JSON VERDICT.`,
    `═══════════════════════════════════════════════════════════`,
  ].filter(Boolean).join("\n");

  if (typeof trackedCall !== "function") {
    throw new Error("assessResult requires trackedCall");
  }

  const remoteAssessmentInstructions = _buildRemoteAssessmentInstructions({
    job,
    workItem,
    taskSpec,
    workflowModeBlock,
    verificationCapabilityBlock,
    atlasBlock,
    priorAssessmentFindings,
    historicalFinalReview,
    fallbackReads: effectiveFallbackReads,
    researchRefsBlock: workItemResearchRefsBlock({ workItemId: job?.work_item_id, jobId: job?.id, packet: assessorPacket, projectDir }),
  });
  // Remote composition binds the packet's issued tool surface, system prompt,
  // and stable context to one provider. A provider fallback recomposes the
  // packet for the fallback provider and takes its options from that exact
  // composition, so the fallback Job issuance matches its Agent identity.
  let composedAssessorProvider = null;
  const composeAssessorPromptForProvider = async (providerName) => {
    const composedPrompt = await composePromptRemoteAware(
      assessorPacket,
      remoteAssessmentInstructions,
      {
        ...(remoteComposer ? { composer: remoteComposer } : {}),
        providerName,
        projectDir,
      },
    );
    composedAssessorProvider = String(providerName || "").trim().toLowerCase();
    return assessorPacket.remote_prompt_composed
      ? [composedPrompt, localAssessmentEvidence].filter(Boolean).join("\n\n")
      : composedPrompt;
  };
  const assessorPacketProviderOptions = () => ({
    stableContext: assessorPacket?.stable_context || null,
    remoteSystemPrompt: assessorPacket?.remote_system_prompt || null,
    sessionPacket: assessorPacket || null,
    skipRolePrompt: !!assessorPacket?.remote_prompt_composed,
  });
  const assessorFallbackOptions = assessorPacket
    ? {
        buildFallbackPrompt: ({ providerName }) => composeAssessorPromptForProvider(providerName),
        buildFallbackOptions: ({ providerName }) => {
          if (String(providerName || "").trim().toLowerCase() !== composedAssessorProvider) {
            throw new Error(`Assessor fallback options requested before composing the ${providerName || "unknown"} provider prompt`);
          }
          return assessorPacketProviderOptions();
        },
      }
    : {};
  let providerPrompt = prompt;
  if (assessorPacket) {
    providerPrompt = await composeAssessorPromptForProvider(assessorProvider);
  }

  let response;
  let trustedAssessorEvidenceChars = null;
  let trustedAssessorClaims = [];
  let assessorToolUses = [];
  let imagePixelEvidenceObserved = false;
  let toolBudgetExhaustion = null;
  let priorMatchingToolBudgetExhaustion = false;
  // Two tool calls per file the assessor may need to inspect (metadata and
  // text for an image, read and lens for source) plus list/validate/handoff
  // slack; the configured value is a floor, not a ceiling on breadth.
  const assessorMaxToolCalls = Math.max(
    getAssessorMaxToolCalls(),
    2 * (Number.isFinite(Number(effectiveFallbackReads)) ? Number(effectiveFallbackReads) : 0) + 4,
  );
  const assessorDeepthink = !!parseJobPayload(job).deepthink;
  const assessmentInputKey = crypto.createHash("sha256").update(JSON.stringify({
    version: 1,
    jobId: job.id,
    provider: assessorProvider,
    modelTier,
    reasoningEffort,
    fallbackReads: Number.isFinite(Number(effectiveFallbackReads)) ? Number(effectiveFallbackReads) : null,
    assessorMaxToolCalls,
    deepthink: assessorDeepthink,
    taskBoundaryRetryDepth,
    providerPrompt,
  })).digest("hex");
  const reusableReview = getArtifacts(job.id, "review").findLast((artifact) => {
    if (!artifact?.content_long || !artifact?.content_json) return false;
    try {
      const metadata = typeof artifact.content_json === "string"
        ? JSON.parse(artifact.content_json)
        : artifact.content_json;
      return metadata?.assessment_input_key === assessmentInputKey
        && metadata?.verdict_parse_succeeded === true;
    } catch {
      return false;
    }
  });
  if (reusableReview) {
    response = reusableReview.content_long;
    try {
      const metadata = typeof reusableReview.content_json === "string"
        ? JSON.parse(reusableReview.content_json)
        : reusableReview.content_json;
      if (Number.isInteger(metadata?.assessor_handoff_evidence_chars)) {
        trustedAssessorEvidenceChars = Math.max(0, metadata.assessor_handoff_evidence_chars);
      }
      trustedAssessorClaims = Array.isArray(metadata?.assessor_handoff_claims)
        ? metadata.assessor_handoff_claims
        : [];
      imagePixelEvidenceObserved = metadata?.image_pixel_evidence_observed === true;
    } catch {
      trustedAssessorEvidenceChars = null;
      trustedAssessorClaims = [];
      imagePixelEvidenceObserved = false;
    }
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_REUSED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Reused unchanged assessment input ${assessmentInputKey.slice(0, 12)}`,
      event_json: JSON.stringify({ assessment_input_key: assessmentInputKey }),
    });
  } else try {
    const tokenBudget = assessorTokenBudgetStatus(job.id);
    const callBudget = assessorCallBudgetStatus(job.id, attemptId);
    if (callBudget.exceeded) {
      const reason = `Assessment call budget exhausted (${callBudget.used}/${callBudget.cap} calls) for this attempt.`;
      throw assessmentBudgetInfrastructureError(
        reason,
        callBudget,
        {
          retryable: true,
          gateImmediately: false,
        },
      );
    }
    if (tokenBudget.exceeded) {
      // Token spend is a diagnostic target, not a reason to discard an
      // otherwise productive assessment and pay for it again. The bounded
      // parse-retry count and per-attempt call ceiling still prevent loops.
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attemptId,
        event_type: EVENT_TYPES.JOB_ASSESSMENT_PARSE_RETRY_BUDGET_EXCEEDED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Assessment passed the ${tokenBudget.cap}-token diagnostic target at ${tokenBudget.spent}; continuing the same recovery flow`,
        event_json: JSON.stringify({
          soft_limit: true,
          spent: tokenBudget.spent,
          target: tokenBudget.cap,
        }),
      });
    }
    // Inherit deepthink from the job being assessed: if the task author
    // marked it deepthink, the assessment deserves the same budget so it
    // doesn't rubber-stamp work that took extra time to produce.
    const result = await trackedCall(providerPrompt, {
      role: "assessor",
      modelTier,
      reasoningEffort,
      activity: `assessing: ${job.title}`,
      silent,
      autoApprove,
      allowShell: allowMutatingRunners,
      allowTests: allowMutatingRunners,
      cwd,
      scopedFiles: providerScope.scopedFiles,
      createFiles: providerScope.createFiles,
      createRoots: providerScope.createRoots,
      fallbackReads: effectiveFallbackReads,
      assessorMaxToolCalls,
      abortSignal,
      atlasPrefetchStatus: assessorPacket?.atlas?.prefetchStatus || assessorAtlasPrefetchStatus,
      disableAtlas: artifactAssessmentRoute,
      ...assessorPacketProviderOptions(),
      taskMode: parsedJobPayload.task_mode || "code",
      // view_image reaches only image assessments, including artifact jobs
      // whose effective mode is image; the visual-evidence policy below keys
      // on the same effective mode.
      imageInspection: effectiveArtifactTaskMode(job, parsedJobPayload) === "image",
      projectDbCapability: parsedJobPayload.task_mode === "db" ? "read" : "none",
      ...assessorFallbackOptions,
      deepthink: assessorDeepthink,
      _attachedSourceEvidence: [
            localAssessmentEvidencePacket.primaryChangeEvidenceAttached
              && assessmentScopedDiff
              && Array.isArray(assessmentContext?.scoped_git_diff_source_ranges)
              ? {
                  kind: "assessment_primary_diff",
                  text: assessmentScopedDiff.trim(),
                  ranges: assessmentContext.scoped_git_diff_source_ranges,
                }
              : null,
            localAssessmentEvidencePacket.dependencyChangeEvidenceAttached
              && assessmentDependencyDiffs
              && Array.isArray(assessmentContext?.dependency_git_diff_source_ranges)
              ? {
                  kind: "assessment_dependency_diff",
                  text: assessmentDependencyDiffs,
                  ranges: assessmentContext.dependency_git_diff_source_ranges,
                }
              : null,
          ].filter(Boolean),
    }, {
      job_id: job.id,
      work_item_id: job.work_item_id,
      attempt_id: attemptId,
      cwd,
      jobProvider: assessorProvider,
      jobModelName: null,
      // job_id is the assessed job; an assessor fallback must not move that
      // job's provider/model pin to the assessor's provider.
      persistJobProvider: false,
    });
    response = result.output;
    assessorToolUses = Array.isArray(result?.stats?.toolUses) ? result.stats.toolUses : [];
    imagePixelEvidenceObserved = assessorPixelEvidenceObserved({
      toolUses: assessorToolUses,
      attemptId,
      agentCallId: result?.agentCallId,
    });
    if (Number.isInteger(result.agentCallId)) {
      toolBudgetExhaustion = assessorToolBudgetExhaustion(result.agentCallId, job.id);
      if (toolBudgetExhaustion) {
        const priorArtifact = getRecentArtifacts(job.id, 1, "review")[0];
        try {
          const metadata = typeof priorArtifact?.content_json === "string"
            ? JSON.parse(priorArtifact.content_json)
            : priorArtifact?.content_json;
          const prior = metadata?.tool_budget_exhaustion;
          priorMatchingToolBudgetExhaustion = prior?.reason === toolBudgetExhaustion.reason
            && Number(prior?.cap) === Number(toolBudgetExhaustion.cap);
        } catch {
          priorMatchingToolBudgetExhaustion = false;
        }
      }
      const handoffRecord = getAgentHandoffRecord(result.agentCallId);
      const packet = handoffRecord?.packet;
      trustedAssessorEvidenceChars = packet?.profile === AGENT_HANDOFF_PROFILES.ASSESSOR_VERDICT
        ? Math.max(0, Number(packet.evidence_chars) || 0)
        : 0;
      trustedAssessorClaims = packet?.profile === AGENT_HANDOFF_PROFILES.ASSESSOR_VERDICT
        && Array.isArray(packet?.handoffs?.[0]?.report?.claims)
        ? packet.handoffs[0].report.claims
        : [];
    }
  } catch (err) {
    throw err;
  }

  // Parse the verdict (provider-agnostic — extractJsonResult handles sanitisation)
  const verdictJson = extractJsonResult(response);
  let verdict = verdictJson.value;
  const verdictJsonType = Array.isArray(verdict)
    ? "array"
    : verdict === null
      ? "null"
      : typeof verdict;
  // Unwrap single-element array — LLMs sometimes wrap the verdict object in brackets
  if (Array.isArray(verdict) && verdict.length === 1 && _looksLikeAssessorVerdictObject(verdict[0])) verdict = verdict[0];
  verdict = _normalizeAssessorVerdictShape(verdict, response);
  verdict = applyImageVisualEvidencePolicy({
    payload: { ...parsedJobPayload, task_mode: effectiveArtifactTaskMode(job, parsedJobPayload) },
    verdict,
    toolUses: assessorToolUses,
    pixelEvidenceObserved: imagePixelEvidenceObserved,
  });

  if (!reusableReview) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      artifact_type: "review",
      content_long: response,
      content_json: {
        assessment_input_key: assessmentInputKey,
        verdict_parse_succeeded: !toolBudgetExhaustion && _isReusableAssessorVerdict(verdictJson, verdict),
        ...(imagePixelEvidenceObserved ? { image_pixel_evidence_observed: true } : {}),
        ...(verdict?._assessment_visual_review ? { visual_evidence_review_required: true } : {}),
        ...(toolBudgetExhaustion ? { tool_budget_exhaustion: toolBudgetExhaustion } : {}),
        ...(trustedAssessorEvidenceChars == null
          ? {}
          : { assessor_handoff_evidence_chars: trustedAssessorEvidenceChars }),
        ...(trustedAssessorClaims.length === 0
          ? {}
          : { assessor_handoff_claims: trustedAssessorClaims }),
      },
    });
  }

  // Only treat assessor "access limitation" phrasing as a retryable environment
  // error when we could NOT extract a usable verdict. These phrases ("provide
  // the content of", "diffs or content", "cannot verify the claimed") legitimately
  // appear inside a real fail verdict's `reasons`; running the sniff on the whole
  // raw response *before* JSON extraction discarded valid verdicts and retried
  // with no parse-success guard and no retry cap. (B6)
  if (!_looksLikeAssessorVerdictObject(verdict) && _looksLikeAssessorAccessLimitation(response)) {
    const err = new Error("Assessor reported blocked file-system access despite deterministic verification context");
    err.assessmentRetryable = true;
    throw err;
  }
  if (toolBudgetExhaustion && !["pass", "fail", "needs_replan"].includes(String(verdict?.verdict || "").toLowerCase())) {
    const budgetLabel = toolBudgetExhaustion.cap == null
      ? toolBudgetExhaustion.reason
      : `${toolBudgetExhaustion.reason} (${toolBudgetExhaustion.used}/${toolBudgetExhaustion.cap})`;
    if (priorMatchingToolBudgetExhaustion) {
      const blocked = (toolBudgetExhaustion.blocked_requests || [])
        .map((request) => request.summary || request.tool)
        .filter(Boolean)
        .slice(0, 4);
      return {
        ...verdict,
        verdict: "needs_review",
        confidence: "none",
        reasons: [
          `Assessment evidence access exhausted the same effective harness budget twice: ${budgetLabel}. Automatic retries stopped and the assessment will fail closed because the retry retained the same evidence authority and hit the same ceiling again.`,
          ...(blocked.length > 0 ? [`Still-blocked targeted reads: ${blocked.join("; ")}`] : []),
          ...(Array.isArray(verdict?.reasons) ? verdict.reasons : []),
        ],
        // A harness-owned read ceiling is not a product or policy decision.
        // Leaving this as an apparent operator-only question routed the second
        // budget miss into a human gate even though a person cannot restore
        // evidence authority from the prompt. The needs_review handler fails
        // closed when no genuine operator question remains.
        human_questions: [],
        spawn_jobs: [],
        _disable_internal_retry: true,
        _assessment_infrastructure_review: true,
      };
    }
    throw assessmentBudgetInfrastructureError(
      `Assessment tool access was exhausted by the harness: ${budgetLabel}`,
      toolBudgetExhaustion,
    );
  }
  // No prose-recovery fallback: if JSON extraction failed we fall through to
  // the parse_error verdict below, which lets the worker re-run assessment at
  // a higher tier (cheap → standard → strong, see runAssessment loop). Prior
  // prose-regex recovery synthesized fake verdicts that masked parser failures
  // and prevented the tier-bump retry from firing.

  // Keep this trust bit outside the provider-supplied verdict object. A model
  // must not be able to label its own response as harness infrastructure and
  // force the dispatcher down an internal-only path.
  let harnessInfrastructureReview = false;
  if (verdict) {
    const originalHumanQuestions = Array.isArray(verdict.human_questions) ? verdict.human_questions : [];
    const sanitizedHumanQuestions = sanitizeHumanQuestions(originalHumanQuestions, {
      context: [response, ...(Array.isArray(verdict.reasons) ? verdict.reasons : [])].join("\n"),
    });
    if (sanitizedHumanQuestions.length !== originalHumanQuestions.length) {
      verdict = {
        ...verdict,
        human_questions: sanitizedHumanQuestions,
      };
      if (
        originalHumanQuestions.length > 0
        && sanitizedHumanQuestions.length === 0
      ) {
        harnessInfrastructureReview = true;
        const rawReasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
        verdict = {
          ...verdict,
          verdict: ["blocked", "needs_review"].includes(String(verdict.verdict || "").toLowerCase())
            ? "needs_review"
            : verdict.verdict,
          reasons: [
            "Assessor asked the human for repository evidence or implementation intent that must be resolved from local assessment context; sanitized the request and will fail closed without an operator gate.",
            ...rawReasons,
          ],
          human_questions: [],
          _disable_internal_retry: true,
        };
      }
    }
  }

  if (verdictJson.repaired) {
    return {
      verdict: "parse_error",
      confidence: "none",
      reasons: ["Assessor response JSON appeared truncated and required repair; refusing to trust a synthesized verdict"],
      spawn_jobs: [],
      human_questions: [],
      raw: response,
    };
  }

  if (!verdict || !verdict.verdict) {
    // Couldn't parse assessor output. Returning "fail" here would trigger
    // fix job spawning + dependency rewiring — creating an amplification loop
    // (bad parse → fail → fix → assess → bad parse → fail → ...).
    // Instead, return "parse_error" so the worker can retry assessment at a
    // higher tier or let the job succeed with a warning.
    const parseReason = verdictJson.found
      ? (
          verdict && typeof verdict === "object" && !Array.isArray(verdict)
            ? "Assessor returned structured JSON without a verdict field"
            : `Assessor returned JSON ${verdictJsonType} instead of a verdict object`
        )
      : "Assessor response could not be parsed as structured JSON";
    return {
      verdict: "parse_error",
      confidence: "none",
      reasons: [parseReason],
      spawn_jobs: [],
      human_questions: [],
      raw: response,
    };
  }

  // Validate the verdict value itself
  const parsedVerdict = ASSESSOR_VALID_VERDICTS.has(verdict.verdict) ? verdict.verdict : "parse_error";
  if (parsedVerdict === "parse_error") {
    return {
      verdict: "parse_error",
      confidence: "none",
      reasons: [`Assessor returned unknown verdict: "${verdict.verdict}"`],
      spawn_jobs: [],
      human_questions: [],
      raw: response,
    };
  }

  // Coerce text arrays — LLMs may return numbers, objects, or null.
  const reasons = _normalizeAssessmentTextList(verdict.reasons);

  const normalizedVerdict = {
    verdict: parsedVerdict,
    confidence: normalizeAssessorConfidence(verdict.confidence, { fallback: "medium", allowNone: true }) || "none",
    reasons,
    spawn_jobs: Array.isArray(verdict.spawn_jobs) ? verdict.spawn_jobs : [],
    human_questions: _normalizeAssessmentTextList(verdict.human_questions),
    suggestions: _normalizeAssessmentTextList(verdict.suggestions),
    raw: response,
    ...(trustedAssessorClaims.length === 0 ? {} : { _assessor_claims: trustedAssessorClaims }),
    ...(verdict._disable_internal_retry ? { _disable_internal_retry: true } : {}),
    ...(verdict._assessment_visual_review ? { _assessment_visual_review: true } : {}),
    ...(harnessInfrastructureReview ? { _assessment_infrastructure_review: true } : {}),
  };
  const taskBoundary = buildAssessmentTaskBoundary(job);
  const boundaryViolation = classifySiblingOnlyAssessmentFailure(normalizedVerdict, taskBoundary);
  if (boundaryViolation && Number(taskBoundaryRetryDepth) < 1) {
    recordAssessmentBoundaryEvent(job, boundaryViolation);
    const correction = [
      `TASK-BOUNDARY CORRECTION: The prior fail cited only exact paths assigned to pending sibling task(s): ${boundaryViolation.cited_paths.join(", ")}.`,
      `Reassess only the current task. Do not require or propose changes to those sibling-owned paths.`,
    ].join("\n");
    return await assessResult(job, output, {
      silent,
      autoApprove,
      modelTier,
      reasoningEffort,
      cwd,
      projectDir,
      routedProviderName: assessorProvider,
      agentDispatcher,
      assessmentContext,
      abortSignal,
      fallbackReads,
      priorAssessmentFindings: [priorAssessmentFindings, correction].filter(Boolean).join("\n\n"),
      trackedCall,
      disableAtlas,
      remoteComposer,
      taskBoundaryRetryDepth: 1,
      ignoredPathRetryDepth,
      attemptId,
      allowMutatingRunners,
    });
  }
  if (boundaryViolation) {
    recordAssessmentBoundaryEvent(job, boundaryViolation, { repeated: true });
    return {
      verdict: "needs_review",
      confidence: "none",
      reasons: [
        `Assessor contract failure: two assessments failed this task only for pending sibling-owned path(s): ${boundaryViolation.cited_paths.join(", ")}. No fix was dispatched.`,
      ],
      spawn_jobs: [],
      human_questions: [],
      suggestions: [],
      raw: normalizedVerdict.raw,
      _disable_internal_retry: true,
      // Another assessment cannot fix the boundary, but whether this task's
      // own work passes is a question the operator can answer: it opens the
      // assessment review gate instead of failing the work item closed.
      _assessment_sibling_boundary_review: true,
    };
  }
  const ignoredPathViolation = assessmentTaskMode === "code" && job.job_type !== "artificer"
    ? await classifyIgnoredPathOnlyAssessmentFailure(normalizedVerdict, { cwd, payload: parsedJobPayload, assessmentContext })
    : null;
  if (ignoredPathViolation && Number(ignoredPathRetryDepth) < 1) {
    recordAssessmentIgnoredPathEvent(job, ignoredPathViolation);
    return await assessResult(job, output, {
      silent,
      autoApprove,
      modelTier,
      reasoningEffort,
      cwd,
      projectDir,
      routedProviderName: assessorProvider,
      agentDispatcher,
      assessmentContext,
      abortSignal,
      fallbackReads,
      priorAssessmentFindings: [priorAssessmentFindings, renderIgnoredPathCorrection(ignoredPathViolation)].filter(Boolean).join("\n\n"),
      trackedCall,
      disableAtlas,
      remoteComposer,
      taskBoundaryRetryDepth,
      ignoredPathRetryDepth: 1,
      attemptId,
      allowMutatingRunners,
    });
  }
  if (ignoredPathViolation) {
    recordAssessmentIgnoredPathEvent(job, ignoredPathViolation, { repeated: true });
    return ignoredPathReviewVerdict(ignoredPathViolation, normalizedVerdict.raw);
  }
  const trustedScopedCheckFailure = _hasTrustedScopedCheckFailure(assessmentContext);
  if (normalizedVerdict.verdict === "fail"
    && trustedAssessorEvidenceChars === 0
    && !trustedScopedCheckFailure) {
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId ?? null,
      observation_type: "assessment.unsupported_fix_blocked",
      summary: "Blocked automatic fix from an evidence-free assessor failure",
      detail: {
        verdict: "fail",
        assessor_handoff_evidence_chars: 0,
      },
    });
    return {
      ...normalizedVerdict,
      verdict: "needs_review",
      confidence: "none",
      reasons: [
        "Assessor reported a failure without an evidence-backed defect claim; automatic repair was suppressed pending review.",
        ...normalizedVerdict.reasons,
      ],
      spawn_jobs: [],
      _disable_internal_retry: true,
      // The unevidenced defect claim is a question the operator can answer
      // (WI 167 job 2209): route it to the assessment review gate. Failing it
      // closed killed the work item with three intact commits and no gate.
      _assessment_unsupported_fail_review: true,
      _assessment_unsupported_claim_review: true,
    };
  }
  if (normalizedVerdict.verdict === "fail"
    && trustedAssessorEvidenceChars === 0
    && trustedScopedCheckFailure) {
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId ?? null,
      observation_type: "assessment.deterministic_fix_evidence_used",
      summary: "Accepted automatic fix from an attributable deterministic scoped-check failure",
      detail: {
        verdict: "fail",
        assessor_handoff_evidence_chars: 0,
        verification_commit_relation: assessmentContext.scoped_check_result.verification_commit_relation,
        baseline_attribution: assessmentContext.scoped_check_result.baseline_attribution,
      },
    });
  }
  return normalizedVerdict;
}

export function shouldRunPreAssessCommand({
  command = "",
  wtPath = "",
  preAssessAlreadyVerified = false,
  hooksSkipped = false,
} = {}) {
  return !!String(command || "").trim()
    && !!wtPath
    && !preAssessAlreadyVerified
    && !hooksSkipped;
}

export function taskAbPinnedTestCommand(payload = {}) {
  if (payload?._task_ab_test_command !== true) return "";
  return typeof payload?.test_command === "string"
    ? payload.test_command.trim()
    : "";
}

function taskAbTestEvidence(command, result = {}) {
  const status = result.ok === true ? "PASS" : "FAIL";
  const output = [result.stdout, result.stderr]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(-4000);
  return [
    `DETERMINISTIC ASSESSOR TEST EXECUTION (${status}):`,
    `command: ${command}`,
    `exit_code: ${result.code ?? "unknown"}`,
    output ? `output:\n${output}` : "output: (empty)",
    result.ok === true
      ? "The assessment layer ran this exact harness command successfully."
      : "The assessment layer ran this exact harness command and it failed. Verdict MUST NOT be pass unless later attached evidence shows a successful rerun.",
  ].join("\n");
}

export function __testTaskAbTestEvidence(command, result = {}) {
  return taskAbTestEvidence(command, result);
}

async function gitPorcelainZAsync(wtPath) {
  return gitExecAsync(["status", "--porcelain=v1", "-z"], wtPath, { trim: false });
}




export function shouldReuseUnchangedArtifactManifest({
  taskMode = "code",
  fullManifest = null,
  output = "",
  outputRoot = null,
  expectedFiles = [],
  shouldFastPassArtifactAssessment = null,
} = {}) {
  if (!isArtifactMode(taskMode)) return false;
  if (!fullManifest || fullManifest.count <= 0) return false;
  if (!artifactOutputClaimsReusableComplete(output)) return false;
  if (typeof shouldFastPassArtifactAssessment !== "function") return false;

  const contractResult = validateManifestAgainstContract(fullManifest, taskMode);
  if (!contractResult.valid) return false;

  return shouldFastPassArtifactAssessment({
    taskMode,
    manifest: fullManifest,
    contractViolations: null,
    outputRoot,
    expectedFiles,
  });
}

export function buildEmptyArtifactOutputMessage({
  taskMode = "artifact",
  outputRoot = "",
  manifest = null,
  fullManifest = null,
  preManifestState = null,
} = {}) {
  const errDetail = Array.isArray(manifest?.errors) && manifest.errors.length > 0
    ? ` (${manifest.errors.join("; ")})`
    : "";
  const hasExistingUnchanged = preManifestState && preManifestState.size > 0 && fullManifest?.count > 0;
  const existingPreview = hasExistingUnchanged
    ? (fullManifest.files || []).slice(0, 5).map((file) => file.path).filter(Boolean).join(", ")
    : "";
  const existingDetail = hasExistingUnchanged
    ? `; ${fullManifest.count} existing file(s) were present but unchanged this attempt${existingPreview ? `: ${existingPreview}` : ""}`
    : "";
  const action = hasExistingUnchanged ? "produced no new or changed files" : "produced no files";
  return `Artifact mode (${taskMode}) ${action} in output_root: ${outputRoot}${existingDetail}${errDetail}`;
}

// The files an artificer must leave in its output root. An assessor-spawned
// artifact repair declares none of its own, but the deliverable it repairs
// (same output root) still owes its original job's files.
export function expectedArtifactDeliverables(payload = {}) {
  let current = payload;
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(current?.files_to_create) && current.files_to_create.length > 0) return current.files_to_create;
    if (current?._artifact_recovery !== true || !current.original_job_id) break;
    const original = getJob(current.original_job_id);
    const originalPayload = original ? parseJobPayload(original) : null;
    if (!originalPayload?.output_root || !payload.output_root
      || path.resolve(String(originalPayload.output_root)) !== path.resolve(String(payload.output_root))) break;
    current = originalPayload;
  }
  return [];
}

function getWorkerProviderCall(worker) {
  const call = worker?.providerClient?.call;
  if (typeof call !== "function") {
    throw new Error("Assessment pipeline requires worker.providerClient.call");
  }
  return call.bind(worker.providerClient);
}

async function callWithProjectDirAssessmentGuard(call, callArgs, {
  projectDir,
  job,
  attemptId = null,
  emit = null,
} = {}) {
  let before = null;
  try {
    before = await gitPorcelainZAsync(projectDir);
  } catch {
    before = null;
  }

  let callResult;
  let callError = null;
  try {
    callResult = await call(...callArgs);
  } catch (err) {
    callError = err;
  }

  let guardError = null;
  if (before != null) {
    let after = before;
    try {
      after = await gitPorcelainZAsync(projectDir);
    } catch {
      after = before;
    }
    if (after !== before) {
      const changedEntries = diffPorcelainEntries(before, after);
      let snapshotDir = null;
      let cleanupError = null;
      if (before === "") {
        try {
          snapshotDir = await snapshotAndResetDirtyWorktreeAsync(projectDir, projectDir, {
            reason: `assessment-project-dir-side-effects-wi-${job.work_item_id}-job-${job.id}`,
            branchName: getWorkItem(job.work_item_id)?.branch_name || null,
            wiId: job.work_item_id,
            onMsg: (message) => emit?.(`${C.dim}[assessor-guard] ${message}${C.reset}`),
          });
        } catch (err) {
          cleanupError = err?.message || String(err);
        }
      } else {
        cleanupError = "projectDir was already dirty; refused to reset operator-owned changes";
      }
      recordObservation({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attemptId,
        observation_type: "assessment.project_dir_side_effect",
        summary: cleanupError
          ? "Assessor changed projectDir and automatic cleanup was unsafe"
          : "Assessor projectDir side effects were snapshotted and reset",
        detail: {
          changed_entries: changedEntries.slice(0, 100),
          snapshot_dir: snapshotDir,
          cleanup_error: cleanupError,
        },
      });
      emit?.(`${C.yellow}[assessor-guard] provider-side projectDir changes detected${snapshotDir ? `; reset after snapshot ${snapshotDir}` : ""}${C.reset}`);
      if (cleanupError) {
        guardError = new Error(`Assessment projectDir mutation cleanup failed: ${cleanupError}`, {
          ...(callError ? { cause: callError } : {}),
        });
      }
    }
  }

  if (guardError) throw guardError;
  if (callError) throw callError;
  return callResult;
}

function killShellCommandProcessTree(child, options = {}) {
  return killShellCommandProcessTreeImpl(child, options);
}

export function __testKillShellCommandProcessTree(child, opts = {}) {
  return killShellCommandProcessTree(child, opts);
}

function runShellCommandAsync(command, options = {}) {
  return runShellCommandAsyncImpl(command, options);
}

export async function runPinnedTaskAbAssessmentCommand(payload = {}, {
  cwd = null,
  timeoutMs = 120000,
} = {}) {
  const command = taskAbPinnedTestCommand(payload);
  if (!command || !cwd) return null;
  try {
    const result = await runShellCommandAsync(command, { cwd, timeoutMs });
    return {
      command,
      cwd,
      status: "passed",
      ok: true,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      evidence: taskAbTestEvidence(command, {
        ok: true,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    };
  } catch (error) {
    return {
      command,
      cwd,
      status: "failed",
      ok: false,
      code: error.code ?? null,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      evidence: taskAbTestEvidence(command, {
        ok: false,
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr || error.message,
      }),
    };
  }
}

export async function runPostExecutionAssessment(worker, {
  attempt,
  committedHash,
  commitBaseHash = null,
  filesCommitted,
  filesCommittedUnknown = false,
  filesCommittedError = null,
  mergeResolutionFiles = [],
  filesReverted,
  hasFileChanges,
  job,
  leaseToken,
  output,
  pendingFileRequests,
  preAssessAlreadyVerified = false,
  preManifestState,
  branchNetDiff = null,
  satisfiedNoop,
  verifiedNoChange = false,
  startTime,
  wtPath,
}, {
  assessmentRetryFallbackReads,
  isProviderError,
  logBadInputFailure,
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
  shortJobTitle,
  syncAssessorWorkerDisplay,
  waitForAtlasWarmCompletion = waitForAtlasWarmJobCompletion,
} = {}) {
  const hasPendingFileRequests = () => {
    if (!pendingFileRequests) return false;
    const autoCount = pendingFileRequests.autoApproved?.length || 0;
    const gatedCount = pendingFileRequests.needsApproval?.length || 0;
    return autoCount + gatedCount > 0;
  };
  let spawnedFileRequestFollowUp = false;
  const spawnPendingFileRequestsOnce = () => {
    if (!hasPendingFileRequests() || spawnedFileRequestFollowUp) return false;
    worker._spawnFileRequestFollowUp(job, pendingFileRequests, attempt.id);
    spawnedFileRequestFollowUp = true;
    return true;
  };

  // A commit warm is emitted before this function runs. Park this job as
  // assess-only until the worker has inspected that exact warm. The worker
  // defers active warms, binds only after success, and applies the configured
  // fail-closed/degraded policy to failed or missing warms. Keeping all three
  // outcomes on that single gate prevents an inline assessor from binding the
  // previous ledger head and avoids waiting inside executions that may not
  // have a background scheduler lane.
  const currentPayload = parseJobPayload(job);
  const evidenceWarmJobId = Number(currentPayload?._atlas_evidence_warm_job_id);
  const evidenceWarmRequired = currentPayload?._atlas_evidence_warm_required === true;
  if (evidenceWarmRequired || (Number.isInteger(evidenceWarmJobId) && evidenceWarmJobId > 0)) {
    const hasEvidenceWarmJob = Number.isInteger(evidenceWarmJobId) && evidenceWarmJobId > 0;
    let evidenceWarm = getAtlasWarmJobCompletion(hasEvidenceWarmJob ? evidenceWarmJobId : null);
    if (hasEvidenceWarmJob && !evidenceWarm.completed) {
      evidenceWarm = await waitForAtlasWarmCompletion(evidenceWarmJobId, {
        timeoutMs: 30_000,
        pollMs: 100,
      });
    }
    if (!evidenceWarm.ok) {
      currentPayload._assess_only = true;
      persistPendingAssessmentFileRequests(currentPayload, pendingFileRequests);
      job.payload_json = JSON.stringify(currentPayload);
      updateJobPayload(job.id, job.payload_json);
      completeAttempt(attempt.id, {
        status: "succeeded",
        duration_ms: Date.now() - startTime,
        output_chars: output.length,
      });
      const warmLabel = hasEvidenceWarmJob ? `#${evidenceWarmJobId}` : "(missing)";
      worker.emit(job.id, `${C.dim}[atlas] WI#${job.work_item_id} job #${job.id}: commit warm ${warmLabel} is ${evidenceWarm.status || evidenceWarm.skipped || "pending"}; deferring evidence binding to assess-only retry${C.reset}`);
      worker._releaseLease(job, leaseToken, "queued");
      refreshAndExtractInsights(job.work_item_id);
      return;
    }
  }

  // When a file-request continuation is guaranteed, assess the combined branch
  // after that continuation instead of paying for an intermediate verdict over
  // work the pipeline already knows is incomplete. Human-gated continuations
  // retain the checkpoint assessment unless this run auto-approves the gate.
  const skipAssessForFileRequest = shouldDeferAssessmentToFileRequestContinuation({
    pendingFileRequests,
    hasFileChanges,
    autoApprove: worker.autoApprove,
  });
  const skipAssessForSatisfiedNoop = satisfiedNoop && !verifiedNoChange && !latestFinalReview(job.id);
  const shouldRunAssessment = ASSESSABLE_JOB_TYPES.has(job.job_type)
    && !worker.dryRun
    && !worker._shouldSkipAssessment(job);
  if (shouldRunAssessment && !skipAssessForFileRequest && !skipAssessForSatisfiedNoop) {
    const barrier = acquireAssessmentBarrier(job.id, leaseToken);
    if (!barrier.ok) {
      if (barrier.reason === "lease_invalid") {
        const errorText = "Lease expired before assessment barrier acquisition — result discarded";
        completeAttempt(attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - startTime,
          error_text: errorText,
        });
        worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} — lease expired before assessment barrier acquisition${C.reset}`);
        refreshAndExtractInsights(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
        return;
      }
      const siblingLocks = barrier.blockers || [];
      setAssessmentLifecycle(job.id, ASSESSMENT_LIFECYCLE.IMPLEMENTATION_COMPLETE);
      markAssessmentRetryAssessOnly(job, pendingFileRequests);
      completeAttempt(attempt.id, {
        status: "succeeded",
        duration_ms: Date.now() - startTime,
        output_chars: output.length,
      });
      const summary = siblingLockSummary(siblingLocks);
      worker.emit(
        job.id,
        `${C.dim}[assessor] WI#${job.work_item_id} job #${job.id}: deferred until ${siblingLocks.length} same-WI writer lock(s) drain${summary ? ` (${summary})` : ""}${C.reset}`,
      );
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.id,
        event_type: EVENT_TYPES.JOB_ASSESSMENT_DEFERRED_FOR_SIBLING_WRITES,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Deferred assessment before budget consumption; ${siblingLocks.length} same-WI writer lock(s) remain`,
        event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
      });
      worker._releaseLease(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + 1_000).toISOString(),
      });
      refreshAndExtractInsights(job.work_item_id);
      return;
    }
    let readiness;
    try {
      readiness = (committedHash || verifiedNoChange)
        ? await inspectAssessmentWorktreeReadiness(wtPath)
        : { ready: true };
    } catch (error) {
      // Implementation already produced its candidate. Charge inspection
      // failures to assessment and retain that candidate for bounded recovery.
      if (recordAssessmentInfrastructureAttempt(job, leaseToken, attempt.id, startTime, error.message)) {
        beginAttachedAssessmentAttempt(job.id, leaseToken);
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, error, { pendingFileRequests });
      }
      refreshAndExtractInsights(job.work_item_id);
      return;
    }
    const readinessOutcome = recordAssessmentWorktreeReadiness(job, leaseToken, readiness, attempt.id);
    if (readinessOutcome.leaseLost) {
      completeAttempt(attempt.id, { status: "interrupted", duration_ms: Date.now() - startTime,
        error_text: "Lease expired during assessment worktree inspection" });
      return;
    }
    if (!readiness.ready) {
      setAssessmentLifecycle(job.id, ASSESSMENT_LIFECYCLE.IMPLEMENTATION_COMPLETE);
      markAssessmentRetryAssessOnly(job, pendingFileRequests);
      completeAttempt(attempt.id, {
        status: "succeeded",
        duration_ms: Date.now() - startTime,
        output_chars: output.length,
      });
      const detail = assessmentWorktreeDirtySummary(readiness);
      worker.emit(
        job.id,
        `${C.dim}[assessor] WI#${job.work_item_id} job #${job.id}: deferred until the committed worktree is clean (${detail})${C.reset}`,
      );
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.id,
        event_type: EVENT_TYPES.JOB_ASSESSMENT_DEFERRED_FOR_DIRTY_WORKTREE,
        actor_type: EVENT_ACTORS.WORKER,
        message: "Deferred assessment before budget consumption because the worktree was not clean after barrier acquisition",
        event_json: JSON.stringify({
          dirty_count: readiness.dirty_count,
          dirty_paths: readiness.dirty_paths.slice(0, 100),
        }),
      });
      if (readinessOutcome.recoveryError) {
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, readinessOutcome.recoveryError, { pendingFileRequests, operatorActionable: true });
      } else {
        worker._releaseLease(job, leaseToken, "queued", {
          readyAt: new Date(Date.now() + 2_000).toISOString(),
        });
      }
      refreshAndExtractInsights(job.work_item_id);
      return;
    }
  }
  if (shouldRunAssessment && !skipAssessForFileRequest) {
    setAssessmentLifecycle(job.id, ASSESSMENT_LIFECYCLE.IMPLEMENTATION_COMPLETE);
    beginAttachedAssessmentAttempt(job.id, leaseToken);
  }
  if (shouldRunAssessment && skipAssessForSatisfiedNoop) {
    updateJobStatus(job.id, "awaiting_assessment", leaseToken != null ? { leaseToken } : {});
    syncAssessorWorkerDisplay(worker.display, job, {
      tier: "cheap",
      effort: job.reasoning_effort || "medium",
      attempt: attempt.attempt_number || job.attempt_count || 1,
    });
    const passMsg = "Deterministic no-op pass: the scoped end state was already satisfied, so no commit was required.";
    worker.emit(job.id, `${C.green}[${DETERMINISTIC_AUDIT_ROLE}]${C.reset} WI#${job.work_item_id} job #${job.id}: deterministic no-op pass`);
    const verdict = {
      verdict: "pass",
      confidence: "high",
      reasons: [passMsg],
      spawn_jobs: [],
      human_questions: [],
      suggestions: [],
    };
    if (!isLeaseValid(job.id, leaseToken)) {
      worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} — lease expired before deterministic no-op verdict${C.reset}`);
      completeAttempt(attempt.id, {
        status: "interrupted",
        duration_ms: Date.now() - startTime,
        error_text: "Lease expired before deterministic no-op verdict — result discarded",
      });
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }
    const emitFn = (msg) => worker.emit(job.id, assessmentDisplayMessage(msg));
    const { action, effectiveVerdict } = processVerdict(job, verdict, { emit: emitFn, projectDir: worker.projectDir, autoApprove: worker.autoApprove, leaseToken });
    log.info(DETERMINISTIC_AUDIT_ROLE, `Verdict: ${effectiveVerdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: effectiveVerdict.verdict, confidence: effectiveVerdict.confidence, reasons: effectiveVerdict.reasons });
    jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"}) — ${passMsg.slice(0, 100)}` });
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      observation_type: ASSESSMENT_VERDICT_OBSERVATION_TYPE,
      summary: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"}): ${passMsg}`,
      detail: {
        verdict: effectiveVerdict.verdict,
        confidence: effectiveVerdict.confidence,
        reasons: effectiveVerdict.reasons,
        action,
        ..._assessorVerdictDelta(verdict, effectiveVerdict),
      },
    });

    const freshJob = getJob(job.id);
    const assessmentOutcome = updateAssessmentLifecycleFromVerdict(job.id, freshJob, effectiveVerdict);
    const finalStatus = freshJob?.status === "succeeded" ? "succeeded" : "failed";
    completeAttempt(attempt.id, {
      status: finalStatus,
      duration_ms: Date.now() - startTime,
      output_chars: output.length,
      error_text: finalStatus === "failed" ? assessmentOutcome.error : null,
    });
    if (freshJob?.status === "succeeded" && hasPendingFileRequests() && !spawnedFileRequestFollowUp) {
      spawnPendingFileRequestsOnce();
    }
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
    return;
  }
  if (shouldRunAssessment && !skipAssessForFileRequest && !skipAssessForSatisfiedNoop) {
    // acquireAssessmentBarrier already moved the job to awaiting_assessment;
    // for worktree writers it also atomically proved there were no live sibling
    // writers and installed the WI-local assessment barrier.
    const reviewed = latestFinalReview(job.id);
    worker.emit(job.id, `${C.yellow}[${DETERMINISTIC_AUDIT_ROLE}]${C.reset} WI#${job.work_item_id} job #${job.id}: ${reviewed ? "verifying final review" : "auditing"} ${shortJobTitle(job).slice(0, 50)}`);
    syncAssessorWorkerDisplay(worker.display, job, {
      tier: "cheap",
      effort: job.reasoning_effort || "medium",
      attempt: attempt.attempt_number || job.attempt_count || 1,
    });

    let taskAbAssessmentEvidence = "";
    let deterministicTestRun = null;
    let assessorProvider = "";
    let assessedCommitHash = committedHash || branchNetDiff?.head || null;
    try {
      if (!assessedCommitHash && verifiedNoChange && wtPath) {
        assessedCommitHash = String(await gitExecAsync(["rev-parse", "HEAD"], wtPath)).trim();
      }
      deterministicTestRun = await ensurePostChangeTestReceipt({
        job,
        payload: currentPayload,
        cwd: wtPath,
        commitHash: assessedCommitHash,
        attemptId: attempt.id,
        cleanupWorktree: wtPath
          ? async () => snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `test-post-change-side-effects-wi-${job.work_item_id}-job-${job.id}`,
              branchName: getWorkItem(job.work_item_id)?.branch_name || null,
              wiId: job.work_item_id,
              onMsg: (message) => worker.emit(job.id, `${C.dim}[audit-test] ${message}${C.reset}`),
            })
          : null,
        siblingOwnedPaths: wtPath ? (paths) => siblingOwnedWorktreePaths(job.id, paths) : null,
        repairDependencies: wtPath
          ? (receipt) => repairTestDependencies(worker, job, wtPath, {
              signal: worker._abortControllers?.get(job.id)?.signal || null,
              phase: "assessor",
              receipt,
            })
          : null,
      });
    } catch (testError) {
      const testInfraMsg = `Deterministic post-change test execution failed to initialize: ${testError?.message || testError}`;
      recordAssessmentInfrastructureAttempt(job, leaseToken, attempt.id, startTime, testInfraMsg);
      routeAssessmentInfrastructureFailure(worker, job, leaseToken, testError, {
        pendingFileRequests,
      });
      return;
    }
    if (deterministicTestRun?.post_change) {
      const postReceipt = deterministicTestRun.post_change;
      const source = postReceipt.source || "planner";
      const logSummary = postChangeTestLogSummary(postReceipt);
      worker.emit(
        job.id,
        `${logSummary.tone === "passed" ? C.green : logSummary.tone === "failed" ? C.red : C.yellow}[audit-test] ${postReceipt.reused ? "Reused" : "Ran"} frozen command: ${logSummary.text}${C.reset}`,
      );
      recordObservation({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.id,
        observation_type: "command.pre_assess",
        summary: `Frozen ${source} test command ${postReceipt.status}`,
        detail: {
          ...testReceiptObservationDetail(postReceipt),
          cwd: wtPath,
        },
      });
      taskAbAssessmentEvidence = renderTestExecutionEvidence(deterministicTestRun ? { ...deterministicTestRun, scope_attribution: testRunScopeAttribution(job.id, deterministicTestRun) } : {});
      if (isBlockingVerificationInfrastructureOutcome(postReceipt, { projectDir: worker.projectDir })) {
        const testInfraMsg = `Deterministic post-change test execution unavailable: ${postReceipt.reason || postReceipt.status}`;
        recordAssessmentInfrastructureAttempt(job, leaseToken, attempt.id, startTime, testInfraMsg);
        routeAssessmentInfrastructureFailure(worker, job, leaseToken,
          verificationInfrastructureError(postReceipt, "Deterministic post-change test execution unavailable"), {
          pendingFileRequests,
          operatorActionable: true,
        });
        return;
      }
    }

    const configuredVerification = await ensureConfiguredVerification(worker, {
      job,
      attemptId: attempt.id,
      assessedCommitHash,
      wtPath,
      preAssessAlreadyVerified,
    });
    if (isBlockingVerificationInfrastructureOutcome(configuredVerification, { projectDir: worker.projectDir })) {
      const failureMessage = configuredVerification.message
        || configuredVerification.error?.message
        || "Pre-assessment hook failed";
      recordAssessmentInfrastructureAttempt(job, leaseToken, attempt.id, startTime, failureMessage);
      routeAssessmentInfrastructureFailure(
        worker,
        job,
        leaseToken,
        configuredVerification.error || new Error(failureMessage),
        { pendingFileRequests, operatorActionable: true },
      );
      return;
    }
    if (configuredVerification.status === "failed") {
      taskAbAssessmentEvidence = [
        taskAbAssessmentEvidence,
        renderConfiguredVerificationEvidence(configuredVerification),
      ].filter(Boolean).join("\n\n");
    }

    try {
      const jobPayloadForAssess = worker.parsePayload(job);
      const taskMode = effectiveArtifactTaskMode(job, jobPayloadForAssess);

      let manifest = null;
      let fullManifest = null;
      if (isArtifactMode(taskMode) && jobPayloadForAssess.output_root) {
        const absOutputRoot = path.resolve(worker.projectDir, jobPayloadForAssess.output_root);
        fullManifest = buildManifest(absOutputRoot, absOutputRoot);

        if (preManifestState && preManifestState.size > 0) {
          manifest = filterNewOrChangedManifestFiles(fullManifest, preManifestState);
          if (manifest.count < fullManifest.count) {
            worker.emit(job.id, `${C.yellow}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: ${fullManifest.count} file(s) in output_root, ${manifest.count} new/changed this attempt (${fullManifest.count - manifest.count} unchanged)`);
          }
          if (manifest.count === 0 && shouldReuseUnchangedArtifactManifest({
            taskMode,
            fullManifest,
            output,
            outputRoot: jobPayloadForAssess.output_root || null,
            expectedFiles: jobPayloadForAssess.files_to_create || [],
            shouldFastPassArtifactAssessment,
          })) {
            manifest = fullManifest;
            worker.emit(job.id, `${C.yellow}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: reusing unchanged artifact output already present in output_root`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_ARTIFACT_EXISTING_OUTPUT_REUSED,
              actor_type: EVENT_ACTORS.WORKER,
              message: `Reusing unchanged artifact output in ${jobPayloadForAssess.output_root}`,
            });
          }
        } else {
          manifest = fullManifest;
        }

        if (manifest.count === 0) {
          const synthesized = materializeFallbackArtifactOutput({
            taskMode,
            payload: jobPayloadForAssess,
            output,
            projectDir: worker.projectDir,
            job,
          });
          if (synthesized) {
            worker.emit(job.id, `${C.yellow}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: synthesized fallback artifact ${path.relative(absOutputRoot, synthesized).replace(/\\/g, "/")}`);
            const refreshedManifest = buildManifest(absOutputRoot, absOutputRoot);
            manifest = preManifestState && preManifestState.size > 0
              ? filterNewOrChangedManifestFiles(refreshedManifest, preManifestState)
              : refreshedManifest;
          }
        }

        if (manifest.count === 0) {
          const emptyMsg = buildEmptyArtifactOutputMessage({
            taskMode,
            outputRoot: jobPayloadForAssess.output_root,
            manifest,
            fullManifest,
            preManifestState,
          });
          worker.emit(job.id, `${C.red}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: ${emptyMsg}`);
          logBadInputFailure(job, {
            attemptId: attempt.id,
            layer: "artificer",
            upstream: "artificer_output",
            classification: "empty_artifact_output",
            detail: emptyMsg,
          });
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.JOB_EMPTY_ARTIFACT,
            actor_type: EVENT_ACTORS.WORKER,
            message: emptyMsg,
          });
          setJobError(job.id, emptyMsg);
          completeAttempt(attempt.id, {
            status: "failed",
            duration_ms: Date.now() - startTime,
            error_text: emptyMsg,
          });
          worker._retryOrFail(job, leaseToken, emptyMsg, { attemptId: attempt.id });
          return;
        }

        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          artifact_type: "log",
          content_long: JSON.stringify({ task_mode: taskMode, output_root: jobPayloadForAssess.output_root, ...manifest }, null, 2),
        });
        worker.emit(job.id, `${C.cyan}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: ${manifest.count} file(s) produced in ${jobPayloadForAssess.output_root}`);
      }

      let contractViolations = null;
      let contractWarnings = null;
      if (manifest && isArtifactMode(taskMode)) {
        const contractResult = validateManifestAgainstContract(manifest, taskMode);
        if (Array.isArray(contractResult.warnings) && contractResult.warnings.length > 0) {
          contractWarnings = contractResult.warnings;
          worker.emit(job.id, `${C.yellow}[contract]${C.reset} WI#${job.work_item_id} job #${job.id}: warning - ${contractWarnings[0]}`);
        }
        if (!contractResult.valid) {
          contractViolations = contractResult.violations;
          worker.emit(job.id, `${C.yellow}[contract]${C.reset} WI#${job.work_item_id} job #${job.id}: ${contractViolations.length} violation(s) — ${contractViolations[0]}`);
        }
      }

      // A declared deliverable that was never written cannot carry assessor
      // evidence, so asking the assessor only opens a review gate (dnd-dissy
      // job 237). Fail it deterministically into the normal artificer retry,
      // which hands the missing names back as the last error.
      const outputRootAbs = path.resolve(worker.projectDir, jobPayloadForAssess.output_root || "");
      const expectedDeliverables = job.job_type === "artificer" && fullManifest
        ? [...new Set(expectedArtifactDeliverables(jobPayloadForAssess)
          .map((file) => String(file || "").replace(/\\/g, "/").trim())
          .filter((file) => file && !file.endsWith("/") && path.resolve(worker.projectDir, file) !== outputRootAbs)
          .map((file) => path.posix.basename(file)))]
        : [];
      const missingDeliverables = missingArtifactDeliverables({ manifest: fullManifest, expectedFiles: expectedDeliverables });
      if (missingDeliverables.length > 0) {
        const presentCount = expectedDeliverables.length - missingDeliverables.length;
        const missingMsg = `Artifact output is missing expected deliverable(s) under ${jobPayloadForAssess.output_root}: ${missingDeliverables.join(", ")}`
          + (presentCount > 0 ? `; the other ${presentCount} expected file(s) are present, so produce only the missing ones` : "");
        worker.emit(job.id, `${C.red}[manifest]${C.reset} WI#${job.work_item_id} job #${job.id}: ${missingMsg}`);
        logBadInputFailure(job, {
          attemptId: attempt.id,
          layer: "artificer",
          upstream: "artificer_output",
          classification: "missing_expected_files",
          detail: missingMsg,
        });
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          event_type: EVENT_TYPES.JOB_ARTIFACT_MISSING_DELIVERABLES,
          actor_type: EVENT_ACTORS.WORKER,
          message: missingMsg,
          event_json: JSON.stringify({ output_root: jobPayloadForAssess.output_root, missing: missingDeliverables }),
        });
        setJobError(job.id, missingMsg);
        completeAttempt(attempt.id, {
          status: "failed",
          duration_ms: Date.now() - startTime,
          error_text: missingMsg,
        });
        worker._retryOrFail(job, leaseToken, missingMsg, { attemptId: attempt.id });
        return;
      }

      const deterministicArtifactPass = shouldFastPassArtifactAssessment({
        taskMode,
        manifest,
        contractViolations,
        outputRoot: jobPayloadForAssess.output_root || null,
        expectedFiles: jobPayloadForAssess.files_to_create || [],
      });

      if (deterministicArtifactPass) {
        const passMsg = `Artifact manifest verified ${manifest.count} file(s) and all expected deliverables under ${jobPayloadForAssess.output_root}`;
        worker.emit(job.id, `${C.green}[${DETERMINISTIC_AUDIT_ROLE}]${C.reset} WI#${job.work_item_id} job #${job.id}: deterministic artifact pass`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          event_type: EVENT_TYPES.JOB_ARTIFACT_FAST_PASS,
          actor_type: EVENT_ACTORS.WORKER,
          message: passMsg,
        });
        const verdict = {
          verdict: "pass",
          confidence: "high",
          reasons: [passMsg],
          spawn_jobs: [],
          human_questions: [],
        };
        if (!isLeaseValid(job.id, leaseToken)) {
          worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} — lease expired before deterministic artifact verdict${C.reset}`);
          completeAttempt(attempt.id, {
            status: "interrupted",
            duration_ms: Date.now() - startTime,
            error_text: "Lease expired before deterministic artifact verdict — result discarded",
          });
          refreshAndExtractInsights(job.work_item_id);
          worker._cleanupWorktreeIfDone(job.work_item_id);
          return;
        }
        const emitFn = (msg) => worker.emit(job.id, assessmentDisplayMessage(msg));
        const { action, effectiveVerdict } = processVerdict(job, verdict, { emit: emitFn, projectDir: worker.projectDir, autoApprove: worker.autoApprove, leaseToken, assessedCommitHash });
        log.info(DETERMINISTIC_AUDIT_ROLE, `Verdict: ${effectiveVerdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: effectiveVerdict.verdict, confidence: effectiveVerdict.confidence, reasons: effectiveVerdict.reasons });
        jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"}) — ${passMsg.slice(0, 100)}` });
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: ASSESSMENT_VERDICT_OBSERVATION_TYPE,
          summary: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"}): ${passMsg}`,
          detail: {
            verdict: effectiveVerdict.verdict,
            confidence: effectiveVerdict.confidence,
            reasons: effectiveVerdict.reasons,
            action,
            ..._assessorVerdictDelta(verdict, effectiveVerdict),
          },
        });

        const freshJob = getJob(job.id);
        const assessmentOutcome = updateAssessmentLifecycleFromVerdict(job.id, freshJob, effectiveVerdict);
        const finalStatus = freshJob?.status === "succeeded" ? "succeeded" : "failed";
        completeAttempt(attempt.id, {
          status: finalStatus,
          duration_ms: Date.now() - startTime,
          output_chars: output.length,
          error_text: finalStatus === "failed" ? assessmentOutcome.error : null,
        });
        if (freshJob?.status === "succeeded" && hasPendingFileRequests() && !spawnedFileRequestFollowUp) {
          spawnPendingFileRequestsOnce();
        }
        refreshAndExtractInsights(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
        return;
      }

      const jobAc = worker._abortControllers.get(job.id);
      assessorProvider = reviewed ? null : String(
        await worker.agentDispatcher?.selectProvider?.({ role: "assessor", providerName: harnessAssessorProvider() })
        || "",
      ).trim().toLowerCase();
      if (!reviewed && !assessorProvider) {
        const routeError = new Error("Assessment requires an assessor Provider route from the AgentDispatcher");
        routeError.code = "POSSE_AGENT_PROVIDER_ROUTE_REQUIRED";
        throw routeError;
      }
      const assessmentContext = await attachAssessmentDiffContextAsync({
        job_id: job.id,
        task_mode: taskMode,
        manifest,
        contract_violations: contractViolations,
        contract_warnings: contractWarnings,
        commit_hash: committedHash,
        commit_base_hash: commitBaseHash,
        branch_net_diff_detected: !!branchNetDiff?.hasDiff,
        branch_net_diff_base: branchNetDiff?.mergeBase || null,
        branch_net_diff_head: branchNetDiff?.head || null,
        branch_net_diff_target: branchNetDiff?.targetBranch || null,
        branch_net_diff_files: branchNetDiff?.files || [],
        branch_net_diff: branchNetDiff?.diff || null,
        branch_net_diff_bytes: branchNetDiff?.diffBytes ?? null,
        branch_net_diff_truncated: branchNetDiff?.diffTruncated === true,
        branch_net_diff_stat: branchNetDiff?.diffStat || null,
        output_root: jobPayloadForAssess.output_root || null,
        verified_no_change: verifiedNoChange,
        allowed_files: jobPayloadForAssess.files_to_modify || [],
        allowed_create_files: jobPayloadForAssess.files_to_create || [],
        allowed_delete_files: scopedDeleteTargets(job, jobPayloadForAssess),
        allowed_create_roots: jobPayloadForAssess.create_roots || [],
        files_committed: filesCommitted,
        files_committed_unknown: filesCommittedUnknown,
        files_committed_error: filesCommittedError,
        merge_resolution_files: mergeResolutionFiles,
        files_reverted: filesReverted,
        files_requested: pendingFileRequests
          ? [...(pendingFileRequests.autoApproved || []), ...(pendingFileRequests.needsApproval || [])]
          : [],
      }, (isArtifactMode(taskMode) && jobPayloadForAssess.output_root)
        ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
        : (wtPath || worker.projectDir), { projectDir: worker.projectDir });
      if (taskAbAssessmentEvidence) {
        assessmentContext.task_ab_test_evidence = taskAbAssessmentEvidence;
      }
      const assessmentCwd = (isArtifactMode(taskMode) && jobPayloadForAssess.output_root)
        ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
        : (wtPath || worker.projectDir);
      const scopedCheckReceipt = await ensureAssessmentScopedCheckEvidence({
        job,
        attemptId: attempt.id,
        cwd: assessmentCwd,
        assessmentContext,
        siblingScopeOwners: (paths) => siblingJobScopeOwners(job.id, paths),
        cleanupWorktree: async ({ expectedHead }) => snapshotAndResetDirtyWorktreeAsync(
          assessmentCwd,
          worker.projectDir,
          {
            reason: `assessment-scoped-check-side-effects-wi-${job.work_item_id}-job-${job.id}`,
            branchName: getWorkItem(job.work_item_id)?.branch_name || null,
            wiId: job.work_item_id,
            expectedHead,
            onMsg: (message) => worker.emit(job.id, `${C.dim}[audit-checks] ${message}${C.reset}`),
          },
        ),
      });
      if (scopedCheckReceipt) {
        assessmentContext.scoped_check_evidence = scopedCheckReceipt.evidence;
        assessmentContext.scoped_check_result = scopedCheckReceipt.result;
        worker.emit(
          job.id,
          `${C.dim}[audit-checks] ${scopedCheckReceipt.reused ? "Reused" : "Ran"} changed-file lint/typecheck: ${scopedCheckReceipt.result.status}${C.reset}`,
        );
      }
      const assessOpts = {
        silent: worker.silent,
        autoApprove: worker.autoApprove,
        agentDispatcher: worker.agentDispatcher,
        routedProviderName: assessorProvider,
        abortSignal: jobAc?.signal || null,
        cwd: assessmentCwd,
        projectDir: worker.projectDir,
        assessmentContext,
        attemptId: attempt.id,
        allowMutatingRunners: !!wtPath,
      };
      let assessorModelCalled = false;
      const providerCall = getWorkerProviderCall(worker);
      const rawTrackedCall = (...args) => {
        assessorModelCalled = true;
        return providerCall(...args);
      };
      const usesProjectDirCwd = !wtPath
        && taskMode === "code"
        && path.resolve(assessmentCwd) === path.resolve(worker.projectDir);
      const trackedCall = usesProjectDirCwd
        ? (...callArgs) => callWithProjectDirAssessmentGuard(rawTrackedCall, callArgs, {
            projectDir: worker.projectDir,
            job,
            attemptId: attempt.id,
            emit: (message) => worker.emit(job.id, message),
          })
        : rawTrackedCall;
      const assessmentTierOrder = ["cheap", "standard"];
      const normalizeAssessmentTier = (value, fallback = "cheap") => {
        const raw = String(value || "").trim().toLowerCase();
        if (raw === "strong") return "standard";
        return assessmentTierOrder.includes(raw) ? raw : fallback;
      };
      const nextAssessmentTier = (value) => {
        const current = normalizeAssessmentTier(value);
        const index = assessmentTierOrder.indexOf(current);
        return assessmentTierOrder[Math.min(index + 1, assessmentTierOrder.length - 1)];
      };
      const assessmentReasoningEffort = harnessAssessorEffort()
        || (["low", "medium", "high"].includes(String(jobPayloadForAssess._assess_reasoning_effort || "").trim().toLowerCase())
          ? String(jobPayloadForAssess._assess_reasoning_effort).trim().toLowerCase()
          : "medium");
      // A/B harnesses compare execution routes, not assessor strength. Allow
      // the harness supervisor to hold the in-job assessor tier constant even
      // when a planner independently adjusts the developer job tier.
      const harnessAssessmentTier = taskAbAssessorTier(getWorkItem(job.work_item_id))
        || (process.env.POSSE_AB_HARNESS ? process.env.POSSE_AB_ASSESSOR_TIER : null);
      const requestedAssessmentTier = normalizeAssessmentTier(
        harnessAssessmentTier || jobPayloadForAssess._assess_model_tier,
        "cheap",
      );
      const initialAssessmentTier = requestedAssessmentTier;
      let lastAssessmentTier = initialAssessmentTier;
      let verdict = await assessResult(job, output, {
        ...assessOpts,
        modelTier: initialAssessmentTier,
        reasoningEffort: assessmentReasoningEffort,
        fallbackReads: raiseAssessmentFallbackReadsForScope(
          assessmentRetryFallbackReads(initialAssessmentTier, 0),
          { assessmentContext: assessOpts.assessmentContext, payload: jobPayloadForAssess },
        ),
        trackedCall,
      });

      if (verdict.verdict === "parse_error") {
        const retryTier = nextAssessmentTier(lastAssessmentTier);
        if (retryTier === lastAssessmentTier) {
          verdict = {
            ...verdict,
            _disable_internal_retry: true,
          };
        } else {
          worker.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id} parse error at ${lastAssessmentTier} tier — retrying at ${retryTier}${C.reset}`);
          worker.display?.updateWorkerTier(job.id, retryTier, attempt.attempt_number || job.attempt_count || 1);
          logBadInputFailure(job, {
            attemptId: attempt.id,
            layer: "assessor",
            upstream: "assessor_output",
            classification: "parse_error_retry",
            detail: `${lastAssessmentTier}-tier assessment parse error: ${(verdict.reasons || []).join("; ")}`,
            snippet: verdict.raw || "",
          });
          const callBudget = assessorCallBudgetStatus(job.id, attempt.id);
          if (callBudget.exceeded) {
            const message = `Assessment retry call budget exhausted (${callBudget.used}/${callBudget.cap} calls) before ${retryTier}-tier retry`;
            worker.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id} ${message}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_ASSESSMENT_PARSE_RETRY_BUDGET_EXCEEDED,
              actor_type: EVENT_ACTORS.WORKER,
              message,
            });
            logBadInputFailure(job, {
              attemptId: attempt.id,
              layer: "assessor",
              upstream: "assessor_output",
              classification: "parse_error_retry_budget_exceeded",
              detail: message,
              snippet: verdict.raw || "",
            });
            verdict = {
              ...verdict,
              reasons: [message, ...(Array.isArray(verdict.reasons) ? verdict.reasons : [])],
              _disable_internal_retry: true,
            };
          } else {
            verdict = await assessResult(job, output, {
              ...assessOpts,
              modelTier: retryTier,
              reasoningEffort: assessmentReasoningEffort,
              fallbackReads: raiseAssessmentFallbackReadsForScope(
                assessmentRetryFallbackReads(retryTier, 1),
                { assessmentContext: assessOpts.assessmentContext, payload: jobPayloadForAssess },
              ),
              trackedCall,
            });
            lastAssessmentTier = retryTier;
          }
        }
      }
      if (verdict.verdict === "parse_error" && !verdict._disable_internal_retry) {
        const retryTier = nextAssessmentTier(lastAssessmentTier);
        if (retryTier === lastAssessmentTier) {
          verdict = {
            ...verdict,
            _disable_internal_retry: true,
          };
        } else {
          worker.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id} parse error at ${lastAssessmentTier} tier — retrying at ${retryTier}${C.reset}`);
          logBadInputFailure(job, {
            attemptId: attempt.id,
            layer: "assessor",
            upstream: "assessor_output",
            classification: "parse_error_retry",
            detail: `${lastAssessmentTier}-tier assessment parse error: ${(verdict.reasons || []).join("; ")}`,
            snippet: verdict.raw || "",
          });
          const callBudget = assessorCallBudgetStatus(job.id, attempt.id);
          if (callBudget.exceeded) {
            const message = `Assessment retry call budget exhausted (${callBudget.used}/${callBudget.cap} calls) before ${retryTier}-tier retry`;
          worker.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id} ${message}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.JOB_ASSESSMENT_PARSE_RETRY_BUDGET_EXCEEDED,
            actor_type: EVENT_ACTORS.WORKER,
            message,
          });
          logBadInputFailure(job, {
            attemptId: attempt.id,
            layer: "assessor",
            upstream: "assessor_output",
            classification: "parse_error_retry_budget_exceeded",
            detail: message,
            snippet: verdict.raw || "",
          });
          verdict = {
            ...verdict,
            reasons: [message, ...(Array.isArray(verdict.reasons) ? verdict.reasons : [])],
            _disable_internal_retry: true,
          };
        } else {
          verdict = await assessResult(job, output, {
            ...assessOpts,
            modelTier: retryTier,
            reasoningEffort: assessmentReasoningEffort,
            // Second (strong-tier) retry — index 2, not 1; the copy/pasted block
            // gave the strong-tier retry the standard-tier fallback-read budget. (B13)
            fallbackReads: raiseAssessmentFallbackReadsForScope(
              assessmentRetryFallbackReads(retryTier, 2),
              { assessmentContext: assessOpts.assessmentContext, payload: jobPayloadForAssess },
            ),
            trackedCall,
          });
          lastAssessmentTier = retryTier;
        }
      }
      }

      if (shouldOverrideArtifactMissingFail(verdict, {
        taskMode,
        manifest,
        contractViolations,
        outputRoot: jobPayloadForAssess.output_root || null,
      })) {
        const overrideMsg = `Artifact manifest confirms ${manifest.count} file(s) exist under ${jobPayloadForAssess.output_root}; overriding false missing-output assessment`;
        worker.emit(job.id, `${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: ${overrideMsg}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          event_type: EVENT_TYPES.JOB_ASSESSMENT_FALSE_MISSING_OVERRIDE,
          actor_type: EVENT_ACTORS.WORKER,
          message: overrideMsg,
        });
        verdict = {
          ...verdict,
          verdict: "pass",
          confidence: "high",
          reasons: [overrideMsg],
        };
        // Correcting file-presence evidence cannot supply missing visual
        // evidence for a semantic image acceptance criterion.
        verdict = applyImageVisualEvidencePolicy({
          payload: { ...jobPayloadForAssess, task_mode: taskMode },
          verdict,
        });
      }

      if (!isLeaseValid(job.id, leaseToken)) {
        worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} — lease expired during assessment, skipping verdict${C.reset}`);
        completeAttempt(attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - startTime,
          error_text: "Lease expired during assessment — verdict skipped",
        });
        refreshAndExtractInsights(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
        return;
      }

      const emitFn = (msg) => worker.emit(job.id, assessmentDisplayMessage(msg, assessorModelCalled));
      let reviewedCompletion = null;
      if (verdict.verdict === "pass" && wtPath && !filesCommittedUnknown) {
        try {
          reviewedCompletion = await prepareReviewedFileCompletion(getJob(job.id) || job, wtPath, {
            committedHash: assessedCommitHash, commitBaseHash, filesCommitted, verifiedNoChange,
          });
        } catch (error) {
          worker.emit(job.id, `[system] Reviewed handoff unavailable: ${error.message}`);
        }
      }
      const { effectiveVerdict } = processVerdict(job, verdict, {
        reviewedCompletion,
        projectDir: worker.projectDir,
        assessmentModelTier: lastAssessmentTier,
        emit: emitFn,
        autoApprove: worker.autoApprove,
        leaseToken,
        assessedCommitHash,
        reviewEvidence: {
          post_change: deterministicTestRun?.post_change || null,
          scoped_checks: scopedCheckReceipt || null,
        },
      });
      log.info(assessorModelCalled ? "assessor" : DETERMINISTIC_AUDIT_ROLE, `Verdict: ${effectiveVerdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: effectiveVerdict.verdict, confidence: effectiveVerdict.confidence, reasons: effectiveVerdict.reasons?.slice(0, 3) });
      jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"})${effectiveVerdict.reasons?.length ? ` — ${effectiveVerdict.reasons[0].slice(0, 100)}` : ""}` });

      recordObservation({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.id,
        observation_type: ASSESSMENT_VERDICT_OBSERVATION_TYPE,
        summary: `${effectiveVerdict.verdict} (${effectiveVerdict.confidence || "?"})`,
        detail: {
          verdict: effectiveVerdict.verdict,
          confidence: effectiveVerdict.confidence,
          reasons: effectiveVerdict.reasons || [],
          spawn_jobs: effectiveVerdict.spawn_jobs || [],
          ..._assessorVerdictDelta(verdict, effectiveVerdict),
        },
      });
      const freshJob = getJob(job.id);
      const assessmentOutcome = updateAssessmentLifecycleFromVerdict(job.id, freshJob, effectiveVerdict);
      if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
        worker._releaseLease(job, leaseToken, freshJob.status);
      }
      const ATTEMPT_STATUS_MAP = { succeeded: "succeeded", failed: "failed", queued: "interrupted", waiting_on_review: "interrupted", waiting_on_human: "interrupted", blocked: "blocked" };
      const finalStatus = ATTEMPT_STATUS_MAP[freshJob?.status] || "failed";
      completeAttempt(attempt.id, {
        status: finalStatus,
        duration_ms: Date.now() - startTime,
        output_chars: output.length,
        error_text: finalStatus === "failed" ? assessmentOutcome.error : null,
      });
      if (freshJob?.status === "succeeded" && hasPendingFileRequests() && !spawnedFileRequestFollowUp) {
        spawnPendingFileRequestsOnce();
      }
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
    } catch (assessErr) {
      const assessErrMessage = String(assessErr?.message || "");
      const turnBudgetExhausted = /exhausted turn budget|turn budget exhausted|tool(?: use| call)?s?.{0,40}(?:exhausted|limit|max|budget)/i.test(assessErrMessage);
      const stallKilled = !!assessErr?.stallKill || /stalled.*killed|killed by stall detector/i.test(assessErrMessage);
      const terminalHandoffRetry = assessmentTerminalHandoffRetryDecision(job.id, assessErr);
      const terminalHandoffMissing = terminalHandoffRetry.retryable;
      if (isProviderError(assessErr) || assessErr?.assessmentRetryable || assessErr?.assessmentGateImmediately || turnBudgetExhausted || stallKilled || terminalHandoffMissing) {
        const retryLabel = assessErr?.assessmentGateImmediately
          ? "Assessment budget exhausted"
          : assessErr?.assessmentRetryable
          ? "Environment/tooling error during assessment"
          : (terminalHandoffMissing
            ? "Assessment terminal handoff missing"
            : (stallKilled
              ? "Assessment stalled"
              : (turnBudgetExhausted
                ? "Assessment turn budget exhausted"
                : "Provider error during assessment")));
        worker.emit(job.id, `${C.yellow}[assessor] ${retryLabel} - requeuing: ${assessErr.message?.split("\n")[0]?.slice(0, 120)}${C.reset}`);
        completeAttempt(attempt.id, {
          // This row is the implementation attempt. The implementation and
          // commit completed even though its attached assessment did not.
          status: "succeeded",
          duration_ms: Date.now() - startTime,
          error_text: assessErr?.assessmentGateImmediately
            ? `Assessment budget exhausted: ${assessErr.message}`
            : assessErr?.assessmentRetryable
            ? `Assessment environment error: ${assessErr.message}`
            : (stallKilled
              ? `Assessment stalled: ${assessErr.message}`
              : (turnBudgetExhausted
                ? `Assessment turn budget exhausted: ${assessErr.message}`
                : (terminalHandoffMissing
                  ? `Assessment terminal handoff error: ${assessErr.message}`
                  : `Assessment provider error: ${assessErr.message}`))),
        });

        if (wtPath) {
          try {
            if (await gitHasChangesAsync(wtPath)) {
              const siblingLocks = activeSiblingWriteLocks(job);
              if (siblingLocks.length > 0) {
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: `Deferred assessment-error dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                  event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                });
              } else {
                try {
                  await stashDirtyWorktreeAsync(wtPath, worker.projectDir, `posse: stash from rate-limited assessment job #${job.id}`, {
                    shouldDefer: () => {
                      const lateSiblingLocks = activeSiblingWriteLocks(job);
                      if (lateSiblingLocks.length === 0) return false;
                      logEvent({
                        work_item_id: job.work_item_id,
                        job_id: job.id,
                        attempt_id: attempt.id,
                        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                        actor_type: EVENT_ACTORS.WORKER,
                        message: `Deferred assessment-error dirty cleanup; ${lateSiblingLocks.length} same-WI job lock(s) still active`,
                        event_json: JSON.stringify({ locks: lateSiblingLocks.slice(0, 20) }),
                      });
                      return true;
                    },
                  });
                }
                catch (stashErr) {
                  // Stash failed — leave the dirt for setup recovery rather
                  // than wiping the only copy of the rate-limited attempt.
                  logEvent({
                    work_item_id: job.work_item_id,
                    job_id: job.id,
                    attempt_id: attempt.id,
                    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                    actor_type: EVENT_ACTORS.WORKER,
                    message: `Left assessment-error dirty state in place; stash failed: ${stashErr?.message || String(stashErr)}`,
                    event_json: JSON.stringify({ reason: `assessment-error-job-${job.id}` }),
                  });
                }
              }
            }
          } catch { /* ignore */ }
        }

        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          event_type: (assessErr?.assessmentRetryable || assessErr?.assessmentGateImmediately)
            ? EVENT_TYPES.JOB_ASSESSMENT_ENVIRONMENT_ERROR
            : (stallKilled
              ? EVENT_TYPES.JOB_STALL_KILLED
              : (turnBudgetExhausted
                ? EVENT_TYPES.JOB_ASSESSMENT_TURN_BUDGET_EXHAUSTED
                : EVENT_TYPES.JOB_ASSESSMENT_PROVIDER_ERROR)),
          actor_type: EVENT_ACTORS.WORKER,
          message: `${retryLabel} - routing through the independent assessment budget: ${assessErr.message?.split("\n")[0]}`,
        });

        const assessBackoff = terminalHandoffMissing
          ? 2
          : (assessErr?.assessmentRetryable || assessErr?.assessmentGateImmediately)
          ? 5
          : (turnBudgetExhausted || stallKilled
            ? 2
            : (assessorProvider
              ? getProviderBackoff(assessorProvider, assessErr).backoffSec
              : 2));
        const readyAt = new Date(Date.now() + assessBackoff * 1000).toISOString();
        try {
          markAssessmentRetryAssessOnly(job, pendingFileRequests);
        } catch (markErr) {
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.JOB_ASSESSMENT_PROVIDER_ERROR,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Failed to mark assessment retry as assess-only: ${markErr?.message || markErr}`,
          });
        }
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, assessErr, {
          pendingFileRequests,
          readyAt,
        });
      } else {
        worker.emit(job.id, `${C.red}[assessor] Transport error: ${assessErr.message}${C.reset}`);
        completeAttempt(attempt.id, {
          status: "succeeded",
          duration_ms: Date.now() - startTime,
          error_text: `Assessment transport error: ${assessErr.message}`,
        });
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          event_type: EVENT_TYPES.JOB_ASSESSMENT_TRANSPORT_ERROR,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Assessment failed — flagging for review: ${assessErr.message}`,
        });
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, assessErr, {
          pendingFileRequests,
        });
        refreshAndExtractInsights(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
      }
    }
    return;
  }

  // Non-assessable job or assessment skipped — mark succeeded
  log.info("worker", `Recorded ${job.job_type} job #${job.id} outcome without assessment`, { jobId: job.id, wiId: job.work_item_id, type: job.job_type, durationMs: Date.now() - startTime });
  recordObservation({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt.id,
    observation_type: "job.done",
    summary: `${job.job_type} succeeded`,
    detail: { duration_ms: Date.now() - startTime, assessed: false, output_chars: output.length },
  });
  completeAttempt(attempt.id, {
    status: "succeeded",
    duration_ms: Date.now() - startTime,
    output_chars: output.length,
  });

  if (job.job_type === "research") {
    // Research has already captured bounded waiting-lane hot paths. Do not
    // enqueue the legacy full WI warm here: ordinary planning reads main and
    // does not consume a parked WI view.
    worker._spawnPlanAfterResearch(job, output);
  } else if (job.job_type === "preflight") {
    worker._spawnResearchAfterPreflight(job, output);
  }

  if (hasPendingFileRequests() && isLeaseValid(job.id, leaseToken)) spawnPendingFileRequestsOnce();
  worker._releaseLease(job, leaseToken, "succeeded");
  refreshAndExtractInsights(job.work_item_id);
  worker._cleanupWorktreeIfDone(job.work_item_id);
}
