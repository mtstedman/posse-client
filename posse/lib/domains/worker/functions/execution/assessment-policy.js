import path from "path";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getAgentCalls, getArtifacts, getSetting } from "../../../queue/functions/index.js";
import { isArtifactMode } from "../../../artifacts/functions/index.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";

export function shouldOverrideArtifactMissingFail(verdict, { taskMode = "code", manifest = null, contractViolations = null, outputRoot = null } = {}) {
  if (!verdict || verdict.verdict !== "fail" || !isArtifactMode(taskMode)) return false;
  if (!manifest || manifest.count <= 0 || !outputRoot) return false;
  if (Array.isArray(contractViolations) && contractViolations.length > 0) return false;
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
  if (reasons.length === 0) return false;
  return reasons.every((reason) => /\b(missing|not found|no .*file|without the actual .*file|cannot be confirmed)\b/i.test(String(reason || "")));
}

export function shouldFastPassArtifactAssessment({
  taskMode = "code",
  manifest = null,
  contractViolations = null,
  outputRoot = null,
  expectedFiles = [],
} = {}) {
  if (!isArtifactMode(taskMode)) return false;
  if (!outputRoot || !manifest || manifest.count <= 0) return false;
  if (Array.isArray(contractViolations) && contractViolations.length > 0) return false;

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestPaths = new Set(manifestFiles.map((file) => String(file.path || "").replace(/\\/g, "/")));
  const required = (Array.isArray(expectedFiles) ? expectedFiles : [])
    .map((file) => String(file || "").replace(/\\/g, "/"))
    .filter(Boolean)
    .map((file) => {
      const rootAbs = path.resolve(outputRoot);
      const fileAbs = path.resolve(file);
      const rel = path.relative(rootAbs, fileAbs).replace(/\\/g, "/");
      return isInsideRoot(fileAbs, rootAbs, { allowEqual: false }) ? rel : path.posix.basename(file);
    });
  if (required.length === 0) return taskMode === "report" && manifestPaths.size > 0;

  return required.every((relPath) => manifestPaths.has(relPath));
}

function assessorFallbackReads(baseReads, modelTier = "cheap") {
  const base = Number.isFinite(Number(baseReads)) ? Math.max(0, Number(baseReads)) : 0;
  const bonus = modelTier === "strong" ? 4 : modelTier === "standard" ? 2 : 0;
  return base + bonus;
}

function getBaseAssessorFallbackReads() {
  const raw = getSetting(SETTING_KEYS.ASSESSOR_FALLBACK_READS);
  if (raw == null || raw === "") return 4;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 4;
}

function getAssessorFallbackRetryStep() {
  const raw = getSetting(SETTING_KEYS.ASSESSOR_FALLBACK_READS_RETRY_STEP);
  if (raw == null || raw === "") return 2;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 2;
}

export function assessmentRetryFallbackReads(modelTier = "cheap", retryCount = 0) {
  const base = getBaseAssessorFallbackReads();
  const progressiveBonus = Math.max(0, Number(retryCount) || 0) * getAssessorFallbackRetryStep();
  return assessorFallbackReads(base + progressiveBonus, modelTier);
}

/**
 * Right-size the assessor's optional read allowance to the exact task surface.
 * This is an allowance, not a target: narrow jobs retain the configured base,
 * while broad/no-change reviews are not forced into a cold assessment retry
 * merely because the planner named more than four files.
 */
export function raiseAssessmentFallbackReadsForScope(baseReads, {
  assessmentContext = null,
  payload = null,
} = {}) {
  const exactPaths = new Set();
  const add = (values) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const pathValue = typeof value === "string"
        ? value
        : (value?.path || value?.file || value?.file_path || null);
      const normalized = String(pathValue || "").replace(/\\/g, "/").trim();
      if (normalized) exactPaths.add(normalized);
    }
  };
  for (const key of [
    "allowed_files",
    "allowed_create_files",
    "files_committed",
    "files_requested",
    "scoped_git_diff_source_ranges",
  ]) add(assessmentContext?.[key]);
  for (const key of ["files_to_modify", "files_to_create", "files_to_delete", "must_modify"]) {
    add(payload?.[key]);
  }
  const base = Number.isFinite(Number(baseReads)) ? Math.max(0, Math.floor(Number(baseReads))) : 0;
  return exactPaths.size > 0 ? Math.max(base, exactPaths.size + 2) : base;
}

export function getAssessorMaxToolCalls() {
  const raw = getSetting(SETTING_KEYS.ASSESSOR_MAX_TOOL_CALLS);
  if (raw == null || raw === "") return 12;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 12;
}

function getAssessorParseRetryInputTokensCap() {
  const raw = getSetting(SETTING_KEYS.ASSESSOR_PARSE_RETRY_INPUT_TOKENS_CAP);
  if (raw == null || raw === "") return 150000;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 150000;
}

export function getAssessorInputTokenSpend(jobId) {
  if (jobId == null) return 0;
  const calls = getAgentCalls(jobId);
  return (Array.isArray(calls) ? calls : []).reduce((sum, call) => {
    if (call?.role !== "assessor") return sum;
    const measured = call?.input_tokens == null ? null : Number(call.input_tokens);
    const promptChars = Number(call?.prompt_chars);
    if (Number.isFinite(measured) && (measured > 0 || !(Number.isFinite(promptChars) && promptChars > 0))) {
      return sum + Math.max(0, measured);
    }
    return sum + (Number.isFinite(promptChars) ? Math.max(0, Math.ceil(promptChars / 4)) : 0);
  }, 0);
}

export function assessorCallBudgetStatus(jobId, attemptId, maxCalls = 4) {
  const normalizedAttemptId = Number(attemptId);
  if (!Number.isInteger(normalizedAttemptId) || normalizedAttemptId <= 0) {
    throw new TypeError("assessorCallBudgetStatus requires a positive attempt ID");
  }
  const calls = jobId == null ? [] : getAgentCalls(jobId);
  const used = (Array.isArray(calls) ? calls : []).filter((call) => (
    call?.role === "assessor"
    && Number(call?.attempt_id) === normalizedAttemptId
  )).length;
  const cap = Math.max(1, Math.floor(Number(maxCalls) || 4));
  return { exceeded: used >= cap, used, cap };
}

export function isAssessorParseRetryBudgetExceeded(jobId) {
  const cap = getAssessorParseRetryInputTokensCap();
  const spent = getAssessorInputTokenSpend(jobId);
  if (cap <= 0) return { exceeded: false, cap, spent };
  return { exceeded: spent >= cap, cap, spent };
}

export function buildPriorAssessmentFindings(jobId) {
  const reviewArtifacts = getArtifacts(jobId, "review");
  const recent = reviewArtifacts.slice(-2);
  if (recent.length === 0) return "";
  const sections = [];
  for (const artifact of recent) {
    const text = String(artifact?.content_long || artifact?.content_json || "").trim();
    if (!text) continue;
    sections.push(text.slice(0, 2500));
  }
  return sections.join("\n\n---\n\n").slice(0, 5000);
}
