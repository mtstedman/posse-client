// lib/domains/worker/functions/helpers/verdicts/fail.js

import {
  addDependency,
  countFailedJobs,
  getDependents,
  getJob,
  logEvent,
  rewireDependency,
  rewireDependencyChain,
  runInTransaction,
  updateJobStatus,
} from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { isArtifactMode } from "../../../../artifacts/functions/index.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { hasWritableScope } from "../../../../handoff/functions/index.js";
import { jobLog } from "../../../../../shared/telemetry/functions/logging/logger.js";
import { getMaxFixChainDepth, getWiFailureThreshold } from "../../../../settings/functions/tunables.js";
import {
  buildFailureHistory as _buildFailureHistory,
  buildFixChainHistory as _buildFixChainHistory,
  buildIntermediateReportPayload as _buildIntermediateReportPayload,
  buildStructuredDataArtifactFixPlan as _buildStructuredDataArtifactFixPlan,
  _extractScopedPathsFromInstructions,
  inferGeneratedArtifactDeletionTargets as _inferGeneratedArtifactDeletionTargets,
  looksLikeStructuredDataRepoTransformRecovery as _looksLikeStructuredDataRepoTransformRecovery,
  mergeFixEditableScope as _mergeFixEditableScope,
  mergeUniquePaths as _mergeUniquePaths,
  normalizeFixTitle as _normalizeFixTitle,
  sanitizeScopedFixPaths as _sanitizeScopedFixPaths,
} from "../verdict-shared.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";

function _positiveFixEditTargets(instructions = "", paths = []) {
  const source = String(instructions || "").toLowerCase();
  const editRe = /\b(add|update|modify|edit|fix|implement|adjust|change|patch|repair|guard|harden)\b/i;
  const nonEditScopeRe = /\b(delete|remove|rollback|revert|restore|drop|prune|create|new file|generate|missing|does not exist)\b/i;
  return (Array.isArray(paths) ? paths : []).filter((filePath) => {
    const candidate = String(filePath || "").replace(/\\/g, "/").toLowerCase();
    if (!candidate) return false;
    const idx = source.indexOf(candidate);
    if (idx < 0) return false;
    const context = source.slice(Math.max(0, idx - 90), Math.min(source.length, idx + candidate.length + 90));
    return editRe.test(context) && !nonEditScopeRe.test(context);
  });
}

function _filterToInheritedScope(paths = [], inherited = []) {
  const allowed = new Set((Array.isArray(inherited) ? inherited : [])
    .map((entry) => String(entry || "").replace(/\\/g, "/"))
    .filter(Boolean));
  return (Array.isArray(paths) ? paths : [])
    .map((entry) => String(entry || "").replace(/\\/g, "/"))
    .filter((entry) => entry && allowed.has(entry));
}

function _isImageArtifactRecovery({ taskMode = "code", needsImageGeneration = false, outputRoot = null } = {}) {
  if (taskMode === "image") return true;
  return !!outputRoot && !!needsImageGeneration && isArtifactMode(taskMode);
}

function _artifactProtocolConfigText({ fixInstructions = "", assessorFeedback = [], specPayload = {} } = {}) {
  return [
    fixInstructions,
    ...(Array.isArray(assessorFeedback) ? assessorFeedback : []),
    specPayload?.instructions || "",
    specPayload?.task_spec || "",
    ...(Array.isArray(specPayload?.success_criteria) ? specPayload.success_criteria : []),
    ...(Array.isArray(specPayload?.files_to_modify) ? specPayload.files_to_modify : []),
    ...(Array.isArray(specPayload?.files_to_create) ? specPayload.files_to_create : []),
  ].filter(Boolean).join("\n").replace(/\\/g, "/").toLowerCase();
}

