// lib/domains/worker/functions/helpers/assessment-pipeline.js
//
// Post-execution assessment pipeline extracted from worker.js.

import path from "path";
import fs from "fs";
import crypto from "crypto";
import {
  acquireAssessmentBarrier,
  beginAttachedAssessmentAttempt,
  completeAttempt,
  createJob,
  getArtifacts,
  getAttempts,
  getJob,
  getSetting,
  getWorkItem,
  isLeaseValid,
  logEvent,
  setJobError,
  setAssessmentLifecycle,
  storeArtifact,
  updateJobPayload,
  updateJobStatus,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { isArtifactMode, buildManifest, validateManifestAgainstContract } from "../../../artifacts/functions/index.js";
import { harnessAssessorEffort, harnessAssessorProvider } from "./assessment-shared.js";
import { getProviderBackoff } from "../../../providers/functions/provider.js";
import {
  attachAssessmentDiffContextAsync,
  buildHandoffPacket,
  composePromptRemoteAware,
  buildSmartPreload,
  handoff,
  renderAtlasHandoffSections,
} from "../../../handoff/functions/index.js";
import {
  getAgentHandoffRecord,
  isRetryableTerminalHandoffError,
} from "../../../handoff/functions/agent-handoff.js";
import { refreshAndExtractInsights } from "./insights.js";
import { gitExec, gitExecAsync, gitHasChangesAsync } from "../../../git/functions/utils.js";
import {
  snapshotAndResetDirtyWorktreeAsync,
  stashDirtyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import { ASSESSABLE_JOB_TYPES } from "../../../../catalog/job.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../../catalog/native-tools.js";
import { effectiveArtifactTaskMode } from "../../../providers/functions/execution-routing.js";
import {
  artifactOutputClaimsReusableComplete,
  filterNewOrChangedManifestFiles,
  materializeFallbackArtifactOutput,
} from "./artifact-output.js";
import { scopedDeleteTargets } from "./mutation-guards.js";
import {
  sanitizeHumanQuestions,
  isRepoFileAccessQuestion,
} from "./human-question-classifier.js";
import {
  buildWorkflowModeBlock,
  getWorkItemWorkflowConfig,
} from "../../../intake/functions/hints.js";
import { isInsideRoot, isUnderRoot, normPath, normalizeRoots } from "../../../../shared/scope/functions/path.js";
import { isTestCollateralPath } from "../../../../shared/policies/functions/scope-auto-approval.js";
import { processVerdict } from "./process-verdict.js";
import { normalizeAssessorConfidence } from "./verdict-shared.js";
import {
  activeSiblingWriteLocks,
  siblingLockSummary,
} from "../../../queue/functions/sibling-locks.js";
import {
  getAtlasWarmJobCompletion,
  waitForAtlasWarmJobCompletion,
} from "../../../atlas/classes/v2/PipelineHooks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { ensureRegisteredTestTables, runRegisteredTest } from "../../../../shared/tools/functions/toolkit/registered-tests.js";
import { REGISTERED_TEST_AGENT_SURFACE_ENABLED } from "../../../../catalog/registered-tests.js";
import {
  persistPendingAssessmentFileRequests,
  shouldDeferAssessmentToFileRequestContinuation,
} from "./assessment-file-requests.js";
import {
  ensurePostChangeTestReceipt,
  renderTestExecutionEvidence,
  testReceiptObservationDetail,
} from "./test-execution-receipt.js";
import {
  buildAssessmentTaskBoundary,
  classifySiblingOnlyAssessmentFailure,
  recordAssessmentBoundaryEvent,
  renderAssessmentTaskBoundary,
} from "./assessment-task-boundary.js";
import {
  killShellCommandProcessTree as killShellCommandProcessTreeImpl,
  runShellCommandAsync as runShellCommandAsyncImpl,
} from "./assessment-runner.js";
import {
  assessorCallBudgetStatus,
  getAssessorMaxToolCalls,
  isAssessorParseRetryBudgetExceeded as assessorTokenBudgetStatus,
} from "../execution/assessment-policy.js";

export { capVerdictForDeterministicTestRegression } from "./verdict-shared.js";
export {
  buildAssessmentTaskBoundary,
  classifySiblingOnlyAssessmentFailure,
  renderAssessmentTaskBoundary,
} from "./assessment-task-boundary.js";

function readSettingText(key) {
  try {
    const value = getSetting(key);
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

function readSettingBool(key, fallback = false) {
  const value = readSettingText(key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

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

function updateAssessmentLifecycleFromVerdict(jobId, freshJob, verdict = null) {
  if (freshJob?.status === "succeeded" || verdict?.verdict === "pass") {
    setAssessmentLifecycle(jobId, "assessment_passed", { completed: true });
  } else if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
    setAssessmentLifecycle(jobId, "assessment_needs_human");
  } else if (freshJob?.status === "failed" || verdict?.verdict === "fail") {
    setAssessmentLifecycle(jobId, "assessment_failed", { completed: true });
  }
}

function routeAssessmentInfrastructureFailure(worker, job, leaseToken, error, {
  pendingFileRequests = null,
  readyAt = null,
} = {}) {
  const message = String(error?.message || error || "Assessment unavailable");
  markAssessmentRetryAssessOnly(job, pendingFileRequests);
  const fresh = getJob(job.id) || job;
  const count = Number(fresh.assessment_attempt_count || 0);
  const max = Math.max(1, Number(fresh.assessment_max_attempts || 3));
  if (count >= max) {
    if (isRetryableTerminalHandoffError(error)) {
      setAssessmentLifecycle(job.id, "assessment_failed", { error: message, completed: true });
      worker.emit(job.id, `${C.red}[assessor] Terminal handoff repair budget exhausted; failing without an operator gate${C.reset}`);
      worker._releaseLease(job, leaseToken, "failed");
      return { gated: false, terminalProtocolFailure: true };
    }
    setAssessmentLifecycle(job.id, "assessment_needs_human", { error: message });
    const reviewJob = createJob({
      work_item_id: job.work_item_id,
      job_type: "human_input",
      title: `Assessment unavailable: ${String(job.title || "").slice(0, 70)}`,
      parent_job_id: job.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: job.id,
        gate_kind: "assessment_retry_exhausted",
        review_type: "assessment_retry_limit",
        question_kind: "assessment_retry_limit",
        choices: WORK_ITEM_QUESTION_CHOICE_IDS.assessment_retry_limit,
        questions: [
          `Assessment for job #${job.id} could not complete after ${count} attempt(s): ${message.split("\n")[0].slice(0, 180)}`,
          "Choose pass, fail, skip, or replan.",
        ],
        context: "The implementation attempt and commit are preserved. This gate controls assessment only.",
      }),
    });
    worker.emit(job.id, `${C.yellow}[assessor] Assessment retry budget exhausted; opened review gate #${reviewJob.id}${C.reset}`);
    worker._releaseLease(job, leaseToken, "waiting_on_review");
    return { gated: true, reviewJob };
  }
  setAssessmentLifecycle(job.id, "assessment_unavailable", { error: message });
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

function _mergeUniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))];
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

// Memoized per cwd: the nested-repo prefix is fixed for a directory for the
// lifetime of a session, and this runs inside every committed-scope check —
// without the cache each check pays a synchronous `git rev-parse` on the main
// thread. Failures are not cached (a transient git error must retry).
// Bounded by the number of distinct worktree/project cwds the process touches
// (a handful per run); never invalidated — the prefix is derived from on-disk
// repo layout, which is stable for the process lifetime.
const _nestedRepoPrefixCache = new Map();

function _deriveNestedRepoPrefix(cwd = process.cwd()) {
  if (!cwd) return null;
  const key = path.resolve(cwd);
  if (_nestedRepoPrefixCache.has(key)) return _nestedRepoPrefixCache.get(key);
  try {
    const repoRoot = path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd));
    const rel = path.relative(repoRoot, key);
    const prefix = (!rel || rel === "." || !isInsideRoot(key, repoRoot, { allowEqual: false, followSymlinks: false }))
      ? null
      : (normPath(rel) || null);
    _nestedRepoPrefixCache.set(key, prefix);
    return prefix;
  } catch {
    return null;
  }
}

