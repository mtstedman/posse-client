// lib/domains/worker/functions/helpers/assessment-pipeline.js
//
// Post-execution assessment pipeline extracted from worker.js.

import path from "path";
import fs from "fs";
import { spawn, spawnSync } from "child_process";
import {
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
  storeArtifact,
  updateJobPayload,
  updateJobStatus,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { isArtifactMode, buildManifest, validateManifestAgainstContract } from "../../../artifacts/functions/index.js";
import { getProviderBackoff, getProviderName } from "../../../providers/functions/provider.js";
import {
  attachAssessmentDiffContextAsync,
  buildRoutingPacket,
  composePromptRemoteAware,
  buildSmartPreload,
  extractResearcherFiles,
  handoff,
  renderAtlasHandoffSections,
} from "../../../handoff/functions/index.js";
import { refreshAndExtractInsights } from "./insights.js";
import { gitExec, gitExecAsync, gitHasChangesAsync } from "../../../git/functions/utils.js";
import {
  resetDirtyWorktreeFallbackAsync,
  snapshotAndResetDirtyWorktreeAsync,
  stashDirtyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import { ASSESSABLE_JOB_TYPES } from "../../../../catalog/job.js";
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
import { processVerdict } from "./process-verdict.js";
import { normalizeAssessorConfidence } from "./verdict-shared.js";
import { activeSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import {
  emitResearchComplete as emitAtlasV2ResearchComplete,
  isAtlasV2EmissionEnabled,
} from "../../../atlas/classes/v2/PipelineHooks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { ensureRegisteredTestTables, runRegisteredTest } from "../../../../functions/toolkit/registered-tests.js";

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

function markAssessmentRetryAssessOnly(job) {
  if (!job || !ASSESSABLE_JOB_TYPES.has(job.job_type)) return false;
  const payload = parseJobPayload(job);
  payload._assess_only = true;
  const nextPayloadJson = JSON.stringify(payload);
  updateJobPayload(job.id, nextPayloadJson);
  job.payload_json = nextPayloadJson;
  return true;
}

function _mergeUniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))];
}

