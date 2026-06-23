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
  verifyMcpOAuthToken,
} from "../../domains/integrations/functions/deterministic-mcp/oauth-token.js";
import { getSharedAtlasToolExecutor } from "../../domains/atlas/functions/v2/tools/executor.js";
import { recordToolUseObservations } from "../../domains/observability/functions/observations.js";
import { appendRunTelemetry } from "../../shared/telemetry/functions/run-telemetry.js";

const MAX_OWNER_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const JSONL_STDOUT_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;
const SESSION_ORPHAN_TTL_MS = 8 * 60 * 60 * 1000;

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeIdPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function defaultPipePath(bootId) {
  const suffix = `${process.pid}-${safeIdPart(bootId)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\posse-mcp-owner-${suffix}`;
  return path.join(os.tmpdir(), `posse-mcp-owner-${suffix}.sock`);
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
  return stripAtlasPrefix(name).replace(/^atlas_/, "").replace(/_/g, ".").trim();
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
    return !!(
      requested.name
      && (
        allowed.has(requested.name)
        || (requested.nested && allowed.has(requested.nested))
      )
    );
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
    spawnImpl = spawn,
  } = {}) {
    this.id = id;
    this.token = token;
    this.claims = claims || {};
    this.bootConfig = bootConfig || {};
    this.serverSpec = serverSpec || null;
    this._spawn = spawnImpl;
    this._proc = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._pending = new Map();
    this._seq = 0;
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

  update({ token, claims, bootConfig, serverSpec } = {}) {
    if (token) this.token = token;
    if (claims) {
      this.claims = claims;
      this.tokenVerified = !!claims.__verified;
      this.tokenSource = claims.__source || (this.tokenVerified ? "local" : "registered");
      this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : this.expiresAt;
    }
    if (bootConfig) this.bootConfig = bootConfig;
    if (serverSpec) this.serverSpec = serverSpec;
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
    const idleMs = now - (this.lastSeenAt || this.registeredAt || now);
    if (this.expiresAt && now > this.expiresAt + SESSION_TOKEN_EXPIRY_GRACE_MS) {
      return idleMs > SESSION_TOKEN_EXPIRY_GRACE_MS;
    }
    return idleMs > SESSION_ORPHAN_TTL_MS;
  }

  ensureStarted() {
    if (this._proc && this._proc.exitCode == null && !this._proc.killed) return;
    if (!this.serverSpec?.command) {
      throw new Error("MCP session has no registered server spec");
    }
    const spec = this.serverSpec;
    this._proc = this._spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      env: spec.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.startedAt = Date.now();
    this.lastExit = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._proc.stdout?.on("data", (chunk) => this._handleStdout(chunk));
    this._proc.stderr?.on("data", (chunk) => {
      try {
        if (isPowershellClixmlProgressNoise(chunk)) return;
        process.stderr.write(`[posse-mcp-owner:${this.id}] ${chunk}`);
      } catch {
        // diagnostics only
      }
    });
    this._proc.on("exit", (code, signal) => {
      this.lastExit = { at: Date.now(), code, signal };
      this._proc = null;
      for (const entry of this._pending.values()) {
        entry.reject(new Error(`MCP session exited (${code ?? signal ?? "unknown"})`));
      }
      this._pending.clear();
    });
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
    const restored = { ...message, id: entry.originalId };
    entry.resolve(restored);
  }

  stop({ force = false } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return false;
    try {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  close({ force = false, timeoutMs = 2000 } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
        done(false);
      }, Math.max(100, Number(timeoutMs) || 2000));
      timer.unref?.();
      proc.once("exit", () => done(true));
      try {
        proc.kill(force ? "SIGKILL" : "SIGTERM");
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
    this._spawn = spawnImpl;
    this._server = null;
    this._sessions = new Map();
    this._sessionIdsByTokenHash = new Map();
    this._gatewaySession = null;
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

  ensureStarted() {
    if (this._server) return this.endpoint();
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        const status = err?.message === "request_body_too_large" ? 413 : 500;
        sendJson(res, status, { ok: false, error: status === 500 ? "internal" : err.message });
      });
    });
    this._server.on("error", (err) => {
      this._listenError = err;
    });
    this._server.listen(this.pipePath, () => {
      this._startedAt = Date.now();
    });
    this._server.unref?.();
    return this.endpoint();
  }

  registerSession({ token, bootConfig = {}, serverSpec = null, prewarm = true } = {}) {
    this.pruneExpiredSessions({ reason: "register_prune" });
    const claims = verifyMcpOAuthToken(token);
    const verified = true;
    claims.__verified = verified;
    if (!claims.__source) claims.__source = "local";
    const id = String(claims.jti || claims.sub || "");
    if (!id) throw new Error("MCP OAuth token is missing a session id");
    const sessionBootConfig = {
      ...bootConfigFromMcpOAuthClaims(claims),
      ...bootConfig,
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
        spawnImpl: this._spawn,
      });
      this._sessions.set(id, session);
    } else {
      session.update({ token, claims, bootConfig: sessionBootConfig, serverSpec: null });
    }
    this._ensureGatewaySession({ serverSpec, prewarm });
    this._sessionIdsByTokenHash.set(tokenHash(token), id);
    return { sessionId: id, ...this.endpoint() };
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
    if (telemetry) {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.unregister_session",
        component: "deterministic_mcp",
        outcome: "released",
        owner_boot_id: this.bootId,
        session_id: id,
        reason,
        session_count: this._sessions.size,
        registered_at: session.registeredAt || null,
        last_seen_at: session.lastSeenAt || null,
        expires_at: session.expiresAt || null,
        attach_proof: attachProof,
        context: context && typeof context === "object" ? context : null,
      });
    }
    return { released: true, sessionId: id, reason, sessionCount: this._sessions.size, attachProof };
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
    this._gatewaySession = null;
    this._sessions.clear();
    this._sessionIdsByTokenHash.clear();
    const server = this._server;
    this._server = null;
    if (server) {
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
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
    if (!session) {
      claims = verifyMcpOAuthToken(token);
      id = String(claims.jti || claims.sub || "");
      const bootConfig = {
        ...bootConfigFromMcpOAuthClaims(claims),
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
      const result = executed?.result && typeof executed.result === "object"
        ? executed.result
        : mcpToolErrorPayload("ATLAS executor returned no MCP result");
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
