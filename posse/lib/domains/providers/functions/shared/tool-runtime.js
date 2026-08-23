import fs from "fs";
import path from "path";
import { protectedMutablePathReason, relativePathFromCwd } from "../../../runtime/functions/protected-paths.js";
import { sanitizeAbsolutePathsInText, toRepoRelativePath } from "../../../../shared/format/functions/display-paths.js";
import { AsyncResourceGate } from "../../../../shared/concurrency/classes/AsyncGate.js";
import { stripPosseMcpGatewayPrefix } from "../../../integrations/functions/mcp-gateway.js";
import { ToolCatalog } from "../../../../shared/tools/classes/ToolCatalog.js";
import { ToolRegistry } from "../../../../shared/tools/classes/ToolRegistry.js";
import { declareToolSuites, LIVE_CHANNEL_TOOL_NAMES } from "../../../../shared/tools/functions/tool-suites.js";
import { OPERATOR_FEEDBACK_DELIVERY_MARKER } from "../../../../catalog/operator-feedback.js";
import { assertAdvertisedHaveExecutors } from "../../../../shared/tools/functions/tool-parity.js";
import { appendHashRefIfMajor, compactCodeSurveyResult, compactCodeWindowLensResult, compactTreeScopeResult } from "../../../../shared/tools/functions/hash-adder.js";
import { createChainLedger } from "../../../../shared/tools/functions/chain-ledger.js";
import { canonicalAtlasToolUseActionName, formatAtlasToolUseDisplayName } from "../../../../shared/tools/functions/mcp-surface.js";
import { atlasSummaryHint, getObservationContext } from "../../../observability/functions/observations.js";
import { AGENT_HANDOFF_PROTOCOL } from "../../../../catalog/handoff.js";
import {
  recordAgentHandoffRejection,
  rejectAgentHandoffForLaterTool,
  stageAgentHandoff,
} from "../../../handoff/functions/agent-handoff.js";
import {
  assertSubAgentParentReady,
  executeSubAgent,
  executeSubAgentNextInput,
  prepareSubAgentHandoff,
  sealSubAgentHandoff,
  subAgentCompletionSignal,
} from "../../../sub-agent/classes/SubAgentRuntime.js";
import { execProjectDbQuery } from "../../../../shared/tools/functions/toolkit/project-db/query.js";
import {
  acknowledgeOperatorFeedback,
  awaitJobScopeExpansionDecision,
  countPendingOperatorFeedbackForJob,
  getOperatorFeedbackForJob,
  grantApprovedScopeEntries,
  recordAgentActivity,
  requestJobScopeExpansion,
  getIntSetting,
  takeOperatorFeedbackDeliveryForToolResult,
} from "../../../queue/functions/index.js";

const PROVIDER_TOOL_GATE = new AsyncResourceGate({ name: "provider native tool" });
const LIVE_SCOPE_WAIT = Symbol("posse.live-scope-wait");

// Concurrent embedded tool calls can wait on the SAME scope request (the
// initiator plus batched joiners that received scope_approval_batched with
// the original request_id). Each independent waiter would race in
// awaitJobScopeExpansionDecision: the winner's transaction consumes the
// pending and the loser reads scope_request_stale despite the approval.
// Mirror the MCP server's shared-wait map: one waiter per (job, request),
// every caller receives the same decision.
const sharedEmbeddedScopeWaits = new Map();