function _looksLikeArtifactRoutingAdminIssue({ fixInstructions = "", assessorFeedback = [], specPayload = {} } = {}) {
  const text = _artifactProtocolConfigText({ fixInstructions, assessorFeedback, specPayload });
  if (!text) return false;
  const mentionsArtifactRouting = /artifact routing unavailable|no artifact protocol configured|artifact protocol|allowed_extensions|allowed_formats|task_mode\s*["'`:= -]*image/.test(text);
  const asksForRoutingRepair = /artifact routing unavailable|no artifact protocol configured|add(?:ing)?\s+(?:an?\s+)?["'`]?image["'`]?\s+entry|configure(?:d|s|ing)?\s+.*artifact|protocol config/.test(text);
  return mentionsArtifactRouting && asksForRoutingRepair;
}

function _buildArtifactRoutingAdminPayload({
  job,
  fixInstructions,
  assessorFeedback,
  originalTaskMode,
  originalTaskSpec,
}) {
  const safeFeedback = Array.isArray(assessorFeedback) ? assessorFeedback : [];
  const modeLabel = String(originalTaskMode || "artifact");
  const safeInstructions = String(fixInstructions || safeFeedback.join("\n") || `Review Posse artifact routing for ${modeLabel} outputs.`);
  return {
    questions: [
      [
        `Job #${job.id} ("${job.title}") failed because Posse artifact routing for task_mode "${modeLabel}" appears unavailable or inconsistent.`,
        "",
        originalTaskSpec ? `Original task:\n${originalTaskSpec}` : null,
        `Assessor/routing feedback:\n${safeInstructions}`,
        safeFeedback.length > 0 ? `Additional assessor reasons:\n${safeFeedback.join("\n")}` : null,
        "",
        "This is Posse runtime/admin state, not a target-repo file. Adjust Posse artifact routing or choose a different task mode, then rerun the work item.",
      ].filter(Boolean).join("\n"),
    ],
    context: `Artifact routing admin review for failed job #${job.id}; repo mutation is intentionally blocked for this recovery path.`,
    review_type: "artifact_routing_admin",
    _artifact_routing_admin_review: true,
  };
}

function _isGenericArtifactRecovery({
  jobType = "",
  taskMode = "code",
  needsImageGeneration = false,
  outputRoot = null,
} = {}) {
  return jobType === "artificer"
    && !!outputRoot
    && isArtifactMode(taskMode)
    && !_isImageArtifactRecovery({ taskMode, needsImageGeneration, outputRoot });
}

function _buildGenericArtifactRecoveryPayload({
  job,
  fixInstructions,
  assessorFeedback,
  originalOutputRoot,
  originalSuccessCriteria,
  originalTaskSpec,
  originalTaskMode,
}) {
  const safeFeedback = Array.isArray(assessorFeedback) ? assessorFeedback : [];
  const safeInstructions = String(fixInstructions || safeFeedback.join("\n") || "Repair the artifact output.");
  return {
    original_job_id: job.id,
    original_title: job.title,
    task_mode: originalTaskMode,
    output_root: originalOutputRoot,
    task_spec: [
      "Repair the failed artifact deliverable using the configured output_root.",
      `Output root: ${originalOutputRoot}`,
      "The working directory is already output_root. When instructions mention `output_root/foo`, write `foo` directly inside the configured output_root; do not create a nested output_root directory and do not edit repository source files.",
      "",
      originalTaskSpec ? `ORIGINAL TASK:\n${originalTaskSpec}` : null,
      `REPAIR INSTRUCTIONS:\n${safeInstructions}`,
      safeFeedback.length > 0 ? `ASSESSOR FEEDBACK:\n${safeFeedback.join("\n")}` : null,
    ].filter(Boolean).join("\n"),
    instructions: safeInstructions,
    assessor_feedback: safeFeedback,
    files_to_modify: [],
    files_to_create: [],
    files_to_delete: [],
    create_roots: originalOutputRoot ? [originalOutputRoot] : [],
    success_criteria: Array.isArray(originalSuccessCriteria) ? originalSuccessCriteria : [],
    _artifact_recovery: true,
    _planner_set_files: true,
  };
}

function _buildImageArtifactRecoveryPayload({
  job,
  fixInstructions,
  assessorFeedback,
  originalCreateFiles,
  originalCreateRoots,
  originalFiles,
  originalOutputRoot,
  originalSuccessCriteria,
  originalTaskSpec,
  specPayload = {},
}) {
  const safeFeedback = Array.isArray(assessorFeedback) ? assessorFeedback : [];
  const safeInstructions = String(fixInstructions || safeFeedback.join("\n") || "Repair the image artifact output.");
  const outputRootLine = originalOutputRoot ? `Output root: ${originalOutputRoot}` : "Output root: use the configured output_root.";
  return {
    original_job_id: job.id,
    original_title: job.title,
    task_mode: "image",
    output_root: originalOutputRoot,
    needs_image_generation: true,
    task_spec: [
      "Repair the failed image artifact deliverables using the configured image-generation route.",
      outputRootLine,
      "",
      "IMAGE ROUTE REQUIREMENT:",
      "- Use the built-in `generate_image` tool for each PNG that must be created or replaced.",
      "- Do not create Python/Pillow scripts, JavaScript/canvas helpers, shell scripts, SVG source files, Markdown notes, disabled helpers, or any other sidecar files in output_root.",
      "- output_root must contain only the final image deliverables when the job finishes.",
      "- If `generate_image` is unavailable or cannot complete the requested assets, report BLOCKED or PARTIAL in ARTIFICER RESULT instead of synthesizing images with code.",
      "",
      originalTaskSpec ? `ORIGINAL TASK:\n${originalTaskSpec}` : null,
      `REPAIR INSTRUCTIONS:\n${safeInstructions}`,
      safeFeedback.length > 0 ? `ASSESSOR FEEDBACK:\n${safeFeedback.join("\n")}` : null,
    ].filter(Boolean).join("\n"),
    instructions: safeInstructions,
    assessor_feedback: safeFeedback,
    files_to_modify: Array.isArray(specPayload.files_to_modify) && specPayload.files_to_modify.length > 0
      ? specPayload.files_to_modify
      : originalFiles,
    files_to_create: Array.isArray(specPayload.files_to_create) && specPayload.files_to_create.length > 0
      ? specPayload.files_to_create
      : originalCreateFiles,
    create_roots: _mergeUniquePaths(
      originalCreateRoots,
      Array.isArray(specPayload.create_roots) ? specPayload.create_roots : [],
      originalOutputRoot ? [originalOutputRoot] : [],
    ),
    success_criteria: Array.isArray(specPayload.success_criteria) && specPayload.success_criteria.length > 0
      ? specPayload.success_criteria
      : originalSuccessCriteria,
    _image_artifact_recovery: true,
  };
}

function _buildMarkFailed(job, ctx) {
  // Idempotent failure mark. First call honors ctx.updateJobStatus (which
  // carries the lease token); subsequent calls within this verdict handler
  // are no-ops via the closed-over flag.
  let failedMarked = false;
  return () => {
    if (failedMarked) return true;
    failedMarked = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("failed")
      : updateJobStatus(job.id, "failed");
    return failedMarked;
  };
}

function _shouldRerouteZeroScopeCodeRecovery(job, currentPayload, desiredOutputs) {
  return (job.job_type === "dev" || job.job_type === "fix")
    && (currentPayload.task_mode || "code") === "code"
    && !hasWritableScope(currentPayload)
    && desiredOutputs.includes("repo");
}

function _spawnZeroScopeReportRecovery({ job, ctx, log, spawnFromAssessor, spawnedJobs, desiredOutputs }) {
  const reportJob = spawnFromAssessor("failed", "artificer", {
    work_item_id: job.work_item_id,
    title: `Report: ${job.title.slice(0, 80)}`,
    parent_job_id: job.id,
    priority: job.priority,
    model_tier: job.model_tier,
    reasoning_effort: job.reasoning_effort,
    payload_json: JSON.stringify(_buildIntermediateReportPayload(job, desiredOutputs)),
  });
  spawnedJobs.push(reportJob);
  log(`${C.yellow}[assessor]${C.reset} rerouted zero-scope code recovery to artificer/report #${reportJob.id}`);
  jobLog("FIX_SPAWNED", { wi: job.work_item_id, job: reportJob.id, detail: `for failed #${job.id}  zero-scope code task rerouted to intermediate report` });

  for (const dep of getDependents(job.id)) {
    rewireDependency(dep.job_id, job.id, reportJob.id, dep.dependency_kind);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: dep.job_id,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Dependency rewired: #${dep.job_id} dep on failed #${job.id} replaced with report #${reportJob.id}`,
    });
  }
}

