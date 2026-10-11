// Read the callable gateway catalog for the native Codex request. Rust owns MCP launch.
import { buildMcpAtlasSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { TOOL_REFS, formatToolReference } from "../../../../catalog/tool-references.js";

const SETUP_TIMEOUT_MS = 35_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function catalogError(message) {
  return Object.assign(new Error(message), { code: "POSSE_CODEX_CORE_DECLARATIONS_INVALID" });
}

export async function prepareCodexResearchMcpSurface(attachment, { mcpGate } = {}) {
  if (!mcpGate?.rpc) throw catalogError("Native Codex requires the attached MCP gate");
  const tools = [];
  const cursors = new Set();
  let cursor;
  let bytes = 0;
  do {
    const response = await mcpGate.rpc({
      jsonrpc: "2.0", id: cursors.size + 1, method: "tools/list",
      params: cursor ? { cursor } : {},
    }, { timeoutMs: SETUP_TIMEOUT_MS, maxResponseBytes: MAX_CATALOG_BYTES, preflight: true });
    if (response?.error || !Array.isArray(response?.result?.tools)) throw catalogError("MCP declarations unavailable during provider setup");
    bytes += Buffer.byteLength(JSON.stringify(response.result));
    if (bytes > MAX_CATALOG_BYTES) throw catalogError("MCP catalog exceeds transport limit");
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw catalogError("Invalid MCP catalog pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);

  const byName = new Map();
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || byName.has(tool.name)
      || (!tool.name.startsWith("tools.") && !tool.name.startsWith("atlas."))
      || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw catalogError("Invalid or duplicate MCP tool declaration");
    }
    byName.set(tool.name, tool);
  }
  for (const required of attachment.requiredTools || []) {
    const name = required.includes(".") ? required : `tools.${required}`;
    if (!byName.has(name)) throw catalogError(`Required MCP tool is absent: ${name}`);
  }
  const atlasNames = [...byName.keys()].filter(name => name.startsWith("atlas."));
  if (attachment.atlasTools.length > 0 && atlasNames.length === 0) throw catalogError("Issued Atlas callable declarations are absent");
  const queryName = formatToolReference(TOOL_REFS.atlas.query);
  const query = byName.get(queryName);
  if (attachment.atlasTools.length > 0 && query && atlasNames.length === 1) throw catalogError("Configured direct Atlas tools were replaced by a dispatcher");
  const issuedActions = new Set(attachment.atlasTools.map(name => name.replace(/^atlas\./, "")));
  for (const action of query?.inputSchema?.properties?.action?.enum || []) {
    if (action !== "workflow" && !issuedActions.has(action)) throw catalogError(`Atlas dispatcher advertises an unissued action: ${action}`);
  }
  const options = { providerName: "codex", serverName: attachment.serverKey, codexNestedMcp: false };
  const atlasContractTools = buildMcpAtlasSurfaceToolDescriptors(attachment.atlasTools, options)
    .flatMap(action => {
      const callableName = byName.has(action.mcpName) ? action.mcpName : byName.has(queryName) ? queryName : null;
      if (!callableName) return [];
      const [callable] = buildMcpAtlasSurfaceToolDescriptors([callableName], options);
      return [{ ...action, mcpName: callable.mcpName, providerSurfaceName: callable.providerSurfaceName, surfaceName: callable.surfaceName }];
    });
  return { declarations: [], atlasTools: atlasNames.map(name => name.slice("atlas.".length)), atlasContractTools, issuedToolIds: [...byName.keys()] };
}
