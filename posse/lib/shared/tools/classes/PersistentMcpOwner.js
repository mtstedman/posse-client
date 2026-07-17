// @ts-check
//
// Persistent MCP owner for provider-launched stdio shims.
//
// The shim stays tiny and forwards JSON-RPC frames here over a local named-pipe
// HTTP endpoint. The owner verifies the signed job capability token, keeps the
// full deterministic MCP runtime out of each provider-launched shim process,
// and owns session lifecycle for the parent Posse process.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  bootConfigFromMcpOAuthClaims,
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  mintMcpOAuthTokenForBootConfig,
  verifyMcpOAuthToken,
} from "../../../domains/integrations/functions/deterministic-mcp/oauth-token.js";
import { ATLAS_TOOL_ACTIONS } from "../../../domains/atlas/functions/v2/contracts/tool-params.js";
import { getSharedAtlasToolExecutor } from "../../../domains/atlas/functions/v2/tools/executor.js";
import { operatorFeedbackSignalTextForJob } from "../../../domains/providers/functions/shared/tool-runtime.js";
import { noteAtlasPressureAndGetNudge } from "../../../domains/integrations/functions/deterministic-mcp/gate.js";
import { recordToolUseObservations } from "../../../domains/observability/functions/observations.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import { NativeAuthHandshake } from "../../native/classes/NativeAuthHandshake.js";
import { appendHashRefIfMajor, compactCodeSurveyResult, compactCodeWindowLensResult, createHashRefTool, fetchHashRefTool } from "../functions/hash-adder.js";
import {
  bindAgentAttachmentToSignedContract,
  isInternalAtlasAction,
  narrowBootConfigToSignedClaims,
} from "../functions/issued-tool-policy.js";

const MAX_OWNER_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
// A child that produces NO response across this many consecutive request
// timeouts is treated as wedged (event loop blocked, native deadlock) rather
// than merely slow, and is force-killed so the next request respawns it. Any
// response resets the counter, so a legitimately long single call does not
// trip it. The gateway is stateless per request, so respawn loses nothing.
const MAX_CONSECUTIVE_REQUEST_TIMEOUTS = 2;
// Minimum spacing between child (re)spawns. Without it, a server spec that
// crashes on startup turns every forwarded request into a fresh, heavy Node
// process spawn — a hot crash-loop. The shim already treats the resulting
// backoff error as a transient 5xx and retries.
const GATEWAY_RESTART_BACKOFF_MS = 2000;
const JSONL_STDOUT_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;
const TOKEN_CLOCK_SKEW_MS = 30 * 1000;
const SESSION_ORPHAN_TTL_MS = 8 * 60 * 60 * 1000;
const ATLAS_TOOL_ACTION_SET = new Set(ATLAS_TOOL_ACTIONS);
const ATLAS_NESTED_ACTION_WRAPPERS = new Set(["query", "code", "repo", "agent", "workflow"]);

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeIdPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

// Unix domain socket paths are capped at ~108 bytes (sockaddr_un.sun_path). A
// long TMPDIR (some systemd/CI/sandbox setups) can push the default path past
// that and make listen() fail with ENAMETOOLONG. Keep the bound path short.
const UNIX_SOCKET_PATH_MAX = 100;

function shortenUnixSocketPath(candidate, suffix) {
  if (Buffer.byteLength(candidate) <= UNIX_SOCKET_PATH_MAX) return candidate;
  const shortId = crypto.createHash("sha1").update(String(suffix)).digest("hex").slice(0, 16);
  // POSIX-only path (this branch never runs on win32); keep forward slashes
  // regardless of the host so the bound socket path is deterministic.
  for (const base of ["/tmp", "/var/tmp"]) {
    const short = path.posix.join(base, `posse-mcp-${shortId}.sock`);
    if (Buffer.byteLength(short) <= UNIX_SOCKET_PATH_MAX) return short;
  }
  return candidate; // best effort; listen() will surface any residual error
}

export function __testShortenUnixSocketPath(candidate, suffix) {
  return shortenUnixSocketPath(candidate, suffix);
}

function defaultPipePath(bootId) {
  const suffix = `${process.pid}-${safeIdPart(bootId)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\posse-mcp-owner-${suffix}`;
  return shortenUnixSocketPath(path.join(os.tmpdir(), `posse-mcp-owner-${suffix}.sock`), suffix);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_OWNER_BODY_BYTES) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function bearerFrom(req) {
  const raw = String(req?.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : "";
}

function tokenEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function ownerErrorSummary(err) {
  if (!err) return null;
  const cause = err.cause && err.cause !== err ? err.cause : null;
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    status: err?.status || err?.statusCode || err?.response?.status || null,
    message: capString(err?.message || String(err), 700),
    cause: cause ? {
      name: cause?.name || null,
      code: cause?.code || cause?.errno || null,
      status: cause?.status || cause?.statusCode || cause?.response?.status || null,
      message: capString(cause?.message || String(cause), 700),
    } : null,
  };
}

function isPowershellClixmlProgressNoise(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  return /#<\s*CLIXML/i.test(text) && /Preparing modules for first use/i.test(text);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function stripGatewaySessionTokenFields(value = {}) {
  const out = cloneJson(value);
  delete out.mcpOAuthToken;
  delete out.mcpOauthToken;
  if (out.mcpAuth && typeof out.mcpAuth === "object") {
    delete out.mcpAuth.accessToken;
    delete out.mcpAuth.token;
  }
  return out;
}

function stripToolsPrefix(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("tools.")) return raw.slice("tools.".length);
  if (raw.startsWith("tools_")) return raw.slice("tools_".length);
  return raw;
}

function stripAtlasPrefix(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

function normalizeAtlasActionName(name) {
  const raw = String(name || "").trim();
  const stripped = raw.startsWith("atlas.")
    ? raw.slice("atlas.".length).trim()
    : (raw.startsWith("atlas_") ? raw.slice("atlas_".length).trim() : raw);
  if (ATLAS_TOOL_ACTION_SET.has(stripped)) return stripped;
  const dotted = stripped.replace(/^atlas_/, "").replace(/_/g, ".").trim();
  if (ATLAS_TOOL_ACTION_SET.has(dotted)) return dotted;
  const lowered = dotted.toLowerCase();
  for (const action of ATLAS_TOOL_ACTION_SET) {
    if (String(action).toLowerCase() === lowered) return action;
  }
  return stripped;
}

function nestedAtlasAction(args = {}) {
  return normalizeAtlasActionName(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  );
}

function requestedToolPolicyName(name, args = {}) {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) {
    const action = normalizeAtlasActionName(raw);
    return {
      suite: "atlas",
      name: action,
      nested: nestedAtlasAction(args),
    };
  }
  return {
    suite: "tools",
    name: stripToolsPrefix(raw),
    nested: "",
  };
}

