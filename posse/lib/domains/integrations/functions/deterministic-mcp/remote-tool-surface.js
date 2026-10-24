// @ts-check
//
// Remote-issued deterministic MCP tool surface helpers.
//
// Posse Remote is the authority for tool contracts. During the bridge phase the
// local runtime asks for that surface before launching provider shims, then
// carries the returned catalog and optional remote-issued MCP bearer into the
// persistent owner.

import { RemotePromptClient } from "../../../remote/classes/RemotePromptClient.js";
import {
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  MCP_OAUTH_AUDIENCE,
  MCP_OAUTH_TOKEN_TYPE,
} from "../../../../catalog/mcp.js";
import {
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../../../remote/functions/mode.js";
import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";
import { errorSummary, safeRemoteOrigin, remoteSurfaceSummary } from "../../../../shared/tools/functions/mcp-diagnostics.js";
import {
  buildMcpOAuthClaimsFromBootConfig,
} from "./oauth-token.js";

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function promptClientRuntimeSummary(promptClient) {
  let nativeAuth = null;
  let nativeManagerAvailable = false;
  let nativeClientSelected = false;
  try { nativeAuth = promptClient?.nativeAuthEnvelope?.() || null; } catch { nativeAuth = null; }
  try { nativeManagerAvailable = promptClient?.nativeManager?.shouldUse?.("remote") === true; } catch { nativeManagerAvailable = false; }
  try { nativeClientSelected = promptClient?.shouldUseNativeClient?.() === true; } catch { nativeClientSelected = false; }
  return {
    authentication_present: promptClient?.hasAuthentication?.() === true,
    default_fetch: promptClient?.usesDefaultFetch === true,
    native_client_required: promptClient?.usesDefaultFetch === true
      && promptClient?.hasAuthentication?.() === true,
    native_auth_present: !!nativeAuth,
    native_manager_available: nativeManagerAvailable,
    native_client_selected: nativeClientSelected,
    timeout_ms: Number(promptClient?.timeoutMs) || null,
    max_retries: Number(promptClient?.maxRetries) || 0,
  };
}

function logRemoteGatewayTelemetry(kind, bootConfig = {}, extra = {}) {
  const remoteCatalog = bootConfig.remoteCatalog || {};
  appendRunTelemetry("diagnostics", {
    kind,
    component: "remote_mcp_gateway",
    role: bootConfig.role || null,
    provider: bootConfig.providerName || null,
    work_item_id: bootConfig.workItemId ?? null,
    job_id: bootConfig.jobId ?? null,
    attempt_id: bootConfig.attemptId ?? null,
    remote_catalog_enabled: remoteCatalog.enabled === true,
    remote_catalog_mode: remoteCatalog.mode || "",
    remote_catalog_base_present: !!String(remoteCatalog.baseUrl || "").trim(),
    remote_catalog_origin: safeRemoteOrigin(remoteCatalog.baseUrl),
    remote_catalog_timeout_ms: Number(remoteCatalog.timeoutMs) || null,
    requested_suites: Array.isArray(remoteCatalog.requestedSuites) ? remoteCatalog.requestedSuites : [],
    ...extra,
  });
}

function requestedRemoteToolSuites(bootConfig = {}) {
  const configured = Array.isArray(bootConfig.remoteCatalog?.requestedSuites)
    ? bootConfig.remoteCatalog.requestedSuites
    : [];
  const suites = configured.length > 0
    ? configured
    : ["tools", ...(bootConfig.atlasAvailable === true ? ["atlas"] : [])];
  const out = [];
  for (const suite of suites) {
    const normalized = String(suite || "").trim().toLowerCase();
    const value = normalized === "deterministic" ? "tools" : normalized;
    if ((value === "tools" || value === "atlas") && !out.includes(value)) out.push(value);
  }
  return out;
}

export function buildRemoteToolSurfaceRequestFromBootConfig(bootConfig = {}) {
  const claims = buildMcpOAuthClaimsFromBootConfig(bootConfig);
  const capabilities = claims.capabilities && typeof claims.capabilities === "object"
    ? claims.capabilities
    : {};
  const agentBound = !!String(bootConfig.agentId || claims.agent_id || "").trim();
  const oauthIdentityCapabilities = agentBound
    ? {
        agentId: String(bootConfig.agentId || claims.agent_id),
        scopeBindingMode: "dispatcher",
      }
    : capabilities;
  const memoryCount = numberOrNull(
    bootConfig?.atlas?.memoryStats?.memories
    ?? bootConfig?.atlas?.memory_count
    ?? bootConfig?.atlas?.memoryCount
    ?? bootConfig?.atlas?.memories,
  );
  const atlasCapabilities = {
    available: bootConfig.atlasAvailable === true,
    backend: bootConfig.atlasAvailable === true ? "v2" : "",
  };
  if (memoryCount != null) atlasCapabilities.memory_count = memoryCount;
  // Only an investigating researcher receives the research-child report
  // schema instead of a compact handoff. A planner also carries
  // researchInvestigation (for its dispatch_agent schema) but still hands off
  // through the compact planner contract its prompt renders.
  const investigatingResearcher = bootConfig.researchInvestigation === true
    && String(bootConfig.role || "").trim().toLowerCase() === "researcher";
  const compactAgentHandoff = bootConfig.agentHandoff === true && !investigatingResearcher;

  return {
    role: String(bootConfig.role || ""),
    provider: String(bootConfig.providerName || ""),
    // Remote uses the profile only to select the handoff variant's claim
    // staging; every report-only profile shares researcher.report.v1, so the
    // canonical report profile stands in for tight and direct variants.
    ...(String(bootConfig.role || "").trim().toLowerCase() === "researcher"
      && bootConfig.agentHandoffReportOnly === true
      ? { prompt_profile: "researcher_report" }
      : {}),
    requested_suites: requestedRemoteToolSuites(bootConfig),
    local_capabilities: {
      tools: {
        read: bootConfig.coordinationChild !== true,
        write: bootConfig.allowWrite === true,
        shell: bootConfig.allowShell === true,
        tests: bootConfig.allowTests === true,
        image_generation: bootConfig.allowImageGeneration === true,
        image_inspection: bootConfig.toolAllowlist?.tools?.includes("read_image_metadata") === true,
        artifact_validation: bootConfig.toolAllowlist?.tools?.includes("validate_artifact_output") === true,
        integrity_verification: bootConfig.toolAllowlist?.tools?.includes("hash_file") === true,
        project_db: bootConfig.projectDbCapability || (bootConfig.projectDbWrite === true ? "write" : "none"),
        environment_setup_v1: true,
        planner_clarification_v1: bootConfig.toolAllowlist?.tools?.includes("request_clarification") === true,
        environment_setup_batch_v1: bootConfig.toolAllowlist?.tools?.includes("setup_environment") === true,
        custom_tools_v1: bootConfig.customTools === true,
        custom_tools_available: bootConfig.customTools === true,
      },
      atlas: atlasCapabilities,
      coordination: {
        agent_handoff_v1: bootConfig.agentHandoff === true,
        agent_handoff_compact_v1: compactAgentHandoff,
        agent_handoff_compact_v2: compactAgentHandoff,
        agent_handoff_compact_v3: compactAgentHandoff,
        sub_agent_v1: bootConfig.subAgent === true,
        dispatch_agent_v1: bootConfig.dispatchAgent === true,
        research_investigation_v1: bootConfig.researchInvestigation === true,
        web_research_handoff_v1: bootConfig.webResearchHandoff === true,
        final_review_v1: bootConfig.finalReview === true,
      },
    },
    mcp_oauth: {
      // Known coordination-only roles resolve an intentionally empty surface.
      // Their agent still receives a locally signed empty OAuth contract, but
      // asking the remote mint for a credential would reject the empty surface.
      requested: bootConfig.remoteCatalog?.requestMcpOAuth !== false,
      audience: MCP_OAUTH_AUDIENCE,
      token_type: MCP_OAUTH_TOKEN_TYPE,
      ttl_seconds: DEFAULT_MCP_OAUTH_TTL_SECONDS,
      subject: claims.sub || null,
      capabilities: oauthIdentityCapabilities,
    },
  };
}

export function extractRemoteMcpOAuthToken(surface = {}) {
  const direct = surface?.mcp_oauth_token
    || surface?.mcpOAuthToken
    || surface?.oauth_token
    || surface?.access_token
    || surface?.token;
  const nested = surface?.mcp_auth?.access_token
    || surface?.mcp_auth?.token
    || surface?.mcpAuth?.accessToken
    || surface?.mcpAuth?.token;
  return String(direct || nested || "").trim();
}

export async function resolveRemoteMcpToolSurfaceForBootConfig(bootConfig = {}, {
  client = null,
  fetchImpl = undefined,
  authManager = null,
  pulseTokens = null,
} = {}) {
  if (bootConfig.remoteCatalog?.enabled !== true) {
    logRemoteGatewayTelemetry("mcp.remote_gateway.call_skipped", bootConfig, {
      outcome: "disabled",
    });
    return null;
  }
  const baseUrl = String(bootConfig.remoteCatalog?.baseUrl || getPosseRemoteUrl() || "").trim();
  if (!baseUrl) {
    logRemoteGatewayTelemetry("mcp.remote_gateway.call_skipped", bootConfig, {
      outcome: "missing_base_url",
    });
    return null;
  }
  const timeoutMs = Number(bootConfig.remoteCatalog?.timeoutMs) || getPosseRemoteTimeoutMs();
  const promptClient = client || new RemotePromptClient({
    baseUrl,
    timeoutMs,
    fetchImpl,
    ...(authManager ? { authManager } : {}),
    ...(pulseTokens ? { pulseTokens } : {}),
  });
  const request = buildRemoteToolSurfaceRequestFromBootConfig(bootConfig);
  const runtime = promptClientRuntimeSummary(promptClient);
  logRemoteGatewayTelemetry("mcp.remote_gateway.call_start", bootConfig, {
    outcome: "started",
    remote_catalog_origin: safeRemoteOrigin(baseUrl),
    requested_suites: request.requested_suites,
    mcp_oauth_requested: request.mcp_oauth?.requested === true,
    ...runtime,
  });
  const startedAt = Date.now();
  try {
    const surface = await promptClient.resolveToolSurface(request);
    const mcpOAuthToken = extractRemoteMcpOAuthToken(surface);
    logRemoteGatewayTelemetry("mcp.remote_gateway.call_result", bootConfig, {
      outcome: surface && typeof surface === "object" ? "ok" : "empty",
      duration_ms: Date.now() - startedAt,
      remote_catalog_origin: safeRemoteOrigin(baseUrl),
      remote_surface_present: !!(surface && typeof surface === "object"),
      remote_oauth_present: !!mcpOAuthToken,
      remote_surface: remoteSurfaceSummary(surface),
      ...runtime,
    });
    return surface && typeof surface === "object" ? {
      request,
      surface,
      mcpOAuthToken,
    } : null;
  } catch (err) {
    logRemoteGatewayTelemetry("mcp.remote_gateway.call_result", bootConfig, {
      outcome: "error",
      duration_ms: Date.now() - startedAt,
      remote_catalog_origin: safeRemoteOrigin(baseUrl),
      remote_surface_present: false,
      remote_oauth_present: false,
      error: errorSummary(err),
      ...runtime,
    });
    throw err;
  }
}