function _escalateWiFailureThreshold({ job, verdict, failedCount, threshold, log, spawnFromAssessor, spawnedJobs }) {
  const failureHistory = _buildFailureHistory(job.work_item_id);
  const escalationJob = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Escalation: WI#${job.work_item_id} has ${failedCount} failures`,
    parent_job_id: job.id,
    priority: "urgent",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      questions: [
        `Work item has ${failedCount} failed dev/fix jobs and needs your guidance.\n\nLatest failure: "${job.title}"\nAssessor reasons: ${verdict.reasons.join("; ")}\n\n--- FULL FAILURE HISTORY ---\n${failureHistory}\n\nWhat should we do? Options:\n- Provide specific fix instructions (e.g. "use X approach instead of Y")\n- Simplify the task scope\n- Skip this work item\n- Retry with a different model tier`,
      ],
      context: `Automatic escalation: failure threshold (${failedCount}/${threshold}) exceeded. No more fix jobs will be spawned until you provide direction. The failure history above shows every error and assessor complaint so you can diagnose the root cause.`,
    }),
  });
  spawnedJobs.push(escalationJob);
  log(`${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} failure threshold (${failedCount}/${threshold})  escalated #${escalationJob.id}`);
  jobLog("ESCALATED", { wi: job.work_item_id, job: job.id, detail: `${failedCount} failures  spawned human_input #${escalationJob.id}. Reasons: ${verdict.reasons.slice(0, 2).join("; ").slice(0, 120)}` });

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORK_ITEM_ESCALATION,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Failure threshold (${threshold}) reached  escalated to human, fix spawning blocked`,
  });
}

function _measureFixChainDepth(job) {
  let depth = 0;
  let walker = job;
  while (walker && walker.parent_job_id) {
    if (walker.job_type === "fix") depth++;
    walker = getJob(walker.parent_job_id);
    if (!walker) break;
  }
  return depth;
}

function _escalateFixChainDepth({ job, verdict, fixChainDepth, maxFixChainDepth, log, spawnFromAssessor, spawnedJobs }) {
  const chainMsg = `Fix chain depth ${fixChainDepth} reached (max ${maxFixChainDepth})  escalating to human`;
  log(`${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} job #${job.id}: ${chainMsg}`);

  const chainHistory = _buildFixChainHistory(job);
  const chainEscalation = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Fix chain limit: ${job.title.slice(0, 70)}`,
    parent_job_id: job.id,
    priority: "high",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      questions: [
        `Job "${job.title}" has been through ${fixChainDepth} fix cycles and is still failing.\n\nLatest assessor reasons: ${verdict.reasons.join("; ")}\n\n--- FIX CHAIN HISTORY ---\n${chainHistory}\n\nThe same approach keeps failing. What should we try differently?`,
      ],
      context: `Fix chain: ${fixChainDepth} deep. Each fix attempt tried to address the assessor's feedback but the underlying issue persists. This likely needs a fundamentally different approach, not another retry.`,
    }),
  });
  spawnedJobs.push(chainEscalation);
  jobLog("ESCALATED", { wi: job.work_item_id, job: job.id, detail: `fix chain depth ${fixChainDepth}  spawned human_input #${chainEscalation.id}. Reasons: ${verdict.reasons.slice(0, 2).join("; ").slice(0, 120)}` });

  for (const dep of getDependents(job.id)) {
    rewireDependency(dep.job_id, job.id, chainEscalation.id, dep.dependency_kind);
  }

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_FIX_CHAIN_ESCALATION,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: chainMsg,
  });
}

