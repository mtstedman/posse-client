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

  const contractedTools = Array.isArray(contract?.tools) ? contract.tools : [];
  const hasCanonicalTraversal = contractedTools.some((tool) => canonicalToolName(tool) === "traverse_ref")
    && definitionsByName.has(String(ToolCatalog.getSchema("traverse_ref", { role: contract?.role })?.name || ""));
  const tools = [];
  for (const tool of contractedTools) {
    const canonicalName = canonicalToolName(tool);
    if (!canonicalName) continue;
    // During the negotiated rollout, Remote advertises both names so older
    // clients retain fetch_ref. A client that knows traverse_ref exposes only
    // the canonical capability and keeps fetch_ref as an execution alias.
    if (canonicalName === "fetch_ref" && hasCanonicalTraversal) continue;
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

export function renderAtlasGuidance(contract = {}) {
  const tools = Array.isArray(contract?.tools) ? contract.tools : [];
  const hasAtlas = tools
    .some((tool) => String(tool?.suite || "").trim() === "atlas"
      || String(tool?.access || "").trim() === "atlas");
  if (!hasAtlas) return [];
  const lines = [
    "Atlas symbol tracing: To get new information about a symbol, choose a different Atlas tool suited to the unresolved fact.",
    "Atlas evidence refs: evidence_ref identifies content already visible in this context. Use it directly for citation, slicing, or handoff; do not call it for the same content.",
    "Atlas stored-result traversal: Call the issued stored-result traversal tool only with an explicit traversal_ref or next_traversal_ref for omitted content. Group concurrently ready traversal refs into one call; use one when it unlocks the next cursor. Each returned evidence_ref identifies the visible text, while next_traversal_ref alone advertises more missing content. Start a fresh producer call for a materially different scope.",
  ];
  const hasCodeWindow = tools.some((tool) => canonicalToolName(tool) === "code.window");
  const policy = contract?.atlasCodeWindowPolicy;
  if (hasCodeWindow && policy) {
    lines.push(
      `Atlas code window limit: code.window is capped at ${policy.maxWindowTokens} tokens and ${policy.maxWindowLines} lines per call for this run. Omit maxTokens to use that configured maximum; a smaller value narrows the result and a larger value is clamped.`,
    );
  }
  return lines;
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

  const lines = [];
  if (parallelAtlas.length + parallelDeterministic.length > 0) {
    lines.push("Turn batching: Issue every independent, ready read only tool call together in the same assistant response. Prefer one batched turn whenever the calls are already determined; a single-call turn fits a call whose target depends on the previous result. All read only tools issued this run, Atlas and standard, support turn batching.");
  }
  if (nativeBatch.length > 0) {
    lines.push("Schema batching: Tools with schema defined batch fields can combine items in one call within their declared limits.");
  }
  return lines;
}
