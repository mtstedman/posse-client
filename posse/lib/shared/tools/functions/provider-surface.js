import { ToolCatalog } from "../classes/ToolCatalog.js";

function canonicalToolName(tool = {}) {
  return String(tool?.canonicalName || tool?.name || "").trim();
}

function functionDefinitionName(definition = {}) {
  return String(definition?.function?.name || definition?.name || "").trim();
}

export function projectFunctionToolSurface(contract = {}, toolDefinitions = []) {
  const definitionsByName = new Map();
  for (const definition of Array.isArray(toolDefinitions) ? toolDefinitions : []) {
    const name = functionDefinitionName(definition);
    if (name && !definitionsByName.has(name)) definitionsByName.set(name, definition);
  }

  const tools = [];
  for (const tool of Array.isArray(contract?.tools) ? contract.tools : []) {
    const canonicalName = canonicalToolName(tool);
    if (!canonicalName) continue;
    const schemaName = String(ToolCatalog.getSchema(canonicalName, {
      role: contract?.role,
      compactCompletion: contract?.agentHandoffCompactV1 === true,
      compactV3: contract?.agentHandoffCompactV3 === true,
    })?.name || "").trim();
    const providerSurfaceName = [schemaName, canonicalName]
      .find((name) => name && definitionsByName.has(name));
    if (!providerSurfaceName) continue;
    tools.push({
      ...tool,
      name: canonicalName,
      canonicalName,
      providerSurfaceName,
      surfaceName: providerSurfaceName,
      transport: "function",
      suite: String(tool?.suite || "").trim()
        || (String(tool?.access || "").trim() === "atlas" ? "atlas" : "tools"),
      providerName: String(contract?.provider || tool?.providerName || "generic").trim(),
    });
  }

  const shellAllowed = tools.some((tool) => canonicalToolName(tool) === "bash");
  return {
    ...contract,
    tools,
    shellAllowed,
    shellMode: shellAllowed ? (contract?.shellMode || "guarded-exception") : "none",
  };
}
