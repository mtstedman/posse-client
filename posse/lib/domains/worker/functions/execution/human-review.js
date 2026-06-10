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

export function classifyApprovalAnswer(answer) {
  const text = String(answer || "").trim().toLowerCase();
  if (!text || text === "(skipped)") return "unknown";
  if (/\b(reject|rejected|no|n|deny|denied|decline|declined|cancel|canceled|cancelled|block|blocked)\b/.test(text)) return "rejected";
  if (/\b(no|not|never|do not|don't|dont|cannot|can't|wont|won't)\b[\s\S]{0,20}\b(approve|approved|allow|allowed|yes|y|ok|okay|proceed|ship)\b/.test(text)) {
    return "rejected";
  }
  if (/\b(approve|approved|yes|y|allow|allowed|ok|okay|proceed|ship)\b/.test(text)) return "approved";
  return "unknown";
}

export function classifyReviewAnswer(answer) {
  const text = String(answer || "").trim().toLowerCase();
  if (!text || text === "(skipped)") return "unknown";
  if (/\b(retry|re-run|rerun|reassess|re-assess|try again)\b/.test(text)) return "retry";
  if (/\b(replan)\b/.test(text)) return "replan";
  if (/\b(skip|skipped)\b/.test(text)) return "skip";
  if (/\b(pass|passed|approve|approved|yes|y)\b/.test(text)) return "pass";
  if (/\b(fail|failed|reject|rejected|no|n)\b/.test(text)) return "fail";
  return "unknown";
}

function providerFromRecoveryAnswer(answer) {
  const text = String(answer || "").toLowerCase();
  const match = text.match(/\b(claude|openai|codex|grok)\b/);
  return match ? match[1] : null;
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

export function classifyDeadLetterRecoveryAnswer(answer) {
  const text = String(answer || "").trim().toLowerCase();
  if (!text || text === "(skipped)") return { action: "unknown", provider: null };
  const provider = providerFromRecoveryAnswer(text);
  const skipRequested = /\b(skip|skipped|unblock|ignore|bypass)\b/.test(text);
  const skipNegated = /\b(do not|don't|dont|not|never)\s+(skip|unblock|ignore|bypass)\b/.test(text);
  if (skipRequested && !skipNegated) return { action: "skip", provider };
  if (/\b(cancel|canceled|cancelled|abandon|fail|failed|stop)\b/.test(text)) return { action: "fail", provider };
  if (/\b(replan|re-plan|simplify|split|narrow)\b/.test(text)) return { action: "retry", provider };
  if (/\b(retry|rertry|re-try|rerun|re-run|try again|run again)\b/.test(text) || provider) {
    return { action: "retry", provider };
  }
  return { action: "retry", provider };
}

export function classifyPartialWorkRecoveryAnswer(answer) {
  const text = String(answer || "").trim().toLowerCase();
  if (!text || text === "(skipped)") return "unknown";
  if (/\b(extend|resume|continue|more turns?|larger turn|increase turn|retry)\b/.test(text)) return "extend";
  if (/\b(commit|assess|assessment|keep|preserve|save)\b/.test(text)) return "commit";
  if (/\b(revert|discard|drop|dead[- ]?letter|deadletter|abandon|kill|fail)\b/.test(text)) return "revert";
  return "unknown";
}

export function buildDeadLetterRetryPayload(origJob, origPayload, humanAnswer, recoveryJobId, projectDir = process.cwd(), { recoveryType = "dead_letter_recovery" } = {}) {
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
  const recoveryMetadata = {
    original_job_id: origJob.id,
    ...(previousRecovery?.original_job_id ? { prior_original_job_id: previousRecovery.original_job_id } : {}),
    recovery_job_id: recoveryJobId,
    human_answer: String(humanAnswer || ""),
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