function _scopePathCandidates(filePath, nestedRepoPrefix = null) {
  const normalized = normPath(filePath);
  if (!normalized) return [];
  const candidates = [normalized];
  if (nestedRepoPrefix) {
    const prefix = `${nestedRepoPrefix}/`;
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length);
      if (stripped) candidates.push(stripped);
    }
  }
  return [...new Set(candidates)];
}

function _findOutOfScopeCommittedFiles(filesCommitted, {
  allowedFiles = [],
  allowedCreateFiles = [],
  allowedDeleteFiles = [],
  allowedCreateRoots = [],
  cwd = process.cwd(),
  nestedRepoPrefix = null,
} = {}) {
  const effectiveNestedRepoPrefix = nestedRepoPrefix || _deriveNestedRepoPrefix(cwd);
  const allAllowed = new Set([
    ...allowedFiles,
    ...allowedCreateFiles,
    ...allowedDeleteFiles,
  ].flatMap((value) => _scopePathCandidates(value, effectiveNestedRepoPrefix)));
  const normalizedRoots = normalizeRoots(allowedCreateRoots, cwd);
  return (Array.isArray(filesCommitted) ? filesCommitted : []).filter((filePath) => {
    const candidates = _scopePathCandidates(filePath, effectiveNestedRepoPrefix);
    if (candidates.length === 0) return true;
    return !candidates.some((candidate) => allAllowed.has(candidate) || isUnderRoot(candidate, normalizedRoots));
  });
}

export function __testFindOutOfScopeCommittedFiles(filesCommitted, opts = {}) {
  return _findOutOfScopeCommittedFiles(filesCommitted, opts);
}

function _requestedScopePathSet(filesRequested = [], cwd = null) {
  const out = new Set();
  for (const request of Array.isArray(filesRequested) ? filesRequested : []) {
    const value = _normalizeAssessmentScopePath(request?.path, cwd);
    if (value) out.add(value);
  }
  return out;
}

function _buildCommittedScopeViolationVerdict(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object") return null;
  const taskMode = assessmentContext.task_mode || "code";
  if (isArtifactMode(taskMode)) return null;
  if (assessmentContext.files_committed_unknown === true) {
    const detail = assessmentContext.files_committed_error
      ? ` Error: ${String(assessmentContext.files_committed_error).slice(0, 240)}`
      : "";
    return {
      verdict: "fail",
      confidence: "high",
      reasons: [
        `Deterministic scope verification failed: could not verify the actual committed files for commit ${assessmentContext.commit_hash || "(unknown)"}.${detail}`,
      ],
      spawn_jobs: [],
      human_questions: [],
      suggestions: [],
      raw: "",
    };
  }
  const filesCommitted = Array.isArray(assessmentContext.files_committed)
    ? assessmentContext.files_committed
    : [];
  if (filesCommitted.length === 0) return null;

  const outOfScope = _findOutOfScopeCommittedFiles(filesCommitted, {
    allowedFiles: assessmentContext.allowed_files || [],
    allowedCreateFiles: assessmentContext.allowed_create_files || [],
    allowedDeleteFiles: assessmentContext.allowed_delete_files || [],
    allowedCreateRoots: assessmentContext.allowed_create_roots || [],
    cwd,
  });
  if (outOfScope.length === 0) return null;

  const requestedPaths = _requestedScopePathSet(assessmentContext.files_requested, cwd);
  const requestedCommitted = outOfScope.filter((filePath) =>
    requestedPaths.has(_normalizeAssessmentScopePath(filePath, cwd))
  );
  const requestedNote = requestedCommitted.length > 0
    ? ` Requested-file entries are follow-up scope, not permission for this commit: ${JSON.stringify(requestedCommitted)}.`
    : "";
  return {
    verdict: "fail",
    confidence: "high",
    reasons: [
      `Deterministic scope violation: committed out-of-scope file(s) ${JSON.stringify(outOfScope)}.${requestedNote}`,
    ],
    spawn_jobs: [],
    human_questions: [],
    suggestions: [],
    raw: "",
  };
}

export function __testBuildCommittedScopeViolationVerdict(assessmentContext = null, cwd = null) {
  return _buildCommittedScopeViolationVerdict(assessmentContext, cwd);
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

function _isFalsyDisabledTestMarkerValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["false", "null", "undefined", "nan", "''", "\"\"", "``", "void 0"].includes(normalized)) {
    return true;
  }
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?n?$/.test(normalized);
}

