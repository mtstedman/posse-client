import { WEB_TOOL_ROLES } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { ToolCatalog } from "../../classes/tools/ToolCatalog.js";
import { ToolContract } from "../../classes/tools/ToolContract.js";

export { WEB_TOOL_ROLES } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

export function buildExecutionContract(opts = {}) {
  return ToolContract.build(opts).toJSON();
}

export function appendExecutionTools(contract = {}, toolNames = []) {
  return ToolContract.append(contract, toolNames, ToolCatalog);
}

export function adaptExecutionContractForProvider(contract = {}, provider = "generic") {
  return ToolContract.adaptForProvider(contract, provider);
}

export function renderExecutionContractBlock(contract = {}) {
  return new ToolContract(contract).renderBlock();
}

export function buildClaudeCliToolConfig(contract = {}, opts = {}) {
  return new ToolContract(contract).toClaudeCliFlags(opts);
}

export function buildProviderToolDefinitions(toolMap = {}, contract = {}) {
  return new ToolContract(contract).toProviderToolDefinitions(toolMap);
}

export function __testGetBaseToolNamesForRole(role, allowWrite, opts = {}) {
  return ToolContract.getBaseToolNamesForRole(role, allowWrite, opts);
}
