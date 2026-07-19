// lib/display/helpers/job-status.js

import { FAILED_JOB_STATUSES, PARKED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../../queue/functions/common.js";
import { MUTATING_JOB_TYPES, QUEUE_LOCKING_JOB_TYPES } from "../../../../../catalog/job.js";

export const JOB_TYPE_ABBR = {
  research: "R",
  preflight: "L",
  plan: "P",
  delegate: "G",
  dev: "D",
  fix: "F",
  artificer: "C",
  assess: "A",
  summarize: "S",
  human_input: "H",
  promote: "M",
  atlas_warm: "W",
};

export const JOB_TYPE_COLORS_KEY = {
  research: "magenta",
  preflight: "blue",
  plan: "cyan",
  delegate: "blue",
  dev: "green",
  fix: "orange",
  artificer: "blue",
  assess: "yellow",
  summarize: "cyan",
  human_input: "yellow",
  promote: "magenta",
  atlas_warm: "cyan",
};

export const BACKGROUND_ATLAS_WARM_JOB_TYPES = new Set(["atlas_warm"]);
export const BACKGROUND_INDEX_JOB_TYPES = BACKGROUND_ATLAS_WARM_JOB_TYPES;

export function jobIsBackgroundAtlasWarm(job) {
  return BACKGROUND_ATLAS_WARM_JOB_TYPES.has(job?.job_type);
}

export function jobIsBackgroundIndex(job) {
  return jobIsBackgroundAtlasWarm(job);
}

export const REVIEW_WRITE_JOB_TYPES = MUTATING_JOB_TYPES;
export const APPROVAL_REPO_WRITE_JOB_TYPES = QUEUE_LOCKING_JOB_TYPES;

export function jobIsWriteStep(job) {
  return REVIEW_WRITE_JOB_TYPES.has(job?.job_type);
}

export function jobIsRepoWriteStep(job) {
  return APPROVAL_REPO_WRITE_JOB_TYPES.has(job?.job_type);
}

export function jobIsReviewVisible(job) {
  return !jobIsBackgroundIndex(job);
}

export function reviewVisibleJobs(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).filter(jobIsReviewVisible);
}

const JOB_FAILURE_STATUSES = new Set(FAILED_JOB_STATUSES);
const PARKED_JOB_STATUS_SET = new Set(PARKED_JOB_STATUSES);

/** Strip redundant job_type prefix from title (e.g., "research: Research X" -> "Research X") */
export function jobLabel(jobType, title) {
  if (/^improvement\s*:/i.test(String(title || ""))) {
    return String(title).replace(/^improvement\s*:\s*/i, "[I] ");
  }
  const lower = title.toLowerCase();
  // Map job_type to words that would be redundant at the start of the title
  const prefixes = {
    research: ["research", "investigate"],
    preflight: ["preflight", "route", "routing"],
    plan: ["plan", "create plan"],
    delegate: ["delegate", "assign"],
    dev: ["develop", "implement", "create", "build", "add"],
    fix: ["fix", "repair"],
    artificer: ["produce", "generate", "create", "export"],
    assess: ["assess", "evaluate", "review"],
    summarize: ["summarize"],
    human_input: ["answer", "respond"],
    promote: ["promote", "copy", "move", "install"],
    atlas_warm: ["atlas warm", "warm"],
  };
  const redundant = prefixes[jobType] || [];
  for (const p of redundant) {
    if (lower.startsWith(p + " ") || lower.startsWith(p + ":")) {
      return title.slice(p.length).replace(/^[\s:]+/, "");
    }
  }
  return title;
}

export function _jobHasSucceededDescendant(job, jobs = []) {
  if (!job?.id) return false;
  const byParent = new Map();
  for (const candidate of jobs) {
    if (!candidate.parent_job_id) continue;
    if (!byParent.has(candidate.parent_job_id)) byParent.set(candidate.parent_job_id, []);
    byParent.get(candidate.parent_job_id).push(candidate);
  }

  const stack = [...(byParent.get(job.id) || [])];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status === "succeeded" && current.job_type !== "human_input") return true;
    stack.push(...(byParent.get(current.id) || []));
  }
  return false;
}

export function jobReportStatus(job, jobs = []) {
  if (JOB_FAILURE_STATUSES.has(job?.status) && _jobHasSucceededDescendant(job, jobs)) {
    return "recovered";
  }
  return job?.status || "unknown";
}

export function jobDisplayStatus(job, jobs = []) {
  return jobReportStatus(job, jobs);
}

export function jobIsDisplayFailure(job, jobs = []) {
  return JOB_FAILURE_STATUSES.has(jobDisplayStatus(job, jobs));
}

export function jobIsDisplaySuccess(job, jobs = []) {
  return ["succeeded", "recovered"].includes(jobDisplayStatus(job, jobs));
}

export function workItemDisplayStatus(wi, jobs = []) {
  const terminal = new Set(TERMINAL_JOB_STATUSES);
  // Merge approval is authoritative. Any review job that raced with merge
  // finalization is stale and must not resurrect the work item in the queue;
  // legitimate follow-up work first clears merge_state through the reopen API.
  if (wi?.merge_state === "merged") return "complete";
  const status = wi?.status || "unknown";
  const activeJobs = jobs.filter((job) => !terminal.has(job.status));
  if (status !== "canceled" && activeJobs.length > 0) {
    if (activeJobs.some((job) => job.status === "waiting_on_human")) return "waiting_on_human";
    if (activeJobs.some((job) => ["running", "leased", "awaiting_assessment"].includes(job.status))) return "running";
    if (activeJobs.some((job) => job.status === "waiting_on_review")) return "waiting_on_review";
    if (activeJobs.some((job) => job.status === "blocked")) return "blocked";
    if (activeJobs.some((job) => job.status === "queued")) {
      return activeJobs.every((job) => ["preflight", "research", "plan"].includes(job.job_type))
        ? "planning"
        : "running";
    }
  }
  if (status !== "failed" || jobs.length === 0) return status;
  if (!jobs.every((job) => terminal.has(job.status))) return wi.status;
  const states = jobs.map((job) => jobDisplayStatus(job, jobs));
  const hasCompletedWork = states.some((status) => status === "succeeded" || status === "recovered");
  return hasCompletedWork && states.every((status) => !JOB_FAILURE_STATUSES.has(status))
    ? "complete"
    : wi.status;
}

export function computeJobProgressStats(jobs = []) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const total = allJobs.length;
  const succeeded = allJobs.filter((job) => jobIsDisplaySuccess(job, allJobs)).length;
  const failed = allJobs.filter((job) => jobIsDisplayFailure(job, allJobs)).length;
  const canceled = allJobs.filter((job) => job?.status === "canceled").length;
  const running = allJobs.filter((job) => job?.status === "running").length;
  const queued = allJobs.filter((job) => job?.status === "queued").length;
  const parked = allJobs.filter((job) => PARKED_JOB_STATUS_SET.has(job?.status)).length;
  const waitingOnHuman = allJobs.filter((job) => job?.status === "waiting_on_human").length;
  const waitingOnReview = allJobs.filter((job) => job?.status === "waiting_on_review").length;
  const blocked = allJobs.filter((job) => job?.status === "blocked").length;
  const assessing = allJobs.filter((job) => job?.status === "awaiting_assessment").length;
  const resolved = succeeded + failed + canceled;
  return {
    total,
    succeeded,
    failed,
    canceled,
    running,
    queued,
    parked,
    waitingOnHuman,
    waitingOnReview,
    blocked,
    assessing,
    resolved,
    fraction: total > 0 ? resolved / total : 0,
  };
}
