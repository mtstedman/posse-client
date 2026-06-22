// @ts-check
//
// Central ATLAS tool execution coordinator. Protocol layers (MCP, embedded
// providers, prefetch) should route ATLAS tool calls through this object so
// queueing, dedupe, telemetry, and conductor ownership stay in one place.

import { AsyncResourceGate } from "../../../../shared/concurrency/classes/AsyncGate.js";
import { getSharedConductor } from "../../functions/v2/parse/conductor.js";
import { ATLAS_TOOL_ACTIONS } from "../../functions/v2/contracts/tool-params.js";
import { ledgerDbPath, mainViewPath } from "../../functions/v2/runtime-paths.js";
import { resolveTargetBranch } from "../../../git/functions/target-branch.js";
import path from "node:path";

const DEFAULT_DEDUPE_WINDOW_MS = 1500;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_DEDUPE_MAX = 256;

const ATLAS_READONLY_DEDUPE_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "info",
  "symbol.search",
  "symbol.getcard",
  "symbol.getcards",
  "slice.build",
  "context",
  "context.summary",
  "agent.context",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "code.getskeleton",
  "code.gethotpath",
  "code.needwindow",
  "file.read",
  "pr.risk",
  "memory.query",
  "policy.get",
  "runtime.queryoutput",
  "usage.stats",
]);

const ATLAS_BLOCKING_ACTIONS = new Set([
  "repo.register",
  "index.refresh",
  "scip.ingest",
  "workflow",
  "buffer.push",
  "buffer.checkpoint",
  "agent.feedback",
  "memory.store",
  "memory.remove",
  "policy.set",
  "runtime.execute",
]);

const ATLAS_GATEWAY_ACTIONS = new Set(["query", "code", "repo", "agent"]);

function stableStringify(value) {
  if (value === undefined || value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function mcpTextResult(text, isError = false) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    isError: !!isError,
  };
}

function conductorEnvelopeToToolResult(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { result: mcpTextResult("Error: ATLAS v2 dispatch returned no envelope", true), ok: false };
  }
  if (envelope.ok === false || envelope.error) {
    const message = envelope.error?.message || envelope.error?.code || "v2 backend error";
    return {
      result: mcpTextResult(`Error: ATLAS v2 ${envelope.action || ""}: ${message}`, true),
      ok: false,
      errorMsg: String(message),
    };
  }
  const data = envelope.data === undefined ? {} : envelope.data;
  const payload = envelope.meta && data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, _meta: envelope.meta }
    : data;
  let text;
  try { text = JSON.stringify(payload, null, 2); }
  catch { text = String(payload); }
  return { result: mcpTextResult(text, false), ok: true, errorMsg: null };
}

function withDedupeMarker(value, mode) {
  const cloned = cloneJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return cloned;
  return {
    ...cloned,
    executor: {
      ...(cloned.executor || {}),
      deduped: mode,
    },
  };
}

function stripAtlasPrefix(name = "") {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

function resolveAtlasAction(toolName = "") {
  const stripped = stripAtlasPrefix(toolName);
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (stripped))) return stripped;
  const lowered = stripped.toLowerCase();
  for (const candidate of ATLAS_TOOL_ACTIONS) {
    if (String(candidate).toLowerCase() === lowered) return candidate;
  }
  return stripped;
}

function gatewayEffectiveAction(action, args = {}) {
  if (!ATLAS_GATEWAY_ACTIONS.has(action)) return action;
  const target = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  return target || action;
}

function effectiveAction(toolName, args = {}) {
  return gatewayEffectiveAction(resolveAtlasAction(toolName), args);
}

function directReadEligible(action, args = {}) {
  if (ATLAS_GATEWAY_ACTIONS.has(action)) return false;
  if (ATLAS_BLOCKING_ACTIONS.has(action)) return false;
  if (gatewayEffectiveAction(action, args) !== action) return false;
  if (String(action || "").startsWith("buffer.") || String(action || "").startsWith("runtime.")) return false;
  if (action === "memory.store" || action === "memory.remove" || action === "memory.flag") return false;
  if (action === "policy.set" || action === "agent.feedback") return false;
  return true;
}

function normalizeRepoKey(value) {
  const text = String(value || "global").replace(/\\/g, "/").trim();
  return text || "global";
}

function normalizeWorkItemKey(value) {
  if (value == null) return null;
  const text = String(value || "").trim();
  if (!text) return null;
  const id = text.replace(/^wi[-:]/i, "");
  return id ? `wi-${id}` : null;
}