function _extractOriginalPayloadContext(job) {
  const origPayload = parseJobPayload(job);
  const originalFiles = Array.isArray(origPayload.files_to_modify) ? origPayload.files_to_modify : [];
  const originalCreateFiles = Array.isArray(origPayload.files_to_create) ? origPayload.files_to_create : [];
  const originalDeleteFiles = Array.isArray(origPayload.files_to_delete) ? origPayload.files_to_delete : [];
  let originalCreateRoots = Array.isArray(origPayload.create_roots) ? origPayload.create_roots : [];
  const originalSuccessCriteria = Array.isArray(origPayload.success_criteria) ? origPayload.success_criteria : [];
  const originalTaskSpec = String(origPayload.task_spec || origPayload.instructions || "");
  const origTaskMode = origPayload.task_mode || "code";
  const origOutputRoot = origPayload.output_root || null;
  const origNeedsImageGen = !!origPayload.needs_image_generation;
  const origPlannerSetFiles = !!origPayload._planner_set_files;
  const origOneshotOrigin = origPayload.oneshot === true || origPayload.oneshot_origin === true;
  if (isArtifactMode(origTaskMode) && origOutputRoot) {
    originalCreateRoots = _mergeUniquePaths(originalCreateRoots, [origOutputRoot]);
  }
  return {
    originalFiles, originalCreateFiles, originalDeleteFiles, originalCreateRoots,
    originalSuccessCriteria, originalTaskSpec,
    origTaskMode, origOutputRoot, origNeedsImageGen, origPlannerSetFiles,
    origOneshotOrigin,
  };
}

function _normalizeScopePath(value) {
  return String(value || "").trim().replace(/\\/g, "/");
}

// One-shot lineage scope guard: a fix descended from a one-shot may keep the
// original file scope automatically, but any added modify/create/delete path
// or create root must be approved by a human before the fix can run.
function _oneshotFixScopeExpansions({
  origCtx,
  mergedFixModify,
  mergedFixCreate,
  mergedFixDelete,
  mergedFixRoots,
}) {
  const baselinePaths = new Set([
    ...origCtx.originalFiles,
    ...origCtx.originalCreateFiles,
    ...origCtx.originalDeleteFiles,
  ].map(_normalizeScopePath).filter(Boolean));
  const baselineRoots = new Set(origCtx.originalCreateRoots.map(_normalizeScopePath).filter(Boolean));

  const expansions = new Map();
  const record = (paths, kind, baseline) => {
    for (const raw of paths) {
      const candidate = _normalizeScopePath(raw);
      if (!candidate || baseline.has(candidate)) continue;
      const existing = expansions.get(candidate);
      if (existing) {
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      } else {
        expansions.set(candidate, { path: candidate, kinds: [kind] });
      }
    }
  };
  record(mergedFixModify, "modify", baselinePaths);
  record(mergedFixCreate, "create", baselinePaths);
  record(mergedFixDelete, "delete", baselinePaths);
  record(mergedFixRoots, "create_root", baselineRoots);
  return [...expansions.values()];
}

function _seedDefaultFixSpecIfMissing(verdict, job) {
  const hasSupportedFixSpec = verdict.spawn_jobs.some((spec) => !spec?.job_type || spec.job_type === "fix");
  if (!hasSupportedFixSpec) {
    verdict.spawn_jobs.push({
      job_type: "fix",
      title: _normalizeFixTitle(job.title),
      payload: { instructions: verdict.reasons.join("\n") },
    });
  }
}

