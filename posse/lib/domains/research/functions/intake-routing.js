// Outer wrapper around the pure routing classifier in ./routing.js.
// Handles the "live" side effects: caching the project map onto the
// work item, logging telemetry events, and turning a routing decision
// into the actual first plan/research/preflight/fanout job(s).
//
// The pure decision logic stays in routing.js. This module is the
// orchestration layer that orchestrator-app.js used to inline.

import path from "path";
import { execFileSync } from "node:child_process";

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
import { isPlanApprovalEnabled } from "../../planning/functions/plan-approval.js";
import { isHighRiskPath } from "../../handoff/functions/index.js";
import { researchPayload } from "./payload.js";
import { validateScopedPath } from "../../../shared/scope/functions/validation.js";
import {
  defaultResearchModelTier,
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

function normalizeCandidatePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPathInsideProject(projectDir, candidate) {
  if (!projectDir) return false;
  const base = path.resolve(projectDir);
  const resolved = path.resolve(base, candidate);
  const rel = path.relative(base, resolved);
  return !!rel && rel !== "." && !path.isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(`..${path.sep}`);
}

function listTrackedFiles(projectDir, candidates = []) {
  if (!projectDir || candidates.length === 0) return new Map();
  const output = execFileSync("git", ["ls-files", "-z", "--", ...candidates], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const tracked = String(output || "").split("\0").filter(Boolean);
  const byNormalized = new Map();
  for (const file of tracked) {
    const normalized = normalizeCandidatePath(file);
    byNormalized.set(process.platform === "win32" ? normalized.toLowerCase() : normalized, normalized);
  }
  return byNormalized;
}

function validateOneshotGate({ candidateFiles = [], projectDir = null, redTeamPlan = false } = {}) {
  const rawCandidates = Array.isArray(candidateFiles) ? candidateFiles : [];
  const candidates = rawCandidates.map(normalizeCandidatePath).filter(Boolean);
  const results = candidates.map((candidate) => ({
    candidate,
    ok: true,
    checks: {},
    canonical_path: null,
  }));

  const failAll = (reason) => {
    for (const result of results) {
      result.ok = false;
      result.reason = result.reason || reason;
    }
    return { ok: false, reason, candidate_files: candidates, gate_results: results };
  };

  if (candidates.length !== 1) {
    return failAll(`candidate_count_${candidates.length}`);
  }
  if (!projectDir) return failAll("missing_project_dir");
  if (isPlanApprovalEnabled()) return failAll("plan_approval_enabled");
  if (redTeamPlan) return failAll("red_team_plan_requested");

  for (const result of results) {
    const candidate = result.candidate;
    const validationError = validateScopedPath(candidate, "oneshot.candidate_file");
    result.checks.scoped_path = validationError ? { ok: false, reason: validationError } : { ok: true };
    if (validationError) {
      result.ok = false;
      result.reason = validationError;
      continue;
    }

    const contained = isPathInsideProject(projectDir, candidate);
    result.checks.contained = { ok: contained };
    if (!contained) {
      result.ok = false;
      result.reason = "path_outside_project";
      continue;
    }
  }

  let failed = results.find((result) => !result.ok);
  if (failed) {
    return {
      ok: false,
      reason: failed.reason || "candidate_rejected",
      candidate_files: candidates,
      gate_results: results,
    };
  }

  let tracked = new Map();
  try {
    tracked = listTrackedFiles(projectDir, candidates);
  } catch (err) {
    return failAll(`git_tracked_check_failed: ${err?.message || err}`);
  }

  for (const result of results) {
    const candidate = result.candidate;

    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const canonical = tracked.get(key);
    result.checks.git_tracked = canonical ? { ok: true, canonical_path: canonical } : { ok: false };
    if (!canonical) {
      result.ok = false;
      result.reason = "not_git_tracked";
      continue;
    }
    result.canonical_path = canonical;

    const highRisk = isHighRiskPath(canonical);
    result.checks.high_risk_path = { ok: !highRisk };
    if (highRisk) {
      result.ok = false;
      result.reason = "high_risk_path";
      continue;
    }
  }

  failed = results.find((result) => !result.ok);
  if (failed) {
    return {
      ok: false,
      reason: failed.reason || "candidate_rejected",
      candidate_files: candidates,
      gate_results: results,
    };
  }

  return {
    ok: true,
    reason: "accepted",
    candidate_files: [results[0].canonical_path],
    gate_results: results,
  };
}

function workItemText(workItem) {
  return [workItem?.title, workItem?.description]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

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
          candidate_files: routing.candidate_files || [],
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

export function createPlanAfterSkippedResearch(workItem, { routing, budget = "normal", source = null, redTeamPlan = false, parentJob = null } = {}) {
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
      parentJob,
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
    parent_job_id: parentJob?.id || null,
    priority: workItem.priority,
    model_tier: "cheap",
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

export function createOneshotDevJob(workItem, {
  routing,
  source = null,
  projectDir = null,
  candidateFiles = null,
  parentJob = null,
  redTeamPlan = false,
  demotionSource = "intake_gate",
} = {}) {
  const requestedCandidates = candidateFiles || routing?.candidate_files || [];
  const gate = validateOneshotGate({ candidateFiles: requestedCandidates, projectDir, redTeamPlan });
  const reason = routing?.reason || "one-shot trivial edit";
  if (!gate.ok) {
    logEvent({
      work_item_id: workItem.id,
      job_id: parentJob?.id || null,
      event_type: EVENT_TYPES.ONESHOT_DEMOTED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `One-shot demoted to planning: ${gate.reason}`,
      event_json: {
        source,
        demotion_source: demotionSource,
        reason: gate.reason,
        candidate_files: gate.candidate_files,
        gate_results: gate.gate_results,
        routing_reason: reason,
      },
    });
    const planJob = createPlanAfterSkippedResearch(workItem, {
      routing: {
        ...routing,
        bucket: "no_research",
        reason: `one-shot demoted: ${gate.reason}`,
        candidate_files: gate.candidate_files,
      },
      budget: routing?.budget || "low",
      source,
      redTeamPlan,
      parentJob,
    });
    return { kind: "plan", job: planJob, routing, gate, demoted: true };
  }

  const [file] = gate.candidate_files;
  const syntheticRouting = {
    ...routing,
    reason,
    candidate_files: [file],
  };
  updateWorkItemResearchSkip(workItem.id, { skipped: true, reason });
  storeArtifact({
    work_item_id: workItem.id,
    job_id: null,
    artifact_type: "response",
    content_long: buildSyntheticResearchBrief(syntheticRouting),
  });

  const requestedText = workItemText(workItem) || workItem?.title || `WI#${workItem.id}`;
  const taskSpec = [
    requestedText,
    "",
    "This task was machine-derived from the work item with no planner. The work item text above is the authoritative statement of intent; make the smallest change that fully satisfies it.",
  ].join("\n");
  const devJob = createJob({
    work_item_id: workItem.id,
    job_type: "dev",
    title: `One-shot: ${(workItem.title || `WI#${workItem.id}`).slice(0, 60)}`,
    parent_job_id: parentJob?.id || null,
    priority: workItem.priority,
    model_tier: "standard",
    reasoning_effort: "low",
    planner_risk_score: 1,
    payload_json: JSON.stringify({
      task_spec: taskSpec,
      success_criteria: [
        `The requested edit is complete: ${workItem.title || requestedText}`,
        "The change is internally consistent; nothing the request implies was left un-updated.",
      ],
      files_to_modify: [file],
      files_to_create: [],
      files_to_delete: [],
      create_roots: [],
      task_mode: "code",
      dev_mode: "cleanup",
      risk: 1,
      oneshot: true,
      oneshot_origin: true,
      _oneshot_reason: reason,
      _oneshot_source: source === "preflight" ? "preflight" : "intake",
      _assess_model_tier: "standard",
    }),
  });

  refreshWorkItemStatus(workItem.id);
  return { kind: "dev", job: devJob, routing: syntheticRouting, gate, demoted: false };
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
      ...(routing?.bucket === "oneshot_candidate" ? { preflight_objective: "oneshot_scope" } : {}),
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
  if (effectiveRouting.bucket === "oneshot") {
    const outcome = createOneshotDevJob(workItem, {
      routing: effectiveRouting,
      source,
      projectDir,
      candidateFiles: effectiveRouting.candidate_files || [],
      redTeamPlan,
      demotionSource: "intake_gate",
    });
    return { ...outcome, routing: effectiveRouting };
  }
  if (effectiveRouting.bucket === "oneshot_candidate") {
    const job = createPreflightResearchJob(workItem, {
      deepthinkBudget,
      routing: effectiveRouting,
      source,
      redTeamPlan,
      projectDir,
    });
    return { kind: "preflight", job, routing: effectiveRouting };
  }
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
