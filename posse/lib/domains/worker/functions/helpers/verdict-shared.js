// lib/domains/worker/functions/helpers/verdict-shared.js
//
// Shared helpers for assessor verdict handlers.

import path from "path";
import { INFERRED_SCOPE_BARE_EXTENSIONS } from "../../../../catalog/files.js";
import { inferGeneratedArtifactDeletionTargets } from "../../../../shared/scope/classes/MutationPolicy.js";
import { TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import {
  applyDelegation,
  getAttempts,
  getDependents,
  getEventsByWorkItem,
  getJob,
  getWorkItem,
  listJobsByWorkItem,
  logEvent,
  runInTransaction,
  updateJobPayload,
  updateJobStatus,
  updateWorkItemMetadata,
} from "../../../queue/functions/index.js";
import { parseJobPayload, parseJsonObject } from "../../../queue/functions/payload.js";
import { artifactsDir, isArtifactMode, wiScopeId } from "../../../artifacts/functions/index.js";
import { sanitizeHumanQuestions } from "./human-question-classifier.js";
import { listUnresolvedActionableFailures } from "../../../queue/functions/failure-actionability.js";
import {
  countInternalAssessmentRetries,
  getAssessmentInternalRetryLimit,
} from "./assessment-shared.js";
import { validateScopedPath } from "../../../../shared/scope/functions/validation.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { assertTestContext } from "../../../runtime/functions/test-context.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const ASSESSMENT_RETRY_TIER_ORDER = ["cheap", "standard", "strong"];
const ASSESSOR_CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);
const ASSESSOR_CONFIDENCE_RANK = Object.freeze({ none: -1, low: 0, medium: 1, high: 2 });
const OUTPUT_CONTRACT_WI_MODES = new Set(["image", "report", "question"]);
const OUTPUT_CONTRACT_JOB_TYPES = new Set(["dev", "fix", "promote", "artificer"]);
const VALID_OUTPUT_SOURCES = new Set(["explicit", "inferred"]);

export function normalizeAssessorConfidence(value, { fallback = "medium", allowNone = true } = {}) {
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (allowNone && ["none", "null", "n/a", "na", "unknown", "no confidence"].includes(raw)) {
    return null;
  }
  if (ASSESSOR_CONFIDENCE_VALUES.has(raw)) return raw;
  if (["moderate", "med", "mid", "middle"].includes(raw)) return "medium";
  if (["very high", "strong", "certain", "confident"].includes(raw)) return "high";
  if (["very low", "weak", "uncertain", "not confident"].includes(raw)) return "low";

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const normalized = numeric > 1 ? numeric / 100 : numeric;
    if (normalized >= 0.67) return "high";
    if (normalized <= 0.33) return "low";
    return "medium";
  }

  return fallback;
}

function _nextAssessmentRetryTier(currentTier) {
  const current = String(currentTier || "standard");
  const idx = ASSESSMENT_RETRY_TIER_ORDER.indexOf(current);
  if (idx < 0) return current;
  return ASSESSMENT_RETRY_TIER_ORDER[Math.min(idx + 1, ASSESSMENT_RETRY_TIER_ORDER.length - 1)];
}

function _logBadInput(job, verdict, classification, detail) {
  if (!job) return;
  const summary = `assessor <= assessor_output [${classification}]${detail ? `  ${detail}` : ""}`;
  jobLog("BAD_INPUT", {
    wi: job.work_item_id,
    job: job.id,
    detail: summary.slice(0, 220),
  });
  log.warn("bad_input", summary, {
    jobId: job.id,
    wiId: job.work_item_id,
    classification,
    detail,
    snippet: verdict?.raw ? String(verdict.raw).slice(0, 500) : undefined,
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_BAD_INPUT,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: summary,
    event_json: JSON.stringify({
      layer: "assessor",
      upstream: "assessor_output",
      classification,
      detail,
      snippet: verdict?.raw ? String(verdict.raw).slice(0, 500) : "",
    }),
  });
}

function _looksLikeCodeOrFrontendPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return [".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".php", ".json"].some((ext) => lower.endsWith(ext));
}

