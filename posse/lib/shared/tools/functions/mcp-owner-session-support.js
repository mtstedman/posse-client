// Stateless support for the persistent MCP owner's session lifecycle and
// JSONL child transport. Session/process state lives in PersistentMcpSession.

import crypto from "node:crypto";
import path from "node:path";
import { sanitizeAbsolutePathsInText } from "../../format/functions/display-paths.js";
import { toolSchemaTelemetry } from "./tool-schema-telemetry.js";

export const JSONL_STDOUT_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_FRAME_TOO_LARGE_CODE = "POSSE_MCP_FRAME_TOO_LARGE";

export { capString } from "./mcp-diagnostics.js";
export { errorSummary as ownerErrorSummary } from "./mcp-diagnostics.js";

export function createSubAgentRoutingState() {
  return {
    evidenceCalls: 0,
    targets: new Set(),
    selections: new Map(),
    delegatedTargets: new Set(),
    delegatedSelections: new Map(),
    dispatched: false,
    reminderIssued: false,
    materializedChars: 0,
    mutated: false,
  };
}

export function isPowershellClixmlProgressNoise(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  return /#<\s*CLIXML/i.test(text) && /Preparing modules for first use/i.test(text);
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export function stripToolsPrefix(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("tools.")) return raw.slice("tools.".length);
  if (raw.startsWith("tools_")) return raw.slice("tools_".length);
  return raw;
}

export function toolsListCount(message) {
  const tools = message?.result?.tools;
  return Array.isArray(tools) ? tools.length : null;
}

export function toolsListNames(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return [];
  return [...new Set(tools
    .map((tool) => String(tool?.name || "").trim())
    .filter(Boolean))].sort();
}

export function toolsListDigest(names = []) {
  if (!Array.isArray(names)) return null;
  return crypto.createHash("sha256").update(names.join("\n"), "utf8").digest("hex");
}

export function agentHandoffSchemaTelemetry(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return null;
  const schema = tools.find((tool) => stripToolsPrefix(tool?.name) === "agent_handoff");
  return schema ? toolSchemaTelemetry(schema) : null;
}

export function gatewayGateBindingKey(bootConfig = {}, sessionId = null) {
  const numericPart = (value) => Number(value) || null;
  return JSON.stringify([
    String(bootConfig?.mcpOAuth?.tokenId || sessionId || "").trim(),
    numericPart(bootConfig?.jobId),
    numericPart(bootConfig?.workItemId),
    numericPart(bootConfig?.attemptId),
    numericPart(bootConfig?.agentCallId),
    String(bootConfig?.role || "").trim(),
    path.resolve(String(bootConfig?.cwd || ".")),
    bootConfig?.atlasAvailable === true,
    bootConfig?.atlasGateEnabled === true,
  ]);
}

export function mcpToolErrorPayload(message, error = null, { cwd = null } = {}) {
  // Scrub here, not at call sites: the structured/_meta channels re-embed the
  // raw error, so a caller-side scrub of the message alone still leaks.
  const scrub = (value) => (cwd ? sanitizeAbsolutePathsInText(String(value), cwd) : String(value));
  const text = scrub(message || "ATLAS tool execution failed");
  const structured = error && typeof error === "object"
    ? {
        code: error.code ? String(error.code) : "atlas_tool_error",
        message: error.message ? scrub(error.message) : text,
        ...(error.details === undefined ? {} : {
          details: typeof error.details === "string" ? scrub(error.details) : error.details,
        }),
      }
    : null;
  const bearers = Array.isArray(structured?.details?.bearers)
    ? [...new Set(structured.details.bearers
      .map((bearer) => scrub(bearer).trim())
      .filter(Boolean))]
      .slice(0, 20)
    : [];
  const visibleDetails = bearers.length > 0
    ? `\nQualified bearers: ${bearers.map((bearer) => JSON.stringify(bearer)).join(", ")}`
    : "";
  return {
    content: [{ type: "text", text: `Error: ${text}${visibleDetails}` }],
    isError: true,
    ...(structured ? { structuredContent: { error: structured }, _meta: { atlasError: structured } } : {}),
  };
}

export function jsonlParseBuffer(buffer, onMessage, { onParseError = null, maxBufferBytes = JSONL_STDOUT_BUFFER_MAX_BYTES } = {}) {
  let next = buffer;
  while (next.length > 0) {
    const newlineIdx = next.indexOf(0x0a);
    if (newlineIdx < 0) break;
    const lineBytes = next.subarray(0, newlineIdx);
    next = next.subarray(newlineIdx + 1);
    if (lineBytes.length > maxBufferBytes) {
      const err = Object.assign(new Error(`MCP session stdout JSONL frame exceeded ${maxBufferBytes} bytes`), {
        code: MCP_FRAME_TOO_LARGE_CODE,
      });
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
    const err = Object.assign(new Error(`MCP session stdout JSONL buffer exceeded ${maxBufferBytes} bytes without newline`), {
      code: MCP_FRAME_TOO_LARGE_CODE,
      partialFrame: true,
    });
    if (typeof onParseError === "function") onParseError(err, "");
    return Buffer.alloc(0);
  }
  return next;
}
