// @ts-check

import http from "node:http";

function freezeJson(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value || {})));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function gateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rpcToolName(name) {
  const raw = String(name || "").trim();
  if (!raw) throw gateError("POSSE_MCP_GATE_TOOL_INVALID", "MCP gate tool name is required");
  if (raw.startsWith("tools.") || raw.startsWith("atlas.")) return raw;
  if (raw.startsWith("tools_")) return `tools.${raw.slice("tools_".length)}`;
  if (raw.startsWith("atlas_")) return `atlas.${raw.slice("atlas_".length).replace(/_/g, ".")}`;
  return raw.includes(".") ? `atlas.${raw}` : `tools.${raw}`;
}

function resultText(message = {}) {
  if (message?.error) {
    const detail = message.error?.message || JSON.stringify(message.error);
    throw gateError("POSSE_MCP_GATE_RPC_ERROR", `MCP tool call failed: ${detail}`);
  }
  const result = message?.result;
  if (result?.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content.map((entry) => entry?.text || "").filter(Boolean).join("\n")
      : "";
    throw gateError("POSSE_MCP_GATE_TOOL_ERROR", text || "MCP tool call returned an error");
  }
  if (Array.isArray(result?.content)) {
    const text = result.content
      .map((entry) => entry?.text ?? entry?.data ?? "")
      .filter((entry) => entry !== "")
      .join("\n");
    if (text) return text;
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

/**
 * Immutable role/tool contract attached to one provider agent for its entire
 * lifetime. The replaceable owner-side attachment carries Job identity, never
 * file authority, and never changes this gate's signed OAuth bearer.
 */
export class McpGate {
  constructor({
    id,
    role,
    providerName,
    token,
    claims,
    contractBootConfig,
    remoteToolSurface = null,
    owner,
    ownerSession,
  } = {}) {
    if (!id) throw new TypeError("McpGate requires an id");
    if (!role) throw new TypeError("McpGate requires a role");
    if (!token) throw new TypeError("McpGate requires an OAuth token");
    if (!owner || typeof owner.attachAgentSession !== "function") {
      throw new TypeError("McpGate requires an MCP owner with Agent attachment support");
    }
    if (!ownerSession?.sessionId) throw new TypeError("McpGate requires a registered owner session");

    const gateId = String(id);
    const gateRole = String(role).trim().toLowerCase();
    const gateProvider = String(providerName || "").trim().toLowerCase();
    const frozenClaims = freezeJson(claims);
    const frozenContract = freezeJson(contractBootConfig);
    const frozenSurface = remoteToolSurface ? freezeJson(remoteToolSurface) : null;
    const frozenOwnerSession = Object.freeze({
      sessionId: ownerSession.sessionId,
      ownerBootId: ownerSession.bootId || ownerSession.ownerBootId || null,
      ownerTransport: ownerSession.transport || ownerSession.ownerTransport || null,
      agentOwned: true,
      gateId,
    });
    Object.defineProperties(this, {
      id: { value: gateId, enumerable: true, configurable: false, writable: false },
      role: { value: gateRole, enumerable: true, configurable: false, writable: false },
      providerName: { value: gateProvider, enumerable: true, configurable: false, writable: false },
      claims: { value: frozenClaims, enumerable: true, configurable: false, writable: false },
      contractBootConfig: { value: frozenContract, enumerable: true, configurable: false, writable: false },
      remoteToolSurface: { value: frozenSurface, enumerable: true, configurable: false, writable: false },
      owner: { value: owner, enumerable: false, configurable: false, writable: false },
      ownerSession: { value: frozenOwnerSession, enumerable: true, configurable: false, writable: false },
      token: { value: String(token), enumerable: false, configurable: false, writable: false },
    });
    this.disposed = false;
    this.binding = null;
  }

  assertCompatible({ role, providerName = null } = {}) {
    const requestedRole = String(role || "").trim().toLowerCase();
    const requestedProvider = String(providerName || "").trim().toLowerCase();
    if (requestedRole && requestedRole !== this.role) {
      throw gateError("POSSE_MCP_GATE_ROLE_MISMATCH", `MCP gate role ${this.role} cannot attach to ${requestedRole}`);
    }
    if (requestedProvider && this.providerName && requestedProvider !== this.providerName) {
      throw gateError(
        "POSSE_MCP_GATE_PROVIDER_MISMATCH",
        `MCP gate provider ${this.providerName} cannot attach to ${requestedProvider}`,
      );
    }
    if (this.disposed) throw gateError("POSSE_MCP_GATE_DISPOSED", "MCP gate has been disposed");
    return true;
  }

  attachJob(attachment = {}) {
    this.assertCompatible({ role: attachment.role, providerName: attachment.providerName });
    const result = this.owner.attachAgentSession({
      sessionId: this.ownerSession.sessionId,
      token: this.token,
      expectedBootId: this.ownerSession.ownerBootId,
      bootConfig: attachment,
    });
    this.binding = freezeJson({
      jobId: attachment.jobId ?? null,
      workItemId: attachment.workItemId ?? null,
      attemptId: attachment.attemptId ?? null,
      agentCallId: attachment.agentCallId ?? null,
      cwd: attachment.cwd || "",
    });
    return result;
  }

  assertAttached({ jobId = null, workItemId = null, agentCallId = null } = {}) {
    if (this.disposed) throw gateError("POSSE_MCP_GATE_DISPOSED", "MCP gate has been disposed");
    if (!this.binding) throw gateError("POSSE_MCP_GATE_ATTACHMENT_MISSING", "MCP gate has no active Job attachment");
    for (const [label, expected] of Object.entries({ jobId, workItemId, agentCallId })) {
      if (expected != null && Number(this.binding[label]) !== Number(expected)) {
        throw gateError(
          "POSSE_MCP_GATE_ATTACHMENT_MISMATCH",
          `MCP gate ${label} does not match the dispatched Agent attachment`,
        );
      }
    }
    return true;
  }

  detachJob({ reason = "job_release" } = {}) {
    if (this.disposed) return { cleared: false, reason: "disposed" };
    const result = this.owner.detachAgentSession({
      sessionId: this.ownerSession.sessionId,
      token: this.token,
      expectedBootId: this.ownerSession.ownerBootId,
      reason,
    });
    this.binding = null;
    return result;
  }

  async rpc(message = {}) {
    if (this.disposed) throw gateError("POSSE_MCP_GATE_DISPOSED", "MCP gate has been disposed");
    if (!this.binding) throw gateError("POSSE_MCP_GATE_ATTACHMENT_MISSING", "MCP gate has no active Job attachment");
    const endpoint = this.owner.endpoint();
    const body = JSON.stringify({ token: this.token, message });
    const payload = await new Promise((resolve, reject) => {
      const request = http.request({
        method: "POST",
        socketPath: endpoint.pipePath,
        path: "/v1/mcp/rpc",
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            if (response.statusCode !== 200 || parsed?.ok !== true) {
              reject(gateError(
                "POSSE_MCP_GATE_OWNER_REJECTED",
                `MCP owner rejected agent gate request (${response.statusCode || "unknown"}): ${parsed?.error || "unknown"}`,
              ));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", reject);
      request.end(body);
    });
    return payload?.message || null;
  }

  async callTool(name, args = {}) {
    const message = await this.rpc({
      jsonrpc: "2.0",
      id: `agent-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method: "tools/call",
      params: {
        name: rpcToolName(name),
        arguments: args && typeof args === "object" ? args : {},
      },
    });
    return resultText(message);
  }

  dispose({ reason = "agent_disposed" } = {}) {
    if (this.disposed) return { released: false, reason: "already_disposed" };
    this.disposed = true;
    this.binding = null;
    return this.owner.unregisterSession({
      sessionId: this.ownerSession.sessionId,
      token: this.token,
      expectedBootId: this.ownerSession.ownerBootId,
      reason,
      context: { gateId: this.id, role: this.role, provider: this.providerName },
    });
  }
}
