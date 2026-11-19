// @ts-check

import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { parseJobPayload } from "./payload.js";
import { getWorkItemIntakeHints } from "../../intake/functions/hints.js";
import { requiresRepositoryExecution } from "../../intake/functions/objective-contract.js";

export const PIPELINE_BOOTSTRAP_JOB_TYPES = new Set(["preflight", "research", "plan"]);

/**
 * Whether one of these jobs was delegated to a session peer whose merge has
 * reached this clone's trunk (session-job-router.js
 * reconcileSessionDelegationCommits): the executor's work item carried out
 * the execution, so a delegated plan or research job left nothing to run here.
 * Only the originator's rows record `merged` and carry no local work item.
 */
function hasMergedDelegatedExecution(wi, jobs) {
  const jobIds = new Set(getDb().prepare(`
    SELECT origin_job_id FROM work_item_delegations
    WHERE origin_work_item_id = ? AND state = 'merged' AND local_work_item_id IS NULL
  `).all(wi.id).map((row) => Number(row.origin_job_id)));
  return jobs.some((job) => jobIds.has(Number(job.id)));
}

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
  return !jobs.some((job) => MUTATING_JOB_TYPES.has(job.job_type)) && !hasMergedDelegatedExecution(wi, jobs);
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
  return !jobs.some(jobProducesRepositoryOutput) && !hasMergedDelegatedExecution(wi, jobs);
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
