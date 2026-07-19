// @ts-check
//
// Pure JSON-RPC envelope + param helpers for the deterministic MCP gateway.
//
// These helpers operate only on their arguments (no module-level mutable
// state). The stdin/stdout protocol loop, sendMessage, and handleRequest remain
// in deterministic-mcp-server.js.

export function jsonRpcSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id, code, message, data = undefined) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function hiddenSessionFromParams(params = {}) {
  const record = /** @type {Record<string, any>} */ (params);
  const session = record && typeof record === "object" ? record._posseSession : null;
  if (!session || typeof session !== "object") return null;
  const boot = session.bootConfig && typeof session.bootConfig === "object" ? session.bootConfig : null;
  return boot ? { bootConfig: boot } : null;
}

export function stripHiddenSessionParam(params = {}) {
  if (!params || typeof params !== "object" || !Object.prototype.hasOwnProperty.call(params, "_posseSession")) {
    return params;
  }
  const out = { ...params };
  delete out._posseSession;
  return out;
}

const NATIVE_TOOL_EXECUTION_FAILURE_RE = /^(?:Exit code:\s*[1-9]\d*\b|Error:.*(?:\bfailed\b|\btimed out\b|\bwas killed\b|\bexited\b|\bcrashed\b|not found on PATH))/i;
const STRUCTURED_TOOL_FAILURE_RE = /\b(?:failed|failure|timed out|assertion|expected true|was killed|exited|crashed)\b/i;
const MCP_TOOL_REJECTION_CODE_RE = /^(?:invalid(?:_|$)|missing(?:_|$)|unknown_(?:action|tool)$|gateway_action_not_allowed$|runtime_disabled$|policy(?:_|$)|not_(?:allowed|permitted|indexed|found)$|unresolved(?:_|$)|.*_conflict$|.*_limit_(?:reached|exceeded)$)/i;
const MCP_TOOL_REJECTION_TEXT_RE = /\b(?:not allowed|not permitted|denied|rejected|blocked|invalid|required|unsupported|not indexed|unresolved|limit (?:reached|exceeded))\b/i;

function structuredToolOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) return "succeeded";
  return STRUCTURED_TOOL_FAILURE_RE.test(JSON.stringify(value)) ? "failed" : "rejected";
}

export function classifyNativeToolResult(text) {
  const value = String(text || "").trim();
  if (NATIVE_TOOL_EXECUTION_FAILURE_RE.test(value)) return "failed";
  if (/^(?:Error:|AUDIT ERROR:)/i.test(value)) return "rejected";
  if (value.startsWith("{")) {
    try {
      const structured = structuredToolOutcome(JSON.parse(value));
      if (structured) return structured;
    } catch { /* non-JSON tool output */ }
  }
  return "succeeded";
}

function mcpToolContentText(result) {
  return Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").filter(Boolean).join("\n")
    : "";
}

export function classifyMcpToolResult(result = null) {
  const text = mcpToolContentText(result);
  if (!result || result.isError !== true) return classifyNativeToolResult(text);
  const structured = result?.structuredContent?.error || result?._meta?.atlasError || {};
  const status = String(structured?.details?.status || structured?.status || "").trim().toLowerCase();
  const code = String(structured?.code || "").trim();
  if (["rejected", "denied", "blocked", "cancelled", "canceled"].includes(status)) return "rejected";
  if (MCP_TOOL_REJECTION_CODE_RE.test(code) || MCP_TOOL_REJECTION_TEXT_RE.test(text)) return "rejected";
  return "failed";
}

export function isSuccessfulNativeToolResult(text) {
  return classifyNativeToolResult(text) === "succeeded";
}
