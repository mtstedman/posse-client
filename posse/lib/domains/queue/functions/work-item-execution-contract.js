// @ts-check

import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { parseJobPayload } from "./payload.js";
import { getWorkItemIntakeHints } from "../../intake/functions/hints.js";
import { requiresRepositoryExecution } from "../../intake/functions/objective-contract.js";

export const PIPELINE_BOOTSTRAP_JOB_TYPES = new Set(["preflight", "research", "plan"]);

export function parseWorkItemMetadataRecord(wi) {
  try {
    const parsed = wi?.metadata_json ? JSON.parse(wi.metadata_json) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isExplicitResearchOnlyWorkItem(wi) {
  if (!wi) return false;
  if (wi.mode === "report" || wi.source === "ask") return true;
  const metadata = parseWorkItemMetadataRecord(wi);
  if (String(metadata.mode || "").trim().toLowerCase() === "question") return true;
  if (String(metadata.workflow_mode || "").trim().toLowerCase() === "audit") return true;
  const hints = metadata.intake_hints && typeof metadata.intake_hints === "object"
    ? metadata.intake_hints
    : {};
  const outputMode = String(hints.output_mode || "").trim().toLowerCase();
  const outputModeSource = String(hints.output_mode_source || "").trim().toLowerCase();
  return outputMode === "question_only"
    && (!outputModeSource || outputModeSource === "explicit");
}

export function missingRequiredBuildExecution(wi, jobs) {
  if (!wi || wi.mode !== "build" || isExplicitResearchOnlyWorkItem(wi)) return false;
  if (!jobs.some((job) => PIPELINE_BOOTSTRAP_JOB_TYPES.has(job.job_type))) return false;
  return !jobs.some((job) => MUTATING_JOB_TYPES.has(job.job_type));
}

export function jobProducesRepositoryOutput(job) {
  if (!job) return false;
  if (job.job_type === "promote") return true;
  if (job.job_type !== "dev" && job.job_type !== "fix") return false;
  const payload = parseJobPayload(job);
  const taskMode = String(payload.task_mode || "code").trim().toLowerCase();
  return taskMode === "code" || taskMode === "db";
}

export function missingRequiredRepoExecution(wi, jobs) {
  if (!wi || isExplicitResearchOnlyWorkItem(wi)) return false;
  if (!jobs.some((job) => PIPELINE_BOOTSTRAP_JOB_TYPES.has(job.job_type))) return false;
  const intakeHints = getWorkItemIntakeHints(wi, wi.mode || "build");
  if (!requiresRepositoryExecution(wi, intakeHints)) return false;
  return !jobs.some(jobProducesRepositoryOutput);
}

export function missingExecutionReason(wi, jobs) {
  if (missingRequiredRepoExecution(wi, jobs)) return "missing_required_repo_execution";
  if (missingRequiredBuildExecution(wi, jobs)) return "missing_required_build_execution";
  return null;
}

export function isActiveIterativeWorkItemRecord(wi) {
  if (!wi?.metadata_json) return false;
  try {
    const metadata = JSON.parse(wi.metadata_json);
    const iteration = metadata?.iteration && typeof metadata.iteration === "object"
      ? metadata.iteration
      : {};
    return !!(metadata?.iterate || metadata?.workflow_mode) && iteration.active !== false;
  } catch {
    return false;
  }
}
