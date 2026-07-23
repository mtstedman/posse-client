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
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../../../remote/functions/mode.js";
import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";
import {
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  MCP_OAUTH_AUDIENCE,
  MCP_OAUTH_TOKEN_TYPE,
  buildMcpOAuthClaimsFromBootConfig,
} from "./oauth-token.js";

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function errorSummary(err) {
  if (!err) return null;
  const cause = err.cause && err.cause !== err ? err.cause : null;
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    status: err?.status || err?.statusCode || err?.response?.status || null,
    message: capString(err?.message || String(err), 700),
    cause: cause ? {
      name: cause?.name || null,
      code: cause?.code || cause?.errno || null,
      status: cause?.status || cause?.statusCode || cause?.response?.status || null,
      message: capString(cause?.message || String(cause), 700),
    } : null,
  };
}

function safeRemoteOrigin(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function remoteSurfaceSummary(surface = null) {
  if (!surface || typeof surface !== "object") {
    return {
      present: false,
      suite_count: 0,
      tool_count: 0,
      tool_names_sample: [],
    };
  }
  const tools = Array.isArray(surface.tools) ? surface.tools : [];
  const suites = Array.isArray(surface.suites) ? surface.suites : [];
  return {
    present: true,
    suite_count: suites.length,
    tool_count: tools.length,
    tool_names_sample: tools
      .map((tool) => String(tool?.name || tool?.local_name || "").trim())
      .filter(Boolean)
      .slice(0, 30),
  };
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

  return {
    role: String(bootConfig.role || ""),
    provider: String(bootConfig.providerName || ""),
    requested_suites: requestedRemoteToolSuites(bootConfig),
    local_capabilities: {
      tools: {
        read: bootConfig.coordinationChild !== true,
        write: bootConfig.allowWrite === true,
        shell: bootConfig.allowShell === true,
        tests: bootConfig.allowTests === true,
        image_generation: bootConfig.allowImageGeneration === true,
        project_db: bootConfig.projectDbCapability || (bootConfig.projectDbWrite === true ? "write" : "none"),
      },
      atlas: atlasCapabilities,
      coordination: {
        agent_handoff_v1: bootConfig.agentHandoff === true,
        agent_handoff_compact_v1: bootConfig.agentHandoff === true,
        agent_handoff_compact_v2: bootConfig.agentHandoff === true,
        sub_agent_v1: bootConfig.subAgent === true,
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
