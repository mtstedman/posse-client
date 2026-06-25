// @ts-check
//
// Central dispatcher for ATLAS v2 tool actions.
//
// Every tool call enters here. Action is matched against
// ATLAS_TOOL_ACTIONS; unknown actions return a structured error rather
// than throwing so the server boundary remains uniform.
//
// Dispatch returns either a ToolResultEnvelope or a Promise when an action
// needs worker IO. Handlers that only read an already-open view stay direct,
// while DB-tapping lifecycle work can be awaited by callers.

import fs from "fs";
import path from "path";
import { ATLAS_TOOL_ACTIONS } from "../contracts/tool-params.js";
import { normalizeAtlasToolCall, validateAtlasToolCall } from "../contracts/tool-schemas.js";
import { errorEnvelope } from "./envelope.js";
import { symbolSearch } from "./search.js";
import { sliceBuild, sliceRefresh, sliceSpilloverGet } from "./slice.js";
import { editPlan } from "./edit-plan.js";
import { repoRegister, repoStatus, indexRefresh, repoOverview, repoQuality } from "./repo.js";
import { bufferPush, bufferCheckpoint, bufferStatus, makeOverlayReadFile } from "./buffer.js";
import { symbolGetCard, symbolGetCards } from "./symbol-card.js";
import { symbolUsages } from "./usages.js";
import { treeGrow, treeOverview, treeScope, treeWalk } from "./tree.js";
import {
  codeGetSkeleton,
  codeGetSkeletonAsync,
  codeGetHotPath,
  codeGetHotPathAsync,
  codeNeedWindow,
  codeNeedWindowAsync,
} from "./code.js";
import { contextBuild, contextSummary, agentFeedback, agentFeedbackQuery } from "./context.js";
import { fileRead, fileReadAsync } from "./file-read.js";
import { deltaGet, prRiskAnalyze, prRisk } from "./blast-radius.js";
import { memoryStore, memorySurface, memoryGet, memoryFeedback } from "./memory.js";
import { policyGet, policySet } from "./policy.js";
import { usageStats, recordAtlasUsageEvent } from "./usage.js";
import { runtimeExecute, runtimeQueryOutput } from "./runtime.js";
import { scipIngest } from "./scip.js";
import { info } from "./info.js";
import { actionSearch, manual } from "./discovery.js";
import { workflowExecute } from "./workflow.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/tool-params.js").ToolCall} ToolCall */
/** @typedef {import("../contracts/tool-params.js").AtlasToolAction} AtlasToolAction */
/** @typedef {import("../contracts/tool-params.js").TaskType} TaskType */
/** @typedef {import("../contracts/tool-results.js").AnyToolResult} AnyToolResult */
/** @typedef {import("./orchestrator/query-planner-types.js").QueryPlan} QueryPlan */

/** @typedef {(path: string) => string | null} ReadFile */

/**
 * @typedef {Object} DispatchContext
 * @property {View} [view]
 * @property {string} versionId
 * @property {Ledger} [ledger]        Optional ledger for history-aware operations (review.delta, agent.feedback persistence, retrieval feedback boost).
 * @property {ReadFile} [readFile]
 * @property {string} [repoRoot]      Filesystem root used to resolve repo-relative reads.
 * @property {string} [viewPath]
 * @property {string} [repoId]
 * @property {Record<string, unknown>} [config]
 * @property {EmbeddingIndex} [embeddingIndex] When set with `encoder`, semantic discovery can use vectors.
 * @property {EmbeddingEncoder} [encoder]
 * @property {string} [taskText]      When present, threads into hybrid search task-query re-ranking on symbol.search.
 * @property {TaskType} [taskType]    When present, scopes feedback boost for symbol.search to one task type.
 * @property {(input: string) => QueryPlan | Promise<QueryPlan>} [planner]
 * @property {boolean} [asyncNativeRedaction] When true, redaction-heavy retrieval uses async native daemon calls.
 */

/**
 * @param {ToolCall} call
 * @param {DispatchContext} ctx
 * @returns {AnyToolResult | Promise<AnyToolResult>}
 */
export function dispatch(call, ctx) {
  const startedAt = Date.now();
  const normalizedCall = normalizeAtlasToolCall(normalizeToolCall(call));
  const result = dispatchImpl(normalizedCall, ctx);
  return recordAndReturn(result, {
    ledger: ctx.ledger,
    action: String(normalizedCall?.action || ""),
    repoId: ctx.repoId,
    versionId: ctx.versionId,
    startedAt,
    taskType: ctx.taskType || (typeof /** @type {any} */ (normalizedCall).taskType === "string" ? /** @type {any} */ (normalizedCall).taskType : null),
  });
}

