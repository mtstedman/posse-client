import { WEB_TOOL_ROLES } from "../../../../shared/tools/functions/contract.js";
import { CODEX_RESEARCHER_TRANSPORT_LIMITS } from "../../../../catalog/tool-surface/provider-attachments.js";

export function buildCodexNestedMcpGuidance() {
  const { maxReadBatch, outputTokens } = CODEX_RESEARCHER_TRANSPORT_LIMITS;
  return `CODEX MCP TRANSPORT: Call the issued mcp__ tools through code mode. Use Promise.all for at most ${maxReadBatch} independent ready reads per execution, then inspect the results before choosing another batch. Begin every execution that emits repository text with this literal first line:\n// @exec: {"max_output_tokens": ${outputTokens}}\nStore the unchanged returned text blocks before emission so a clipped result can be recovered without another repository read. Emit every returned text content block verbatim with text(block.text), including source and evidence/continuation headers. Do not JSON-stringify the enclosing MCP result, discard blocks, or mix terminal agent_handoff with other work in one execution. Preserve truncation and error notices. If an emission clips, load the stored blocks and re-emit smaller portions before another read or handoff; never treat a successful JavaScript tool return as proof that its text reached the model.`;
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
