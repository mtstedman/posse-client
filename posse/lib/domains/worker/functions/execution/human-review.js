import fs from "fs";
import path from "path";
import { getDependencies, getJob } from "../../../queue/functions/index.js";
import { parseJsonObject } from "../../../queue/functions/payload.js";
import { artifactsDir, wiScopeId } from "../../../artifacts/functions/index.js";

export function extractHumanAnswers(output) {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed?.answers) ? parsed.answers : [];
  } catch {
    return [];
  }
}

export function extractHumanAnswerText(answer) {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer.answer === "string") return answer.answer;
  return "";
}

export function extractLatestActionableHumanAnswerText(answers) {
  if (!Array.isArray(answers)) return "";
  for (let i = answers.length - 1; i >= 0; i--) {
    const text = extractHumanAnswerText(answers[i]).trim();
    if (text && text.toLowerCase() !== "(skipped)") return text;
  }
  return "";
}

/**
 * The whole collected response of a text gate: the one answer when every
 * question got the same (or a single) answer, else each question with its
 * answer, skipped ones omitted. A multi-question clarification answered one
 * question at a time used to reach its planner as the last answer alone.
 */
export function collectedHumanAnswerText(answers) {
  if (!Array.isArray(answers)) return "";
  const answered = answers
    .map((answer) => ({
      question: String(answer && typeof answer === "object" ? answer.question || "" : "").trim(),
      answer: extractHumanAnswerText(answer).trim(),
    }))
    .filter((entry) => entry.answer && entry.answer.toLowerCase() !== "(skipped)");
  if (new Set(answered.map((entry) => entry.answer)).size <= 1) {
    return extractLatestActionableHumanAnswerText(answers);
  }
  return answered
    .map((entry) => (entry.question ? `Q: ${entry.question}\nA: ${entry.answer}` : entry.answer))
    .join("\n\n");
}

function parsePayloadValue(value) {
  return parseJsonObject(value);
}

function slashPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveMaybeProjectPath(projectDir, value) {
  if (!value) return "";
  return path.resolve(projectDir || process.cwd(), String(value)).replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathWithinOrEqual(child, root) {
  const c = slashPath(child);
  const r = slashPath(root);
  return !!c && !!r && (c === r || c.startsWith(`${r}/`));
}

function sourceDirHasPromoteMappingFiles(sourceDir, mappings = []) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return false;
  for (const mapping of mappings || []) {
    const pattern = String(mapping?.pattern || "").trim();
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      let found = false;
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(ext)) found = true;
          if (found) return;
        }
      };
      walk(sourceDir);
      if (!found) return false;
    } else if (!fs.existsSync(path.join(sourceDir, pattern))) {
      return false;
    }
  }
  return true;
}

function collectRecoveryOriginalJobs(origJob, origPayload) {
  const jobs = [];
  const seen = new Set();
  const addJob = (job) => {
    if (!job || seen.has(job.id)) return;
    seen.add(job.id);
    jobs.push(job);
  };
  addJob(origJob);

  let cursorPayload = origPayload || {};
  for (let depth = 0; depth < 5; depth++) {
    const priorId = Number(cursorPayload?._dead_letter_recovery?.original_job_id);
    if (!Number.isInteger(priorId) || priorId <= 0 || seen.has(priorId)) break;
    const priorJob = getJob(priorId);
    addJob(priorJob);
    cursorPayload = parsePayloadValue(priorJob?.payload_json);
  }
  return jobs;
}

