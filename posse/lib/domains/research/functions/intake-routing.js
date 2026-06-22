// Outer wrapper around the pure routing classifier in ./routing.js.
// Handles the "live" side effects: caching the project map onto the
// work item, logging telemetry events, and turning a routing decision
// into the actual first plan/research/preflight/fanout job(s).
//
// The pure decision logic stays in routing.js. This module is the
// orchestration layer that orchestrator-app.js used to inline.

import {
  createJob,
  getWorkItem,
  logEvent,
  refreshWorkItemStatus,
  storeArtifact,
  updateWorkItemMetadata,
  updateWorkItemResearchSkip,
} from "../../queue/functions/index.js";
import { ensureProjectMap, getCachedProjectMap } from "../../project/functions/map.js";
import { parseWorkItemMetadata } from "../../planning/functions/state.js";
import { buildSyntheticResearchBrief, classifyResearchTask } from "./routing.js";
import {
  createResearchFanoutJobs,
  getResearchFanoutMode,
  logFanoutSkipped,
} from "./fanout.js";
import { createRedTeamPlanChain, redTeamPlanningPayload } from "../../planning/functions/red-team-plan.js";
import { researchPayload } from "./payload.js";
import {
  defaultResearchModelTier,
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

export function getProjectMapForResearchRouting(projectDir) {
  try {
    return getCachedProjectMap(projectDir) || ensureProjectMap(projectDir);
  } catch {
    return null;
  }
}

export function classifyResearchForRouting({
  projectDir,
  workItem,
  title = null,
  description = null,
  intakeHints = null,
  mode = null,
  source = null,
  live = false,
} = {}) {
  const metadata = workItem ? parseWorkItemMetadata(workItem) : {};
  const hints = intakeHints ?? metadata.intake_hints ?? {};
  const projectMap = metadata.research_project_map || getProjectMapForResearchRouting(projectDir);
  if (live && workItem?.id && projectMap && !metadata.research_project_map) {
    try {
      updateWorkItemMetadata(workItem.id, { ...metadata, research_project_map: projectMap });
    } catch {
      // Project-map staging is an optimization; routing can still proceed.
    }
  }
  const routing = classifyResearchTask({
    title: title ?? workItem?.title ?? "",
    description: description ?? workItem?.description ?? "",
    intakeHints: hints,
    projectMap,
    mode: mode ?? workItem?.mode ?? metadata.mode ?? null,
  });

  try {
    if (workItem?.id) {
      logEvent({
        work_item_id: workItem.id,
        event_type: live ? EVENT_TYPES.RESEARCH_ROUTING : EVENT_TYPES.RESEARCH_ROUTING_SHADOW,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `${live ? "live" : "shadow"} route ${routing.bucket}/${routing.budget}: ${routing.reason}`,
        event_json: {
          source,
          live,
          bucket: routing.bucket,
          budget: routing.budget,
          reason: routing.reason,
          branches: routing.branches || [],
          web_targets: routing.web_targets || [],
        },
      });
    }
  } catch {
    // Shadow classification must not affect pipeline behavior.
  }

  return routing;
}

export function createPlanAfterSkippedResearch(workItem, { routing, budget = "normal", source = null, redTeamPlan = false } = {}) {
  const deepthinkBudget = normalizeResearchBudget(budget);
  const reason = routing?.reason || "deterministic no_research route";
  updateWorkItemResearchSkip(workItem.id, { skipped: true, reason });
  storeArtifact({
    work_item_id: workItem.id,
    job_id: null,
    artifact_type: "response",
    content_long: buildSyntheticResearchBrief(routing),
  });
  if (redTeamPlan) {
    const chain = createRedTeamPlanChain({
      workItem,
      basePayload: researchPayload({
        research_skipped: true,
        research_skip_reason: reason,
      }, deepthinkBudget),
      budget: deepthinkBudget,
      priority: workItem.priority,
      actorType: "system",
    });
    logEvent({
      work_item_id: workItem.id,
      job_id: chain.synthJob.id,
      event_type: EVENT_TYPES.RESEARCH_SKIPPED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Skipped researcher: ${reason}; spawned red-team planning chain`,
      event_json: {
        source,
        bucket: routing?.bucket || "no_research",
        budget: routing?.budget || deepthinkBudget,
        reason,
        planning_mode: "dual_redteam",
      },
    });
    refreshWorkItemStatus(workItem.id);
    return chain.synthJob;
  }
  const planJob = createJob({
    work_item_id: workItem.id,
    job_type: "plan",
    title: `Plan: ${(workItem.title || `WI#${workItem.id}`).slice(0, 60)}`,
    priority: workItem.priority,
    model_tier: "standard",
    reasoning_effort: researchBudgetToReasoningEffort(deepthinkBudget, "high"),
    payload_json: JSON.stringify(researchPayload({
      research_skipped: true,
      research_skip_reason: reason,
    }, deepthinkBudget)),
  });
  logEvent({
    work_item_id: workItem.id,
    job_id: planJob.id,
    event_type: EVENT_TYPES.RESEARCH_SKIPPED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Skipped researcher: ${reason}`,
    event_json: {
      source,
      bucket: routing?.bucket || "no_research",
      budget: routing?.budget || deepthinkBudget,
      reason,
    },
  });
  refreshWorkItemStatus(workItem.id);
  return planJob;
}

export function createPreflightResearchJob(workItem, {
  deepthinkBudget = "normal",
  routing,
  source = null,
  redTeamPlan = false,
  projectDir = null,
} = {}) {
  const metadata = parseWorkItemMetadata(workItem);
  const fallbackBudget = normalizeResearchBudget(deepthinkBudget, "normal");
  // The preflight role handler reads `payload.routing`,
  // `payload.fallback_budget`, and `payload.project_map` directly
  // (lib/domains/worker/classes/roles/preflight.js). Keep them on the payload —
  // an earlier extraction flattened them into routing_reason/branches/
  // web_targets which nothing consumed, leaving the role to see undefined
  // for all three.
  return createJob({
    work_item_id: workItem.id,
    job_type: "preflight",
    title: `Preflight: ${(workItem.title || `WI#${workItem.id}`).slice(0, 60)}`,
    priority: workItem.priority,
    model_tier: "cheap",
    reasoning_effort: "low",
    payload_json: JSON.stringify(researchPayload({
      project_map: metadata.research_project_map || getProjectMapForResearchRouting(projectDir),
      routing: routing || null,
      fallback_budget: fallbackBudget,
      upstream_mode: workItem.mode || metadata.mode || null,
      upstream_source: source,
      ...redTeamPlanningPayload(redTeamPlan),
    }, fallbackBudget)),
  });
}

export function createInitialResearchOrPlanJob(workItem, { deepthinkBudget, source = null, routing = null, redTeamPlan = false, projectDir = null } = {}) {
  if (!routing) {
    throw new Error("createInitialResearchOrPlanJob requires a precomputed routing decision");
  }
  const effectiveRouting = routing;
  const actualBudget = maxResearchBudget(deepthinkBudget, effectiveRouting.budget);
  const fanoutMode = effectiveRouting.bucket === "fanout_clear" ? getResearchFanoutMode() : "off";
  if (effectiveRouting.bucket === "no_research") {
    return {
      kind: "plan",
      job: createPlanAfterSkippedResearch(workItem, {
        routing: effectiveRouting,
        budget: actualBudget,
        source,
        redTeamPlan,
      }),
      routing: effectiveRouting,
    };
  }
  if (effectiveRouting.bucket === "ambiguous") {
    const job = createPreflightResearchJob(workItem, {
      deepthinkBudget,
      routing: effectiveRouting,
      source,
      redTeamPlan,
      projectDir,
    });
    return { kind: "preflight", job, routing: effectiveRouting };
  }

  if (effectiveRouting.bucket === "web_only_answer") {
    const job = createJob({
      work_item_id: workItem.id,
      job_type: "research",
      title: `Research: ${(workItem.title || `WI#${workItem.id}`).slice(0, 60)}`,
      priority: workItem.priority,
      model_tier: defaultResearchModelTier(),
      reasoning_effort: researchBudgetToReasoningEffort(actualBudget, "medium"),
      payload_json: JSON.stringify(researchPayload({
        ...redTeamPlanningPayload(redTeamPlan),
        web_only_answer: true,
        web_scope_hints: (effectiveRouting.web_targets || [])
          .flatMap((branch) => Array.isArray(branch.scope_hints) ? branch.scope_hints : [])
          .slice(0, 12),
      }, actualBudget)),
    });
    return { kind: "research", job, routing: effectiveRouting };
  }

  if (effectiveRouting.bucket === "fanout_clear") {
    if (fanoutMode === "on") {
      const fanout = createResearchFanoutJobs({
        workItem,
        branches: effectiveRouting.branches,
        budget: actualBudget,
        source,
        reason: effectiveRouting.reason,
        mode: fanoutMode,
        actorType: "system",
        extraPayload: redTeamPlanningPayload(redTeamPlan),
      });
      if (fanout?.synthJob) {
        return { kind: "research_fanout", job: fanout.synthJob, routing: effectiveRouting, fanout };
      }
    }
  }

  const job = createJob({
    work_item_id: workItem.id,
    job_type: "research",
    title: `Research: ${(workItem.title || `WI#${workItem.id}`).slice(0, 60)}`,
    priority: workItem.priority,
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(actualBudget, "medium"),
    payload_json: JSON.stringify(researchPayload({
      ...redTeamPlanningPayload(redTeamPlan),
    }, actualBudget)),
  });
  if (effectiveRouting.bucket === "fanout_clear") {
    if (fanoutMode === "shadow") {
      createResearchFanoutJobs({
        workItem,
        branches: effectiveRouting.branches,
        budget: actualBudget,
        source,
        reason: effectiveRouting.reason,
        mode: fanoutMode,
        soloJob: job,
        actorType: "system",
        extraPayload: redTeamPlanningPayload(redTeamPlan),
      });
    } else {
      logFanoutSkipped({
        workItem,
        job,
        routing: effectiveRouting,
        source,
        actualBudget,
      });
    }
  }
  return { kind: "research", job, routing: effectiveRouting };
}
