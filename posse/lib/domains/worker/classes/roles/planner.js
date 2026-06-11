// lib/worker/roles/planner.js
//
// Planner role handler that builds per-work-item task plans, prepares planner
// context bundles, and emits structured tasks for downstream lanes.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import {
  getArtifactsByWorkItem,
  getAttempts,
  getIntSetting,
  getJob,
  getSetting,
  getWorkItem,
  logEvent,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import {
  artifactsDir,
  contextDir,
  getConfiguredImageProviders,
  getResolvedImageProtocol,
  inputsDir,
  wiScopeId,
  workspaceDir,
} from "../../../artifacts/functions/index.js";
import {
  composePromptRemoteAware,
  handoff,
  normalizeResearcherFilePriorities,
  normalizeResearcherKeySymbols,
  parseResearcherStructuredOutput,
  renderAtlasHandoffSections,
  _parseFunctions,
} from "../../../handoff/functions/index.js";
import { resolvePlannerBudgetFromResearchScope } from "../../../handoff/functions/helpers/execution-policy.js";
import { buildSyntheticResearchBrief } from "../../../research/functions/routing.js";
import {
  buildIntakeHintsBlock,
  getWorkItemIntakeHints,
  getWorkItemWorkflowConfig,
  buildWorkflowModeBlock,
} from "../../functions/helpers/intake-hints.js";
import { currentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import { getExplicitIntakeBindings } from "../../functions/helpers/plan-routing.js";
import { resolvePathWithin } from "../../functions/helpers/scope.js";
import { getProviderName, isProviderReady } from "../../../providers/functions/provider.js";
import { getDefaultImageModel } from "../../../providers/functions/model-catalog.js";
import { isSensitiveEnvFilePath, safePath } from "../../../../functions/toolkit/index.js";
import { getEnabledSkillsForRole } from "../../../../shared/skills/functions/registry.js";
import { promptPersistenceSummary } from "../../../../shared/telemetry/functions/logging/prompt-persistence.js";
import {
  isRedTeamPlanningPayload,
  RED_TEAM_PLANNING_MODE,
} from "../../../planning/functions/red-team-plan.js";
import { BaseRole } from "../BaseRole.js";
import {
  classifyPlannerOutput as defaultClassifyPlannerOutput,
  getResearchBudget as defaultGetResearchBudget,
  isDeepthinkTask as defaultIsDeepthinkTask,
  isResearchBudgetDeep as defaultIsResearchBudgetDeep,
  researchBudgetPromptBlock as defaultResearchBudgetPromptBlock,
  researchBudgetToMaxTurnsOverride as defaultResearchBudgetToMaxTurnsOverride,
  researchBudgetToReasoningEffort as defaultResearchBudgetToReasoningEffort,
  shortJobTitle as defaultShortJobTitle,
  unwrapTaskArray as defaultUnwrapTaskArray,
} from "../../functions/helpers/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../functions/helpers/role-spawn-policies.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const DEFAULT_DEPS = {
  classifyPlannerOutput: defaultClassifyPlannerOutput,
  getResearchBudget: defaultGetResearchBudget,
  isDeepthinkTask: defaultIsDeepthinkTask,
  isResearchBudgetDeep: defaultIsResearchBudgetDeep,
  loadNudges: () => "",
  logBadInputFailure: () => {},
  researchBudgetPromptBlock: defaultResearchBudgetPromptBlock,
  researchBudgetToMaxTurnsOverride: defaultResearchBudgetToMaxTurnsOverride,
  researchBudgetToReasoningEffort: defaultResearchBudgetToReasoningEffort,
  shortJobTitle: defaultShortJobTitle,
  unwrapTaskArray: defaultUnwrapTaskArray,
};

function emit(worker, jobId, message) {
  if (typeof worker?.emit === "function") {
    worker.emit(jobId, message);
  }
}

function normalizePlannerRoleMode(value) {
  const raw = String(value || "normal").trim().toLowerCase();
  return ["normal", "primary", "redteam", "synth"].includes(raw) ? raw : "normal";
}

function researcherPathFromValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.path === "string") return value.path;
  return "";
}

