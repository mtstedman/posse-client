// Per-turn local tool gateway used by native provider adapters.
//
// The opaque lease is kept in this process and maps to an already-minted
// McpGate. Every call therefore crosses the same signed session, scope,
// budget, and tool-policy checks as a provider-owned MCP shim.

import crypto from "node:crypto";
import http from "node:http";
import { sortAgentToolDefinitions } from "../functions/agent-schema.js";

import {
  PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES,
  PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES,
  PROVIDER_TOOL_GATEWAY_PATH,
  PROVIDER_TOOL_GATEWAY_PROTOCOL,
} from "../../../catalog/binary.js";

const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 4 * 60 * 60 * 1_000;

function tokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload, maxBytes = PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES) {
  let encoded = Buffer.from(JSON.stringify(payload), "utf8");
  if (encoded.length > maxBytes) {
    status = 502;
    encoded = Buffer.from(JSON.stringify({
      ok: false,
      error: "tool_result_too_large",
    }), "utf8");
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  res.end(encoded);
}

async function readJsonBody(req) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("request_too_large"), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("request_too_large"), { statusCode: 413 });
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function validId(value, max = 160) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && /^[A-Za-z0-9._:/-]+$/.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function providerDispatchSurfaceDigest(toolDescriptors = []) {
  return crypto.createHash("sha256").update(canonicalJson(sortAgentToolDefinitions(toolDescriptors))).digest("hex");
}

