// lib/domains/worker/functions/helpers/pipeline-continuation.js
//
// Research pipeline continuation helpers extracted from worker.js:
// file-request follow-ups, research->plan chaining, and question extraction.

import fs from "fs";
import path from "path";
import { isRepoFileAccessQuestion } from "./human-question-classifier.js";
import {
  addDependency,
  createJob,
  getArtifactsByWorkItem,
  getDependents,
  listJobsByWorkItem,
  getWorkItem,
  logEvent,
  storeInsight,
  updateWorkItemResearchSkip,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { getRuntimeDbPath } from "../../../runtime/functions/paths.js";
import { parseResearcherStructuredOutput } from "../../../handoff/functions/index.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { getMaxFileRequestDepth } from "../../../settings/functions/tunables.js";
import {
  getResearchFanoutMode,
  logFanoutChildCompleted,
  logFanoutSkipped,
  logFanoutSynthesisCompleted,
  normalizeFanoutBranches,
} from "../../../research/functions/fanout.js";
import { validateScopedPath } from "../../../../shared/scope/functions/validation.js";
import {
  defaultResearchModelTier,
  getResearchBudget,
  isResearchBudgetDeep,
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../../shared/policies/functions/role-utils.js";
import { spawnFromRole } from "../../../queue/functions/spawn-guard.js";
import { ResearchSession } from "../../../research/classes/ResearchSession.js";
import {
  createRedTeamPlanChain,
  isRedTeamPlanningPayload,
  redTeamPlanningPayload,
} from "../../../planning/functions/red-team-plan.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const ALLOWED_BARE_DOTFILES = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".gitignore",
  ".gitattributes",
  ".htaccess",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".eslintignore",
  ".stylelintrc",
  ".prettierignore",
]);

const PREFLIGHT_MODES = new Set(["solo", "fanout_clear"]);

function parsePayload(worker, job) {
  if (typeof worker?.parsePayload === "function") return worker.parsePayload(job);
  return parseJobPayload(job);
}

function findExistingPlanForResearch(researchJob) {
  return listJobsByWorkItem(researchJob.work_item_id)
    .filter((job) =>
      job.job_type === "plan"
      && job.parent_job_id === researchJob.id
      && job.status !== "canceled"
    )
    .sort((a, b) => a.id - b.id)[0] || null;
}

function replanPayloadFields(payload = {}) {
  const fields = {};
  if (payload.replan_reason) fields.replan_reason = payload.replan_reason;
  if (payload.original_job_id != null) fields.original_job_id = payload.original_job_id;
  if (payload.original_title) fields.original_title = payload.original_title;
  return fields;
}

export function parsePreflightRoutingDecision(output, { fallbackBudget = "normal", fallbackReason = null } = {}) {
  const parsedResult = typeof output === "string" ? extractJsonResult(output) : { found: true, value: output, repaired: false };
  const parsed = parsedResult.found && !parsedResult.repaired ? parsedResult.value : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      mode: "solo",
      budget: normalizeResearchBudget(fallbackBudget, "normal"),
      branches: [],
      fallback: true,
      reason: fallbackReason || "preflight returned malformed JSON",
    };
  }

  const mode = PREFLIGHT_MODES.has(parsed.mode) ? parsed.mode : "solo";
  const branches = mode === "fanout_clear" ? normalizeFanoutBranches(parsed.branches).slice(0, 3) : [];
  return {
    mode: mode === "fanout_clear" && branches.length > 0 ? "fanout_clear" : "solo",
    budget: normalizeResearchBudget(parsed.budget, fallbackBudget),
    branches,
    fallback: false,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : null,
  };
}

