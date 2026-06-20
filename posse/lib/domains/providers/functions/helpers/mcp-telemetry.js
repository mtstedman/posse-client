import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";

function toNameList(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      return value?.providerSurfaceName
        || value?.surfaceName
        || value?.name
        || value?.canonicalName
        || value?.mcpName
        || "";
    })
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function splitToolFlag(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return toNameList(value);
  return String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function serverNamesFromPayload(payload = null) {
  const servers = payload?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers).filter(Boolean) : [];
}

export function logProviderMcpSurfaceTelemetry({
  providerName,
  role,
  workItemId = null,
  jobId = null,
  attemptId = null,
  phase = "configured",
  deterministicReadMcp = null,
  atlasReadyForMcp = false,
  atlasContractTools = [],
  mcpServerNames = [],
  cliToolConfig = null,
  configOverrideCount = null,
  forceReadOnlySandbox = null,
  extra = {},
} = {}) {
  const deterministicTools = toNameList(deterministicReadMcp?.tools || []);
  const contractTools = toNameList(deterministicReadMcp?.contractTools || []);
  const atlasTools = toNameList(atlasContractTools);
  const serverNames = Array.isArray(mcpServerNames) && mcpServerNames.length > 0
    ? mcpServerNames.map((name) => String(name || "").trim()).filter(Boolean)
    : serverNamesFromPayload(deterministicReadMcp?.payload);
  const allowedTools = splitToolFlag(cliToolConfig?.allowedTools);
  appendRunTelemetry("diagnostics", {
    kind: "provider.mcp_surface",
    component: "provider_tool_surface",
    phase,
    provider: providerName || null,
    role: role || null,
    work_item_id: workItemId ?? null,
    job_id: jobId ?? null,
    attempt_id: attemptId ?? null,
    deterministic_active: deterministicReadMcp?.active === true,
    deterministic_server_name: deterministicReadMcp?.serverName || deterministicReadMcp?.serverKey || null,
    deterministic_tool_count: deterministicTools.length,
    deterministic_tool_names_sample: deterministicTools.slice(0, 40),
    contract_tool_count: contractTools.length,
    contract_tool_names_sample: contractTools.slice(0, 40),
    atlas_ready_for_mcp: atlasReadyForMcp === true,
    atlas_contract_tool_count: atlasTools.length,
    atlas_contract_tool_names_sample: atlasTools.slice(0, 40),
    mcp_server_count: serverNames.length,
    mcp_server_names: serverNames,
    active_without_server: deterministicReadMcp?.active === true && serverNames.length === 0,
    cli_allowed_tools_count: allowedTools.length,
    cli_allowed_tools_sample: allowedTools.slice(0, 60),
    cli_tools_flag_present: cliToolConfig?.tools != null,
    cli_disallowed_tools_present: !!cliToolConfig?.disallowedTools,
    cli_dangerously_skip_permissions: cliToolConfig?.dangerouslySkipPermissions === true,
    config_override_count: configOverrideCount == null ? null : Number(configOverrideCount) || 0,
    force_read_only_sandbox: forceReadOnlySandbox == null ? null : forceReadOnlySandbox === true,
    ...extra,
  });
}
