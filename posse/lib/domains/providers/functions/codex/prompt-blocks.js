import { TOOL_REFS, formatToolReference } from "../../../../catalog/tool-references.js";
import { ProviderToolRenderer } from "../../../../shared/tools/classes/ProviderToolRenderer.js";

export function buildCodexResearchMcpGuidance(executionContract) {
  if (["researcher", "planner", "dev", "fix", "assessor", "artificer"].includes(executionContract?.role)) return "";
  const renderer = new ProviderToolRenderer({ providerName: "codex", issuedSurface: executionContract });
  const queryAction = executionContract?.tools?.find(tool => tool.mcpName === formatToolReference(TOOL_REFS.atlas.query));
  const atlas = renderer.tryRender(TOOL_REFS.atlas.query) || (queryAction && renderer.tryRenderIssued(queryAction));
  const handoff = renderer.tryRender(TOOL_REFS.tools.agentHandoff);
  const directAtlas = executionContract?.tools?.some(tool => tool.suite === "atlas"
    && tool.mcpName !== formatToolReference(TOOL_REFS.atlas.query));
  return [
    "CODEX MCP TRANSPORT: Core retrieval tools are declared upfront. Call them directly with structured arguments; no registry lookup is needed. Preserve truncation and error notices; recover missing source before citing it.",
    "Run independent, already-needed tool calls in parallel in the same turn when their arguments and authorization are known. Keep dependent operations sequential. Keep scope requests, sub-agent control, and terminal handoff separate from other calls.",
    atlas && !directAtlas ? `Atlas actions such as code.window are action values passed to ${atlas}; put the selected action's fields in args. They are not separate callable tools.` : null,
    directAtlas ? "Atlas reads are individually declared tools. Call the issued tool name with its structured parameters, without an action/args wrapper." : null,
    handoff ? `Submit the completed report directly through ${handoff} with structured arguments. Keep terminal submission separate from other tool calls. If validation rejects it, repair the reported fields using delivered evidence.` : null,
  ].filter(Boolean).join("\n");
}
