import { spawn } from "node:child_process";
import { buildMcpAtlasSurfaceToolDescriptors, renderMcpSurfaceName } from "../../../../shared/tools/functions/mcp-surface.js";
import { TOOL_REFS, formatToolReference } from "../../../../catalog/tool-references.js";

const SETUP_TIMEOUT_MS = 35000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function catalogError(message) {
  return Object.assign(new Error(message), { code: "POSSE_CODEX_CORE_DECLARATIONS_INVALID" });
}

async function listCatalog(rpc) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  let bytes = 0;
  do {
    const response = await rpc({ jsonrpc: "2.0", id: cursors.size + 2, method: "tools/list", params: cursor ? { cursor } : {} });
    if (response?.error || !Array.isArray(response?.result?.tools)) {
      throw catalogError("Core MCP declarations unavailable during provider setup");
    }
    bytes += Buffer.byteLength(JSON.stringify(response.result));
    if (bytes > MAX_CATALOG_BYTES) throw catalogError("Core MCP catalog exceeds transport limit");
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) {
      throw catalogError("Invalid MCP catalog pagination");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

// A compatibility attachment may have no in-process gate. Its short-lived shim
// still connects to the already-issued owner session, just like the CLI shims.
async function listViaShim(config) {
  const child = spawn(config.command, config.args || [], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env, ...config.providerChildEnv },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let pending = null;
  let buffer = "";
  let bytes = 0;
  let failure = null;
  const fail = (error) => { failure = error; pending?.reject(error); pending = null; };
  const closed = new Promise(resolve => child.once("close", resolve));
  child.on("error", () => fail(catalogError("Core MCP catalog shim failed to start")));
  child.on("exit", () => fail(catalogError("Core MCP catalog shim exited before setup completed")));
  child.stdin.on("error", () => fail(catalogError("Core MCP catalog shim input closed")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_CATALOG_BYTES) { fail(catalogError("Core MCP catalog exceeds transport limit")); return; }
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { fail(catalogError("Invalid core MCP catalog frame")); return; }
      if (pending && message.id === pending.id) {
        const current = pending; pending = null; current.resolve(message);
      }
    }
  });
  const rpc = message => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    pending = { id: message.id, resolve, reject };
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
  const timer = setTimeout(() => fail(catalogError("Core MCP catalog setup timed out")), SETUP_TIMEOUT_MS);
  try {
    const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "posse-core-declarations", version: "1" },
    } });
    if (initialized?.error || !initialized?.result) throw catalogError("Core MCP catalog initialization failed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await listCatalog(rpc);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await closed;
    clearTimeout(killTimer);
  }
}

export async function prepareCodexResearchMcpSurface(attachment, { mcpGate = null } = {}) {
  if (!attachment.codexCodeMode && !attachment.codexNativeBatching) return { declarations: [], atlasTools: attachment.atlasTools || [] };
  const tools = mcpGate?.rpc
    ? await listCatalog(message => mcpGate.rpc(message, { timeoutMs: SETUP_TIMEOUT_MS, maxResponseBytes: MAX_CATALOG_BYTES, preflight: true }))
    : await listViaShim(attachment.serverConfig);
  const byName = new Map();
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || byName.has(tool.name)) throw catalogError("Invalid or duplicate core MCP tool name");
    byName.set(tool.name, tool);
  }
  for (const required of [...attachment.requiredTools, ...attachment.directTools]) {
    const name = required.includes(".") ? required : `tools.${required}`;
    if (!byName.has(name)) throw catalogError(`Required MCP tool is absent: ${name}`);
  }
  // tools/list is already narrowed by the signed owner session. Atlas may fold
  // many issued actions into one dispatcher; action IDs are not callable IDs.
  const atlasNames = [...byName.keys()].filter(name => name.startsWith("atlas."));
  if (attachment.atlasTools.length > 0 && atlasNames.length === 0) {
    throw catalogError("Issued Atlas callable declarations are absent");
  }
  const reads = attachment.codexNativeBatching
    ? attachment.tools.filter(name => !attachment.directTools.includes(name) && !attachment.lazyTools.includes(name))
    : attachment.nestedTools;
  const names = [...reads.map(name => `tools.${name}`), ...atlasNames];
  const declarations = names.filter(name => byName.has(name)).map(name => {
    const tool = byName.get(name);
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw catalogError(`Core MCP tool schema is absent: ${name}`);
    }
    return {
      name: renderMcpSurfaceName({ providerName: "codex", serverName: attachment.serverKey, toolName: name, codexNestedMcp: attachment.codexCodeMode }),
      description: String(tool.description || ""),
      parameters: tool.inputSchema,
    };
  });
  // Authorization and policy use issued action identities; MCP declarations
  // use callable identities. A consolidated query must not replace the former
  // or the contract's issued-surface filter silently removes Atlas guidance.
  const options = { providerName: "codex", serverName: attachment.serverKey, codexNestedMcp: attachment.codexCodeMode };
  const queryName = formatToolReference(TOOL_REFS.atlas.query);
  const atlasContractTools = buildMcpAtlasSurfaceToolDescriptors(attachment.atlasTools, options)
    .flatMap(action => {
      const callableName = byName.has(action.mcpName) ? action.mcpName : byName.has(queryName) ? queryName : null;
      if (!callableName) return [];
      const [callable] = buildMcpAtlasSurfaceToolDescriptors([callableName], options);
      return [{ ...action, mcpName: callable.mcpName, providerSurfaceName: callable.providerSurfaceName, surfaceName: callable.surfaceName }];
    });
  return { declarations, atlasTools: atlasNames.map(name => name.slice("atlas.".length)), atlasContractTools };
}