function _isLikelyArtifactRouteMismatch(job, verdict) {
  if (!job || verdict?.verdict !== "fail") return false;

  let payload = {};
  let workItem = null;
  let intakeHints = {};
  payload = parseJobPayload(job);
  try {
    workItem = getWorkItem(job.work_item_id);
    const metadata = parseJsonObject(workItem?.metadata_json);
    intakeHints = metadata.intake_hints || {};
  } catch {}

  if (payload.task_mode !== "image" || !payload.needs_image_generation) return false;

  const reasonsText = (verdict.reasons || []).join(" ").toLowerCase();
  const hasImageContractFailure =
    reasonsText.includes("image mode") ||
    reasonsText.includes("image artifact") ||
    reasonsText.includes("allowed formats [.png") ||
    reasonsText.includes("disallowed formats");
  if (!hasImageContractFailure) return false;

  const scopedFiles = [
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
  ];
  const hasCodeLikeOutputs = scopedFiles.some(_looksLikeCodeOrFrontendPath);
  const specText = String(payload.task_spec || "").toLowerCase();
  const specLooksLikeFrontend =
    /\b(html|css|javascript|frontend|landing page|signup page|login page|api client|stylesheet)\b/.test(specText);
  const hintedCodeDeliverable =
    intakeHints.deliverable_type === "code" ||
    intakeHints.output_mode === "repo";

  return hasCodeLikeOutputs || specLooksLikeFrontend || hintedCodeDeliverable;
}

function _getDesiredOutputs(workItem) {
  return _getDesiredOutputBinding(workItem).desiredOutputs;
}

function _workItemMode(workItem, metadata = null) {
  const mode = String(metadata?.mode || workItem?.mode || "").trim().toLowerCase();
  return mode || "build";
}

function _getDesiredOutputBinding(workItem) {
  try {
    const metadata = workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
    const hints = metadata?.intake_hints && typeof metadata.intake_hints === "object" ? metadata.intake_hints : {};
    const desiredOutputs = Array.isArray(hints.desired_outputs)
      ? hints.desired_outputs.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [];
    const rawSource = String(hints.desired_outputs_source || "").trim().toLowerCase();
    const source = VALID_OUTPUT_SOURCES.has(rawSource)
      ? rawSource
      : (rawSource ? "inferred" : "legacy");
    return {
      desiredOutputs,
      source,
      metadata,
      hints,
      workItemMode: _workItemMode(workItem, metadata),
    };
  } catch {
    return { desiredOutputs: [], source: "inferred", metadata: {}, hints: {}, workItemMode: "build" };
  }
}

function _jobSatisfiesDesiredOutput(job, output, payload = null, workItem = null) {
  if (!job || job.status !== "succeeded") return false;
  const parsedPayload = payload || parseJobPayload(job);
  const taskMode = parsedPayload.task_mode || "code";
  let metadataMode = "";
  try {
    const metadata = parseJsonObject(workItem?.metadata_json);
    metadataMode = String(metadata?.mode || "").trim().toLowerCase();
  } catch {
    metadataMode = "";
  }
  const workItemMode = String(metadataMode || workItem?.mode || "").trim().toLowerCase();
  switch (output) {
    case "repo":
      return job.job_type === "promote" || ((job.job_type === "dev" || job.job_type === "fix") && taskMode === "code");
    case "artifact":
      return job.job_type === "artificer" && taskMode !== "code";
    case "question_only":
      return job.job_type === "human_input"
        || ((job.job_type === "research" || job.job_type === "summarize") && workItemMode === "question");
    default:
      return false;
  }
}

function _planShapeIsTerminalCodeOnly(jobs = []) {
  const outputJobs = (Array.isArray(jobs) ? jobs : [])
    .filter((candidate) => OUTPUT_CONTRACT_JOB_TYPES.has(candidate?.job_type));
  if (outputJobs.length === 0) return false;
  if (outputJobs.some((candidate) => candidate.job_type === "artificer" || candidate.job_type === "promote")) return false;
  return outputJobs.every((candidate) => {
    const payload = parseJobPayload(candidate);
    const taskMode = String(payload.task_mode || "code").trim().toLowerCase();
    return (candidate.job_type === "dev" || candidate.job_type === "fix") && taskMode === "code";
  });
}

