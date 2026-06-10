// Read-side helpers for the "iterative workflow" feature: a work item
// can be tagged with workflow_mode (bugfix / ux / refactor / audit /
// iterate) and the orchestrator will repeat research → plan passes up
// to a profile-defined max_passes until the assessor signals it's done
// or the human stops it.
//
// All persistence for this feature lives on work_items.metadata_json,
// so this module is a pure read/write layer over that blob plus a few
// queue helpers — no PROJECT_DIR, no process.argv, no display deps.
// Orchestration (spawning the next pass, intake routing, wrap-up flow)
// stays in orchestrator-app.js for now since it pulls in the broader
// CLI surface.

import { FAILED_JOB_STATUSES, ITERATIVE_SUBSTANTIVE_JOB_TYPES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getWorkItem, listJobsByWorkItem, updateWorkItemMetadata } from "../../queue/functions/index.js";
import { logEvent, flushEventsNow } from "../../queue/functions/events.js";
import { RED_TEAM_PLANNING_MODE } from "./red-team-plan.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

export const ITERATIVE_WORKFLOW_PROFILES = {
  bugfix: {
    intent_type: "bugfix",
    deliverable_type: "code",
    output_mode: "repo",
    deepthink: true,
    max_passes: 3,
    subtasks: [
      "Iterate in bounded bug-fix passes",
      "Prioritize correctness, regressions, and broken states before polish",
    ],
    constraints: [
      "Stop when assessor finds no meaningful remaining bugfix work",
    ],
  },
  ux: {
    intent_type: "task",
    deliverable_type: "code",
    output_mode: "repo",
    deepthink: true,
    max_passes: 3,
    subtasks: [
      "Iterate in bounded UX refinement passes",
      "Prioritize clarity, responsiveness, and usability before cosmetic extras",
    ],
    constraints: [
      "Stop when assessor finds no meaningful UX improvement left",
    ],
  },
  refactor: {
    intent_type: "task",
    deliverable_type: "code",
    output_mode: "repo",
    deepthink: true,
    max_passes: 3,
    subtasks: [
      "Iterate in bounded refactor passes",
      "Preserve behavior while improving structure and maintainability",
    ],
    constraints: [
      "Avoid broad rewrites that do not improve maintainability or safety",
    ],
  },
  audit: {
    intent_type: "analysis",
    deliverable_type: "answer",
    output_mode: "question_only",
    deepthink: true,
    max_passes: 3,
    subtasks: [
      "Iterate on findings until diminishing returns",
      "Report bugs, risks, and regressions before optional fixes",
    ],
    constraints: [
      "Prefer read-only investigation unless the user later asks for code changes",
    ],
  },
  iterate: {
    intent_type: "task",
    deliverable_type: "code",
    output_mode: "repo",
    deepthink: true,
    max_passes: 3,
    subtasks: [
      "Iterate in bounded improvement passes",
      "Let assessor narrow the next pass instead of repeating the same sweep",
    ],
    constraints: [
      "Stop when assessor finds no meaningful new work or confidence is high",
    ],
  },
};

export const ITERATIVE_RELOOP_PROMPTS = {
  bugfix: "Review the completed pass for unresolved bugs, regressions, broken states, or incomplete fixes. Propose one bounded next pass only if a meaningful correctness issue remains. Do not repeat already-completed work.",
  ux: "Review the completed pass for meaningful usability, clarity, accessibility, responsiveness, or visual-consistency issues. Propose one bounded next pass only if the improvement would materially help users. Do not repeat already-completed work.",
  refactor: "Review the completed pass for remaining structural problems, duplication, unsafe complexity, or maintainability issues. Propose one bounded next pass only if behavior can remain stable and the improvement is worth the churn. Do not repeat already-completed work.",
  audit: "Review the completed pass for additional concrete findings with evidence. Propose one bounded next pass only if it is likely to uncover materially new issues rather than restating the same ones.",
  iterate: "Review the completed pass, identify the single highest-value remaining improvement, and propose one bounded next pass only if there is still meaningful work left. Stop if the remaining issues are minor, speculative, or not worth another pass.",
};

export function getIterativeWorkflowProfile(mode) {
  return ITERATIVE_WORKFLOW_PROFILES[mode] || ITERATIVE_WORKFLOW_PROFILES.bugfix;
}

export function getIterativeReloopPrompt(mode) {
  return ITERATIVE_RELOOP_PROMPTS[mode] || ITERATIVE_RELOOP_PROMPTS.iterate;
}

