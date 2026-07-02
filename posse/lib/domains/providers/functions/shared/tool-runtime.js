import path from "path";
import { protectedMutablePathReason, relativePathFromCwd } from "../../../runtime/functions/protected-paths.js";
import { AsyncResourceGate } from "../../../../shared/concurrency/classes/AsyncGate.js";
import { stripPosseMcpGatewayPrefix } from "../../../integrations/functions/mcp-gateway.js";
import { ToolCatalog } from "../../../../classes/tools/ToolCatalog.js";
import { ToolRegistry } from "../../../../classes/tools/ToolRegistry.js";
import { declareToolSuites, LIVE_CHANNEL_TOOL_NAMES } from "../../../../functions/tools/tool-suites.js";
import { assertAdvertisedHaveExecutors } from "../../../../functions/tools/tool-parity.js";
import { createChainLedger } from "../../../../functions/tools/chain-ledger.js";
import { formatAtlasToolUseDisplayName } from "../../../../functions/tools/mcp-surface.js";
import { getObservationContext } from "../../../observability/functions/observations.js";
import { execProjectDbQuery } from "../../../../functions/toolkit/project-db/query.js";
import {
  acknowledgeOperatorFeedback,
  countPendingOperatorFeedbackForJob,
  getOperatorFeedbackForJob,
  recordAgentActivity,
} from "../../../queue/functions/index.js";

const PROVIDER_TOOL_GATE = new AsyncResourceGate({ name: "provider native tool" });
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

function liveChannelSignalForAmbient(toolName) {
  if (LIVE_CHANNEL_TOOL_NAMES.has(toolName)) return "";
  const ambient = getObservationContext() || {};
  if (ambient.job_id == null) return "";
  return operatorFeedbackSignalTextForJob(ambient.job_id, toolName);
}

/**
 * The signal suffix for a specific job — shared with owner-side result paths
 * (PersistentMcpOwner ATLAS results) that carry an explicit session job id
 * instead of ambient observation context.
 *
 * @param {number | string | null} jobId
 * @param {string} [toolName]
 * @returns {string}
 */
export function operatorFeedbackSignalTextForJob(jobId, toolName = "") {
  if (toolName && LIVE_CHANNEL_TOOL_NAMES.has(toolName)) return "";
  const normalized = Number(jobId);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";
  const pendingCount = countPendingOperatorFeedbackForJob(normalized);
  if (pendingCount <= 0) return "";
  return [
    "",
    "OPERATOR_FEEDBACK_SIGNAL:",
    JSON.stringify({
      operator_feedback_available: true,
      pending_count: pendingCount,
      next_tool: "get_operator_feedback",
      ack_tool: "ack_operator_feedback",
    }),
  ].join("\n");
}

function appendLiveChannelSignal(result, toolName) {
  // The signal is advisory: a DB hiccup while counting pending feedback must
  // never convert a SUCCESSFUL tool result into an error, and non-string
  // results must pass through untouched (String() would turn structured
  // results into "[object Object]").
  if (typeof result !== "string") return result;
  let signal = "";
  try {
    signal = liveChannelSignalForAmbient(toolName);
  } catch {
    return result;
  }
  if (!signal) return result;
  return `${result}${signal}`;
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
    const verdict = String(input.verdict || "").slice(0, 20);
    return { target: input.path || "", summary: `ChainVerdict: ${input.path || "?"} → ${verdict}` };
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
    input.symbolId,
    input.repoId,
    input.sliceHandle,
    input.taskText,
  ];
  const first = candidates.find((value) => value != null && String(value).trim() !== "");
  return first ? String(first).split(/\r?\n/)[0].slice(0, 80) : "";
}

export function summarizeObservedToolUse(toolName, input = {}) {
  const raw = String(toolName || "");
  const atlasDisplayName = formatAtlasToolUseDisplayName(raw, input);
  if (atlasDisplayName) {
    const target = atlasToolTarget(input);
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
  const handlers = {
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
        phase: args.phase,
        action: args.status,
        body: args.summary,
        source: "embedded_tool",
        metadata_json: { status: args.status || null },
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
      if (!ctx.scopePredicates.canCreate(writePath)) {
        return `Error: write_file blocked - ${args.path} is outside the allowed creation scope (not in files_to_create or create_roots). If this is a new file, it must be in files_to_create. Use FILE_REQUEST if you need out-of-scope files created.`;
      }
      return deterministicWriteFile(args, ctx.cwd, ctx.scopePredicates);
    },
    edit_file(args, ctx) {
      if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
      const editPath = safePath(ctx.cwd, args.path, ctx.scopePredicates);
      const protectedErr = protectedMutationError("edit_file", args.path, editPath, ctx);
      if (protectedErr) return protectedErr;
      if (!ctx.scopePredicates.canEdit(editPath)) {
        return `Error: edit_file blocked - ${args.path} is outside the allowed edit scope (not in files_to_modify or create_roots)`;
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
    // Opt-in project DB access. Capability is gated by per-repo config; when the
    // repo hasn't enabled it the handler returns a clear "not enabled" error.
    project_db_query(args, ctx) {
      return execProjectDbQuery(args, { projectDir: ctx.cwd });
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
    const handler = handlers[name];
    if (typeof handler === "function") {
      const run = () => handler(args, context);
      // The operator channel must stay reachable no matter what holds the
      // worktree gate: the trio touches only SQLite, so running it ungated
      // cannot conflict with a blocking tool's write barrier — and gating it
      // meant a 120s bash hold could fail the operator's own recovery path
      // with gate contention.
      if (LIVE_CHANNEL_TOOL_NAMES.has(name)) {
        return appendLiveChannelSignal(await run(), name);
      }
      const label = `tool.${name}`;
      const key = nativeToolGateKey(context?.cwd);
      const result = BLOCKING_NATIVE_TOOL_NAMES.has(name)
        ? await PROVIDER_TOOL_GATE.write(key, run, { label, waitMs: 120000, barrierName: label })
        : await PROVIDER_TOOL_GATE.read(key, run, { label, waitMs: 30000 });
      return appendLiveChannelSignal(result, name);
    }
    if (typeof onUnknown === "function") {
      const result = await onUnknown(name, args, context);
      return appendLiveChannelSignal(result, name);
    }
    return `Error: Unknown tool "${name}"`;
  } catch (err) {
    if (isAsyncGateError(err)) throw err;
    return `Error executing ${name}: ${err?.message || String(err)}`;
  }
}