function suiteToolAllowlistPolicy(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist && typeof bootConfig.toolAllowlist === "object" && !Array.isArray(bootConfig.toolAllowlist)
    ? bootConfig.toolAllowlist
    : null;
  const suites = {};
  if (source) {
    for (const [suite, names] of Object.entries(source)) {
      const suiteName = String(suite || "").trim().toLowerCase();
      if (!suiteName || !Array.isArray(names)) continue;
      suites[suiteName] = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    }
  }
  return {
    suites,
    source: source ? "token-allowlist" : "missing-token-allowlist",
  };
}

function hasSuiteToolAllowlist(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist;
  return !!(source && typeof source === "object" && !Array.isArray(source));
}

function sessionToolPolicy(session) {
  return suiteToolAllowlistPolicy(session?.bootConfig || {});
}

function toolAllowedByPolicy(policy, toolName, args = {}) {
  const requested = requestedToolPolicyName(toolName, args);
  const allowed = policy?.suites?.[requested.suite] || new Set();
  if (requested.suite === "atlas") {
    if (!requested.name || isInternalAtlasAction(requested.name)) return false;
    if (!allowed.has(requested.name)) return false;
    if (ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name) && requested.nested) {
      return !isInternalAtlasAction(requested.nested) && allowed.has(requested.nested);
    }
    return true;
  }
  return !!requested.name && allowed.has(requested.name);
}

function filterToolsListMessage(message, policy) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.filter((tool) => toolAllowedByPolicy(policy, tool?.name)),
    },
  };
}

function toolsListCount(message) {
  const tools = message?.result?.tools;
  return Array.isArray(tools) ? tools.length : null;
}

function attachTelemetryContext(session, ownerBootId) {
  const boot = session?.bootConfig || {};
  return {
    component: "deterministic_mcp",
    owner_boot_id: ownerBootId || null,
    session_id: session?.id || null,
    provider: boot.providerName || null,
    role: boot.role || null,
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
  };
}

function injectSessionContext(message, session) {
  const outbound = cloneJson(message);
  const params = outbound.params && typeof outbound.params === "object" && !Array.isArray(outbound.params)
    ? { ...outbound.params }
    : {};
  delete params._posseSession;
  params._posseSession = {
    sessionId: session.id,
    bootConfig: stripGatewaySessionTokenFields(session.bootConfig || {}),
  };
  outbound.params = params;
  return outbound;
}

function deniedToolCallMessage(message, toolName, policy) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (id == null) return null;
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: `Tool ${toolName || "(unknown)"} is not allowed for this MCP session (${policy.source} policy).`,
      }],
      isError: true,
    },
  };
}

function mcpToolErrorPayload(message, error = null) {
  const text = String(message || "ATLAS tool execution failed");
  const structured = error && typeof error === "object"
    ? {
        code: error.code ? String(error.code) : "atlas_tool_error",
        message: error.message ? String(error.message) : text,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    : null;
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    isError: true,
    ...(structured ? { structuredContent: { error: structured }, _meta: { atlasError: structured } } : {}),
  };
}

function mcpToolTextPayload(text) {
  const value = String(text || "");
  return {
    content: [{ type: "text", text: value }],
    isError: /^Error:/i.test(value),
  };
}

function mcpToolResultMessage(message, result) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (id == null) return null;
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function atlasExecutorSessionContext(session) {
  return {
    id: session?.id || null,
    bootConfig: stripGatewaySessionTokenFields(session?.bootConfig || {}),
    tokenSource: session?.tokenSource || null,
    tokenVerified: session?.tokenVerified === true,
  };
}

function hashRefToolContext(session) {
  const boot = session?.bootConfig || {};
  return {
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    agent_call_id: boot.agentCallId ?? null,
  };
}

function isAtlasFetchRefTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && requested.name === "fetch_ref";
}

function isAtlasCreateHashTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && requested.name === "create_ref";
}

function appendHashRefToMcpTextResult(result, toolName, toolArgs, session) {
  if (!result || result.isError === true) return result;
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
  const context = hashRefToolContext(session);
  // Flag-gated survey tail compaction runs before the ambient stamp so the
  // stamp covers the compacted (inline-head) payload.
  const compacted = compactCodeSurveyResult(requested.name || toolName, first.text, { args, context });
  const refPaged = compactCodeWindowLensResult(requested.name || toolName, compacted.result, { args, context });
  const stamped = appendHashRefIfMajor(requested.name || toolName, refPaged.result, {
    args,
    context,
    source: `atlas:${requested.name || toolName}`,
    objectType: requested.name ? `atlas.${requested.name}` : "atlas.tool_result",
  });
  if (stamped === first.text) return result;
  return {
    ...result,
    content: [{ ...first, text: stamped }, ...result.content.slice(1)],
  };
}

/**
 * Append the operator-feedback availability signal to an ATLAS MCP result's
 * text. Advisory: any failure (or a non-text result) leaves the result
 * untouched — a signal lookup must never break a successful ATLAS call.
 */
/* L3a (atlas_gate_nudge): count lens/window ladder pressure on the owner
 * ATLAS lane (the claude/MCP transport, where the embedded tool loop's gate
 * hooks never run) and append the in-band steering nudge to the triggering
 * result when the flag is on. Shadow-mode (flag off) still records the
 * observation; this helper then appends nothing. */
function appendOwnerAtlasPressureNudge(result, session, toolName, toolArgs) {
  try {
    if (result?.isError === true) return result;
    const jobId = session?.bootConfig?.jobId ?? null;
    const nudge = noteAtlasPressureAndGetNudge({
      action: toolName,
      args: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
      scopeKey: jobId != null ? `job:${jobId}` : (session?.id || null),
    });
    if (!nudge) return result;
    const first = result?.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") return result;
    return {
      ...result,
      content: [{ ...first, text: `${first.text}\n\n${nudge}` }, ...result.content.slice(1)],
    };
  } catch {
    return result;
  }
}