function maybeWorkItemKey(value) {
  if (typeof value === "number" && Number.isFinite(value)) return normalizeWorkItemKey(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^wi[-:]/i.test(text) || /^\d+$/.test(text)) return normalizeWorkItemKey(text);
  return null;
}

function workItemKeyForRequest(request = {}) {
  const config = request.config || {};
  const session = request.session || {};
  const boot = session.bootConfig || session || {};
  const source = request.source && typeof request.source === "object" ? request.source : {};
  return normalizeWorkItemKey(
    request.workItemId
    ?? request.work_item_id
    ?? config.workItemId
    ?? config.work_item_id
    ?? boot.workItemId
    ?? boot.work_item_id
    ?? session.workItemId
    ?? session.work_item_id
    ?? source.workItemId
    ?? source.work_item_id
    ?? null,
  );
}

function readContextKeyFor(scope) {
  if (scope && typeof scope === "object") {
    const wiKey = normalizeWorkItemKey(scope.workItemId ?? scope.work_item_id ?? scope.wi ?? null);
    if (wiKey) return wiKey;
    const location = scope.location || scope.repoKey || scope.repoRoot || scope.repoPath || scope.cwd || null;
    return normalizeRepoKey(location);
  }
  const wiKey = maybeWorkItemKey(scope);
  return wiKey || normalizeRepoKey(scope);
}

/**
 * @typedef {{
 *   toolName: string,
 *   args?: Record<string, any>,
 *   session?: Record<string, any> | null,
 *   config?: Record<string, any> | null,
 *   source?: Record<string, any> | string | null,
 *   workItemId?: string | number | null,
 *   work_item_id?: string | number | null,
 *   waitMs?: number | null,
 * }} AtlasToolRequest
 */

export class AtlasToolExecutor {
  #conductorFactory;
  #gate;
  #dedupeWindowMs;
  #waitMs;
  #dedupeMax;
  /** @type {Map<string, Promise<any>>} */
  #inflightDedupe = new Map();
  /** @type {Map<string, { atMs: number, payload: any }>} */
  #recentDedupe = new Map();
  /** @type {Map<string, Record<string, any>>} */
  #readContexts = new Map();
  /** @type {Map<string, string>} */
  #readContextVersions = new Map();
  #now;

  constructor({
    conductorFactory = getSharedConductor,
    gate = new AsyncResourceGate({ name: "ATLAS tool executor", policy: "writer-priority" }),
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    waitMs = DEFAULT_WAIT_MS,
    dedupeMax = DEFAULT_DEDUPE_MAX,
    readContexts = null,
    now = Date.now,
  } = {}) {
    this.#conductorFactory = conductorFactory;
    this.#gate = gate;
    this.#dedupeWindowMs = Math.max(0, Number(dedupeWindowMs) || 0);
    this.#waitMs = Math.max(0, Number(waitMs) || DEFAULT_WAIT_MS);
    this.#dedupeMax = Math.max(1, Number(dedupeMax) || DEFAULT_DEDUPE_MAX);
    this.#now = now;
    if (readContexts && typeof readContexts === "object") {
      for (const [repoKey, context] of Object.entries(readContexts)) {
        this.setReadContext(repoKey, context);
      }
    }
  }

