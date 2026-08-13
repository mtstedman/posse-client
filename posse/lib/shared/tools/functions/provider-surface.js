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

function pushUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

export function renderToolBatchingGuidance(contract = {}, toolRenderer) {
  if (!toolRenderer || typeof toolRenderer.tryRenderIssued !== "function") return [];

  const parallelAtlas = [];
  const parallelDeterministic = [];
  const nativeBatch = [];
  for (const tool of Array.isArray(contract?.tools) ? contract.tools : []) {
    const rendered = toolRenderer.tryRenderIssued(tool);
    if (!rendered) continue;
    if (tool?.batching === "parallel-read") {
      const destination = String(tool?.suite || "").trim() === "atlas"
        || String(tool?.access || "").trim() === "atlas"
        ? parallelAtlas
        : parallelDeterministic;
      pushUnique(destination, rendered);
    } else if (tool?.batching === "native-batch") {
      pushUnique(nativeBatch, rendered);
    }
  }

  if (parallelAtlas.length + parallelDeterministic.length + nativeBatch.length === 0) return [];

  const lines = [
    "- Parallel tool-call rule: when two or more independent calls are ready, emit every ready call together in one assistant response before awaiting results. This applies to every role, not only research.",
  ];
  if (parallelAtlas.length > 0) {
    lines.push(`- Parallel Atlas reads issued this run: ${parallelAtlas.join(", ")}.`);
  }
  if (parallelDeterministic.length > 0) {
    lines.push(`- Parallel deterministic/MCP repository reads issued this run: ${parallelDeterministic.join(", ")}.`);
  }
  if (nativeBatch.length > 0) {
    lines.push(`- Schema-native batch tools issued this run: ${nativeBatch.join(", ")}. Combine ready items in one call only through array fields present in that tool's schema.`);
  }
  lines.push("- For parallel-read tools, batching means multiple top-level tool calls in the same response; do not invent an items field. Serialize only when one result is required to choose or parameterize the next call, or when a stateful, mutating, or terminal action has no schema-defined atomic batch.");
  return lines;
}
