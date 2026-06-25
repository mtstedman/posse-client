import path from "path";
import {
  buildOperatorGuidanceForAttempt,
} from "../../../queue/functions/index.js";
import { slugify } from "../../../../shared/format/functions/slug.js";
import { estimateCallCost } from "../../../billing/functions/pricing.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";

const PROVIDER_ERROR_PATTERNS = [
  /overloaded_error/i,
  /API Error:\s*5\d\d/i,
  /api_error.*internal server error/i,
  /rate.?limit|429|too many requests/i,
  /out of.*usage|usage.*reset|usage limit|usage cap|usage exhausted|over usage|quota exceeded|credit balance is too low/i,
  /configuration.*corrupted/i,
  /Failed to spawn claude/i,
  /claude exited null/i,
  /claude exited with unknown status/i,
  /claude exited via signal/i,
  /socket connection was closed unexpectedly/i,
  /^Codex CLI exited with code 1\s*$/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
  /connection error/i,
  /circuit breaker open/i,
];

export function loadNudges(jobId, { attemptId = null, agentCallId = null } = {}) {
  return buildOperatorGuidanceForAttempt({
    job_id: jobId,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
  });
}

export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

export function artifactTaskSlug(title, fallback = "artifact") {
  return slugify(title || fallback, { fallback, maxLength: 40 });
}

export function buildIntermediateReportTask(task, artifactDirAbs, desiredOutputs = []) {
  const outputRoot = String(task?.output_root || artifactDirAbs || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const reportPath = `${outputRoot}/report.md`;
  const desiredText = desiredOutputs.length > 0 ? desiredOutputs.join(", ") : "repo";
  return {
    ...task,
    job_type: "artificer",
    task_mode: "report",
    output_root: outputRoot,
    create_roots: [outputRoot],
    files_to_modify: [],
    files_to_create: [reportPath],
    files_to_delete: [],
    needs_image_generation: false,
    task_spec: [
      task?.task_spec || task?.instructions || task?.title || "",
      "",
      "This task has no writable repo scope, so treat it as an intermediate verification/reporting step.",
      `Generate a markdown report at ${reportPath} with the commands run, observations, blockers, and concrete evidence gathered.`,
      `This report is intermediate context only. The work item still requires terminal output(s): ${desiredText}.`,
    ].filter(Boolean).join("\n"),
  };
}

export function isProviderError(err) {
  const msg = err.message || "";
  return PROVIDER_ERROR_PATTERNS.some((re) => re.test(msg));
}

export function resolveCallCostEstimate(stats) {
  const candidates = [
    stats?.costUsd,
    stats?.cost_usd,
    stats?.estimatedCostUsd,
    stats?.totalCostUsd,
    stats?.total_cost_usd,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  const estimated = estimateCallCost({
    provider: stats?.provider,
    modelName: stats?.modelName || stats?.model_name,
    modelTier: stats?.modelTier || stats?.model_tier,
    inputTokens: stats?.inputTokens ?? stats?.input_tokens ?? 0,
    outputTokens: stats?.outputTokens ?? stats?.output_tokens ?? 0,
    cachedInputTokens: stats?.cachedInputTokens ?? stats?.cached_input_tokens ?? 0,
    cacheCreationInputTokens: stats?.cacheCreationInputTokens ?? stats?.cache_creation_input_tokens ?? 0,
    longContextInputTokens: stats?.longContextInputTokens ?? stats?.long_context_input_tokens ?? null,
  });
  return estimated?.costUsd ?? null;
}

export function normalizePlannerScore(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(5, parsed));
}

function isGenericResearchPlaceholderQuestion(question) {
  const normalized = String(question || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return normalized === "the researcher flagged questions in the research brief. please review the research output and provide answers.";
}

export function isBogusResearchPlaceholderPayload(payload = {}) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (questions.length === 0) return false;
  if (!questions.every((q) => isGenericResearchPlaceholderQuestion(q))) return false;
  const context = String(payload?.context || "").toLowerCase();
  return context.includes("researcher tried to self-resolve");
}

export function latestArtifactText(jobId, types = []) {
  for (const type of types) {
    const artifacts = getArtifacts(jobId, type);
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const text = artifacts[i]?.content_long || artifacts[i]?.content_json || "";
      if (text) return String(text);
    }
  }
  return "";
}

export function resolveExpectedFilePath(outputRoot, file) {
  const rootAbs = path.resolve(outputRoot);
  const fileAbs = path.resolve(file);
  const rel = path.relative(rootAbs, fileAbs).replace(/\\/g, "/");
  return isInsideRoot(fileAbs, rootAbs, { allowEqual: false }) ? rel : path.posix.basename(file);
}
