import { WEB_TOOL_ROLES } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { ToolCatalog } from "../../classes/tools/ToolCatalog.js";
import { ToolContract } from "../../classes/tools/ToolContract.js";
import { projectDbEffectivePermissions } from "../toolkit/project-db/config.js";

export { WEB_TOOL_ROLES } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

export function buildExecutionContract(opts = {}) {
  return filterProjectDbTool(ToolContract.build(opts).toJSON(), opts);
}

// project_db_query is declared per-role in the catalog, but it only exists
// where the repo's admin config enables it: when the caller identifies the
// repo (projectDir), drop the tool from the contract unless the operator
// grant — capped to the job's read/write capability lane — is non-empty.
// Callers that pass no projectDir (catalog-level surface dumps, tests) get
// the unfiltered role surface. projectDbWrite decouples the DB capability
// lane from the file-write grant for db-mode dev jobs (task_mode:"db"), which
// run with allowWrite:false but need the write-capable DB grant.
function filterProjectDbTool(contract, { projectDir = null, allowWrite = false, projectDbWrite = false } = {}) {
  if (!projectDir) return contract;
  const tools = Array.isArray(contract?.tools) ? contract.tools : [];
  if (!tools.some((tool) => tool?.name === "project_db_query")) return contract;
  let effective = [];
  try {
    effective = projectDbEffectivePermissions({ projectDir, capability: (allowWrite || projectDbWrite) ? "write" : "read" });
  } catch {
    effective = [];
  }
  if (effective.length > 0) return contract;
  return { ...contract, tools: tools.filter((tool) => tool?.name !== "project_db_query") };
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