function _correctInferredDesiredOutputsToRepo(workItem, binding, missing = []) {
  if (!workItem?.id || !binding?.metadata || !binding?.hints) return false;
  try {
    const nextMetadata = {
      ...binding.metadata,
      intake_hints: {
        ...binding.hints,
        desired_outputs: ["repo"],
        desired_outputs_source: "inferred",
        needs_review: true,
        review_reason: "inferred_desired_outputs_impossible_for_code_plan",
        previous_desired_outputs: binding.desiredOutputs,
      },
    };
    updateWorkItemMetadata(workItem.id, nextMetadata);
    logEvent({
      work_item_id: workItem.id,
      event_type: EVENT_TYPES.WORK_ITEM_INTAKE_HINTS_CORRECTED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Corrected inferred desired_outputs from [${binding.desiredOutputs.join(", ")}] to [repo]`,
      event_json: JSON.stringify({
        previous_desired_outputs: binding.desiredOutputs,
        desired_outputs: ["repo"],
        missing,
        reason: "inferred_output_contract_impossible_for_terminal_code_plan",
      }),
    });
    return true;
  } catch (err) {
    log.warn("assessor", "Failed to correct inferred desired_outputs metadata", {
      workItemId: workItem.id,
      error: err?.message || String(err),
    });
    return false;
  }
}

function _shouldReplanForDesiredOutputs(job, verdict) {
  if (!job || verdict?.verdict !== "pass") return null;
  const workItem = getWorkItem(job.work_item_id);
  const binding = _getDesiredOutputBinding(workItem);
  const desiredOutputs = binding.desiredOutputs;
  if (desiredOutputs.length === 0) return null;

  const jobs = listJobsByWorkItem(job.work_item_id);
  const terminal = new Set(TERMINAL_JOB_STATUSES);
  const liveDependents = getDependents(job.id)
    .map((dep) => getJob(dep.job_id))
    .filter((depJob) => depJob && !terminal.has(depJob.status));
  if (liveDependents.length > 0) return null;

  const otherActiveJobs = jobs.filter((candidate) => candidate.id !== job.id && !terminal.has(candidate.status));
  if (otherActiveJobs.length > 0) return null;

  const currentPayload = parseJobPayload(job);
  const satisfied = new Set();
  for (const candidate of jobs) {
    if (candidate.id === job.id) {
      const synthetic = { ...candidate, status: "succeeded" };
      for (const output of desiredOutputs) {
        if (_jobSatisfiesDesiredOutput(synthetic, output, currentPayload, workItem)) satisfied.add(output);
      }
      continue;
    }
    for (const output of desiredOutputs) {
      if (_jobSatisfiesDesiredOutput(candidate, output, null, workItem)) satisfied.add(output);
    }
  }
  const missing = desiredOutputs.filter((output) => !satisfied.has(output));
  if (missing.length === 0) return null;
  const hardEnforced = binding.source === "explicit"
    || binding.source === "legacy"
    || OUTPUT_CONTRACT_WI_MODES.has(binding.workItemMode);
  if (!hardEnforced) {
    if (binding.source === "inferred" && missing.includes("artifact") && _planShapeIsTerminalCodeOnly(jobs)) {
      return {
        action: "metadata_correction_review",
        desiredOutputs,
        missing,
        currentPayload,
        source: binding.source,
        corrected: _correctInferredDesiredOutputsToRepo(workItem, binding, missing),
      };
    }
    return null;
  }

  return {
    action: "replan",
    desiredOutputs,
    missing,
    currentPayload,
    source: binding.source,
  };
}

export function prepareVerdictForDispatch(job, verdict) {
  const workItem = getWorkItem(job.work_item_id);
  const desiredOutputs = _getDesiredOutputs(workItem);
  const payload = parseJobPayload(job);
  let prepared = {
    ...verdict,
    human_questions: sanitizeHumanQuestions(verdict?.human_questions, {
      context: [verdict?.raw, ...(Array.isArray(verdict?.reasons) ? verdict.reasons : [])].join("\n"),
    }),
  };

  if (_isLikelyArtifactRouteMismatch(job, prepared)) {
    prepared = {
      ...prepared,
      verdict: "needs_review",
      reasons: [
        "Likely route mismatch: this task was enforced as image artifact mode, but the scoped outputs and task spec look like repo/frontend code deliverables.",
        ...(prepared.reasons || []),
      ],
      human_questions: [
        `Job #${job.id} ("${job.title}") was assessed under image artifact rules, but it appears to be a code/frontend task. Should this be re-routed and replanned instead of fixed as an image artifact? (pass / fail / replan / retry)`,
      ],
    };
  }

  const outputGap = _shouldReplanForDesiredOutputs(job, prepared);
  if (outputGap?.action === "metadata_correction_review") {
    prepared = {
      ...prepared,
      verdict: "needs_review",
      _disable_internal_retry: true,
      reasons: [
        `Corrected inferred terminal output hint: desired_outputs [${outputGap.desiredOutputs.join(", ")}] could not be satisfied by the compiled code-only plan, so the work item was reclassified toward repo output instead of replanning for a manufactured artifact.`,
        ...(prepared.reasons || []),
      ],
      human_questions: [
        `Job #${job.id} ("${job.title}") passed, but an inferred artifact output hint did not match the code-only plan. I corrected desired_outputs to repo. Should this stand as passed, or should the work item be replanned? (pass / replan / fail / retry)`,
      ],
    };
  } else if (outputGap) {
    prepared = {
      ...prepared,
      verdict: "needs_replan",
      reasons: [
        `Intermediate output only: work item still requires terminal output(s) [${outputGap.missing.join(", ")}].`,
        ...(prepared.reasons || []),
      ],
    };
  }

  const passConfidenceFloor = normalizeAssessorConfidence(payload?._assess_pass_confidence_floor, {
    fallback: null,
    allowNone: true,
  });
  if (prepared.verdict === "pass" && passConfidenceFloor) {
    const confidence = normalizeAssessorConfidence(prepared.confidence, { fallback: "medium", allowNone: true }) || "none";
    if ((ASSESSOR_CONFIDENCE_RANK[confidence] ?? -1) < ASSESSOR_CONFIDENCE_RANK[passConfidenceFloor]) {
      prepared = {
        ...prepared,
        verdict: "needs_review",
        confidence,
        _disable_internal_retry: true,
        reasons: [
          `Deterministic assessment policy requires ${passConfidenceFloor} confidence to pass this risk profile; assessor returned ${confidence}.`,
          ...(prepared.reasons || []),
        ],
      };
    }
  }

  return { verdict: prepared, desiredOutputs };
}

