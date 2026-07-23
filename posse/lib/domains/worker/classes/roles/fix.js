// lib/domains/worker/classes/roles/fix.js
//
// Recovery-oriented developer role used for assessor follow-up jobs. It runs
// through BaseRole's hook pipeline while reusing the dev provider lane.

import fs from "fs";
import { C } from "../../../../shared/format/functions/colors.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { isGeneratedArtifactDirectoryPath, isGeneratedArtifactPath } from "../../../../shared/scope/classes/MutationPolicy.js";
import { getArtifacts, getAttempts, getWorkItem, storeArtifact, updateJobPayload } from "../../../queue/functions/index.js";
import {
  applyDeterministicDeletes,
  buildPromptAsync,
  buildRoutingPacket,
  handoff,
} from "../../../handoff/functions/index.js";
import { resolvePathWithin } from "../../../../shared/scope/functions/path.js";
import { BaseRole } from "../BaseRole.js";
import { currentExecutionProvider as defaultCurrentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import {
  extractCheckpointFromOutput as defaultExtractCheckpointFromOutput,
  inferGeneratedArtifactDeletionTargets as defaultInferGeneratedArtifactDeletionTargets,
  loadCheckpoint as defaultLoadCheckpoint,
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

const DEFAULT_DEPS = {
  checkpointTokenThreshold: CHECKPOINT_TOKEN_THRESHOLD,
  currentExecutionProvider: defaultCurrentExecutionProvider,
  extractCheckpointFromOutput: defaultExtractCheckpointFromOutput,
  inferGeneratedArtifactDeletionTargets: defaultInferGeneratedArtifactDeletionTargets,
  loadCheckpoint: defaultLoadCheckpoint,
  loadNudges: () => "",
  scopedDeleteTargets: defaultScopedDeleteTargets,
  shortJobTitle: defaultShortJobTitle,
  uniqueScopeFiles: defaultUniqueScopeFiles,
};

function existingFileWithin(cwd, relPath) {
  const resolved = resolvePathWithin(cwd, String(relPath || ""), { allowEqual: false });
  if (!resolved) return false;
  try {
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function plausibleDeleteFileTarget(relPath) {
  const normalized = String(relPath || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || /\s/.test(normalized)) return false;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (/^(git|npm|node|python|php|bash|sh)$/i.test(parts[0])) return false;
  const base = parts.at(-1) || "";
  return /\.[A-Za-z0-9_-]{1,12}$/.test(base);
}

function normalizeExistingCreateScope(payload, cwd, uniqueScopeFiles) {
  const createFiles = Array.isArray(payload.files_to_create) ? payload.files_to_create : [];
  if (createFiles.length === 0) return false;
  const existingCreate = [];
  for (const filePath of createFiles) {
    if (existingFileWithin(cwd, filePath)) existingCreate.push(filePath);
  }
  if (existingCreate.length === 0) return false;
  // A file created earlier on this WI branch is editable during repair, but it
  // remains a creation relative to the target branch. Keep both declarations:
  // modify authorizes the existing worktree path, while create lets assessment
  // validate the final diff against main correctly.
  payload.files_to_create = uniqueScopeFiles(createFiles);
  payload.files_to_modify = uniqueScopeFiles(payload.files_to_modify || [], existingCreate);
  return true;
}

function looksLikeGeneratedArtifactCleanup(job, payload, deleteFiles) {
  const targets = (Array.isArray(deleteFiles) ? deleteFiles : []).filter(Boolean);
  if (targets.length === 0 || !targets.every((target) => isGeneratedArtifactPath(target) && !isGeneratedArtifactDirectoryPath(target))) return false;
  const text = [
    job?.title || "",
    payload?.fix_instructions || "",
    payload?.instructions || "",
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
  ].join("\n").toLowerCase();
  if (!/\b(__pycache__|pyc|pyo|bytecode|out-of-scope|artifact|cache)\b/.test(text)) return false;
  return /\b(delete|remove|drop|clean up|cleanup|prune|keep source files unchanged|retry)\b/.test(text);
}

function looksLikeOutOfScopeFileCleanup(job, payload, deleteFiles) {
  const targets = (Array.isArray(deleteFiles) ? deleteFiles : []).filter(Boolean);
  if (targets.length === 0) return false;
  const text = [
    job?.title || "",
    payload?.fix_instructions || "",
    payload?.instructions || "",
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
  ].join("\n").toLowerCase();

  const scopeViolation = /\b(out[- ]of[- ]scope|scope contract|scope violation|not allowed|new files were not allowed)\b/.test(text);
  if (!scopeViolation) return false;

  const requiresFileAbsence = /\b(final commit contains no|contains no new|no new .*file|true deletion|git rm|remove .* from (?:the )?commit|delete .* from (?:the )?commit|fully deleted|file still exists)\b/.test(text);
  if (!requiresFileAbsence) return false;

  const restorationOnly = /\b(modification|modified out of scope|changes made to|restore|rollback|revert)\b/.test(text)
    && !/\b(true deletion|git rm|final commit contains no|contains no new|no new .*file|fully deleted|file still exists)\b/.test(text);
  return !restorationOnly;
}

export class FixRole extends BaseRole {
  static role = "dev";
  static spawnsOnSuccess = spawnSuccessForRole("fix");
  static spawnsOnFailure = spawnFailureForRole("fix");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const {
      loadCheckpoint,
      loadNudges,
      inferGeneratedArtifactDeletionTargets,
      scopedDeleteTargets,
      uniqueScopeFiles,
    } = this.roleDeps();

    const workItem = getWorkItem(job.work_item_id);
    const payload = worker.parsePayload(job);
    const fixCwd = job._worktreePath || worker.projectDir;
    let payloadDirty = false;
    const generatedArtifactDeletes = inferGeneratedArtifactDeletionTargets(job, payload);
    if (generatedArtifactDeletes.length > 0) {
      payload.files_to_delete = uniqueScopeFiles(payload.files_to_delete || [], generatedArtifactDeletes);
      payloadDirty = true;
    }
    if (Array.isArray(payload.files_to_delete) && payload.files_to_delete.some(isGeneratedArtifactDirectoryPath)) {
      payload.files_to_delete = uniqueScopeFiles(payload.files_to_delete.filter((filePath) => !isGeneratedArtifactDirectoryPath(filePath)));
      payloadDirty = true;
    }
    payloadDirty = normalizeExistingCreateScope(payload, fixCwd, uniqueScopeFiles) || payloadDirty;
    let fixDeleteFiles = scopedDeleteTargets(job, payload);
    const generatedArtifactCleanup = looksLikeGeneratedArtifactCleanup(job, payload, fixDeleteFiles);
    const outOfScopeFileCleanup = looksLikeOutOfScopeFileCleanup(job, payload, fixDeleteFiles);
    const outOfScopeDeleteFiles = outOfScopeFileCleanup
      ? fixDeleteFiles.filter(plausibleDeleteFileTarget)
      : [];
    if (outOfScopeFileCleanup && outOfScopeDeleteFiles.length > 0) {
      payload.files_to_delete = uniqueScopeFiles(payload.files_to_delete || [], outOfScopeDeleteFiles);
      fixDeleteFiles = uniqueScopeFiles(payload.files_to_delete);
      payloadDirty = true;
    }
    const deterministicDeleteCleanup = generatedArtifactCleanup || (outOfScopeFileCleanup && outOfScopeDeleteFiles.length > 0);
    if (deterministicDeleteCleanup) {
      payload.files_to_modify = [];
      payload.files_to_create = [];
      payload.create_roots = [];
      payloadDirty = true;
    }
    if (payloadDirty) {
      const payloadJson = JSON.stringify(payload);
      updateJobPayload(job.id, payloadJson);
      if (job?.row) job.row.payload_json = payloadJson;
    }
    let fixFiles = deterministicDeleteCleanup ? [] : uniqueScopeFiles(payload.files_to_modify || []);
    let fixCreateFiles = deterministicDeleteCleanup ? [] : (payload.files_to_create || []);
    let fixCreateRoots = deterministicDeleteCleanup ? [] : (payload.create_roots || []);

    let originalOutput = "";
    if (payload.original_job_id) {
      const originalArtifacts = getArtifacts(payload.original_job_id, "response");
      if (originalArtifacts.length > 0) {
        originalOutput = originalArtifacts[originalArtifacts.length - 1].content_long || "";
      }
    }

    const fixAttempts = getAttempts(job.id);
    const previousFixAttempts = fixAttempts.filter((attempt) => attempt.status !== "running");
    const currentFixAttemptNumber = previousFixAttempts.length + 1;
    const lastError = previousFixAttempts.length > 0
      ? (job.last_error || previousFixAttempts[previousFixAttempts.length - 1].error_text || null)
      : null;

    const packet = buildRoutingPacket(job, {
      workItem,
      payload,
      role: this.getRole(),
      effectiveTier: ctx.tier,
      attemptCount: currentFixAttemptNumber,
      maxAttempts: job.max_attempts || 3,
      lastError,
      cwd: fixCwd,
      atlasConfig: job._atlasConfig || null,
      disableAtlas: !!job._atlasDisabledForWorkItem,
    });

    await handoff(packet);
    if (Array.isArray(packet.fix_scope_guard_added) && packet.fix_scope_guard_added.length > 0) {
      worker.emit(job.id, `${C.cyan}[handoff]${C.reset} WI#${job.work_item_id} job #${job.id}: added ${packet.fix_scope_guard_added.length} fix target(s) to writable scope`);
    }
    let handoffScopeChanged = Array.isArray(packet.fix_scope_guard_added) && packet.fix_scope_guard_added.length > 0;
    for (const key of ["files_to_modify", "files_to_create", "files_to_delete", "create_roots"]) {
      const next = uniqueScopeFiles(packet[key] || []);
      if (JSON.stringify(payload[key] || []) !== JSON.stringify(next)) {
        payload[key] = next;
        handoffScopeChanged = true;
      }
    }
    if (handoffScopeChanged) {
      const payloadJson = JSON.stringify(payload);
      updateJobPayload(job.id, payloadJson);
      if (job?.row) job.row.payload_json = payloadJson;
      else job.payload_json = payloadJson;
    }
    fixFiles = deterministicDeleteCleanup ? [] : uniqueScopeFiles(packet.files_to_modify || []);
    fixCreateFiles = deterministicDeleteCleanup ? [] : (packet.files_to_create || []);
    fixCreateRoots = deterministicDeleteCleanup ? [] : (packet.create_roots || []);
    const fixHasScope = fixFiles.length > 0 || fixCreateFiles.length > 0 || fixDeleteFiles.length > 0 || fixCreateRoots.length > 0;
    if (!fixHasScope) {
      throw new Error(
        "Fix job has no writable scope (files_to_modify/files_to_create/files_to_delete/create_roots); reject to prevent unsafely broad edits."
      );
    }
    const fixDeleteOutcome = applyDeterministicDeletes(packet);
    if (fixDeleteOutcome.deleted.length > 0) {
      worker.emit(job.id, `${C.cyan}[handoff]${C.reset} WI#${job.work_item_id} job #${job.id}: deleted ${fixDeleteOutcome.deleted.length} file(s) before agent handoff`);
    }
    if (fixDeleteOutcome.failed.length > 0) {
      throw new Error(`Deterministic delete failed: ${fixDeleteOutcome.failed.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`);
    }

    let fixContinuation = "";
    const isFixRetry = previousFixAttempts.length > 0;
    if (payload._stall_resume && job._worktreePath) {
      const resumed = await worker.applyStallStashAsync(job, job._worktreePath);
      if (resumed) {
        fixContinuation = resumed;
        worker.emit(job.id, `${C.green}[resume]${C.reset} WI#${job.work_item_id} job #${job.id}: continuing from previous attempt`);
      } else {
        worker.emit(job.id, `${C.yellow}[restart]${C.reset} WI#${job.work_item_id} job #${job.id}: stash not found - starting over`);
      }
    } else if (isFixRetry) {
      const checkpoint = loadCheckpoint(job.id, getArtifacts);
      if (checkpoint) {
        fixContinuation = `CHECKPOINT FROM PREVIOUS ATTEMPT (use this to avoid repeating work):\n${checkpoint}`;
        worker.emit(job.id, `${C.green}[checkpoint]${C.reset} WI#${job.work_item_id} job #${job.id}: loaded checkpoint from previous attempt`);
      }
      worker.emit(job.id, `${C.yellow}[restart]${C.reset} WI#${job.work_item_id} job #${job.id}: attempt ${currentFixAttemptNumber} - starting over`);
    } else {
      worker.emit(job.id, `${C.green}[new]${C.reset} WI#${job.work_item_id} job #${job.id}: first attempt`);
    }

    const fixDriftContext = worker.detectDrift(job, fixFiles, fixCwd);
    const fixNudgeContext = loadNudges(job.id, { attemptId: ctx.attemptId });
    const fixText = [
      payload.task_spec || "",
      payload.fix_instructions || "",
      ...(Array.isArray(payload.assessor_feedback) ? payload.assessor_feedback : []),
    ].join("\n").toLowerCase();
    const hasScopedPng = [...fixFiles, ...fixCreateFiles].some((file) => String(file || "").toLowerCase().endsWith(".png"));
    const shouldHintResizeTool = hasScopedPng && /\b(resize|aspect ratio|dimensions?|crop|scale)\b/.test(fixText);

    const fixFallbackReads = packet.budgets?.fallback_reads_remaining ?? null;
    const fixTaskMode = payload.task_mode || "code";
    const fixNeedsImageGen = !!payload.needs_image_generation;
    const primedFixCreateFiles = worker.primeCreatableFiles(fixCwd, fixCreateFiles);
    const fixEditableScope = uniqueScopeFiles(fixFiles, fixCreateFiles);
    const fixDeleteOnlyTask = fixEditableScope.length === 0 && fixCreateFiles.length === 0 && fixCreateRoots.length === 0 && fixDeleteFiles.length > 0;
    if (primedFixCreateFiles.length > 0) {
      worker.emit(job.id, `${C.cyan}[scope]${C.reset} WI#${job.work_item_id} job #${job.id}: pre-created ${primedFixCreateFiles.length} scoped file(s) to avoid creation prompts`);
    }

    Object.assign(ctx, {
      fixCwd,
      fixCreateFiles,
      fixCreateRoots,
      fixDeleteFiles,
      fixDeleteOnlyTask,
      fixDeleteOutcome,
      fixEditableScope,
      fixFallbackReads,
      fixFiles,
      fixHasScope,
      fixNeedsImageGen,
      fixTaskMode,
      packet,
      payload,
      promptArtifact: { stored: false },
      promptState: {},
      workItem,
    });

    if (fixDeleteOnlyTask) {
      const summary = `Deterministic delete handoff completed. Deleted ${fixDeleteOutcome.deleted.length} file(s); ${fixDeleteOutcome.alreadyAbsent.length} already absent.`;
      ctx.providerResult = {
        output: [
          "--- DEV RESULT START ---",
          "status: COMPLETE",
          `summary: ${summary}`,
          "--- DEV RESULT END ---",
        ].join("\n"),
        stats: {},
      };
      worker.emit(job.id, `${C.cyan}[handoff]${C.reset} WI#${job.work_item_id} job #${job.id}: delete-only fix satisfied without agent call`);
    }

    return [
      fixContinuation ? fixContinuation + "\n" : null,
      fixDriftContext ? fixDriftContext + "\n" : null,
      fixNudgeContext || null,
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("TASK", job.title),
      "",
      promptLiteral("FIX INSTRUCTIONS", payload.task_spec || payload.fix_instructions || payload.instructions || job.title),
      shouldHintResizeTool
        ? "\nTOOL HINT:\nUse `clean_image` with mode=resize for PNG aspect-ratio or dimension fixes when the existing asset just needs resizing. Prefer resizing the current file over regenerating it."
        : null,
      originalOutput ? `\nPREVIOUS DEV OUTPUT (read-only context):\n${originalOutput.slice(0, 2000)}` : null,
    ].filter((value) => value !== null).join("\n");
  }

  buildContract() {
    // No local prompt text. Fix compiles as role "dev", so the dev role prompt
    // (dev.md) + DEV RESULT contract (dev-log.md) are the relay-compiled system
    // prompt (VERIFIED_NO_CHANGE, compact result semantics incl.
    // VERIFICATION_UNAVAILABLE). The fix-retry framing is already carried by the
    // injected FIX INSTRUCTIONS + assessor feedback + PREVIOUS DEV OUTPUT
    // context in this role's run(). All prompts remote-owned (artificer pattern).
    return "";
  }

  async composePrompt({ contextText, contract, job, ctx } = {}) {
    const instructions = [contextText, "", contract]
      .filter((part) => part != null && String(part) !== "")
      .join("\n");
    if (ctx.promptState) ctx.promptState.taskInstructions = instructions;
    const prompt = await buildPromptAsync(ctx.packet, instructions, {
      providerName: ctx.providerName,
    });
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
      allowWrite: true,
      scopedFiles: ctx.fixEditableScope.length > 0 ? ctx.fixEditableScope : null,
      createFiles: ctx.fixCreateFiles.length > 0 ? ctx.fixCreateFiles : null,
      createRoots: ctx.fixCreateRoots.length > 0 ? ctx.fixCreateRoots : null,
      deleteFiles: ctx.fixDeleteFiles.length > 0 ? ctx.fixDeleteFiles : null,
      stableContext: ctx.packet.stable_context || null,
      remoteSystemPrompt: ctx.packet.remote_system_prompt || null,
      skillsAttached: ctx.packet.skills_attached || null,
      sessionPacket: ctx.packet,
      sessionInstructions: ctx.promptState?.taskInstructions || null,
      // The fixHasScope guard in assembleContext throws when scope is empty,
      // so this code path always runs with scope present. Hard-code false so
      // an inverted/relaxed guard cannot silently enable
      // --dangerously-skip-permissions for a no-scope fix session.
      autoApprove: false,
      modelTier: ctx.tier,
      reasoningEffort: job.reasoning_effort || "medium",
      activity: `fixing job #${job.id}: ${shortJobTitle(job).slice(0, 40)}`,
      fallbackReads: ctx.fixFallbackReads,
      taskMode: ctx.fixTaskMode,
      needsImageGeneration: ctx.fixNeedsImageGen,
      filesToModifyCount: ctx.fixFiles.length,
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
      cwd: ctx.fixCwd,
      atlasConfig: job._atlasConfig || null,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
      complexity: job.planner_complexity_score,
    };
  }

  async processOutput(output, fixStats = {}, job, ctx) {
    const worker = this.context;
    const {
      checkpointTokenThreshold,
      extractCheckpointFromOutput,
    } = this.roleDeps();

    if (fixStats?.outputTokens >= checkpointTokenThreshold) {
      const checkpoint = extractCheckpointFromOutput(output);
      if (checkpoint) {
        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: ctx.attemptId,
          artifact_type: "log",
          content_long: `checkpoint:${checkpoint}`,
        });
        worker.emit(job.id, `${C.dim}[checkpoint] WI#${job.work_item_id} job #${job.id}: captured (${fixStats.outputTokens} output tokens)${C.reset}`);
      }
    }

    return output;
  }
}