function validateRequest(body, gateway) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid_request";
  const surfaceRequest = body.type === "surface.get";
  const allowed = new Set(surfaceRequest
    ? ["protocol", "type", "dispatchId", "surfaceDigest"]
    : ["protocol", "type", "dispatchId", "toolCallId", "surfaceDigest", "name", "arguments"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return "unknown_request_field";
  if (body.protocol !== PROVIDER_TOOL_GATEWAY_PROTOCOL
    || !["surface.get", "tool.call"].includes(body.type)) return "invalid_protocol";
  if (body.dispatchId !== gateway.dispatchId) return "dispatch_mismatch";
  if (body.surfaceDigest !== gateway.surfaceDigest) return "surface_mismatch";
  if (surfaceRequest) return null;
  if (!validId(body.toolCallId)) return "invalid_tool_call_id";
  if (!validId(body.name) || !gateway.issuedToolIds.has(body.name)) return "tool_not_issued";
  if (!body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) return "invalid_arguments";
  return null;
}

export class ProviderDispatchGateway {
  constructor({
    dispatchId,
    issuedToolIds,
    surfaceDigest,
    mcpGate,
    identity = {},
    role = null,
    provider = null,
    cwd = null,
    leaseTtlMs,
    maxResponseBytes = PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES,
  } = {}) {
    if (!validId(dispatchId, 120)) throw new Error("Provider dispatch gateway requires a valid dispatch id");
    if (!mcpGate || typeof mcpGate.callToolResult !== "function"
      || typeof mcpGate.rpc !== "function" || typeof mcpGate.assertAttached !== "function"
      || typeof mcpGate.assertCompatible !== "function") {
      throw new Error("Provider dispatch gateway requires an attached MCP gate");
    }
    mcpGate.assertCompatible({ role, providerName: provider });
    mcpGate.assertAttached({ ...identity, cwd });
    if (!mcpGate.binding) throw new Error("Provider dispatch gateway requires an active job binding");
    this.binding = mcpGate.binding;
    const ids = Array.isArray(issuedToolIds) ? issuedToolIds.map((value) => String(value)) : [];
    if (ids.length === 0 || ids.some((value) => !validId(value)) || new Set(ids).size !== ids.length) {
      throw new Error("Provider dispatch gateway requires unique issued tool ids");
    }
    if (surfaceDigest != null
      && (typeof surfaceDigest !== "string" || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(surfaceDigest))) {
      throw new Error("Provider dispatch gateway requires the issued tool surface digest");
    }
    this.dispatchId = dispatchId;
    this.issuedToolIds = new Set(ids.sort());
    this.surfaceDigest = surfaceDigest == null ? null : surfaceDigest.replace(/^sha256:/, "").toLowerCase();
    this.mcpGate = mcpGate;
    this.lease = crypto.randomBytes(32).toString("base64url");
    this.leaseTtlMs = Math.max(
      MIN_LEASE_TTL_MS,
      Math.min(MAX_LEASE_TTL_MS, Number(leaseTtlMs) || MIN_LEASE_TTL_MS),
    );
    this.expiresAt = null;
    this.maxResponseBytes = Math.max(1024, Math.min(
      PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES,
      Number(maxResponseBytes) || PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES,
    ));
    this.toolDescriptors = null;
    this.server = null;
    this.endpoint = null;
    this.active = new Set();
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error("Provider dispatch gateway is closed");
    this.#assertBinding();
    if (this.server) return this.capability();
    await this.prepareSurface();
    this.#assertBinding();
    this.expiresAt = Date.now() + this.leaseTtlMs;
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        if (!res.headersSent) {
          sendJson(res, Number(error?.statusCode) || 500, {
            ok: false,
            error: Number(error?.statusCode) ? error.message : "internal",
          }, this.maxResponseBytes);
        } else {
          res.destroy();
        }
      });
    });
    this.server = server;
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off("listening", listening);
        this.server = null;
        reject(error);
      };
      const listening = () => {
        server.off("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen(0, "127.0.0.1");
    });
    server.unref?.();
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Provider dispatch gateway did not bind a loopback port");
    }
    this.endpoint = `http://127.0.0.1:${address.port}${PROVIDER_TOOL_GATEWAY_PATH}`;
    return this.capability();
  }

  capability() {
    if (!this.endpoint || !this.server || !this.surfaceDigest || this.closed) {
      throw new Error("Provider dispatch gateway is not started");
    }
    return {
      transport: "http",
      endpoint: this.endpoint,
      lease: this.lease,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active) controller.abort(new Error("Provider dispatch gateway lease revoked"));
    this.active.clear();
    const server = this.server;
    this.server = null;
    this.lease = "";
    if (!server) return;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async #handle(req, res) {
    if (this.closed || this.expiresAt == null || Date.now() >= this.expiresAt) {
      sendJson(res, 401, { ok: false, error: "lease_expired" }, this.maxResponseBytes);
      return;
    }
    if (req.method !== "POST" || req.url !== PROVIDER_TOOL_GATEWAY_PATH) {
      sendJson(res, 404, { ok: false, error: "not_found" }, this.maxResponseBytes);
      return;
    }
    if (!tokenEqual(bearer(req), this.lease)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" }, this.maxResponseBytes);
      return;
    }
    const body = await readJsonBody(req);
    // Reading a streamed body yields. A lease checked at header arrival may
    // have expired or been revoked before the complete call is available.
    if (this.closed || this.expiresAt == null || Date.now() >= this.expiresAt) {
      sendJson(res, 401, { ok: false, error: "lease_expired" }, this.maxResponseBytes);
      return;
    }
    const invalid = validateRequest(body, this);
    if (invalid) {
      sendJson(res, 403, { ok: false, error: invalid }, this.maxResponseBytes);
      return;
    }
    try {
      this.#assertBinding();
    } catch {
      sendJson(res, 403, { ok: false, error: "attachment_changed" }, this.maxResponseBytes);
      return;
    }
    if (body.type === "surface.get") {
      sendJson(res, 200, {
        ok: true,
        protocol: PROVIDER_TOOL_GATEWAY_PROTOCOL,
        type: "surface.completed",
        dispatchId: this.dispatchId,
        surfaceDigest: this.surfaceDigest,
        tools: this.toolDescriptors,
      }, this.maxResponseBytes);
      return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    const disconnected = () => {
      if (!res.writableFinished) controller.abort(new Error("Provider gateway client disconnected"));
    };
    res.once("close", disconnected);
    try {
      const result = await this.mcpGate.callToolResult(body.name, body.arguments, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.closed) return;
      this.#assertBinding();
      sendJson(res, 200, {
        ok: true,
        protocol: PROVIDER_TOOL_GATEWAY_PROTOCOL,
        type: "tool.completed",
        dispatchId: this.dispatchId,
        toolCallId: body.toolCallId,
        result,
      }, this.maxResponseBytes);
    } catch (error) {
      if (controller.signal.aborted || this.closed) return;
      sendJson(res, 502, {
        ok: false,
        error: "tool_execution_failed",
        code: String(error?.code || "POSSE_TOOL_GATEWAY_FAILURE").slice(0, 100),
      }, this.maxResponseBytes);
    } finally {
      res.off("close", disconnected);
      this.active.delete(controller);
    }
  }

  async #loadIssuedToolDescriptors() {
    const descriptors = new Map();
    const cursors = new Set();
    let cursor = null;
    for (let page = 0; page < 16; page += 1) {
      this.#assertBinding();
      const message = await this.mcpGate.rpc({
        jsonrpc: "2.0",
        id: `provider-dispatch-surface-${page}`,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }, { preflight: true });
      this.#assertBinding();
      if (message?.error || !message?.result || !Array.isArray(message.result.tools)) {
        throw new Error("Provider dispatch gateway could not attest its MCP tool catalog");
      }
      for (const raw of message.result.tools) {
        const name = String(raw?.name || "");
        if (!this.issuedToolIds.has(name)) continue;
        if (descriptors.has(name)) {
          throw new Error(`Provider dispatch gateway received duplicate tool ${name}`);
        }
        const description = String(raw?.description || "");
        const inputSchema = raw?.inputSchema;
        if (description.length > 64 * 1024 || !inputSchema
          || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
          throw new Error(`Provider dispatch gateway received invalid schema for ${name}`);
        }
        descriptors.set(name, JSON.parse(JSON.stringify({ name, description, inputSchema })));
      }
      const next = message.result.nextCursor;
      if (next == null || next === "") break;
      if (typeof next !== "string" || next.length > 1024 || cursors.has(next)) {
        throw new Error("Provider dispatch gateway received an invalid tool cursor");
      }
      cursors.add(next);
      cursor = next;
      if (page === 15) throw new Error("Provider dispatch gateway tool catalog has too many pages");
    }
    const missing = [...this.issuedToolIds].filter((name) => !descriptors.has(name));
    if (missing.length > 0) {
      throw new Error(`Provider dispatch gateway is missing issued tool ${missing[0]}`);
    }
    const ordered = [...this.issuedToolIds].map((name) => descriptors.get(name));
    if (Buffer.byteLength(JSON.stringify(ordered), "utf8") > this.maxResponseBytes) {
      throw new Error("Provider dispatch gateway tool catalog is too large");
    }
    return Object.freeze(ordered);
  }

  async prepareToolDescriptors() {
    if (this.closed) throw new Error("Provider dispatch gateway is closed");
    this.#assertBinding();
    this.toolDescriptors ||= await this.#loadIssuedToolDescriptors();
    return JSON.parse(JSON.stringify(this.toolDescriptors));
  }

  #assertBinding() {
    this.mcpGate.assertAttached();
    // McpGate replaces its frozen binding on every attachment. Even another
    // attachment with identical IDs must not inherit an older dispatch lease.
    if (this.mcpGate.binding !== this.binding) {
      throw new Error("Provider dispatch gateway job attachment changed");
    }
  }

  async prepareSurface() {
    const descriptors = await this.prepareToolDescriptors();
    const observedDigest = providerDispatchSurfaceDigest(descriptors);
    if (this.surfaceDigest && observedDigest !== this.surfaceDigest) {
      throw new Error("Provider dispatch gateway tool catalog does not match its surface digest");
    }
    this.surfaceDigest = observedDigest;
    return { descriptors, digest: observedDigest };
  }
}