function _buildIntermediateReportPayload(job, desiredOutputs = []) {
  const artifactRoot = `${artifactsDir(wiScopeId(job.work_item_id)).replace(/\\/g, "/").replace(/\/+$/, "")}/task-${job.id}-replan-report`;
  const reportPath = `${artifactRoot}/report.md`;
  return {
    task_spec: [
      `Investigate and document intermediate evidence for "${job.title}".`,
      `Write a markdown report at ${reportPath} with commands run, observations, blockers, and any evidence that should feed the next plan.`,
      `This is not terminal completion. The work item still requires: ${desiredOutputs.join(", ")}.`,
    ].join("\n"),
    task_mode: "report",
    output_root: artifactRoot,
    files_to_modify: [],
    files_to_create: [reportPath],
    files_to_delete: [],
    create_roots: [artifactRoot],
    success_criteria: [
      "A markdown report is written with concrete evidence from the attempted verification step",
      "The report captures blockers, commands, and observations for the next planner pass",
    ],
    _planner_set_files: true,
  };
}


function _mergeFixEditableScope(existingFiles = [], createFiles = []) {
  return [...new Set([
    ...(Array.isArray(existingFiles) ? existingFiles : []),
    ...(Array.isArray(createFiles) ? createFiles : []),
  ].filter(Boolean))];
}

function _mergeUniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))];
}

function _normalizeFixTitle(title = "") {
  const raw = String(title || "").trim().replace(/^(fix:\s*)+/i, "");
  return raw ? `Fix: ${raw}` : "Fix";
}