  /**
   * Execute one ATLAS tool call through the shared conductor boundary.
   *
   * @param {AtlasToolRequest} request
   */
  async executeTool(request = {}) {
    const toolName = String(request.toolName || "").trim();
    if (!toolName) throw new Error("AtlasToolExecutor.executeTool requires toolName");
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const action = effectiveAction(toolName, args);
    const repoKey = this.#repoKeyFor(request);
    const dedupeEligible = ATLAS_READONLY_DEDUPE_ACTIONS.has(String(action).toLowerCase());
    const dedupeKey = dedupeEligible ? this.#dedupeKey({ toolName, args, repoKey }) : null;
    if (dedupeKey) {
      const cached = this.#recentDedupe.get(dedupeKey);
      if (cached && this.#now() - cached.atMs <= this.#dedupeWindowMs) {
        return withDedupeMarker(cached.payload, "cache");
      }
      const inflight = this.#inflightDedupe.get(dedupeKey);
      if (inflight) {
        const value = await inflight;
        return withDedupeMarker(value, "inflight");
      }
    }

    const run = () => this.#runThroughGate({ ...request, toolName, args, action, repoKey });
    if (!dedupeKey) return run();

    const promise = run()
      .then((value) => {
        this.#rememberDedupe(dedupeKey, value);
        return value;
      })
      .finally(() => {
        if (this.#inflightDedupe.get(dedupeKey) === promise) this.#inflightDedupe.delete(dedupeKey);
      });
    this.#inflightDedupe.set(dedupeKey, promise);
    return promise;
  }

  /**
   * Queue an incremental ATLAS warm after a deterministic file write. This is
   * intentionally owner/conductor-side; MCP reports the write result and never
   * runs parse/index refresh work itself.
   *
   * @param {AtlasToolRequest & { result?: any }} request
   */
  async scheduleDeterministicWriteRefresh(request = {}) {
    const toolName = String(request.toolName || "").trim();
    if (toolName !== "write_file" && toolName !== "edit_file") return null;
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const boot = request.session?.bootConfig || request.session || {};
    const atlas = boot?.atlas || {};
    const liveBuffers = String(atlas.liveBuffers || "off").trim().toLowerCase();
    if (!["1", "true", "deterministic-writes"].includes(liveBuffers)) return null;
    if (!args.path) return null;

    const cwd = String(boot.cwd || request.config?.cwd || process.cwd());
    const repoRoot = String(request.config?.repoRoot || atlas.repoPath || cwd);
    const absPath = path.resolve(cwd, String(args.path));
    const relPath = path.relative(cwd, absPath).replace(/\\/g, "/");
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return null;
    const repoKey = normalizeRepoKey(repoRoot);
    const branch = this.#branchForRepo(repoRoot);
    const config = {
      ...(atlas && typeof atlas === "object" ? atlas : {}),
      ...(request.config && typeof request.config === "object" ? request.config : {}),
    };
    return this.#gate.write(
      repoKey,
      async (queueInfo) => {
        const conductor = this.#conductorFactory();
        const result = await conductor.warm({
          ledgerPath: ledgerDbPath(repoRoot),
          dbPath: mainViewPath(repoRoot),
          repoRoot,
          branch,
          config,
          job: {
            purpose: "main-incremental",
            branch,
            paths: [relPath],
            trigger_event: "atlas.executor.deterministic_write",
            out_view_path: mainViewPath(repoRoot),
          },
        }, { timeoutMs: request.waitMs || this.#waitMs });
        return {
          ok: result?.ok !== false,
          action: "index.refresh",
          path: relPath,
          via: "AtlasToolExecutor",
          branch,
          queue: {
            key: queueInfo.key,
            waitMs: queueInfo.waitMs,
            depthAtEnqueue: queueInfo.depthAtEnqueue,
            inFlightAtEnqueue: queueInfo.inFlightAtEnqueue,
          },
          result,
        };
      },
      { label: "atlas.deterministic_write.refresh", waitMs: request.waitMs || this.#waitMs },
    );
  }

  setReadContext(scope, context = null) {
    const key = readContextKeyFor(scope);
    if (!context || typeof context !== "object") {
      this.clearReadContext(key);
      return;
    }
    const cloned = cloneJson(context) || {};
    const version = this.#readContextVersion(cloned);
    const previous = this.#readContextVersions.get(key);
    this.#readContexts.set(key, cloned);
    this.#readContextVersions.set(key, version);
    if (previous !== version) this.#clearRecentDedupeForRepo(key);
  }

  hasReadContext(scope) {
    return this.#readContexts.has(readContextKeyFor(scope));
  }

  clearReadContext(scope) {
    const key = readContextKeyFor(scope);
    this.#readContexts.delete(key);
    this.#readContextVersions.delete(key);
    this.#clearRecentDedupeForRepo(key);
  }

  clearReadContexts() {
    this.#readContexts.clear();
    this.#readContextVersions.clear();
    this.#recentDedupe.clear();
  }

  snapshot() {
    return {
      gate: this.#gate.snapshot?.() || null,
      inflightDedupe: this.#inflightDedupe.size,
      recentDedupe: this.#recentDedupe.size,
      readContexts: this.#readContexts.size,
      dedupeWindowMs: this.#dedupeWindowMs,
      waitMs: this.#waitMs,
    };
  }

  async close() {
    this.#inflightDedupe.clear();
    this.#recentDedupe.clear();
    this.#readContexts.clear();
    this.#readContextVersions.clear();
  }

  #runThroughGate(request) {
    const mode = ATLAS_BLOCKING_ACTIONS.has(String(request.action || ""));
    const label = `atlas.tool.${request.action || request.toolName}`;
    const runner = async (queueInfo) => {
      const conductor = this.#conductorFactory();
      const payload = {
        toolName: request.toolName,
        action: request.action,
        args: request.args,
        session: request.session || null,
        config: request.config || null,
        source: request.source || null,
        executor: {
          queue: {
            key: queueInfo.key,
            waitMs: queueInfo.waitMs,
            depthAtEnqueue: queueInfo.depthAtEnqueue,
            inFlightAtEnqueue: queueInfo.inFlightAtEnqueue,
            mode: queueInfo.mode,
          },
        },
      };
      const readPayload = await this.#readPayloadFor(request, conductor);
      if (readPayload && typeof conductor.retrieve === "function") {
        const envelope = await conductor.retrieve(readPayload, { timeoutMs: request.waitMs || this.#waitMs });
        return conductorEnvelopeToToolResult(envelope);
      }
      if (typeof conductor.executeTool === "function") {
        return conductor.executeTool(payload, { timeoutMs: request.waitMs || this.#waitMs });
      }
      if (typeof conductor.retrieve === "function") {
        return conductor.retrieve(payload, { timeoutMs: request.waitMs || this.#waitMs });
      }
      throw new Error("ATLAS conductor does not expose executeTool/retrieve");
    };
    return mode
      ? this.#gate.write(request.repoKey, runner, { label, waitMs: request.waitMs || this.#waitMs })
      : this.#gate.read(request.repoKey, runner, { label, waitMs: request.waitMs || this.#waitMs });
  }

  #repoKeyFor(request) {
    const wiKey = workItemKeyForRequest(request);
    if (wiKey) return wiKey;
    const config = request.config || {};
    const session = request.session || {};
    const boot = session.bootConfig || session || {};
    return normalizeRepoKey(
      config.repoRoot
      || config.cwd
      || boot?.atlas?.repoPath
      || boot?.cwd
      || request.args?.repoRoot
      || request.args?.cwd
      || "global",
    );
  }

  async #readPayloadFor(request, conductor = null) {
    if (!directReadEligible(request.action, request.args)) return null;
    const context = await this.#readContextFor(request, conductor);
    if (!context) return null;
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const action = request.action;
    const call = { action, ...args };
    const taskText = typeof args.taskText === "string"
      ? args.taskText
      : (action === "symbol.search" && typeof args.query === "string" ? args.query : undefined);
    const wantsSemantic = (action === "symbol.search" && args.semantic)
      || (action === "slice.build" && args.taskText && args.semantic !== false)
      || ((action === "context" || action === "context.summary") && args.taskText);
    return {
      call,
      viewPath: context.viewPath || null,
      ledgerPath: context.ledgerPath || null,
      versionId: String(context.versionId || ""),
      readRoot: context.readRoot || undefined,
      repoId: context.repoId || null,
      semantic: !!wantsSemantic,
      taskText,
      taskType: typeof args.taskType === "string" ? args.taskType : undefined,
      config: cloneJson(request.config || context.config || {}) || {},
    };
  }

  #dedupeKey({ toolName, args, repoKey }) {
    return `${repoKey}|${String(toolName || "")}|${stableStringify(args || {})}`;
  }

  async #readContextFor(request, conductor = null) {
    let context = this.#readContexts.get(request.repoKey);
    const wiKey = workItemKeyForRequest(request);
    if (context || !wiKey || typeof conductor?.resolveReadContext !== "function") return context || null;
    const resolved = await conductor.resolveReadContext({
      workItemKey: wiKey,
      workItemId: wiKey.replace(/^wi-/, ""),
      repoKey: request.repoKey,
      config: request.config || null,
      session: request.session || null,
      source: request.source || null,
    });
    if (!resolved || typeof resolved !== "object") return null;
    this.setReadContext({ workItemId: wiKey }, resolved);
    context = this.#readContexts.get(wiKey);
    return context || null;
  }

  #readContextVersion(context) {
    return stableStringify({
      viewPath: context?.viewPath || null,
      ledgerPath: context?.ledgerPath || null,
      versionId: context?.versionId || null,
      readRoot: context?.readRoot || null,
      repoId: context?.repoId || null,
    });
  }

  #clearRecentDedupeForRepo(repoKey) {
    const prefix = `${repoKey}|`;
    for (const key of [...this.#recentDedupe.keys()]) {
      if (String(key).startsWith(prefix)) this.#recentDedupe.delete(key);
    }
  }

  #rememberDedupe(key, payload) {
    this.#recentDedupe.set(key, { atMs: this.#now(), payload: cloneJson(payload) });
    while (this.#recentDedupe.size > this.#dedupeMax) {
      const oldest = this.#recentDedupe.keys().next().value;
      if (oldest == null) break;
      this.#recentDedupe.delete(oldest);
    }
  }

  #branchForRepo(repoRoot) {
    try {
      return resolveTargetBranch(repoRoot || process.cwd());
    } catch {
      return "main";
    }
  }
}