function awaitSharedEmbeddedScopeDecision({ jobId, requestId, attemptId, signal }) {
  const key = `${jobId}:${requestId}`;
  const existing = sharedEmbeddedScopeWaits.get(key);
  if (existing) return existing;
  const wait = awaitJobScopeExpansionDecision({ jobId, requestId, attemptId, signal })
    .finally(() => {
      if (sharedEmbeddedScopeWaits.get(key) === wait) sharedEmbeddedScopeWaits.delete(key);
    });
  sharedEmbeddedScopeWaits.set(key, wait);
  return wait;
}
const BLOCKING_NATIVE_TOOL_NAMES = new Set([
  "Bash",
  "Edit",
  "Write",
  "bash",
  "chain_read",
  "chain_verdict",
  "clean_image",
  "copy_file",
  "edit_file",
  "generate_image",
  "make_dir",
  "move_file",
  "optimize_image",
  "prune_artifact_output",
  "reencode_image",
  "resize_image",
  "write_file",
]);
function nativeToolGateKey(cwd) {
  const normalized = path.resolve(String(cwd || process.cwd())).replace(/\\/g, "/");
  return `provider-tools:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

function isAsyncGateError(err) {
  return err?.code === "ASYNC_GATE_BUSY" || err?.code === "ASYNC_GATE_TIMEOUT";
}

const OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS = new Set([
  "get_operator_feedback",
  "ack_operator_feedback",
]);

function operatorFeedbackDeliveryForAmbient(toolName) {
  if (OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS.has(toolName)) return null;
  const ambient = getObservationContext() || {};
  if (ambient.job_id == null) return null;
  return operatorFeedbackDeliveryForJob(ambient.job_id, {
    attemptId: ambient.attempt_id,
    agentCallId: ambient.agent_call_id,
    toolName,
  });
}

/**
 * Claim a direct feedback envelope for a specific job. Shared with owner-side
 * result paths
 * (PersistentMcpOwner ATLAS results) that carry an explicit session job id
 * instead of ambient observation context.
 *
 * @param {number | string | null} jobId
 * @param {{attemptId?: number|null, agentCallId?: number|null, toolName?: string}} [options]
 * @returns {object|null}
 */
export function operatorFeedbackDeliveryForJob(jobId, {
  attemptId = null,
  agentCallId = null,
  toolName = "",
} = {}) {
  if (toolName && OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS.has(toolName)) return null;
  const normalized = Number(jobId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return takeOperatorFeedbackDeliveryForToolResult({
    job_id: normalized,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    // Keep the trusted control envelope comfortably below provider result
    // clipping thresholds. Further pending items attach to a later result.
    limit: 8,
  });
}

export function operatorFeedbackDeliveryText(delivery) {
  if (!delivery) return "";
  return [
    `${OPERATOR_FEEDBACK_DELIVERY_MARKER}:`,
    JSON.stringify(delivery),
    "Apply these operator instructions now. Acknowledge every item with ack_operator_feedback before normal work continues.",
  ].join("\n");
}

export function truncateToolResultPreservingFeedback(result, maxChars = 100000) {
  const text = String(result ?? "");
  const limit = Math.max(1, Number(maxChars) || 100000);
  if (text.length <= limit) return text;
  const marker = `\n\n${OPERATOR_FEEDBACK_DELIVERY_MARKER}:`;
  const deliveryIndex = text.lastIndexOf(marker);
  const truncationNotice = "\n... (tool result truncated; operator feedback preserved)";
  if (deliveryIndex < 0) return `${text.slice(0, limit)}\n... (truncated at ${Math.round(limit / 1000)} KB)`;
  const delivery = text.slice(deliveryIndex);
  const headChars = Math.max(0, limit - delivery.length - truncationNotice.length);
  return `${text.slice(0, headChars)}${truncationNotice}${delivery}`;
}

function appendOperatorFeedbackDelivery(result, toolName) {
  // Direct delivery is advisory to tool execution: a DB hiccup while claiming
  // pending feedback must never convert a successful tool result into an
  // error. Non-string results pass through untouched (String() would turn
  // structured results into "[object Object]").
  if (typeof result !== "string") return result;
  let deliveryText = "";
  try {
    deliveryText = operatorFeedbackDeliveryText(operatorFeedbackDeliveryForAmbient(toolName));
  } catch {
    return result;
  }
  const ambient = getObservationContext() || {};
  const completionSignal = subAgentCompletionSignal(ambient.agent_call_id, toolName);
  const suffix = `${deliveryText ? `\n\n${deliveryText}` : ""}${completionSignal}`;
  if (!suffix) return result;
  return `${result}${suffix}`;
}

export function parseToolArgs(argsStr) {
  try {
    return { ok: true, value: JSON.parse(argsStr) };
  } catch {
    return {
      ok: false,
      error: `Error: Could not parse tool arguments as JSON: ${String(argsStr || "").slice(0, 200)}`,
    };
  }
}

const OBSERVED_TOOL_FORMATTERS = {
  Read(input = {}) {
    return { target: input.file_path || "", summary: `Read: ${input.file_path || "?"}` };
  },
  Glob(input = {}) {
    return { target: input.pattern || "", summary: `Glob: ${input.pattern || "?"}` };
  },
  Grep(input = {}) {
    const pattern = input.pattern || "?";
    const where = input.path || input.glob || "";
    return {
      target: where ? `"${pattern}" in ${where}` : `"${pattern}"`,
      summary: `Grep: "${pattern}" in ${where || "."}`,
    };
  },
  Write(input = {}) {
    return { target: input.file_path || "", summary: `Write: ${input.file_path || "?"}` };
  },
  Edit(input = {}) {
    return { target: input.file_path || "", summary: `Edit: ${input.file_path || "?"}` };
  },
  Bash(input = {}) {
    const command = String(input.command || "");
    return {
      target: command.slice(0, 60),
      summary: `Bash: ${(command || "?").slice(0, 80)}`,
    };
  },
  chain_read(input = {}) {
    return { target: input.path || "", summary: `ChainRead: ${input.path || "?"}` };
  },
  chain_verdict(input = {}) {
    const verdict = String(input.verdict || "?").slice(0, 20);
    return { target: verdict, summary: `ChainVerdict: ${verdict}` };
  },
  agent_feedback(input = {}) {
    return { target: input.phase || "", summary: `AgentFeedback: ${input.summary || input.phase || "update"}` };
  },
  get_operator_feedback(input = {}) {
    return { target: "", summary: `GetFeedback: limit ${input.limit || 20}` };
  },
  ack_operator_feedback(input = {}) {
    return { target: String(input.interaction_id || ""), summary: `AckFeedback: #${input.interaction_id || "?"} ${input.decision || "accepted"}` };
  },
  agent_handoff(input = {}) {
    return { target: input.profile || "", summary: `AgentHandoff: ${input.profile || "?"} ${input.outcome || "?"}` };
  },
  sub_agent(input = {}) {
    return { target: input.batch_id || input.op || "", summary: `SubAgent: ${input.op || "?"}` };
  },
  sub_agent_next_input(input = {}) {
    return { target: String(input.position ?? ""), summary: `SubAgentInput: ${input.position ?? "?"}` };
  },
  read_file(input = {}) {
    return { target: input.path || "", summary: `Read: ${input.path || "?"}` };
  },
  write_file(input = {}) {
    return { target: input.path || "", summary: `Write: ${input.path || "?"}` };
  },
  edit_file(input = {}) {
    return { target: input.path || "", summary: `Edit: ${input.path || "?"}` };
  },
  list_files(input = {}) {
    return { target: input.path || "", summary: `List: ${input.path || "."}` };
  },
  search_files(input = {}) {
    const pattern = input.pattern || "?";
    return { target: pattern, summary: `Search: "${pattern}"` };
  },
  inspect_file(input = {}) {
    return { target: input.path || "", summary: `Inspect: ${input.path || "?"}` };
  },
  validate_artifact_output(input = {}) {
    return { target: input.output_root || ".", summary: `ValidateArtifact: ${input.output_root || "."}` };
  },
  prune_artifact_output(input = {}) {
    return { target: input.output_root || ".", summary: `PruneArtifact: ${input.output_root || "."}` };
  },
  bash(input = {}) {
    const command = String(input.command || "");
    return { target: command.slice(0, 60), summary: `Bash: ${(command || "?").slice(0, 80)}` };
  },
};