function _artifactOutputNameForDest(dest, basenameCounts, usedNames) {
  const normalized = String(dest || "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  const dirname = path.posix.dirname(normalized);
  let candidate = basename;
  if ((basenameCounts.get(basename) || 0) > 1) {
    const prefix = String(dirname === "." ? "root" : dirname)
      .replace(/[^a-zA-Z0-9._-]+/g, "__")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      || "root";
    candidate = `${prefix}__${basename}`;
  }

  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  const ext = path.posix.extname(candidate);
  const stem = ext ? candidate.slice(0, -ext.length) : candidate;
  let suffix = 2;
  while (usedNames.has(`${stem}-${suffix}${ext}`)) suffix++;
  candidate = `${stem}-${suffix}${ext}`;
  usedNames.add(candidate);
  return candidate;
}

function _looksLikeStructuredDataRepoTransformRecovery({
  job = null,
  originalFiles = [],
  originalCreateFiles = [],
  taskSpec = "",
  fixInstructions = "",
  assessorFeedback = [],
} = {}) {
  if (!job || (job.job_type !== "dev" && job.job_type !== "fix")) return false;
  if (!Array.isArray(originalFiles) || originalFiles.length === 0) return false;
  if (Array.isArray(originalCreateFiles) && originalCreateFiles.length > 0) return false;

  const structuredExts = new Set([".json", ".csv", ".tsv", ".txt"]);
  const allStructured = originalFiles.every((file) => structuredExts.has(path.posix.extname(String(file || "").replace(/\\/g, "/")).toLowerCase()));
  if (!allStructured) return false;

  const text = [
    job.title || "",
    taskSpec || "",
    fixInstructions || "",
    ...(Array.isArray(assessorFeedback) ? assessorFeedback : []),
  ].join("\n").toLowerCase();

  const transformVerb = /\b(regenerate|reformat|transform|normalize|merge|compile|synthesize|consolidate|reshape|rewrite|refresh|backfill)\b/.test(text);
  const dataNoun = /\b(data|dataset|json|csv|records?|entries|rows|contacts?|offices?|officials?)\b/.test(text);
  const codeIntent = /\b(function|class|api|endpoint|schema|frontend|html|css|javascript|sql|migration|test file|unit test|integration test)\b/.test(text);
  return transformVerb && dataNoun && !codeIntent;
}

function _buildStructuredDataArtifactFixPlan(job, {
  title = "",
  fixInstructions = "",
  assessorFeedback = [],
  originalFiles = [],
  originalCreateRoots = [],
  originalSuccessCriteria = [],
} = {}) {
  const artifactRoot = artifactsDir(wiScopeId(job.work_item_id)).replace(/\\/g, "/");
  const normalizedFiles = originalFiles.map((dest) => String(dest || "").replace(/\\/g, "/")).filter(Boolean);
  const basenameCounts = new Map();
  for (const dest of normalizedFiles) {
    const basename = path.posix.basename(dest);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }
  const usedOutputNames = new Set();
  const outputs = normalizedFiles.map((dest) => {
    const artifactName = _artifactOutputNameForDest(dest, basenameCounts, usedOutputNames);
    return {
      dest,
      artifactName,
      outputFile: path.posix.join(artifactRoot, artifactName),
    };
  });
  const outputFiles = outputs.map((output) => output.outputFile);
  const mappings = outputs.map(({ artifactName, dest }) => ({
    pattern: artifactName,
    dest,
    destination_type: "file",
  }));

  return {
    artifactTitle: _normalizeFixTitle(title || job.title),
    artifactPayload: {
      original_job_id: job.id,
      original_title: job.title,
      task_spec: [
        fixInstructions || assessorFeedback.join("\n") || `Repair ${job.title}`,
        "",
        "This is a structured-data transform task. Produce the corrected dataset as artifact output, then let the deterministic promote step copy it into the repo.",
        "Write these output files exactly:",
        ...outputFiles.map((file) => `- ${file}`),
      ].filter(Boolean).join("\n"),
      assessor_feedback: assessorFeedback,
      task_mode: "content",
      output_root: artifactRoot,
      files_to_modify: [],
      files_to_create: outputFiles,
      files_to_delete: [],
      create_roots: _mergeUniquePaths([artifactRoot], originalCreateRoots),
      success_criteria: Array.isArray(originalSuccessCriteria) ? originalSuccessCriteria : [],
      _planner_set_files: true,
    },
    promoteTitle: `Promote: ${_normalizeFixTitle(title || job.title).replace(/^Fix:\s*/i, "")}`,
    promotePayload: {
      mappings,
      source_dir: artifactRoot,
      files_to_modify: normalizedFiles,
      create_roots: _parentDirs(originalFiles),
      success_criteria: Array.isArray(originalSuccessCriteria) ? originalSuccessCriteria : [],
    },
  };
}

function _queueInternalAssessmentRetry(
  job,
  verdict,
  retryReason,
  {
    maxRetries = getAssessmentInternalRetryLimit(),
    leaseToken = null,
    recordAssessorVerdict = null,
  } = {},
) {
  const retryCount = countInternalAssessmentRetries(job.id);
  if (retryCount >= maxRetries) return false;
  let payload = {};
  try {
    payload = job?.payload_json
      ? (typeof job.payload_json === "string" ? JSON.parse(job.payload_json) : { ...job.payload_json })
      : {};
  } catch (err) {
    const message = err?.message || String(err);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_RETRY_PAYLOAD_PARSE_FAILED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Skipped internal assessment retry because job payload JSON is invalid: ${message}`,
    });
    log.warn("assessor", "Skipped internal assessment retry due to invalid job payload JSON", {
      jobId: job.id,
      workItemId: job.work_item_id,
      error: message,
    });
    return false;
  }
  const previousTier = job.model_tier || "standard";
  const retryTier = _nextAssessmentRetryTier(previousTier);
  payload._assess_only = true;
  payload._assess_model_tier = retryTier;
  delete payload._assess_model_name;
  const queued = runInTransaction(() => {
    const changed = updateJobStatus(
      job.id,
      "queued",
      leaseToken != null ? { leaseToken } : {},
    );
    if (!changed) return false;
    if (retryTier !== previousTier || job.model_name) {
      applyDelegation(job.id, { model_tier: retryTier, model: null });
      job.model_tier = retryTier;
      job.model_name = null;
    }
    updateJobPayload(job.id, JSON.stringify(payload));
    if (typeof recordAssessorVerdict === "function" && !recordAssessorVerdict()) {
      throw new Error(`Unable to record assessor verdict for job #${job.id} before internal retry`);
    }
    return true;
  });
  if (!queued) return false;
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_ASSESSMENT_INTERNAL_RETRY,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Assessment retry ${retryCount + 1}/${maxRetries} (${previousTier} -> ${retryTier}): ${retryReason}`,
    event_json: JSON.stringify({
      retry: retryCount + 1,
      maxRetries,
      retryReason,
      previous_model_tier: previousTier,
      model_tier: retryTier,
    }),
  });
  log.info("assessor", "Queued internal assessment retry", {
    jobId: job.id,
    workItemId: job.work_item_id,
    retryCount: retryCount + 1,
    maxRetries,
    retryReason,
    previousTier,
    retryTier,
  });
  return true;
}

export function __testQueueInternalAssessmentRetry(job, verdict, retryReason, opts = {}) {
  assertTestContext("__testQueueInternalAssessmentRetry");
  return _queueInternalAssessmentRetry(job, verdict, retryReason, opts);
}

export function __testNextAssessmentRetryTier(currentTier) {
  return _nextAssessmentRetryTier(currentTier);
}

function _sanitizeScopedFixPaths(paths = [], label = "path") {
  const kept = [];
  for (let i = 0; i < (Array.isArray(paths) ? paths.length : 0); i++) {
    const raw = paths[i];
    const err = validateScopedPath(raw, `${label}[${i}]`);
    if (!err) kept.push(String(raw).replace(/\\/g, "/"));
  }
  return _mergeUniquePaths(kept);
}


function _parentDirs(paths = []) {
  const dirs = [];
  for (const relPath of paths) {
    const normalized = String(relPath || "").replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    if (idx > 0) dirs.push(normalized.slice(0, idx));
  }
  return [...new Set(dirs)];
}

const INFERRED_SCOPE_BARE_FILENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".env.example",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "dockerfile",
  "gemfile",
  "makefile",
  "procfile",
  "readme",
]);

function _looksLikeScopedFilePath(value = "") {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes(":id")) return false;
  if (/\s/.test(normalized)) return false;
  if (/^[A-Za-z]+:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized)) return false;
  if (/^(git|npm|node|python|php|bash|sh)\b/i.test(normalized)) return false;
  if (normalized.includes("HEAD:")) return false;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1];
  if (!base || base.startsWith(":")) return false;
  const baseLower = base.toLowerCase();
  if (INFERRED_SCOPE_BARE_FILENAMES.has(baseLower)) return true;
  if (!/\.[A-Za-z0-9_-]{1,12}$/.test(base)) return false;
  if (!normalized.includes("/") && !INFERRED_SCOPE_BARE_EXTENSIONS.has(path.posix.extname(baseLower))) {
    return false;
  }
  return true;
}

export function _extractScopedPathsFromInstructions(text = "") {
  const source = String(text || "");
  if (!source.trim()) {
    return { files_to_modify: [], files_to_create: [], create_roots: [] };
  }

  const candidates = new Set();
  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1].trim().replace(/\\/g, "/");
    if (_looksLikeScopedFilePath(value)) candidates.add(value);
  }
  for (const match of source.matchAll(/\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)\b/g)) {
    const value = match[1].trim().replace(/\\/g, "/");
    if (_looksLikeScopedFilePath(value)) candidates.add(value);
  }

  const files_to_create = [];
  const files_to_modify = [];

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const optionalWrappedPath = `[\\s"'\\x60]*${escaped}[\\s"'\\x60]*`;
    const createRe = new RegExp(`(?:create|write|generate)(?:\\s+(?:a\\s+new\\s+file|the\\s+file|file))?\\s+${optionalWrappedPath}`, "i");
    const createAfterRe = new RegExp(`${optionalWrappedPath}.*(?:must\\s+be\\s+created|should\\s+be\\s+created|does\\s+not\\s+exist|missing)`, "i");
    const modifyRe = new RegExp(`(?:add|remove|delete|revert|rollback|undo|update|modify|edit|resize|cleanup|clean\\s+up)(?:\\s+(?:any\\s+changes\\s+made\\s+to|the\\s+file|file|tests?\\s+in))?\\s+${optionalWrappedPath}`, "i");
    const modifyAfterRe = new RegExp(`${optionalWrappedPath}.*(?:must\\s+be\\s+deleted|should\\s+be\\s+deleted|must\\s+be\\s+removed|should\\s+be\\s+removed|must\\s+be\\s+restored|should\\s+be\\s+restored|rollback|revert|deleted|removed)`, "i");

    let inferredCreate = createRe.test(source) || createAfterRe.test(source);
    let inferredModify = modifyRe.test(source) || modifyAfterRe.test(source);

    if (!inferredCreate && !inferredModify) {
      const lowerSource = source.toLowerCase();
      const lowerCandidate = candidate.toLowerCase();
      const idx = lowerSource.indexOf(lowerCandidate);
      if (idx >= 0) {
        const windowStart = Math.max(0, idx - 80);
        const windowEnd = Math.min(lowerSource.length, idx + lowerCandidate.length + 80);
        const context = lowerSource.slice(windowStart, windowEnd);
        inferredCreate = /\b(create|new file|write|generate|missing|does not exist)\b/.test(context);
        inferredModify = /\b(add|remove|delete|revert|rollback|undo|update|modify|edit|resize|cleanup|clean up|deleted|removed)\b/.test(context);
      }
    }

    if (inferredCreate && inferredModify) {
      if (/\b(add\s+tests?\s+in|modify|update|edit|remove|delete|revert|rollback|undo|cleanup|clean up)\b/i.test(source)) {
        inferredCreate = false;
      }
    }

    if (inferredCreate) {
      files_to_create.push(candidate);
      continue;
    }
    if (inferredModify) {
      files_to_modify.push(candidate);
    }
  }

  return {
    files_to_modify: _mergeUniquePaths(files_to_modify),
    files_to_create: _mergeUniquePaths(files_to_create),
    create_roots: _parentDirs(files_to_create),
  };
}