function sanitizeResearcherFileList(values, projectDir, field) {
  const files = [];
  const dropped = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : [];

  const drop = (value, reason) => {
    dropped.push({
      field,
      path: researcherPathFromValue(value) || String(value ?? ""),
      reason,
    });
  };

  for (const value of list) {
    const raw = researcherPathFromValue(value).trim();
    if (!raw) {
      drop(value, "empty");
      continue;
    }
    if (raw.includes("\0")) {
      drop(value, "nul_byte");
      continue;
    }

    const slashPath = raw.replace(/\\/g, "/");
    if (path.isAbsolute(raw) || path.posix.isAbsolute(slashPath) || /^[A-Za-z]:\//.test(slashPath)) {
      drop(value, "absolute_path");
      continue;
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      drop(value, "path_traversal");
      continue;
    }
    if (isSensitiveEnvFilePath(normalized)) {
      drop(value, "sensitive_env");
      continue;
    }
    const parts = normalized.toLowerCase().split("/").filter(Boolean);
    if (parts.some((part) => part === ".git" || part === ".claude" || part === ".codex")) {
      drop(value, "private_workspace_metadata");
      continue;
    }
    if (parts[0] === ".posse" && parts[1] !== "resources") {
      drop(value, "private_workspace_metadata");
      continue;
    }

    const resolved = resolvePathWithin(projectDir, normalized, { allowEqual: false });
    if (!resolved) {
      drop(value, "outside_project_scope");
      continue;
    }
    try {
      safePath(projectDir, normalized);
    } catch {
      drop(value, "private_workspace_metadata");
      continue;
    }

    const rel = path.relative(projectDir, resolved).replace(/\\/g, "/");
    if (!rel || rel === "." || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }

  return { files, dropped };
}

function sanitizeResearcherFilePriorities(parsed, projectDir) {
  const files = [];
  const dropped = [];
  const seen = new Set();
  const priorities = normalizeResearcherFilePriorities(parsed);

  for (const entry of priorities) {
    const sanitized = sanitizeResearcherFileList([entry.path], projectDir, "planner_file_priorities");
    dropped.push(...sanitized.dropped);
    const rel = sanitized.files[0];
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push({
      ...entry,
      path: rel,
      rank: files.length + 1,
    });
  }

  return { files, dropped };
}

function oneLine(value, max = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function renderPlannerFilePriorities(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return [
    "# Planner File Priorities",
    "",
    "Researcher-ranked files for planning order and scope. Use these as the first read targets, then fall back to the full brief when detail is missing.",
    "",
    ...entries.map((entry) => {
      const details = [
        entry.usefulness && entry.usefulness !== "unspecified" ? `usefulness=${oneLine(entry.usefulness, 60)}` : "",
        entry.evidence && entry.evidence !== "unspecified" ? `evidence=${oneLine(entry.evidence, 60)}` : "",
        entry.reason ? oneLine(entry.reason, 200) : "",
      ].filter(Boolean);
      return `${entry.rank}. ${entry.path}${details.length > 0 ? ` - ${details.join("; ")}` : ""}`;
    }),
    "",
  ].join("\n");
}

function latestPlanArtifactText(workItemId, jobId, preferredTypes = []) {
  if (!jobId) return "";
  const artifacts = getArtifactsByWorkItem(workItemId)
    .filter((artifact) => Number(artifact.job_id) === Number(jobId));
  for (const type of preferredTypes) {
    const match = artifacts
      .filter((artifact) => artifact.artifact_type === type)
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
    if (match?.content_long) return match.content_long;
  }
  const fallback = artifacts
    .filter((artifact) => artifact.content_long)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  return fallback?.content_long || "";
}

function buildPlanSynthesisArtifact(ctx, output) {
  return [
    "# Red-Team Planning Synthesis",
    "",
    `work_item_id: ${ctx.workItem?.id ?? "unknown"}`,
    `primary_plan_job_id: ${ctx.payload?.primary_plan_job_id ?? "unknown"}`,
    `red_team_plan_job_id: ${ctx.payload?.red_team_plan_job_id ?? "unknown"}`,
    "",
    "## Primary Planner Output",
    ctx.primaryPlanText || "(missing)",
    "",
    "## Red-Team Planner Output",
    ctx.redTeamPlanText || "(missing)",
    "",
    "## Synthesized Write-Layer Plan",
    output || "(empty)",
  ].join("\n");
}

export class PlannerRole extends BaseRole {
  static role = "planner";
  static spawnsOnSuccess = spawnSuccessForRole("planner");
  static spawnsOnFailure = spawnFailureForRole("planner");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  buildContract({ job, ctx } = {}) {
    const {
      loadNudges,
      researchBudgetPromptBlock,
    } = this.roleDeps();
    const plannerCtx = ctx || {};
    const dualMode = plannerCtx.planningMode === RED_TEAM_PLANNING_MODE;
    const roleMode = plannerCtx.plannerRoleMode || "normal";
    if (dualMode && roleMode === "redteam") {
      return [
        "You are the RED-TEAM PLANNER in a pre-write planning review.",
        "Your job is to critique the primary planner's candidate plan before any write-layer jobs are created.",
        "",
        researchBudgetPromptBlock(plannerCtx.researchBudget, "planner"),
        "",
        plannerCtx.workflowModeBlock,
        plannerCtx.plannerOutputBindingRules,
        plannerCtx.desiredOutputsBlock,
        job ? loadNudges(job.id) : "",
        plannerCtx.plannerRoutingContext,
        plannerCtx.projectDir ? `You have Read, Glob, and Grep tools. Project root: ${plannerCtx.projectDir.replace(/\\/g, "/")}` : null,
        "",
        "Do NOT emit the final executable task JSON array.",
        "Do NOT create a compromise plan by averaging ideas.",
        "Attack the plan for user-intent misses, UX/domain-fit misses, missing states, brittle architecture, unsafe scope, bad dependencies, wrong role routing, and weak verification.",
        "Output Markdown with these sections: Summary, Critical Risks, Missing UX/Product Concerns, Architectural/Scope Concerns, Concrete Corrections, Synthesis Guidance.",
      ].filter(Boolean).join("\n");
    }

    const modeInstructions = dualMode && roleMode === "primary"
      ? [
          "DUAL PLANNING MODE: PRIMARY PLANNER.",
          "Create the best candidate plan, but this output will be reviewed by a red-team planner and will not directly create write-layer jobs.",
          "Still output the normal JSON task array so the synthesis planner can compare concrete task structure.",
          "",
        ].join("\n")
      : dualMode && roleMode === "synth"
        ? [
            "DUAL PLANNING MODE: SYNTHESIS PLANNER.",
            "You are the only planner in this chain allowed to emit the final executable task JSON array.",
            "Use the research brief, the primary planner output, and the red-team critique to produce one authoritative write-layer plan.",
            "Preserve the strongest parts of the primary plan, apply concrete red-team corrections, and avoid blending incompatible approaches.",
            "Output the final JSON task array using the standard planner contract.",
            "",
          ].join("\n")
        : "";

    return [
      modeInstructions,
      ...(plannerCtx.modeConstraints || []),
      "Create a development plan for the following work item.",
      "",
      researchBudgetPromptBlock(plannerCtx.researchBudget, "planner"),
      "",
      plannerCtx.workflowModeBlock,
      plannerCtx.plannerOutputBindingRules,
      plannerCtx.desiredOutputsBlock,
      job ? loadNudges(job.id) : "",
      plannerCtx.plannerRoutingContext,
      plannerCtx.projectDir ? `You have Read, Glob, and Grep tools. Project root: ${plannerCtx.projectDir.replace(/\\/g, "/")}` : null,
      "",
      "Output a JSON array of tasks. Each task must have: title, task_spec, job_type, success_criteria, depends_on_index.",
      "Optional: model_tier and reasoning_effort are planner hints; deterministic scope/risk policy may lower or raise them before dispatch.",
      "For repo code tasks (job_type \"dev\", task_mode \"code\"), include dev_mode using one allowed value from the planner dev-mode contract.",
      "Optional: skills: [\"<id>\", ...] for dev code tasks only. Choose only ids listed in Available dev skills; omit skills when none apply. Do not set skills on artificer, promote, or human_input tasks.",
      "Optional: deepthink_budget: \"low\" | \"normal\" | \"high\" | \"xhigh\" for tasks that need lower or higher analysis/tool-turn budget. Legacy deepthink: true is also accepted and maps to high.",
      "For repo code tasks, include risk: 1-5, risk_tags: [\"auth\" | \"security\" | \"schema\" | \"migration\" | \"persistence\" | \"delete\" | \"payment\" | \"concurrency\" | \"git\", ...], scope_confidence: \"high\" | \"medium\" | \"low\", and score_reasons: [\"...\"].",
      "Do not emit complexity; downstream budget is derived from declared scope, risk, verification path, and deterministic structural facts.",
      "If job_type is \"promote\", also include mappings: [{ pattern, dest }] and optionally source_dir. Use promote for deterministic artifact copies from .posse/resources/artifacts into repo paths.",
      "For repo code tasks, include file scope explicitly: files_to_modify (existing files to edit), files_to_create (exact new files), files_to_delete (exact existing files to remove), and create_roots only when a free-write directory is truly needed.",
      "For non-code tasks, artifact tasks, promote tasks, and human_input tasks, omit files_to_modify unless the task genuinely edits an existing repo file.",
      "Use files_to_delete whenever a task requires removing files. Do not hide deletions inside prose alone.",
      "For report/content/image/intake_processing tasks, use the absolute artifact directories above as output_root and create_roots. These paths are stable across all execution contexts.",
    ].filter(Boolean).join("\n");
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const {
      getResearchBudget,
    } = this.roleDeps();

    const workItem = getWorkItem(job.work_item_id);
    const payload = worker.parsePayload(job);
    const planningMode = isRedTeamPlanningPayload(payload) ? RED_TEAM_PLANNING_MODE : "normal";
    const plannerRoleMode = planningMode === RED_TEAM_PLANNING_MODE
      ? normalizePlannerRoleMode(payload.planner_role_mode)
      : "normal";
    const primaryPlanText = latestPlanArtifactText(
      job.work_item_id,
      payload.primary_plan_job_id,
      ["plan_primary", "response"],
    );
    const redTeamPlanText = latestPlanArtifactText(
      job.work_item_id,
      payload.red_team_plan_job_id,
      ["plan_redteam", "response"],
    );
    const researchBudget = getResearchBudget(workItem, payload);
    const intakeHints = getWorkItemIntakeHints(workItem, workItem?.mode || "build");
    const intakeHintsBlock = buildIntakeHintsBlock(intakeHints);
    const workflowModeBlock = buildWorkflowModeBlock(getWorkItemWorkflowConfig(workItem), "planner");

    const ctxDir = contextDir(wiScopeId(job.work_item_id), worker.projectDir);
    const fastDir = path.join(ctxDir, "planner", "fast");
    const fullDir = path.join(ctxDir, "planner", "full");
    const researchSkipped = !!workItem?.research_skipped;
    const researchArtifacts = getArtifactsByWorkItem(job.work_item_id, "response")
      .filter((artifact) => {
        if (researchSkipped && artifact.job_id == null) return true;
        const relatedJob = getJob(artifact.job_id);
        if (!relatedJob || relatedJob.job_type !== "research") return false;
        const relatedPayload = parseJobPayload(relatedJob);
        if (relatedPayload?.role_mode === "child") return false;
        if (relatedPayload?.fanout_shadow === true) return false;
        return true;
      });

    let keyFiles = [];
    let keySymbols = [];
    let relatedFiles = [];
    let plannerFilePriorities = [];
    let structuredData = null;
    let researchBrief = "";
    let lastRawResearchBrief = "";
    const droppedResearcherPaths = [];
    for (const artifact of researchArtifacts) {
      const artifactContent = artifact.content_long || "";
      lastRawResearchBrief = artifactContent;
      const parsed = parseResearcherStructuredOutput(artifactContent);
      if (!parsed) continue;
      // Keep the authoritative brief paired with the structured data it parsed
      // from: only the last fully-parsed artifact wins. A trailing unparseable
      // artifact must not leave the brief and structuredData sourced from
      // different artifacts.
      researchBrief = artifactContent;
      const sanitizedKeyFiles = sanitizeResearcherFileList(parsed.key_files, worker.projectDir, "key_files");
      const sanitizedRelatedFiles = sanitizeResearcherFileList(parsed.related_files, worker.projectDir, "related_files");
      const sanitizedPlannerPriorities = sanitizeResearcherFilePriorities(parsed, worker.projectDir);
      const artifactDroppedResearcherPaths = [
        ...sanitizedKeyFiles.dropped,
        ...sanitizedRelatedFiles.dropped,
        ...sanitizedPlannerPriorities.dropped,
      ];
      droppedResearcherPaths.push(...artifactDroppedResearcherPaths);
      const priorityPaths = sanitizedPlannerPriorities.files.map((entry) => entry.path);
      keyFiles = priorityPaths.length > 0
        ? [...new Set([...priorityPaths, ...sanitizedKeyFiles.files])]
        : sanitizedKeyFiles.files;
      keySymbols = normalizeResearcherKeySymbols(parsed);
      relatedFiles = sanitizedRelatedFiles.files;
      plannerFilePriorities = sanitizedPlannerPriorities.files;
      structuredData = {
        ...parsed,
        key_files: keyFiles,
        key_symbols: keySymbols,
        related_files: relatedFiles,
      };
      delete structuredData.ranked_files;
      if (plannerFilePriorities.length > 0 || Array.isArray(parsed.planner_file_priorities) || Array.isArray(parsed.ranked_files)) {
        structuredData.planner_file_priorities = plannerFilePriorities;
      }
      if (artifactDroppedResearcherPaths.length > 0) {
        structuredData.dropped_research_files = artifactDroppedResearcherPaths;
      }
    }
    // No artifact parsed into structured output: fall back to the most recent
    // raw artifact content so a freeform brief is still surfaced (structuredData
    // stays null, matching the absence of parseable structure).
    if (!researchBrief) researchBrief = lastRawResearchBrief;
    if (researchSkipped && !researchBrief) {
      researchBrief = buildSyntheticResearchBrief(workItem.research_skip_reason || "deterministic no_research route");
      structuredData = parseResearcherStructuredOutput(researchBrief);
    }
    const researchScopePolicy = resolvePlannerBudgetFromResearchScope({
      keyFiles,
      relatedFiles,
      plannerFilePriorities,
      scopeEstimate: structuredData?.scope_estimate,
      currentBudget: researchBudget,
    });
    if (structuredData) {
      structuredData.research_scope_policy = researchScopePolicy;
    }
    if (researchScopePolicy.budget !== researchBudget) {
      emit(worker, job.id, `${C.cyan}[planner-budget]${C.reset} WI#${job.work_item_id}: research scope raised planner budget ${researchBudget} -> ${researchScopePolicy.budget} (${researchScopePolicy.reasons.join(", ") || "scope policy"})`);
    }
    if (droppedResearcherPaths.length > 0) {
      const message = `Dropped ${droppedResearcherPaths.length} researcher-provided planner context path(s): ${droppedResearcherPaths.slice(0, 5).map((entry) => `${entry.field}:${entry.path || "(empty)"}:${entry.reason}`).join(", ")}`;
      emit(worker, job.id, `${C.yellow}[context]${C.reset} WI#${job.work_item_id}: ${message}`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx?.attemptId || null,
        event_type: EVENT_TYPES.PLANNER_RESEARCH_PATHS_DROPPED,
        actor_type: EVENT_ACTORS.WORKER,
        message,
        event_json: JSON.stringify({ dropped: droppedResearcherPaths.slice(0, 100) }),
      });
    }
    const fullFiles = [...new Set([...keyFiles, ...relatedFiles])];

    let fullCount = 0;
    let fastFileCount = 0;
    const funcLines = [];

    try {
      fs.mkdirSync(fastDir, { recursive: true });

      if (researchBrief) {
        fs.writeFileSync(path.join(fastDir, "brief.md"), researchBrief, "utf-8");
        fastFileCount++;
      }

      if (structuredData) {
        fs.writeFileSync(path.join(fastDir, "research.json"), JSON.stringify(structuredData, null, 2), "utf-8");
        fastFileCount++;
      }

      const priorityText = renderPlannerFilePriorities(plannerFilePriorities);
      if (priorityText) {
        fs.writeFileSync(path.join(fastDir, "file-priorities.md"), priorityText, "utf-8");
        fastFileCount++;
      }

      for (const filePath of keyFiles) {
        try {
          const src = path.resolve(worker.projectDir, filePath);
          const content = fs.readFileSync(src, "utf-8");
          if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(filePath)) {
            funcLines.push(`## ${filePath}`, `(non-JS file - ${content.split("\n").length} lines)`, "");
            continue;
          }
          const funcs = _parseFunctions(content);
          if (funcs.length === 0) {
            funcLines.push(`## ${filePath}`, `(no functions/classes found - ${content.split("\n").length} lines)`, "");
            continue;
          }
          funcLines.push(`## ${filePath}`);
          for (const fn of funcs) {
            funcLines.push(`- **${fn.name}** [lines ${fn.startLine}-${fn.endLine}]: \`${fn.signature.slice(0, 120)}\``);
          }
          funcLines.push("");
        } catch (fileErr) {
          const reason = fileErr.code === "ENOENT" ? "file not found" : `error: ${fileErr.message?.split("\n")[0]?.slice(0, 80)}`;
          funcLines.push(`## ${filePath}`, `(${reason})`, "");
        }
      }
      if (funcLines.length > 0) {
        fs.writeFileSync(path.join(fastDir, "functions.md"), funcLines.join("\n"), "utf-8");
        fastFileCount++;
      }

      if (fullFiles.length > 0) {
        fs.mkdirSync(fullDir, { recursive: true });
        for (const filePath of fullFiles) {
          try {
            const src = path.resolve(worker.projectDir, filePath);
            const dest = path.join(fullDir, filePath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            fullCount++;
          } catch {}
        }
      }

      if (fastFileCount > 0 || fullCount > 0) {
        emit(worker, job.id, `${C.cyan}[context]${C.reset} WI#${job.work_item_id}: fast/ ${fastFileCount} ref file(s), full/ ${fullCount} source file(s)`);
      }
    } catch (ctxErr) {
      emit(worker, job.id, `${C.yellow}[context]${C.reset} WI#${job.work_item_id}: context dir build failed (${ctxErr.message?.split("\n")[0]?.slice(0, 80)}) - planner will use tools`);
      fastFileCount = 0;
      fullCount = 0;
    }

    validatePlannerContextPreflight(worker, job, ctx.attemptId, {
      fastDir,
      researchArtifacts,
    });

    const humanAnswers = getArtifactsByWorkItem(job.work_item_id, "response")
      .filter((artifact) => {
        const relatedJob = getJob(artifact.job_id);
        return relatedJob && relatedJob.job_type === "human_input";
      })
      .map((artifact) => artifact.content_long)
      .join("\n\n---\n\n");

    const wiMode = workItem.mode || "build";
    const artifactDir = artifactsDir(wiScopeId(job.work_item_id), worker.projectDir).replace(/\\/g, "/");
    const modeConstraints = {
      image: [
        "==== WORK ITEM MODE: image ====",
        "This WI produces IMAGE ARTIFACTS, NOT repo code changes.",
        "The artificer agent has a built-in generate_image tool (OpenAI or Grok, depending on image protocol config) - it does NOT need to write scripts, install packages, or call APIs manually.",
        "",
        "PLANNING RULES:",
        "- Each image task should be ONE task: \"Generate [description]\"",
        "- Do NOT plan tasks like \"write generation script\" or \"execute script\" - the tool handles this",
        "- Do NOT plan API setup, package installation, or script writing tasks",
        "- ALL tasks MUST use task_mode \"image\" or \"content\"",
        "- Do NOT emit files_to_modify - images go to output_root",
        `- Set output_root to: ${artifactDir}`,
        "- Include output_root in create_roots",
        "- Set needs_image_generation: true for tasks that generate images",
        "- The task_spec should describe the image to generate, not how to generate it",
        "",
      ],
      report: [
        "==== WORK ITEM MODE: report ====",
        "This WI produces TEXT/DATA ARTIFACTS, NOT repo code changes.",
        "- ALL tasks MUST use task_mode \"report\" or \"content\"",
        "- Do NOT emit files_to_modify - reports go to output_root",
        `- Set output_root to: ${artifactDir}`,
        "- Include output_root in create_roots",
        "",
      ],
    };

    const plannerArtifactConfigPath = path.join(worker.projectDir, "config", "artifact-protocols.json").replace(/\\/g, "/");
    const plannerImageProviders = getConfiguredImageProviders();
    const plannerImageProtocol = getResolvedImageProtocol();
    const explicitBindings = getExplicitIntakeBindings(workItem);
    const plannerImageReadinessSummary = plannerImageProviders
      .map((provider) => {
        const readiness = isProviderReady(provider, "images");
        return `${provider}:${readiness.ready ? "available" : `unavailable (${readiness.reason || "unknown reason"})`}`;
      })
      .join(", ");
    const enabledDevSkills = getEnabledSkillsForRole("dev");
    const renderSkillAllowlist = (skills) => {
      if (!skills.length) return "- dev: none";
      return [
        "- dev:",
        ...skills.map((skill) => `  - ${skill.id}: ${skill.when_to_use || skill.description || skill.name}`),
      ].join("\n");
    };
    const availableSkillsBlock = [
      "Available dev skills (optional planner-selected prompt attachments; choose only these ids for dev code tasks):",
      renderSkillAllowlist(enabledDevSkills),
      "- artificer/promote/human_input: skills are not attached",
    ].join("\n");
    const plannerOutputBindingRules = explicitBindings.outputMode
      ? [
          "EXPLICIT OUTPUT BINDING (user-selected - treat as a strong planning constraint, not a hint):",
          `- output_mode is explicitly bound to "${explicitBindings.outputMode}"`,
          explicitBindings.outputMode === "repo"
            ? "- Plan repo-edit tasks: use job_type \"dev\", task_mode \"code\", and target real repo files/surfaces"
            : explicitBindings.outputMode === "artifact"
              ? "- Plan artifact tasks: use job_type \"artificer\" or \"promote\" and target artifact output directories, not repo edits"
              : "- Keep the plan in question/answer mode; do not invent repo-edit or artifact-generation tasks",
          "- Do NOT override this binding just because the wording sounds visual, design-oriented, or mock-like",
          "",
        ].join("\n")
      : "OUTPUT MODE is not explicitly bound - use heuristics only when the request is ambiguous.\n";
    const desiredOutputsBlock = Array.isArray(explicitBindings.desiredOutputs) && explicitBindings.desiredOutputs.length > 0
      ? [
          "TERMINAL OUTPUT CONTRACT (work item binding - planner and assessor both enforce this):",
          `- desired_outputs: ${explicitBindings.desiredOutputs.join(", ")}`,
          explicitBindings.desiredOutputs.includes("repo")
            ? "- The work item is not complete until repo-facing work lands. Evidence-only/report tasks are intermediate unless paired with repo work."
            : "- Repo changes are not required unless separately planned.",
          explicitBindings.desiredOutputs.includes("artifact")
            ? "- Include artifact generation when needed; for repo+artifact work, ensure the plan covers both generation and integration."
            : "- Artifact generation is optional unless it is required to reach the requested repo outcome.",
          "",
        ].join("\n")
      : "";
    const plannerRoutingContext = [
      "PIPELINE ROUTING CONTEXT (treat this as source-of-truth project configuration):",
      `- Artifact protocol config: ${plannerArtifactConfigPath}`,
      "- Non-code deliverables belong to the ARTIFICER role unless the task is a deterministic promote copy step.",
      `- Image protocol: providers=${plannerImageProviders.join(", ")}, selected=${plannerImageProtocol.provider}, model=${plannerImageProtocol.model || getDefaultImageModel(plannerImageProtocol.provider)}`,
      `- Image provider readiness: ${plannerImageReadinessSummary}`,
      `- Admin-backed provider selections: planner=${job.provider || getProviderName("planner")}, artificer=${getProviderName("artificer")}, dev=${getProviderName("dev")}`,
      availableSkillsBlock,
      "- If a task produces images, reports, generated content, or intake outputs, route it to job_type \"artificer\" with the matching task_mode.",
      "- If repo code must consume artificer output, insert a \"promote\" job between the artificer task and the dev task.",
      "",
    ].join("\n");

    // Resolve ATLAS handoff state for this planner job so ATLAS CONTEXT / ATLAS SLICE
    // PRUNING sections can be injected into the prompt for every provider.
    const plannerExecProvider = currentExecutionProvider(job);
    const plannerPacket = await handoff({
      recipient: "planner",
      data: {
        cwd: worker.projectDir,
        execution_provider: plannerExecProvider,
        title: workItem.title || "",
        project_context: (payload.task_spec || workItem.description || "").slice(0, 4000),
        files_to_modify: [],
        context_hints: {
          atlas_seed_files: keyFiles,
          atlas_seed_symbols: keySymbols,
        },
      },
    });
    const plannerAttempts = getAttempts(job.id);
    Object.assign(plannerPacket, {
      job_type: job.job_type,
      work_item_id: job.work_item_id,
      job_id: job.id,
      title: job.title,
      model_tier: ctx.tier || job.model_tier || "standard",
      reasoning_effort: job.reasoning_effort || "medium",
      governance_tier: workItem?.governance_tier || "mvp",
      execution_provider: plannerExecProvider,
      attempt: {
        count: plannerAttempts.length + 1,
        max: job.max_attempts || 3,
        last_error: job.last_error || plannerAttempts.at(-1)?.error_text || null,
        escalated: ctx.tier && ctx.tier !== job.model_tier,
      },
      success_criteria: Array.isArray(payload.success_criteria) ? payload.success_criteria : [],
      test_command: payload.test_command || null,
    });
    const atlasHandoffBlock = renderAtlasHandoffSections(plannerPacket);

    const contextDirsBlock = fastFileCount > 0 || fullCount > 0 ? [
      "CONTEXT DIRECTORIES (pre-staged from research - read these before planning):",
      `  fast/ (curated reference): ${fastDir.replace(/\\/g, "/")}`,
      "    - brief.md      - researcher's full analysis",
      "    - research.json  - structured data (key_files, patterns, constraints)",
      plannerFilePriorities.length > 0 ? "    - file-priorities.md - researcher-ranked file order for planning" : "",
      funcLines.length > 0 ? "    - functions.md   - function/class index with signatures and line ranges" : "",
      fullCount > 0 ? `  full/ (source files):  ${fullDir.replace(/\\/g, "/")}` : "",
      "",
      plannerFilePriorities.length > 0
        ? "  START by reading fast/file-priorities.md and fast/brief.md, then fast/functions.md when present."
        : funcLines.length > 0
          ? "  START by reading fast/brief.md and fast/functions.md - they have everything you need to plan."
          : "  START by reading fast/brief.md - it has the research context you need to plan.",
      "  Only read from full/ if the reference files lack detail on a specific function body or pattern.",
      "  Only read from the project root as a last resort for files not in full/.",
      "",
    ].filter(Boolean).join("\n") : "";

    const contextText = [
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("DESCRIPTION", workItem.description || "(none)"),
      intakeHintsBlock ? `${intakeHintsBlock}\n` : "",
      humanAnswers ? `HUMAN ANSWERS (from researcher clarification questions):\n${humanAnswers}\n` : "",
      payload.replan_reason ? `REPLAN REASON (previous approach failed - you MUST take a different approach):\n${payload.replan_reason}\n` : "",
      planningMode === RED_TEAM_PLANNING_MODE && plannerRoleMode === "redteam"
        ? `PRIMARY PLANNER OUTPUT (candidate plan to critique):\n${primaryPlanText || "(missing primary planner output)"}\n`
        : "",
      planningMode === RED_TEAM_PLANNING_MODE && plannerRoleMode === "synth"
        ? [
            `PRIMARY PLANNER OUTPUT (candidate plan):\n${primaryPlanText || "(missing primary planner output)"}`,
            "",
            `RED-TEAM PLANNER OUTPUT (critique to apply):\n${redTeamPlanText || "(missing red-team planner output)"}`,
            "",
          ].join("\n")
        : "",
      "ARTIFACT DIRECTORIES (absolute paths - use these for non-code tasks):",
      `  artifacts: ${artifactDir}`,
      `  workspace: ${workspaceDir(wiScopeId(job.work_item_id), worker.projectDir).replace(/\\/g, "/")}`,
      `  inputs: ${inputsDir(wiScopeId(job.work_item_id), worker.projectDir).replace(/\\/g, "/")}`,
      "",
      contextDirsBlock,
      atlasHandoffBlock || null,
    ].filter(Boolean).join("\n");
    Object.assign(ctx, {
      contextDirsBlock,
      desiredOutputsBlock,
      fastDir,
      fastFileCount,
      fullCount,
      fullDir,
      funcLines,
      modeConstraints: modeConstraints[wiMode] || [],
      payload,
      planningMode,
      plannerFilePriorities,
      plannerOutputBindingRules,
      plannerPacket,
      plannerRoleMode,
      plannerRoutingContext,
      primaryPlanText,
      projectDir: worker.projectDir,
      promptArtifact: { stored: false },
      redTeamPlanText,
      researchBudget: researchScopePolicy.budget,
      researchScopePolicy,
      atlasHandoffBlock,
      wiMode,
      workflowModeBlock,
      workItem,
    });

    return contextText;
  }

  async composePrompt({ contextText, contract, job, ctx } = {}) {
    const remoteInstructions = [contract, contextText]
      .filter((part) => part != null && String(part) !== "")
      .join("\n");
    if (!remoteInstructions) {
      throw new Error(`${this.constructor.name} produced empty prompt`);
    }
    const prompt = await composePromptRemoteAware(ctx.plannerPacket, remoteInstructions);
    if (ctx?.promptArtifact && !ctx.promptArtifact.stored && job) {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "prompt",
        content_long: promptPersistenceSummary({ prompt, packet: ctx.plannerPacket, role: this.getRole(), provider: ctx.providerName }),
      });
      ctx.promptArtifact.stored = true;
    }
    return prompt;
  }

  buildOpts(job, ctx) {
    const {
      isDeepthinkTask,
      isResearchBudgetDeep,
      researchBudgetToMaxTurnsOverride,
      researchBudgetToReasoningEffort,
      shortJobTitle,
    } = this.roleDeps();
    const maxTurns = researchBudgetToMaxTurnsOverride(ctx.researchBudget, "planner");
    return {
      role: this.getRole(),
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: researchBudgetToReasoningEffort(ctx.researchBudget, job.reasoning_effort || "medium"),
      deepthink: isResearchBudgetDeep(ctx.researchBudget) || isDeepthinkTask(ctx.workItem, ctx.payload),
      ...(maxTurns ? { maxTurns } : {}),
      activity: shortJobTitle(job).replace(/^Plan:\s*/i, "").slice(0, 40),
      stableContext: ctx.plannerPacket?.stable_context || null,
      remoteSystemPrompt: ctx.plannerPacket?.remote_system_prompt || null,
      atlasPrefetchStatus: ctx.plannerPacket?.atlas?.prefetchStatus || null,
      sessionPacket: ctx.plannerPacket || null,
      sessionInstructions: [ctx.plannerRoutingContext, ctx.contextDirsBlock].filter(Boolean).join("\n\n") || null,
      skipRolePrompt: !!ctx.plannerPacket?.remote_prompt_composed,
    };
  }

  buildMeta(job) {
    return {
      job_id: job.id,
      work_item_id: job.work_item_id,
      cwd: this.context.projectDir,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
    };
  }

  async processOutput(output, plannerStats = {}, job, ctx) {
    const worker = this.context;
    const {
      classifyPlannerOutput,
      logBadInputFailure,
      unwrapTaskArray,
    } = this.roleDeps();

    if (plannerStats?.toolUses) {
      const normalizePathForCompare = (value) => String(value || "").replace(/\\/g, "/").toLowerCase();
      const fullDirNorm = normalizePathForCompare(ctx.fullDir);
      const fastDirNorm = normalizePathForCompare(ctx.fastDir);
      const projectNorm = normalizePathForCompare(worker.projectDir);
      let fastReads = 0;
      let fullReads = 0;
      let projectReads = 0;
      for (const toolUse of plannerStats.toolUses) {
        if (toolUse.tool !== "Read" && toolUse.tool !== "Glob" && toolUse.tool !== "Grep") continue;
        const candidates = [
          toolUse.input?.file_path,
          toolUse.input?.path,
          toolUse.input?.pattern,
        ].map(normalizePathForCompare).filter(Boolean);
        if (candidates.some((target) => target.startsWith(fastDirNorm))) fastReads++;
        else if (candidates.some((target) => target.startsWith(fullDirNorm))) fullReads++;
        else if (candidates.some((target) => target.startsWith(projectNorm))) projectReads++;
      }
      const parts = [];
      if (fastReads > 0) parts.push(`fast: ${fastReads}`);
      if (fullReads > 0) parts.push(`${C.yellow}full: ${fullReads}${C.reset}`);
      if (projectReads > 0) parts.push(`${C.yellow}project: ${projectReads}${C.reset}`);
      if (parts.length > 0) {
        emit(worker, job.id, `${C.cyan}[context]${C.reset} WI#${job.work_item_id} planner reads: ${parts.join(", ")} (${plannerStats.numTurns || "?"} turns)`);
      }
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "log",
        content_long: `context_reads: fast=${fastReads} full=${fullReads} project=${projectReads} turns=${plannerStats.numTurns || 0}`,
      });
    }

    const dualMode = ctx?.planningMode === RED_TEAM_PLANNING_MODE;
    const roleMode = ctx?.plannerRoleMode || "normal";

    if (/NO_TASKS_NEEDED/i.test(output) && !extractJson(output) && !dualMode) {
      const reasonMatch = output.match(/NO_TASKS_NEEDED[:\s]*([^\n]+)/i);
      const reason = reasonMatch ? reasonMatch[1].trim() : "research already covers this work item";
      emit(worker, job.id, `${C.cyan}[planner]${C.reset} WI#${job.work_item_id}: no tasks needed - ${reason}`);
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "summary",
        content_long: `Planner: no tasks needed. ${reason}`,
      });
      return output;
    }

    if (dualMode && roleMode !== "synth") {
      const artifactType = roleMode === "redteam" ? "plan_redteam" : "plan_primary";
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "response",
        content_long: output,
      });
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: artifactType,
        content_long: output,
      });
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "summary",
        content_long: `${roleMode === "redteam" ? "Red-team planner critique" : "Primary planner candidate"} stored for synthesis; no write-layer jobs created by this planner.`,
      });
      emit(worker, job.id, `${C.cyan}[planner]${C.reset} WI#${job.work_item_id}: stored ${roleMode} planning artifact for synthesis`);
      return output;
    }

    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: ctx.attemptId,
      artifact_type: "response",
      content_long: output,
    });
    if (dualMode && roleMode === "synth") {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "plan_synthesis",
        content_long: buildPlanSynthesisArtifact(ctx, output),
      });
      emit(worker, job.id, `${C.cyan}[planner]${C.reset} WI#${job.work_item_id}: stored red-team plan synthesis artifact`);
    }
    const rawParsed = extractJson(output);
    let tasks = unwrapTaskArray(rawParsed);
    const plannerOutputClass = classifyPlannerOutput(output, tasks);
    // Remember whether the original parse succeeded with a valid-but-empty array
    // so we can pick an accurate error suffix below and skip the pointless repair
    // call. A repair LLM given "[]" has nothing to work with; repairJson rejects
    // empty arrays by design, so calling it here just burns tokens.
    const originalWasEmptyArray = Array.isArray(tasks) && tasks.length === 0;
    let repairAttempted = false;
    if (Array.isArray(tasks) && tasks.length > 0) {
      emit(worker, job.id, `${C.cyan}[planner]${C.reset} WI#${job.work_item_id}: parsed ${tasks.length} task(s) from output (${(output || "").length} chars)`);
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      if (originalWasEmptyArray) {
        emit(worker, job.id, `${C.yellow}[planner]${C.reset} WI#${job.work_item_id}: parser returned empty array [class=${plannerOutputClass}] - skipping repair (would also be empty)`);
      } else {
        emit(worker, job.id, `${C.yellow}[planner]${C.reset} WI#${job.work_item_id}: extractJson failed [class=${plannerOutputClass}] - trying repair`);
        repairAttempted = true;
        tasks = unwrapTaskArray(await worker.repairJson(output, "planner", job));
      }
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      const snippet = (output || "").slice(0, 500).replace(/\n/g, "\\n");
      const repairTag = repairAttempted ? " (repair also failed)" : "";
      emit(worker, job.id, `${C.red}[planner] WI#${job.work_item_id} JSON parse failed${repairTag} - output starts with: ${snippet}${snippet.length >= 500 ? "..." : ""}${C.reset}`);
      // Pick the suffix from the ORIGINAL parse, not the post-repair state;
      // repair sets tasks=null on rejection, which would otherwise mislabel a
      // valid-but-empty array as "(no JSON found)".
      const parseErrorSuffix = Array.isArray(rawParsed)
        ? " (empty array)"
        : rawParsed == null
          ? " (no JSON found)"
          : ` (got ${typeof rawParsed})`;
      logBadInputFailure(job, {
        attemptId: ctx.attemptId,
        layer: "planner",
        upstream: "planner_output",
        classification: plannerOutputClass,
        detail: `Planner output could not be parsed into a non-empty task array${parseErrorSuffix}`,
        snippet: output,
      });
      throw new Error(`Planner output could not be parsed as a JSON task array${parseErrorSuffix} [class=${plannerOutputClass}]`);
    }
    const rawMaxTasks = getIntSetting(SETTING_KEYS.PLANNER_MAX_TASKS, 50);
    const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? rawMaxTasks : 50;
    if (tasks.length > maxTasks) {
      emit(worker, job.id, `${C.yellow}[planner]${C.reset} WI#${job.work_item_id}: planner returned ${tasks.length} tasks - capping to ${maxTasks}`);
      logBadInputFailure(job, {
        attemptId: ctx.attemptId,
        layer: "planner",
        upstream: "planner_output",
        classification: "task_cap_exceeded",
        detail: `Planner returned ${tasks.length} tasks (cap ${maxTasks})`,
        snippet: output,
      });
      tasks = tasks.slice(0, maxTasks);
    }
    worker.createJobsFromPlan(job, tasks);

    return output;
  }
}