function atlasToolTarget(input = {}) {
  const candidates = [
    input.file,
    input.filePath,
    input.path,
    input.query,
    input.pattern,
    input.repoId,
    input.sliceHandle,
    input.taskText,
  ];
  const first = candidates.find((value) => value != null && String(value).trim() !== "");
  if (first) return String(first).split(/\r?\n/)[0].slice(0, 80);
  if (input.symbolId) return "symbol target";
  if (Array.isArray(input.symbolIds) && input.symbolIds.length > 0) {
    return `${input.symbolIds.length} symbol target${input.symbolIds.length === 1 ? "" : "s"}`;
  }
  return "";
}

function observationValueFromKeys(input = {}, keys = []) {
  for (const key of keys || []) {
    const value = input?.[key];
    if (Array.isArray(value)) {
      const first = value.find((item) => item != null && String(item).trim() !== "");
      if (first != null) return String(first);
      continue;
    }
    if (value != null && String(value).trim() !== "") return String(value);
  }
  return "";
}

function summarizeCatalogObservedToolUse(toolName, input = {}) {
  const entry = ToolCatalog.getCanonical(toolName);
  const observation = entry?.observation;
  if (!observation?.label) return null;
  const source = observationValueFromKeys(input, observation.sourceKey ? [observation.sourceKey] : []);
  const destination = observationValueFromKeys(input, observation.destinationKey ? [observation.destinationKey] : []);
  const target = source || destination
    ? `${source || "?"} -> ${destination || "?"}`
    : observationValueFromKeys(input, [
        observation.commandKey,
        observation.rootKey,
        ...(observation.pathKeys || []),
        ...(observation.arrayPathKeys || []),
        ...(observation.targetKeys || []),
      ]);
  const clippedTarget = String(target || "").split(/\r?\n/)[0].slice(0, 80);
  return {
    target: clippedTarget,
    summary: `${observation.label}${clippedTarget ? `: ${clippedTarget}` : ""}`,
  };
}

