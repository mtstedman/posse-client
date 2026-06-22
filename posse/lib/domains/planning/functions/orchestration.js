// Iterative-workflow orchestration: spawn the next research/plan pass,
// detect/finalize terminal iterative work items at wrap-up time, and
// the small red-team-plan glue used during intake.
//
// State-only helpers live in ./state.js. Anything in this file is
// side-effecting (creates jobs, refreshes status, may log events).
// Argv-derived flags (redTeamPlan, iterateRedTeam) and PROJECT_DIR
// arrive as parameters so this module never closes over CLI globals.

import { C } from "../../../shared/format/functions/colors.js";
import {
  addDependency,
  createJob,
  getJob,
  getWorkItem,
  listJobsByWorkItem,
  listWorkItems,
  logEvent,
  refreshWorkItemStatus,
  reopenWorkItemForFollowUp,
  setMergeState,
  updateWorkItemMetadata,
} from "../../queue/functions/index.js";
import {
  ITERATIVE_WORKFLOW_PROFILES,
  getIterativeReloopPrompt,
  getIterativeState,
  getIterativeWorkflowProfile,
  isIterativeWorkItemActive,
  iterativeFollowUpJobsAfter,
  markIterativeFinished,
  metadataRedTeamPlanningEnabled,
  parseWorkItemMetadata,
  persistIterativeState,
  summarizeIterativeReasons,
} from "./state.js";
import { classifyResearchForRouting } from "../../research/functions/intake-routing.js";
import { createRedTeamPlanChain, redTeamPlanningPayload } from "./red-team-plan.js";
import { normalizeIntakeHints } from "../../intake/functions/hints.js";
import { researchPayload } from "../../research/functions/payload.js";
import {
  defaultResearchModelTier,
  getResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { ACTIVE_LEASE_STATUSES, DEADLOCK_TERMINAL_STATUSES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const ACTIVE_LEASE_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);

function awaitedIterativeJobs(state) {
  const ids = [state?.awaitingResearchJobId, state?.awaitingPlanJobId]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  return ids.map((id) => getJob(id)).filter(Boolean);
}

function activeIterativePassStatus(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  if (jobs.some((job) => ACTIVE_LEASE_STATUS_SET.has(job.status))) return "running";
  if (jobs.some((job) => job.status === "queued")) return "planning";
  if (jobs.some((job) => ["blocked", "waiting_on_human", "waiting_on_review"].includes(job.status))) return "blocked";
  return null;
}

function sanitizeTerminalIterativePass(wi, state, { reason = "wrap-up" } = {}) {
  const awaited = awaitedIterativeJobs(state);
  if (awaited.length === 0) return null;
  if (awaited.every((job) => TERMINAL_JOB_STATUS_SET.has(job.status))) return null;
  const nextStatus = activeIterativePassStatus(awaited) || "planning";
  const reopened = reopenWorkItemForFollowUp(wi.id, {
    status: nextStatus,
    reason: "iterative_startup_sanitize",
  });
  if (reopened) {
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_ITERATION_STARTUP_SANITIZED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Reopened active iterative WI from terminal status to ${nextStatus} at ${reason}`,
      event_json: JSON.stringify({
        status: nextStatus,
        reason,
        awaited_jobs: awaited.map((job) => ({
          job_id: job.id,
          job_type: job.job_type,
          status: job.status,
        })),
      }),
    });
  }
  return reopened ? getWorkItem(wi.id) : wi;
}

export function applyIterativeWorkflowProfile(intakeHints, workflowMode, defaultMode = "build") {
  const profile = getIterativeWorkflowProfile(workflowMode);
  return normalizeIntakeHints({
    ...intakeHints,
    intent_type: profile.intent_type,
    intent_type_source: "explicit",
    deliverable_type: profile.deliverable_type,
    deliverable_type_source: "explicit",
    output_mode: profile.output_mode,
    output_mode_source: "explicit",
    desired_outputs_source: "explicit",
    subtasks: [...profile.subtasks, ...(Array.isArray(intakeHints?.subtasks) ? intakeHints.subtasks : [])],
    constraints: [...profile.constraints, ...(Array.isArray(intakeHints?.constraints) ? intakeHints.constraints : [])],
  }, {
    requestText: "",
    fallbackMode: defaultMode,
  });
}

export function shouldUseRedTeamPlanForWorkItem(wi, { redTeamPlan = false, iterateRedTeam = false } = {}) {
  const metadata = parseWorkItemMetadata(wi);
  const iterative = !!(metadata.iterate || metadata.workflow_mode);
  return redTeamPlan ||
    metadataRedTeamPlanningEnabled(metadata) ||
    (iterateRedTeam && iterative);
}

export function shouldPersistIterativeRedTeamPlan({ redTeamPlan = false, iterateRedTeam = false } = {}) {
  return redTeamPlan || iterateRedTeam;
}

export function persistIterativeRedTeamPlanIfRequested(wi, { redTeamPlan = false, iterateRedTeam = false } = {}) {
  if (!wi || !shouldPersistIterativeRedTeamPlan({ redTeamPlan, iterateRedTeam })) return wi;
  const metadata = parseWorkItemMetadata(wi);
  if (!(metadata.iterate || metadata.workflow_mode)) return wi;
  const iteration = metadata.iteration && typeof metadata.iteration === "object" ? metadata.iteration : {};
  if (iteration.red_team_plan === true) return wi;
  metadata.iteration = {
    ...iteration,
    red_team_plan: true,
  };
  updateWorkItemMetadata(wi.id, metadata);
  return getWorkItem(wi.id);
}

export function spawnIterativeNextPass(wi, state, { projectDir, redTeamPlan = false, iterateRedTeam = false } = {}) {
  reopenWorkItemForFollowUp(wi.id, { status: "planning", reason: "iterative_pass" });
  wi = getWorkItem(wi.id) || wi;
  const wiTitle = (wi.title || `WI#${wi.id}`).slice(0, 60);
  const passNumber = state.passCount + 1;
  const mode = state.workflowMode || "iterate";
  const passRedTeamPlan = !!(state.redTeamPlan || redTeamPlan || iterateRedTeam);
  const reloopPrompt = getIterativeReloopPrompt(mode);
  const failureSummary = summarizeIterativeReasons(wi, state.awaitingPlanJobId || null);
  const instructions = [
    `Iterative workflow mode: ${mode}.`,
    `You are preparing pass ${passNumber} of ${state.maxPasses}.`,
    reloopPrompt,
    failureSummary ? `Recent failures or assessor reasons:\n${failureSummary}` : "",
  ].filter(Boolean).join("\n\n");
  const deepthinkBudget = getResearchBudget(wi);
  // Iteration always forces one follow-up research pass, so this classifier
  // call remains telemetry-only even though normal intake routing is live.
  classifyResearchForRouting({ projectDir, workItem: wi, mode, source: "iterate", live: false });

  const reResearchJob = createJob({
    work_item_id: wi.id,
    job_type: "research",
    title: `Research (iterate ${passNumber}): ${wiTitle}`,
    priority: wi.priority,
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(deepthinkBudget, "medium"),
    payload_json: JSON.stringify(researchPayload({
      _is_loopback: true,
      _iterate_pass: passNumber,
      workflow_mode: mode,
      instructions,
      ...redTeamPlanningPayload(passRedTeamPlan),
    }, deepthinkBudget)),
  });

  const planPayload = researchPayload({
    _is_loopback: true,
    _iterate_pass: passNumber,
    workflow_mode: mode,
    replan_reason: instructions,
    original_title: wi.title,
  }, deepthinkBudget);
  let planJob;
  if (passRedTeamPlan) {
    const chain = createRedTeamPlanChain({
      workItem: wi,
      parentJob: reResearchJob,
      basePayload: planPayload,
      budget: deepthinkBudget,
      title: `Iterate (${mode} pass ${passNumber}): ${wiTitle}`,
      priority: wi.priority,
      actorType: "system",
    });
    addDependency(chain.primaryJob.id, reResearchJob.id, "hard");
    planJob = chain.synthJob;
  } else {
    planJob = createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: `Iterate (${mode} pass ${passNumber}): ${wiTitle}`,
      parent_job_id: reResearchJob.id,
      priority: wi.priority,
      model_tier: "standard",
      reasoning_effort: researchBudgetToReasoningEffort(deepthinkBudget, "high"),
      payload_json: JSON.stringify(planPayload),
    });
    addDependency(planJob.id, reResearchJob.id, "hard");
  }
  refreshWorkItemStatus(wi.id);
  const updated = persistIterativeState(wi, {
    workflow_mode: mode,
    auto_approve: true,
    active: true,
    pass_count: passNumber,
    max_passes: state.maxPasses,
    red_team_plan: passRedTeamPlan,
    awaiting_research_job_id: reResearchJob.id,
    awaiting_plan_job_id: planJob.id,
    last_reason: reloopPrompt,
    stop_reason: null,
  });
  logEvent({
    work_item_id: wi.id,
    job_id: planJob.id,
    event_type: EVENT_TYPES.WORK_ITEM_ITERATION_SPAWNED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Spawned iterative pass ${passNumber}/${state.maxPasses} (${mode})${passRedTeamPlan ? " with red-team planning" : ""}`,
    event_json: JSON.stringify({ pass: passNumber, workflow_mode: mode, red_team_plan: passRedTeamPlan }),
  });
  return { updatedWorkItem: updated, researchJobId: reResearchJob.id, planJobId: planJob.id, passNumber, mode, redTeamPlan: passRedTeamPlan };
}

export async function processIterativeWrapUp({
  display = null,
  reason = "wrap-up",
  projectDir,
  redTeamPlan = false,
  iterateRedTeam = false,
  mergeIterativePassToTarget = null,
} = {}) {
  const terminal = listWorkItems(["complete", "failed"]).filter((wi) => isIterativeWorkItemActive(wi));
  if (terminal.length === 0) return { spawned: 0, finalized: 0, rerun: false };

  const say = (message) => {
    if (display) display.addEvent(message);
    else console.log(message);
  };

  let spawned = 0;
  let finalized = 0;
  for (let wi of terminal) {
    const state = getIterativeState(wi);
    if (!state || !state.active) continue;

    const sanitized = sanitizeTerminalIterativePass(wi, state, { reason });
    if (sanitized) {
      say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: reconciled active iterative pass at ${reason}`);
      continue;
    }

    if (state.awaitingPlanJobId) {
      const planJob = getJob(state.awaitingPlanJobId);
      const followUps = iterativeFollowUpJobsAfter(wi.id, state.awaitingPlanJobId);
      if (followUps.length === 0 && planJob?.status === "succeeded") {
        wi = markIterativeFinished(wi, `Iteration complete at ${reason}: no meaningful next pass was planned.`);
        finalized++;
        say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: no further pass planned — iteration complete`);
        continue;
      }
      if (followUps.length === 0 && planJob && DEADLOCK_TERMINAL_STATUSES.includes(planJob.status)) {
        wi = markIterativeFinished(wi, `Iteration stopped at ${reason}: planner pass ${state.passCount} did not complete cleanly.`);
        finalized++;
        say(`  ${C.yellow}[iterate]${C.reset} WI#${wi.id}: iterative planner pass ended without a clean result`);
        continue;
      }

      wi = persistIterativeState(wi, {
        awaiting_plan_job_id: null,
        awaiting_research_job_id: null,
      });
    }

    const refreshed = getIterativeState(wi);
    if (!refreshed || !refreshed.active) continue;
    if (refreshed.passCount >= refreshed.maxPasses) {
      wi = markIterativeFinished(wi, `Iteration cap reached (${refreshed.passCount}/${refreshed.maxPasses}) at ${reason}.`);
      finalized++;
      say(`  ${C.yellow}[iterate]${C.reset} WI#${wi.id}: iteration cap reached (${refreshed.passCount}/${refreshed.maxPasses})`);
      continue;
    }

    if (typeof mergeIterativePassToTarget === "function" && wi.branch_name) {
      const mergeResult = await mergeIterativePassToTarget(wi, {
        passNumber: refreshed.passCount,
        reason,
        display,
      });
      if (!mergeResult.ok) {
        setMergeState(wi.id, "merge_failed");
        wi = markIterativeFinished(
          wi,
          `Iteration blocked at ${reason}: pass merge failed before next loop (${mergeResult.message || "unknown merge error"}).`,
        );
        finalized++;
        logEvent({
          work_item_id: wi.id,
          event_type: EVENT_TYPES.WORK_ITEM_MERGE_FAILED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Iterative pass merge failed before next loop: ${mergeResult.message || "unknown merge error"}`,
          event_json: JSON.stringify({
            pass: refreshed.passCount,
            branch: wi.branch_name,
            target_branch: mergeResult.targetBranch || null,
            reason,
            deferred: mergeResult.deferred === true,
            dirty: mergeResult.dirty === true,
          }),
        });
        say(`  ${C.red}[iterate]${C.reset} WI#${wi.id}: pass merge failed before next loop — ${mergeResult.message || "unknown merge error"}`);
        continue;
      }
      wi = persistIterativeState(wi, {
        last_merged_pass: refreshed.passCount,
        last_merged_branch_tip: mergeResult.sourceBranchTip || null,
        last_merged_target_sha: mergeResult.mergeHash || null,
        last_merged_target_branch: mergeResult.targetBranch || null,
      });
    }

    const spawnedPass = spawnIterativeNextPass(wi, refreshed, { projectDir, redTeamPlan, iterateRedTeam });
    spawned++;
    say(`  ${C.cyan}[iterate]${C.reset} WI#${wi.id}: queued pass ${spawnedPass.passNumber}/${refreshed.maxPasses} (${spawnedPass.mode})`);
  }

  return { spawned, finalized, rerun: spawned > 0 };
}

// Re-export for orchestrator-app.js convenience so the bootDeps
// bundle can collect the iterative + research entry points from a
// single import.
export { listWorkItems, listJobsByWorkItem, ITERATIVE_WORKFLOW_PROFILES };