function failPlannerContextPreflight(worker, job, attemptId, detail) {
  const message = `Planner handoff preflight failed: ${detail}`;
  emit(worker, job.id, `${C.red}[context]${C.reset} WI#${job.work_item_id}: ${message}`);
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    artifact_type: "summary",
    content_long: message,
  });
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    artifact_type: "response",
    content_long: `PLANNER_CONTEXT_ERROR: ${detail}`,
  });
  throw new Error(message);
}

function validatePlannerContextPreflight(worker, job, attemptId, { fastDir, researchArtifacts }) {
  if (!Array.isArray(researchArtifacts) || researchArtifacts.length === 0) return;

  const briefPath = path.join(fastDir, "brief.md");
  let briefStat = null;
  try {
    briefStat = fs.statSync(briefPath);
  } catch (err) {
    const reason = err?.code === "ENOENT"
      ? "missing fast/brief.md"
      : `unable to stat fast/brief.md (${err?.code || "unknown"}: ${err?.message?.split("\n")[0]?.slice(0, 120) || "no detail"})`;
    failPlannerContextPreflight(worker, job, attemptId, reason);
  }
  if (!briefStat?.isFile()) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is not a regular file");
  }
  if (briefStat.size <= 0) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is empty");
  }

  let briefContent = "";
  try {
    briefContent = fs.readFileSync(briefPath, "utf-8");
  } catch (err) {
    const reason = `unable to read fast/brief.md (${err?.code || "unknown"}: ${err?.message?.split("\n")[0]?.slice(0, 120) || "no detail"})`;
    failPlannerContextPreflight(worker, job, attemptId, reason);
  }
  if (!String(briefContent || "").trim()) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is blank");
  }
}
