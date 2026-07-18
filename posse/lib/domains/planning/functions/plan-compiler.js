// lib/domains/planning/functions/plan-compiler.js
//
// Planner task compilation extracted from worker.js.

import fs from "fs";
import path from "path";
import { PLANNER_ALLOWED_JOB_TYPES } from "../../../catalog/job.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../queue/functions/index.js";
import {
  addDependency,
  applyDelegation,
  getArtifactsByWorkItem,
  getDependents,
  getJob,
  getSetting,
  getWorkItem,
  logEvent,
  rewireDependency,
  setJobError,
  setJobResult,
  storeArtifact,
  updateJobPayload,
  updateJobStatus,
} from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  getAvailableProviders,
  getProviderMap,
  getProviderName,
  isProviderReady,
  needsDelegation,
} from "../../providers/functions/provider.js";
import { C } from "../../../shared/format/functions/colors.js";
import {
  artifactTaskOutputRoot,
  contextDir,
  getWiModeConfig,
  isValidTaskMode,
  normalizeArtifactCreateFiles,
  workItemArtifactRoot,
  wiScopeId,
} from "../../artifacts/functions/index.js";
import { hasWritableScope, parseResearcherStructuredOutput } from "../../handoff/functions/index.js";
import { projectDbEffectivePermissions } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import {
  normalizeRiskTags,
  resolveTaskExecutionPolicy,
} from "../../handoff/functions/helpers/execution-policy.js";
import { validateSkillIds } from "../../../shared/skills/functions/registry.js";
import {
  buildStructuredDataPromotePlan as buildStructuredDataPromotePlanFromModule,
  getExplicitIntakeBindings as getExplicitIntakeBindingsFromModule,
  getCreateFileKindSummary as getCreateFileKindSummaryFromModule,
  inferPromoteTask as inferPromoteTaskFromModule,
  looksLikeArtifactGenerationTask as looksLikeArtifactGenerationTaskFromModule,
  looksLikeRepoCodeCreationTask as looksLikeRepoCodeCreationTaskFromModule,
  looksLikeRepoDesignTask as looksLikeRepoDesignTaskFromModule,
  looksLikeStructuredDataRepoTransformTask as looksLikeStructuredDataRepoTransformTaskFromModule,
  normalizePromoteMappings as normalizePromoteMappingsFromModule,
  validatePlannedTask as validatePlannedTaskFromModule,
} from "./plan-routing.js";
import { getWorkItemIntakeHints } from "../../intake/functions/hints.js";
import {
  effectiveArtifactTaskMode as effectiveArtifactTaskModeFromModule,
  NO_IMAGE_PROVIDERS_AVAILABLE,
  resolveImageExecutionProvider as resolveImageExecutionProviderFromModule,
} from "../../providers/functions/execution-routing.js";
import { DEFAULT_DEV_MODE, isValidDevMode, normalizeDevMode } from "../../../shared/policies/functions/dev-modes.js";
import {
  buildDeterministicDelegations as buildDeterministicDelegationsFromModule,
  delegationRoleForJobType as delegationRoleForJobTypeFromModule,
  getDelegationMode as getDelegationModeFromModule,
  jobNeedsMlDelegation as jobNeedsMlDelegationFromModule,
} from "../../providers/functions/delegation-routing.js";
import { repairWebAssetCreateScope as repairWebAssetCreateScopeFromModule } from "../../git/functions/commit-scope.js";
import { planArtifactReuse as planArtifactReuseFromModule } from "./artifact-reuse.js";
import { createPlanApprovalGate, isPlanApprovalEnabled } from "./plan-approval.js";
import {
  getResearchBudget,
  isResearchBudgetDeep,
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetFromDeepthink,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { spawnFromRole as defaultSpawnFromRole } from "../../queue/functions/spawn-guard.js";
import {
  collectRequestedImageOutputs,
  hasRequestedImageGenerationOutput,
} from "./image-outputs.js";
import { sanitizePlannerDevBrief } from "./planner-helpers.js";
import { reissueHashRefHandoffPacket } from "../../handoff/functions/helpers/hash-ref-packet.js";
import {
  isBroadNarrowScopedCodeTask,
  parseUnderScopedBroadGateMode,
} from "./scope-gates.js";
import { reconcilePlannerFileKinds } from "./scope-reconciliation.js";
import { rewriteDependenciesAfterSplit } from "./dependency-rewrite.js";
import { cancelSupersededPlanChildren } from "./plan-cleanup.js";
import {
  resolvePromoteSourceDir,
  routePromoteTaskByOutputDir,
  splitTaskByCreateFileKind,
} from "./task-splitting.js";
import { ASSESSABLE_JOB_TYPES } from "../../../catalog/job.js";
import { normPath } from "../../../shared/scope/functions/path.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const FRONTEND_DESIGN_SKILL_ID = "frontend-design";

function normalizePromoteDestinationFile(value, projectDir) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = path.isAbsolute(raw)
    ? normPath(path.relative(projectDir, raw))
    : normPath(raw);
  const cleaned = normalized.replace(/\/+$/, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith("../")) return null;
  return cleaned;
}

function promoteDestinationFiles(payload = {}, projectDir = process.cwd()) {
  const files = [];
  for (const filePath of Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []) {
    const normalized = normalizePromoteDestinationFile(filePath, projectDir);
    if (normalized) files.push(normalized);
  }
  for (const filePath of Array.isArray(payload.files_to_create) ? payload.files_to_create : []) {
    const normalized = normalizePromoteDestinationFile(filePath, projectDir);
    if (normalized) files.push(normalized);
  }

  if (files.length === 0 && Array.isArray(payload.mappings)) {
    for (const mapping of payload.mappings) {
      const dest = String(mapping?.dest || "").trim();
      if (!dest) continue;
      if (mapping?.destination_type === "file") {
        const normalized = normalizePromoteDestinationFile(dest, projectDir);
        if (normalized) files.push(normalized);
        continue;
      }
      const pattern = normPath(mapping?.pattern || "");
      if (!pattern || /[*?[\]{}]/.test(pattern)) continue;
      const destRoot = normalizePromoteDestinationFile(dest, projectDir);
      const basename = path.posix.basename(pattern);
      if (destRoot && basename) files.push(path.posix.join(destRoot, basename));
    }
  }

  return [...new Set(files)];
}

