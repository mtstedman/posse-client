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

export function renderAtlasGuidance(contract = {}) {
  const tools = Array.isArray(contract?.tools) ? contract.tools : [];
  const hasAtlas = tools
    .some((tool) => String(tool?.suite || "").trim() === "atlas"
      || String(tool?.access || "").trim() === "atlas");
  if (!hasAtlas) return [];
  const issued = new Set(tools.map((tool) => canonicalToolName(tool)));
  const lines = [
    "Atlas symbol tracing: Choose retrieval by the unresolved fact and the location already known, not by a need to switch tools. Use search or survey to locate unknown targets; use lens for scattered details and callers/structure only for a needed relationship, selecting the relevant relation kinds instead of all kinds.",
    "Atlas evidence refs: evidence_ref identifies content already visible in this context. Use it directly for citation, slicing, or handoff; do not call it for the same content.",
    "Atlas stored-result traversal: Call the issued stored-result traversal tool only with an explicit traversal_ref for omitted content. Group concurrently ready traversal refs into one call; use one when it unlocks the next cursor. Omit limit for normal source traversal: limit measures characters per ref, not source lines. A successful call promotes that same ref to evidence_ref, and each returned evidence_ref identifies the visible text. A different traversal_ref alone advertises more missing content. Copy opaque refs as issued and do not calculate offsets. Start a fresh producer call for a materially different scope.",
  ];
  const hasCodeWindow = tools.some((tool) => canonicalToolName(tool) === "code.window");
  const policy = contract?.atlasCodeWindowPolicy;
  // Describe what each read returns, not when to call it: prescriptive routing
  // invites checklist tool use. The earlier line routed every known read to
  // code.window and discouraged mapping; 37% of HARD-40 file reads reopened a
  // file already read, mostly for names the previous window had revealed.
  if (hasCodeWindow) {
    const reads = [];
    if (issued.has("code.skeleton")) {
      reads.push("code.skeleton returns a compact list of a file's declarations with symbol handles");
    }
    if (issued.has("symbol.get")) {
      reads.push("symbol.get returns complete bodies of named declarations, several in one file through file+symbols or independent ones through items");
    }
    reads.push("code.window returns a source region around named declarations including the same-file control flow between them; granularity symbol covers the named declarations' regions, and fileWindow covers most of the file and is the largest read");
    if (issued.has("code.lens")) reads.push("code.lens returns the locations of an identifier's uses with their enclosing symbols");
    lines[0] += ` Atlas reads: ${reads.join("; ")}. None of these requires a prior symbol_id lookup.`;
  }
  if (hasCodeWindow && policy) {
    lines.push(
      `Atlas code window limit: code.window is capped at ${policy.maxWindowTokens} tokens and ${policy.maxWindowLines} lines per call for this run. Omit max_tokens to use that configured maximum; a smaller value narrows the result and a larger value is clamped.`,
    );
  }
  return lines;
}

export function renderToolBatchingGuidance(contract = {}, toolRenderer) {
  if (!toolRenderer || typeof toolRenderer.tryRenderIssued !== "function") return [];

  const hasNativeBatch = (Array.isArray(contract?.tools) ? contract.tools : [])
    .some((tool) => tool?.batching === "native-batch" && toolRenderer.tryRenderIssued(tool));
  return hasNativeBatch
    ? ["Schema batching: Tools with schema defined batch fields can combine items in one call within their declared limits."]
    : [];
}
