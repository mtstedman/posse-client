import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";

// Flags that disable per-tool permission enforcement in the provider CLIs
// (claude and codex respectively). No posse code path emits either today;
// deriving from argv keeps this telemetry truthful if that ever changes.
const PERMISSION_BYPASS_CLI_FLAGS = Object.freeze([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
]);

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

function canonicalExpectedMcpNames(deterministicReadMcp = null) {
  return [...new Set([
    ...toNameList(deterministicReadMcp?.tools || []).map((name) => (
      name.startsWith("tools.") ? name : `tools.${name}`
    )),
    ...toNameList(deterministicReadMcp?.atlasTools || []).map((name) => (
      name.startsWith("atlas.") ? name : `atlas.${name}`
    )),
  ])].sort();
}

function canonicalRequiredMcpNames(deterministicReadMcp = null) {
  return [...new Set(toNameList(
    deterministicReadMcp?.requiredTools
      || deterministicReadMcp?.serverConfig?.requiredTools
      || [],
  ).map((name) => {
    if (name.startsWith("tools.") || name.startsWith("atlas.")) return name;
    return `tools.${name}`;
  }))].sort();
}

// Provider-agnostic extraction of MCP/gateway-relevant lines from an agent
// CLI's stderr. The attach-under-load failure (the CLI failing to bring up the
// stdio posse-gateway server) surfaces in the CLI's own stderr, which Posse
// otherwise discards on a clean (exit 0) run — so the failure was invisible.
const MCP_STDERR_TOPIC = /(mcp|posse-gateway|gateway|tool)/i;
const MCP_STDERR_PROBLEM = /(fail|error|not connected|unavailable|timed?\s?out|refused|disconnect|no such tool|could not|unable to|ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)/i;
const MCP_STDERR_GATEWAY = /(posse-gateway|mcp[^.]{0,30}(gateway|server))/i;
const MCP_STDERR_GATEWAY_FAIL = /(fail|not connected|unavailable|refused|disconnect|timed?\s?out|no such tool|could not|unable)/i;

export function extractMcpStderrSignals(stderr, { maxLines = 25 } = {}) {
  const text = String(stderr || "");
  if (!text) return { lines: [], gatewayAttachFailed: false };
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (MCP_STDERR_TOPIC.test(line) && MCP_STDERR_PROBLEM.test(line)) {
      lines.push(line.slice(0, 400));
      if (lines.length >= maxLines) break;
    }
  }
  const gatewayAttachFailed = lines.some(
    (l) => MCP_STDERR_GATEWAY.test(l) && MCP_STDERR_GATEWAY_FAIL.test(l),
  );
  return { lines, gatewayAttachFailed };
}

// Records MCP-relevant CLI stderr (only when a signal is present, to stay
// low-noise) so a gateway attach failure leaves a trace keyed by job_id.
export function logProviderCliStderrTelemetry({
  providerName,
  role,
  workItemId = null,
  jobId = null,
  attemptId = null,
  exitCode = null,
  stderr = "",
  attachProof = null,
  extra = {},
} = {}) {
  const { lines, gatewayAttachFailed: stderrSuggestsAttachFailure } = extractMcpStderrSignals(stderr);
  if (lines.length === 0) return null;
  const attachProofPresent = !!attachProof?.initializeSeenAt && !!attachProof?.toolsListSeenAt;
  // Tool-level MCP errors can contain phrases such as "MCP server failed"
  // even after the owner observed a successful initialize + tools/list. Do
  // not misclassify those model/request errors as a gateway attach failure.
  const gatewayAttachFailed = stderrSuggestsAttachFailure && !attachProofPresent;
  appendRunTelemetry("diagnostics", {
    kind: "provider.cli_mcp_stderr",
    component: "provider_tool_surface",
    provider: providerName || null,
    role: role || null,
    work_item_id: workItemId ?? null,
    job_id: jobId ?? null,
    attempt_id: attemptId ?? null,
    exit_code: exitCode ?? null,
    gateway_attach_failed: gatewayAttachFailed,
    gateway_attach_proof_present: attachProofPresent,
    mcp_stderr_line_count: lines.length,
    mcp_stderr_lines: lines,
    ...extra,
  });
  return { lines, gatewayAttachFailed };
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
  emittedCliArgs = null,
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
    // This field reports the command line that was actually emitted, derived
    // from the built argv so it cannot drift from reality. Provider policy may
    // request bypass-like behavior while implementing it with a bounded
    // allowlist instead of the unsafe CLI flag. Null means the callsite did
    // not supply the argv — unknown, never a false claim of safety.
    cli_dangerously_skip_permissions: Array.isArray(emittedCliArgs)
      ? PERMISSION_BYPASS_CLI_FLAGS.some((flag) => emittedCliArgs.includes(flag))
      : null,
    cli_permission_bypass_requested: cliToolConfig?.dangerouslySkipPermissions === true,
    config_override_count: configOverrideCount == null ? null : Number(configOverrideCount) || 0,
    force_read_only_sandbox: forceReadOnlySandbox == null ? null : forceReadOnlySandbox === true,
    ...extra,
  });
}

