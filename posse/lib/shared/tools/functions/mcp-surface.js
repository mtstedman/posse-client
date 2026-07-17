function normalizeProviderName(providerName = "") {
  return String(providerName || "").trim().toLowerCase();
}

const ATLAS_DISPLAY_ACTIONS = Object.freeze({
  "action.search": "action.search",
  "agent": "agent",
  "agent.feedback": "agent.feedback",
  "agent.feedback.query": "agent.feedback.query",
  "buffer.checkpoint": "buffer.checkpoint",
  "buffer.push": "buffer.push",
  "buffer.status": "buffer.status",
  "code": "code",
  "code.lens": "code.lens",
  "code.skeleton": "code.skeleton",
  "code.structure": "code.structure",
  "code.survey": "code.survey",
  "code.window": "code.window",
  "context": "context",
  "context.summary": "context.summary",
  "review.delta": "review.delta",
  "edit.plan": "edit.plan",
  // fetch_ref normalizes to "fetch.ref" (underscores become dots) but displays
  // under its canonical issued name.
  "fetch.ref": "fetch_ref",
  "create.ref": "create_ref",
  "file.read": "file.read",
  "file.write": "file.write",
  "index.refresh": "index.refresh",
  "info": "info",
  "manual": "manual",
  "memory.feedback": "memory.feedback",
  "memory.get": "memory.get",
  "memory.store": "memory.store",
  "memory.surface": "memory.surface",
  "policy.get": "policy.get",
  "policy.set": "policy.set",
  "review.risk": "review.risk",
  "review.analyze": "review.analyze",
  "query": "query",
  "repo": "repo",
  "repo.overview": "repo.overview",
  "repo.quality": "repo.quality",
  "repo.register": "repo.register",
  "repo.status": "repo.status",
  "runtime.execute": "runtime.execute",
  "runtime.queryoutput": "runtime.queryOutput",
  "scip.ingest": "scip.ingest",
  "slice.build": "slice.build",
  "slice.refresh": "slice.refresh",
  "slice.spillover.get": "slice.spillover.get",
  "symbol.card": "symbol.card",
  "symbol.search": "symbol.search",
  "symbol.overview": "symbol.overview",
  "tree.overview": "tree.overview",
  "tree.branch": "tree.branch",
  "tree.scope": "tree.scope",
  "tree.expand": "tree.expand",
  "usage.stats": "usage.stats",
  "workflow": "workflow",
});

const ATLAS_GATEWAY_DISPLAY_ACTIONS = new Set(["agent", "code", "query", "repo"]);

function stripMcpSurfacePrefix(toolName = "") {
  const raw = String(toolName || "").trim();
  if (!raw.toLowerCase().startsWith("mcp__")) return raw;
  const parts = raw.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : raw;
}

function stripRepeatedAtlasPrefix(value = "") {
  let action = String(value || "").trim();
  for (let i = 0; i < 4; i++) {
    const next = action
      .replace(/^atlas\s+/i, "")
      .replace(/^atlas[._-]/i, "");
    if (next === action) break;
    action = next.trim();
  }
  return action;
}