function appendOwnerOperatorFeedbackSignal(result, session) {
  try {
    const signal = operatorFeedbackSignalTextForJob(session?.bootConfig?.jobId ?? null);
    if (!signal) return result;
    const first = result?.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") return result;
    return {
      ...result,
      content: [{ ...first, text: `${first.text}${signal}` }, ...result.content.slice(1)],
    };
  } catch {
    return result;
  }
}

function mcpToolCallSuccess(response = null) {
  const result = response?.result;
  if (!result || result.isError === true) return false;
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("")
    : "";
  return !/^(?:Error:|AUDIT ERROR:)/i.test(String(text || ""));
}

function mcpToolResultErrorText(result = null) {
  if (!result?.isError) return "";
  const contentText = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").filter(Boolean).join("\n")
    : "";
  const structured = result?.structuredContent?.error?.message || result?._meta?.atlasError?.message || "";
  return capString(contentText || structured || "ATLAS tool returned an error", 700);
}

function recordOwnerToolObservation({ session, toolName, toolArgs, result = null, error = null } = {}) {
  const boot = session?.bootConfig || {};
  const errorText = error
    ? capString(error?.message || String(error), 700)
    : mcpToolResultErrorText(result);
  try {
    recordToolUseObservations({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      cwd: boot.cwd || null,
      tool_uses: [{
        tool: toolName,
        input: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
        ...(errorText ? { status: "error", error: errorText } : {}),
      }],
    });
  } catch (recordErr) {
    appendRunTelemetry("diagnostics", {
      kind: "mcp.owner.tool_observation_failed",
      ...attachTelemetryContext(session, null),
      tool_name: toolName || null,
      error: ownerErrorSummary(recordErr),
    });
  }
}

function jsonlParseBuffer(buffer, onMessage, { onParseError = null, maxBufferBytes = JSONL_STDOUT_BUFFER_MAX_BYTES } = {}) {
  let next = buffer;
  while (next.length > 0) {
    const newlineIdx = next.indexOf(0x0a);
    if (newlineIdx < 0) break;
    const lineBytes = next.subarray(0, newlineIdx);
    next = next.subarray(newlineIdx + 1);
    if (lineBytes.length > maxBufferBytes) {
      const err = new Error(`MCP session stdout JSONL frame exceeded ${maxBufferBytes} bytes`);
      if (typeof onParseError === "function") onParseError(err, "");
      continue;
    }
    let line = lineBytes.toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.trim();
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch (err) {
      if (typeof onParseError === "function") onParseError(err, line);
    }
  }
  if (next.length > maxBufferBytes) {
    const err = new Error(`MCP session stdout JSONL buffer exceeded ${maxBufferBytes} bytes without newline`);
    if (typeof onParseError === "function") onParseError(err, "");
    return Buffer.alloc(0);
  }
  return next;
}

export function __testJsonlParseBuffer(buffer, onMessage, opts = {}) {
  return jsonlParseBuffer(buffer, onMessage, opts);
}

class PersistentMcpSession {
  constructor({
    id,
    token,
    claims,
    bootConfig,
    serverSpec,
    agentOwned = false,
    spawnImpl = spawn,
  } = {}) {
    this.id = id;
    this.token = token;
    this.claims = claims || {};
    this.bootConfig = bootConfig || {};
    this.serverSpec = serverSpec || null;
    this.agentOwned = agentOwned === true;
    this._spawn = spawnImpl;
    this._proc = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._pending = new Map();
    this._seq = 0;
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    this.startedAt = null;
    this.lastExit = null;
    this.prewarmedAt = null;
    this.prewarmError = null;
    this._prewarmPromise = null;
    this.tokenVerified = !!claims?.__verified;
    this.tokenSource = claims?.__source || (this.tokenVerified ? "local" : "registered");
    const now = Date.now();
    this.registeredAt = now;
    this.updatedAt = now;
    this.lastSeenAt = now;
    this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null;
    this.attachProof = this._newAttachProof();
  }

  _newAttachProof() {
    return {
      initializeSeenAt: null,
      toolsListSeenAt: null,
      toolsListCount: null,
      firstToolCallSeenAt: null,
      firstToolName: null,
      requestCount: 0,
      lastRequestAt: null,
      lastMethod: null,
      lastOwnerError: null,
    };
  }

  update({ token, claims, bootConfig, serverSpec, agentOwned = undefined } = {}) {
    if (token) this.token = token;
    if (claims) {
      this.claims = claims;
      this.tokenVerified = !!claims.__verified;
      this.tokenSource = claims.__source || (this.tokenVerified ? "local" : "registered");
      this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : this.expiresAt;
    }
    if (bootConfig) this.bootConfig = bootConfig;
    if (serverSpec) this.serverSpec = serverSpec;
    if (agentOwned !== undefined && (agentOwned === true) !== this.agentOwned) {
      throw new Error("MCP session ownership cannot change after registration");
    }
    this.updatedAt = Date.now();
    this.attachProof = this._newAttachProof();
    this.touch();
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
  }

  snapshotAttachProof() {
    return {
      initializeSeenAt: this.attachProof.initializeSeenAt || null,
      toolsListSeenAt: this.attachProof.toolsListSeenAt || null,
      toolsListCount: this.attachProof.toolsListCount ?? null,
      firstToolCallSeenAt: this.attachProof.firstToolCallSeenAt || null,
      firstToolName: this.attachProof.firstToolName || null,
      requestCount: this.attachProof.requestCount || 0,
      lastRequestAt: this.attachProof.lastRequestAt || null,
      lastMethod: this.attachProof.lastMethod || null,
      lastOwnerError: this.attachProof.lastOwnerError || null,
    };
  }

  noteRequest(message = {}, now = Date.now()) {
    const method = String(message?.method || "").trim();
    this.attachProof.requestCount += 1;
    this.attachProof.lastRequestAt = now;
    this.attachProof.lastMethod = method || null;
    if (method === "initialize" && !this.attachProof.initializeSeenAt) {
      this.attachProof.initializeSeenAt = now;
      return "initialize";
    }
    if (method === "tools/call" && !this.attachProof.firstToolCallSeenAt) {
      this.attachProof.firstToolCallSeenAt = now;
      this.attachProof.firstToolName = String(message?.params?.name || "").trim() || null;
      return "tools/call";
    }
    return null;
  }

  noteToolsList(response = null, now = Date.now()) {
    const count = toolsListCount(response);
    this.attachProof.toolsListSeenAt = this.attachProof.toolsListSeenAt || now;
    this.attachProof.toolsListCount = count;
    return count;
  }