export function logProviderMcpAttachProofTelemetry({
  providerName,
  role,
  workItemId = null,
  jobId = null,
  attemptId = null,
  exitCode = null,
  deterministicReadMcp = null,
  releaseResult = null,
  phase = "provider_cleanup",
  extra = {},
} = {}) {
  const proof = releaseResult?.attachProof || null;
  const deterministicActive = deterministicReadMcp?.active === true;
  const initializeSeen = !!proof?.initializeSeenAt;
  const toolsListSeen = !!proof?.toolsListSeenAt;
  const missingProof = deterministicActive && (!initializeSeen || !toolsListSeen);
  const expectedToolNames = canonicalExpectedMcpNames(deterministicReadMcp);
  const requiredToolNames = canonicalRequiredMcpNames(deterministicReadMcp);
  const actualToolNames = [...new Set(toNameList(proof?.toolsListNames || []))].sort();
  const expectedToolSet = new Set(expectedToolNames);
  const actualToolSet = new Set(actualToolNames);
  const missingRequiredToolNames = requiredToolNames.filter((name) => !actualToolSet.has(name));
  const unexpectedToolNames = actualToolNames.filter((name) => !expectedToolSet.has(name));
  const emptyOperationalProjection = deterministicActive
    && toolsListSeen
    && expectedToolNames.length > 0
    && actualToolNames.length === 0;
  const projectionMismatch = deterministicActive
    && toolsListSeen
    && (
      emptyOperationalProjection
      || missingRequiredToolNames.length > 0
      || unexpectedToolNames.length > 0
    );
  appendRunTelemetry("diagnostics", {
    kind: missingProof
      ? "mcp.attach.missing_proof"
      : projectionMismatch
      ? "mcp.attach.projection_mismatch"
      : "mcp.attach.proof",
    component: "provider_tool_surface",
    phase,
    provider: providerName || null,
    role: role || null,
    work_item_id: workItemId ?? null,
    job_id: jobId ?? null,
    attempt_id: attemptId ?? null,
    exit_code: exitCode ?? null,
    deterministic_active: deterministicActive,
    deterministic_server_name: deterministicReadMcp?.serverName || deterministicReadMcp?.serverKey || null,
    owner_session_released: releaseResult?.released === true,
    owner_release_reason: releaseResult?.reason || null,
    initialize_seen: initializeSeen,
    tools_list_seen: toolsListSeen,
    tools_list_count: proof?.toolsListCount ?? null,
    tools_list_names: actualToolNames,
    tools_list_sha256: proof?.toolsListSha256 || null,
    expected_tool_names: expectedToolNames,
    required_tool_names: requiredToolNames,
    missing_required_tool_names: missingRequiredToolNames,
    unexpected_tool_names: unexpectedToolNames,
    empty_operational_projection: emptyOperationalProjection,
    projection_mismatch: projectionMismatch,
    first_tool_call_seen: !!proof?.firstToolCallSeenAt,
    first_tool_name: proof?.firstToolName || null,
    owner_request_count: proof?.requestCount ?? null,
    owner_last_method: proof?.lastMethod || null,
    owner_last_error: proof?.lastOwnerError || null,
    missing_attach_proof: missingProof,
    ...extra,
  });
  return {
    missingProof,
    projectionMismatch,
    invalidProof: missingProof || projectionMismatch,
    proof,
  };
}
