import { selectPromptToolConditions } from "./prompt-tool-conditions.js";
import { ProviderToolRenderer } from "../classes/ProviderToolRenderer.js";
import { ATLAS_READ_GUIDANCE_TOKEN, TOOL_REFS, toolReference } from "../../../catalog/tool-references.js";
import { ToolCatalog } from "../classes/ToolCatalog.js";
import { recordObservation } from "../../../domains/observability/functions/observations.js";
import { PROVIDER_TOOL_REFERENCE_UNRESOLVED_OBSERVATION_TYPE } from "../../../catalog/observation.js";

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
      researchInvestigation: contract?.researchInvestigation === true,
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

export function renderAtlasGuidance(contract = {}, toolRenderer = new ProviderToolRenderer({
  providerName: contract.provider,
  issuedSurface: contract,
})) {
  const tools = Array.isArray(contract?.tools) ? contract.tools : [];
  const hasAtlas = tools
    .some((tool) => String(tool?.suite || "").trim() === "atlas"
      || String(tool?.access || "").trim() === "atlas");
  if (!hasAtlas) return [];
  const issued = (name) => toolRenderer.tryRender(toolReference("atlas", name));
  const discovery = [issued("symbol.search"), issued("code.survey")].filter(Boolean);
  const lens = issued("code.lens");
  const relationships = [issued("symbol.callers"), issued("code.structure")].filter(Boolean);
  const routing = [
    "Atlas symbol tracing: Choose retrieval by the unresolved fact and the location already known, not by a need to switch tools.",
    discovery.length ? `Use ${discovery.join(" or ")} to locate unknown targets.` : "",
    lens ? `Use ${lens} for scattered details.` : "",
    relationships.length ? `Use ${relationships.join(" or ")} only for a needed relationship, selecting the relevant relation kinds instead of all kinds.` : "",
  ].filter(Boolean).join(" ");
  const lines = [
    routing,
    "Atlas evidence refs: evidence_ref identifies content already visible in this context. Use it directly for citation, slicing, or handoff; do not call it for the same content.",
  ];
  const traversal = toolRenderer.tryRender(TOOL_REFS.atlas.traverseRef)
    || toolRenderer.tryRender(TOOL_REFS.atlas.fetchRef);
  if (traversal) {
    lines.push(`Atlas stored-result traversal: Call ${traversal} only with an explicit traversal_ref for omitted content. Group concurrently ready traversal refs into one call; use one when it unlocks the next cursor. Omit limit for normal source traversal: limit measures characters per ref, not source lines. A successful call promotes that same ref to evidence_ref, and each returned evidence_ref identifies the visible text. A different traversal_ref alone advertises more missing content. Copy opaque refs as issued and do not calculate offsets. Start a fresh producer call for a materially different scope.`);
  }
  const codeWindow = toolRenderer.tryRender(TOOL_REFS.atlas.codeWindow);
  const policy = contract?.atlasCodeWindowPolicy;
  if (codeWindow) {
    const reads = [];
    const skeleton = issued("code.skeleton");
    const symbolGet = issued("symbol.get");
    if (skeleton) reads.push(`${skeleton} returns a compact list of a file's declarations with symbol handles`);
    if (symbolGet) reads.push(`${symbolGet} returns complete bodies of named declarations, several in one file through file+symbols or independent ones through items`);
    reads.push(`${codeWindow} returns a source region around named declarations including the same-file control flow between them; granularity symbol covers the named declarations' regions, and fileWindow covers most of the file and is the largest read`);
    if (lens) reads.push(`${lens} returns the locations of an identifier's uses with their enclosing symbols`);
    lines[0] += ` Atlas reads: ${reads.join("; ")}. None of these requires a prior symbol_id lookup.`;
  }
  if (codeWindow && policy) {
    lines.push(
      `Atlas code window limit: ${codeWindow} is capped at ${policy.maxWindowTokens} tokens and ${policy.maxWindowLines} lines per call for this run. Omit max_tokens to use that configured maximum; a smaller value narrows the result and a larger value is clamped.`,
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

// Remote owns contract prose; local projection binds names only after the
// final provider surface is known. Never guess an unissued callable name.
export function renderProviderPromptContracts(prompt, contract = {}) {
  const renderer = new ProviderToolRenderer({ providerName: contract.provider, issuedSurface: contract });
  const observed = new Set();
  const lookup = (reference) => renderer.tryRender(reference)
    || (reference.suite === "atlas" && reference.canonicalName === "traverse_ref"
      ? renderer.tryRender(TOOL_REFS.atlas.fetchRef) : null);
  const observe = (reference) => {
    const key = `${reference.suite}.${reference.canonicalName}`;
    if (observed.has(key)) return;
    observed.add(key);
    recordObservation({
      observation_type: PROVIDER_TOOL_REFERENCE_UNRESOLVED_OBSERVATION_TYPE,
      summary: `Provider prompt tool reference unresolved: ${key}`,
      detail: { provider: renderer.providerName, suite: reference.suite, tool: reference.canonicalName },
    });
  };
  const selected = selectPromptToolConditions(String(prompt || ""), {
    hasTool: (key) => {
      const separator = key.indexOf(".");
      const reference = toolReference(key.slice(0, separator), key.slice(separator + 1));
      if (lookup(reference)) return true;
      observe(reference);
      return false;
    },
    hasSuite: (suite) => renderer.issuedTools.some((tool) => (tool.suite || (tool.access === "atlas" ? "atlas" : "tools")) === suite && renderer.tryRenderIssued(tool)),
  });
  // Older Remote versions can still send unguarded tokens. Omit their
  // dependent guidance after selecting guarded branches so call-time surface
  // narrowing never fails prompt assembly or names an absent tool.
  const missing = new Set();
  for (const match of selected.matchAll(/\{\{tool:(tools|atlas)\.([a-zA-Z0-9_.]+)\}\}/g)) {
    const reference = toolReference(match[1], match[2]);
    if (lookup(reference)) continue;
    observe(reference);
    missing.add(match[0]);
  }
  const withoutMissingGuidance = selected.split(/(?=^=== CONTRACT:)/m).map(block => {
    if (block.startsWith("=== CONTRACT:") && [...missing].some(token => block.includes(token))) return "";
    return block.split("\n").filter(line => ![...missing].some(token => line.includes(token))).join("\n");
  }).join("").replace(/\n{3,}/g, "\n\n");
  const renderedPrompt = withoutMissingGuidance
    .replaceAll(ATLAS_READ_GUIDANCE_TOKEN, renderAtlasGuidance(contract, renderer).join("\n"))
    .replace(/\{\{tool:(tools|atlas)\.([a-zA-Z0-9_.]+)\}\}/g, (_token, suite, action) => {
      const reference = toolReference(suite, action);
      return lookup(reference) || "";
    });
  const acknowledgement = renderer.tryRender(TOOL_REFS.tools.ackOperatorFeedback);
  if (!acknowledgement || String(prompt || "").includes(ATLAS_READ_GUIDANCE_TOKEN)
    || selected.includes("{{tool:tools.ack_operator_feedback}}")
    || renderedPrompt.includes(acknowledgement)) return renderedPrompt;
  return [renderedPrompt.trim(), `Operator feedback acknowledgement tool: ${acknowledgement}. Acknowledge pending operator feedback before continuing.`]
    .filter(Boolean).join("\n\n");
}