  noteOwnerError(err, method = null, now = Date.now()) {
    this.attachProof.lastOwnerError = {
      at: now,
      method: method || this.attachProof.lastMethod || null,
      error: ownerErrorSummary(err),
    };
  }

  isExpired(now = Date.now()) {
    // Agent-owned registration follows the authoritative in-process Agent
    // lifecycle. Its bearer has a separate hard expiry at the RPC boundary
    // and is rotated before reuse, so pruning registration by token age here
    // would strand an otherwise reusable Agent before it can rotate.
    if (this.agentOwned) return false;
    const idleMs = now - (this.lastSeenAt || this.registeredAt || now);
    if (this.expiresAt && now > this.expiresAt + SESSION_TOKEN_EXPIRY_GRACE_MS) {
      return idleMs > SESSION_TOKEN_EXPIRY_GRACE_MS;
    }
    return idleMs > SESSION_ORPHAN_TTL_MS;
  }

  isTokenExpired(now = Date.now()) {
    return !!this.expiresAt && now > this.expiresAt + TOKEN_CLOCK_SKEW_MS;
  }

  _rejectPending(error) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  ensureStarted() {
    if (this._proc && this._proc.exitCode == null) return;
    if (!this.serverSpec?.command) {
      throw new Error("MCP session has no registered server spec");
    }
    // Respawn backoff: a spec that crashes on startup would otherwise hot-loop
    // one heavy Node spawn per forwarded request. Allow the first respawn after
    // a crash immediately (a single restart is normal and several tests depend
    // on it), but once the child has died repeatedly without ever answering,
    // throttle spawns to one per backoff window. The crash counter resets on any
    // healthy response, so this only engages for a genuinely broken child.
    if (this._crashesSinceHealthy >= 2
      && this.lastExit?.at
      && Date.now() - this.lastExit.at < GATEWAY_RESTART_BACKOFF_MS) {
      const err = new Error("MCP session restarting; backing off after repeated exits");
      err.code = "GATEWAY_RESTART_BACKOFF";
      throw err;
    }
    const spec = this.serverSpec;
    const proc = this._spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      env: spec.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._proc = proc;
    this.startedAt = Date.now();
    this.lastExit = null;
    this._consecutiveTimeouts = 0;
    this._stdoutBuffer = Buffer.alloc(0);
    let finished = false;
    const finish = ({ code = null, signal = null, error = null } = {}) => {
      if (finished || this._proc !== proc) return;
      finished = true;
      this.lastExit = {
        at: Date.now(),
        code,
        signal,
        ...(error ? { error: ownerErrorSummary(error) } : {}),
      };
      if (this._proc === proc) this._proc = null;
      this._crashesSinceHealthy += 1;
      this._prewarmPromise = null;
      this.prewarmedAt = null;
      const failure = error || new Error(`MCP session exited (${code ?? signal ?? "unknown"})`);
      this._rejectPending(failure);
    };
    const failStream = (error) => {
      finish({ error });
      try { proc.kill?.("SIGTERM"); } catch { /* best effort */ }
    };
    proc.stdin?.on?.("error", failStream);
    proc.stdout?.on("data", (chunk) => {
      if (this._proc !== proc) return;
      this._handleStdout(chunk);
    });
    proc.stdout?.on?.("error", failStream);
    proc.stderr?.on("data", (chunk) => {
      try {
        if (isPowershellClixmlProgressNoise(chunk)) return;
        process.stderr.write(`[posse-mcp-owner:${this.id}] ${chunk}`);
      } catch {
        // diagnostics only
      }
    });
    proc.stderr?.on?.("error", failStream);
    proc.once("error", (error) => finish({ error }));
    proc.once("exit", (code, signal) => finish({ code, signal }));
    for (const frame of Array.isArray(spec.startupFrames) ? spec.startupFrames : []) {
      this._write(frame);
    }
  }