export function parseWorkItemMetadata(wi) {
  try {
    return wi?.metadata_json ? JSON.parse(wi.metadata_json) : {};
  } catch (err) {
    try {
      logEvent({
        work_item_id: wi?.id || null,
        event_type: EVENT_TYPES.WORK_ITEM_METADATA_PARSE_ERROR,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Failed to parse metadata_json: ${(err?.message || String(err)).slice(0, 240)}`,
      });
    } catch {
      // Best effort logging only.
    }
    return {};
  }
}

export function metadataRedTeamPlanningEnabled(metadata = {}) {
  const iteration = metadata?.iteration && typeof metadata.iteration === "object" ? metadata.iteration : {};
  return metadata?.red_team_plan === true ||
    iteration.red_team_plan === true ||
    String(metadata?.planning_mode || "").trim().toLowerCase() === RED_TEAM_PLANNING_MODE;
}

export function getIterativeState(wi) {
  const metadata = parseWorkItemMetadata(wi);
  const workflowMode = metadata.workflow_mode || null;
  const enabled = !!(metadata.iterate || workflowMode);
  if (!enabled) return null;
  const profile = getIterativeWorkflowProfile(workflowMode || "iterate");
  const state = metadata.iteration && typeof metadata.iteration === "object" ? metadata.iteration : {};
  return {
    metadata,
    workflowMode: workflowMode || "iterate",
    enabled: true,
    maxPasses: Number.isFinite(Number(state.max_passes)) ? Math.max(1, Number(state.max_passes)) : profile.max_passes,
    passCount: Number.isFinite(Number(state.pass_count)) ? Math.max(0, Number(state.pass_count)) : 0,
    active: state.active !== false,
    autoApprove: state.auto_approve !== false,
    awaitingPlanJobId: Number.isFinite(Number(state.awaiting_plan_job_id)) ? Number(state.awaiting_plan_job_id) : null,
    awaitingResearchJobId: Number.isFinite(Number(state.awaiting_research_job_id)) ? Number(state.awaiting_research_job_id) : null,
    lastReason: typeof state.last_reason === "string" ? state.last_reason : null,
    redTeamPlan: state.red_team_plan === true || metadataRedTeamPlanningEnabled(metadata),
    stopReason: typeof state.stop_reason === "string" ? state.stop_reason : null,
  };
}

export function persistIterativeState(wi, statePatch) {
  const metadata = parseWorkItemMetadata(wi);
  const existing = metadata.iteration && typeof metadata.iteration === "object" ? metadata.iteration : {};
  metadata.iterate = true;
  if (!metadata.workflow_mode) metadata.workflow_mode = statePatch.workflow_mode || existing.workflow_mode || "iterate";
  metadata.iteration = {
    ...existing,
    ...statePatch,
  };
  updateWorkItemMetadata(wi.id, metadata);
  return getWorkItem(wi.id);
}

export function isIterativeWorkItemActive(wi) {
  const state = getIterativeState(wi);
  return !!(state && state.active);
}

export function isIterativeAwaitingLoopResolution(wi) {
  const state = getIterativeState(wi);
  return !!(state && state.active && state.awaitingPlanJobId);
}

export function isIterativeFinalized(wi) {
  const state = getIterativeState(wi);
  return !!(state && !state.active);
}

export function shouldAutoApproveIterativeWorkItem(wi) {
  const state = getIterativeState(wi);
  return !!(state && !state.active && state.autoApprove);
}

export function hasMergedHistory(wiId) {
  if (!Number.isFinite(Number(wiId))) return false;
  try {
    flushEventsNow();
    const row = getDb().prepare(`
      SELECT 1
      FROM events
      WHERE work_item_id = ?
        AND event_type = '${EVENT_TYPES.WORK_ITEM_MERGED}'
      LIMIT 1
    `).get(wiId);
    return !!row;
  } catch {
    return false;
  }
}

export function summarizeIterativeReasons(wi, anchorJobId = null) {
  const jobs = listJobsByWorkItem(wi.id);
  const relevant = jobs.filter((job) => !anchorJobId || job.id > anchorJobId);
  const reasons = [];
  for (const job of relevant) {
    if (!FAILED_JOB_STATUSES.includes(job.status) || !job.assessor_reason) continue;
    reasons.push(`- ${job.job_type} #${job.id}: ${job.assessor_reason}`);
  }
  return reasons.slice(0, 5).join("\n");
}

export function iterativeFollowUpJobsAfter(wiId, anchorJobId) {
  return listJobsByWorkItem(wiId).filter((job) =>
    job.id > anchorJobId && ITERATIVE_SUBSTANTIVE_JOB_TYPES.has(job.job_type) && job.status !== "canceled"
  );
}

export function markIterativeFinished(wi, reason) {
  const updated = persistIterativeState(wi, {
    active: false,
    awaiting_plan_job_id: null,
    awaiting_research_job_id: null,
    stop_reason: reason,
  });
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_ITERATION_FINISHED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: reason,
    event_json: JSON.stringify({ workflow_mode: parseWorkItemMetadata(updated).workflow_mode || "iterate" }),
  });
  return updated;
}