/**
 * @param {ToolCall} call
 * @param {DispatchContext} ctx
 * @returns {AnyToolResult | Promise<AnyToolResult>}
 */
function dispatchImpl(call, ctx) {
  call = normalizeAtlasToolCall(normalizeToolCall(call));
  const action = call.action;
  if (!ATLAS_TOOL_ACTIONS.includes(action)) {
    return /** @type {any} */ (
      errorEnvelope({
        action: /** @type {AtlasToolAction} */ (action),
        versionId: ctx.versionId,
        code: "unknown_action",
        message: `Unknown ATLAS action: ${String(action)}`,
      })
    );
  }
  const validation = validateAtlasToolCall(call);
  if (validation.ok === false) {
    const validationCode = validationErrorCodeForAction(action, validation.errors);
    return /** @type {any} */ (
      errorEnvelope({
        action,
        versionId: ctx.versionId,
        code: validationCode,
        message: `Invalid ATLAS parameters for ${action}: ${validation.errors[0]?.message || "request failed schema validation"}`,
        details: { errors: validation.errors },
      })
    );
  }
  const baseReadFile = ctx.readFile || makeFsReadFile(ctx.repoRoot);
  const readFile = makeOverlayReadFile({
    repoRoot: ctx.repoRoot,
    sessionId: /** @type {any} */ (call).sessionId,
    baseReadFile,
  });
  switch (action) {
    case "query":
      return /** @type {any} */ (dispatchGateway({ gateway: "query", call, ctx }));
    case "code":
      return /** @type {any} */ (dispatchGateway({ gateway: "code", call, ctx }));
    case "repo":
      return /** @type {any} */ (dispatchGateway({ gateway: "repo", call, ctx }));
    case "agent":
      return /** @type {any} */ (dispatchGateway({ gateway: "agent", call, ctx }));
    case "action.search":
      return /** @type {any} */ (actionSearch({ versionId: ctx.versionId, params: call }));
    case "manual":
      return /** @type {any} */ (manual({ versionId: ctx.versionId, params: call }));
    case "workflow":
      return /** @type {any} */ (workflowExecute({
        versionId: ctx.versionId,
        params: call,
        runAction: (innerCall) => dispatchImpl(innerCall, ctx),
      }));
    case "info":
      return /** @type {any} */ (info({
        versionId: ctx.versionId,
        params: call,
        view: ctx.view,
        ledger: ctx.ledger,
        repoRoot: ctx.repoRoot,
        repoId: ctx.repoId,
        viewPath: ctx.viewPath,
      }));
    case "repo.register":
      return /** @type {any} */ (repoRegister({
        versionId: ctx.versionId,
        params: call,
        repoRoot: ctx.repoRoot,
        repoId: ctx.repoId,
      }));
    case "index.refresh":
      return /** @type {any} */ (indexRefresh({
        versionId: ctx.versionId,
        params: call,
        repoRoot: ctx.repoRoot,
        ledger: ctx.ledger,
        config: ctx.config,
      }));
    case "buffer.push":
      return /** @type {any} */ (bufferPush({ repoRoot: ctx.repoRoot, versionId: ctx.versionId, params: call }));
    case "buffer.checkpoint":
      return /** @type {any} */ (bufferCheckpoint({ repoRoot: ctx.repoRoot, versionId: ctx.versionId, params: call }));
    case "buffer.status":
      return /** @type {any} */ (bufferStatus({ repoRoot: ctx.repoRoot, versionId: ctx.versionId, params: call }));
    case "agent.feedback.query":
      return /** @type {any} */ (agentFeedbackQuery({ versionId: ctx.versionId, params: call, ledger: ctx.ledger }));
    case "repo.status":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (repoStatus({
        view: ctx.view,
        versionId: ctx.versionId,
        params: call,
        repoId: ctx.repoId,
        repoRoot: ctx.repoRoot,
        viewPath: ctx.viewPath,
        ledger: ctx.ledger,
        config: ctx.config,
      }));
    case "repo.overview":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (repoOverview({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "repo.quality":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (repoQuality({
        view: ctx.view,
        versionId: ctx.versionId,
        params: call,
        repoRoot: ctx.repoRoot,
        viewPath: ctx.viewPath,
        ledger: ctx.ledger,
        config: ctx.config,
      }));
    case "symbol.search":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (symbolSearch({
        view: ctx.view,
        versionId: ctx.versionId,
        params: call,
        ledger: ctx.ledger,
        embeddingIndex: ctx.embeddingIndex,
        encoder: ctx.encoder,
        taskText: ctx.taskText || (typeof /** @type {any} */ (call).taskText === "string" ? /** @type {any} */ (call).taskText : undefined),
        taskType: ctx.taskType || (typeof /** @type {any} */ (call).taskType === "string" ? /** @type {any} */ (call).taskType : undefined),
        repoId: ctx.repoId,
        repoRoot: ctx.repoRoot,
        planner: ctx.planner,
        onDemandEmbeddingFill: ctx.config?.onDemandEmbeddingFill !== false,
      }));
    case "symbol.card":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (symbolGetCard({ view: ctx.view, versionId: ctx.versionId, params: call, repoRoot: ctx.repoRoot, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "symbol.cards":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (symbolGetCards({ view: ctx.view, versionId: ctx.versionId, params: call, repoRoot: ctx.repoRoot, ledger: ctx.ledger, repoId: ctx.repoId, action: "symbol.cards" }));
    case "symbol.overview":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (symbolUsages({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "tree.overview":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (treeOverview({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "tree.branch":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (treeWalk({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "tree.scope":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (treeScope({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "tree.expand":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (treeGrow({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "slice.build":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (sliceBuild({
        view: ctx.view,
        versionId: ctx.versionId,
        params: call,
        ledger: ctx.ledger,
        repoRoot: ctx.repoRoot,
        repoId: ctx.repoId,
        embeddingIndex: ctx.embeddingIndex,
        encoder: ctx.encoder,
        taskType: ctx.taskType || (typeof /** @type {any} */ (call).taskType === "string" ? /** @type {any} */ (call).taskType : undefined),
        planner: ctx.planner,
        onDemandEmbeddingFill: ctx.config?.onDemandEmbeddingFill !== false,
      }));
    case "slice.refresh":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (sliceRefresh({ view: ctx.view, versionId: ctx.versionId, params: call, repoRoot: ctx.repoRoot }));
    case "slice.spillover.get":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (sliceSpilloverGet({ view: ctx.view, versionId: ctx.versionId, params: call, repoRoot: ctx.repoRoot }));
    case "edit.plan":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (editPlan({ view: ctx.view, versionId: ctx.versionId, params: call }));
    case "code.skeleton":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ ((ctx.asyncNativeRedaction ? codeGetSkeletonAsync : codeGetSkeleton)({ view: ctx.view, versionId: ctx.versionId, params: call, readFile, repoRoot: ctx.repoRoot }));
    case "code.lens":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ ((ctx.asyncNativeRedaction ? codeGetHotPathAsync : codeGetHotPath)({ view: ctx.view, versionId: ctx.versionId, params: call, readFile, repoRoot: ctx.repoRoot }));
    case "code.window":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ ((ctx.asyncNativeRedaction ? codeNeedWindowAsync : codeNeedWindow)({ view: ctx.view, versionId: ctx.versionId, params: call, readFile, repoRoot: ctx.repoRoot, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "context":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (contextBuild({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoRoot: ctx.repoRoot, repoId: ctx.repoId, embeddingIndex: ctx.embeddingIndex, encoder: ctx.encoder, planner: ctx.planner }));
    case "context.summary":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (contextSummary({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoRoot: ctx.repoRoot, repoId: ctx.repoId, embeddingIndex: ctx.embeddingIndex, encoder: ctx.encoder, planner: ctx.planner }));
    case "agent.feedback":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (agentFeedback({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger }));
    case "review.delta":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (deltaGet({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger }));
    case "review.analyze":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (prRiskAnalyze({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger }));
    case "review.risk":
      if (!ctx.view) return notIndexed(action, ctx.versionId);
      return /** @type {any} */ (prRisk({ view: ctx.view, versionId: ctx.versionId, params: call, ledger: ctx.ledger }));
    case "file.read":
      return /** @type {any} */ ((ctx.asyncNativeRedaction ? fileReadAsync : fileRead)({ versionId: ctx.versionId, params: call, readFile, view: ctx.view }));
    case "memory.store":
      return /** @type {any} */ (memoryStore({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "memory.get":
      return /** @type {any} */ (memoryGet({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId, view: ctx.view }));
    case "memory.feedback":
      return /** @type {any} */ (memoryFeedback({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "memory.surface":
      // The view (when present) lets surfacing validate file anchors against
      // the indexed tree; surfacing still works ledger-only without it.
      return /** @type {any} */ (memorySurface({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId, view: ctx.view }));
    case "policy.get":
      return /** @type {any} */ (policyGet({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "policy.set":
      return /** @type {any} */ (policySet({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "usage.stats":
      return /** @type {any} */ (usageStats({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoId: ctx.repoId }));
    case "runtime.execute":
      return /** @type {any} */ (runtimeExecute({
        versionId: ctx.versionId,
        params: call,
        ledger: ctx.ledger,
        repoRoot: ctx.repoRoot,
        repoId: ctx.repoId,
      }));
    case "runtime.queryOutput":
      return /** @type {any} */ (runtimeQueryOutput({
        versionId: ctx.versionId,
        params: call,
        repoRoot: ctx.repoRoot,
      }));
    case "scip.ingest":
      return /** @type {any} */ (scipIngest({ versionId: ctx.versionId, params: call, ledger: ctx.ledger, repoRoot: ctx.repoRoot }));
    default:
      return /** @type {any} */ (
        errorEnvelope({
          action,
          versionId: ctx.versionId,
          code: "unimplemented_action",
          message: `Action ${action} is registered but has no handler`,
        })
      );
  }
}

function validationErrorCodeForAction(action, errors = []) {
  if (
    action === "memory.feedback"
    && errors.some((error) =>
      (error?.path === "$.reason" || error?.path === "$.verdict")
      && ["enum", "required"].includes(String(error?.code || ""))
    )
  ) {
    return "invalid_memory_feedback_verdict";
  }
  return "invalid_params";
}

const GATEWAY_ACTIONS = Object.freeze({
  query: new Set([
    "symbol.search",
    "symbol.card",
    "symbol.cards",
    "symbol.overview",
    "tree.overview",
    "tree.branch",
    "tree.scope",
    "tree.expand",
    "slice.build",
    "slice.refresh",
    "slice.spillover.get",
    "edit.plan",
    "context",
    "context.summary",
    "review.delta",
    "review.analyze",
    "review.risk",
    "repo.status",
    "repo.quality",
    "memory.surface",
    "memory.get",
    "file.read",
  ]),
  code: new Set([
    "code.skeleton",
    "code.lens",
    "code.window",
    "edit.plan",
    "file.read",
  ]),
  repo: new Set([
    "info",
    "action.search",
    "manual",
    "repo.register",
    "repo.status",
    "repo.quality",
    "index.refresh",
    "policy.get",
    "policy.set",
    "usage.stats",
    "runtime.execute",
    "runtime.queryOutput",
    "scip.ingest",
  ]),
  agent: new Set([
    "context",
    "context.summary",
    "agent.feedback",
    "agent.feedback.query",
    "buffer.push",
    "buffer.checkpoint",
    "buffer.status",
    "memory.store",
    "memory.feedback",
  ]),
});

const ACTION_BY_NORMALIZED_KEY = new Map(
  ATLAS_TOOL_ACTIONS.map((action) => [actionKey(action), action]),
);

const ACTION_ALIAS_BY_NORMALIZED_KEY = new Map([
  ["symbolgetcard", "symbol.card"],
  ["symbolgetcards", "symbol.cards"],
  ["symbolcards", "symbol.cards"],
  ["treewalk", "tree.branch"],
]);

const FIELD_ALIASES = Object.freeze({
  action_name: "actionName",
  gateway_action: "gatewayAction",
  target_action: "targetAction",
  node_id: "nodeId",
  repo: "repoId",
  repo_id: "repoId",
  repo_root: "repoRoot",
  root_path: "repoRoot",
  project_path: "repoRoot",
  symbol_id: "symbolId",
  symbol_ids: "symbolIds",
  symbol_ref: "symbolRef",
  ref_type: "refType",
  ref_id: "refId",
  symbol_refs: "symbolRefs",
  entry_symbols: "entrySymbols",
  task_text: "taskText",
  task_type: "taskType",
  from_version: "fromVersion",
  to_version: "toVersion",
  slice_handle: "sliceHandle",
  spillover_handle: "spilloverHandle",
  if_none_match: "ifNoneMatch",
  known_etags: "knownEtags",
  known_card_etags: "knownCardEtags",
  file_path: "filePath",
  relative_cwd: "relativeCwd",
  identifiers: "identifiersToFind",
  identifiers_to_find: "identifiersToFind",
  expected_lines: "expectedLines",
  max_tokens: "maxTokens",
  max_depth: "maxDepth",
  max_cards: "maxCards",
  include_aggregates: "includeAggregates",
  include_terms: "includeTerms",
  include_refs: "includeRefs",
  include_latest_run: "includeLatestRun",
  include_resolution_metadata: "includeResolutionMetadata",
  min_call_confidence: "minCallConfidence",
});

const BLOCKED_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {{ gateway: "query" | "code" | "repo" | "agent", call: ToolCall, ctx: DispatchContext }} args
 */
function dispatchGateway({ gateway, call, ctx }) {
  const target = normalizeActionName(String(
    /** @type {any} */ (call).gatewayAction
    || /** @type {any} */ (call).targetAction
    || /** @type {any} */ (call).actionName
    || "",
  ).trim());
  const allowed = GATEWAY_ACTIONS[gateway];
  if (!target || !allowed.has(target)) {
    return errorEnvelope({
      action: /** @type {AtlasToolAction} */ (gateway),
      versionId: ctx.versionId,
      code: "gateway_action_not_allowed",
      message: `${gateway} gateway cannot route action: ${target || "<missing>"}`,
      details: { gateway, allowedActions: [...allowed].sort() },
    });
  }
  const inner = { .../** @type {any} */ (call) };
  delete inner.gatewayAction;
  delete inner.targetAction;
  delete inner.actionName;
  inner.action = target;
  return dispatchImpl(/** @type {ToolCall} */ (inner), ctx);
}

/**
 * @param {AnyToolResult | Promise<AnyToolResult>} result
 * @param {{ ledger?: Ledger, action: string, repoId?: string, versionId?: string, startedAt: number, taskType?: string | null }} detail
 * @returns {AnyToolResult | Promise<AnyToolResult>}
 */
function recordAndReturn(result, detail) {
  if (result && typeof /** @type {any} */ (result).then === "function") {
    return /** @type {any} */ (result).then((envelope) => {
      recordAtlasUsageEvent({ ...detail, envelope });
      return envelope;
    }).catch((err) => {
      recordAtlasUsageEvent({
        ...detail,
        envelope: {
          ok: false,
          action: detail.action,
          error: {
            code: "handler_rejected",
            message: err?.message || String(err),
          },
        },
      });
      throw err;
    });
  }
  recordAtlasUsageEvent({ ...detail, envelope: result });
  return result;
}

/**
 * @param {AtlasToolAction} action
 * @param {string} versionId
 * @returns {AnyToolResult}
 */
function notIndexed(action, versionId) {
  return /** @type {AnyToolResult} */ (/** @type {any} */ (errorEnvelope({
    action,
    versionId,
    code: "not_indexed",
    message: `${action} requires an ATLAS view; run repo.register/index.refresh first.`,
  })));
}

/**
 * Default readFile implementation that resolves repo-relative paths
 * against `repoRoot`. Returns null on any IO error so handlers can
 * report a clean error envelope rather than throwing.
 *
 * @param {string | undefined} repoRoot
 * @returns {ReadFile}
 */
function makeFsReadFile(repoRoot) {
  if (!repoRoot) {
    return () => null;
  }
  const root = path.resolve(repoRoot);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* fall back to resolved root */ }
  return (relPath) => {
    try {
      const abs = path.resolve(root, relPath);
      // Guard against path-traversal: the resolved absolute path must
      // remain within repoRoot.
      if (!abs.startsWith(root + path.sep) && abs !== root) return null;
      const realAbs = fs.realpathSync(abs);
      if (!realAbs.startsWith(realRoot + path.sep) && realAbs !== realRoot) return null;
      const stat = fs.statSync(realAbs);
      if (!stat.isFile()) return null;
      return fs.readFileSync(realAbs, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * @param {ToolCall} call
 * @returns {ToolCall}
 */
function normalizeToolCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) return call;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [rawKey, value] of Object.entries(/** @type {Record<string, unknown>} */ (call))) {
    if (BLOCKED_ARGUMENT_KEYS.has(rawKey)) continue;
    const key = normalizeFieldName(rawKey);
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = value;
  }
  if (typeof out.action === "string") out.action = normalizeActionName(out.action);
  for (const key of ["gatewayAction", "targetAction", "actionName"]) {
    if (typeof out[key] === "string") out[key] = normalizeActionName(out[key]);
  }
  return /** @type {ToolCall} */ (out);
}

/**
 * @param {string} key
 */
function normalizeFieldName(key) {
  if (Object.prototype.hasOwnProperty.call(FIELD_ALIASES, key)) {
    return /** @type {Record<string, string>} */ (FIELD_ALIASES)[key];
  }
  if (!key.includes("_")) return key;
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, char) => char.toUpperCase());
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeActionName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {AtlasToolAction} */ (raw))) return raw;
  const stripped = raw
    .replace(/^atlas[._-]/i, "")
    .replace(/^atlas_/i, "");
  const key = actionKey(stripped);
  return ACTION_ALIAS_BY_NORMALIZED_KEY.get(key) || ACTION_BY_NORMALIZED_KEY.get(key) || stripped;
}

/**
 * @param {string} action
 */
function actionKey(action) {
  return String(action || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