export function canonicalAtlasActionName(toolName = "") {
  const raw = stripRepeatedAtlasPrefix(stripMcpSurfacePrefix(toolName));
  if (!raw) return null;
  const normalized = stripRepeatedAtlasPrefix(raw)
    .replace(/\s+/g, ".")
    .replace(/_+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
  return ATLAS_DISPLAY_ACTIONS[normalized] || null;
}

function atlasInputActionName(input = {}) {
  if (!input || typeof input !== "object") return null;
  return canonicalAtlasActionName(input.targetAction)
    || canonicalAtlasActionName(input.gatewayAction)
    || canonicalAtlasActionName(input.action);
}

export function canonicalAtlasToolUseActionName(toolName = "", input = {}) {
  const toolAction = canonicalAtlasActionName(toolName);
  const inputAction = atlasInputActionName(input);
  if (inputAction && (!toolAction || ATLAS_GATEWAY_DISPLAY_ACTIONS.has(toolAction))) {
    return inputAction;
  }
  return toolAction || inputAction;
}

export function formatAtlasToolDisplayName(toolName = "", { prefix = true } = {}) {
  const action = canonicalAtlasActionName(toolName);
  if (!action) return "";
  return prefix ? `atlas ${action}` : action;
}

export function formatAtlasToolUseDisplayName(toolName = "", input = {}, { prefix = true } = {}) {
  const action = canonicalAtlasToolUseActionName(toolName, input);
  if (!action) return "";
  return prefix ? `atlas ${action}` : action;
}

export function renderMcpToolNameForProvider(toolName, { providerName = "generic" } = {}) {
  const name = String(toolName || "").trim();
  if (!name) return "";
  if (!["claude", "codex"].includes(normalizeProviderName(providerName))) return name;
  return name
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function renderMcpSurfaceName({ providerName = "generic", serverName, toolName } = {}) {
  const server = String(serverName || "").trim();
  const renderedTool = renderMcpToolNameForProvider(toolName, { providerName });
  if (!server || !renderedTool) return "";
  return `mcp__${server}__${renderedTool}`;
}

function buildMcpSurfaceDescriptor({
  canonicalName,
  mcpName,
  providerName = "generic",
  serverName,
  suite,
} = {}) {
  const canonical = String(canonicalName || "").trim();
  const mcp = String(mcpName || "").trim();
  const providerSurfaceName = renderMcpSurfaceName({ providerName, serverName, toolName: mcp });
  if (!canonical || !mcp || !providerSurfaceName) return null;
  return {
    // Compatibility fields used by existing ToolContract callers.
    name: canonical,
    surfaceName: providerSurfaceName,
    // Explicit projection fields: catalog -> MCP server -> provider wrapper.
    canonicalName: canonical,
    mcpName: mcp,
    providerSurfaceName,
    transport: "mcp",
    suite,
    serverName,
    providerName,
  };
}

function stripToolsPrefix(toolName = "") {
  const name = String(toolName || "").trim();
  return name.startsWith("tools.") ? name.slice("tools.".length) : name;
}

function renderToolsMcpToolName(toolName = "") {
  const name = String(toolName || "").trim();
  if (!name) return "";
  return name.startsWith("tools.") ? name : `tools.${name}`;
}

export function buildMcpSurfaceToolDescriptors(toolNames = [], { providerName = "generic", serverName } = {}) {
  return (Array.isArray(toolNames) ? toolNames : [])
    .map((toolName) => {
      const canonicalName = stripToolsPrefix(toolName);
      const mcpToolName = renderToolsMcpToolName(toolName);
      return buildMcpSurfaceDescriptor({
        canonicalName,
        mcpName: mcpToolName,
        providerName,
        serverName,
        suite: "tools",
      });
    })
    .filter(Boolean);
}

function stripAtlasPrefix(toolName = "") {
  const name = String(toolName || "").trim();
  return name.startsWith("atlas.") ? name.slice("atlas.".length) : name;
}

function renderAtlasMcpToolName(toolName = "") {
  const name = String(toolName || "").trim();
  if (!name) return "";
  return name.startsWith("atlas.") ? name : `atlas.${name}`;
}

export function buildMcpAtlasSurfaceToolDescriptors(toolNames = [], { providerName = "generic", serverName } = {}) {
  return (Array.isArray(toolNames) ? toolNames : [])
    .map((toolName) => {
      const canonicalName = stripAtlasPrefix(toolName);
      const mcpToolName = renderAtlasMcpToolName(toolName);
      return buildMcpSurfaceDescriptor({
        canonicalName,
        mcpName: mcpToolName,
        providerName,
        serverName,
        suite: "atlas",
      });
    })
    .filter(Boolean);
}

export function buildSurfaceNameMap(toolDescriptors = []) {
  const map = {};
  for (const descriptor of Array.isArray(toolDescriptors) ? toolDescriptors : []) {
    const name = String(descriptor?.canonicalName || descriptor?.name || "").trim();
    const surfaceName = String(descriptor?.providerSurfaceName || descriptor?.surfaceName || "").trim();
    if (name && surfaceName) map[name] = surfaceName;
  }
  return map;
}