  request(message = {}) {
    this.ensureStarted();
    const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    const outbound = cloneJson(message);
    if (id == null) {
      this._write(outbound);
      return Promise.resolve(null);
    }
    const internalId = `owner-${this.id}-${++this._seq}`;
    outbound.id = internalId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(internalId);
        // A wedged child (blocked event loop, native deadlock) never answers,
        // so the caller's timeout is the only signal. Count consecutive
        // no-response timeouts; once the child looks wedged rather than slow,
        // force-kill it. Its exit drives finish() → rejects remaining pending,
        // and the next request respawns a fresh child via ensureStarted. Without
        // this the single shared gateway child stays wedged forever, costing
        // every subsequent request a full 120s timeout.
        this._consecutiveTimeouts += 1;
        if (this._consecutiveTimeouts >= MAX_CONSECUTIVE_REQUEST_TIMEOUTS) {
          try { this.stop({ force: true }); } catch { /* best effort; exit path handles pending */ }
        }
        reject(new Error(`MCP session request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this._pending.set(internalId, {
        originalId: id,
        resolve,
        reject,
        timer,
      });
      try {
        this._write(outbound);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(internalId);
        reject(err);
      }
    });
  }

  prewarm() {
    if (this._prewarmPromise) return this._prewarmPromise;
    this._prewarmPromise = (async () => {
      this.ensureStarted();
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "posse-mcp-owner", version: "1.0.0" },
        },
      });
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-tools",
        method: "tools/list",
        params: {},
      });
      this.prewarmedAt = Date.now();
      this.prewarmError = null;
      return true;
    })().catch((err) => {
      this.prewarmError = String(err?.message || err);
      this._prewarmPromise = null;
      throw err;
    });
    return this._prewarmPromise;
  }

  _write(message) {
    if (!this._proc?.stdin || this._proc.stdin.destroyed) {
      throw new Error("MCP session stdin is closed");
    }
    this._proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  _handleStdout(chunk) {
    this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, Buffer.from(chunk)]);
    this._stdoutBuffer = jsonlParseBuffer(
      this._stdoutBuffer,
      (message) => this._handleMessage(message),
      {
        onParseError: (err) => {
          try {
            process.stderr.write(`[posse-mcp-owner:${this.id}] failed to parse session stdout: ${err?.message || err}\n`);
          } catch {
            // diagnostics only
          }
        },
      },
    );
  }

  _handleMessage(message) {
    const id = String(message?.id ?? "");
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    // The child answered — it is alive and responsive, so clear any accumulated
    // timeout strikes and crash-loop history.
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    const restored = { ...message, id: entry.originalId };
    entry.resolve(restored);
  }

  stop({ force = false } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return false;
    if (process.platform === "win32") {
      try {
        const args = ["/pid", String(proc.pid), "/T"];
        if (force) args.push("/F");
        const killer = this._spawn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
        return true;
      } catch {
        // Fall through to the direct child kill.
      }
    }
    try {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  close({ force = false, timeoutMs = 10000 } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let procExited = false;
      let treeKillFinished = process.platform !== "win32";
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const maybeDone = () => {
        if (procExited && treeKillFinished) done(true);
      };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
        done(false);
      }, Math.max(100, Number(timeoutMs) || 10000));
      timer.unref?.();
      proc.once("exit", () => {
        procExited = true;
        maybeDone();
      });
      try {
        if (process.platform === "win32") {
          const args = ["/pid", String(proc.pid), "/T"];
          if (force) args.push("/F");
          const killer = this._spawn("taskkill", args, {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("close", (code) => {
            treeKillFinished = true;
            if (code !== 0 && !procExited) {
              try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            }
            maybeDone();
          });
          killer.once("error", () => {
            treeKillFinished = true;
            try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            maybeDone();
          });
        } else {
          proc.kill(force ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        done(false);
      }
    });
  }
}

export class PersistentMcpOwner {
  constructor({
    pipePath = null,
    token = randomToken(),
    spawnImpl = spawn,
  } = {}) {
    this.bootId = crypto.randomUUID();
    this.pipePath = pipePath || defaultPipePath(this.bootId);
    this.token = token;
    // Separate from the agent-facing MCP token. The trusted hot gateway uses
    // this private capability to authenticate its backend daemon session.
    this.nativeAuthToken = randomToken();
    this._spawn = spawnImpl;
    this._server = null;
    this._sessions = new Map();
    this._sessionIdsByTokenHash = new Map();
    this._gatewaySession = null;
    this._gatewayRetirements = new Set();
    this._startedAt = null;
    this._listenError = null;
  }

  endpoint() {
    return {
      transport: "pipe",
      pipePath: this.pipePath,
      token: this.token,
      bootId: this.bootId,
    };
  }

  nativeAuthBrokerCapability() {
    return {
      transport: "pipe",
      pipePath: this.pipePath,
      token: this.nativeAuthToken,
    };
  }

  ensureStarted() {
    if (this._server) return this.endpoint();
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        const status = err?.message === "request_body_too_large" ? 413 : 500;
        sendJson(res, status, { ok: false, error: status === 500 ? "internal" : err.message });
      });
    });
    this._server = server;
    server.on("error", (err) => {
      this._listenError = err;
      if (this._server === server) {
        this._server = null;
        this._startedAt = null;
      }
      try { server.close(); } catch { /* best effort */ }
    });
    server.listen(this.pipePath, () => {
      this._listenError = null;
      this._startedAt = Date.now();
    });
    server.unref?.();
    return this.endpoint();
  }

  registerSession({ token, bootConfig = {}, serverSpec = null, prewarm = true, agentOwned = false } = {}) {
    this.pruneExpiredSessions({ reason: "register_prune" });
    const claims = verifyMcpOAuthToken(token);
    const verified = true;
    claims.__verified = verified;
    if (!claims.__source) claims.__source = "local";
    const id = String(claims.jti || claims.sub || "");
    if (!id) throw new Error("MCP OAuth token is missing a session id");
    const signedBootConfig = bootConfigFromMcpOAuthClaims(claims);
    const resolvedBootConfig = agentOwned === true
      ? bindAgentAttachmentToSignedContract(signedBootConfig, bootConfig)
      : narrowBootConfigToSignedClaims(signedBootConfig, bootConfig);
    const sessionBootConfig = {
      ...resolvedBootConfig,
      mcpOAuth: {
        verified: true,
        tokenId: id,
        expiresAt: claims.exp || null,
        source: claims.__source || (verified ? "local" : "remote"),
      },
    };
    if (!hasSuiteToolAllowlist(sessionBootConfig)) {
      throw new Error("MCP OAuth token is missing suite-scoped toolAllowlist");
    }
    let session = this._sessions.get(id);
    if (session && !tokenEqual(session.token, token)) {
      throw new Error("MCP OAuth token session id collision");
    }
    if (!session) {
      session = new PersistentMcpSession({
        id,
        token,
        claims,
        bootConfig: sessionBootConfig,
        serverSpec: null,
        agentOwned,
        spawnImpl: this._spawn,
      });
      this._sessions.set(id, session);
    } else {
      session.update({ token, claims, bootConfig: sessionBootConfig, serverSpec: null, agentOwned });
    }
    this._ensureGatewaySession({ serverSpec, prewarm });
    this._sessionIdsByTokenHash.set(tokenHash(token), id);
    return { sessionId: id, ...this.endpoint() };
  }

  _rotateAgentSessionToken(session, now = Date.now()) {
    if (!session?.agentOwned) return null;
    const signedBootConfig = bootConfigFromMcpOAuthClaims(session.claims);
    const token = mintMcpOAuthTokenForBootConfig(signedBootConfig, {
      nowMs: now,
      expiresInSeconds: DEFAULT_MCP_OAUTH_TTL_SECONDS,
      jti: `agent-rotation-${crypto.randomUUID()}`,
    });
    const claims = verifyMcpOAuthToken(token, { nowMs: now });
    claims.__verified = true;
    claims.__source = session.claims?.__source || "local";
    this._sessionIdsByTokenHash.delete(tokenHash(session.token));
    session.update({ token, claims });
    this._sessionIdsByTokenHash.set(tokenHash(token), session.id);
    return token;
  }

  attachAgentSession({
    sessionId,
    token,
    expectedBootId = null,
    bootConfig = {},
    serverSpec = null,
  } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) {
      throw new Error("MCP owner boot changed before agent scope binding");
    }
    const id = String(sessionId || "");
    const session = id ? this._sessions.get(id) : null;
    if (!session) throw new Error("MCP agent session is not registered");
    if (!session.agentOwned) throw new Error("MCP session is not owned by an agent");
    if (!token || !tokenEqual(session.token, token)) throw new Error("MCP agent session token mismatch");
    if (session.isTokenExpired()) {
      const error = new Error("MCP agent session token is expired");
      error.code = "POSSE_MCP_AGENT_TOKEN_EXPIRED";
      throw error;
    }
    const signedBootConfig = bootConfigFromMcpOAuthClaims(session.claims);
    const boundBootConfig = {
      ...bindAgentAttachmentToSignedContract(signedBootConfig, bootConfig),
      mcpOAuth: {
        verified: true,
        tokenId: session.id,
        expiresAt: session.claims?.exp || null,
        source: session.claims?.__source || "local",
      },
    };
    if (!hasSuiteToolAllowlist(boundBootConfig)) {
      throw new Error("MCP agent contract is missing suite-scoped toolAllowlist");
    }
    if (serverSpec?.command) this._ensureGatewaySession({ serverSpec, prewarm: true });
    // Rotate only after every fallible validation/setup step. Otherwise an
    // attach error strands the caller with the old bearer and prevents its
    // cleanup path from unregistering the session.
    const rotatedToken = this._rotateAgentSessionToken(session);
    session.update({ bootConfig: boundBootConfig, serverSpec });
    return {
      bound: true,
      sessionId: id,
      jobId: boundBootConfig.jobId ?? null,
      workItemId: boundBootConfig.workItemId ?? null,
      ...(rotatedToken ? { token: rotatedToken } : {}),
    };
  }

  detachAgentSession({
    sessionId,
    token,
    expectedBootId = null,
    reason = "job_release",
  } = {}) {
    const result = this.attachAgentSession({
      sessionId,
      token,
      expectedBootId,
      bootConfig: {
        cwd: "",
        jobId: null,
        workItemId: null,
        attemptId: null,
        agentCallId: null,
        allowWrite: false,
        allowShell: false,
        allowTests: false,
        projectDbCapability: "none",
        projectDbWrite: false,
        allowImageGeneration: false,
        atlasAvailable: false,
      },
    });
    return {
      cleared: result.bound === true,
      sessionId: result.sessionId,
      reason,
      ...(result.token ? { token: result.token } : {}),
    };
  }

  _logAttachProof(session, kind, fields = {}) {
    try {
      appendRunTelemetry("diagnostics", {
        kind,
        ...attachTelemetryContext(session, this.bootId),
        ...fields,
      });
    } catch {
      // Telemetry must not affect MCP request handling.
    }
  }

  _removeSession(id, { reason = "released", context = null, telemetry = true } = {}) {
    const session = id ? this._sessions.get(id) : null;
    if (!session) return { released: false, reason: "not_found", sessionCount: this._sessions.size };
    const attachProof = session.snapshotAttachProof();
    this._sessions.delete(id);
    this._sessionIdsByTokenHash.delete(tokenHash(session.token));
    let gatewayReleased = false;
    let gatewayStopped = false;
    if (this._sessions.size === 0 && this._gatewaySession) {
      const gateway = this._gatewaySession;
      this._gatewaySession = null;
      gatewayReleased = true;
      // No signed sessions remain, so every process in this gateway tree is
      // run-owned and unreachable. Force the tree down on Windows; graceful
      // taskkill can leave the stdio helper alive and keep one-shot callers
      // (including provider-backed ML passes) from exiting.
      gatewayStopped = !!gateway._proc
        && gateway._proc.exitCode == null
        && !gateway._proc.killed;
      const retirement = gateway.close({ force: true });
      this._gatewayRetirements.add(retirement);
      retirement.finally(() => this._gatewayRetirements.delete(retirement));
    }
    if (telemetry) {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.unregister_session",
        component: "deterministic_mcp",
        outcome: "released",
        owner_boot_id: this.bootId,
        session_id: id,
        reason,
        session_count: this._sessions.size,
        gateway_released: gatewayReleased,
        gateway_stopped: gatewayStopped,
        registered_at: session.registeredAt || null,
        last_seen_at: session.lastSeenAt || null,
        expires_at: session.expiresAt || null,
        attach_proof: attachProof,
        context: context && typeof context === "object" ? context : null,
      });
    }
    return {
      released: true,
      sessionId: id,
      reason,
      sessionCount: this._sessions.size,
      gatewayReleased,
      gatewayStopped,
      attachProof,
    };
  }

  unregisterSession({ sessionId = null, token = null, expectedBootId = null, reason = "provider_exit", context = null } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) {
      return { released: false, reason: "owner_mismatch", sessionCount: this._sessions.size };
    }
    const id = String(sessionId || (token ? this._sessionIdsByTokenHash.get(tokenHash(token)) : "") || "");
    const session = id ? this._sessions.get(id) : null;
    if (!session) return { released: false, reason: "not_found", sessionCount: this._sessions.size };
    if (token && !tokenEqual(session.token, token)) {
      return { released: false, reason: "token_session_mismatch", sessionCount: this._sessions.size };
    }
    return this._removeSession(id, { reason, context, telemetry: true });
  }

  snapshotSessionAttachProof({ sessionId = null, expectedBootId = null } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) return null;
    const session = sessionId ? this._sessions.get(String(sessionId)) : null;
    return session ? session.snapshotAttachProof() : null;
  }

  pruneExpiredSessions({ now = Date.now(), reason = "expired" } = {}) {
    let released = 0;
    for (const session of [...this._sessions.values()]) {
      if (!session.isExpired(now)) continue;
      const result = this._removeSession(session.id, {
        reason,
        context: { expired: true },
        telemetry: true,
      });
      if (result.released) released += 1;
    }
    return { released, sessionCount: this._sessions.size };
  }

  _ensureGatewaySession({ serverSpec = null, prewarm = true } = {}) {
    if (!serverSpec?.command) return null;
    if (!this._gatewaySession) {
      this._gatewaySession = new PersistentMcpSession({
        id: "hot-gateway",
        token: this.token,
        claims: { __verified: true, __source: "owner" },
        bootConfig: { ownerHotGateway: true },
        serverSpec,
        spawnImpl: this._spawn,
      });
    } else if (!this._gatewaySession._proc || this._gatewaySession._proc.exitCode != null || this._gatewaySession._proc.killed) {
      this._gatewaySession.update({ serverSpec });
    }
    if (prewarm) {
      const startedAt = Date.now();
      this._gatewaySession.prewarm()
        .then(() => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.gateway_prewarm",
            component: "deterministic_mcp",
            outcome: "ok",
            owner_boot_id: this.bootId,
            duration_ms: Date.now() - startedAt,
            session_count: this._sessions.size,
            gateway_running: !!this._gatewaySession?._proc
              && this._gatewaySession._proc.exitCode == null
              && !this._gatewaySession._proc.killed,
            prewarmed_at: this._gatewaySession?.prewarmedAt || null,
          });
        })
        .catch((err) => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.gateway_prewarm",
            component: "deterministic_mcp",
            outcome: "error",
            owner_boot_id: this.bootId,
            duration_ms: Date.now() - startedAt,
            session_count: this._sessions.size,
            gateway_running: !!this._gatewaySession?._proc
              && this._gatewaySession._proc.exitCode == null
              && !this._gatewaySession._proc.killed,
            prewarm_error: this._gatewaySession?.prewarmError || null,
            last_exit: this._gatewaySession?.lastExit || null,
            error: ownerErrorSummary(err),
          });
        });
    }
    return this._gatewaySession;
  }

  status() {
    return {
      ok: true,
      bootId: this.bootId,
      pipePath: this.pipePath,
      startedAt: this._startedAt,
      uptimeMs: this._startedAt ? Math.max(0, Date.now() - this._startedAt) : 0,
      sessionCount: this._sessions.size,
      listenError: this._listenError ? String(this._listenError?.message || this._listenError) : null,
      gateway: this._gatewaySession ? {
        id: this._gatewaySession.id,
        startedAt: this._gatewaySession.startedAt,
        prewarmedAt: this._gatewaySession.prewarmedAt,
        prewarmError: this._gatewaySession.prewarmError,
        running: !!this._gatewaySession._proc && this._gatewaySession._proc.exitCode == null && !this._gatewaySession._proc.killed,
        lastExit: this._gatewaySession.lastExit,
      } : null,
      sessions: [...this._sessions.values()].map((session) => ({
        id: session.id,
        agentOwned: session.agentOwned,
        agentId: session.bootConfig?.agentId || null,
        jobId: session.bootConfig?.jobId ?? null,
        startedAt: this._gatewaySession?.startedAt || null,
        running: !!this._gatewaySession?._proc && this._gatewaySession._proc.exitCode == null && !this._gatewaySession._proc.killed,
        lastExit: session.lastExit,
        tokenVerified: session.tokenVerified,
        tokenSource: session.tokenSource,
        attachProof: session.snapshotAttachProof(),
      })),
    };
  }

  async close({ force = true } = {}) {
    await Promise.all([...this._sessions.values()].map((session) => session.close({ force })));
    await this._gatewaySession?.close?.({ force });
    await Promise.allSettled([...this._gatewayRetirements]);
    this._gatewaySession = null;
    this._gatewayRetirements.clear();
    this._sessions.clear();
    this._sessionIdsByTokenHash.clear();
    const server = this._server;
    this._server = null;
    if (server) {
      try { server.close(); } catch { /* best effort */ }
      try { server.closeIdleConnections?.(); } catch { /* best effort */ }
      try { server.closeAllConnections?.(); } catch { /* best effort */ }
      server.unref?.();
    }
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
  }

  async _handleRequest(req, res) {
    if (req.method === "GET" && req.url === "/v1/mcp/healthz") {
      if (!this._authorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, this.status());
      return;
    }
    if (req.method === "POST" && req.url === "/v1/capabilities/handshake") {
      if (!tokenEqual(bearerFrom(req), this.nativeAuthToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(req);
      const { pulseTokenManager } = await import("../../native/classes/PulseTokenManager.js");
      try {
        const handshakes = new NativeAuthHandshake({ pulseManager: pulseTokenManager });
        const grant = await handshakes.issue(body);
        sendJson(res, 200, { ok: true, grant });
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "POSSE_PULSE_ROUTE_DENIED" || code === "POSSE_PARENT_PULSE_DENIED") {
          sendJson(res, 403, { ok: false, error: "capability_denied", code });
        } else if (code === "POSSE_CAPABILITY_REQUEST_INVALID" || code === "POSSE_CAPABILITY_PROTOCOL_INVALID") {
          sendJson(res, 400, { ok: false, error: "invalid_capability_request", code });
        } else {
          sendJson(res, 503, { ok: false, error: "heartbeat_unavailable" });
        }
      }
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/mcp/rpc") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!this._authorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(req);
    const token = String(body?.token || "").trim();
    const message = body?.message && typeof body.message === "object" ? body.message : null;
    if (!token || !message) {
      sendJson(res, 400, { ok: false, error: "invalid_request" });
      return;
    }
    let id = this._sessionIdsByTokenHash.get(tokenHash(token)) || "";
    let session = id ? this._sessions.get(id) : null;
    let claims = null;
    if (session && !tokenEqual(session.token, token)) {
      sendJson(res, 403, { ok: false, error: "token_session_mismatch" });
      return;
    }
    if (session?.isTokenExpired()) {
      this._removeSession(session.id, {
        reason: "token_expired",
        context: { expired: true },
        telemetry: true,
      });
      sendJson(res, 401, { ok: false, error: "token_expired" });
      return;
    }
    if (!session) {
      try {
        claims = verifyMcpOAuthToken(token);
      } catch (err) {
        const code = String(err?.code || "invalid_token");
        sendJson(res, 401, {
          ok: false,
          error: code === "token_expired" ? "token_expired" : "invalid_token",
        });
        return;
      }
      const signedBoot = bootConfigFromMcpOAuthClaims(claims);
      if (claims.agent_id || signedBoot.scopeBindingMode === "dispatcher") {
        sendJson(res, 403, { ok: false, error: "unregistered_agent_gate" });
        return;
      }
      id = String(claims.jti || claims.sub || "");
      const bootConfig = {
        ...signedBoot,
        mcpOAuth: {
          verified: true,
          tokenId: id,
          expiresAt: claims.exp || null,
        },
      };
      if (!hasSuiteToolAllowlist(bootConfig)) {
        sendJson(res, 403, { ok: false, error: "missing_token_tool_allowlist" });
        return;
      }
      session = new PersistentMcpSession({
        id,
        token,
        claims: { ...claims, __verified: true, __source: "local" },
        bootConfig,
        serverSpec: null,
        agentOwned: false,
        spawnImpl: this._spawn,
      });
      this._sessions.set(id, session);
      this._sessionIdsByTokenHash.set(tokenHash(token), id);
    }
    session.touch();
    const method = String(message?.method || "").trim();
    const proofEvent = session.noteRequest(message);
    if (proofEvent === "initialize") {
      this._logAttachProof(session, "mcp.attach.initialize_seen", {
        method,
        request_count: session.attachProof.requestCount,
      });
    } else if (proofEvent === "tools/call") {
      this._logAttachProof(session, "mcp.attach.first_tool_call", {
        method,
        tool_name: session.attachProof.firstToolName || null,
        request_count: session.attachProof.requestCount,
      });
    }
    try {
      if (!this._gatewaySession) {
        throw new Error("MCP hot gateway has not been registered");
      }
      const policy = sessionToolPolicy(session);
      if (message.method === "tools/call") {
        const toolName = String(message?.params?.name || "");
        const toolArgs = message?.params?.arguments || {};
        if (!toolAllowedByPolicy(policy, toolName, message?.params?.arguments || {})) {
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: deniedToolCallMessage(message, toolName, policy),
          });
          return;
        }
        const requested = requestedToolPolicyName(toolName, toolArgs);
        if (requested.suite === "atlas") {
          const response = await this._executeAtlasToolCall({ message, session, toolName, toolArgs });
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: response,
          });
          return;
        }
      }
      let response = await this._gatewaySession.request(injectSessionContext(message, session));
      if (message.method === "tools/call" && mcpToolCallSuccess(response)) {
        void this._scheduleAtlasWriteRefresh({ message, session, response }).catch((err) => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.atlas_write_refresh",
            ...attachTelemetryContext(session, this.bootId),
            outcome: "error",
            duration_ms: 0,
            error: ownerErrorSummary(err),
          });
        });
      }
      if (message.method === "tools/list") {
        response = filterToolsListMessage(response, policy);
        const count = session.noteToolsList(response);
        this._logAttachProof(session, "mcp.attach.tools_list_seen", {
          method,
          tool_count: count,
          request_count: session.attachProof.requestCount,
        });
      }
      sendJson(res, 200, {
        ok: true,
        bootId: this.bootId,
        sessionId: id,
        message: response,
      });
    } catch (err) {
      session.noteOwnerError(err, method);
      this._logAttachProof(session, "mcp.attach.owner_error", {
        method,
        request_count: session.attachProof.requestCount,
        error: ownerErrorSummary(err),
      });
      sendJson(res, 500, {
        ok: false,
        bootId: this.bootId,
        sessionId: id,
        error: String(err?.message || err),
      });
    }
  }

  async _executeAtlasToolCall({ message, session, toolName, toolArgs }) {
    const startedAt = Date.now();
    const context = attachTelemetryContext(session, this.bootId);
    try {
      if (isAtlasFetchRefTool(toolName, toolArgs) || isAtlasCreateHashTool(toolName, toolArgs)) {
        const hashStoreTool = isAtlasCreateHashTool(toolName, toolArgs) ? createHashRefTool : fetchHashRefTool;
        let result = mcpToolTextPayload(hashStoreTool(toolArgs || {}, {
          context: hashRefToolContext(session),
        }));
        result = appendOwnerOperatorFeedbackSignal(result, session);
        recordOwnerToolObservation({ session, toolName, toolArgs, result });
        appendRunTelemetry("diagnostics", {
          kind: "mcp.owner.atlas_tool_call",
          ...context,
          outcome: result?.isError ? "tool_error" : "ok",
          tool_name: toolName,
          duration_ms: Date.now() - startedAt,
          executor: { via: "hash_ref_store" },
        });
        return mcpToolResultMessage(message, result);
      }
      const executor = getSharedAtlasToolExecutor();
      const executed = await executor.executeTool({
        toolName,
        args: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
        session: atlasExecutorSessionContext(session),
        source: {
          kind: "mcp_owner",
          ownerBootId: this.bootId,
          sessionId: session?.id || null,
        },
      });
      let result = executed?.result && typeof executed.result === "object"
        ? executed.result
        : mcpToolErrorPayload("ATLAS executor returned no MCP result");
      result = appendHashRefToMcpTextResult(result, toolName, toolArgs, session);
      result = appendOwnerAtlasPressureNudge(result, session, toolName, toolArgs);
      // ATLAS calls are the bulk of a retrieval-phase agent's tool traffic;
      // without the signal here (the gateway only appends it to native
      // tools), an MCP-transport agent deep in an ATLAS-only phase learns
      // about pending operator feedback late or never.
      result = appendOwnerOperatorFeedbackSignal(result, session);
      recordOwnerToolObservation({ session, toolName, toolArgs, result });
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_tool_call",
        ...context,
        outcome: result?.isError ? "tool_error" : "ok",
        tool_name: toolName,
        duration_ms: Date.now() - startedAt,
        executor: executed?.executor || null,
      });
      return mcpToolResultMessage(message, result);
    } catch (err) {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_tool_call",
        ...context,
        outcome: "error",
        tool_name: toolName,
        duration_ms: Date.now() - startedAt,
        error: ownerErrorSummary(err),
      });
      recordOwnerToolObservation({ session, toolName, toolArgs, error: err });
      return mcpToolResultMessage(
        message,
        mcpToolErrorPayload(String(err?.message || err || "ATLAS tool execution failed"), err),
      );
    }
  }

  async _scheduleAtlasWriteRefresh({ message, session, response }) {
    const toolName = String(message?.params?.name || "");
    const toolArgs = message?.params?.arguments || {};
    const requested = requestedToolPolicyName(toolName, toolArgs);
    if (requested.suite !== "tools") return null;
    if (requested.name !== "write_file" && requested.name !== "edit_file") return null;
    const startedAt = Date.now();
    const executor = getSharedAtlasToolExecutor();
    const scheduled = await executor.scheduleDeterministicWriteRefresh({
      toolName: requested.name,
      args: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
      session: atlasExecutorSessionContext(session),
      source: {
        kind: "mcp_owner_deterministic_write",
        ownerBootId: this.bootId,
        sessionId: session?.id || null,
        originalToolName: toolName,
      },
      result: response?.result || null,
    });
    appendRunTelemetry("diagnostics", {
      kind: "mcp.owner.atlas_write_refresh",
      ...attachTelemetryContext(session, this.bootId),
      outcome: scheduled ? (scheduled.ok === false ? "tool_error" : "ok") : "skipped",
      tool_name: requested.name,
      path: typeof toolArgs?.path === "string" ? capString(toolArgs.path, 240) : null,
      duration_ms: Date.now() - startedAt,
      scheduled: !!scheduled,
      detail: scheduled ? {
        action: scheduled.action || null,
        via: scheduled.via || null,
        branch: scheduled.branch || null,
        queue: scheduled.queue || null,
      } : null,
    });
    return scheduled;
  }

  _authorized(req) {
    return tokenEqual(bearerFrom(req), this.token);
  }
}

export const persistentMcpOwner = new PersistentMcpOwner();