export function summarizeObservedToolUse(toolName, input = {}) {
  const raw = String(toolName || "");
  const atlasDisplayName = formatAtlasToolUseDisplayName(raw, input);
  if (atlasDisplayName) {
    const action = canonicalAtlasToolUseActionName(raw, input);
    const target = atlasSummaryHint(input, action) || atlasToolTarget(input);
    return {
      target,
      summary: `${atlasDisplayName}${target ? `: ${target}` : ""}`,
    };
  }
  // Claude/Codex surface deterministic-toolkit tools under an MCP prefix;
  // strip it so the formatter table matches bare names uniformly.
  const normalized = stripPosseMcpGatewayPrefix(raw);
  const formatter = OBSERVED_TOOL_FORMATTERS[normalized];
  if (typeof formatter === "function") return formatter(input);
  const catalogSummary = summarizeCatalogObservedToolUse(normalized, input);
  if (catalogSummary) return catalogSummary;
  const fallback = Object.values(input).filter((value) => typeof value === "string").join(" ");
  return {
    target: fallback.slice(0, 60),
    summary: `${normalized || "Tool"}: ${JSON.stringify(input || {}).slice(0, 80)}`,
  };
}

export function createStandardToolHandlerMap({
  deterministicReadFile,
  deterministicWriteFile,
  deterministicEditFile,
  deterministicListFiles,
  deterministicSearchFiles,
  deterministicGitHistory,
  deterministicInspectFile,
  deterministicHashFile,
  deterministicPullBrief,
  deterministicGetBrief,
  deterministicResizeImage,
  deterministicValidateArtifactOutput,
  deterministicPruneArtifactOutput,
  deterministicReadImageMetadata,
  deterministicOptimizeImage,
  deterministicReencodeImage,
  deterministicCleanImage,
  deterministicExtractImageText,
  deterministicRunScopedChecks,
  deterministicBash,
  execGenerateImage,
  safePath,
} = {}) {
  const protectedMutationError = (toolName, displayPath, absolutePath, ctx) => {
    const relPath = relativePathFromCwd(ctx.cwd, absolutePath);
    const reason = protectedMutablePathReason(relPath);
    return reason ? `Error: ${toolName} blocked - ${displayPath} is protected: ${reason}.` : null;
  };
  // Per-job researcher chain ledgers, keyed by the job's scope key (falls back
  // to cwd). The embedded runtime is a process singleton, so the ledger must be
  // scoped per job to avoid cross-job contamination of the audit state.
  // TODO(cleanup): evict ledgers when a researcher job completes.
  const chainLedgers = new Map();
  const embeddedChainLedger = (ctx) => {
    const key = String(ctx?.chainScopeKey || ctx?.cwd || "default");
    let ledger = chainLedgers.get(key);
    if (!ledger) {
      ledger = createChainLedger({
        readFile: deterministicReadFile,
        cwd: ctx?.cwd,
        scopePredicates: ctx?.scopePredicates,
      });
      chainLedgers.set(key, ledger);
    }
    return ledger;
  };
  const beginLiveScopeRequest = (args, ctx) => {
    const ambient = getObservationContext() || {};
    const result = requestJobScopeExpansion({
      jobId: ambient.job_id,
      workItemId: ambient.work_item_id,
      attemptId: ambient.attempt_id,
      agentCallId: ambient.agent_call_id,
      path: args.path,
      access: args.access,
      operation: args.operation,
      reason: args.reason,
      source: "embedded_internal_tool",
      liveWait: true,
    });
    if (result?.approved === true) {
      grantApprovedScopeEntries(result, ctx?.scopePredicates);
    }
    if (
      result?.live === true
      && ["scope_approval_pending", "scope_approval_batched"].includes(result?.code)
    ) {
      return { [LIVE_SCOPE_WAIT]: true, request: result, resume: null };
    }
    return result;
  };
  const handlers = {
    agent_handoff(args, ctx) {
      const ambient = getObservationContext() || {};
      try {
        assertSubAgentParentReady(ambient.agent_call_id);
        const preparedSubAgentHandoff = prepareSubAgentHandoff(ambient.agent_call_id, args || {});
        const receipt = stageAgentHandoff(args || {}, {
          context: ambient,
          role: ctx?.role || ctx?.declaredScope?.role || "",
          projectDir: ctx?.cwd || null,
          scopePredicates: ctx?.scopePredicates || null,
          maxHandoffs: (ctx?.role || ctx?.declaredScope?.role) === "planner"
            ? getIntSetting("planner_max_tasks", 50)
            : 1,
        });
        if (preparedSubAgentHandoff) sealSubAgentHandoff(ambient.agent_call_id);
        return JSON.stringify({
          ok: true,
          protocol: AGENT_HANDOFF_PROTOCOL,
          status: receipt.status,
          digest: receipt.digest,
          call_count: receipt.callCount,
          terminal: true,
        });
      } catch (error) {
        recordAgentHandoffRejection(ambient.agent_call_id, error);
        throw error;
      }
    },
    async sub_agent(args) {
      const ambient = getObservationContext() || {};
      const result = await executeSubAgent(args || {}, { context: ambient });
      return JSON.stringify(result);
    },
    async sub_agent_next_input(args) {
      const ambient = getObservationContext() || {};
      const result = await executeSubAgentNextInput(args || {}, { context: ambient });
      return JSON.stringify(result);
    },
    request_scope(args, ctx) {
      const result = beginLiveScopeRequest(args, ctx);
      return result?.[LIVE_SCOPE_WAIT] === true ? result : JSON.stringify(result, null, 2);
    },
    chain_read(args, ctx) {
      return embeddedChainLedger(ctx).chainRead(args);
    },
    chain_verdict(args, ctx) {
      return embeddedChainLedger(ctx).chainVerdict(args);
    },
    agent_feedback(args) {
      const ambient = getObservationContext() || {};
      if (ambient.job_id == null) return "No active job context is available for agent_feedback.";
      recordAgentActivity({
        work_item_id: ambient.work_item_id ?? null,
        job_id: ambient.job_id,
        attempt_id: ambient.attempt_id ?? null,
        agent_call_id: ambient.agent_call_id ?? null,
        phase: args.phase,
        status: args.status,
        body: args.summary,
        role: ambient.role ?? null,
        detail: args.detail,
        source: "embedded_tool",
      });
      return "Agent feedback recorded for Monitor Agents.";
    },
    get_operator_feedback(args) {
      const ambient = getObservationContext() || {};
      if (ambient.job_id == null) return "No active job context is available for get_operator_feedback.";
      const feedback = getOperatorFeedbackForJob({
        job_id: ambient.job_id,
        attempt_id: ambient.attempt_id ?? null,
        agent_call_id: ambient.agent_call_id ?? null,
        limit: args.limit,
      });
      return JSON.stringify({
        ok: true,
        acknowledgement_required: feedback.length > 0,
        default_ack_decision: "accepted",
        ack_tool: "ack_operator_feedback",
        feedback,
      }, null, 2);
    },
    ack_operator_feedback(args) {
      const ambient = getObservationContext() || {};
      if (ambient.job_id == null) return "No active job context is available for ack_operator_feedback.";
      const row = acknowledgeOperatorFeedback({
        interaction_id: args.interaction_id,
        job_id: ambient.job_id,
        attempt_id: ambient.attempt_id ?? null,
        agent_call_id: ambient.agent_call_id ?? null,
        decision: args.decision || "accepted",
        reason: args.reason || "",
      });
      if (!row) return `No operator feedback item found for id ${args.interaction_id}.`;
      return JSON.stringify({
        ok: true,
        interaction_id: row.id,
        decision: row.ack_decision || "accepted",
        reason: row.ack_reason || null,
        acknowledged_at: row.acknowledged_at || null,
        // First ack wins; a repeat ack reads back the recorded decision.
        ...(row.already_acknowledged ? { already_acknowledged: true } : {}),
      }, null, 2);
    },
    read_file(args, ctx) {
      return deterministicReadFile(args, ctx.cwd, ctx.scopePredicates);
    },
    write_file(args, ctx) {
      if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
      const writePath = safePath(ctx.cwd, args.path, ctx.scopePredicates);
      const protectedErr = protectedMutationError("write_file", args.path, writePath, ctx);
      if (protectedErr) return protectedErr;
      const exists = fs.existsSync(writePath);
      const allowed = exists
        ? ctx.scopePredicates.canEdit(writePath)
        : ctx.scopePredicates.canCreate(writePath);
      if (!allowed) {
        const ambient = getObservationContext() || {};
        if (ambient.job_id == null) {
          return `Error: write_file blocked - ${args.path} is outside the allowed ${exists ? "edit" : "creation"} scope.`;
        }
        const scopeResult = beginLiveScopeRequest({
          path: toRepoRelativePath(ctx.cwd, writePath) ?? "",
          access: exists ? "modify" : "create",
          operation: "write_file",
          reason: `write_file requires this ${exists ? "existing" : "new"} file to complete the active job`,
        }, ctx);
        if (scopeResult?.[LIVE_SCOPE_WAIT] === true) {
          return {
            ...scopeResult,
            resume: () => {
              const resumedPath = safePath(ctx.cwd, args.path, ctx.scopePredicates);
              const resumedProtectedErr = protectedMutationError("write_file", args.path, resumedPath, ctx);
              if (resumedProtectedErr) return resumedProtectedErr;
              return deterministicWriteFile(args, ctx.cwd, ctx.scopePredicates);
            },
          };
        }
        if (scopeResult?.approved !== true) return JSON.stringify(scopeResult, null, 2);
      }
      return deterministicWriteFile(args, ctx.cwd, ctx.scopePredicates);
    },
    edit_file(args, ctx) {
      if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
      const editPath = safePath(ctx.cwd, args.path, ctx.scopePredicates);
      const protectedErr = protectedMutationError("edit_file", args.path, editPath, ctx);
      if (protectedErr) return protectedErr;
      if (!ctx.scopePredicates.canEdit(editPath)) {
        const ambient = getObservationContext() || {};
        if (ambient.job_id == null) {
          return `Error: edit_file blocked - ${args.path} is outside the allowed edit scope (not in files_to_modify or create_roots).`;
        }
        const scopeResult = beginLiveScopeRequest({
          path: toRepoRelativePath(ctx.cwd, editPath) ?? "",
          access: "modify",
          operation: "edit_file",
          reason: "edit_file requires this existing file to complete the active job",
        }, ctx);
        if (scopeResult?.[LIVE_SCOPE_WAIT] === true) {
          return {
            ...scopeResult,
            resume: () => {
              const resumedPath = safePath(ctx.cwd, args.path, ctx.scopePredicates);
              const resumedProtectedErr = protectedMutationError("edit_file", args.path, resumedPath, ctx);
              if (resumedProtectedErr) return resumedProtectedErr;
              return deterministicEditFile(args, ctx.cwd, ctx.scopePredicates);
            },
          };
        }
        if (scopeResult?.approved !== true) return JSON.stringify(scopeResult, null, 2);
      }
      return deterministicEditFile(args, ctx.cwd, ctx.scopePredicates);
    },
    list_files(args, ctx) {
      return deterministicListFiles(args, ctx.cwd, ctx.scopePredicates);
    },
    search_files(args, ctx) {
      return deterministicSearchFiles(args, ctx.cwd, ctx.scopePredicates);
    },
    git_history(args, ctx) {
      return deterministicGitHistory(args, ctx.cwd, ctx.scopePredicates);
    },
    inspect_file(args, ctx) {
      return deterministicInspectFile(args, ctx.cwd, ctx.scopePredicates);
    },
    hash_file(args, ctx) {
      return deterministicHashFile(args, ctx.cwd, ctx.scopePredicates);
    },
    pull_brief(args, ctx) {
      return deterministicPullBrief(args, ctx.cwd, ctx.scopePredicates);
    },
    get_brief(args, ctx) {
      if (typeof deterministicGetBrief !== "function") {
        return "Error: get_brief is not wired into this provider runtime.";
      }
      return deterministicGetBrief(args, ctx.cwd, ctx.scopePredicates);
    },
    resize_image(args, ctx) {
      return deterministicResizeImage(args, ctx.cwd, ctx.scopePredicates);
    },
    validate_artifact_output(args, ctx) {
      if (typeof deterministicValidateArtifactOutput !== "function") {
        return "Error: validate_artifact_output is not wired into this provider runtime.";
      }
      return deterministicValidateArtifactOutput(args, ctx.cwd, ctx.scopePredicates);
    },
    prune_artifact_output(args, ctx) {
      if (typeof deterministicPruneArtifactOutput !== "function") {
        return "Error: prune_artifact_output is not wired into this provider runtime.";
      }
      return deterministicPruneArtifactOutput(args, ctx.cwd, ctx.scopePredicates);
    },
    read_image_metadata(args, ctx) {
      if (typeof deterministicReadImageMetadata !== "function") {
        return "Error: read_image_metadata is not wired into this provider runtime.";
      }
      return deterministicReadImageMetadata(args, ctx.cwd, ctx.scopePredicates);
    },
    optimize_image(args, ctx) {
      if (typeof deterministicOptimizeImage !== "function") {
        return "Error: optimize_image is not wired into this provider runtime.";
      }
      return deterministicOptimizeImage(args, ctx.cwd, ctx.scopePredicates);
    },
    reencode_image(args, ctx) {
      if (typeof deterministicReencodeImage !== "function") {
        return "Error: reencode_image is not wired into this provider runtime.";
      }
      return deterministicReencodeImage(args, ctx.cwd, ctx.scopePredicates);
    },
    clean_image(args, ctx) {
      if (typeof deterministicCleanImage !== "function") {
        return "Error: clean_image is not wired into this provider runtime.";
      }
      return deterministicCleanImage(args, ctx.cwd, ctx.scopePredicates);
    },
    extract_image_text(args, ctx) {
      if (typeof deterministicExtractImageText !== "function") {
        return "Error: extract_image_text is not wired into this provider runtime.";
      }
      return deterministicExtractImageText(args, ctx.cwd, ctx.scopePredicates);
    },
    run_scoped_checks(args, ctx) {
      if (typeof deterministicRunScopedChecks !== "function") {
        return "Error: run_scoped_checks is not wired into this provider runtime.";
      }
      return deterministicRunScopedChecks(args, ctx.cwd, ctx.scopePredicates, ctx.declaredScope || {});
    },
    bash(args, ctx) {
      return deterministicBash(args, ctx.cwd, ctx.allowWrite, ctx.scopePredicates.hasScope ? true : null);
    },
    async generate_image(args, ctx) {
      return execGenerateImage(args, ctx.cwd, ctx.scopePredicates);
    },
    // Opt-in project DB access. Availability is gated by per-repo config (when
    // the repo hasn't enabled it the handler returns a clear "not enabled"
    // error), and the job's write permission picks the capability lane:
    // read-lane jobs are capped to SELECT/inspection at execution. db-mode dev
    // jobs (task_mode:"db") run with allowWrite:false but carry the
    // projectDbWrite override on their declared scope — the project database
    // is their write surface even though the file tools are read-only.
    project_db_query(args, ctx) {
      const declaredCapability = ["none", "read", "write"].includes(String(ctx.declaredScope?.projectDbCapability || "").toLowerCase())
        ? String(ctx.declaredScope.projectDbCapability).toLowerCase()
        : null;
      if (declaredCapability === "none") {
        return "Error: project_db_query is not authorized by the declared project database capability.";
      }
      const dbWrite = declaredCapability
        ? declaredCapability === "write"
        : ctx.allowWrite || ctx.declaredScope?.projectDbWrite === true;
      return execProjectDbQuery(args, {
        projectDir: ctx.cwd,
        capability: declaredCapability || (dbWrite ? "write" : "read"),
      });
    },
  };
  // Attach the embedded executors to a ToolRegistry seeded with the shared
  // suite metadata, so the embedded runtime's handler set flows through the
  // single registry the deterministic MCP server also builds from.
  const registry = declareToolSuites(new ToolRegistry());
  for (const [name, execute] of Object.entries(handlers)) {
    if (!registry.has(name)) {
      registry.declare({
        suite: "tools",
        name,
        roles: [...(ToolCatalog.get(name)?.roleAllowlist || [])],
        mutatesWorktree: false,
        advertise: [],
      });
    }
    registry.attach(name, execute);
  }
  // Parity: every tool advertised on the function transport must have an
  // executor attached here. Catches "advertised but not executable" drift
  // (e.g. promoting chain_read to the embedded surface without wiring it).
  assertAdvertisedHaveExecutors(registry, registry.executableNames(), "function");
  return registry.handlerMap();
}