function _disabledRequiredTestMarkers(scopedDiff = "") {
  const added = _addedScopedDiffText(scopedDiff);
  if (!added) return [];
  const patterns = [
    /\b(?:describe|it|test)\.(?:skip|todo)\s*\(/gi,
    /\b(?:xdescribe|xit|xtest)\s*\(/gi,
    /@(?:pytest\.mark\.skip|unittest\.skip|Disabled)\b/gi,
    /\bpytest\.skip\s*\(/gi,
    /#\s*\[\s*ignore\s*\]/gi,
  ];
  const addedTests = _addedScopedTestDiffText(scopedDiff);
  const propertyMarkers = [...addedTests.matchAll(/\b(?:todo|skip)\s*:\s*([^,}\n]+)/gi)]
    .filter((match) => !_isFalsyDisabledTestMarkerValue(match[1]))
    .map((match) => match[0]);
  return [...new Set([
    ...patterns.flatMap((pattern) => added.match(pattern) || []),
    ...propertyMarkers,
  ])];
}

function _buildDisabledRequiredTestsVerdict({ assessmentContext = null, taskSpec = "" } = {}) {
  const scopedDiff = assessmentContext?.scoped_git_diff || assessmentContext?.branch_net_diff || "";
  const markers = _disabledRequiredTestMarkers(scopedDiff);
  if (markers.length === 0) return null;
  const requirement = String(taskSpec || "");
  const requiresActiveTests = /\b(?:test|tests|testing|regression|coverage|assertion|assertions)\b/i.test(requirement);
  const explicitlyAllowsDisabledTests = /\b(?:allow|keep|preserve|create|add)\b[^.\n]{0,100}\b(?:skipped|disabled|todo|ignored)\b/i.test(requirement);
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

const ASSESSOR_VALID_VERDICTS = new Set(["pass", "fail", "blocked", "needs_replan", "needs_review"]);

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

function _normalizeAssessmentScopePath(value, cwd = null, nestedRepoPrefix = null) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  const prefix = nestedRepoPrefix || (cwd ? _deriveNestedRepoPrefix(cwd) : null);
  if (prefix && normalized.startsWith(`${prefix}/`)) {
    return normalized.slice(prefix.length + 1);
  }
  return normalized;
}

function buildAssessmentProviderScope({ cwd = null, assessmentContext = null } = {}) {
  if (!assessmentContext || typeof assessmentContext !== "object") {
    return { scopedFiles: [], createFiles: [], deleteFiles: [], createRoots: [] };
  }
  const nestedRepoPrefix = _deriveNestedRepoPrefix(cwd);

  const scopedFiles = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
    ...(Array.isArray(assessmentContext.files_reverted) ? [assessmentContext.files_reverted] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => _normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const createFiles = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_files) ? [assessmentContext.allowed_create_files] : []),
    ...(Array.isArray(assessmentContext.manifest?.files)
      ? [assessmentContext.manifest.files.map((f) => f?.path).filter(Boolean)]
      : []),
  ).map((value) => _normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const deleteFiles = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_delete_files) ? [assessmentContext.allowed_delete_files] : []),
  ).map((value) => _normalizeAssessmentScopePath(value, cwd, nestedRepoPrefix)).filter(Boolean);

  const createRoots = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_create_roots) ? [assessmentContext.allowed_create_roots] : []),
    ...(assessmentContext.output_root ? [_normalizeAssessmentScopePath(assessmentContext.output_root, cwd, nestedRepoPrefix)] : []),
  ).filter(Boolean);

  return { scopedFiles, createFiles, deleteFiles, createRoots };
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
  fallbackReads = null,
} = {}) {
  return [
    Number.isFinite(Number(fallbackReads)) ? `Fallback read budget for this assessment attempt: ${Math.max(0, Number(fallbackReads))}.` : null,
    workflowModeBlock,
    verificationCapabilityBlock,
    `If the bounded role result marks VERIFICATION_UNAVAILABLE, keep the completion status tied to product work. Treat the unavailable method as NOT_APPLICABLE when attached evidence or one obvious equivalent invocation establishes the criterion; it is not, by itself, a reason to block.`,
    atlasBlock || null,
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

function _buildVerificationCapabilityBlock(payload = {}) {
  const contract = payload?.verification_contract && typeof payload.verification_contract === "object"
    ? payload.verification_contract
    : null;
  return [
    `VERIFICATION CAPABILITY CONTRACT:`,
    `Your issued tools plus the deterministic evidence attached to this prompt are the complete set of available verification methods for this attempt.`,
    `Use those assigned capabilities. Discard browser, lint, shell, or other verification options that are not callable through the issued tool surface and are not represented by deterministic verification evidence.`,
    `An unavailable optional method is NOT_APPLICABLE: do not lower confidence, fail, block, or ask a human merely because it cannot be run.`,
    `A configured test command is a verification recipe, not product behavior, unless the objective explicitly requires that literal invocation to work. If its launcher is unavailable, one obvious equivalent launcher or targeted invocation may establish the same criterion.`,
    `When a DETERMINISTIC TEST EXECUTION RECEIPT or DETERMINISTIC ASSESSOR TEST EXECUTION is attached, the orchestration layer already ran that frozen command outside model context. Treat the receipt as ground truth and do not rerun the command.`,
    `Do not request a repository file or human intervention solely to supply an executable alias or change test discovery after equivalent evidence proves the behavior.`,
    `If no equivalent evidence can establish a genuinely required criterion, return blocked once with the missing capability named. Do not retry the same assessment hoping the capability appears.`,
    contract ? `Task verification contract:\n${JSON.stringify(contract, null, 2)}` : null,
  ].filter(Boolean).join("\n");
}

function _dbTableExists(db, tableName) {
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
  } catch {
    return false;
  }
}

function _parseFailureJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : { message: String(parsed) };
  } catch {
    return { message: String(value) };
  }
}