function formatPromoteDestinationList(files = []) {
  const visible = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${visible}, +${files.length - 3} more` : visible;
}

const DEDUPE_SORTED_ARRAY_KEYS = new Set([
  "create_roots",
  "depends_on_index",
  "files_to_create",
  "files_to_delete",
  "files_to_modify",
  "input_roots",
  "mappings",
  "success_criteria",
]);

function stableDedupeValue(value, key = null) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableDedupeValue(entry));
    if (!DEDUPE_SORTED_ARRAY_KEYS.has(key)) return normalized;
    return normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = stableDedupeValue(value[childKey], childKey);
    }
    return out;
  }
  return value;
}

function normalizedTaskTitleForDedupe(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function parsePayloadForDedupe(payloadJson) {
  if (!payloadJson) return null;
  if (typeof payloadJson === "object") return payloadJson;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

function plannedTaskDedupeKey(task, {
  finalJobType,
  taskMode,
  provider = null,
  modelTier = null,
  reasoningEffort = null,
  payloadJson = null,
  promoteFollowUp = null,
} = {}) {
  if (!task || !finalJobType || finalJobType === "promote") return null;
  return JSON.stringify(stableDedupeValue({
    job_type: finalJobType,
    title: normalizedTaskTitleForDedupe(task.title),
    task_mode: taskMode || null,
    provider: provider || null,
    model_tier: modelTier || null,
    reasoning_effort: reasoningEffort || null,
    depends_on_index: Array.isArray(task.depends_on_index) ? task.depends_on_index : [],
    payload: parsePayloadForDedupe(payloadJson),
    promote_follow_up: promoteFollowUp ? {
      title: promoteFollowUp.title || null,
      mappings: Array.isArray(promoteFollowUp.mappings) ? promoteFollowUp.mappings : [],
      files_to_create: Array.isArray(promoteFollowUp.files_to_create) ? promoteFollowUp.files_to_create : [],
      create_roots: Array.isArray(promoteFollowUp.create_roots) ? promoteFollowUp.create_roots : [],
    } : null,
  }));
}

function taskTextForSkillInference(task = {}) {
  return [
    task.title,
    task.task_spec,
    task.instructions,
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria]),
    ...(Array.isArray(task.files_to_modify) ? task.files_to_modify : []),
    ...(Array.isArray(task.files_to_create) ? task.files_to_create : []),
  ].filter(Boolean).join("\n").toLowerCase();
}

function taskPathsForSkillInference(task = {}) {
  return [
    ...(Array.isArray(task.files_to_modify) ? task.files_to_modify : []),
    ...(Array.isArray(task.files_to_create) ? task.files_to_create : []),
    ...(Array.isArray(task.files_to_delete) ? task.files_to_delete : []),
  ].map((filePath) => String(filePath || "").replace(/\\/g, "/").toLowerCase());
}

function shouldInferFrontendDesignSkill(task, { finalJobType, taskMode } = {}) {
  if (finalJobType !== "dev" || taskMode !== "code") return false;
  const text = taskTextForSkillInference(task);
  const paths = taskPathsForSkillInference(task);
  const frontendExt = /\.(css|scss|sass|less|html|htm|jsx|tsx|vue|svelte)$/;
  const frontendPath = paths.some((filePath) => frontendExt.test(filePath));
  const browserJsPath = paths.some((filePath) => /^htdocs\/.*\.js$/.test(filePath));
  const designIntent = /\b(ui|ux|front-?end|layout|responsive|stylesheet|css|style|styling|design|visual|component|hero|nav|navigation|footer|header|cards?|theme|typography|spacing|contrast|accessib(?:le|ility)?|mobile|desktop|page|pages)\b/.test(text);
  return frontendPath || (browserJsPath && designIntent);
}

function mergeSkillId(skillIds, skillId) {
  if (!skillId || skillIds.includes(skillId)) return skillIds;
  return [...skillIds, skillId];
}

export function createJobsFromPlan(worker, planJob, tasks, {
  atlasDevBriefsEnabled = false,
  sourceHashRefContext = null,
  artifactTaskSlug = (title, mode) => `${String(mode || "task")}-${String(title || "task")}`,
  buildIntermediateReportTask = (task) => task,
  logBadInputFailure = () => {},
  normalizePlannerScore = (value) => value,
  repairWebAssetCreateScope = repairWebAssetCreateScopeFromModule,
  spawnFromRole = defaultSpawnFromRole,
} = {}) {
      const plannerRole = worker?.roleRegistry?.get?.("plan");
      const jobMap = new Map(); // dependency target by planner task index
      const pendingDependencyLinks = [];
      const duplicateTaskClaims = new Map(); // semantic planner task -> first job created for it
      const allCreatedJobIds = new Set(); // every job spawned by this compilation
      const compiledTaskJobIds = new Map(); // planner task index -> spawned job ids
      const promoteDestinationClaims = new Map(); // repo file -> promote claim record
      const promoteClaimsByJobId = new Map(); // promote job id -> claim group
      const rawMaxTasks = getIntSetting(SETTING_KEYS.PLANNER_MAX_TASKS, 50);
      const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? rawMaxTasks : 50;
      const artifactDirAbs = workItemArtifactRoot(planJob.work_item_id, worker.projectDir).replace(/\\/g, "/");
      if (Array.isArray(tasks) && tasks.length > maxTasks) {
        worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: planner emitted ${tasks.length} tasks — capping to ${maxTasks}`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.PLAN_TASK_CAPPED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Planner emitted ${tasks.length} tasks; capped to ${maxTasks}`,
        });
        tasks = tasks.slice(0, maxTasks);
      }
      // Planners may only emit dev or human_input — other types are internal pipeline types.
      // Defense-in-depth: LLMs can conflate task_mode values with job_type (e.g. "content").
      const PLANNER_ALLOWED_TYPES = PLANNER_ALLOWED_JOB_TYPES;
      const VALID_TIERS = new Set(["cheap", "standard", "strong"]);
      const VALID_EFFORTS = new Set(["low", "medium", "high"]);
      // LLMs confuse the two enum sets — normalize crossed values before validation
      const TIER_SYNONYMS = { low: "cheap", medium: "standard", high: "strong", max: "strong", premium: "high",
        haiku: "cheap", sonnet: "standard", opus: "strong",
        "1": "cheap", "2": "standard", "3": "strong",
        mid: "standard", lo: "cheap", hi: "strong" };
      const EFFORT_SYNONYMS = { cheap: "low", standard: "medium", strong: "high",
        mid: "medium", lo: "low", hi: "high" };
      let createdCount = 0;
      const underScopedDroppedTitles = [];
      const researchCandidateFiles = new Set();
      const projectRootAbs = path.resolve(worker.projectDir).replace(/\\/g, "/").replace(/\/+$/, "");
      const broadPlannerRoot = (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) return null;
        if (raw === "*" || raw === "." || raw === "./" || raw === ".\\") return raw;
        const resolved = path.resolve(worker.projectDir, raw).replace(/\\/g, "/").replace(/\/+$/, "");
        return resolved === projectRootAbs ? raw : null;
      };
      const researchArtifacts = getArtifactsByWorkItem(planJob.work_item_id, "response")
        .filter((artifact) => {
          const sourceJob = artifact?.job_id ? getJob(artifact.job_id) : null;
          return sourceJob?.job_type === "research";
        });

      const releasePromoteClaimsForJob = (jobId) => {
        const group = promoteClaimsByJobId.get(jobId);
        if (!group) return null;
        for (const filePath of group.files) {
          const current = promoteDestinationClaims.get(filePath);
          if (current?.jobId === jobId) promoteDestinationClaims.delete(filePath);
        }
        promoteClaimsByJobId.delete(jobId);
        return group;
      };

      const validatePromoteDestinationClaim = (payload, {
        title,
        taskIndex,
        preferred = false,
      } = {}) => {
        const files = promoteDestinationFiles(payload, worker.projectDir);
        if (files.length === 0) return { ok: true, files, superseded: [] };
        const conflicts = files
          .map((filePath) => promoteDestinationClaims.get(filePath))
          .filter(Boolean);
        if (conflicts.length === 0) return { ok: true, files, superseded: [] };

        const conflictGroups = [...new Map(conflicts.map((claim) => [claim.jobId, claim])).values()]
          .map((claim) => promoteClaimsByJobId.get(claim.jobId))
          .filter(Boolean);
        const candidateFiles = new Set(files);
        const supersedable = preferred && conflictGroups.length > 0 && conflictGroups.every((group) =>
          !group.preferred && group.files.every((filePath) => candidateFiles.has(filePath))
        );
        if (supersedable) return { ok: true, files, superseded: conflictGroups };

        const first = conflicts[0];
        return {
          ok: false,
          files,
          conflict: first,
          duplicateFiles: files.filter((filePath) => promoteDestinationClaims.has(filePath)),
          message: `Dropped promote task "${title}": destination already claimed by promote job #${first.jobId} (${first.title})`,
          event_json: {
            task_title: title,
            task_index: taskIndex,
            duplicate_destinations: files.filter((filePath) => promoteDestinationClaims.has(filePath)),
            existing_job_id: first.jobId,
            existing_task_title: first.title,
          },
        };
      };

      const recordPromoteDestinationClaim = (job, payload, {
        files = null,
        taskIndex = null,
        preferred = false,
        superseded = [],
      } = {}) => {
        const claimFiles = Array.isArray(files) ? files : promoteDestinationFiles(payload, worker.projectDir);
        for (const group of superseded) {
          releasePromoteClaimsForJob(group.jobId);
          const message = `Canceled duplicate promote job #${group.jobId}: superseded by promote job #${job.id}`;
          updateJobStatus(group.jobId, "canceled", { expectedStatuses: ["queued"] });
          setJobError(group.jobId, `${message}; duplicate destinations: ${formatPromoteDestinationList(group.files)}`);
          allCreatedJobIds.delete(group.jobId);
          if (createdCount > 0) createdCount--;
          for (const priorIndex of group.taskIndexes || []) jobMap.set(priorIndex, job.id);
          for (const dep of getDependents(group.jobId)) {
            if (Number(dep.job_id) !== Number(job.id)) {
              rewireDependency(dep.job_id, group.jobId, job.id, dep.dependency_kind || "hard");
            }
          }
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
          logEvent({
            work_item_id: planJob.work_item_id,
            job_id: group.jobId,
            event_type: EVENT_TYPES.JOB_DROPPED_DUPLICATE_PROMOTE,
            actor_type: EVENT_ACTORS.PLANNER,
            message,
            event_json: JSON.stringify({
              superseded_by_job_id: job.id,
              duplicate_destinations: group.files,
              replacement_task_title: job.title,
            }),
          });
        }

        const group = {
          jobId: job.id,
          title: job.title,
          files: claimFiles,
          taskIndexes: taskIndex == null ? [] : [taskIndex],
          preferred,
        };
        promoteClaimsByJobId.set(job.id, group);
        for (const filePath of claimFiles) {
          promoteDestinationClaims.set(filePath, {
            jobId: job.id,
            title: job.title,
            filePath,
            preferred,
          });
        }
      };

      const dropDuplicatePromoteTask = (claim, title) => {
        const duplicateFiles = claim.duplicateFiles || [];
        const detail = duplicateFiles.length > 0 ? `: ${formatPromoteDestinationList(duplicateFiles)}` : "";
        const message = `${claim.message}${detail}`;
        worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.JOB_DROPPED_DUPLICATE_PROMOTE,
          actor_type: EVENT_ACTORS.PLANNER,
          message,
          event_json: JSON.stringify({
            task_title: title,
            ...claim.event_json,
          }),
        });
      };
      for (const artifact of researchArtifacts) {
        const parsed = parseResearcherStructuredOutput(String(artifact?.content_long || ""));
        if (!parsed) continue;
        const plannerFilePriorities = Array.isArray(parsed.planner_file_priorities)
          ? parsed.planner_file_priorities
          : Array.isArray(parsed.ranked_files)
            ? parsed.ranked_files
            : [];
        for (const priorityEntry of plannerFilePriorities) {
          const filePath = typeof priorityEntry === "string" ? priorityEntry : priorityEntry?.path;
          if (typeof filePath === "string" && filePath.trim()) researchCandidateFiles.add(filePath.trim());
        }
        const keyFiles = Array.isArray(parsed.key_files) ? parsed.key_files : [];
        for (const filePath of keyFiles) {
          if (typeof filePath === "string" && filePath.trim()) researchCandidateFiles.add(filePath.trim());
        }
        const relatedFiles = Array.isArray(parsed.related_files) ? parsed.related_files : [];
        for (const related of relatedFiles) {
          const filePath = typeof related === "string" ? related : related?.path;
          if (typeof filePath === "string" && filePath.trim()) researchCandidateFiles.add(filePath.trim());
        }
      }
      const researchCandidateCount = researchCandidateFiles.size;
      const underScopedBroadGateMode = parseUnderScopedBroadGateMode(getSetting(SETTING_KEYS.PLANNER_UNDER_SCOPED_BROAD_GATE));
      cancelSupersededPlanChildren(worker, planJob);
      const droppedTaskIndexes = new Set();
      let expansionCapLogged = false;

      const plannerDependencyLabel = (depIdx) => Number.isInteger(depIdx) ? `task ${depIdx + 1}` : String(depIdx);
      const dependencyMissingReason = (depIdx, taskIndex) => {
        if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= tasks.length) return "invalid_dependency_index";
        if (depIdx === taskIndex) return "self_dependency";
        if (droppedTaskIndexes.has(depIdx)) return "dropped_dependency";
        if (!jobMap.has(depIdx)) return "missing_dependency_job";
        return null;
      };
      const dependencyMissingText = (reason) => {
        switch (reason) {
          case "dropped_dependency":
            return "was dropped";
          case "missing_dependency_job":
            return "has no compiled job";
          case "self_dependency":
            return "would create a self-dependency";
          case "cycle_or_self_dependency":
            return "would create a dependency cycle";
          case "invalid_dependency_index":
          default:
            return "was invalid";
        }
      };
      const logMissingPlannerDependency = ({ jobId, taskTitle, taskIndex, depIdx, reason }) => {
        const depLabel = plannerDependencyLabel(depIdx);
        const reasonText = dependencyMissingText(reason);
        const eventJson = {
          reason,
          task_index: taskIndex,
        };
        if (Number.isInteger(depIdx)) {
          eventJson.dependency_index = depIdx;
        } else {
          eventJson.dependency_value = depIdx;
        }
        worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dependency ${depLabel} for "${taskTitle}" ${reasonText} — continuing without it`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: jobId,
          event_type: EVENT_TYPES.PLAN_DEPENDENCY_MISSING,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Dependency ${depLabel} for task "${taskTitle}" ${reasonText}; proceeding without it`,
          event_json: JSON.stringify(eventJson),
        });
      };
      const recordPlannerDependencies = (job, task, taskIndex) => {
        if (!Array.isArray(task?.depends_on_index) || task.depends_on_index.length === 0) return;
        pendingDependencyLinks.push({
          jobId: job.id,
          taskIndex,
          taskTitle: typeof task.title === "string" && task.title.trim() ? task.title.trim() : `task ${taskIndex}`,
          dependsOnIndexes: [...task.depends_on_index],
        });
      };
      const recordCompiledTaskJob = (taskIndex, jobId) => {
        if (!Number.isInteger(taskIndex) || jobId == null) return;
        const ids = compiledTaskJobIds.get(taskIndex) || new Set();
        ids.add(jobId);
        compiledTaskJobIds.set(taskIndex, ids);
      };
      const normalizeArtifactRoot = (root) => path.resolve(worker.projectDir, String(root || "")).replace(/\\/g, "/").replace(/\/+$/, "");
      const wiArtifactRoot = artifactDirAbs.replace(/\/+$/, "");
      const derivePriorArtifactInputRoots = (task, taskIndex) => {
        if (!Array.isArray(task?.depends_on_index) || task.depends_on_index.length === 0) return [];
        const currentOutputRoot = task.output_root ? normalizeArtifactRoot(task.output_root) : null;
        const roots = [];
        for (const depIdx of task.depends_on_index) {
          if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= taskIndex) continue;
          if (droppedTaskIndexes.has(depIdx)) continue;
          const sourceTask = tasks[depIdx];
          if (!sourceTask?.output_root) continue;
          const sourceOutputRoot = normalizeArtifactRoot(sourceTask.output_root);
          if (!sourceOutputRoot || sourceOutputRoot === currentOutputRoot) continue;
          roots.push(sourceOutputRoot);
          if (sourceOutputRoot.startsWith(`${wiArtifactRoot}/`)) roots.push(wiArtifactRoot);
        }
        return [...new Set(roots)];
      };
      const rewritePendingDependenciesAfterSplit = (splitIndex, splitTaskCount, finalIndex) => {
        const offset = splitTaskCount - 1;
        if (offset <= 0) return;
        for (const link of pendingDependencyLinks) {
          link.dependsOnIndexes = link.dependsOnIndexes.map((depIdx) => {
            if (!Number.isInteger(depIdx)) return depIdx;
            if (depIdx === splitIndex) return finalIndex;
            if (depIdx > splitIndex) return depIdx + offset;
            return depIdx;
          });
        }
      };
      const wirePlannerDependencies = () => {
        for (const link of pendingDependencyLinks) {
          if (!allCreatedJobIds.has(link.jobId)) continue;
          for (const depIdx of link.dependsOnIndexes) {
            const missingReason = dependencyMissingReason(depIdx, link.taskIndex);
            if (missingReason) {
              logMissingPlannerDependency({ ...link, depIdx, reason: missingReason });
              continue;
            }
            const targetJobId = jobMap.get(depIdx);
            const dependencyAdded = addDependency(link.jobId, targetJobId, "hard");
            if (!dependencyAdded) {
              logMissingPlannerDependency({ ...link, depIdx, reason: "cycle_or_self_dependency" });
            }
          }
        }
      };

      const logExpansionCap = (message, detail = {}) => {
        if (expansionCapLogged) return;
        expansionCapLogged = true;
        worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.PLAN_TASK_CAPPED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message,
          event_json: JSON.stringify({
            cap: maxTasks,
            ...detail,
          }),
        });
      };

      const taskTitleForLog = (task, fallbackIndex = null) => (
        typeof task?.title === "string" && task.title.trim()
          ? task.title.trim()
          : (Number.isInteger(fallbackIndex) ? `task ${fallbackIndex}` : "untitled task")
      );

      const capExpandedTasks = (reason) => {
        if (!Array.isArray(tasks) || tasks.length <= maxTasks) return;
        const before = tasks.length;
        const droppedTitles = tasks.slice(maxTasks).map((task, offset) => taskTitleForLog(task, maxTasks + offset));
        tasks.length = maxTasks;
        logExpansionCap(`Planner task expansion produced ${before} tasks — capping to ${maxTasks}`, {
          reason,
          expanded_task_count: before,
          dropped_task_titles: droppedTitles,
        });
      };

      const splitGroupCrossesTaskCap = (splitIndex, splitTaskCount) => {
        if (!Number.isInteger(splitIndex) || !Number.isInteger(splitTaskCount) || splitTaskCount <= 1) return false;
        return splitIndex < maxTasks && splitIndex + splitTaskCount > maxTasks;
      };

      const dropSplitGroupAtCap = (task, splitIndex, splitTasks, reason) => {
        droppedTaskIndexes.add(splitIndex);
        const title = taskTitleForLog(task, splitIndex);
        const splitTitles = Array.isArray(splitTasks)
          ? splitTasks.map((splitTask, offset) => taskTitleForLog(splitTask, splitIndex + offset))
          : [];
        logExpansionCap(`Planner task expansion would split "${title}" across the ${maxTasks}-task cap — dropping the whole split group`, {
          reason,
          task_index: splitIndex,
          split_task_count: splitTitles.length,
          dropped_task_titles: splitTitles,
        });
        worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped split task "${title}" — rewritten group would cross the ${maxTasks}-task cap`);
      };

      const dropInvalidRewrittenTask = (task, index, reason) => {
        const validationErrors = validatePlannedTaskFromModule(task, index, tasks.length);
        if (validationErrors.length === 0) return false;
        const title = typeof task?.title === "string" && task.title.trim() ? task.title.trim() : `task ${index}`;
        droppedTaskIndexes.add(index);
        worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped invalid rewritten task "${title}" — ${validationErrors.join("; ")}`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.PLAN_TASK_INVALID,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Dropped invalid rewritten planned task "${title}": ${validationErrors.join("; ")}`,
          event_json: JSON.stringify({
            reason,
            task_index: index,
            validation_errors: validationErrors,
          }),
        });
        return true;
      };

      const hasJobCapacity = (title, reason) => {
        if (createdCount < maxTasks) return true;
        logExpansionCap(`Planner job expansion reached ${maxTasks} jobs — dropping remaining expanded work`, {
          reason,
          dropped_task_title: title || null,
          created_jobs: createdCount,
        });
        return false;
      };

      const cancelCompiledTaskForDroppedDependency = (taskIndex, blockedDeps) => {
        if (droppedTaskIndexes.has(taskIndex)) return false;
        const title = taskTitleForLog(tasks[taskIndex], taskIndex);
        const blockedLabels = blockedDeps.map((idx) => idx + 1).join(", ");
        droppedTaskIndexes.add(taskIndex);
        const jobIds = compiledTaskJobIds.get(taskIndex) || new Set();
        const targetJobId = jobMap.get(taskIndex);
        if (targetJobId != null) jobIds.add(targetJobId);

        for (const jobId of jobIds) {
          releasePromoteClaimsForJob(jobId);
          if (allCreatedJobIds.delete(jobId) && createdCount > 0) createdCount--;
          updateJobStatus(jobId, "canceled", { expectedStatuses: ["queued"] });
          setJobError(jobId, `Dropped dependent planned task "${title}": prerequisite task(s) ${blockedLabels} were dropped`);
        }
        jobMap.delete(taskIndex);

        worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped dependent task "${title}" — prerequisite task(s) ${blockedLabels} were dropped`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.PLAN_TASK_INVALID,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Dropped dependent planned task "${title}": prerequisite task(s) ${blockedLabels} were dropped`,
          event_json: JSON.stringify({
            reason: "dropped_dependency",
            task_index: taskIndex,
            dropped_dependencies: blockedDeps,
            canceled_job_ids: [...jobIds],
          }),
        });
        return true;
      };

      const propagateDroppedPlannerDependencies = () => {
        let changed = true;
        while (changed) {
          changed = false;
          for (const link of pendingDependencyLinks) {
            if (droppedTaskIndexes.has(link.taskIndex)) continue;
            if (!allCreatedJobIds.has(link.jobId)) continue;
            const blockedDeps = link.dependsOnIndexes
              .filter((depIdx) => Number.isInteger(depIdx) && droppedTaskIndexes.has(depIdx));
            if (blockedDeps.length === 0) continue;
            changed = cancelCompiledTaskForDroppedDependency(link.taskIndex, [...new Set(blockedDeps)]) || changed;
          }
        }
      };

      for (let i = 0; i < tasks.length; i++) {
        let t = tasks[i];
        if (!t || !t.title) {
          droppedTaskIndexes.add(i);
          continue;
        }
        const fileKindRepair = reconcilePlannerFileKinds(t, worker.projectDir);
        if (fileKindRepair.changed) {
          const details = [
            fileKindRepair.movedToCreate.length > 0
              ? `${fileKindRepair.movedToCreate.length} missing path(s) to files_to_create`
              : null,
            fileKindRepair.movedToModify.length > 0
              ? `${fileKindRepair.movedToModify.length} existing path(s) to files_to_modify`
              : null,
          ].filter(Boolean).join(", ");
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: reconciled file kinds for task "${t.title}" (${details})`);
        }
        const preValidationWi = getWorkItem(planJob.work_item_id);
        const preValidationWiMode = preValidationWi?.mode || "build";
        const preValidationArtifactPathRe = /(?:^|\/)\.posse\/resources\/artifacts(?:\/|$)/;
        const isPreValidationArtifactPath = (value) => {
          const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
          const artifactRoot = artifactDirAbs.replace(/\/+$/, "");
          return normalized === artifactRoot
            || normalized.startsWith(`${artifactRoot}/`)
            || preValidationArtifactPathRe.test(normalized);
        };
        const hasPreValidationArtifactScope =
          isPreValidationArtifactPath(t.output_root)
          || (Array.isArray(t.create_roots) && t.create_roots.some(isPreValidationArtifactPath))
          || (Array.isArray(t.files_to_create) && t.files_to_create.some(isPreValidationArtifactPath));
        if (
          preValidationWiMode !== "build"
          && (t.job_type === "dev" || !t.job_type)
          && (!Array.isArray(t.files_to_modify) || t.files_to_modify.length === 0)
          && (!Array.isArray(t.files_to_delete) || t.files_to_delete.length === 0)
          && hasPreValidationArtifactScope
        ) {
          t.job_type = "artificer";
        }
        const validationErrors = validatePlannedTaskFromModule(t, i, tasks.length);
        if (validationErrors.length > 0) {
          const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : `task ${i}`;
          const artifactScopeRejected = String(t.job_type || "").trim().toLowerCase() === "artificer"
            && validationErrors.some((error) => /repo-wide write scope|below the repo root/i.test(error));
          if (validationErrors.some((error) => /^create_roots\[\d+\] /.test(error))) {
            underScopedDroppedTitles.push(title);
          }
          droppedTaskIndexes.add(i);
          worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped invalid task "${title}" — ${validationErrors.join("; ")}`);
          logEvent({
            work_item_id: planJob.work_item_id,
            job_id: planJob.id,
            event_type: EVENT_TYPES.PLAN_TASK_INVALID,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Dropped invalid planned task "${title}": ${validationErrors.join("; ")}`,
          });
          if (artifactScopeRejected) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.PLAN_SCOPE_REJECTED,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Dropped artifact task "${title}": broad create/output root from planner validation`,
              event_json: JSON.stringify({
                reason: "artifact_root_scope_rejected",
                validation_errors: validationErrors,
              }),
            });
          }
          continue;
        }
        const blockedDeps = Array.isArray(t.depends_on_index)
          ? t.depends_on_index.filter((depIdx) => droppedTaskIndexes.has(depIdx))
          : [];
        if (blockedDeps.length > 0) {
          const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : `task ${i}`;
          droppedTaskIndexes.add(i);
          worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped dependent task "${title}" — prerequisite task(s) ${blockedDeps.map((idx) => idx + 1).join(", ")} were dropped`);
          logEvent({
            work_item_id: planJob.work_item_id,
            job_id: planJob.id,
            event_type: EVENT_TYPES.PLAN_TASK_INVALID,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Dropped dependent planned task "${title}": prerequisite task(s) ${blockedDeps.map((idx) => idx + 1).join(", ")} were dropped`,
            event_json: JSON.stringify({
              reason: "dropped_dependency",
              dropped_dependencies: blockedDeps,
            }),
          });
          continue;
        }

        // Pivot: common LLM confusions between job_type and task_mode
        if (t.job_type === "code") {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: pivoted job_type "code" → "dev" in task "${t.title}"`);
          t.job_type = "dev";
        }
        if (t.task_mode === "dev") {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: pivoted task_mode "dev" → "code" in task "${t.title}"`);
          t.task_mode = "code";
        }
        // LLMs may put task_mode values in job_type — route to artificer
        const ARTIFACT_JOB_TYPE_PIVOTS = new Set(["content", "image", "report", "intake_processing"]);
        if (ARTIFACT_JOB_TYPE_PIVOTS.has(t.job_type)) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: pivoted job_type "${t.job_type}" → "artificer" (task_mode="${t.job_type}") in task "${t.title}"`);
          if (!t.task_mode || t.task_mode === "code") t.task_mode = t.job_type;
          t.job_type = "artificer";
        }
        const jobType = PLANNER_ALLOWED_TYPES.has(t.job_type) ? t.job_type : "dev";
        if (t.job_type && t.job_type !== jobType) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: invalid job_type "${t.job_type}" in task "${t.title}" — defaulting to "dev"`);
        }
        const normalizeTierAlias = (value) => {
          let current = value;
          for (let i = 0; i < 4; i++) {
            if (typeof current !== "string" || !Object.hasOwn(TIER_SYNONYMS, current)) break;
            current = TIER_SYNONYMS[current];
          }
          return current;
        };
        const usedTierSynonym = typeof t.model_tier === "string" && Object.hasOwn(TIER_SYNONYMS, t.model_tier);
        const rawTier = usedTierSynonym ? normalizeTierAlias(t.model_tier) : t.model_tier;
        const modelTier = VALID_TIERS.has(rawTier) ? rawTier : "standard";
      const plannerComplexityScore = normalizePlannerScore(t.planner_complexity_score ?? t.complexity);
      const plannerRiskScore = normalizePlannerScore(t.planner_risk_score ?? t.risk);
      const plannerVerificationScore = normalizePlannerScore(t.planner_failure_cost_score ?? t.verification_difficulty);
        if (t.model_tier && !usedTierSynonym && t.model_tier !== modelTier) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: normalized model_tier "${t.model_tier}" → "${modelTier}" in task "${t.title}"`);
        }
        const usedEffortSynonym = typeof t.reasoning_effort === "string" && Object.hasOwn(EFFORT_SYNONYMS, t.reasoning_effort);
        const rawEffort = usedEffortSynonym ? EFFORT_SYNONYMS[t.reasoning_effort] : t.reasoning_effort;
        const baseReasoningEffort = VALID_EFFORTS.has(rawEffort) ? rawEffort : "medium";
        const taskHasExplicitBudget = t.deepthink_budget != null || t.research_budget != null || t.deepthink != null;
        const taskBudgetSource = t.deepthink_budget != null
          ? "deepthink_budget"
          : t.research_budget != null
            ? "research_budget"
            : t.deepthink != null
              ? "deepthink"
              : null;
        const taskResearchBudget = t.deepthink_budget != null
          ? t.deepthink_budget
          : t.research_budget != null
            ? t.research_budget
            : t.deepthink != null
              ? researchBudgetFromDeepthink(!!t.deepthink)
              : "normal";
        const deepthinkBudget = taskHasExplicitBudget
          ? normalizeResearchBudget(taskResearchBudget)
          : "normal";
        const reasoningEffort = taskHasExplicitBudget
          ? researchBudgetToReasoningEffort(deepthinkBudget, baseReasoningEffort)
          : baseReasoningEffort;
        const deepthink = isResearchBudgetDeep(deepthinkBudget);
        if (t.reasoning_effort && (usedEffortSynonym || t.reasoning_effort !== baseReasoningEffort)) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: normalized reasoning_effort "${t.reasoning_effort}" → "${baseReasoningEffort}" in task "${t.title}"`);
        }
        if (taskHasExplicitBudget && baseReasoningEffort !== reasoningEffort) {
          const sourceValue = taskBudgetSource === "deepthink"
            ? String(!!t.deepthink)
            : deepthinkBudget;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: applied ${taskBudgetSource}="${sourceValue}": reasoning_effort "${baseReasoningEffort}" → "${reasoningEffort}" in task "${t.title}"`);
        }

        // ── Task mode validation ──
        let taskMode = t.task_mode || "code";
        if (taskMode !== "code" && !isValidTaskMode(taskMode)) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: invalid task_mode "${taskMode}" → "code" in task "${t.title}"`);
          taskMode = "code";
        }

        const wi = getWorkItem(planJob.work_item_id);
        const wiMode = wi?.mode || "build";
        const wiModeConfig = getWiModeConfig(wiMode);
        const intakeHints = getWorkItemIntakeHints(wi, wiMode);
        const explicitBindings = getExplicitIntakeBindingsFromModule(wi);
        const desiredOutputs = Array.isArray(explicitBindings.desiredOutputs) ? explicitBindings.desiredOutputs : [];
        const plannerRepoEditTask = jobType === "dev" && Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0;
        const plannerRepoMutationScope =
          (Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0)
          || (Array.isArray(t.files_to_delete) && t.files_to_delete.length > 0);
        const plannerRepoCreateScope = Array.isArray(t.files_to_create) && t.files_to_create.length > 0;
        const plannerRepoWritableScope = plannerRepoMutationScope || plannerRepoCreateScope;

        // ── DB-only task normalization (task_mode:"db") ──
        // A db task's entire write surface is the project database; it must
        // carry no file scope (locks/commit machinery key on task_mode:"db"
        // carrying none). Contradictory shapes degrade to dev/code — the file
        // scope wins. A db task compiled without a write-capable grant fails
        // fast at the developer preflight; warn here so the gap is visible in
        // plan events rather than only as a downstream job failure.
        if (taskMode === "db") {
          if (plannerRepoWritableScope) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: db task "${t.title}" carries file scope — demoted to dev/code`);
            taskMode = "code";
            t.task_mode = "code";
          } else {
            if (t.output_root) t.output_root = null;
            let dbWritePerms = [];
            try {
              dbWritePerms = projectDbEffectivePermissions({ projectDir: worker.projectDir, capability: "write" })
                .filter((perm) => perm !== "read");
            } catch {
              dbWritePerms = [];
            }
            if (dbWritePerms.length === 0) {
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: db task "${t.title}" compiled without a write-capable project DB grant — it will fail fast unless the grant is configured`);
            }
          }
        }
        const forceRepoOutput = explicitBindings.outputMode === "repo";
        const forceArtifactOutput = explicitBindings.outputMode === "artifact";
        const intakeDesiredOutputs = Array.isArray(intakeHints.desired_outputs)
          ? intakeHints.desired_outputs.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
          : [];
        const artifactOnlyOutputHint =
          !forceRepoOutput
          && (
            forceArtifactOutput
            || wiMode === "report"
            || wiMode === "image"
            || (intakeDesiredOutputs.includes("artifact") && !intakeDesiredOutputs.includes("repo"))
          );
        const hintedRepoDesignTask = !artifactOnlyOutputHint && looksLikeRepoDesignTaskFromModule(t, intakeHints);

        // Repo-output bindings can rescue artifact-looking work, but not tasks
        // that are explicitly marked as image generation.
        if (forceRepoOutput && jobType === "artificer" && wiMode === "build" && !t.needs_image_generation && taskMode !== "image") {
          t.job_type = "dev";
          if (taskMode !== "code") taskMode = "code";
          t.task_mode = "code";
          if (t.output_root) t.output_root = null;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: explicit output_mode=repo preserved "${t.title}" as dev/code`);
        }
        if (forceArtifactOutput && jobType === "dev" && wiMode === "build" && taskMode !== "code" && taskMode !== "db") {
          t.job_type = "artificer";
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: explicit output_mode=artifact preserved "${t.title}" as artificer/${taskMode}`);
        }

        // ── Infer image generation intent from task spec early ──
        // This must run before WI/build-mode routing and artifact reuse preflight so
        // provider-pinned image jobs can be narrowed or skipped deterministically.
        if (!t._file_kind_split_done && !t.needs_image_generation && (jobType === "dev" || jobType === "artificer") && (taskMode === "code" || taskMode === "content" || taskMode === "image")) {
          const spec = (t.task_spec || t.instructions || t.title || "").toLowerCase();
          const referencesExistingAsset = /\b(use|reuse|keep|preserve|retain|show|display|place|position|align|style|restyle|resize|move|update|wire up|reference|references)\b[\s\S]{0,60}\b(existing|current|already)\b/.test(spec)
            || /\b(existing|current|already)\b[\s\S]{0,80}\b(logo|icon|image|images|banner|photo|graphic|artwork|illustration|asset|assets)\b/.test(spec);
          const explicitImageAsset = /\b(png|jpg|jpeg|webp|svg|illustration|photo|raster image|screenshot|mockup|thumbnail|hero image|image asset|dall-?e)\b/.test(spec);
          const explicitImageGeneration = hasRequestedImageGenerationOutput(t, { pathOnlyIsIntent: false });
          const structuredImageOutputs = collectRequestedImageOutputs(t, { includeText: false });
          const documentationArtifactIntent =
            taskMode !== "image"
            && structuredImageOutputs.length === 0
            && /\b(readme|markdown|\.md|report|documentation|docs?|usage note|intended use|explaining|describing)\b/.test(spec);
          const shouldInferImageGeneration =
            !forceRepoOutput
            && !hintedRepoDesignTask
            && !referencesExistingAsset
            && !documentationArtifactIntent
            && (explicitImageGeneration || (!plannerRepoWritableScope && explicitImageAsset));
          if (shouldInferImageGeneration) {
            t.needs_image_generation = true;
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: inferred needs_image_generation from task spec in "${t.title}"`);
            if (taskMode === "code" && !plannerRepoEditTask) {
              const inferredTaskMode = wiMode === "build" ? "image" : wiModeConfig.defaultTaskMode;
              taskMode = inferredTaskMode;
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: inferred task_mode "${inferredTaskMode}" from image-generation task "${t.title}"`);
            }
          }
        }

        // ── WI-mode enforcement ──
        // If the WI has a non-build mode, force artifact task modes regardless
        // of what the planner emitted. This is the deterministic guardrail.
        const inferredPromote = inferPromoteTaskFromModule(t, artifactDirAbs);
        if (inferredPromote) {
          t = inferredPromote;
          tasks[i] = t;
          if (dropInvalidRewrittenTask(t, i, "inferred_promote")) continue;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: normalized artifact copy task "${t.title}" → "promote"`);
        }
        let normalizedJobType = PLANNER_ALLOWED_TYPES.has(t.job_type) ? t.job_type : jobType;
        const fileKindRoute = splitTaskByCreateFileKind(t, i, artifactDirAbs, { taskMode, normalizedJobType });
        if (fileKindRoute?.splitTasks?.length > 1) {
          if (splitGroupCrossesTaskCap(i, fileKindRoute.splitTasks.length)) {
            dropSplitGroupAtCap(t, i, fileKindRoute.splitTasks, "file_kind_split");
            continue;
          }
          rewriteDependenciesAfterSplit(tasks, i, fileKindRoute.splitTasks.length, fileKindRoute.finalIndex);
          rewritePendingDependenciesAfterSplit(i, fileKindRoute.splitTasks.length, fileKindRoute.finalIndex);
          tasks.splice(i, 1, ...fileKindRoute.splitTasks);
          capExpandedTasks("file_kind_split");
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${fileKindRoute.reason} in task "${t.title}"`);
          i -= 1;
          continue;
        }
        if (fileKindRoute?.normalizedTask) {
          t = fileKindRoute.normalizedTask;
          tasks[i] = t;
          if (dropInvalidRewrittenTask(t, i, "file_kind_normalization")) continue;
          taskMode = t.task_mode || taskMode;
          normalizedJobType = PLANNER_ALLOWED_TYPES.has(t.job_type) ? t.job_type : jobType;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${fileKindRoute.reason} in task "${t.title}"`);
        }
        const repoMutationScopeAfterSplit =
          (Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0)
          || (Array.isArray(t.files_to_delete) && t.files_to_delete.length > 0);
        const createKindSummaryAfterSplit = repoMutationScopeAfterSplit
          ? getCreateFileKindSummaryFromModule(t, artifactDirAbs)
          : null;
        if (
          repoMutationScopeAfterSplit
          && (normalizedJobType === "dev" || normalizedJobType === "artificer")
          && (taskMode === "image" || t.needs_image_generation)
          && (!createKindSummaryAfterSplit || createKindSummaryAfterSplit.imageFiles.length === 0)
          && !hasRequestedImageGenerationOutput(t)
        ) {
          t.job_type = "dev";
          taskMode = "code";
          t.task_mode = "code";
          t.needs_image_generation = false;
          if (t.output_root) t.output_root = null;
          if (Array.isArray(t.create_roots) && t.create_roots.length > 0) t.create_roots = [];
          normalizedJobType = "dev";
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: preserved repo-edit image-adjacent task "${t.title}" as dev/code`);
        }
        const plannerImageTask = taskMode === "image" || !!t.needs_image_generation;
        if (plannerImageTask && (normalizedJobType === "dev" || normalizedJobType === "artificer")) {
          t.job_type = "artificer";
          taskMode = "image";
          t.task_mode = "image";
          t.needs_image_generation = true;
          if (!t.output_root) t.output_root = artifactDirAbs;
          if (!Array.isArray(t.create_roots) || t.create_roots.length === 0) t.create_roots = [t.output_root];
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: preserved image task "${t.title}" as artificer/image`);
        }
        const plannerRepoEditTaskNormalized = normalizedJobType === "dev" && Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0;
        const plannerRepoCodeCreateTaskNormalized = normalizedJobType === "dev" && looksLikeRepoCodeCreationTaskFromModule(t, artifactDirAbs);
        // The hinted-repo-design heuristic is a pattern match (keywords like
        // "admin"/"page" in both designIntent and repoSurface regexes). It
        // should lose to an explicit user binding of output_mode=artifact —
        // otherwise a plan artifact whose spec mentions the feature area
        // gets force-routed to repo code by downstream blocks via this flag.
        const plannerRepoCodeTaskNormalized =
          plannerRepoEditTaskNormalized
          || plannerRepoCodeCreateTaskNormalized
          || (hintedRepoDesignTask && !forceArtifactOutput)
          || forceRepoOutput;

        // Downgrade artificer → dev only when the hinted-repo-design heuristic
        // fires AND the user hasn't explicitly bound the WI to artifact output.
        // The explicit binding wins over pattern matching — otherwise a task
        // whose spec mentions "admin" or "page" can get miscategorized just
        // because those words are in both designIntent and repoSurface regexes.
        if (
          (hintedRepoDesignTask || forceRepoOutput)
          && !forceArtifactOutput
          && normalizedJobType === "artificer"
          && !t.needs_image_generation
          && taskMode !== "image"
        ) {
          t.job_type = "dev";
          taskMode = "code";
          t.task_mode = "code";
          if (t.output_root) t.output_root = null;
          const reason = forceRepoOutput ? "explicit output_mode=repo" : "hinted repo design task";
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: preserved ${reason} "${t.title}" as dev/code`);
        }

        if (
          wiMode === "build"
          && taskMode === "code"
          && normalizedJobType === "dev"
          && !plannerRepoCodeTaskNormalized
          && looksLikeArtifactGenerationTaskFromModule(t, artifactDirAbs)
        ) {
          taskMode = "report";
          t.job_type = "artificer";
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: build WI rerouted artifact-like data task "${t.title}" → artificer/report`);
        }

        if (wiMode !== "build") {
          if (plannerRepoCodeTaskNormalized && taskMode !== "code") {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: preserved repo-edit task "${t.title}" as code-mode inside WI mode "${wiMode}"`);
            taskMode = "code";
          }
          // Force job_type to artificer for non-build WIs — artifact work belongs to the artificer role
          if (!plannerRepoCodeTaskNormalized && normalizedJobType === "dev") {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: WI mode "${wiMode}" routed job_type "dev" → "artificer" in task "${t.title}"`);
            t.job_type = "artificer";
          }
          // Force task_mode if planner emitted an invalid mode for this WI
          if (!plannerRepoCodeTaskNormalized && !wiModeConfig.allowedTaskModes.includes(taskMode)) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: WI mode "${wiMode}" forced task_mode "${taskMode}" → "${wiModeConfig.defaultTaskMode}" in task "${t.title}"`);
            taskMode = wiModeConfig.defaultTaskMode;
          }
          // Strip files_to_modify — artifact WIs don't touch repo files
          if (!plannerRepoCodeTaskNormalized && t.files_to_modify?.length > 0) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: WI mode "${wiMode}" stripped ${t.files_to_modify.length} files_to_modify in task "${t.title}"`);
            t.files_to_modify = [];
          }
          // Auto-populate output_root and create_roots if missing
          if (!plannerRepoCodeTaskNormalized && !t.output_root) t.output_root = artifactDirAbs;
          if (!plannerRepoCodeTaskNormalized && (!t.create_roots || t.create_roots.length === 0)) t.create_roots = [artifactDirAbs];
          // For image WI: force needs_image_generation
          if (!plannerRepoCodeTaskNormalized && wiMode === "image" && taskMode === "image" && !t.needs_image_generation) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: WI mode "image" auto-set needs_image_generation in task "${t.title}"`);
            t.needs_image_generation = true;
          }
        } else if (taskMode !== "code" && taskMode !== "db") {
          // Build WI with non-code task (image/content) — route to artificer.
          // Build WIs can mix code tasks (dev) with artifact tasks (artificer).
          // db tasks are excluded: they stay dev jobs with no artifact dirs.
          if (plannerRepoCodeTaskNormalized && !t.needs_image_generation && taskMode !== "image") {
            taskMode = "code";
            t.task_mode = "code";
            if (t.output_root) t.output_root = null;
          } else if (normalizedJobType === "dev") {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: build WI routed non-code task_mode "${taskMode}" → artificer in task "${t.title}"`);
            t.job_type = "artificer";
          }
          // Set up artifact dirs for the artificer
          if (!plannerRepoCodeTaskNormalized && !t.output_root) t.output_root = artifactDirAbs;
          if (!plannerRepoCodeTaskNormalized && (!t.create_roots || t.create_roots.length === 0)) t.create_roots = [artifactDirAbs];
          // Auto-set needs_image_generation for image tasks
          if (!plannerRepoCodeTaskNormalized && taskMode === "image" && !t.needs_image_generation) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: build WI auto-set needs_image_generation in task "${t.title}"`);
            t.needs_image_generation = true;
          }
        }

          let promoteFollowUp = null;
          if (
            wiMode === "build"
            && taskMode === "code"
            && (PLANNER_ALLOWED_TYPES.has(t.job_type) ? t.job_type : jobType) === "dev"
            && looksLikeStructuredDataRepoTransformTaskFromModule(t, artifactDirAbs)
          ) {
            const reroutePlan = buildStructuredDataPromotePlanFromModule(t, artifactDirAbs);
            if (reroutePlan) {
              t = reroutePlan.artifactTask;
              tasks[i] = t;
              if (dropInvalidRewrittenTask(t, i, "structured_data_artifact_reroute")) continue;
              if (dropInvalidRewrittenTask(reroutePlan.promoteTask, i, "structured_data_promote_follow_up")) continue;
              taskMode = "content";
              promoteFollowUp = reroutePlan.promoteTask;
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: rerouted structured data transform "${t.title}" → artificer + promote`);
            }
          }

          // Re-resolve jobType after WI-mode enforcement may have changed it
          let finalJobType = PLANNER_ALLOWED_TYPES.has(t.job_type) ? t.job_type : jobType;

          // Dev is for repo edits. Image generation always belongs to artificer.
          const finalRepoMutationScope =
            (Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0)
            || (Array.isArray(t.files_to_delete) && t.files_to_delete.length > 0);
          if (finalJobType === "dev" && finalRepoMutationScope && (taskMode === "image" || t.needs_image_generation) && !hasRequestedImageGenerationOutput(t)) {
            taskMode = "code";
            t.task_mode = "code";
            t.needs_image_generation = false;
            if (t.output_root) t.output_root = null;
            if (Array.isArray(t.create_roots) && t.create_roots.length > 0) t.create_roots = [];
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: preserved repo-edit image-adjacent task "${t.title}" as dev/code`);
          }

          // Dev is for repo edits. Image generation always belongs to artificer.
          if (finalJobType === "dev" && !finalRepoMutationScope && (taskMode === "image" || t.needs_image_generation)) {
            finalJobType = "artificer";
            taskMode = "image";
            t.job_type = "artificer";
            t.task_mode = "image";
            t.needs_image_generation = true;
            if (!t.output_root) t.output_root = artifactDirAbs;
            if (!Array.isArray(t.create_roots) || t.create_roots.length === 0) t.create_roots = [t.output_root];
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: rerouted image-generation task "${t.title}" from dev to artificer/image`);
          }

          if (finalJobType === "dev" && taskMode === "code" && !hasWritableScope(t) && desiredOutputs.includes("repo")) {
          t = buildIntermediateReportTask(t, artifactDirAbs, desiredOutputs);
            tasks[i] = t;
            taskMode = "report";
            finalJobType = "artificer";
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: rerouted zero-scope repo-bound task "${t.title}" → artificer/report for intermediate evidence`);
          }

          if (finalJobType === "dev" && taskMode === "code") {
            const hasModifyScope = Array.isArray(t.files_to_modify) && t.files_to_modify.length > 0;
            const hasCreateScope = Array.isArray(t.files_to_create) && t.files_to_create.length > 0;
            const broadNarrowScope = isBroadNarrowScopedCodeTask(t);
            const shouldDropForBroadNarrowScope = underScopedBroadGateMode === "enforce" && broadNarrowScope;
            if (underScopedBroadGateMode !== "off" && broadNarrowScope) {
              const level = underScopedBroadGateMode === "enforce" ? C.red : C.yellow;
              worker.emit(
                planJob.id,
                `${level}[plan-scope]${C.reset} WI#${planJob.work_item_id}: broad code task "${t.title}" has narrow writable scope (${underScopedBroadGateMode})`
              );
              if (underScopedBroadGateMode === "warn") {
                logEvent({
                  work_item_id: planJob.work_item_id,
                  job_id: planJob.id,
                  event_type: EVENT_TYPES.PLAN_TASK_SCOPE_WARNING,
                  actor_type: EVENT_ACTORS.SYSTEM,
                  message: `Broad code task "${t.title}" has narrow writable scope`,
                  event_json: JSON.stringify({
                    gate_mode: underScopedBroadGateMode,
                    files_to_modify: t.files_to_modify || [],
                    files_to_create: t.files_to_create || [],
                    create_roots: t.create_roots || [],
                  }),
                });
              }
            }
            if (
              (researchCandidateCount > 3 || shouldDropForBroadNarrowScope)
              && !hasModifyScope
              && !hasCreateScope
            ) {
              underScopedDroppedTitles.push(t.title);
              const reason = shouldDropForBroadNarrowScope
                ? `broad task with narrow writable scope in enforce mode (${underScopedBroadGateMode})`
                : `research identified ${researchCandidateCount} candidate files but files_to_modify/files_to_create are both empty`;
              worker.emit(
                planJob.id,
                `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped under-scoped code task "${t.title}" — ${reason}`
              );
              logEvent({
                work_item_id: planJob.work_item_id,
                job_id: planJob.id,
                event_type: EVENT_TYPES.PLAN_TASK_INVALID,
                actor_type: EVENT_ACTORS.SYSTEM,
                message: `Dropped under-scoped code task "${t.title}": ${reason}`,
                event_json: JSON.stringify({
                  reason: shouldDropForBroadNarrowScope ? "broad_narrow_scope_enforce" : "research_candidates_missing_scope",
                  research_candidate_count: researchCandidateCount,
                  gate_mode: underScopedBroadGateMode,
                }),
              });
              droppedTaskIndexes.add(i);
              continue;
            }
            const webAssetScopeRepair = repairWebAssetCreateScope(t);
            if (webAssetScopeRepair.changed) {
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: repaired web asset create scope for task "${t.title}" → ${webAssetScopeRepair.files.join(", ")}`);
            }
          }

          if (finalJobType === "dev" && taskMode === "code" && t.output_root) {
            const normalizedArtifactDir = artifactDirAbs.replace(/\\/g, "/").replace(/\/+$/, "");
            const artifactPathRe = /(?:^|\/)\.posse\/resources\/artifacts(?:\/|$)/;
            const isArtifactPath = (value) => {
              const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
              return normalized === normalizedArtifactDir
                || normalized.startsWith(`${normalizedArtifactDir}/`)
                || artifactPathRe.test(normalized);
            };
            const normalizedOutputRoot = String(t.output_root || "").replace(/\\/g, "/").replace(/\/+$/, "");
            if (isArtifactPath(normalizedOutputRoot)) {
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: stripped artifact output_root from repo code task "${t.title}"`);
              t.output_root = null;
              if (Array.isArray(t.create_roots) && t.create_roots.every((root) => isArtifactPath(root))) {
                const createRoots = [...new Set((t.files_to_create || [])
                  .map((file) => path.posix.dirname(String(file || "").replace(/\\/g, "/")))
                  .filter((dir) => dir && dir !== "."))];
                t.create_roots = createRoots;
              }
            }
          }

          // Artifact jobs within the same WI should not all contend on the shared
          // WI artifact root. Give each non-code artificer task its own output dir
          // unless the planner explicitly scoped it somewhere else.
          const shouldRunArtifactPreflight =
            (finalJobType === "artificer" && taskMode !== "code")
            || (!!t.needs_image_generation && !!t.output_root && Array.isArray(t.files_to_create) && t.files_to_create.length > 0);

        if (shouldRunArtifactPreflight) {
          const defaultRoot = artifactDirAbs.replace(/\/+$/, "");
          const normalizeResolvedRoot = (root) => path.resolve(worker.projectDir, String(root || "")).replace(/\\/g, "/").replace(/\/+$/, "");
          const explicitRoot = t.output_root ? normalizeResolvedRoot(t.output_root) : "";
          const createRoots = Array.isArray(t.create_roots) ? t.create_roots.map((r) => normalizeResolvedRoot(r)) : [];
          const rootLooksShared = !explicitRoot || explicitRoot === defaultRoot;
          const createRootsLookShared = createRoots.length === 0 || (createRoots.length === 1 && createRoots[0] === defaultRoot);
          if (rootLooksShared && createRootsLookShared) {
            const scopedRoot = artifactTaskOutputRoot(
              planJob.work_item_id,
              `task-${String(i + 1).padStart(2, "0")}-${artifactTaskSlug(t.title, taskMode)}`,
              worker.projectDir,
            ).replace(/\\/g, "/");
            t.output_root = scopedRoot;
            t.create_roots = [scopedRoot];
            worker.emit(planJob.id, `${C.cyan}[plan-validate]${C.reset} WI#${planJob.work_item_id}: scoped artifact task "${t.title}" to ${scopedRoot}`);
          }

          const priorArtifactInputRoots = derivePriorArtifactInputRoots(t, i);
          if (priorArtifactInputRoots.length > 0) {
            const existingInputRoots = Array.isArray(t.input_roots) ? t.input_roots : [];
            t.input_roots = [...new Set([...existingInputRoots, ...priorArtifactInputRoots])];
            worker.emit(planJob.id, `${C.cyan}[plan-validate]${C.reset} WI#${planJob.work_item_id}: added ${priorArtifactInputRoots.length} prior artifact input root(s) for task "${t.title}"`);
          }

          if (taskMode === "report" && (!Array.isArray(t.files_to_create) || t.files_to_create.length === 0)) {
            t.files_to_create = ["report.md"];
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: synthesized report deliverable file for task "${t.title}"`);
          }

          if (taskMode !== "content") {
            const normalizedFilesToCreate = normalizeArtifactCreateFiles(t.files_to_create || [], t.output_root || defaultRoot);
            if (JSON.stringify(normalizedFilesToCreate) !== JSON.stringify(t.files_to_create || [])) {
              t.files_to_create = normalizedFilesToCreate;
              worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: rebased artifact files_to_create into output_root for task "${t.title}"`);
            }
          }

          const reusePlan = planArtifactReuseFromModule({ ...t, task_mode: taskMode }, worker.projectDir);
          if (reusePlan && reusePlan.allExpectedReusable && reusePlan.validReusableOutputs) {
            t._planner_reuse_existing_outputs = reusePlan.reusableFiles.map((file) => file.path);
            worker.emit(planJob.id, `${C.cyan}[plan-validate]${C.reset} WI#${planJob.work_item_id}: reusing existing artifact outputs for "${t.title}" (${reusePlan.reusableFiles.length} file(s))`);
          } else if (reusePlan && reusePlan.missingCreateFiles.length < (t.files_to_create || []).length) {
            const reusedCount = (t.files_to_create || []).length - reusePlan.missingCreateFiles.length;
            t.files_to_create = reusePlan.missingCreateFiles;
            t.task_spec = [
              t.task_spec || t.instructions || "",
              "",
              `Planner note: ${reusedCount} deliverable(s) already exist in output_root and should be reused. Generate only these missing files:`,
              ...reusePlan.missingCreateFiles.map((file) => `- ${path.basename(file)}`),
            ].filter(Boolean).join("\n");
            worker.emit(planJob.id, `${C.cyan}[plan-validate]${C.reset} WI#${planJob.work_item_id}: narrowed artifact task "${t.title}" to ${reusePlan.missingCreateFiles.length} missing file(s)`);
          }
        }

        if (finalJobType === "artificer") {
          const broadRoot = [
            t.output_root,
            ...(Array.isArray(t.create_roots) ? t.create_roots : []),
          ].map(broadPlannerRoot).find(Boolean);
          if (broadRoot) {
            droppedTaskIndexes.add(i);
            worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped task "${t.title}" — artifact create/output scope must not target the repo root (${broadRoot})`);
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.PLAN_SCOPE_REJECTED,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Dropped artifact task "${t.title}": broad create/output root ${broadRoot}`,
            });
            continue;
          }
        }

        if (finalJobType === "promote") {
          const promoteOutputDirRoute = routePromoteTaskByOutputDir(t, i, tasks, artifactDirAbs);
          if (promoteOutputDirRoute?.splitTasks?.length > 1) {
            if (splitGroupCrossesTaskCap(i, promoteOutputDirRoute.splitTasks.length)) {
              dropSplitGroupAtCap(t, i, promoteOutputDirRoute.splitTasks, "promote_output_dir_split");
              continue;
            }
            rewriteDependenciesAfterSplit(tasks, i, promoteOutputDirRoute.splitTasks.length, promoteOutputDirRoute.finalIndex);
            rewritePendingDependenciesAfterSplit(i, promoteOutputDirRoute.splitTasks.length, promoteOutputDirRoute.finalIndex);
            tasks.splice(i, 1, ...promoteOutputDirRoute.splitTasks);
            capExpandedTasks("promote_output_dir_split");
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${promoteOutputDirRoute.reason}`);
            i -= 1;
            continue;
          }
          if (promoteOutputDirRoute?.normalizedTask) {
            t = promoteOutputDirRoute.normalizedTask;
            tasks[i] = t;
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${promoteOutputDirRoute.reason}`);
          }
        }

        if (dropInvalidRewrittenTask(t, i, "final_rewrite_validation")) continue;

        // ── Protocol-driven image capability validation ──
        // The image provider belongs to the generate_image tool call, not to
        // the artificer's chat provider assignment.
        let provider = null;
        const compiledRole = delegationRoleForJobTypeFromModule(finalJobType);
        const compiledRoleProviders = getAvailableProviders(compiledRole);
        if (finalJobType !== "promote" && finalJobType !== "human_input" && compiledRoleProviders.length <= 1) {
          provider = compiledRoleProviders[0] || getProviderName(compiledRole);
        }
        let imageRoute = null;
        let imageProviderUnavailable = false;
        let imageProviderUnavailableReason = null;
        if (t.needs_image_generation && finalJobType === "artificer" && taskMode !== "code") {
          imageRoute = resolveImageExecutionProviderFromModule({ needs_image_generation: true });
          if (imageRoute.readiness.ready) {
            worker.emit(planJob.id, `${C.cyan}[plan-validate]${C.reset} WI#${planJob.work_item_id}: image task "${t.title}" will use generate_image via ${imageRoute.provider}/${imageRoute.model}`);
          } else {
            imageProviderUnavailable = true;
            imageProviderUnavailableReason = imageRoute.readiness.reason || NO_IMAGE_PROVIDERS_AVAILABLE;
            worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: task "${t.title}" requires image generation — ${imageProviderUnavailableReason}`);
          }
        }

        if (finalJobType === "promote") {
          const resolvedSourceDir = resolvePromoteSourceDir(t, tasks, artifactDirAbs);
          if (resolvedSourceDir) t.source_dir = resolvedSourceDir;
        }

        // Build payload — promote jobs get a minimal deterministic payload
        const devMode = finalJobType === "dev" && taskMode === "code"
          ? normalizeDevMode(t.dev_mode, { fallback: DEFAULT_DEV_MODE })
          : null;
        if (finalJobType === "dev" && taskMode === "code" && t.dev_mode && !isValidDevMode(String(t.dev_mode).trim().toLowerCase().replace(/[\s-]+/g, "_"))) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: normalized dev_mode "${t.dev_mode}" → "${devMode}" in task "${t.title}"`);
        }
        let taskSkillIds = [];
        const plannerSkillIds = Array.isArray(t.skills) ? t.skills : [];
        if (t.skills != null && !Array.isArray(t.skills)) {
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ignored non-array skills field in task "${t.title}"`);
        }
        if (plannerSkillIds.length > 0 && finalJobType === "dev" && taskMode === "code") {
          const skillValidation = validateSkillIds(plannerSkillIds, compiledRole);
          taskSkillIds = skillValidation.valid;
          for (const id of skillValidation.invalid) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.SKILL_SKIPPED_UNKNOWN,
              actor_type: EVENT_ACTORS.PLANNER,
              message: `Planner selected unknown skill ${id} for task "${t.title}"`,
              event_json: JSON.stringify({ skill_id: id, task_title: t.title, role: compiledRole }),
            });
          }
          for (const id of skillValidation.disabled) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.SKILL_SKIPPED_DISABLED,
              actor_type: EVENT_ACTORS.PLANNER,
              message: `Planner selected disabled skill ${id} for task "${t.title}"`,
              event_json: JSON.stringify({ skill_id: id, task_title: t.title, role: compiledRole }),
            });
          }
        } else if (plannerSkillIds.length > 0) {
          for (const id of plannerSkillIds) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.SKILL_SKIPPED_DISABLED,
              actor_type: EVENT_ACTORS.PLANNER,
              message: `Planner selected skill ${id} for non-dev task "${t.title}"`,
              event_json: JSON.stringify({ skill_id: id, task_title: t.title, job_type: finalJobType, task_mode: taskMode, reason: "skills_dev_only" }),
            });
          }
        }
        if (shouldInferFrontendDesignSkill(t, { finalJobType, taskMode })) {
          const skillValidation = validateSkillIds([FRONTEND_DESIGN_SKILL_ID], compiledRole);
          if (skillValidation.valid.includes(FRONTEND_DESIGN_SKILL_ID)) {
            if (!taskSkillIds.includes(FRONTEND_DESIGN_SKILL_ID)) {
              taskSkillIds = mergeSkillId(taskSkillIds, FRONTEND_DESIGN_SKILL_ID);
              logEvent({
                work_item_id: planJob.work_item_id,
                job_id: planJob.id,
                event_type: EVENT_TYPES.SKILL_INFERRED,
                actor_type: EVENT_ACTORS.SYSTEM,
                message: `Inferred ${FRONTEND_DESIGN_SKILL_ID} for frontend task "${t.title}"`,
                event_json: JSON.stringify({ skill_id: FRONTEND_DESIGN_SKILL_ID, task_title: t.title, role: compiledRole, reason: "frontend_design_task" }),
              });
            }
          } else if (skillValidation.invalid.includes(FRONTEND_DESIGN_SKILL_ID)) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.SKILL_SKIPPED_UNKNOWN,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Inferred unknown skill ${FRONTEND_DESIGN_SKILL_ID} for task "${t.title}"`,
              event_json: JSON.stringify({ skill_id: FRONTEND_DESIGN_SKILL_ID, task_title: t.title, role: compiledRole, reason: "frontend_design_task" }),
            });
          } else if (skillValidation.disabled.includes(FRONTEND_DESIGN_SKILL_ID)) {
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.SKILL_SKIPPED_DISABLED,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: `Inferred disabled skill ${FRONTEND_DESIGN_SKILL_ID} for task "${t.title}"`,
              event_json: JSON.stringify({ skill_id: FRONTEND_DESIGN_SKILL_ID, task_title: t.title, role: compiledRole, reason: "frontend_design_task" }),
            });
          }
        }
        let normalizedPromotePayload = null;
        let promoteClaim = null;
        if (finalJobType === "promote") {
          normalizedPromotePayload = normalizePromoteMappingsFromModule(t, artifactDirAbs, { projectDir: worker.projectDir });
          if (!Array.isArray(normalizedPromotePayload.mappings) || normalizedPromotePayload.mappings.length === 0) {
            const message = `Dropped promote task "${t.title}": no valid repo-relative or proven web-root destination`;
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.JOB_DROPPED_INVALID_PROMOTE,
              actor_type: EVENT_ACTORS.PLANNER,
              message,
              event_json: JSON.stringify({
                task_title: t.title,
                source_dir: normalizedPromotePayload.source_dir || null,
              }),
            });
            continue;
          }
          promoteClaim = validatePromoteDestinationClaim(normalizedPromotePayload, {
            title: t.title,
            taskIndex: i,
            preferred: t._file_kind_split_done === true && Number.isInteger(t._split_promote_source_index),
          });
          if (!promoteClaim.ok) {
            dropDuplicatePromoteTask(promoteClaim, t.title);
            continue;
          }
        }

        const shouldApplyExecutionPolicy = finalJobType === "dev" && taskMode === "code";
        const executionPolicy = shouldApplyExecutionPolicy
          ? resolveTaskExecutionPolicy({
              task: t,
              jobType: finalJobType,
              taskMode,
              currentModelTier: modelTier,
              currentReasoningEffort: reasoningEffort,
            })
          : null;
        const resolvedModelTier = finalJobType === "promote"
          ? "cheap"
          : executionPolicy?.dev?.model_tier || modelTier;
        const resolvedReasoningEffort = finalJobType === "promote"
          ? "low"
          : executionPolicy?.dev?.reasoning_effort || reasoningEffort;
        const resolvedMaxTurnsOverride = executionPolicy?.dev?.max_turns_override || null;
        const resolvedRiskTags = executionPolicy?.risk_tags || normalizeRiskTags(t.risk_tags);
        if (executionPolicy && (resolvedModelTier !== modelTier || resolvedReasoningEffort !== reasoningEffort)) {
          const policyChanges = [];
          if (resolvedModelTier !== modelTier) {
            policyChanges.push(`model_tier "${modelTier}" → "${resolvedModelTier}"`);
          }
          if (resolvedReasoningEffort !== reasoningEffort) {
            policyChanges.push(`reasoning_effort "${reasoningEffort}" → "${resolvedReasoningEffort}"`);
          }
          const reasons = Array.isArray(executionPolicy.dev?.reasons) && executionPolicy.dev.reasons.length > 0
            ? executionPolicy.dev.reasons.join("; ")
            : "execution policy";
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: policy adjusted ${policyChanges.join(", ")} in task "${t.title}" (${reasons})`);
        }
        const devBriefResult = atlasDevBriefsEnabled && finalJobType === "dev" && taskMode === "code"
          ? sanitizePlannerDevBrief(t.dev_brief, worker.projectDir)
          : { brief: null, droppedFiles: [], droppedHashRefs: [] };
        if (devBriefResult.droppedFiles.length > 0 || devBriefResult.droppedHashRefs.length > 0) {
          const droppedCount = devBriefResult.droppedFiles.length + devBriefResult.droppedHashRefs.length;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: dropped ${droppedCount} ATLAS dev_brief item(s) in task "${t.title}"`);
        }
        let activeHashRefPacket = devBriefResult.hashRefPacket || null;
        const payloadJson = finalJobType === "promote"
          ? JSON.stringify(normalizedPromotePayload)
          : JSON.stringify({
              task_spec: t.task_spec || t.instructions || "",
              deepthink_budget: deepthinkBudget,
              deepthink,
              task_mode: taskMode,
              ...(devMode ? { dev_mode: devMode } : {}),
              needs_image_generation: !!t.needs_image_generation,
              ...(imageRoute?.provider ? {
                image_provider: imageRoute.provider,
                image_model: imageRoute.model || null,
              } : {}),
              output_root: t.output_root || null,
              input_roots: t.input_roots || [],
              files_to_modify: t.files_to_modify || [],
              files_to_create: t.files_to_create || [],
              files_to_delete: t.files_to_delete || [],
              create_roots: t.create_roots || [],
              ...(Array.isArray(t.must_modify) && t.must_modify.length > 0 ? { must_modify: t.must_modify } : {}),
              success_criteria: Array.isArray(t.success_criteria) ? t.success_criteria : t.success_criteria ? [t.success_criteria] : [],
              test_command: t.test_command || null,
              ...(devBriefResult.brief ? { dev_brief: devBriefResult.brief } : {}),
              ...(activeHashRefPacket ? { hash_ref_packet: activeHashRefPacket } : {}),
              ...(devBriefResult.droppedFiles.length > 0 ? { dropped_dev_brief_files: devBriefResult.droppedFiles } : {}),
              ...(devBriefResult.droppedHashRefs.length > 0 ? { dropped_dev_brief_hash_refs: devBriefResult.droppedHashRefs } : {}),
              _planner_set_files: (t.files_to_modify?.length > 0 || t.files_to_create?.length > 0 || t.files_to_delete?.length > 0) || false,
              risk: executionPolicy?.risk_score ?? plannerRiskScore,
              risk_tags: resolvedRiskTags,
              scope_confidence: executionPolicy?.scope_confidence || t.scope_confidence || null,
              verification_difficulty: plannerVerificationScore,
              planner_complexity_score: plannerComplexityScore,
              planner_risk_score: plannerRiskScore,
              planner_context_score: null,
              planner_failure_cost_score: plannerVerificationScore,
              ...(resolvedMaxTurnsOverride ? { _max_turns_override: resolvedMaxTurnsOverride } : {}),
              ...(executionPolicy?.assessor?.model_tier ? { _assess_model_tier: executionPolicy.assessor.model_tier } : {}),
              ...(executionPolicy?.assessor?.reasoning_effort ? { _assess_reasoning_effort: executionPolicy.assessor.reasoning_effort } : {}),
              ...(executionPolicy?.assessor?.pass_confidence_floor ? { _assess_pass_confidence_floor: executionPolicy.assessor.pass_confidence_floor } : {}),
              ...(executionPolicy ? { _execution_policy: executionPolicy } : {}),
              ...(taskSkillIds.length > 0 ? { skills: taskSkillIds } : {}),
            });

        const taskDedupeKey = plannedTaskDedupeKey(t, {
          finalJobType,
          taskMode,
          provider,
          modelTier: resolvedModelTier,
          reasoningEffort: resolvedReasoningEffort,
          payloadJson,
          promoteFollowUp,
        });
        const duplicateTask = taskDedupeKey ? duplicateTaskClaims.get(taskDedupeKey) : null;
        if (duplicateTask) {
          jobMap.set(i, duplicateTask.targetJobId);
          const message = `Skipped duplicate planned task "${t.title}": already covered by ${duplicateTask.job_type} job #${duplicateTask.job_id}`;
          worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
          logEvent({
            work_item_id: planJob.work_item_id,
            job_id: planJob.id,
            event_type: EVENT_TYPES.PLAN_TASK_INVALID,
            actor_type: EVENT_ACTORS.SYSTEM,
            message,
            event_json: JSON.stringify({
              reason: "duplicate_planned_task",
              task_index: i,
              existing_task_index: duplicateTask.task_index,
              existing_job_id: duplicateTask.job_id,
              dependency_target_job_id: duplicateTask.targetJobId,
              task_title: t.title,
            }),
          });
          continue;
        }
        if (!hasJobCapacity(t.title, "main_job_spawn")) continue;

        const job = spawnFromRole(plannerRole, "succeeded", finalJobType, {
          work_item_id: planJob.work_item_id,
          title: t.title,
          parent_job_id: planJob.id,
          priority: t.priority || planJob.priority || "normal",
          model_tier: resolvedModelTier,
          reasoning_effort: resolvedReasoningEffort,
          provider,
          max_attempts: finalJobType === "promote" ? 2 : undefined,
          payload_json: payloadJson,
          planner_complexity_score: plannerComplexityScore,
          planner_risk_score: plannerRiskScore,
          planner_failure_cost_score: plannerVerificationScore,
          skills: taskSkillIds,
        });
        allCreatedJobIds.add(job.id);
        recordCompiledTaskJob(i, job.id);
        let activeHashRefPacketDropped = [];
        if (activeHashRefPacket && sourceHashRefContext && finalJobType === "dev" && taskMode === "code") {
          const targetHashRefContext = {
            work_item_id: planJob.work_item_id,
            job_id: job.id,
          };
          const reissuedPacket = reissueHashRefHandoffPacket(activeHashRefPacket, {
            sourceContext: sourceHashRefContext,
            targetContext: targetHashRefContext,
            targetOwnerScope: "job",
          });
          if (reissuedPacket.packet) {
            activeHashRefPacket = reissuedPacket.packet;
            const existingPayload = parseJobPayload(job);
            existingPayload.hash_ref_packet = activeHashRefPacket;
            if (reissuedPacket.dropped.length > 0) {
              existingPayload.dropped_hash_ref_packet_refs = reissuedPacket.dropped;
            }
            updateJobPayload(job.id, JSON.stringify(existingPayload));
          }
          activeHashRefPacketDropped = reissuedPacket.dropped || [];
          if (activeHashRefPacketDropped.length > 0) {
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${activeHashRefPacketDropped.length} ATLAS hash_ref_packet ref(s) were not reissued for task "${t.title}"`);
          }
        }
        if (finalJobType === "promote") {
          recordPromoteDestinationClaim(job, normalizedPromotePayload, {
            files: promoteClaim?.files || null,
            taskIndex: i,
            preferred: t._file_kind_split_done === true && Number.isInteger(t._split_promote_source_index),
            superseded: promoteClaim?.superseded || [],
          });
        }

        if (t._planner_reuse_existing_outputs?.length > 0) {
          const reuseMsg = `Planner reused ${t._planner_reuse_existing_outputs.length} existing artifact output(s) in ${t.output_root}`;
          updateJobStatus(job.id, "succeeded");
          setJobResult(job.id, reuseMsg);
          storeArtifact({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: null,
            artifact_type: "response",
            content_long: [
              "--- ARTIFICER LOG START ---",
              "status: COMPLETE",
              `summary: ${reuseMsg}`,
              `deliverables: ${t._planner_reuse_existing_outputs.join(", ")}`,
              "criteria_check: planner verified existing outputs before execution",
              "--- ARTIFICER LOG END ---",
            ].join("\n"),
          });
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.JOB_ARTIFACT_REUSED,
            actor_type: EVENT_ACTORS.PLANNER,
            message: reuseMsg,
          });
        }

        jobMap.set(i, job.id);
        createdCount++;

        if (promoteFollowUp) {
          if (t.output_root) promoteFollowUp.source_dir = t.output_root;
          const normalizedPromotePayload = normalizePromoteMappingsFromModule(promoteFollowUp, artifactDirAbs, { projectDir: worker.projectDir });
          if (!Array.isArray(normalizedPromotePayload.mappings) || normalizedPromotePayload.mappings.length === 0) {
            const message = `Dropped promote follow-up "${promoteFollowUp.title}": no valid repo-relative or proven web-root destination`;
            worker.emit(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${message}`);
            logEvent({
              work_item_id: planJob.work_item_id,
              job_id: planJob.id,
              event_type: EVENT_TYPES.JOB_DROPPED_INVALID_PROMOTE,
              actor_type: EVENT_ACTORS.PLANNER,
              message,
              event_json: JSON.stringify({
                task_title: promoteFollowUp.title,
                source_dir: normalizedPromotePayload.source_dir || null,
              }),
            });
          } else {
            const promoteClaim = validatePromoteDestinationClaim(normalizedPromotePayload, {
              title: promoteFollowUp.title,
              taskIndex: i,
              preferred: true,
            });
            if (!promoteClaim.ok) {
              dropDuplicatePromoteTask(promoteClaim, promoteFollowUp.title);
            } else {
              // The promote follow-up is the second half of the artificer job
              // created just above — dropping it at the task cap would leave
              // artifacts generated but never promoted. It is exempt from
              // hasJobCapacity; createdCount++ below still counts it against
              // the cap for subsequent main tasks.
              const promotePayloadJson = JSON.stringify(normalizedPromotePayload);
              const promoteJob = spawnFromRole(plannerRole, "succeeded", "promote", {
                work_item_id: planJob.work_item_id,
                title: promoteFollowUp.title,
                parent_job_id: planJob.id,
                priority: t.priority || planJob.priority || "normal",
                model_tier: "cheap",
                reasoning_effort: "low",
                max_attempts: 2,
                payload_json: promotePayloadJson,
              });
              allCreatedJobIds.add(promoteJob.id);
              recordCompiledTaskJob(i, promoteJob.id);
              recordPromoteDestinationClaim(promoteJob, normalizedPromotePayload, {
                files: promoteClaim.files,
                taskIndex: i,
                preferred: true,
                superseded: promoteClaim.superseded,
              });
              addDependency(promoteJob.id, job.id, "hard");
              jobMap.set(i, promoteJob.id);
              createdCount++;
            }
          }
        }

        recordPlannerDependencies(job, t, i);

        if (taskDedupeKey) {
          duplicateTaskClaims.set(taskDedupeKey, {
            task_index: i,
            job_id: job.id,
            targetJobId: jobMap.get(i) || job.id,
            job_type: finalJobType,
            title: t.title,
          });
        }

        // Fail immediately if image generation was requested but no capable provider exists
        if (imageProviderUnavailable) {
          const errMsg = imageProviderUnavailableReason || NO_IMAGE_PROVIDERS_AVAILABLE;
          updateJobStatus(job.id, "failed");
          setJobError(job.id, errMsg);
          worker.emit(planJob.id, `${C.red}[plan-validate]${C.reset} WI#${planJob.work_item_id}: job #${job.id} failed — ${errMsg}`);
        }

        // ── Build per-job context directory (role-scoped) ──
        // Each dev/artificer job gets its own context dir with ONLY the files
        // in its scope. No access to planner context or other jobs' files.
        if ((finalJobType === "dev" || finalJobType === "artificer") && !imageProviderUnavailable) {
          const jobCtxDir = path.join(contextDir(wiScopeId(planJob.work_item_id), worker.projectDir), `job-${job.id}`);
          try {
            fs.mkdirSync(jobCtxDir, { recursive: true });

            // task.json — task spec, success criteria, scoped file lists
            fs.writeFileSync(path.join(jobCtxDir, "task.json"), JSON.stringify({
              title: t.title,
              task_spec: t.task_spec || t.instructions || "",
              deepthink_budget: deepthinkBudget,
              deepthink,
              job_type: finalJobType,
              task_mode: taskMode,
              ...(devMode ? { dev_mode: devMode } : {}),
              files_to_modify: t.files_to_modify || [],
              files_to_create: t.files_to_create || [],
              files_to_delete: t.files_to_delete || [],
              create_roots: t.create_roots || [],
              success_criteria: Array.isArray(t.success_criteria) ? t.success_criteria : t.success_criteria ? [t.success_criteria] : [],
              test_command: t.test_command || null,
              ...(devBriefResult.brief ? { dev_brief: devBriefResult.brief } : {}),
              ...(activeHashRefPacket ? { hash_ref_packet: activeHashRefPacket } : {}),
              ...(devBriefResult.droppedFiles.length > 0 ? { dropped_dev_brief_files: devBriefResult.droppedFiles } : {}),
              ...(devBriefResult.droppedHashRefs.length > 0 ? { dropped_dev_brief_hash_refs: devBriefResult.droppedHashRefs } : {}),
              ...(activeHashRefPacketDropped.length > 0 ? { dropped_hash_ref_packet_refs: activeHashRefPacketDropped } : {}),
            }, null, 2), "utf-8");

            // Copy only this job's scoped source files
            for (const fp of (t.files_to_modify || [])) {
              try {
                const src = path.resolve(worker.projectDir, fp);
                if (!fs.existsSync(src)) continue;
                const dest = path.join(jobCtxDir, fp);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(src, dest);
              } catch { /* skip */ }
            }

            // Thread context_dir into the payload for the dev handler
            const existingPayload = parseJobPayload(job);
            existingPayload.context_dir = jobCtxDir.replace(/\\/g, "/");
            updateJobPayload(job.id, JSON.stringify(existingPayload));
          } catch { /* context dir is nice-to-have, not critical */ }
        }

        const providerTag = provider ? ` ${C.dim}→ ${provider}${C.reset}` : "";
        if (finalJobType !== "promote") {
          worker.emit(planJob.id, `${C.cyan}[planner] Created job #${job.id}: ${t.title.slice(0, 60)}${providerTag}${C.reset}`);
        }
      }

      // ── Spawn delegator if multi-provider is configured ──
      // Only include jobs that actually need provider assignment (dev/fix/artificer).
      // Promote and human_input are deterministic — no provider needed.
      propagateDroppedPlannerDependencies();

      if (createdCount === 0) {
        if (underScopedDroppedTitles.length > 0) {
          const plannerPayload = worker.parsePayload(planJob);
          const recoveryRound = Math.max(0, Number.parseInt(plannerPayload._planner_scope_recovery_round || 0, 10) || 0) + 1;
          const escalatedPayload = {
            ...plannerPayload,
            deepthink_budget: maxResearchBudget(getResearchBudget(getWorkItem(planJob.work_item_id), plannerPayload), "high"),
            deepthink: true,
            _planner_scope_recovery_round: recoveryRound,
            _planner_scope_recovery_reason: "under_scoped_code_tasks",
            _planner_scope_recovery_titles: underScopedDroppedTitles,
          };
          updateJobPayload(planJob.id, JSON.stringify(escalatedPayload));
          worker.emit(
            planJob.id,
            `${C.yellow}[plan-recovery]${C.reset} WI#${planJob.work_item_id}: escalating planner retry (deepthink=true, round ${recoveryRound}) after under-scoped drop(s): ${underScopedDroppedTitles.join(", ")}`
          );
          logEvent({
            work_item_id: planJob.work_item_id,
            job_id: planJob.id,
            event_type: EVENT_TYPES.PLAN_RECOVERY_ESCALATED,
            actor_type: EVENT_ACTORS.SYSTEM,
            message: `Escalated planner retry after under-scoped task drop(s): ${underScopedDroppedTitles.join(", ")}`,
            event_json: JSON.stringify({
              recovery_round: recoveryRound,
              dropped_tasks: underScopedDroppedTitles,
              deepthink: true,
            }),
          });
        }
        logBadInputFailure(planJob, {
          layer: "planner",
          upstream: "validated_plan",
          classification: "no_valid_tasks",
          detail: "Planner plan contained no valid tasks after schema validation",
        });
        throw new Error("Planner plan contained no valid tasks after schema validation");
      }

      wirePlannerDependencies();

      if (needsDelegation()) {
        const delegatableJobs = [...jobMap.values()].map(id => getJob(id)).filter((j) =>
          j && j.status === "queued" && ASSESSABLE_JOB_TYPES.has(j.job_type)
        );
        if (delegatableJobs.length > 0) {
          const providerMap = getProviderMap();
          const delegationMode = getDelegationModeFromModule();

          if (delegationMode === "js") {
            const assignments = buildDeterministicDelegationsFromModule(delegatableJobs.map((j) => ({
              job_id: j.id,
              title: j.title,
              job_type: j.job_type,
              model_tier: j.model_tier,
              reasoning_effort: j.reasoning_effort,
              priority: j.priority,
              provider: j.provider,
            })), { providerMap });
            if (Array.isArray(assignments)) {
              for (const a of assignments) {
                applyDelegation(a.job_id, {
                  provider: a.provider || null,
                  model: a.model || null,
                  model_tier: a.model_tier || null,
                  reasoning_effort: a.reasoning_effort || null,
                  priority: a.priority || null,
                });
                worker.emit(planJob.id, `${C.magenta}[delegator-js]${C.reset} job #${a.job_id}: ${a.provider || "default"}${a.model_tier ? `/${a.model_tier}` : ""} - ${(a.reason || "").slice(0, 60)}`);
              }
            }
          } else {
            const mlPendingJobs = delegatableJobs.filter((j) => jobNeedsMlDelegationFromModule(j));
            if (mlPendingJobs.length > 0) {
              const wi = getWorkItem(planJob.work_item_id);
              const delegateJob = spawnFromRole(plannerRole, "succeeded", "delegate", {
                work_item_id: planJob.work_item_id,
                title: `Delegate: ${(wi?.title || planJob.title).slice(0, 50)}`,
                parent_job_id: planJob.id,
                priority: "high",
                model_tier: "cheap",
                reasoning_effort: "low",
                payload_json: JSON.stringify({
                  provider_map: providerMap,
                  pending_jobs: mlPendingJobs.map(j => ({
                    job_id: j.id,
                    title: j.title,
                    job_type: j.job_type,
                    model_tier: j.model_tier,
                    reasoning_effort: j.reasoning_effort,
                    priority: j.priority,
                    provider: j.provider,
                  })),
                }),
              });
              allCreatedJobIds.add(delegateJob.id);
              for (const j of mlPendingJobs) {
                addDependency(j.id, delegateJob.id, "hard");
              }
              // Track the delegate job so the optional approval gate can block
              // it too (otherwise it would run before the human reviews).
              jobMap.set(`__delegate__`, delegateJob.id);
              worker.emit(planJob.id, `${C.magenta}[delegator]${C.reset} spawned delegate job #${delegateJob.id} for ${mlPendingJobs.length} task(s)`);
            }
          }
        }
      }

      // ── Plan-approval gate (opt-in via account settings) ──
      // Every created job gets a hard-dep on the gate so none run until the
      // human approves/rejects. The gate is a human_input job parked at
      // waiting_on_human; `posse plan approve/reject` drives the transition.
      try {
        if (isPlanApprovalEnabled()) {
          const createdIds = [...allCreatedJobIds];
          if (createdIds.length > 0) {
            const wi = getWorkItem(planJob.work_item_id);
            const gateId = createPlanApprovalGate(planJob, createdIds, {
              wi_title: wi?.title || planJob.title,
              task_count: createdCount,
              job_count: createdIds.length,
            });
            if (gateId != null) {
              worker.emit(planJob.id, `${C.yellow}[plan-approval]${C.reset} WI#${planJob.work_item_id}: ${createdIds.length} job(s) blocked pending approval (gate job #${gateId})`);
            }
          }
        }
      } catch (err) {
        // Gate creation must not break a successful plan compilation. Log and
        // continue — operators see the event in the event log.
        worker.emit(planJob.id, `${C.red}[plan-approval]${C.reset} WI#${planJob.work_item_id}: gate creation failed — ${err?.message || String(err)}`);
        logEvent({
          work_item_id: planJob.work_item_id,
          job_id: planJob.id,
          event_type: EVENT_TYPES.PLAN_APPROVAL_GATE_FAILED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Plan approval gate creation failed: ${err?.message || String(err)}`,
        });
      }
}