export async function executeToolWithMap(name, argsStr, context, {
  handlers = {},
  onUnknown = null,
} = {}) {
  const parsed = parseToolArgs(argsStr);
  if (!parsed.ok) return parsed.error;
  const args = parsed.value;

  try {
    const ambient = getObservationContext() || {};
    if (
      name === "agent_handoff"
      && ambient.job_id != null
      && countPendingOperatorFeedbackForJob(ambient.job_id) > 0
    ) {
      return appendOperatorFeedbackDelivery(
        "Error: agent_handoff paused: acknowledge pending operator feedback with ack_operator_feedback before terminal handoff.",
        name,
      );
    }
    const violatesTerminalHandoff = () => name !== "agent_handoff"
      && rejectAgentHandoffForLaterTool(ambient.agent_call_id, name);
    if (violatesTerminalHandoff()) {
      return "Error: agent_handoff was already staged; later tool calls invalidate the terminal report";
    }
    const handler = handlers[name];
    if (typeof handler === "function") {
      const run = () => handler(args, context);
      // The operator channel must stay reachable no matter what holds the
      // worktree gate: the trio touches only SQLite, so running it ungated
      // cannot conflict with a blocking tool's write barrier — and gating it
      // meant a 120s bash hold could fail the operator's own recovery path
      // with gate contention.
      if (LIVE_CHANNEL_TOOL_NAMES.has(name)) {
        const result = await run();
        if (violatesTerminalHandoff()) {
          return "Error: agent_handoff was staged while this tool was running; the terminal report was invalidated";
        }
        return appendOperatorFeedbackDelivery(result, name);
      }
      const label = `tool.${name}`;
      const key = nativeToolGateKey(context?.cwd);
      let result = BLOCKING_NATIVE_TOOL_NAMES.has(name)
        ? await PROVIDER_TOOL_GATE.write(key, run, { label, waitMs: 120000, barrierName: label })
        : await PROVIDER_TOOL_GATE.read(key, run, { label, waitMs: 30000 });
      if (result?.[LIVE_SCOPE_WAIT] === true) {
        const ambientJob = getObservationContext() || {};
        const decision = await awaitSharedEmbeddedScopeDecision({
          jobId: ambientJob.job_id,
          requestId: result.request?.request_id,
          attemptId: ambientJob.attempt_id,
          signal: context?.abortSignal || null,
        });
        if (decision?.approved === true) {
          const entries = Array.isArray(decision.batch) && decision.batch.length > 0
            ? decision.batch
            : [decision];
          for (const entry of entries) {
            if (entry?.path) context?.scopePredicates?.policy?.grantWritePath?.(entry.path);
          }
          // The human wait happens outside the repository gate. Reacquire the
          // mutation lane only for the original write/edit operation itself.
          const continuation = result;
          result = typeof continuation.resume === "function"
            ? await PROVIDER_TOOL_GATE.write(key, () => continuation.resume(decision), {
              label: `${label}.approved`,
              waitMs: 120000,
              barrierName: `${label}.approved`,
            })
            : JSON.stringify(decision, null, 2);
        } else {
          result = JSON.stringify(decision, null, 2);
        }
      }
      if (name === "agent_handoff") return result;
      if (name === "sub_agent" || name === "sub_agent_next_input") {
        return appendOperatorFeedbackDelivery(result, name);
      }
      if (violatesTerminalHandoff()) {
        return "Error: agent_handoff was staged while this tool was running; the terminal report was invalidated";
      }
      const treeCompacted = compactTreeScopeResult(name, result, { args, context });
      if (treeCompacted.compacted) {
        const anchored = appendHashRefIfMajor(name, treeCompacted.result, { args, context, minChars: 1 });
        return appendOperatorFeedbackDelivery(anchored, name);
      }
      const surveyCompacted = compactCodeSurveyResult(name, result, { args, context });
      if (surveyCompacted.compacted) {
        const anchored = appendHashRefIfMajor(name, surveyCompacted.result, { args, context, minChars: 1 });
        return appendOperatorFeedbackDelivery(anchored, name);
      }
      // Window/lens ref-paging (flag-gated) runs after survey compaction and
      // before the ambient stamp so the stamp covers the compacted inline head.
      const refPaged = compactCodeWindowLensResult(name, surveyCompacted.result, { args, context });
      const withHashRef = appendHashRefIfMajor(name, refPaged.result, {
        args,
        context,
        ...(refPaged.compacted ? { minChars: 1 } : {}),
      });
      return appendOperatorFeedbackDelivery(withHashRef, name);
    }
    if (typeof onUnknown === "function") {
      const result = await onUnknown(name, args, context);
      if (violatesTerminalHandoff()) {
        return "Error: agent_handoff was staged while this tool was running; the terminal report was invalidated";
      }
      return appendOperatorFeedbackDelivery(result, name);
    }
    return `Error: Unknown tool "${name}"`;
  } catch (err) {
    if (isAsyncGateError(err)) throw err;
    return `Error executing ${name}: ${sanitizeAbsolutePathsInText(err?.message || String(err), context?.cwd)}`;
  }
}
