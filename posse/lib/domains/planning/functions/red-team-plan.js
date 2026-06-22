import {
  addDependency,
  createJob,
  logEvent,
} from "../../queue/functions/index.js";
import {
  isResearchBudgetDeep,
  normalizeResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES } from "../../../catalog/event.js";

export const RED_TEAM_PLANNING_MODE = "dual_redteam";

export function redTeamPlanningPayload(enabled = false) {
  return enabled ? { planning_mode: RED_TEAM_PLANNING_MODE } : {};
}

export function isRedTeamPlanningPayload(payload = {}) {
  return String(payload?.planning_mode || "").trim().toLowerCase() === RED_TEAM_PLANNING_MODE;
}

function shortTitle(workItem, fallback = null) {
  return String(workItem?.title || fallback || `WI#${workItem?.id || "?"}`).slice(0, 60);
}

function planPayload(basePayload, roleMode, budget, extra = {}) {
  const normalizedBudget = normalizeResearchBudget(budget, "normal");
  return JSON.stringify({
    ...basePayload,
    planning_mode: RED_TEAM_PLANNING_MODE,
    planner_role_mode: roleMode,
    deepthink_budget: normalizedBudget,
    deepthink: isResearchBudgetDeep(normalizedBudget),
    ...extra,
  });
}

export function createRedTeamPlanChain({
  workItem,
  parentJob = null,
  basePayload = {},
  budget = "normal",
  title = null,
  priority = null,
  actorType = "system",
} = {}) {
  if (!workItem?.id) {
    throw new Error("createRedTeamPlanChain requires a work item");
  }

  const wiTitle = shortTitle(workItem, title || parentJob?.title);
  const normalizedBudget = normalizeResearchBudget(budget, "normal");
  const isReplan = !!basePayload?.replan_reason;
  const primaryJob = createJob({
    work_item_id: workItem.id,
    job_type: "plan",
    title: `${isReplan ? "Replan" : "Plan"} (primary): ${wiTitle}`,
    parent_job_id: parentJob?.id || null,
    priority: priority || parentJob?.priority || workItem.priority || "normal",
    model_tier: "standard",
    reasoning_effort: researchBudgetToReasoningEffort(normalizedBudget, "medium"),
    payload_json: planPayload(basePayload, "primary", normalizedBudget, {
      source_research_job_id: parentJob?.job_type === "research" ? parentJob.id : null,
    }),
  });

  const redTeamJob = createJob({
    work_item_id: workItem.id,
    job_type: "plan",
    title: `Plan red-team: ${wiTitle}`,
    parent_job_id: primaryJob.id,
    priority: primaryJob.priority,
    model_tier: "standard",
    reasoning_effort: researchBudgetToReasoningEffort(normalizedBudget, "medium"),
    payload_json: planPayload(basePayload, "redteam", normalizedBudget, {
      primary_plan_job_id: primaryJob.id,
      source_research_job_id: parentJob?.job_type === "research" ? parentJob.id : null,
    }),
  });
  addDependency(redTeamJob.id, primaryJob.id, "hard");

  const synthJob = createJob({
    work_item_id: workItem.id,
    job_type: "plan",
    title: `${isReplan ? "Replan" : "Plan"} synthesis: ${wiTitle}`,
    parent_job_id: redTeamJob.id,
    priority: primaryJob.priority,
    model_tier: "standard",
    reasoning_effort: researchBudgetToReasoningEffort(normalizedBudget, "high"),
    payload_json: planPayload(basePayload, "synth", normalizedBudget, {
      primary_plan_job_id: primaryJob.id,
      red_team_plan_job_id: redTeamJob.id,
      source_research_job_id: parentJob?.job_type === "research" ? parentJob.id : null,
    }),
  });
  addDependency(synthJob.id, primaryJob.id, "hard");
  addDependency(synthJob.id, redTeamJob.id, "hard");

  logEvent({
    work_item_id: workItem.id,
    job_id: synthJob.id,
    event_type: EVENT_TYPES.PLAN_RED_TEAM_CHAIN_CREATED,
    actor_type: actorType,
    message: `Red-team planning chain created: primary #${primaryJob.id}, red-team #${redTeamJob.id}, synthesis #${synthJob.id}`,
    event_json: JSON.stringify({
      primary_plan_job_id: primaryJob.id,
      red_team_plan_job_id: redTeamJob.id,
      synthesis_plan_job_id: synthJob.id,
      parent_job_id: parentJob?.id || null,
    }),
  });

  return { primaryJob, redTeamJob, synthJob };
}