function _inferDeletionTargetsFromPayload(job, payload = {}) {
  const sources = [
    job?.title || "",
    payload?.task_spec || "",
    payload?.fix_instructions || "",
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
  ];
  const found = new Set();
  for (const source of sources) {
    const inferred = _extractScopedPathsFromInstructions(source);
    for (const candidate of inferred.files_to_modify) {
      found.add(candidate);
    }
  }
  return [...found];
}



//  Failure history helpers

function _safeParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Build a human-readable failure history for a work item.
 * Shows each failed job with its attempt errors and assessor reasons,
 * so the human can actually diagnose what's going wrong.
 */
function _buildFailureHistory(workItemId) {
  try {
    const jobs = listJobsByWorkItem(workItemId);
    const failedJobs = listUnresolvedActionableFailures(jobs);

    // Grab assessor events for this WI
    const assessEvents = getEventsByWorkItem(workItemId, 200)
      .filter(e => e.event_type === "job.assessed");
    const verdictsByJob = new Map();
    for (const ev of assessEvents) {
      const parsed = _safeParseJson(ev.event_json);
      if (parsed && ev.job_id) {
        if (!verdictsByJob.has(ev.job_id)) verdictsByJob.set(ev.job_id, []);
        verdictsByJob.get(ev.job_id).push(parsed);
      }
    }

    const lines = [];
    for (const fj of failedJobs.slice(-8)) { // last 8 failures max
      const attempts = getAttempts(fj.id);
      const failed = attempts.filter(a => a.status === "failed");
      const verdicts = verdictsByJob.get(fj.id) || [];
      const assessorReasons = verdicts
        .filter(v => v.verdict === "fail")
        .flatMap(v => v.reasons || []);

      lines.push(`[${fj.job_type}] #${fj.id} "${fj.title}" (${fj.status}, ${failed.length} failed attempts)`);

      // Show each attempt's error
      for (const a of failed.slice(-3)) {
        const err = (a.error_text || "no error text").split("\n")[0].slice(0, 200);
        lines.push(`  attempt ${a.attempt_number} (${a.model_name || "default"}): ${err}`);
      }

      // Show assessor feedback
      if (assessorReasons.length > 0) {
        lines.push(`  assessor: ${assessorReasons.slice(0, 3).join("; ")}`);
      }

      lines.push(""); // blank line between jobs
    }

    return lines.join("\n").slice(0, 3000) || "No failure details available.";
  } catch (err) {
    return `(Error building failure history: ${err.message})`;
  }
}