function _parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _compactEvidenceText(value, max = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function _normalizeEvidenceScopeFiles(scopeFiles = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(scopeFiles) ? scopeFiles : []) {
    const rel = String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .trim();
    if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || /^[A-Za-z]:\//.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function _rowRegisteredTestTargetFiles(row) {
  return _parseJsonArray(row?.target_files_json).map((value) => String(value || "")).filter(Boolean);
}

function _registeredTestTargetsOverlapScope(row, scopeFiles = []) {
  const normalizedScope = _normalizeEvidenceScopeFiles(scopeFiles);
  if (normalizedScope.length === 0) return true;
  const scopeSet = new Set(normalizedScope);
  const targets = _rowRegisteredTestTargetFiles(row);
  if (targets.length === 0) return false;
  return targets.some((file) => scopeSet.has(file));
}

function _formatTargetImportHints(value) {
  const imports = _parseJsonArray(value);
  if (imports.length === 0) return "";
  return imports.slice(0, 8).map((entry) => {
    const parts = [];
    if (Array.isArray(entry?.symbols) && entry.symbols.length > 0) parts.push(`symbols=${entry.symbols.join(",")}`);
    if (entry?.default) parts.push(`default=${entry.default}`);
    if (entry?.namespace) parts.push(`namespace=${entry.namespace}`);
    return `${entry?.path || "unknown"}${parts.length ? ` (${parts.join("; ")})` : ""}`;
  }).join("; ");
}

function _formatRegisteredTestRunEvidence(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const ordered = [...rows].reverse();
  const passed = ordered.filter((row) => Number(row.ok) === 1).length;
  const failed = ordered.length - passed;
  const lines = [
    `REGISTERED POSSE TEST RUNS (runtime DB evidence from this job before assessment):`,
    `summary: ${passed}/${ordered.length} run${ordered.length === 1 ? "" : "s"} passed${failed ? `; ${failed} failed` : ""}.`,
    `Use this as verification evidence from the dev's registered test tools and system handoff rechecks. Rerun a relevant test or suite if it is central to the verdict or the result looks stale.`,
  ];

  for (const row of ordered) {
    const status = Number(row.ok) === 1 ? "PASS" : "FAIL";
    const suite = row.suite_name || row.suite_slug || `suite#${row.suite_id}`;
    const test = row.test_name || row.test_slug || (row.test_id ? `test#${row.test_id}` : "suite run");
    const duration = Number.isFinite(Number(row.duration_ms)) ? `${Number(row.duration_ms)}ms` : "?ms";
    const actor = row.created_by_role ? ` by ${row.created_by_role}` : "";
    const created = row.created_at ? ` at ${row.created_at}` : "";
    const language = row.language ? ` ${row.language}` : "";
    lines.push(`- ${status} run #${row.id}${actor}: ${suite} / ${test}${language} (${duration})${created}`);
    const targetFiles = _rowRegisteredTestTargetFiles(row);
    const targetSymbols = _parseJsonArray(row.target_symbols_json).map((value) => String(value || "")).filter(Boolean);
    const importHints = _formatTargetImportHints(row.target_imports_json);
    if (targetFiles.length > 0 || targetSymbols.length > 0) {
      lines.push(`  targets: files=[${targetFiles.join(", ")}]${targetSymbols.length > 0 ? ` symbols=[${targetSymbols.join(", ")}]` : ""}`);
    }
    if (importHints) lines.push(`  imports: ${importHints}`);
    if (status === "FAIL") {
      const failure = _parseFailureJson(row.failure_json);
      const message = _compactEvidenceText(failure?.message || failure?.error || JSON.stringify(failure || {}));
      if (message) lines.push(`  failure: ${message}`);
    }
  }
  return `\n${lines.join("\n")}\n`;
}

function _registeredTestRunRowsForJob({ jobId, limit = 30, scopeFiles = [], db }) {
  if (!jobId || !db) return [];
  ensureRegisteredTestTables(db);
  if (!_dbTableExists(db, "posse_test_runs")) return [];
  if (!_dbTableExists(db, "posse_test_suites")) return [];
  if (!_dbTableExists(db, "posse_tests")) return [];
  const cap = Math.max(1, Math.min(80, Number(limit) || 30));
  const queryLimit = _normalizeEvidenceScopeFiles(scopeFiles).length > 0 ? Math.min(240, cap * 4) : cap;
  const rows = db.prepare(`
    SELECT
      r.id,
      r.ok,
      r.duration_ms,
      r.failure_json,
      r.created_by_role,
      r.created_at,
      s.id AS suite_id,
      s.name AS suite_name,
      s.slug AS suite_slug,
      t.id AS test_id,
      t.name AS test_name,
      t.slug AS test_slug,
      t.language AS language,
      t.target_files_json AS target_files_json,
      t.target_symbols_json AS target_symbols_json,
      t.target_imports_json AS target_imports_json
    FROM posse_test_runs r
    JOIN posse_test_suites s ON s.id = r.suite_id
    LEFT JOIN posse_tests t ON t.id = r.test_id
    WHERE r.created_by_job_id = ?
      AND COALESCE(r.created_by_role, 'dev') IN ('dev', 'fix', 'assessor_handoff')
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `).all(Number(jobId), queryLimit);
  const scopedRows = _normalizeEvidenceScopeFiles(scopeFiles).length > 0
    ? rows.filter((row) => _registeredTestTargetsOverlapScope(row, scopeFiles))
    : rows;
  return scopedRows.slice(0, cap);
}

function _failedRegisteredTestsNeedingHandoffRecheck({ jobId, limit = 30, scopeFiles = [], db }) {
  const rows = _registeredTestRunRowsForJob({ jobId, limit, scopeFiles, db });
  const latestByTest = new Map();
  for (const row of rows) {
    if (!row.test_id || latestByTest.has(row.test_id)) continue;
    latestByTest.set(row.test_id, row);
  }
  return [...latestByTest.values()]
    .filter((row) => Number(row.ok) === 0)
    .filter((row) => ["dev", "fix"].includes(String(row.created_by_role || "dev")))
    .slice(0, 10);
}

function _rerunFailedRegisteredTestsForAssessment({ job, cwd, scopeFiles = [], db }) {
  if (!job?.id || !db) return [];
  const failed = _failedRegisteredTestsNeedingHandoffRecheck({ jobId: job.id, scopeFiles, db });
  const results = [];
  for (const row of failed) {
    const result = runRegisteredTest({
      args: { test_id: row.test_id },
      cwd,
      scopeFiles,
      actor: {
        role: "assessor_handoff",
        jobId: job.id,
        workItemId: job.work_item_id,
      },
      db,
    });
    results.push({
      test_id: row.test_id,
      previous_run_id: row.id,
      rerun_id: result.run_id || null,
      ok: result.ok === true,
      summary: result.summary || "",
      failure: result.failure || null,
    });
  }
  return results;
}

export function __testBuildRegisteredTestRunEvidence({ jobId, limit = 20, scopeFiles = [], db = null } = {}) {
  if (!jobId) return "";
  let handle = db;
  try {
    handle = handle || getDb();
    const rows = _registeredTestRunRowsForJob({ jobId, limit, scopeFiles, db: handle });
    return _formatRegisteredTestRunEvidence(rows);
  } catch {
    return "";
  }
}

export function __testRerunFailedRegisteredTestsForAssessment(opts = {}) {
  return _rerunFailedRegisteredTestsForAssessment(opts);
}

function _buildLocalAssessmentEvidence({
  fileVerification = "",
  assessmentDiffNarrative = "",
  assessmentScopedDiff = "",
  assessmentFileSnapshots = "",
  registeredTestRunEvidence = "",
  workerStatusOutput = "",
} = {}) {
  const primaryChangeEvidence = assessmentScopedDiff
    || assessmentDiffNarrative
    || assessmentFileSnapshots;
  const evidenceBudgetChars = 60_000;
  const sections = [];
  let usedChars = 0;
  const appendWhole = (value, label) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (usedChars + text.length > evidenceBudgetChars) {
      sections.push(`[${label} omitted because the bounded assessment evidence packet is full]`);
      return;
    }
    sections.push(text);
    usedChars += text.length;
  };
  // Receipts and the primary change view are indivisible evidence. In
  // particular, never turn a complete diff into a misleading partial diff at
  // this final assembly boundary.
  appendWhole(registeredTestRunEvidence, "registered test evidence");
  appendWhole(primaryChangeEvidence, "primary change evidence");
  appendWhole(fileVerification, "scope verification evidence");
  if (workerStatusOutput && !registeredTestRunEvidence) {
    const prefix = "WORKER STATUS (context only; never proof):\n";
    const remaining = Math.max(0, evidenceBudgetChars - usedChars - prefix.length);
    if (remaining > 0) sections.push(`${prefix}${String(workerStatusOutput).slice(0, remaining)}`);
  }
  return [
    `LOCAL ASSESSMENT EVIDENCE`,
    `This block was attached by the local client after remote prompt compilation. Treat deterministic receipts and the single primary change view as ground truth. Worker status is context only, never proof.`,
    sections.join("\n") || null,
  ].filter(Boolean).join("\n");
}

function _formatLineNumberedFile(raw = "", startLine = 1) {
  return String(raw || "")
    .split("\n")
    .map((ln, i) => `${String(startLine + i).padStart(4)}\t${ln}`)
    .join("\n");
}

function _extractTaskLineRanges(taskSpec = "") {
  const ranges = [];
  for (const match of String(taskSpec || "").matchAll(/lines?\s+~?(\d+)\s*(?:[-–]\s*~?(\d+))?/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    ranges.push({
      start: Math.max(1, start - 20),
      end: Math.max(start, end + 20),
    });
  }
  return ranges.slice(0, 6);
}

function _mergeLineRanges(ranges = []) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const sorted = ranges
    .map((r) => ({ start: Math.max(1, Number(r.start) || 1), end: Math.max(1, Number(r.end) || 1) }))
    .sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 5) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function _buildAssessmentFileSnapshots({ cwd = null, assessmentContext = null, taskSpec = "" } = {}) {
  if (!cwd || !assessmentContext || typeof assessmentContext !== "object") return "";

  const committedPaths = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
  );
  // Changed files are the authoritative snapshot set. Fall back to scoped task
  // targets only when commit discovery was unavailable or empty.
  const candidatePaths = (committedPaths.length > 0
    ? committedPaths
    : _mergeUniquePaths(
        ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
      )).slice(0, 6);
  if (candidatePaths.length === 0) return "";

  const lineHints = _extractTaskLineRanges(taskSpec);
  const sections = [];
  const totalBudgetChars = 48_000;
  const perFileBudgetChars = 20_000;
  let usedChars = 0;
  const addSection = (section) => {
    const remaining = totalBudgetChars - usedChars;
    if (remaining <= 0) return false;
    const bounded = String(section || "").slice(0, Math.min(perFileBudgetChars, remaining));
    if (bounded) {
      sections.push(bounded);
      usedChars += bounded.length;
    }
    return usedChars < totalBudgetChars;
  };

  for (const relPath of candidatePaths) {
    const normalizedPath = _normalizeAssessmentScopePath(relPath, cwd);
    if (!normalizedPath) continue;
    const absPath = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(cwd, normalizedPath);
    let raw = "";
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      if (!addSection(`=== ${normalizedPath} === (file not found or unreadable during assessment preload)`)) break;
      continue;
    }

    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    // Prefer focused excerpts even for small files; whole-file snapshots are
    // resent after every agentic tool round-trip.
    const smart = buildSmartPreload(raw, taskSpec);
    if (smart && Array.isArray(smart.matched) && smart.matched.length > 0) {
      const parts = [`=== ${normalizedPath} (${smart.totalLines} lines) ===`];
      if (smart.imports && smart.imports.trim()) parts.push(`\nIMPORTS:\n${smart.imports}`);
      for (const fn of smart.matched) {
        parts.push(`\nFUNCTION: ${fn.name} [lines ${fn.startLine}-${fn.endLine}]\n${fn.content}`);
      }
      if (smart.toc && smart.toc.length > 0) {
        parts.push(`\nOTHER FUNCTIONS (read-only reference):`);
        for (const fn of smart.toc.slice(0, 20)) {
          parts.push(`  ${fn.name} [lines ${fn.startLine}-${fn.endLine}]`);
        }
      }
      if (!addSection(parts.join("\n"))) break;
      continue;
    }

    const mergedHints = _mergeLineRanges(lineHints.map((range) => ({
      start: range.start,
      end: Math.min(lines.length, range.end),
    })));
    if (mergedHints.length > 0) {
      const parts = [`=== ${normalizedPath} (${lines.length} lines, targeted excerpts) ===`];
      for (const range of mergedHints) {
        const excerpt = lines.slice(range.start - 1, range.end).join("\n");
        parts.push(`\nLINES ${range.start}-${range.end}:\n${_formatLineNumberedFile(excerpt, range.start)}`);
      }
      if (!addSection(parts.join("\n"))) break;
      continue;
    }

    const head = lines.slice(0, 120).join("\n");
    if (!addSection(`=== ${normalizedPath} (${lines.length} lines, head excerpt) ===\n${_formatLineNumberedFile(head)}`)) break;
  }

  return sections.length > 0
    ? `\nSCOPED FILE SNAPSHOTS (ground truth — use these to verify without re-reading when possible):\n${sections.join("\n\n")}\n`
    : "";
}

