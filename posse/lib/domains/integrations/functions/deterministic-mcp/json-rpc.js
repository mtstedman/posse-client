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
  const session = params && typeof params === "object" ? params._posseSession : null;
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

export function isSuccessfulNativeToolResult(text) {
  return !/^(?:Error:|AUDIT ERROR:)/i.test(String(text || ""));
}
