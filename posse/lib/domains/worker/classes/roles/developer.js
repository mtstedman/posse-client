// lib/domains/worker/classes/roles/developer.js
//
// Developer role handler for scoped repo mutations, checkpoint capture, and
// one-shot context expansion during implementation work.

import { C } from "../../../../shared/format/functions/colors.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getArtifacts, getAttempts, getIntSetting, getSetting, getWorkItem, storeArtifact } from "../../../queue/functions/index.js";
import {
  applyDeterministicDeletes,
  buildPromptAsync,
  buildRoutingPacket,
  handoff,
  packetToDynamicContextString,
  parseMissingContext,
} from "../../../handoff/functions/index.js";
import { BaseRole } from "../BaseRole.js";
import { currentExecutionProvider as defaultCurrentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import {
  extractCheckpointFromOutput as defaultExtractCheckpointFromOutput,
  loadCheckpoint as defaultLoadCheckpoint,
  parseAgentCompletionLog as defaultParseAgentCompletionLog,
  scopedDeleteTargets as defaultScopedDeleteTargets,
} from "../../functions/helpers/mutation-guards.js";
import {
  CHECKPOINT_TOKEN_THRESHOLD,
  maxTurnsOverrideFromPayload,
  shortJobTitle as defaultShortJobTitle,
  uniqueScopeFiles as defaultUniqueScopeFiles,
} from "../../../../shared/policies/functions/role-utils.js";
import { promptPersistenceSummary } from "../../../../shared/telemetry/functions/logging/prompt-persistence.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { projectDbEffectivePermissions } from "../../../../shared/tools/functions/toolkit/project-db/config.js";

const DEFAULT_DEPS = {
  checkpointTokenThreshold: CHECKPOINT_TOKEN_THRESHOLD,
  currentExecutionProvider: defaultCurrentExecutionProvider,
  extractCheckpointFromOutput: defaultExtractCheckpointFromOutput,
  loadCheckpoint: defaultLoadCheckpoint,
  loadNudges: () => "",
  parseAgentCompletionLog: defaultParseAgentCompletionLog,
  scopedDeleteTargets: defaultScopedDeleteTargets,
  shortJobTitle: defaultShortJobTitle,
  uniqueScopeFiles: defaultUniqueScopeFiles,
};

export class DeveloperRole extends BaseRole {
  static role = "dev";
  static spawnsOnSuccess = spawnSuccessForRole("dev");
  static spawnsOnFailure = spawnFailureForRole("dev");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const {
      loadCheckpoint,
      loadNudges,
      scopedDeleteTargets,
      uniqueScopeFiles,
    } = this.roleDeps();

    const workItem = getWorkItem(job.work_item_id);
    const payload = worker.parsePayload(job);
    const devCwd = job._worktreePath || worker.projectDir;
    const dbOnlyTask = (payload.task_mode || "code") === "db";
    let dbGrants = [];
    if (dbOnlyTask) {
      // DB-only means DB-only: the write surface is project_db_query under the
      // operator grant; file scope must be empty (locks/commit machinery key on
      // task_mode:"db" carrying none). Both checks run before any provider
      // spend so an impossible job fails fast with a clear reason.
      const scopeLeak = [payload.files_to_modify, payload.files_to_create, payload.files_to_delete, payload.create_roots]
        .some((list) => Array.isArray(list) && list.length > 0);
      if (scopeLeak) {
        throw new Error(
          "db-mode dev job must not carry file scope (files_to_modify/files_to_create/files_to_delete/create_roots); use task_mode:\"code\" for repo edits."
        );
      }
      dbGrants = projectDbEffectivePermissions({ projectDir: worker.projectDir, capability: "write" });
      if (!dbGrants.some((perm) => perm !== "read")) {
        throw new Error(
          "db-mode dev job requires a write-capable project DB grant (insert/write/delete/create/alter), but this repo's project_db config grants none; configure the grant or replan the task as repo work."
        );
      }
    }
    const deleteFiles = dbOnlyTask ? [] : scopedDeleteTargets(job, payload);
    let files = uniqueScopeFiles(payload.files_to_modify || []);
    let createFiles = payload.files_to_create || [];
    let createRoots = payload.create_roots || [];

    const attempts = getAttempts(job.id);
    const previousAttempts = attempts.filter((attempt) => attempt.status !== "running");
    const currentAttemptNumber = previousAttempts.length + 1;
    const lastError = previousAttempts.length > 0
      ? (job.last_error || previousAttempts[previousAttempts.length - 1].error_text || null)
      : null;

    const packet = buildRoutingPacket(job, {
      workItem,
      payload,
      role: this.getRole(),
      effectiveTier: ctx.tier,
      attemptCount: currentAttemptNumber,
      maxAttempts: job.max_attempts || 3,
      lastError,
      cwd: devCwd,
      atlasConfig: job._atlasConfig || null,
      disableAtlas: !!job._atlasDisabledForWorkItem,
    });

    await handoff(packet);
    files = dbOnlyTask ? [] : uniqueScopeFiles(packet.files_to_modify || []);
    createFiles = dbOnlyTask ? [] : (packet.files_to_create || []);
    createRoots = dbOnlyTask ? [] : (packet.create_roots || []);
    const hasScope = files.length > 0 || createFiles.length > 0 || deleteFiles.length > 0 || createRoots.length > 0;
    // db-mode jobs legitimately run with an empty file scope: their write
    // surface is the project database, and the file tools stay read-only.
    if (!hasScope && !dbOnlyTask) {
      throw new Error(
        "Developer job has no writable scope (files_to_modify/files_to_create/files_to_delete/create_roots); reject to prevent unsafely broad edits."
      );
    }
    const deleteOutcome = applyDeterministicDeletes(packet);
    if (deleteOutcome.deleted.length > 0) {
      worker.emit(job.id, `${C.cyan}[handoff]${C.reset} WI#${job.work_item_id} job #${job.id}: deleted ${deleteOutcome.deleted.length} file(s) before agent handoff`);
    }
    if (deleteOutcome.failed.length > 0) {
      throw new Error(`Deterministic delete failed: ${deleteOutcome.failed.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`);
    }

    const driftContext = worker.detectDrift(job, files, devCwd);

    let continuationContext = "";
    const isRetry = previousAttempts.length > 0;
    if (payload._stall_resume && job._worktreePath) {
      const resumed = await worker.applyStallStashAsync(job, job._worktreePath);
      if (resumed) {
        continuationContext = resumed;
        worker.emit(job.id, `${C.green}[resume]${C.reset} WI#${job.work_item_id} job #${job.id}: continuing from previous attempt`);
      } else {
        worker.emit(job.id, `${C.yellow}[restart]${C.reset} WI#${job.work_item_id} job #${job.id}: stash not found - starting over`);
      }
    } else if (isRetry) {
      const checkpoint = loadCheckpoint(job.id, getArtifacts);
      if (checkpoint) {
        continuationContext = `CHECKPOINT FROM PREVIOUS ATTEMPT (use this to avoid repeating work):\n${checkpoint}`;
        worker.emit(job.id, `${C.green}[checkpoint]${C.reset} WI#${job.work_item_id} job #${job.id}: loaded checkpoint from previous attempt`);
      }
      worker.emit(job.id, `${C.yellow}[restart]${C.reset} WI#${job.work_item_id} job #${job.id}: attempt ${currentAttemptNumber} - starting over`);
    } else {
      worker.emit(job.id, `${C.green}[new]${C.reset} WI#${job.work_item_id} job #${job.id}: first attempt`);
    }

    const nudgeContext = loadNudges(job.id, { attemptId: ctx.attemptId });
    const fallbackReads = packet.budgets?.fallback_reads_remaining ?? null;
    const taskMode = payload.task_mode || "code";
    const needsImageGeneration = !!payload.needs_image_generation;
    const primedCreateFiles = worker.primeCreatableFiles(devCwd, createFiles);
    const editableScope = uniqueScopeFiles(files, createFiles);
    const deleteOnlyTask = editableScope.length === 0 && createFiles.length === 0 && createRoots.length === 0 && deleteFiles.length > 0;
    if (primedCreateFiles.length > 0) {
      worker.emit(job.id, `${C.cyan}[scope]${C.reset} WI#${job.work_item_id} job #${job.id}: pre-created ${primedCreateFiles.length} scoped file(s) to avoid creation prompts`);
    }

    const rawExpandSteps = getIntSetting(SETTING_KEYS.CONTEXT_EXPAND_MAX_STEPS, 2);
    const maxExpandSteps = Number.isFinite(rawExpandSteps) ? Math.max(0, Math.min(3, rawExpandSteps)) : 2;
    const rawExpandFileBudget = getIntSetting(SETTING_KEYS.CONTEXT_EXPAND_FILE_BUDGET_PER_ATTEMPT, 8);

    Object.assign(ctx, {
      createFiles,
      createRoots,
      dbOnlyTask,
      deleteFiles,
      deleteOnlyTask,
      deleteOutcome,
      devCwd,
      editableScope,
      expandedFiles: new Set(),
      fallbackReads,
      files,
      hasScope,
      maxExpandSteps,
      needsImageGeneration,
      packet,
      payload,
      promptArtifact: { stored: false },
      promptState: {},
      remainingExpandFileBudget: Number.isFinite(rawExpandFileBudget) ? Math.max(0, rawExpandFileBudget) : 8,
      taskMode,
      workItem,
    });

    if (deleteOnlyTask) {
      ctx.providerResult = {
        output: `Deterministic delete handoff completed. Deleted ${deleteOutcome.deleted.length} file(s); ${deleteOutcome.alreadyAbsent.length} already absent.`,
        stats: {},
      };
      worker.emit(job.id, `${C.cyan}[handoff]${C.reset} WI#${job.work_item_id} job #${job.id}: delete-only task satisfied without agent call`);
    }

    return [
      continuationContext ? continuationContext + "\n" : null,
      driftContext ? driftContext + "\n" : null,
      nudgeContext || null,
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("TASK", job.title),
      "",
      promptLiteral("INSTRUCTIONS", payload.task_spec || job.title),
      dbOnlyTask
        ? [
          "",
          "DB-ONLY TASK MODE:",
          `- This job's entire change is in the project database, made through the project_db_query tool (granted permissions: ${dbGrants.join(", ")}).`,
          "- File tools are read-only for this job: do not attempt repo edits, file creation, or FILE_REQUESTs for this work.",
          "- Verify your changes with SELECT/inspection statements and put that evidence in the dev log criteria_check.",
          "- A COMPLETE status with zero file changes is the expected success shape for this task.",
        ].join("\n")
        : null,
    ].filter((value) => value !== null).join("\n");
  }

  buildContract() {
    // No local prompt text: the dev role prompt (prompts/roles/dev.md) and the
    // DEV LOG contract (prompts/contracts/dev-log.md) are the relay-compiled
    // system prompt. They own execute-exactly, hard file scope,
    // VERIFIED_NO_CHANGE (no decorative churn), the DEV LOG markers/fields, and
    // the criteria_check rules incl. VERIFICATION_UNAVAILABLE. All prompts
    // remote-owned (artificer pattern).
    return "";
  }

  async composePrompt({ contextText, contract, job, ctx } = {}) {
    const taskInstructions = [contextText, "", contract]
      .filter((part) => part != null && String(part) !== "")
      .join("\n");
    if (ctx.promptState) ctx.promptState.taskInstructions = taskInstructions;
    const prompt = await buildPromptAsync(ctx.packet, taskInstructions);
    if (ctx?.promptArtifact && !ctx.promptArtifact.stored && job) {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "prompt",
        content_long: promptPersistenceSummary({ prompt, packet: ctx.packet, role: this.getRole(), provider: ctx.providerName }),
      });
      ctx.promptArtifact.stored = true;
    }
    return prompt;
  }

  buildOpts(job, ctx) {
    const { shortJobTitle } = this.roleDeps();
    const maxTurns = maxTurnsOverrideFromPayload(ctx.payload);
    return {
      role: this.getRole(),
      // db-mode jobs run without file-write tools entirely; their only write
      // surface is project_db_query, granted via projectDbWrite below.
      allowWrite: !ctx.dbOnlyTask,
      projectDbWrite: !!ctx.dbOnlyTask,
      scopedFiles: ctx.editableScope.length > 0 ? ctx.editableScope : null,
      createFiles: ctx.createFiles.length > 0 ? ctx.createFiles : null,
      createRoots: ctx.createRoots.length > 0 ? ctx.createRoots : null,
      deleteFiles: ctx.deleteFiles.length > 0 ? ctx.deleteFiles : null,
      stableContext: ctx.packet.stable_context || null,
      remoteSystemPrompt: ctx.packet.remote_system_prompt || null,
      skillsAttached: ctx.packet.skills_attached || null,
      sessionPacket: ctx.packet,
      sessionInstructions: ctx.promptState?.taskInstructions || null,
      // The hasScope guard in assembleContext (line 94) throws when scope is
      // empty, so this code path always runs with scope present. Hard-code
      // false so an inverted/relaxed guard cannot silently enable
      // --dangerously-skip-permissions for a no-scope dev session.
      autoApprove: false,
      modelTier: ctx.tier,
      reasoningEffort: job.reasoning_effort || "medium",
      activity: `executing job #${job.id}: ${shortJobTitle(job).slice(0, 40)}`,
      fallbackReads: ctx.fallbackReads,
      taskMode: ctx.taskMode,
      needsImageGeneration: ctx.needsImageGeneration,
      filesToModifyCount: ctx.files.length,
      atlasPrefetchStatus: ctx.packet.atlas?.prefetchStatus || null,
      atlasConfig: job._atlasConfig || null,
      disableAtlas: !!job._atlasDisabledForWorkItem,
      deepthink: !!ctx.payload.deepthink,
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
      cwd: ctx.devCwd,
      atlasConfig: job._atlasConfig || null,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
      complexity: job.planner_complexity_score,
    };
  }

  async processOutput(output, devStats = {}, job, ctx) {
    const worker = this.context;
    const {
      checkpointTokenThreshold,
      extractCheckpointFromOutput,
      currentExecutionProvider,
      parseAgentCompletionLog,
      shortJobTitle,
    } = this.roleDeps();
    let remainingExpandFileBudget = ctx.remainingExpandFileBudget;

    if (devStats?.outputTokens >= checkpointTokenThreshold) {
      const checkpoint = extractCheckpointFromOutput(output);
      if (checkpoint) {
        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: ctx.attemptId,
          artifact_type: "log",
          content_long: `checkpoint:${checkpoint}`,
        });
        worker.emit(job.id, `${C.dim}[checkpoint] WI#${job.work_item_id} job #${job.id}: captured (${devStats.outputTokens} output tokens)${C.reset}`);
      }
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
      worker.emit(
        job.id,
        `${C.yellow}[context-expand]${C.reset} WI#${job.work_item_id}: dev expansion ${expandStep + 1}/${ctx.maxExpandSteps} (+${filesForStep.length} file(s), budget left ${remainingExpandFileBudget})`,
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
      const expandedPrompt = await buildPromptAsync(ctx.packet, ctx.promptState?.taskInstructions || "")
        + `\n\nADDITIONAL CONTEXT (requested by previous attempt):\n${packetToDynamicContextString(ctx.packet)}\n\nYou now have additional context. Continue implementation.`;

      const retry = await this.providerClient.call(expandedPrompt, {
        ...this.buildOpts(job, ctx),
        activity: `executing job #${job.id} (expanded ${expandStep + 1}): ${shortJobTitle(job).slice(0, 28)}`,
      }, {
        ...this.buildMeta(job, ctx),
        jobProvider: currentExecutionProvider(job),
      });

      output = retry.output;
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

    const completion = parseAgentCompletionLog(output);
    if (completion.found && completion.kind === "dev") {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: ctx.attemptId,
        artifact_type: "log",
        content_long: completion.body,
      });
    }

    return output;
  }
}