function _dedupeSpawnSpecs(verdict) {
  // Dedup specs that would result in identical fix jobs. An assessor that
  // emits the same spec twice would otherwise spawn two redundant fixes and
  // wire both into every dependent's hard-dep list.
  const seen = new Set();
  verdict.spawn_jobs = verdict.spawn_jobs.filter((spec) => {
    const key = [
      spec?.job_type || "fix",
      (spec?.title || "").trim().toLowerCase(),
      (spec?.payload?.instructions || "").trim().toLowerCase(),
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _spawnRecoveryJobsForVerdict({
  job, verdict, currentPayload, origCtx, ctx, log, spawnFromAssessor, spawnedJobs,
}) {
  const {
    originalFiles, originalCreateFiles, originalDeleteFiles, originalCreateRoots,
    originalSuccessCriteria, originalTaskSpec,
    origTaskMode, origOutputRoot, origNeedsImageGen, origPlannerSetFiles,
    origOneshotOrigin,
  } = origCtx;
  // One-shot lineage marker survives every recovery spawn so later fixes and
  // file-request follow-ups keep the tightened one-shot policies.
  const oneshotPayloadFields = origOneshotOrigin ? { oneshot_origin: true } : {};

  const dependencyReplacementJobs = [];
  for (const spec of verdict.spawn_jobs) {
    if (spec.job_type !== "fix" && spec.job_type) {
      // Today only "fix" spawn specs are handled. A non-fix spec from the
      // assessor (e.g. "human_input") would otherwise be silently dropped,
      // leaving dependents blocked on the failed job. Log + emit an event
      // so the drop is at least visible until non-fix handlers exist.
      const skipMsg = `assessor returned spawn_job with unsupported job_type="${spec.job_type}"; skipped (only "fix" is implemented)`;
      try { log?.(`${C.yellow}[verdict] ${skipMsg}${C.reset}`); } catch { /* log best-effort */ }
      try {
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          event_type: EVENT_TYPES.ASSESSOR_SPAWN_JOB_SKIPPED,
          actor_type: EVENT_ACTORS.ASSESSOR,
          message: skipMsg,
          event_json: JSON.stringify({ skipped_job_type: spec.job_type }),
        });
      } catch { /* event logging best-effort */ }
      continue;
    }

    const fixInstructions = spec.payload?.instructions || verdict.reasons.join("\n");
    const explicitFixModify = _sanitizeScopedFixPaths(spec.payload?.files_to_modify, "spawn_jobs.files_to_modify");
    const explicitFixCreate = _sanitizeScopedFixPaths(spec.payload?.files_to_create, "spawn_jobs.files_to_create");
    const explicitFixRoots = Array.isArray(spec.payload?.create_roots) ? spec.payload.create_roots : [];
    const inferredFixScope = _extractScopedPathsFromInstructions(fixInstructions);
    const inferredFixModify = _positiveFixEditTargets(fixInstructions, inferredFixScope.files_to_modify);
    const inferredGeneratedDeletes = _inferGeneratedArtifactDeletionTargets(job, {
      ...currentPayload,
      fix_instructions: fixInstructions,
      assessor_feedback: verdict.reasons,
    });
    const inheritedEditableScope = _mergeFixEditableScope(originalFiles, originalCreateFiles);
    const inheritedExplicitModify = _filterToInheritedScope(explicitFixModify, inheritedEditableScope);
    const mergedFixCreate = _mergeUniquePaths(originalCreateFiles, explicitFixCreate, inferredFixScope.files_to_create);
    const mergedFixDelete = _mergeUniquePaths(originalDeleteFiles, inferredGeneratedDeletes);
    const mergedFixModify = _mergeUniquePaths(
      inheritedEditableScope,
      inheritedExplicitModify,
      inferredFixModify,
      mergedFixCreate,
    );
    const mergedFixRoots = _mergeUniquePaths(
      originalCreateRoots,
      explicitFixRoots,
      // Inferred files_to_create already grants each exact path. Promoting
      // their parent directories into create_roots broadens scheduler locks
      // and can deadlock otherwise-disjoint repair jobs under src/ or test/.
      (isArtifactMode(origTaskMode) && origOutputRoot) ? [origOutputRoot] : [],
    );

    if (_looksLikeStructuredDataRepoTransformRecovery({
      job,
      originalFiles,
      originalCreateFiles,
      taskSpec: originalTaskSpec,
      fixInstructions: spec.payload?.instructions || "",
      assessorFeedback: verdict.reasons,
    })) {
      const recoveryPlan = _buildStructuredDataArtifactFixPlan(job, {
        title: spec.title || job.title,
        fixInstructions: spec.payload?.instructions || verdict.reasons.join("\n"),
        assessorFeedback: verdict.reasons,
        originalFiles,
        originalCreateRoots: mergedFixRoots,
        originalSuccessCriteria,
      });
      const artifactFixJob = spawnFromAssessor("failed", "artificer", {
        work_item_id: job.work_item_id,
        title: recoveryPlan.artifactTitle,
        parent_job_id: job.id,
        priority: job.priority,
        model_tier: job.model_tier,
        reasoning_effort: job.reasoning_effort,
        skills: job.skills || null,
        payload_json: JSON.stringify({ ...recoveryPlan.artifactPayload, ...oneshotPayloadFields }),
      });
      const promoteJob = spawnFromAssessor("failed", "promote", {
        work_item_id: job.work_item_id,
        title: recoveryPlan.promoteTitle,
        parent_job_id: job.id,
        priority: job.priority,
        model_tier: "cheap",
        reasoning_effort: "low",
        max_attempts: 2,
        payload_json: JSON.stringify({ ...recoveryPlan.promotePayload, ...oneshotPayloadFields }),
      });
      addDependency(promoteJob.id, artifactFixJob.id, "hard");
      spawnedJobs.push(artifactFixJob, promoteJob);
      dependencyReplacementJobs.push({ job: promoteJob, label: "promote" });

      log(`${C.yellow}[assessor]${C.reset} spawned structured-data recovery #${artifactFixJob.id} + promote #${promoteJob.id}`);
      jobLog("FIX_SPAWNED", {
        wi: job.work_item_id,
        job: artifactFixJob.id,
        detail: `structured-data recovery for failed #${job.id} via artificer #${artifactFixJob.id} + promote #${promoteJob.id}`,
      });
      continue;
    }

    if (_looksLikeArtifactRoutingAdminIssue({
      fixInstructions,
      assessorFeedback: verdict.reasons,
      specPayload: spec.payload || {},
    })) {
      const routingPayload = _buildArtifactRoutingAdminPayload({
        job,
        fixInstructions,
        assessorFeedback: verdict.reasons,
        originalTaskMode: origTaskMode,
        originalTaskSpec,
      });
      const routingJob = spawnFromAssessor("failed", "human_input", {
        work_item_id: job.work_item_id,
        title: `Artifact routing review: ${job.title.slice(0, 70)}`,
        parent_job_id: job.id,
        priority: "high",
        model_tier: "cheap",
        payload_json: JSON.stringify(routingPayload),
      });
      spawnedJobs.push(routingJob);
      dependencyReplacementJobs.push({ job: routingJob, label: "artifact routing review" });

      log(`${C.yellow}[assessor]${C.reset} spawned artifact routing human review #${routingJob.id}: ${routingJob.title.slice(0, 60)}`);
      jobLog("FIX_SPAWNED", {
        wi: job.work_item_id,
        job: routingJob.id,
        detail: `artifact routing admin review for failed #${job.id}`,
      });
      continue;
    }

    if (_isImageArtifactRecovery({
      taskMode: origTaskMode,
      needsImageGeneration: origNeedsImageGen,
      outputRoot: origOutputRoot,
    })) {
      const imagePayload = _buildImageArtifactRecoveryPayload({
        job,
        fixInstructions,
        assessorFeedback: verdict.reasons,
        originalCreateFiles: mergedFixCreate,
        originalCreateRoots: mergedFixRoots,
        originalFiles,
        originalOutputRoot: origOutputRoot,
        originalSuccessCriteria,
        originalTaskSpec,
        specPayload: spec.payload || {},
      });
      const imageJob = spawnFromAssessor("failed", "artificer", {
        work_item_id: job.work_item_id,
        title: `Image artifact repair: ${(spec.title || job.title).slice(0, 70)}`,
        parent_job_id: job.id,
        priority: job.priority,
        model_tier: job.model_tier,
        reasoning_effort: job.reasoning_effort,
        skills: job.skills || null,
        payload_json: JSON.stringify({ ...imagePayload, ...oneshotPayloadFields }),
      });
      spawnedJobs.push(imageJob);
      dependencyReplacementJobs.push({ job: imageJob, label: "image artifact repair" });

      log(`${C.yellow}[assessor]${C.reset} rerouted image artifact recovery to artificer #${imageJob.id}: ${imageJob.title.slice(0, 60)}`);
      jobLog("FIX_SPAWNED", { wi: job.work_item_id, job: imageJob.id, detail: `image artifact recovery for failed #${job.id} via artificer route` });
      continue;
    }

    if (_isGenericArtifactRecovery({
      jobType: job.job_type,
      taskMode: origTaskMode,
      needsImageGeneration: origNeedsImageGen,
      outputRoot: origOutputRoot,
    })) {
      const artifactPayload = _buildGenericArtifactRecoveryPayload({
        job,
        fixInstructions,
        assessorFeedback: verdict.reasons,
        originalOutputRoot: origOutputRoot,
        originalSuccessCriteria,
        originalTaskSpec,
        originalTaskMode: origTaskMode,
      });
      const artifactJob = spawnFromAssessor("failed", "artificer", {
        work_item_id: job.work_item_id,
        title: `Artifact repair: ${(spec.title || job.title).slice(0, 70)}`,
        parent_job_id: job.id,
        priority: job.priority,
        model_tier: job.model_tier,
        reasoning_effort: job.reasoning_effort,
        skills: job.skills || null,
        payload_json: JSON.stringify({ ...artifactPayload, ...oneshotPayloadFields }),
      });
      spawnedJobs.push(artifactJob);
      dependencyReplacementJobs.push({ job: artifactJob, label: "artifact repair" });

      log(`${C.yellow}[assessor]${C.reset} rerouted artifact recovery to artificer #${artifactJob.id}: ${artifactJob.title.slice(0, 60)}`);
      jobLog("FIX_SPAWNED", { wi: job.work_item_id, job: artifactJob.id, detail: `artifact recovery for failed #${job.id} via artificer route` });
      continue;
    }

    const oneshotScopeExpansions = origOneshotOrigin
      ? _oneshotFixScopeExpansions({ origCtx, mergedFixModify, mergedFixCreate, mergedFixDelete, mergedFixRoots })
      : [];

    const fixJob = spawnFromAssessor("failed", "fix", {
      work_item_id: job.work_item_id,
      title: _normalizeFixTitle(spec.title || job.title),
      parent_job_id: job.id,
      priority: job.priority,
      provider: (job.job_type === "dev" || job.job_type === "fix") ? (job.provider || null) : null,
      model_tier: job.model_tier,
      reasoning_effort: job.reasoning_effort,
      skills: job.skills || null,
      payload_json: JSON.stringify({
        original_job_id: job.id,
        original_title: job.title,
        fix_instructions: fixInstructions,
        assessor_feedback: verdict.reasons,
        files_to_modify: mergedFixModify,
        files_to_create: mergedFixCreate,
        files_to_delete: mergedFixDelete,
        create_roots: mergedFixRoots,
        task_mode: origTaskMode,
        output_root: origOutputRoot,
        needs_image_generation: origNeedsImageGen,
        success_criteria: originalSuccessCriteria,
        _planner_set_files: origPlannerSetFiles,
        ...oneshotPayloadFields,
        // Fix jobs inherit the original scope as editable context; the
        // assessor verifies success after the fix, so don't require every
        // inherited file to be re-committed on each repair attempt.
        declared_output_contract: false,
      }),
    });
    spawnedJobs.push(fixJob);
    dependencyReplacementJobs.push({ job: fixJob, label: "fix" });

    if (oneshotScopeExpansions.length > 0) {
      // A one-shot's machine-derived scope was exactly one file. Same-file
      // fixes run automatically; a fix that adds paths or create roots is a
      // scope expansion and must be human-approved. Rejection cancels the
      // gated fix (dependents of the human job); approval releases it.
      const expansionDesc = oneshotScopeExpansions
        .map((entry) => `- ${entry.path} (${entry.kinds.join(", ")})`)
        .join("\n");
      const gateJob = spawnFromAssessor("failed", "human_input", {
        work_item_id: job.work_item_id,
        title: `Approve one-shot fix scope: ${oneshotScopeExpansions.slice(0, 3).map((entry) => entry.path).join(", ")}${oneshotScopeExpansions.length > 3 ? ` (+${oneshotScopeExpansions.length - 3})` : ""}`,
        parent_job_id: job.id,
        priority: "high",
        model_tier: "cheap",
        payload_json: JSON.stringify({
          original_job_id: job.id,
          questions: [
            [
              `Fix #${fixJob.id} descends from one-shot job #${job.id} ("${job.title}") but expands beyond the original one-file scope:`,
              expansionDesc,
              `Original one-shot scope: ${[...origCtx.originalFiles, ...origCtx.originalCreateFiles].join(", ") || "(none)"}`,
              `Reply with "approve" to let the expanded fix run or "reject" to cancel it.`,
            ].join("\n"),
          ],
          context: `One-shot lineage scope gate for fix #${fixJob.id}; assessor feedback: ${verdict.reasons.join("; ").slice(0, 500)}`,
          file_requests: oneshotScopeExpansions.map((entry) => ({
            path: entry.path,
            reason: `one-shot fix scope expansion (${entry.kinds.join(", ")})`,
            risk: "high",
          })),
        }),
      });
      addDependency(fixJob.id, gateJob.id, "hard");
      spawnedJobs.push(gateJob);

      log(`${C.yellow}[assessor]${C.reset} gated one-shot fix #${fixJob.id} on scope approval #${gateJob.id} (${oneshotScopeExpansions.length} added path(s))`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: fixJob.id,
        event_type: EVENT_TYPES.ONESHOT_FIX_SCOPE_GATED,
        actor_type: EVENT_ACTORS.ASSESSOR,
        message: `One-shot fix #${fixJob.id} scope expansion gated behind human approval #${gateJob.id}`,
        event_json: JSON.stringify({
          fix_job_id: fixJob.id,
          human_job_id: gateJob.id,
          original_scope: [...origCtx.originalFiles, ...origCtx.originalCreateFiles],
          expansions: oneshotScopeExpansions,
        }),
      });
    }

    log(`${C.yellow}[assessor]${C.reset} spawned fix #${fixJob.id}: ${fixJob.title.slice(0, 60)}`);
    jobLog("FIX_SPAWNED", { wi: job.work_item_id, job: fixJob.id, detail: `for failed #${job.id}  ${(verdict.reasons[0] || "").slice(0, 100)}` });
  }
  return dependencyReplacementJobs;
}

function _rewireDependentsToReplacements({ job, dependentsSnapshot, dependencyReplacementJobs }) {
  if (dependencyReplacementJobs.length === 0) return;

  const replacementIds = dependencyReplacementJobs.map((entry) => entry.job.id);
  const replacementSummary = dependencyReplacementJobs
    .map((entry) => `${entry.label} #${entry.job.id}`)
    .join(", ");
  const replacementById = new Map(dependencyReplacementJobs.map((entry) => [entry.job.id, entry]));
  for (const dep of dependentsSnapshot) {
    const result = rewireDependencyChain(dep.job_id, job.id, replacementIds, dep.dependency_kind, { returnDetails: true });
    if (result.rewired) {
      const insertedSummary = result.inserted
        .map((replacementId) => {
          const entry = replacementById.get(replacementId);
          return entry ? `${entry.label} #${entry.job.id}` : `#${replacementId}`;
        })
        .join(", ");
      logEvent({
        work_item_id: job.work_item_id,
        job_id: dep.job_id,
        event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRED,
        actor_type: EVENT_ACTORS.ASSESSOR,
        message: `Dependency rewired: #${dep.job_id} dep on failed #${job.id} replaced with ${insertedSummary}`,
        event_json: JSON.stringify({ replacements: result.inserted, skipped: result.skipped }),
      });
    } else {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: dep.job_id,
        event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRE_FAILED,
        actor_type: EVENT_ACTORS.ASSESSOR,
        message: `Dependency rewire failed: #${dep.job_id} remains dependent on failed #${job.id}; attempted replacements ${replacementSummary}`,
        event_json: JSON.stringify({ replacements: replacementIds, skipped: result.skipped }),
      });
    }
  }
}