function normalizeAtlasResearchFiles(files) {
  const out = [];
  const seen = new Set();
  for (const raw of files || []) {
    const rel = String(raw || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "");
    if (!rel || rel.includes("\0") || rel.startsWith("../") || rel === "..") continue;
    if (/^[a-zA-Z]:\//.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function emitAtlasV2ResearchCompleteIfEnabled(job, output) {
  if (!isAtlasV2EmissionEnabled()) return;
  try {
    const artifacts = getArtifacts(job.id, "summary");
    const files = normalizeAtlasResearchFiles(
      extractResearcherFiles([...artifacts, { content_long: output || "" }]),
    );
    const wi = getWorkItem(job.work_item_id);
    emitAtlasV2ResearchComplete({
      payload: {
        wi_id: Number(job.work_item_id),
        branch: String(wi?.branch_name || `wi-${job.work_item_id}`),
        files,
      },
      jobId: job.id,
      onError: (err) => {
        log.warn("atlas-v2", "Failed to emit research_complete outbox event", {
          jobId: job.id,
          wiId: job.work_item_id,
          error: err?.message || String(err),
        });
      },
    });
  } catch (err) {
    log.warn("atlas-v2", "Failed to prepare research_complete outbox event", {
      jobId: job.id,
      wiId: job.work_item_id,
      error: err?.message || String(err),
    });
  }
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
  if (!Array.isArray(normalized.reasons) || normalized.reasons.length === 0) {
    const fallbackReason = normalized.summary || normalized.reason || normalized.notes;
    if (fallbackReason) {
      normalized.reasons = [String(fallbackReason)];
    }
  }
  if (!Array.isArray(normalized.spawn_jobs)) normalized.spawn_jobs = [];
  if (!Array.isArray(normalized.human_questions)) normalized.human_questions = [];
  if (!Array.isArray(normalized.suggestions)) normalized.suggestions = [];
  if (!normalized.raw && raw) normalized.raw = raw;
  return normalized;
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

function _buildRemoteAssessmentInstructions({
  job,
  taskSpec = "",
  workflowModeBlock = "",
  atlasBlock = "",
  priorAssessmentFindings = "",
  fileVerification = "",
  registeredTestRunEvidence = "",
  assessmentDiffNarrative = "",
  fallbackReads = null,
} = {}) {
  return [
    `Assess this completed task. Check the actual files, not just the dev's claims.`,
    `The local client will append local-only assessment evidence after remote prompt compilation, including any scoped git diff, file snapshots, and worker output. Use that appended evidence for verification; do not ask the human to paste repository files or diffs that are already in the workspace.`,
    `If the dev log marks VERIFICATION_UNAVAILABLE for a command/tool, treat that as a verification gap, not proof of failure. Fail only when deterministic evidence shows a success criterion is unmet; return blocked when the only missing piece is unavailable environment/tooling.`,
    Number.isFinite(Number(fallbackReads)) ? `Fallback read budget for this assessment attempt: ${Math.max(0, Number(fallbackReads))}.` : null,
    workflowModeBlock,
    atlasBlock || null,
    priorAssessmentFindings ? `PRIOR ASSESSMENT FINDINGS (build on these; do not re-request the same evidence unless necessary):\n${priorAssessmentFindings}` : null,
    ``,
    `TASK SPECIFICATION:`,
    taskSpec || `Title: ${job?.title || ""}`,
    fileVerification ? `\nFILE VERIFICATION SUMMARY:\n${fileVerification}` : null,
    registeredTestRunEvidence ? `\nREGISTERED POSSE TEST RUN SUMMARY:\n${registeredTestRunEvidence}` : null,
    assessmentDiffNarrative ? `\nSCOPED DIFF NARRATIVE:\n${assessmentDiffNarrative}` : null,
    ``,
    `The final response must be only a fenced \`\`\`json verdict block. No prose.`,
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
  truncatedOutput = "",
} = {}) {
  return [
    `LOCAL ASSESSMENT EVIDENCE`,
    `This block was attached by the local client after remote prompt compilation. Treat it as the ground-truth verification context.`,
    fileVerification || null,
    assessmentDiffNarrative || null,
    assessmentScopedDiff || null,
    assessmentFileSnapshots || null,
    registeredTestRunEvidence || null,
    `WORKER OUTPUT:`,
    truncatedOutput,
    ``,
    `═══════════════════════════════════════════════════════════`,
    `YOUR RESPONSE MUST BE ONLY A FENCED \`\`\`json VERDICT BLOCK.`,
    `NO PROSE. NO EXPLANATION. JUST THE JSON VERDICT.`,
    `═══════════════════════════════════════════════════════════`,
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

  const candidatePaths = _mergeUniquePaths(
    ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
  ).slice(0, 6);
  if (candidatePaths.length === 0) return "";

  const lineHints = _extractTaskLineRanges(taskSpec);
  const sections = [];

  for (const relPath of candidatePaths) {
    const normalizedPath = _normalizeAssessmentScopePath(relPath, cwd);
    if (!normalizedPath) continue;
    const absPath = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(cwd, normalizedPath);
    let raw = "";
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      sections.push(`=== ${normalizedPath} === (file not found or unreadable during assessment preload)`);
      continue;
    }

    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    if (lines.length <= 450 && raw.length <= 50000) {
      sections.push(`=== ${normalizedPath} (${lines.length} lines) ===\n${_formatLineNumberedFile(lines.join("\n"))}`);
      continue;
    }

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
      sections.push(parts.join("\n"));
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
      sections.push(parts.join("\n"));
      continue;
    }

    const head = lines.slice(0, 160).join("\n");
    sections.push(`=== ${normalizedPath} (${lines.length} lines, head excerpt) ===\n${_formatLineNumberedFile(head)}`);
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
export async function assessResult(job, output, { silent = false, autoApprove = false, modelTier = "standard", reasoningEffort = "medium", cwd = null, providerOverride = null, assessmentContext = null, abortSignal = null, fallbackReads = null, priorAssessmentFindings = "", trackedCall = null, disableAtlas = false, remoteComposer = null } = {}) {
  // Gather context: the task spec (from payload or artifact)
  let taskSpec = "";
  let parsedJobPayload = parseJobPayload(job);
  const visibleJobPayload = stripInternalAssessmentPolicyPayload(parsedJobPayload);
  const workflowModeBlock = buildWorkflowModeBlock(getWorkItemWorkflowConfig(getWorkItem(job.work_item_id)), "assessor");
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
    ? `\nSCOPED GIT DIFF (preferred verification view for this job's changes):\n${assessmentContext.scoped_git_diff}\n`
    : "";
  const assessmentDiffNarrative = assessmentContext?.scoped_diff_narrative
    ? `\nSCOPED DIFF NARRATIVE (compact summary of changed files and hunks):\n${assessmentContext.scoped_diff_narrative}\n`
    : "";
  const assessmentFileSnapshots = _buildAssessmentFileSnapshots({ cwd, assessmentContext, taskSpec });

  // Extract the structured log (DEV LOG or ARTIFICER LOG) as the primary
  // assessment input. The assessor reads actual files for verification — it
  // doesn't need the full tool-call stream. Only include the raw stream as
  // a fallback if no structured log is found.
  const logMatch = output.match(/---\s*(?:DEV|ARTIFICER) LOG START\s*---\s*([\s\S]*?)---\s*(?:DEV|ARTIFICER) LOG END\s*---/);
  let truncatedOutput;
  if (logMatch) {
    truncatedOutput = `AGENT COMPLETION LOG:\n${logMatch[1].trim()}`;
    // If the log references issues, include a small window of raw output
    // around the log for context (last 3000 chars before the log)
    const logStart = output.indexOf(logMatch[0]);
    if (logStart > 0) {
      const contextWindow = output.slice(Math.max(0, logStart - 3000), logStart).trim();
      if (contextWindow.length > 0) {
        truncatedOutput = `RECENT AGENT OUTPUT (last steps before completion):\n${contextWindow}\n\n${truncatedOutput}`;
      }
    }
  } else {
    // No structured log — fall back to truncated raw output
    const maxOutputChars = 20000;
    truncatedOutput = output.length > maxOutputChars
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

  const providerScope = buildAssessmentProviderScope({ cwd, assessmentContext });
  const registeredTestScopeFiles = _mergeUniquePaths(
    providerScope.scopedFiles,
    providerScope.createFiles,
    providerScope.deleteFiles,
  );

  let registeredTestRunEvidence = "";
  try {
    const assessmentDb = getDb();
    _rerunFailedRegisteredTestsForAssessment({ job, cwd, scopeFiles: registeredTestScopeFiles, db: assessmentDb });
    registeredTestRunEvidence = __testBuildRegisteredTestRunEvidence({
      jobId: job.id,
      scopeFiles: registeredTestScopeFiles,
      db: assessmentDb,
    });
  } catch {
    registeredTestRunEvidence = "";
  }

  // Resolve the assessor handoff packet before prompt composition. The packet
  // carries remote-prompt identity, stable scope/tool metadata, and ATLAS status.
  // It must not contain raw diff/snapshot evidence; that stays local and is
  // appended after remote compilation below.
  let atlasBlock = "";
  let assessorAtlasPrefetchStatus = null;
  let assessorPacket = null;
  try {
    const workItemForAssessor = getWorkItem(job.work_item_id);
    const packetPayload = {
      ...parsedJobPayload,
      task_spec: taskSpec || parsedJobPayload.task_spec || parsedJobPayload.instructions || job.title,
      files_to_modify: providerScope.scopedFiles.length > 0 ? providerScope.scopedFiles : (parsedJobPayload.files_to_modify || []),
      files_to_create: providerScope.createFiles.length > 0 ? providerScope.createFiles : (parsedJobPayload.files_to_create || []),
      files_to_delete: providerScope.deleteFiles.length > 0 ? providerScope.deleteFiles : (parsedJobPayload.files_to_delete || []),
      create_roots: providerScope.createRoots.length > 0 ? providerScope.createRoots : (parsedJobPayload.create_roots || []),
    };
    assessorPacket = buildRoutingPacket(job, {
      workItem: workItemForAssessor,
      payload: packetPayload,
      role: "assessor",
      effectiveTier: modelTier,
      attemptCount: getAttempts(job.id).length + 1,
      maxAttempts: job.max_attempts || 3,
      lastError: null,
      cwd,
      jobProvider: providerOverride || job.provider || null,
      disableAtlas: artifactAssessmentRoute,
      disableAtlasReason: artifactAssessmentRoute ? "artifact route" : null,
      context_hints: Number.isFinite(Number(fallbackReads))
        ? { allow_fallback_reads: Math.max(0, Number(fallbackReads)) }
        : {},
    });
    await handoff(assessorPacket);
    if (!artifactAssessmentRoute) {
      atlasBlock = renderAtlasHandoffSections(assessorPacket) || "";
      assessorAtlasPrefetchStatus = assessorPacket?.atlas?.prefetchStatus || null;
    }
  } catch {
    atlasBlock = "";
    assessorAtlasPrefetchStatus = null;
  }

  const prompt = [
    `Assess this completed task. Check the actual files, not just the dev's claims.`,
    `Use the SCOPED DIFF NARRATIVE as the quick map of what changed, then use any SCOPED GIT DIFF below as the primary verification view for exact changes. Use SCOPED FILE SNAPSHOTS as fallback/current-state context when the diff alone is insufficient. Do not ask the human to paste repository files or diffs that are already in the workspace; if verification still fails due to environment/tooling limits, return blocked without human_questions requesting repo file contents.`,
    `If the dev log marks VERIFICATION_UNAVAILABLE for a command/tool, treat that as a verification gap, not proof of failure. Fail only when deterministic evidence shows a success criterion is unmet; return blocked when the only missing piece is unavailable environment/tooling.`,
    Number.isFinite(Number(fallbackReads)) ? `Fallback read budget for this assessment attempt: ${Math.max(0, Number(fallbackReads))}.` : null,
    workflowModeBlock,
    atlasBlock || null,
    priorAssessmentFindings ? `PRIOR ASSESSMENT FINDINGS (build on these; do not re-request the same evidence unless necessary):\n${priorAssessmentFindings}` : null,
    ``,
    `TASK SPECIFICATION:`,
    taskSpec || `Title: ${job.title}`,
    fileVerification,
    registeredTestRunEvidence,
    assessmentDiffNarrative,
    assessmentScopedDiff,
    assessmentFileSnapshots,
    `WORKER OUTPUT:`,
    truncatedOutput,
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
    taskSpec,
    workflowModeBlock,
    atlasBlock,
    priorAssessmentFindings,
    fileVerification,
    registeredTestRunEvidence,
    assessmentDiffNarrative,
    fallbackReads,
  });
  const localAssessmentEvidence = _buildLocalAssessmentEvidence({
    fileVerification,
    assessmentDiffNarrative,
    assessmentScopedDiff,
    assessmentFileSnapshots,
    registeredTestRunEvidence,
    truncatedOutput,
  });
  let providerPrompt = prompt;
  if (assessorPacket) {
    providerPrompt = await composePromptRemoteAware(
      assessorPacket,
      remoteAssessmentInstructions,
      {
        ...(remoteComposer ? { composer: remoteComposer } : {}),
        providerName: providerOverride || job.provider || null,
      },
    );
    if (assessorPacket.remote_prompt_composed) {
      providerPrompt = [providerPrompt, localAssessmentEvidence].filter(Boolean).join("\n\n");
    }
  }

  let response;
  try {
    // Inherit deepthink from the job being assessed: if the task author
    // marked it deepthink, the assessment deserves the same budget so it
    // doesn't rubber-stamp work that took extra time to produce.
    const assessorDeepthink = !!parseJobPayload(job).deepthink;

    const result = await trackedCall(providerPrompt, {
      role: "assessor",
      modelTier,
      reasoningEffort,
      activity: `assessing: ${job.title}`,
      silent,
      autoApprove,
      cwd,
      scopedFiles: providerScope.scopedFiles,
      createFiles: providerScope.createFiles,
      createRoots: providerScope.createRoots,
      fallbackReads,
      abortSignal,
      atlasPrefetchStatus: assessorPacket?.atlas?.prefetchStatus || assessorAtlasPrefetchStatus,
      disableAtlas: artifactAssessmentRoute,
      stableContext: assessorPacket?.stable_context || null,
      remoteSystemPrompt: assessorPacket?.remote_system_prompt || null,
      skipRolePrompt: !!assessorPacket?.remote_prompt_composed,
      deepthink: assessorDeepthink,
    }, {
      job_id: job.id,
      work_item_id: job.work_item_id,
      cwd,
      jobProvider: providerOverride || null,
      jobModelName: job.model_name || null,
    });
    response = result.output;
  } catch (err) {
    throw err;
  }

  // Store the raw assessment as an artifact
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    artifact_type: "review",
    content_long: response,
  });

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
  const VALID_VERDICTS = new Set(["pass", "fail", "blocked", "needs_replan", "needs_review"]);
  const parsedVerdict = VALID_VERDICTS.has(verdict.verdict) ? verdict.verdict : "parse_error";
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

  // Coerce reasons to strings — LLMs may return numbers, objects, or null
  const rawReasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
  const reasons = rawReasons.map(r => (r == null ? "" : typeof r === "string" ? r : JSON.stringify(r))).filter(Boolean);

  return {
    verdict: parsedVerdict,
    confidence: normalizeAssessorConfidence(verdict.confidence, { fallback: "medium", allowNone: true }) || "none",
    reasons,
    spawn_jobs: Array.isArray(verdict.spawn_jobs) ? verdict.spawn_jobs : [],
    human_questions: (Array.isArray(verdict.human_questions) ? verdict.human_questions : []).map(q => typeof q === "string" ? q : String(q)),
    suggestions: Array.isArray(verdict.suggestions) ? verdict.suggestions : [],
    raw: response,
    ...(verdict._disable_internal_retry ? { _disable_internal_retry: true } : {}),
  };
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

function killShellCommandProcessTree(child, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform === "win32" && child?.pid) {
    try {
      const result = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (!result || result.status === 0) return true;
    } catch {
      // Fall back to killing the shell wrapper below.
    }
  }
  try { return !!child?.kill?.(); } catch { return false; }
}

export function __testKillShellCommandProcessTree(child, opts = {}) {
  return killShellCommandProcessTree(child, opts);
}

function runShellCommandAsync(command, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killShellCommandProcessTree(child);
      const err = new Error(`Command timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, Math.max(1000, Number(timeoutMs) || 120000));

    child.stdout?.on("data", (chunk) => { stdout += String(chunk || ""); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`Command exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export async function runPostExecutionAssessment(worker, {
  attempt,
  committedHash,
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

  // Skip assessment when the job made no file changes but has file requests.
  const skipAssessForFileRequest = !hasFileChanges && hasPendingFileRequests();
  const skipAssessForSatisfiedNoop = satisfiedNoop && !verifiedNoChange;
  const shouldRunAssessment = ASSESSABLE_JOB_TYPES.has(job.job_type)
    && !worker.dryRun
    && !worker._shouldSkipAssessment(job);
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
    // Keep the scoped job lock active while the committed work is being assessed.
    updateJobStatus(job.id, "awaiting_assessment", leaseToken != null ? { leaseToken } : {});
    worker.emit(job.id, `${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: assessing ${shortJobTitle(job).slice(0, 50)}`);
    syncAssessorWorkerDisplay(worker.display, job, {
      tier: "cheap",
      effort: job.reasoning_effort || "medium",
      attempt: attempt.attempt_number || job.attempt_count || 1,
    });

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
          detail: { command: preAssessCmd, cwd: wtPath },
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
            status: "failed",
            duration_ms: Date.now() - startTime,
            error_text: hookMsg,
          });
          setJobError(job.id, hookMsg);
          worker._retryOrFail(job, leaseToken, hookMsg);
          return;
        }
        worker.emit(job.id, `${C.green}[pre-assess] Passed${C.reset}`);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "command.pre_assess",
          summary: "Pre-assess command passed",
          detail: { command: preAssessCmd, cwd: wtPath, status: "passed" },
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
          detail: { command: preAssessCmd, cwd: wtPath, status: "failed" },
        });
        completeAttempt(attempt.id, {
          status: "failed",
          duration_ms: Date.now() - startTime,
          error_text: hookMsg,
        });
        setJobError(job.id, hookMsg);
        worker._retryOrFail(job, leaseToken, hookMsg);
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
      const assessmentContext = await attachAssessmentDiffContextAsync({
        task_mode: taskMode,
        manifest,
        contract_violations: contractViolations,
        contract_warnings: contractWarnings,
        commit_hash: committedHash,
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
      const assessOpts = {
        silent: worker.silent,
        autoApprove: worker.autoApprove,
        abortSignal: jobAc?.signal || null,
        cwd: (isArtifactMode(taskMode) && jobPayloadForAssess.output_root)
          ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
          : (wtPath || worker.projectDir),
        assessmentContext,
      };
      const trackedCall = getWorkerProviderCall(worker);
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
      const assessmentReasoningEffort = ["low", "medium", "high"].includes(String(jobPayloadForAssess._assess_reasoning_effort || "").trim().toLowerCase())
        ? String(jobPayloadForAssess._assess_reasoning_effort).trim().toLowerCase()
        : "medium";
      const initialAssessmentTier = normalizeAssessmentTier(jobPayloadForAssess._assess_model_tier, "cheap");
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
          if (budget.exceeded) {
            const message = `Assessment parse-retry budget exceeded (${budget.spent}/${budget.cap} input tokens) before ${retryTier}-tier retry`;
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
          if (budget.exceeded) {
            const message = `Assessment parse-retry budget exceeded (${budget.spent}/${budget.cap} input tokens) before ${retryTier}-tier retry`;
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
      if (isProviderError(assessErr) || assessErr?.assessmentRetryable || turnBudgetExhausted || stallKilled) {
        const retryLabel = assessErr?.assessmentRetryable
          ? "Environment/tooling error during assessment"
          : (stallKilled
            ? "Assessment stalled"
            : (turnBudgetExhausted
              ? "Assessment turn budget exhausted"
              : "Provider error during assessment"));
        worker.emit(job.id, `${C.yellow}[assessor] ${retryLabel} - requeuing: ${assessErr.message?.split("\n")[0]?.slice(0, 120)}${C.reset}`);
        completeAttempt(attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - startTime,
          error_text: assessErr?.assessmentRetryable
            ? `Assessment environment error: ${assessErr.message}`
            : (stallKilled
              ? `Assessment stalled: ${assessErr.message}`
              : (turnBudgetExhausted
                ? `Assessment turn budget exhausted: ${assessErr.message}`
                : `Assessment provider error: ${assessErr.message}`)),
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
                catch { try { await resetDirtyWorktreeFallbackAsync(wtPath, worker.projectDir); } catch { /* ignore */ } }
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
          message: `${retryLabel} - requeuing without penalty: ${assessErr.message?.split("\n")[0]}`,
        });

        const assessProvider = job.provider || getProviderName("assessor");
        const assessBackoff = assessErr?.assessmentRetryable
          ? 5
          : (turnBudgetExhausted || stallKilled
            ? 2
            : getProviderBackoff(assessProvider, assessErr).backoffSec);
        const readyAt = new Date(Date.now() + assessBackoff * 1000).toISOString();
        try {
          markAssessmentRetryAssessOnly(job);
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
        worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
      } else {
        worker.emit(job.id, `${C.red}[assessor] Transport error: ${assessErr.message}${C.reset}`);
        completeAttempt(attempt.id, {
          status: "failed",
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
        const reviewJob = createJob({
          work_item_id: job.work_item_id,
          job_type: "human_input",
          title: `Assessment failed: ${job.title.slice(0, 70)}`,
          parent_job_id: job.id,
          priority: "high",
          model_tier: "cheap",
          payload_json: JSON.stringify({
            original_job_id: job.id,
            questions: [
              `Assessment for job #${job.id} ("${job.title}") failed with a transport error: ${assessErr.message?.split("\n")[0]?.slice(0, 150)}`,
              `The dev work is committed but unverified. Retry assessment, pass manually, or fail?`,
            ],
            context: `Assessment transport error. The dev work may be correct but could not be verified.`,
            review_type: "assessment_transport_error",
          }),
        });
        worker.emit(job.id, `${C.yellow}[worker] Spawned review job #${reviewJob.id} for assessment failure${C.reset}`);
        worker._releaseLease(job, leaseToken, "waiting_on_review");
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
    emitAtlasV2ResearchCompleteIfEnabled(job, output);
    worker._spawnPlanAfterResearch(job, output);
  } else if (job.job_type === "preflight") {
    worker._spawnResearchAfterPreflight(job, output);
  }

  if (hasPendingFileRequests() && isLeaseValid(job.id, leaseToken)) spawnPendingFileRequestsOnce();
  worker._releaseLease(job, leaseToken, "succeeded");
  refreshAndExtractInsights(job.work_item_id);
  worker._cleanupWorktreeIfDone(job.work_item_id);
}