/**
 * Walk the fix chain (job  parent  parent...) to show what each
 * fix cycle tried and why it failed. Helps human see the progression.
 */
function _buildFixChainHistory(job) {
  try {
    const chain = [];
    let current = job;
    while (current) {
      const attempts = getAttempts(current.id);
      const failed = attempts.filter(a => a.status === "failed");
      const payload = _safeParseJson(current.payload_json);

      const entry = {
        id: current.id,
        type: current.job_type,
        title: current.title,
        errors: failed.slice(-2).map(a =>
          (a.error_text || "").split("\n")[0].slice(0, 150)
        ),
        fixInstructions: payload?.fix_instructions?.slice(0, 200) || null,
        assessorFeedback: payload?.assessor_feedback?.slice(0, 3) || null,
      };
      chain.unshift(entry); // oldest first

      if (!current.parent_job_id) break;
      current = getJob(current.parent_job_id);
      if (chain.length > 5) break; // safety cap
    }

    return chain.map((c, i) => {
      const lines = [`${i + 1}. [${c.type}] #${c.id} "${c.title}"`];
      if (c.fixInstructions) lines.push(`   Fix instructions: ${c.fixInstructions}`);
      if (c.assessorFeedback) lines.push(`   Assessor said: ${c.assessorFeedback.join("; ")}`);
      if (c.errors.length > 0) lines.push(`   Errors: ${c.errors.join("  ")}`);
      return lines.join("\n");
    }).join("\n\n").slice(0, 3000) || "No chain history available.";
  } catch (err) {
    return `(Error building fix chain: ${err.message})`;
  }
}

export {
  _buildFailureHistory as buildFailureHistory,
  _buildFixChainHistory as buildFixChainHistory,
  _buildIntermediateReportPayload as buildIntermediateReportPayload,
  _buildStructuredDataArtifactFixPlan as buildStructuredDataArtifactFixPlan,
  _getDesiredOutputs as getDesiredOutputs,
  inferGeneratedArtifactDeletionTargets,
  _inferDeletionTargetsFromPayload as inferDeletionTargetsFromPayload,
  _isLikelyArtifactRouteMismatch as isLikelyArtifactRouteMismatch,
  _logBadInput as logBadInput,
  _looksLikeStructuredDataRepoTransformRecovery as looksLikeStructuredDataRepoTransformRecovery,
  _mergeFixEditableScope as mergeFixEditableScope,
  _mergeUniquePaths as mergeUniquePaths,
  _normalizeFixTitle as normalizeFixTitle,
  _parentDirs as parentDirs,
  _queueInternalAssessmentRetry as queueInternalAssessmentRetry,
  _sanitizeScopedFixPaths as sanitizeScopedFixPaths,
  _shouldReplanForDesiredOutputs as shouldReplanForDesiredOutputs,
};