export function __testBuildAssessmentProviderScope(options) {
  return buildAssessmentProviderScope(options);
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
export async function assessResult(job, output, { silent = false, autoApprove = false, modelTier = "standard", reasoningEffort = "medium", cwd = null, routedProviderName = null, agentDispatcher = null, assessmentContext = null, abortSignal = null, fallbackReads = null, priorAssessmentFindings = "", trackedCall = null, disableAtlas = false, remoteComposer = null, taskBoundaryRetryDepth = 0, attemptId = null, allowMutatingRunners = false } = {}) {
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
  const verificationCapabilityBlock = _buildVerificationCapabilityBlock(visibleJobPayload);
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
    ? `\nSCOPED GIT DIFF (COMPLETE — do not re-derive via git):\n${assessmentContext.scoped_git_diff}\n`
    : "";
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
    : _buildAssessmentFileSnapshots({ cwd, assessmentContext, taskSpec });

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
      files_reverted = [],
      files_requested = [],
    } = assessmentContext;
    const sections = [];

    if (assessmentContext.task_ab_test_evidence) {
      sections.push(String(assessmentContext.task_ab_test_evidence));
    }

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

    if (files_committed.length > 0) {
      sections.push(`files_actually_committed: ${JSON.stringify(files_committed)}`);
      // Check for scope violations deterministically
      const outOfScope = _findOutOfScopeCommittedFiles(files_committed, {
        allowedFiles: allowed_files,
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
        `- If files_reverted is non-empty → the dev attempted out-of-scope edits that were ALREADY REVERTED by the system. Do NOT fail for this — it is informational only. Judge the task solely on whether the in-scope committed files satisfy the success criteria.`,
      ].filter(Boolean);
      if (files_requested.length > 0) {
        rules.push(`- files_requested_via_pipeline are LEGITIMATE — the system handles these via follow-up jobs. Do NOT treat as failures or incomplete work.`);
      }
      fileVerification = `\nFILE VERIFICATION DATA (from git — ground truth, not dev claims):\n${sections.join("\n")}\n\nScope rules:\n${rules.join("\n")}\n`;
    }
  }

  const deterministicScopeViolation = _buildCommittedScopeViolationVerdict(assessmentContext, cwd);
  if (deterministicScopeViolation) {
    return deterministicScopeViolation;
  }
  const disabledRequiredTestsViolation = _buildDisabledRequiredTestsVerdict({ assessmentContext, taskSpec });
  if (disabledRequiredTestsViolation) {
    return disabledRequiredTestsViolation;
  }

  const providerScope = buildAssessmentProviderScope({ cwd, assessmentContext });
  const registeredTestScopeFiles = _mergeUniquePaths(
    providerScope.scopedFiles,
    providerScope.createFiles,
    providerScope.deleteFiles,
  );

  let registeredTestRunEvidence = "";
  if (REGISTERED_TEST_AGENT_SURFACE_ENABLED) {
    try {
      const assessmentDb = getDb();
      if (allowMutatingRunners) {
        _rerunFailedRegisteredTestsForAssessment({ job, cwd, scopeFiles: registeredTestScopeFiles, db: assessmentDb });
      }
      registeredTestRunEvidence = __testBuildRegisteredTestRunEvidence({
        jobId: job.id,
        scopeFiles: registeredTestScopeFiles,
        db: assessmentDb,
      });
    } catch {
      registeredTestRunEvidence = "";
    }
  }

  // Resolve the assessor handoff packet before prompt composition. The packet
  // carries remote-prompt identity, stable scope/tool metadata, and ATLAS status.
  // It must not contain raw diff/snapshot evidence; that stays local and is
  // appended after remote compilation below.
  let atlasBlock = "";
  let assessorAtlasPrefetchStatus = null;
  let assessorPacket = null;
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
    if (!artifactAssessmentRoute) {
      atlasBlock = renderAtlasHandoffSections(assessorPacket) || "";
      assessorAtlasPrefetchStatus = assessorPacket?.atlas?.prefetchStatus || null;
    }
  } catch {
    atlasBlock = "";
    assessorAtlasPrefetchStatus = null;
  }

  const localAssessmentEvidence = _buildLocalAssessmentEvidence({
    fileVerification,
    assessmentDiffNarrative,
    assessmentScopedDiff,
    assessmentFileSnapshots,
    registeredTestRunEvidence,
    workerStatusOutput,
  });
  const prompt = [
    `Assess this completed task. Check the actual files, not just the dev's claims.`,
    `Use the deterministic scope and test receipts plus the single attached primary change view. If that bounded evidence cannot resolve a material criterion, use an issued read tool rather than requesting repository contents from the human.`,
    `If the bounded role result marks VERIFICATION_UNAVAILABLE, keep the completion status tied to product work. Treat the unavailable method as NOT_APPLICABLE when attached evidence or one obvious equivalent invocation establishes the criterion; it is not, by itself, a reason to block.`,
    Number.isFinite(Number(fallbackReads)) ? `Fallback read budget for this assessment attempt: ${Math.max(0, Number(fallbackReads))}.` : null,
    workflowModeBlock,
    verificationCapabilityBlock,
    atlasBlock || null,
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
    fallbackReads,
  });
  let providerPrompt = prompt;
  if (assessorPacket) {
    providerPrompt = await composePromptRemoteAware(
      assessorPacket,
      remoteAssessmentInstructions,
      {
        ...(remoteComposer ? { composer: remoteComposer } : {}),
        providerName: assessorProvider,
      },
    );
    if (assessorPacket.remote_prompt_composed) {
      providerPrompt = [providerPrompt, localAssessmentEvidence].filter(Boolean).join("\n\n");
    }
  }

  let response;
  let trustedAssessorEvidenceChars = null;
  let trustedAssessorClaims = [];
  const assessorMaxToolCalls = getAssessorMaxToolCalls();
  const assessorDeepthink = !!parseJobPayload(job).deepthink;
  const assessmentInputKey = crypto.createHash("sha256").update(JSON.stringify({
    version: 1,
    jobId: job.id,
    provider: assessorProvider,
    modelTier,
    reasoningEffort,
    fallbackReads: Number.isFinite(Number(fallbackReads)) ? Number(fallbackReads) : null,
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
    } catch {
      trustedAssessorEvidenceChars = null;
      trustedAssessorClaims = [];
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
    if (tokenBudget.exceeded || callBudget.exceeded) {
      const reason = callBudget.exceeded
        ? `Assessment call budget exhausted (${callBudget.used}/${callBudget.cap} calls) for this attempt.`
        : `Assessment input-token budget exhausted (${tokenBudget.spent}/${tokenBudget.cap} tokens) for this job.`;
      return {
        verdict: "needs_review",
        confidence: "none",
        reasons: [reason],
        spawn_jobs: [],
        human_questions: [],
        suggestions: [],
        raw: "",
        _disable_internal_retry: true,
      };
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
      fallbackReads,
      assessorMaxToolCalls,
      abortSignal,
      atlasPrefetchStatus: assessorPacket?.atlas?.prefetchStatus || assessorAtlasPrefetchStatus,
      disableAtlas: artifactAssessmentRoute,
      stableContext: assessorPacket?.stable_context || null,
      remoteSystemPrompt: assessorPacket?.remote_system_prompt || null,
      taskMode: parsedJobPayload.task_mode || "code",
      projectDbCapability: parsedJobPayload.task_mode === "db" ? "read" : "none",
      sessionPacket: assessorPacket || null,
      skipRolePrompt: !!assessorPacket?.remote_prompt_composed,
      deepthink: assessorDeepthink,
    }, {
      job_id: job.id,
      work_item_id: job.work_item_id,
      attempt_id: attemptId,
      cwd,
      jobProvider: assessorProvider,
      jobModelName: null,
    });
    response = result.output;
    if (Number.isInteger(result.agentCallId)) {
      const handoffRecord = getAgentHandoffRecord(result.agentCallId);
      const packet = handoffRecord?.packet;
      trustedAssessorEvidenceChars = packet?.profile === "assessor.verdict.v1"
        ? Math.max(0, Number(packet.evidence_chars) || 0)
        : 0;
      trustedAssessorClaims = packet?.profile === "assessor.verdict.v1"
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

  if (!reusableReview) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      artifact_type: "review",
      content_long: response,
      content_json: {
        assessment_input_key: assessmentInputKey,
        verdict_parse_succeeded: _isReusableAssessorVerdict(verdictJson, verdict),
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
  // No prose-recovery fallback: if JSON extraction failed we fall through to
  // the parse_error verdict below, which lets the worker re-run assessment at
  // a higher tier (cheap → standard → strong, see runAssessment loop). Prior
  // prose-regex recovery synthesized fake verdicts that masked parser failures
  // and prevented the tier-bump retry from firing.

  if (verdict) {
    const originalHumanQuestions = Array.isArray(verdict.human_questions) ? verdict.human_questions : [];
    const strippedRepoFileQuestions = originalHumanQuestions.filter((question) =>
      isRepoFileAccessQuestion(question, {
        context: [response, ...(Array.isArray(verdict.reasons) ? verdict.reasons : [])].join("\n"),
      })
    );
    const sanitizedHumanQuestions = sanitizeHumanQuestions(originalHumanQuestions, {
      context: [response, ...(Array.isArray(verdict.reasons) ? verdict.reasons : [])].join("\n"),
    });
    if (sanitizedHumanQuestions.length !== originalHumanQuestions.length) {
      verdict = {
        ...verdict,
        human_questions: sanitizedHumanQuestions,
      };
      const accessContext = [
        response,
        ...(Array.isArray(verdict.reasons) ? verdict.reasons : []),
        ...originalHumanQuestions,
      ].join("\n");
      if (
        sanitizedHumanQuestions.length === 0
        && (
          strippedRepoFileQuestions.length > 0
          || _looksLikeAssessorAccessLimitation(accessContext)
        )
      ) {
        const rawReasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
        verdict = {
          ...verdict,
          verdict: ["blocked", "needs_review"].includes(String(verdict.verdict || "").toLowerCase())
            ? "blocked"
            : verdict.verdict,
          reasons: [
            "Assessor asked the human for repository file contents or diffs that must be verified from local assessment context; sanitized the request and disabled internal assessment retry.",
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
    };
  }
  if (normalizedVerdict.verdict === "fail" && trustedAssessorEvidenceChars === 0) {
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
    };
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

function parsePorcelainZ(raw = "") {
  const parts = String(raw || "").split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const status = item.slice(0, 2);
    const filePath = item.slice(3);
    let oldPath = null;
    if ((status.includes("R") || status.includes("C")) && i + 1 < parts.length) {
      oldPath = parts[++i];
    }
    entries.push({ status, path: filePath, old_path: oldPath });
  }
  return entries;
}

function porcelainEntryKey(entry) {
  return `${entry.status}\0${entry.path || ""}\0${entry.old_path || ""}`;
}

function diffPorcelainEntries(beforeRaw, afterRaw) {
  const beforeKeys = new Set(parsePorcelainZ(beforeRaw).map(porcelainEntryKey));
  return parsePorcelainZ(afterRaw).filter((entry) => !beforeKeys.has(porcelainEntryKey(entry)));
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
  isAssessorParseRetryBudgetExceeded,
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
  const skipAssessForSatisfiedNoop = satisfiedNoop && !verifiedNoChange;
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
      setAssessmentLifecycle(job.id, "implementation_complete");
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
  }
  if (shouldRunAssessment && !skipAssessForFileRequest) {
    setAssessmentLifecycle(job.id, "implementation_complete");
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
    worker.emit(job.id, `${C.green}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: deterministic no-op pass`);
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
    const emitFn = (msg) => worker.emit(job.id, msg);
    const { action } = processVerdict(job, verdict, { emit: emitFn, autoApprove: worker.autoApprove, leaseToken });
    log.info("assessor", `Verdict: ${verdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: verdict.verdict, confidence: verdict.confidence, reasons: verdict.reasons });
    jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${verdict.verdict} (${verdict.confidence}) — ${passMsg.slice(0, 100)}` });
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      observation_type: "assessment.verdict",
      summary: `${verdict.verdict}: ${passMsg}`,
      detail: { verdict: verdict.verdict, confidence: verdict.confidence, reasons: verdict.reasons, action },
    });

    const freshJob = getJob(job.id);
    updateAssessmentLifecycleFromVerdict(job.id, freshJob, verdict);
    const finalStatus = freshJob?.status === "succeeded" ? "succeeded" : "failed";
    completeAttempt(attempt.id, {
      status: finalStatus,
      duration_ms: Date.now() - startTime,
      output_chars: output.length,
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
    worker.emit(job.id, `${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: assessing ${shortJobTitle(job).slice(0, 50)}`);
    syncAssessorWorkerDisplay(worker.display, job, {
      tier: "cheap",
      effort: job.reasoning_effort || "medium",
      attempt: attempt.attempt_number || job.attempt_count || 1,
    });

    let taskAbAssessmentEvidence = "";
    let deterministicTestRun = null;
    let assessorProvider = "";
    try {
      deterministicTestRun = await ensurePostChangeTestReceipt({
        job,
        payload: currentPayload,
        cwd: wtPath,
        commitHash: committedHash || branchNetDiff?.head || null,
        attemptId: attempt.id,
        cleanupWorktree: wtPath
          ? async () => snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `test-post-change-side-effects-wi-${job.work_item_id}-job-${job.id}`,
              branchName: getWorkItem(job.work_item_id)?.branch_name || null,
              wiId: job.work_item_id,
              onMsg: (message) => worker.emit(job.id, `${C.dim}[assessor-test] ${message}${C.reset}`),
            })
          : null,
      });
    } catch (testError) {
      const testInfraMsg = `Deterministic post-change test execution failed to initialize: ${testError?.message || testError}`;
      completeAttempt(attempt.id, {
        status: "succeeded",
        duration_ms: Date.now() - startTime,
        error_text: testInfraMsg,
      });
      setJobError(job.id, testInfraMsg);
      routeAssessmentInfrastructureFailure(worker, job, leaseToken, testError, {
        pendingFileRequests,
      });
      return;
    }
    if (deterministicTestRun?.post_change) {
      const postReceipt = deterministicTestRun.post_change;
      const source = postReceipt.source || "planner";
      worker.emit(
        job.id,
        `${postReceipt.status === "passed" ? C.green : postReceipt.status === "failed" ? C.red : C.yellow}[assessor-test] ${postReceipt.reused ? "Reused" : "Ran"} frozen command: ${postReceipt.status}${C.reset}`,
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
      taskAbAssessmentEvidence = renderTestExecutionEvidence(deterministicTestRun);
      if (["infrastructure_error", "unavailable"].includes(postReceipt.status)) {
        const testInfraMsg = `Deterministic post-change test execution unavailable: ${postReceipt.reason || postReceipt.status}`;
        completeAttempt(attempt.id, {
          status: "succeeded",
          duration_ms: Date.now() - startTime,
          error_text: testInfraMsg,
        });
        setJobError(job.id, testInfraMsg);
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, new Error(testInfraMsg), {
          pendingFileRequests,
        });
        return;
      }
    }

    const preAssessCmd = readSettingText("pre_assess_cmd") || null;
    const hooksSkipped = readSettingBool("skip_hooks", false) || readSettingBool("skip_hook_post_dev_verify", false);
    if (shouldRunPreAssessCommand({
      command: preAssessCmd,
      wtPath,
      preAssessAlreadyVerified,
      hooksSkipped,
    })) {
      try {
        worker.emit(job.id, `${C.dim}[pre-assess] Running: ${preAssessCmd}${C.reset}`);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "command.pre_assess",
          summary: "Running pre-assess command",
          detail: { command: preAssessCmd, cwd: wtPath, source: "setting" },
        });
        const preAssessBeforePorcelain = await gitPorcelainZAsync(wtPath);
        await runShellCommandAsync(preAssessCmd, { cwd: wtPath, timeoutMs: 120000 });
        const preAssessAfterPorcelain = await gitPorcelainZAsync(wtPath);
        const dirtyEntries = diffPorcelainEntries(preAssessBeforePorcelain, preAssessAfterPorcelain);
        if (dirtyEntries.length > 0 || preAssessAfterPorcelain !== preAssessBeforePorcelain) {
          const dirtyPaths = dirtyEntries.map((entry) => entry.path).filter(Boolean);
          const preview = dirtyPaths.slice(0, 10).join(", ");
          const more = dirtyPaths.length > 10 ? " ..." : "";
          const hookMsg = `Pre-assessment hook left worktree dirty${preview ? `: ${preview}${more}` : ""}`;
          let snapshotDir = null;
          let snapshotError = null;
          try {
            const wiForHook = getWorkItem(job.work_item_id);
            snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `pre-assess-dirty-wi-${job.work_item_id}-job-${job.id}`,
              branchName: wiForHook?.branch_name || null,
              wiId: job.work_item_id,
              onMsg: (msg) => worker.emit(job.id, `${C.dim}[pre-assess] ${msg}${C.reset}`),
            });
          } catch (snapshotErr) {
            snapshotError = snapshotErr?.message || String(snapshotErr);
          }
          worker.emit(job.id, `${C.yellow}[pre-assess] ${hookMsg}${snapshotDir ? ` (snapshot: ${snapshotDir})` : ""}${C.reset}`);
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.WORKTREE_PRE_ASSESS_DIRTY,
            actor_type: EVENT_ACTORS.WORKER,
            message: hookMsg,
            event_json: JSON.stringify({
              command: preAssessCmd,
              cwd: wtPath,
              changed_paths: dirtyPaths.slice(0, 100),
              changed_entries: dirtyEntries.slice(0, 100),
              before_entries: parsePorcelainZ(preAssessBeforePorcelain).slice(0, 100),
              after_entries: parsePorcelainZ(preAssessAfterPorcelain).slice(0, 100),
              snapshot_dir: snapshotDir,
              snapshot_error: snapshotError,
            }),
          });
          recordObservation({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            observation_type: "command.pre_assess",
            summary: hookMsg,
            detail: {
              command: preAssessCmd,
              cwd: wtPath,
              status: "dirty",
              changed_paths: dirtyPaths,
              snapshot_dir: snapshotDir,
              snapshot_error: snapshotError,
            },
          });
          completeAttempt(attempt.id, {
            status: "succeeded",
            duration_ms: Date.now() - startTime,
            error_text: hookMsg,
          });
          setJobError(job.id, hookMsg);
          routeAssessmentInfrastructureFailure(worker, job, leaseToken, new Error(hookMsg), {
            pendingFileRequests,
          });
          return;
        }
        worker.emit(job.id, `${C.green}[pre-assess] Passed${C.reset}`);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "command.pre_assess",
          summary: "Pre-assess command passed",
          detail: {
            command: preAssessCmd,
            cwd: wtPath,
            status: "passed",
            source: "setting",
          },
        });
      } catch (hookErr) {
        const hookMsg = `Pre-assessment hook failed: ${hookErr.message.split("\n")[0]}`;
        worker.emit(job.id, `${C.red}[pre-assess] ${hookMsg}${C.reset}`);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "command.pre_assess",
          summary: hookMsg,
          detail: {
            command: preAssessCmd,
            cwd: wtPath,
            status: "failed",
            source: "setting",
          },
        });
        completeAttempt(attempt.id, {
          status: "succeeded",
          duration_ms: Date.now() - startTime,
          error_text: hookMsg,
        });
        setJobError(job.id, hookMsg);
        routeAssessmentInfrastructureFailure(worker, job, leaseToken, hookErr, {
          pendingFileRequests,
        });
        return;
      }
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
          worker._retryOrFail(job, leaseToken, emptyMsg);
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

      const deterministicArtifactPass = shouldFastPassArtifactAssessment({
        taskMode,
        manifest,
        contractViolations,
        outputRoot: jobPayloadForAssess.output_root || null,
        expectedFiles: jobPayloadForAssess.files_to_create || [],
      });

      if (deterministicArtifactPass) {
        const passMsg = `Artifact manifest verified ${manifest.count} file(s) and all expected deliverables under ${jobPayloadForAssess.output_root}`;
        worker.emit(job.id, `${C.green}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: deterministic artifact pass`);
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
        const emitFn = (msg) => worker.emit(job.id, msg);
        const { action } = processVerdict(job, verdict, { emit: emitFn, autoApprove: worker.autoApprove, leaseToken });
        log.info("assessor", `Verdict: ${verdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: verdict.verdict, confidence: verdict.confidence, reasons: verdict.reasons });
        jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${verdict.verdict} (${verdict.confidence}) — ${passMsg.slice(0, 100)}` });
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "assessment.verdict",
          summary: `${verdict.verdict}: ${passMsg}`,
          detail: { verdict: verdict.verdict, confidence: verdict.confidence, reasons: verdict.reasons, action },
        });

        const freshJob = getJob(job.id);
        updateAssessmentLifecycleFromVerdict(job.id, freshJob, verdict);
        const finalStatus = freshJob?.status === "succeeded" ? "succeeded" : "failed";
        completeAttempt(attempt.id, {
          status: finalStatus,
          duration_ms: Date.now() - startTime,
          output_chars: output.length,
        });
        if (freshJob?.status === "succeeded" && hasPendingFileRequests() && !spawnedFileRequestFollowUp) {
          spawnPendingFileRequestsOnce();
        }
        refreshAndExtractInsights(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
        return;
      }

      const jobAc = worker._abortControllers.get(job.id);
      assessorProvider = String(
        await worker.agentDispatcher?.selectProvider?.({ role: "assessor", providerName: harnessAssessorProvider() })
        || "",
      ).trim().toLowerCase();
      if (!assessorProvider) {
        const routeError = new Error("Assessment requires an assessor Provider route from the AgentDispatcher");
        routeError.code = "POSSE_AGENT_PROVIDER_ROUTE_REQUIRED";
        throw routeError;
      }
      const assessmentContext = await attachAssessmentDiffContextAsync({
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
        files_reverted: filesReverted,
        files_requested: pendingFileRequests
          ? [...(pendingFileRequests.autoApproved || []), ...(pendingFileRequests.needsApproval || [])]
          : [],
      }, (isArtifactMode(taskMode) && jobPayloadForAssess.output_root)
        ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
        : (wtPath || worker.projectDir));
      if (taskAbAssessmentEvidence) {
        assessmentContext.task_ab_test_evidence = taskAbAssessmentEvidence;
      }
      const assessOpts = {
        silent: worker.silent,
        autoApprove: worker.autoApprove,
        agentDispatcher: worker.agentDispatcher,
        routedProviderName: assessorProvider,
        abortSignal: jobAc?.signal || null,
        cwd: (isArtifactMode(taskMode) && jobPayloadForAssess.output_root)
          ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
          : (wtPath || worker.projectDir),
        assessmentContext,
        attemptId: attempt.id,
        allowMutatingRunners: !!wtPath,
      };
      const rawTrackedCall = getWorkerProviderCall(worker);
      const assessmentCwd = assessOpts.cwd;
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
      const assessmentTierOrder = ["cheap", "standard", "strong"];
      const normalizeAssessmentTier = (value, fallback = "cheap") => {
        const raw = String(value || "").trim().toLowerCase();
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
      const initialAssessmentTier = harnessAssessmentTier || jobPayloadForAssess.deepthink === true
        ? requestedAssessmentTier
        : requestedAssessmentTier === "strong" ? "standard" : requestedAssessmentTier;
      if (requestedAssessmentTier === "strong" && initialAssessmentTier === "standard") {
        worker.emit(job.id, `${C.yellow}[assessor] planner requested strong initial assessment; capped at standard and reserved strong for escalation${C.reset}`);
      }
      let lastAssessmentTier = initialAssessmentTier;
      let verdict = await assessResult(job, output, {
        ...assessOpts,
        modelTier: initialAssessmentTier,
        reasoningEffort: assessmentReasoningEffort,
        fallbackReads: assessmentRetryFallbackReads(initialAssessmentTier, 0),
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
          const budget = isAssessorParseRetryBudgetExceeded(job.id);
          const callBudget = assessorCallBudgetStatus(job.id, attempt.id);
          if (budget.exceeded || callBudget.exceeded) {
            const message = callBudget.exceeded
              ? `Assessment retry call budget exhausted (${callBudget.used}/${callBudget.cap} calls) before ${retryTier}-tier retry`
              : `Assessment retry token budget exceeded (${budget.spent}/${budget.cap} input tokens) before ${retryTier}-tier retry`;
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
              fallbackReads: assessmentRetryFallbackReads(retryTier, 1),
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
          const budget = isAssessorParseRetryBudgetExceeded(job.id);
          const callBudget = assessorCallBudgetStatus(job.id, attempt.id);
          if (budget.exceeded || callBudget.exceeded) {
            const message = callBudget.exceeded
              ? `Assessment retry call budget exhausted (${callBudget.used}/${callBudget.cap} calls) before ${retryTier}-tier retry`
              : `Assessment retry token budget exceeded (${budget.spent}/${budget.cap} input tokens) before ${retryTier}-tier retry`;
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
            fallbackReads: assessmentRetryFallbackReads(retryTier, 2),
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

      const emitFn = (msg) => worker.emit(job.id, msg);
      const { action } = processVerdict(job, verdict, { emit: emitFn, autoApprove: worker.autoApprove, leaseToken });
      log.info("assessor", `Verdict: ${verdict.verdict}`, { jobId: job.id, wiId: job.work_item_id, verdict: verdict.verdict, confidence: verdict.confidence, reasons: verdict.reasons?.slice(0, 3) });
      jobLog("ASSESSED", { wi: job.work_item_id, job: job.id, detail: `${verdict.verdict} (${verdict.confidence || "?"})${verdict.reasons?.length ? ` — ${verdict.reasons[0].slice(0, 100)}` : ""}` });

      recordObservation({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt.id,
        observation_type: "assessment.verdict",
        summary: `${verdict.verdict} (${verdict.confidence || "?"})`,
        detail: { reasons: verdict.reasons || [], spawn_jobs: verdict.spawn_jobs || [] },
      });
      const freshJob = getJob(job.id);
      updateAssessmentLifecycleFromVerdict(job.id, freshJob, verdict);
      if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
        worker._releaseLease(job, leaseToken, freshJob.status);
      }
      const ATTEMPT_STATUS_MAP = { succeeded: "succeeded", failed: "failed", queued: "interrupted", waiting_on_review: "interrupted", waiting_on_human: "interrupted", blocked: "blocked" };
      const finalStatus = ATTEMPT_STATUS_MAP[freshJob?.status] || "failed";
      completeAttempt(attempt.id, {
        status: finalStatus,
        duration_ms: Date.now() - startTime,
        output_chars: output.length,
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
      if (isProviderError(assessErr) || assessErr?.assessmentRetryable || turnBudgetExhausted || stallKilled || terminalHandoffMissing) {
        const retryLabel = assessErr?.assessmentRetryable
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
          error_text: assessErr?.assessmentRetryable
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
          event_type: assessErr?.assessmentRetryable
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
          : assessErr?.assessmentRetryable
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
  log.info("worker", `Job done (no assessment): ${job.job_type} #${job.id}`, { jobId: job.id, wiId: job.work_item_id, type: job.job_type, durationMs: Date.now() - startTime });
  jobLog("DONE", { wi: job.work_item_id, job: job.id, detail: `${job.job_type} succeeded in ${((Date.now() - startTime) / 1000).toFixed(0)}s (no assessment)` });
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