export function incomingDependenciesForRecoveryRetry(origJob, origPayload) {
  const deps = [];
  const seen = new Set();
  for (const job of collectRecoveryOriginalJobs(origJob, origPayload)) {
    for (const dep of getDependencies(job.id) || []) {
      const key = `${dep.depends_on_job_id}:${dep.dependency_kind || "hard"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push(dep);
    }
  }
  return deps;
}

function repairPromoteRetryPayload(origJob, retryPayload, projectDir, origPayload = {}) {
  if (origJob?.job_type !== "promote") return retryPayload;
  const mappings = Array.isArray(retryPayload?.mappings) ? retryPayload.mappings : [];
  if (mappings.length === 0) return retryPayload;

  const artifactRoot = artifactsDir(wiScopeId(origJob.work_item_id), projectDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const artifactsBase = slashPath(path.dirname(artifactRoot));
  const currentSource = resolveMaybeProjectPath(projectDir, retryPayload.source_dir || "");
  const sourceLooksShared = !currentSource || currentSource === artifactRoot || currentSource === artifactsBase;
  // The runtime validator now accepts promote sources from any work item's
  // artifact namespace, so cross-WI sources (e.g. WI#80 promoting WI#79's
  // generated artifacts) no longer need repair. Only synthesize a new
  // source_dir when the current one is missing, equal to the bare root, or
  // entirely outside `.posse/resources/artifacts/`.
  if (!sourceLooksShared && pathWithinOrEqual(currentSource, artifactsBase)) return retryPayload;

  const outputRoots = [];
  const seenRoots = new Set();
  for (const job of collectRecoveryOriginalJobs(origJob, origPayload)) {
    for (const dep of getDependencies(job.id) || []) {
      const depJob = getJob(dep.depends_on_job_id);
      const depPayload = parsePayloadValue(depJob?.payload_json);
      const root = resolveMaybeProjectPath(projectDir, depPayload.output_root || "");
      if (!root || seenRoots.has(root) || !pathWithinOrEqual(root, artifactRoot) || root === artifactRoot) continue;
      seenRoots.add(root);
      outputRoots.push(root);
    }
  }

  const matchingRoots = outputRoots.filter((root) => sourceDirHasPromoteMappingFiles(root, mappings));
  const selected = matchingRoots.length === 1 ? matchingRoots[0] : outputRoots.length === 1 ? outputRoots[0] : null;
  if (!selected) return retryPayload;

  return {
    ...retryPayload,
    source_dir: selected,
    _dead_letter_recovery: {
      ...(retryPayload._dead_letter_recovery || {}),
      promote_source_dir_repaired: true,
      repaired_source_dir: selected,
    },
  };
}

export function buildDeadLetterRetryPayload(origJob, origPayload, humanAnswer, recoveryJobId, projectDir = process.cwd(), {
  recoveryType = "dead_letter_recovery",
  providerOverride = null,
  failureRepeatKey = null,
} = {}) {
  const retryPayload = { ...(origPayload || {}) };
  const previousRecovery = retryPayload._dead_letter_recovery && typeof retryPayload._dead_letter_recovery === "object"
    ? retryPayload._dead_letter_recovery
    : null;
  const instruction = [
    `Dead-letter recovery from human_input job #${recoveryJobId}:`,
    String(humanAnswer || "").trim() || "(no additional instructions)",
    "",
    "Do not repeat the previous failure mode. If the prior issue involved a gitignored runtime/local file, keep that file out of committed files_to_create and use tracked examples or operator setup notes instead.",
  ].join("\n");
  const previousStallCount = Number(previousRecovery?.stall_recovery_count || 0);
  const previousRecoveryCount = Number(previousRecovery?.recovery_count || 0);
  const recoveryMetadata = {
    original_job_id: origJob.id,
    ...(previousRecovery?.original_job_id ? { prior_original_job_id: previousRecovery.original_job_id } : {}),
    recovery_job_id: recoveryJobId,
    human_answer: String(humanAnswer || ""),
    recovery_count: (Number.isFinite(previousRecoveryCount) && previousRecoveryCount > 0
      ? Math.floor(previousRecoveryCount)
      : 0) + 1,
    ...(providerOverride ? { provider_override: String(providerOverride) } : {}),
    ...(failureRepeatKey ? { failure_repeat_key: String(failureRepeatKey).slice(0, 320) } : {}),
  };
  if (Number.isFinite(previousStallCount) && previousStallCount > 0) {
    recoveryMetadata.stall_recovery_count = Math.floor(previousStallCount);
  }
  if (recoveryType === "stall_exhausted_recovery") {
    recoveryMetadata.recovery_type = "stall_exhausted_recovery";
    recoveryMetadata.stall_recovery_count = (Number.isFinite(previousStallCount) && previousStallCount > 0 ? Math.floor(previousStallCount) : 0) + 1;
  }
  retryPayload._dead_letter_recovery = recoveryMetadata;
  if (typeof retryPayload.task_spec === "string" && retryPayload.task_spec.trim()) {
    retryPayload.task_spec = `${retryPayload.task_spec.trim()}\n\nRECOVERY INSTRUCTIONS:\n${instruction}`;
  } else {
    retryPayload.task_spec = instruction;
  }
  return repairPromoteRetryPayload(origJob, retryPayload, projectDir, origPayload);
}
