import { WEB_TOOL_ROLES } from "../../../../shared/tools/functions/contract.js";

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
