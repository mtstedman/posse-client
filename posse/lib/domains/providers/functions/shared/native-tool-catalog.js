import { PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES } from "../../../../catalog/binary.js";

// The signed owner already narrowed this catalog to the attached job and role.
// Native adapters receive only these callable IDs, never action aliases.
export async function nativeIssuedToolIds(mcpGate) {
  if (!mcpGate?.rpc) throw new Error("Native provider requires the attached MCP gate");
  const names = new Set();
  const cursors = new Set();
  let cursor;
  let bytes = 0;
  do {
    const response = await mcpGate.rpc({ jsonrpc: "2.0", id: cursors.size + 1, method: "tools/list", params: cursor ? { cursor } : {} }, {
      timeoutMs: 35000, maxResponseBytes: PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES, preflight: true,
    });
    if (response?.error || !Array.isArray(response?.result?.tools)) throw new Error("Native provider tool catalog is unavailable");
    bytes += Buffer.byteLength(JSON.stringify(response.result));
    if (bytes > PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES) throw new Error("Native provider tool catalog exceeds its limit");
    for (const tool of response.result.tools) {
      if (typeof tool?.name !== "string" || names.has(tool.name)
        || (!tool.name.startsWith("tools.") && !tool.name.startsWith("atlas."))) throw new Error("Native provider received an invalid tool ID");
      names.add(tool.name);
    }
    cursor = response.result.nextCursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw new Error("Native provider tool catalog has invalid pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...names];
}
