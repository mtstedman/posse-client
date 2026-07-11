// lib/domains/worker/classes/roles/assessor.js - Verdict engine
//
// Evaluates job outputs against success criteria.
// Returns structured verdicts and spawns follow-up jobs.

import {
  getWorkItem,
  getAttempts,
} from "../../../queue/functions/index.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { buildRoutingPacket, composePromptRemoteAware, handoff, renderAtlasHandoffSections } from "../../../handoff/functions/index.js";
import {
  buildIntakeHintsBlock,
  getWorkItemIntakeHints,
} from "../../../intake/functions/hints.js";
import { getAssessmentInternalRetryLimit } from "../../functions/helpers/assessment-shared.js";
import { assessResult } from "../../functions/helpers/assessment-pipeline.js";
import { isArtifactMode } from "../../../artifacts/functions/index.js";
import { BaseRole } from "../BaseRole.js";
import { currentExecutionProvider as currentExecutionProviderFromDiagnostics } from "../../functions/helpers/diagnostics.js";
import { shortJobTitle as shortJobTitleFromModule } from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { processVerdict } from "../../functions/helpers/process-verdict.js";

export {
  assessResult,
  __testBuildRegisteredTestRunEvidence,
  __testBuildAssessmentProviderScope,
  __testBuildCommittedScopeViolationVerdict,
  __testFindOutOfScopeCommittedFiles,
  __testLooksLikeAssessorAccessLimitation,
  __testRerunFailedRegisteredTestsForAssessment,
  _normalizeAssessorVerdictShape,
} from "../../functions/helpers/assessment-pipeline.js";
export {
  __testNextAssessmentRetryTier,
  __testQueueInternalAssessmentRetry,
  _extractScopedPathsFromInstructions,
} from "../../functions/helpers/verdict-shared.js";

export function __testGetAssessmentInternalRetryLimit() {
  return getAssessmentInternalRetryLimit();
}

export { processVerdict };

const DEFAULT_DEPS = {
  currentExecutionProvider: currentExecutionProviderFromDiagnostics,
  loadNudges: () => "",
  shortJobTitle: shortJobTitleFromModule,
};

/**
 * Direct assessor jobs run through the role template. The larger post-execution
 * assessment path still enters through assessResult/processVerdict below.
 */
export class AssessorRole extends BaseRole {
  static role = "assessor";
  static spawnsOnSuccess = spawnSuccessForRole("assessor");
  static spawnsOnFailure = spawnFailureForRole("assessor");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const { loadNudges } = this.roleDeps();
    const workItem = getWorkItem(job.work_item_id);
    const payload = worker.parsePayload(job);
    const taskMode = payload.assessmentContext?.task_mode
      || payload.assessment_context?.task_mode
      || payload.task_mode
      || "code";
    const disableAtlas = job.job_type === "artificer" || isArtifactMode(taskMode);
    const intakeHints = getWorkItemIntakeHints(workItem, workItem?.mode || "build");
    const intakeHintsBlock = buildIntakeHintsBlock(intakeHints);
    const packet = buildRoutingPacket(job, {
      workItem,
      payload,
      role: this.getRole(),
      effectiveTier: ctx.tier,
      attemptCount: getAttempts(job.id).length + 1,
      maxAttempts: job.max_attempts || 3,
      lastError: job.last_error || null,
      cwd: job._worktreePath || worker.projectDir,
      disableAtlas,
      disableAtlasReason: disableAtlas ? "artifact route" : null,
    });
    await handoff(packet);

    const atlasBlock = renderAtlasHandoffSections(packet);
    Object.assign(ctx, {
      packet,
      payload,
      taskMode,
      disableAtlas,
      workerCwd: job._worktreePath || worker.projectDir,
    });

    return [
      atlasBlock ? `${atlasBlock}\n` : "",
      intakeHintsBlock ? `${intakeHintsBlock}\n` : "",
      loadNudges(job.id, { attemptId: ctx.attemptId }),
      promptLiteral("ASSESSMENT REQUEST", payload.task_spec || payload.instructions || job.title),
    ].filter((part) => part !== "").join("\n");
  }

  buildContract() {
    // No local prompt text: the assessor role prompt (prompts/roles/assessor.md)
    // is the relay-compiled system prompt and already states the mission
    // ("quality control ... you verify the work actually did what was asked").
    // The ASSESSMENT REQUEST context is supplied by buildContext (all prompts
    // remote-owned; artificer pattern).
    return "";
  }

  async composePrompt({ contextText, contract, ctx } = {}) {
    const remoteInstructions = [contract, contextText]
      .filter((part) => part != null && String(part) !== "")
      .join("\n\n");
    if (!remoteInstructions) {
      throw new Error(`${this.constructor.name} produced empty prompt`);
    }
    return await composePromptRemoteAware(ctx.packet, remoteInstructions);
  }

  buildOpts(job, ctx) {
    const { shortJobTitle } = this.roleDeps();
    return {
      role: this.getRole(),
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: job.reasoning_effort || "medium",
      activity: `assessing: ${shortJobTitle(job).slice(0, 40)}`,
      stableContext: ctx.packet?.stable_context || null,
      remoteSystemPrompt: ctx.packet?.remote_system_prompt || null,
      fallbackReads: ctx.packet.budgets?.fallback_reads_remaining ?? null,
      taskMode: ctx.taskMode,
      projectDbCapability: ctx.taskMode === "db" ? "read" : "none",
      disableAtlas: !!ctx.disableAtlas,
      sessionPacket: ctx.packet || null,
      skipRolePrompt: !!ctx.packet?.remote_prompt_composed,
    };
  }

  buildMeta(job, ctx) {
    const { currentExecutionProvider } = this.roleDeps();
    return {
      job_id: job.id,
      work_item_id: job.work_item_id,
      cwd: ctx.workerCwd,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
    };
  }

  async processOutput(output) {
    return output;
  }

  async assessResult(job, output, opts = {}) {
    const trackedCall = opts.trackedCall || this.providerClient.call.bind(this.providerClient);
    return await assessResult(job, output, { ...opts, trackedCall });
  }

  processVerdict(job, verdict, opts = {}) {
    return processVerdict(job, verdict, opts);
  }
}
