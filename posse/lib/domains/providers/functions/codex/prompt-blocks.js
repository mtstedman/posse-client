import { CODEX_RESEARCHER_TRANSPORT_LIMITS } from "../../../../catalog/tool-surface/provider-attachments.js";
import { WEB_TOOL_ROLES } from "../../../../shared/tools/functions/contract.js";
import { TOOL_REFS, formatToolReference } from "../../../../catalog/tool-references.js";
import { ProviderToolRenderer } from "../../../../shared/tools/classes/ProviderToolRenderer.js";

export function buildCodexResearchMcpGuidance(executionContract, coreDeclarations = [], { nativeBatching = false } = {}) {
  const renderer = new ProviderToolRenderer({ providerName: "codex", issuedSurface: executionContract });
  const queryAction = executionContract?.tools?.find(tool => tool.mcpName === formatToolReference(TOOL_REFS.atlas.query));
  const atlas = renderer.tryRender(TOOL_REFS.atlas.query) || (queryAction && renderer.tryRenderIssued(queryAction));
  const handoff = renderer.tryRender(TOOL_REFS.tools.agentHandoff);
  return [
    nativeBatching
      ? `CODEX MCP TRANSPORT: Core retrieval tools are declared upfront. Call them directly with structured arguments; no registry lookup is needed. Use native parallel tool calls for at most ${CODEX_RESEARCHER_TRANSPORT_LIMITS.maxReadBatch} independent ready reads per turn, then inspect results before choosing dependent reads. Tool results deliver source and evidence/continuation headers directly. Preserve truncation and error notices; recover missing source before citing it.`
      : `CODEX MCP TRANSPORT: Core retrieval declarations are provided below before research begins. Call their exact names as tools.<name> inside functions.exec; no registry lookup is needed. Use Promise.all for at most ${CODEX_RESEARCHER_TRANSPORT_LIMITS.maxReadBatch} independent ready reads per execution, then inspect results before choosing dependent reads. Emit every returned text content block verbatim, including source and evidence/continuation headers. Do not JSON-stringify the enclosing MCP result or discard blocks. Preserve truncation and error notices; recover missing source before citing it. Use this executor output ceiling for source batches:`,
    nativeBatching ? null : `// @exec: ${JSON.stringify({ max_output_tokens: CODEX_RESEARCHER_TRANSPORT_LIMITS.outputTokens })}`,
    atlas ? `Atlas actions such as code.window are action values passed to ${atlas}; put the selected action's fields in args. They are not separate callable tools.` : null,
    handoff ? `Submit the completed report directly through ${handoff} with structured arguments, without preparation acknowledgements or an executor wrapper. Keep terminal submission separate from other tool calls. If validation rejects it, repair the reported fields using delivered evidence and preserve unchanged claims.` : null,
    nativeBatching ? null : `CORE MCP RETRIEVAL DECLARATIONS (name, description, parameters):\n${JSON.stringify(coreDeclarations)}`,
  ].filter(Boolean).join("\n");
}

export function buildCodexWebToolsOverrides({ role, roleMode = null, webToolsEnabled } = {}) {
  const normalizedRoleMode = String(roleMode || "").trim().toLowerCase();
  const webToolsAllowedForRoleMode = !(role === "researcher" && normalizedRoleMode === "synth");
  const active = !!webToolsEnabled && webToolsAllowedForRoleMode && WEB_TOOL_ROLES.has(role);
  return {
    active,
    // Codex defaults top-level web_search to cached, so omitting an enable
    // override does not remove the native tool. Explicitly disable both the
    // current mode and the legacy tool toggle whenever Posse has not issued
    // web access. This matters especially for detached/native controls, which
    // do not have an MCP gate to reject a model-issued web call.
    configOverrides: active
      ? ["tools.web_search=true"]
      : ['web_search="disabled"', "tools.web_search=false"],
  };
}

export function __testBuildCodexWebToolsOverrides(options = {}) {
  return buildCodexWebToolsOverrides(options);
}