export function handle(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor, reasonBrief, isFromSuggestion, desiredOutputs } = ctx;
  // Wrap the whole verdict body so fix-job spawning, dependency rewiring,
  // and the status update commit atomically. A crash mid-flow could otherwise
  // leave dependents pointing at jobs that don't exist (or at the original
  // failed job with replacements only partly wired).
  runInTransaction(() => {
    const markFailed = _buildMarkFailed(job, ctx);
    log(`${C.yellow}[assessor] FAIL${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);

    const currentPayload = parseJobPayload(job);
    const failedCount = countFailedJobs(job.work_item_id) + 1;
    if (!markFailed()) return;

    // Phase 1: zero-scope code job with repo output → reroute to artificer report.
    if (_shouldRerouteZeroScopeCodeRecovery(job, currentPayload, desiredOutputs)) {
      _spawnZeroScopeReportRecovery({ job, ctx, log, spawnFromAssessor, spawnedJobs, desiredOutputs });
      markFailed();
      return;
    }

    // Phase 2: too many failures for this WI → escalate to human_input.
    const wiFailureThreshold = getWiFailureThreshold();
    if (!isFromSuggestion && failedCount >= wiFailureThreshold) {
      _escalateWiFailureThreshold({
        job, verdict, failedCount, threshold: wiFailureThreshold,
        log, spawnFromAssessor, spawnedJobs,
      });
      markFailed();
      return;
    }

    // Phase 3: dev→fix→fix→… chain too deep → escalate. Walk parent_job_id
    // to count fix ancestors; escalate when at or above the configured cap.
    const fixChainDepth = _measureFixChainDepth(job);
    const maxFixChainDepth = getMaxFixChainDepth();
    if (fixChainDepth >= maxFixChainDepth) {
      _escalateFixChainDepth({
        job, verdict, fixChainDepth, maxFixChainDepth,
        log, spawnFromAssessor, spawnedJobs,
      });
      markFailed();
      return;
    }

    // Phase 4: spawn recovery jobs (fix/artificer/promote) and rewire deps.
    const origCtx = _extractOriginalPayloadContext(job);
    _seedDefaultFixSpecIfMissing(verdict, job);
    _dedupeSpawnSpecs(verdict);

    const dependentsSnapshot = getDependents(job.id);
    const dependencyReplacementJobs = _spawnRecoveryJobsForVerdict({
      job, verdict, currentPayload, origCtx, ctx,
      log, spawnFromAssessor, spawnedJobs,
    });
    _rewireDependentsToReplacements({ job, dependentsSnapshot, dependencyReplacementJobs });
    markFailed();
  });
}
