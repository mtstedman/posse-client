// lib/domains/worker/classes/roles/artificer.js
//
// Artificer role handler for artifact-producing tasks such as reports,
// generated content, and image outputs written into artifact roots.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import {
  getArtifactsByWorkItem,
  getAttempts,
  getIntSetting,
  getJob,
  getSetting,
  getWorkItem,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import {
  buildPromptAsync,
  buildRoutingPacket,
  extractResearcherFiles as defaultExtractResearcherFiles,
  handoff,
  packetToDynamicContextString,
  parseMissingContext,
} from "../../../handoff/functions/index.js";
import { getAvailableProviders, getProviderName } from "../../../providers/functions/provider.js";
import { artifactsDir, wiScopeId } from "../../../artifacts/functions/index.js";
import { BaseRole } from "../BaseRole.js";
import { currentExecutionProvider as defaultCurrentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import { hasStructuredArtificerLog as defaultHasStructuredArtificerLog } from "../../functions/helpers/artifact-output.js";
import { maxTurnsOverrideFromPayload } from "../../../../shared/policies/functions/role-utils.js";
import {
  looksLikePermissionRequest as defaultLooksLikePermissionRequest,
} from "../../functions/helpers/mutation-guards.js";
import { selectFallbackProvider as defaultSelectFallbackProvider } from "../../../providers/functions/delegation-routing.js";
import { shortJobTitle as defaultShortJobTitle } from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { validateArtifactRootPath } from "../../../planning/functions/plan-routing.js";
import { promptPersistenceSummary } from "../../../../shared/telemetry/functions/logging/prompt-persistence.js";

const DEFAULT_DEPS = {
  currentExecutionProvider: defaultCurrentExecutionProvider,
  extractResearcherFiles: defaultExtractResearcherFiles,
  hasStructuredArtificerLog: defaultHasStructuredArtificerLog,
  loadNudges: () => "",
  logBadInputFailure: () => {},
  looksLikePermissionRequest: defaultLooksLikePermissionRequest,
  selectFallbackProvider: defaultSelectFallbackProvider,
  shortJobTitle: defaultShortJobTitle,
};

function parsePayload(context, job) {
  if (typeof context?.parsePayload === "function") return context.parsePayload(job);
  return parseJobPayload(job);
}

function emit(context, jobId, message) {
  if (typeof context?.emit === "function") context.emit(jobId, message);
}

function normalizeDisplayPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(root, target) {
  const rootCmp = normalizePathForCompare(root);
  const targetCmp = normalizePathForCompare(target);
  return targetCmp === rootCmp || targetCmp.startsWith(rootCmp + path.sep);
}

function resolveContainedArtifactRoot(projectDir, value, label) {
  const err = validateArtifactRootPath(value, label);
  if (err) throw new Error(err);
  const root = path.resolve(projectDir);
  const target = path.resolve(root, String(value || ""));
  if (!isWithinRoot(root, target)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return target;
}

function resolveContainedArtifactRoots(projectDir, values, label) {
  if (!Array.isArray(values)) return [];
  const roots = [];
  const seen = new Set();
  for (const [idx, value] of values.entries()) {
    const resolved = resolveContainedArtifactRoot(projectDir, value, `${label}[${idx}]`);
    const display = normalizeDisplayPath(resolved);
    if (seen.has(display)) continue;
    seen.add(display);
    roots.push(display);
  }
  return roots;
}

export class ArtificerRole extends BaseRole {
  static role = "artificer";
  static spawnsOnSuccess = spawnSuccessForRole("artificer");
  static spawnsOnFailure = spawnFailureForRole("artificer");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  buildContract() {
    return "";
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const projectDir = worker?.projectDir || process.cwd();
    const {
      extractResearcherFiles,
      loadNudges,
    } = this.roleDeps();

    const workItem = getWorkItem(job.work_item_id);
    const payload = parsePayload(worker, job);
    const rawOutputRoot = payload.output_root || artifactsDir(wiScopeId(job.work_item_id), projectDir);
    const artCwd = rawOutputRoot ? resolveContainedArtifactRoot(projectDir, rawOutputRoot, "output_root") : projectDir;
    const outputRoot = rawOutputRoot ? normalizeDisplayPath(artCwd) : null;
    if (rawOutputRoot) fs.mkdirSync(artCwd, { recursive: true });
    if (!payload.output_root) {
      emit(worker, job.id, `${C.yellow}[artificer]${C.reset} WI#${job.work_item_id} job #${job.id}: missing output_root - defaulting to ${outputRoot}`);
    }

    const createRoots = resolveContainedArtifactRoots(projectDir, payload.create_roots || [], "create_roots");
    const inputRoots = resolveContainedArtifactRoots(projectDir, payload.input_roots || [], "input_roots");
    const researchArtifacts = getArtifactsByWorkItem(job.work_item_id, "response")
      .filter((a) => {
        const relatedJob = getJob(a.job_id);
        return relatedJob?.job_type === "research";
      });
    const referenceFiles = extractResearcherFiles(researchArtifacts);
    const summaries = getArtifactsByWorkItem(job.work_item_id, "summary");
    const projectContext = summaries.length > 0 ? summaries[summaries.length - 1].content_long : "";
    const attempts = getAttempts(job.id);
    const previousAttempts = attempts.filter((attempt) => attempt.status !== "running");
    const currentAttemptNumber = previousAttempts.length + 1;
    const lastError = previousAttempts.length > 0
      ? (job.last_error || previousAttempts[previousAttempts.length - 1].error_text || null)
      : null;

    if (payload._stall_resume && outputRoot) {
      emit(worker, job.id, `${C.green}[resume]${C.reset} WI#${job.work_item_id} job #${job.id}: continuing from previous attempt`);
    } else if (previousAttempts.length > 0) {
      emit(worker, job.id, `${C.yellow}[restart]${C.reset} WI#${job.work_item_id} job #${job.id}: attempt ${currentAttemptNumber} - starting over`);
    } else {
      emit(worker, job.id, `${C.green}[new]${C.reset} WI#${job.work_item_id} job #${job.id}: first attempt`);
    }

    const packet = buildRoutingPacket(job, {
      workItem,
      payload,
      role: this.getRole(),
      effectiveTier: ctx.tier,
      attemptCount: currentAttemptNumber,
      maxAttempts: job.max_attempts || 3,
      lastError,
      cwd: artCwd,
      relatedFiles: referenceFiles,
      projectContext,
      contextHints: { related_files_cwd: projectDir },
      disableAtlas: true,
      disableAtlasReason: "artifact route",
    });
    await handoff(packet);

    const taskMode = payload.task_mode || "content";
    const needsImageGeneration = !!(payload.needs_image_generation || taskMode === "image");
    const outputRootDisplay = outputRoot || "(not set - check task spec)";
    const buildArtificerPrompt = async (extraSections = []) => buildPromptAsync(packet, [
      loadNudges(job.id, { attemptId: ctx.attemptId }),
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("TASK", job.title),
      "",
      `OUTPUT ROOT: ${outputRootDisplay}`,
      Array.isArray(payload.files_to_create) && payload.files_to_create.length > 0
        ? `EXPECTED FILES: ${payload.files_to_create.join(", ")}`
        : null,
      inputRoots.length > 0 ? `INPUT ROOTS (read-only): ${inputRoots.join(", ")}` : null,
      "",
      promptLiteral("INSTRUCTIONS", payload.task_spec || job.title),
      "",
      ...extraSections,
    ].filter(Boolean).join("\n"));

    const prompt = await buildArtificerPrompt();
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: ctx.attemptId,
      artifact_type: "prompt",
      content_long: promptPersistenceSummary({ prompt, packet, role: this.getRole(), provider: ctx.providerName }),
    });

    const rawExpandSteps = getIntSetting(SETTING_KEYS.CONTEXT_EXPAND_MAX_STEPS, 2);
    const maxExpandSteps = Number.isFinite(rawExpandSteps) ? Math.max(0, Math.min(3, rawExpandSteps)) : 2;
    const rawExpandFileBudget = getIntSetting(SETTING_KEYS.CONTEXT_EXPAND_FILE_BUDGET_PER_ATTEMPT, 8);
    const artRoots = createRoots.length > 0
      ? (outputRoot && !createRoots.includes(outputRoot) ? [outputRoot, ...createRoots] : createRoots)
      : (outputRoot ? [outputRoot] : null);

    Object.assign(ctx, {
      artCwd,
      artRoots,
      buildArtificerPrompt,
      expandedFiles: new Set(),
      fallbackReads: packet.budgets?.fallback_reads_remaining ?? null,
      maxExpandSteps,
      inputRoots,
      needsImageGeneration,
      outputRoot,
      packet,
      payload,
      prompt,
      projectDir,
      remainingExpandFileBudget: Number.isFinite(rawExpandFileBudget) ? Math.max(0, rawExpandFileBudget) : 8,
      taskMode,
      workItem,
    });

    return prompt;
  }

  buildOpts(job, ctx) {
    const { shortJobTitle } = this.roleDeps();
    const maxTurns = maxTurnsOverrideFromPayload(ctx.payload);
    return {
      role: this.getRole(),
      allowWrite: true,
      scopedFiles: null,
      createFiles: null,
      createRoots: ctx.artRoots,
      readRoots: ctx.inputRoots?.length > 0 ? ctx.inputRoots : null,
      stableContext: ctx.packet?.stable_context || null,
      remoteSystemPrompt: ctx.packet?.remote_system_prompt || null,
      skillsAttached: ctx.packet?.skills_attached || null,
      sessionPacket: ctx.packet || null,
      sessionInstructions: ctx.packet?.prompt || null,
      autoApprove: !ctx.artRoots,
      modelTier: ctx.tier,
      reasoningEffort: job.reasoning_effort || "medium",
      activity: `producing job #${job.id}: ${shortJobTitle(job).slice(0, 40)}`,
      fallbackReads: ctx.fallbackReads,
      taskMode: ctx.taskMode,
      needsImageGeneration: ctx.needsImageGeneration,
      disableAtlas: true,
      allowedProviders: job._allowedProviders || null,
      deepthink: !!ctx.payload?.deepthink,
      skipRolePrompt: !!ctx.packet?.remote_prompt_composed,
      ...(maxTurns ? { maxTurns } : {}),
    };
  }

  buildMeta(job, ctx) {
    const { currentExecutionProvider } = this.roleDeps();
    return {
      job_id: job.id,
      work_item_id: job.work_item_id,
      jobDir: job._jobDir,
      cwd: ctx.artCwd,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
      complexity: job.planner_complexity_score,
    };
  }

  async processOutput(output, _stats, job, ctx) {
    const worker = this.context;
    const {
      currentExecutionProvider,
      hasStructuredArtificerLog,
      logBadInputFailure,
      looksLikePermissionRequest,
      selectFallbackProvider,
      shortJobTitle,
    } = this.roleDeps();
    let prompt = ctx.prompt;
    let remainingExpandFileBudget = ctx.remainingExpandFileBudget;

    if (looksLikePermissionRequest(output)) {
      emit(worker, job.id, `${C.yellow}[artificer]${C.reset} WI#${job.work_item_id} job #${job.id}: permission-style response detected - retrying with explicit write instruction`);
      const permissionRetryPrompt = await ctx.buildArtificerPrompt([
        "Write permission is already granted inside output_root and create_roots for this task.",
        "Do NOT ask for approval or permission.",
        "Use the available file-writing tools and create the deliverable files now.",
        "",
      ]);
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "prompt",
        content_long: promptPersistenceSummary({ prompt: permissionRetryPrompt, packet: ctx.packet, role: this.getRole(), provider: ctx.providerName }),
      });
      const retry = await this.providerClient.call(permissionRetryPrompt, {
        ...this.buildOpts(job, ctx),
        activity: `producing job #${job.id} (permission retry): ${shortJobTitle(job).slice(0, 30)}`,
      }, this.buildMeta(job, ctx));
      output = retry.output;
      prompt = permissionRetryPrompt;
    }

    for (let expandStep = 0; expandStep < ctx.maxExpandSteps; expandStep++) {
      const neededFiles = parseMissingContext(output, { maxFiles: Math.max(1, remainingExpandFileBudget || 1) });
      if (!neededFiles || neededFiles.length === 0) break;
      if (remainingExpandFileBudget <= 0) {
        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: ctx.attemptId,
          artifact_type: "log",
          content_long: `context_expand_budget_exhausted: requested=${neededFiles.join(", ")}`,
        });
        break;
      }

      const filesForStep = neededFiles
        .filter((filePath) => !ctx.expandedFiles.has(filePath))
        .slice(0, remainingExpandFileBudget);
      if (filesForStep.length === 0) break;
      filesForStep.forEach((filePath) => ctx.expandedFiles.add(filePath));
      remainingExpandFileBudget -= filesForStep.length;
      emit(
        worker,
        job.id,
        `${C.yellow}[context-expand]${C.reset} WI#${job.work_item_id}: artificer expansion ${expandStep + 1}/${ctx.maxExpandSteps} (+${filesForStep.length} file(s), budget left ${remainingExpandFileBudget})`,
      );
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "log",
        content_long: `context_expand_step:${expandStep + 1}:${filesForStep.join(", ")}`,
      });

      ctx.packet.related_files = [...new Set([...(ctx.packet.related_files || []), ...filesForStep])];
      await handoff(ctx.packet);
      const expandedPrompt = await ctx.buildArtificerPrompt([
        "ADDITIONAL CONTEXT (requested by previous attempt):",
        packetToDynamicContextString(ctx.packet),
        "",
        "You now have additional context. Continue and produce the deliverables.",
        "",
      ]);
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "prompt",
        content_long: promptPersistenceSummary({ prompt: expandedPrompt, packet: ctx.packet, role: this.getRole(), provider: ctx.providerName }),
      });

      const retry = await this.providerClient.call(expandedPrompt, {
        ...this.buildOpts(job, ctx),
        activity: `producing job #${job.id} (context retry ${expandStep + 1}): ${shortJobTitle(job).slice(0, 24)}`,
      }, this.buildMeta(job, ctx));
      output = retry.output;
      prompt = expandedPrompt;
      if (remainingExpandFileBudget <= 0) {
        const stillMissing = parseMissingContext(output, { maxFiles: 1 });
        if (stillMissing && stillMissing.length > 0) {
          storeArtifact({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: ctx.attemptId,
            artifact_type: "log",
            content_long: `context_expand_budget_exhausted: requested=${stillMissing.join(", ")}`,
          });
        }
        break;
      }
    }

    if (!hasStructuredArtificerLog(output)) {
      logBadInputFailure(job, {
        layer: "artificer",
        upstream: "artificer_output",
        classification: "missing_structured_log",
        detail: `${job.provider || getProviderName("artificer")} returned artifact output without an ARTIFICER RESULT wrapper`,
        snippet: output,
      });
      const fallbackPool = Array.isArray(job._allowedProviders) && job._allowedProviders.length > 0
        ? [...new Set(job._allowedProviders.filter(Boolean))]
        : getAvailableProviders("artificer");
      const activeProvider = currentExecutionProvider(job) || getProviderName("artificer");
      const fallbackName = selectFallbackProvider(fallbackPool, activeProvider, ctx.needsImageGeneration);
      if (fallbackName && fallbackName !== activeProvider) {
        emit(worker, job.id, `${C.yellow}[fallback] ${job.provider || getProviderName("artificer")} returned malformed artifact output - trying ${fallbackName}${C.reset}`);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: ctx.attemptId,
          observation_type: "provider.fallback",
          summary: `${activeProvider} -> ${fallbackName}`,
          detail: { role: "artificer", from: activeProvider, to: fallbackName, provider_pool: fallbackPool, reason: "malformed_artifact_output" },
        });
        const fallback = await this.providerClient.call(prompt, {
          ...this.buildOpts(job, ctx),
          activity: `producing job #${job.id} (fallback): ${shortJobTitle(job).slice(0, 32)}`,
          allowedProviders: fallbackPool,
        }, {
          ...this.buildMeta(job, ctx),
          jobProvider: fallbackName,
          jobModelName: null,
        });

        if (hasStructuredArtificerLog(fallback.output)) {
          output = fallback.output;
          const fallbackModel = fallback.stats?.modelName || null;
          if (typeof job.setProvider === "function") {
            await job.setProvider(fallbackName, fallbackModel);
          } else {
            const mutableRow = job.row || job;
            mutableRow.provider = fallbackName;
            mutableRow.model_name = fallbackModel;
          }
          (job.row || job)._executionProvider = fallbackName;
          emit(worker, job.id, `${C.green}[fallback] ${fallbackName} produced structured artifact output${C.reset}`);
        }
      }
    }

    const logMatch = output.match(/---\s*ARTIFICER (RESULT|LOG) START\s*---\s*([\s\S]*?)---\s*ARTIFICER \1 END\s*---/i);
    if (logMatch) {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "log",
        content_long: logMatch[2].trim(),
      });
    }

    return output;
  }
}