export function spawnFileRequestFollowUp(worker, originJob, requestsByRisk, attemptId) {
  const originRole = worker?.roleRegistry?.get?.(originJob?.job_type);
  const sanitizeRequests = (requests) => requests.filter((request) => {
    const candidate = String(request?.path || "").replace(/\\/g, "/").trim();
    const basename = path.posix.basename(candidate).toLowerCase();
    const isBarePseudoDotfile = /^\.[a-z0-9_-]+$/.test(basename) && !ALLOWED_BARE_DOTFILES.has(basename);
    return !candidate.includes("*")
      && !candidate.includes("?")
      && !isBarePseudoDotfile
      && !validateScopedPath(candidate, "file_request.path");
  });
  const rawAutoApproved = requestsByRisk?.autoApproved || [];
  const rawNeedsApproval = requestsByRisk?.needsApproval || [];
  const rawRequestCount = rawAutoApproved.length + rawNeedsApproval.length;
  const autoApproved = sanitizeRequests(rawAutoApproved);
  const needsApproval = sanitizeRequests(rawNeedsApproval);
  if (autoApproved.length === 0 && needsApproval.length === 0) {
    if (rawRequestCount > 0) {
      const droppedCount = rawRequestCount - autoApproved.length - needsApproval.length;
      worker.emit(
        originJob.id,
        `${C.yellow}[file-request]${C.reset} WI#${originJob.work_item_id}: ignored ${droppedCount} invalid file request(s) after sanitization`,
      );
      logEvent({
        work_item_id: originJob.work_item_id,
        job_id: originJob.id,
        attempt_id: attemptId || null,
        event_type: EVENT_TYPES.JOB_FILE_REQUEST_SANITIZED_EMPTY,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Ignored ${droppedCount} invalid file request(s) after sanitization`,
        event_json: JSON.stringify({
          requested: rawRequestCount,
          dropped: droppedCount,
        }),
      });
    }
    return;
  }

  // Gather context from the origin job for the follow-up task_spec
  // Dev jobs use task_spec; fix jobs use fix_instructions instead
  const originPayload = worker.parsePayload(originJob);
  const originSpec = originPayload.task_spec
    || originPayload.fix_instructions
    || originJob.title;
  const originDepth = Math.max(0, Number.parseInt(String(originPayload.file_request_depth || 0), 10) || 0);
  const maxFileRequestDepth = getMaxFileRequestDepth();
  if (originDepth >= maxFileRequestDepth) {
    worker.emit(
      originJob.id,
      `${C.yellow}[file-request]${C.reset} WI#${originJob.work_item_id}: skipped follow-up because file request depth ${originDepth} reached limit ${maxFileRequestDepth}`,
    );
    logEvent({
      work_item_id: originJob.work_item_id,
      job_id: originJob.id,
      attempt_id: attemptId || null,
      event_type: EVENT_TYPES.JOB_FILE_REQUEST_DEPTH_LIMIT,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Skipped file-request follow-up at depth ${originDepth}`,
      event_json: JSON.stringify({ depth: originDepth, max_depth: maxFileRequestDepth }),
    });
    return;
  }
  const inheritedPayloadFields = {};
  for (const key of ["task_mode", "output_root", "needs_image_generation"]) {
    if (Object.prototype.hasOwnProperty.call(originPayload, key)) {
      inheritedPayloadFields[key] = originPayload[key];
    }
  }
  const researchArtifacts = getArtifactsByWorkItem(originJob.work_item_id, "summary");
  const projectContext = researchArtifacts.length > 0
    ? researchArtifacts[researchArtifacts.length - 1].content_long
    : "";

  const spawnedDevIds = [];

  // Helper: build a rich task_spec for the file-create dev job
  const buildFileCreateSpec = (files) => {
    const fileDesc = files
      .map(r => `- ${r.path}${r.reason ? ` — ${r.reason}` : ""}`)
      .join("\n");
    const parts = [
      `CONTEXT: This is a file-creation job spawned by job #${originJob.id}.`,
      `The original task was: ${originJob.title}`,
      `Original task spec:\n${originSpec}`,
      ``,
      `FILES TO CREATE:`,
      fileDesc,
      ``,
      `INSTRUCTIONS:`,
      `Create each file listed above. Use the original task spec and project`,
      `context to understand what content each file needs. Read existing files`,
      `in the worktree for patterns, conventions, and imports to follow.`,
      ``,
      `For each file:`,
      `- If the reason describes specific content, implement it fully`,
      `- Match the style and conventions of surrounding code/files`,
      `- Include necessary imports, exports, and boilerplate`,
      `- If the file's purpose is genuinely unclear, create it with a`,
      `  structured placeholder and a TODO comment — but prefer implementing`,
      `  over placeholders`,
    ];
    if (projectContext) {
      parts.push(``, `PROJECT CONTEXT:`, projectContext);
    }
    return parts.join("\n");
  };

  // Helper: deduplicate file paths and derive create_roots from parent dirs
  const buildFileScope = (files) => {
    const uniquePaths = [...new Set(files.map(r => r.path))];
    const parentDirs = [...new Set(uniquePaths.map(f => {
      const dir = f.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
      return dir === f ? "" : dir; // no slash = root-level file -> empty
    }).filter(Boolean))];
    return { filePaths: uniquePaths, createRoots: parentDirs };
  };

  // -- Auto-approved files (low + mid risk): dev job, no gate --
  if (autoApproved.length > 0) {
    const { filePaths } = buildFileScope(autoApproved);
    const riskLabels = autoApproved.map(r => `${r.path} (${r.risk})`).join(", ");

    const devJob = spawnFromRole(originRole, "succeeded", "dev", {
      work_item_id: originJob.work_item_id,
      title: `Create files (auto): ${filePaths.slice(0, 3).join(", ")}${filePaths.length > 3 ? ` (+${filePaths.length - 3})` : ""}`,
      parent_job_id: originJob.id,
      provider: originJob.provider || null,
      priority: originJob.priority || "normal",
      model_tier: originJob.model_tier || "standard",
      reasoning_effort: originJob.reasoning_effort || "medium",
      payload_json: JSON.stringify({
        ...inheritedPayloadFields,
        file_request_depth: originDepth + 1,
        task_spec: buildFileCreateSpec(autoApproved),
        files_to_modify: [],
        files_to_create: filePaths,
        create_roots: [],
        success_criteria: filePaths.map(f => `File ${f} exists with appropriate content`),
      }),
    });

    addDependency(devJob.id, originJob.id, "hard");
    spawnedDevIds.push(devJob.id);

    worker.emit(originJob.id,
      `${C.cyan}[file-request]${C.reset} WI#${originJob.work_item_id}: spawned dev #${devJob.id} for ${autoApproved.length} auto-approved file(s): ${riskLabels}`);

    logEvent({
      work_item_id: originJob.work_item_id,
      job_id: originJob.id,
      attempt_id: attemptId,
      event_type: EVENT_TYPES.JOB_FILE_REQUEST_AUTO,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Auto-approved file creation -> dev #${devJob.id}: ${riskLabels}`,
      event_json: JSON.stringify({ dev_job_id: devJob.id, files: autoApproved }),
    });
  }

  // -- High-risk files: human_input gate -> dev job --
  if (needsApproval.length > 0) {
    const { filePaths: approvalPaths, createRoots: approvalRoots } = buildFileScope(needsApproval);
    const fileDesc = needsApproval
      .map(r => `- ${r.path}${r.reason ? ` — ${r.reason}` : ""}`)
      .join("\n");

    // 1. Human approval gate
    const humanJob = spawnFromRole(originRole, "succeeded", "human_input", {
      work_item_id: originJob.work_item_id,
      title: `Approve files: ${approvalPaths.slice(0, 3).join(", ")}${approvalPaths.length > 3 ? ` (+${approvalPaths.length - 3})` : ""}`,
      parent_job_id: originJob.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: originJob.id,
        questions: [
          [
            `Job #${originJob.id} (${originJob.title}) requests creation of ${approvalPaths.length} high-risk file(s):`,
            fileDesc,
            `These are script/executable/code files.`,
            `Reply with "approve" to continue or "reject" to cancel the gated file-creation job.`,
          ].join("\n"),
        ],
        context: `Original task: ${originSpec.slice(0, 500)}`,
        file_requests: needsApproval,
      }),
    });

    // 2. Dev job to create the files
    const devJob = spawnFromRole(originRole, "succeeded", "dev", {
      work_item_id: originJob.work_item_id,
      title: `Create files (approved): ${approvalPaths.slice(0, 3).join(", ")}${approvalPaths.length > 3 ? ` (+${approvalPaths.length - 3})` : ""}`,
      parent_job_id: originJob.id,
      provider: originJob.provider || null,
      priority: originJob.priority || "normal",
      model_tier: originJob.model_tier || "standard",
      reasoning_effort: originJob.reasoning_effort || "medium",
      payload_json: JSON.stringify({
        ...inheritedPayloadFields,
        file_request_depth: originDepth + 1,
        task_spec: buildFileCreateSpec(needsApproval),
        files_to_modify: [],
        files_to_create: approvalPaths,
        create_roots: approvalRoots,
        success_criteria: approvalPaths.map(f => `File ${f} exists with appropriate content`),
      }),
    });

    addDependency(devJob.id, humanJob.id, "hard");
    addDependency(devJob.id, originJob.id, "hard");
    spawnedDevIds.push(devJob.id);

    worker.emit(originJob.id,
      `${C.yellow}[file-request]${C.reset} WI#${originJob.work_item_id}: spawned approval #${humanJob.id} -> dev #${devJob.id} for ${needsApproval.length} high-risk file(s)`);

    logEvent({
      work_item_id: originJob.work_item_id,
      job_id: originJob.id,
      attempt_id: attemptId,
      event_type: EVENT_TYPES.JOB_FILE_REQUEST_GATED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `High-risk file creation: human #${humanJob.id} -> dev #${devJob.id}: ${approvalPaths.join(", ")}`,
      event_json: JSON.stringify({ human_job_id: humanJob.id, dev_job_id: devJob.id, files: needsApproval }),
    });
  }

  // -- Rewire downstream: jobs depending on origin also depend on file-create --
  if (spawnedDevIds.length > 0) {
    const dependents = getDependents(originJob.id);
    for (const dep of dependents) {
      if (spawnedDevIds.includes(dep.job_id)) continue;
      for (const devId of spawnedDevIds) {
        addDependency(dep.job_id, devId, dep.dependency_kind);
      }
      logEvent({
        job_id: dep.job_id,
        event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Dependency added: #${dep.job_id} now also depends on file-create job(s) ${spawnedDevIds.map(id => "#" + id).join(", ")}`,
      });
    }
  }
}

export function spawnResearchAfterPreflight(worker, preflightJob, output, { fallbackReason = null } = {}) {
  const wi = getWorkItem(preflightJob.work_item_id);
  const preflightPayload = parsePayload(worker, preflightJob);
  const planningPayload = redTeamPlanningPayload(isRedTeamPlanningPayload(preflightPayload));
  const fallbackBudget = normalizeResearchBudget(
    preflightPayload.fallback_budget || preflightPayload.deepthink_budget,
    "normal",
  );
  const decision = parsePreflightRoutingDecision(output, { fallbackBudget, fallbackReason });
  const researchBudget = decision.fallback
    ? decision.budget
    : maxResearchBudget(fallbackBudget, decision.budget);
  const wiTitle = (wi?.title || preflightJob.title.replace(/^Preflight:\s*/i, "") || `WI#${preflightJob.work_item_id}`).slice(0, 60);
  const fanoutMode = decision.mode === "fanout_clear" ? getResearchFanoutMode() : "off";

  if (decision.fallback) {
    logEvent({
      work_item_id: preflightJob.work_item_id,
      job_id: preflightJob.id,
      event_type: EVENT_TYPES.PREFLIGHT_FALLBACK,
      actor_type: EVENT_ACTORS.PREFLIGHT,
      message: `Preflight fallback to solo research: ${decision.reason}`,
      event_json: JSON.stringify({
        reason: decision.reason,
        budget: researchBudget,
      }),
    });
  }

  if (decision.mode === "fanout_clear" && fanoutMode === "on" && wi) {
    const researchSession = new ResearchSession({
      workItem: wi,
      parentJob: preflightJob,
      budget: researchBudget,
      branches: decision.branches,
      options: { actorType: "preflight", mode: fanoutMode },
    });
    const fanout = researchSession.executeFanout({
      workItem: wi,
      parentJob: preflightJob,
      source: "preflight",
      reason: decision.reason || preflightPayload.routing?.reason || null,
      mode: fanoutMode,
      preflightJobId: preflightJob.id,
      extraPayload: planningPayload,
    });
    if (fanout?.synthJob) {
      logEvent({
        work_item_id: preflightJob.work_item_id,
        job_id: fanout.synthJob.id,
        event_type: EVENT_TYPES.PREFLIGHT_ROUTED,
        actor_type: EVENT_ACTORS.PREFLIGHT,
        message: `Preflight routed to active fanout with ${researchBudget} budget`,
        event_json: JSON.stringify({
          mode: decision.mode,
          budget: researchBudget,
          fallback: !!decision.fallback,
          reason: decision.reason,
          branches: decision.branches,
          preflight_job_id: preflightJob.id,
          fanout_execution: "on",
          child_job_ids: fanout.childJobs.map((job) => job.id),
          synth_job_id: fanout.synthJob.id,
        }),
      });
      worker?.emit?.(
        preflightJob.id,
        `${C.cyan}[preflight]${C.reset} WI#${preflightJob.work_item_id}: routed to fanout synthesis #${fanout.synthJob.id} (${researchBudget})`,
      );
      return fanout.synthJob;
    }
  }

  const researchJob = createJob({
    work_item_id: preflightJob.work_item_id,
    job_type: "research",
    title: `Research: ${wiTitle}`,
    parent_job_id: preflightJob.id,
    priority: preflightJob.priority,
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(researchBudget, "medium"),
    payload_json: JSON.stringify({
      deepthink_budget: researchBudget,
      deepthink: isResearchBudgetDeep(researchBudget),
      preflight_job_id: preflightJob.id,
      preflight_mode: decision.mode,
      preflight_branches: decision.branches,
      preflight_reason: decision.reason || preflightPayload.routing?.reason || null,
      ...planningPayload,
    }),
  });

  let shadowFanout = null;
  if (decision.mode === "fanout_clear" && fanoutMode === "shadow" && wi) {
    const researchSession = new ResearchSession({
      workItem: wi,
      parentJob: preflightJob,
      budget: researchBudget,
      branches: decision.branches,
      options: { actorType: "preflight", mode: fanoutMode },
    });
    shadowFanout = researchSession.executeFanout({
      workItem: wi,
      parentJob: preflightJob,
      source: "preflight",
      reason: decision.reason || preflightPayload.routing?.reason || null,
      mode: fanoutMode,
      soloJob: researchJob,
      preflightJobId: preflightJob.id,
      extraPayload: planningPayload,
    });
  }

  logEvent({
    work_item_id: preflightJob.work_item_id,
    job_id: researchJob.id,
    event_type: EVENT_TYPES.PREFLIGHT_ROUTED,
    actor_type: EVENT_ACTORS.PREFLIGHT,
    message: `Preflight routed to ${decision.mode} research with ${researchBudget} budget`,
    event_json: JSON.stringify({
      mode: decision.mode,
      budget: researchBudget,
      fallback: !!decision.fallback,
      reason: decision.reason,
      branches: decision.branches,
      preflight_job_id: preflightJob.id,
      fanout_execution: shadowFanout ? "shadow" : "single_researcher",
      child_job_ids: shadowFanout?.childJobs?.map((job) => job.id) || [],
      synth_job_id: shadowFanout?.synthJob?.id || null,
    }),
  });

  if (decision.mode === "fanout_clear" && !shadowFanout) {
    logFanoutSkipped({
      workItem: wi,
      job: researchJob,
      routing: {
        bucket: "fanout_clear",
        budget: researchBudget,
        reason: decision.reason || null,
        branches: decision.branches,
      },
      source: "preflight",
      actorType: "preflight",
      actualBudget: researchBudget,
      preflightJobId: preflightJob.id,
    });
  }

  worker?.emit?.(
    preflightJob.id,
    `${C.cyan}[preflight]${C.reset} WI#${preflightJob.work_item_id}: routed to research job #${researchJob.id} (${decision.mode}, ${researchBudget})`,
  );
  return researchJob;
}

export function spawnPlanAfterResearch(worker, researchJob, output) {
  const wi = getWorkItem(researchJob.work_item_id);
  if (wi?.research_skipped) {
    updateWorkItemResearchSkip(researchJob.work_item_id, { skipped: false, reason: null });
  }
  let metadata = {};
  try { metadata = wi?.metadata_json ? JSON.parse(wi.metadata_json) : {}; } catch { /* ignore */ }

  const researchPayload = worker.parsePayload(researchJob);
  const planningPayload = redTeamPlanningPayload(isRedTeamPlanningPayload(researchPayload));
  const roleMode = String(researchPayload.role_mode || "solo").trim().toLowerCase();
  const isFanoutChild = roleMode === "child";
  const isFanoutSynth = roleMode === "synth";

  if (isFanoutChild) {
    logFanoutChildCompleted(researchJob, output, researchPayload);
    worker?.emit?.(researchJob.id,
      `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: fanout child complete; waiting for synthesis`);
    return;
  }

  if (isFanoutSynth) {
    logFanoutSynthesisCompleted(researchJob, output, researchPayload);
    if (researchPayload.fanout_shadow === true) {
      worker?.emit?.(researchJob.id,
        `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: shadow fanout synthesis complete; planner remains on solo path`);
      return;
    }
  }

  // -- Detect researcher questions --
  const extractedQuestions = isFanoutSynth ? [] : extractResearcherQuestions(output);
  const hasQuestions = extractedQuestions.length > 0;

  // Is this already a self-resolution attempt? Check payload for the flag.
  const researchBudget = getResearchBudget(wi, researchPayload);
  const isSelfResolve = !!researchPayload._self_resolve;
  const isLoopback = !!researchPayload._is_loopback;
  const clarificationRound = researchPayload._clarification_round || 0;
  const MAX_CLARIFICATION_ROUNDS = 3;

  // -- Question mode: research is the final step --
  // WI completes naturally (all jobs terminal). Save answer to JSON.
  if (metadata.mode === "question") {
    // Even in question mode, if the researcher has questions, we need
    // human answers before we can call this "answered".
    if (hasQuestions) {
      const questions = extractedQuestions;
      const humanJob = createJob({
        work_item_id: researchJob.work_item_id,
        job_type: "human_input",
        title: `Researcher questions: ${wi.title.slice(0, 60)}`,
        parent_job_id: researchJob.id,
        priority: "high",
        model_tier: "cheap",
        payload_json: JSON.stringify({
          original_job_id: researchJob.id,
          questions,
          context: "The researcher needs clarification before the answer is complete.",
        }),
      });
      worker.emit(researchJob.id,
        `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: researcher has ${questions.length} question(s) — spawned human_input #${humanJob.id}`);

      // Spawn a follow-up research job that depends on the human answers.
      // Cap clarification rounds to prevent infinite research->human->research loops.
      const nextRound = clarificationRound + 1;
      if (nextRound > MAX_CLARIFICATION_ROUNDS) {
        worker.emit(researchJob.id,
          `${C.red}[pipeline]${C.reset} WI#${researchJob.work_item_id}: clarification limit (${MAX_CLARIFICATION_ROUNDS}) reached — completing with current research`);
        // Fall through to complete without further research
      } else {
        const followUp = createJob({
          work_item_id: researchJob.work_item_id,
          job_type: "research",
          title: `Research (follow-up): ${wi.title.slice(0, 50)}`,
          parent_job_id: humanJob.id,
          priority: researchJob.priority,
          model_tier: researchJob.model_tier,
          reasoning_effort: researchBudgetToReasoningEffort(researchBudget, researchJob.reasoning_effort || "medium"),
          payload_json: JSON.stringify({
            _is_loopback: true,
            _clarification_round: nextRound,
            deepthink_budget: researchBudget,
            deepthink: isResearchBudgetDeep(researchBudget),
            instructions: "Continue the research with the human's answers incorporated. The previous research brief and human answers are in the artifacts.",
          }),
        });
        addDependency(followUp.id, humanJob.id, "hard");
        worker.emit(researchJob.id,
          `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: spawned follow-up research #${followUp.id} (round ${nextRound}/${MAX_CLARIFICATION_ROUNDS})`);
        return;
      }
    }

    try {
      const dbPath = getRuntimeDbPath();
      const answerDir = path.join(path.dirname(dbPath), "answers");
      fs.mkdirSync(answerDir, { recursive: true });
      fs.writeFileSync(
        path.join(answerDir, `wi-${researchJob.work_item_id}.json`),
        JSON.stringify({
          work_item_id: researchJob.work_item_id,
          title: wi.title,
          answer: output,
          timestamp: new Date().toISOString(),
        }, null, 2),
        "utf-8"
      );
    } catch { /* best effort */ }
    worker.emit(researchJob.id,
      `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: question answered — done`);
    return;
  }

  // -- Builder mode: continue to planning --
  // Use clean WI title - don't derive from parent job title to avoid prefix stacking
  // (e.g. "Plan: Research (follow-up): ..." ). Display prefixes come from jobLabel().
  const wiTitle = (wi?.title || researchJob.title.replace(/^Research(?:\s*\([^)]*\))?:\s*/i, "")).slice(0, 60);

  if (hasQuestions && !isSelfResolve) {
    // Give every information gap one deeper self-resolution pass before
    // bothering the human. This mirrors MemStack's silent pre-flight idea.
    const questions = extractedQuestions;
    const nextRound = isLoopback ? clarificationRound : 0;
    const selfResolveBudget = maxResearchBudget(researchBudget, "high");
    const selfResolve = createJob({
      work_item_id: researchJob.work_item_id,
      job_type: "research",
      title: `Research (self-resolve): ${wiTitle}`,
      parent_job_id: researchJob.id,
      priority: researchJob.priority,
      model_tier: researchJob.model_tier,
      reasoning_effort: researchBudgetToReasoningEffort(selfResolveBudget, "high"),
      payload_json: JSON.stringify({
        _is_loopback: true,
        _self_resolve: true,
        _clarification_round: nextRound,
        ...replanPayloadFields(researchPayload),
        ...planningPayload,
        deepthink_budget: selfResolveBudget,
        deepthink: true,
        instructions: [
          "The previous research pass flagged these open questions:",
          ...questions.map((q, i) => `  ${i + 1}. ${q}`),
          "",
          "Before escalating to the human, silently compile all available information:",
          "read current project context, prior research, recent human answers, config files, README/docs, tests, and git state.",
          "",
          "Investigate the codebase MORE DEEPLY to answer as many as possible.",
          "Look at package.json, config files, READMEs, test fixtures, CI configs,",
          "and any files you skipped the first time.",
          "",
          "If you can answer ALL questions from the codebase, produce your updated",
          "research brief WITHOUT a Questions for Human section.",
          "If some questions genuinely require human judgment (security decisions,",
          "business requirements, naming conventions), keep ONLY those in the",
          "Questions for Human section.",
        ].join("\n"),
      }),
    });
    worker.emit(researchJob.id,
      `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: researcher has ${questions.length} question(s) — trying self-resolution #${selfResolve.id} before asking human`);
    return;
  }

  let terminalHumanGate = null;

  if (hasQuestions && isSelfResolve) {
    // Self-resolution failed, so now escalate to human and remember the
    // information gap for future runs.
    const questions = extractedQuestions;
    try {
      storeInsight({
        work_item_id: researchJob.work_item_id,
        job_id: researchJob.id,
        insight_type: "information_request",
        summary: `Human clarification needed for "${wiTitle}"`,
        detail: questions.slice(0, 5).map((q, i) => `${i + 1}. ${q}`).join("\n").slice(0, 1000),
        file_paths: null,
      });
    } catch { /* best effort */ }
    const humanJob = createJob({
      work_item_id: researchJob.work_item_id,
      job_type: "human_input",
      title: `Researcher questions: ${wiTitle}`,
      parent_job_id: researchJob.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: researchJob.id,
        questions,
        context: "The researcher tried to self-resolve but still needs human clarification before planning can proceed.",
      }),
    });

    const nextRound = clarificationRound + 1;
    if (nextRound > MAX_CLARIFICATION_ROUNDS) {
      terminalHumanGate = humanJob;
      worker.emit(researchJob.id,
        `${C.yellow}[pipeline]${C.reset} WI#${researchJob.work_item_id}: clarification limit (${MAX_CLARIFICATION_ROUNDS}) reached — spawned human_input #${humanJob.id}; planning will wait for the answer`);
      // Fall through to plan creation below, gated on the final human answer.
    } else {
      const followUp = createJob({
        work_item_id: researchJob.work_item_id,
        job_type: "research",
        title: `Research (follow-up): ${wiTitle}`,
        parent_job_id: humanJob.id,
        priority: researchJob.priority,
        model_tier: researchJob.model_tier,
        reasoning_effort: researchBudgetToReasoningEffort(researchBudget, researchJob.reasoning_effort || "medium"),
        payload_json: JSON.stringify({
          _is_loopback: true,
          _clarification_round: nextRound,
          ...replanPayloadFields(researchPayload),
          ...planningPayload,
          deepthink_budget: researchBudget,
          deepthink: isResearchBudgetDeep(researchBudget),
          instructions: "Continue the research with the human's answers incorporated. The previous research brief and human answers are in the artifacts.",
        }),
      });
      addDependency(followUp.id, humanJob.id, "hard");

      worker.emit(researchJob.id,
        `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: self-resolve still has ${questions.length} question(s) — spawned human_input #${humanJob.id}, follow-up research #${followUp.id} (round ${nextRound}/${MAX_CLARIFICATION_ROUNDS})`);
      return;
    }
  }

  const existingPlanJob = findExistingPlanForResearch(researchJob);
  if (existingPlanJob) {
    if (terminalHumanGate) addDependency(existingPlanJob.id, terminalHumanGate.id, "hard");
    worker?.emit?.(researchJob.id,
      `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: existing plan job #${existingPlanJob.id} already follows research #${researchJob.id} - skipping duplicate plan spawn`);
    logEvent({
      work_item_id: researchJob.work_item_id,
      job_id: existingPlanJob.id,
      event_type: EVENT_TYPES.PIPELINE_DUPLICATE_PLAN_SKIPPED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Skipped duplicate plan spawn after research #${researchJob.id}; existing plan #${existingPlanJob.id} already follows it`,
      event_json: JSON.stringify({
        research_job_id: researchJob.id,
        existing_plan_job_id: existingPlanJob.id,
        gated_by_human_job_id: terminalHumanGate?.id || null,
      }),
    });
    return existingPlanJob;
  }

  const basePlanPayload = {
    ...replanPayloadFields(researchPayload),
    deepthink_budget: researchBudget,
    deepthink: isResearchBudgetDeep(researchBudget),
  };
  if (isRedTeamPlanningPayload(researchPayload)) {
    const chain = createRedTeamPlanChain({
      workItem: wi,
      parentJob: researchJob,
      basePayload: basePlanPayload,
      budget: researchBudget,
      title: wiTitle,
      priority: researchJob.priority,
      actorType: "researcher",
    });
    if (terminalHumanGate) addDependency(chain.primaryJob.id, terminalHumanGate.id, "hard");
    worker.emit(researchJob.id,
      `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: spawned red-team planning chain #${chain.primaryJob.id} -> #${chain.redTeamJob.id} -> #${chain.synthJob.id}${terminalHumanGate ? ` gated by human_input #${terminalHumanGate.id}` : ""}`);
    return chain.synthJob;
  }

  const planJob = createJob({
    work_item_id: researchJob.work_item_id,
    job_type: "plan",
    title: researchPayload.replan_reason ? `Replan: ${wiTitle}` : `Plan: ${wiTitle}`,
    parent_job_id: researchJob.id,
    priority: researchJob.priority,
    model_tier: "standard",
    reasoning_effort: researchBudgetToReasoningEffort(researchBudget, "medium"),
    payload_json: JSON.stringify(basePlanPayload),
  });
  if (terminalHumanGate) addDependency(planJob.id, terminalHumanGate.id, "hard");

  worker.emit(researchJob.id,
    `${C.cyan}[pipeline]${C.reset} WI#${researchJob.work_item_id}: spawned plan job #${planJob.id}${terminalHumanGate ? ` gated by human_input #${terminalHumanGate.id}` : ""}`);
}

/**
 * Extract individual questions from researcher output containing QUESTIONS_FOR_HUMAN.
 * Parses the numbered question format: "1. [QUESTION_ID: Q1] ... Question: ..."
 */
export function extractResearcherQuestions(output) {
  const structured = parseResearcherStructuredOutput(output);
  if (structured) {
    const structuredQuestions = Array.isArray(structured.questions) ? structured.questions
      .map(q => {
        if (typeof q === "string") return q.trim();
        if (q && typeof q === "object" && typeof q.question === "string") return q.question.trim();
        return "";
      })
      .filter(Boolean) : [];
    if (structured.questions_for_human === true) {
      return structuredQuestions.filter((q) => !isRepoFileAccessQuestion(q, { context: output }));
    }
  }

  const questions = [];
  let sawQuestionMarker = false;
  // Match numbered question blocks
  const questionRegex = /\d+\.\s*\[QUESTION_ID:\s*Q\d+\][^\n]*\n\s*Question:\s*([^\n]+(?:\n(?!\n)(?!\d+\.\s*\[QUESTION_ID)(?!\s*```)[^\n]*)*)/gi;
  let match;
  while ((match = questionRegex.exec(output)) !== null) {
    sawQuestionMarker = true;
    const q = match[1].trim().replace(/\n\s+/g, " ");
    if (q) questions.push(q);
  }
  // Fallback: if regex didn't match, grab lines after "Questions for Human"
  if (questions.length === 0) {
    const section = output.match(/Questions for Human[\s\S]*$/i);
    if (section) {
      sawQuestionMarker = true;
      const lines = section[0].split("\n").filter(l => /Question:/i.test(l));
      for (const line of lines) {
        const q = line.replace(/.*Question:\s*/i, "").trim();
        if (q) questions.push(q);
      }
    }
  }
  const filteredQuestions = questions.filter((q) => !isRepoFileAccessQuestion(q, { context: output }));
  if (filteredQuestions.length > 0) {
    return filteredQuestions;
  }
  // If the output had an explicit human-question marker but every question
  // was filtered out as self-resolvable, treat it as "no human question".
  if (sawQuestionMarker) {
    return [];
  }
  return [];
}
