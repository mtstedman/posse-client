// @ts-check
//
// Remote-issued deterministic MCP tool surface helpers.
//
// Posse Remote is the authority for tool contracts. During the bridge phase the
// local runtime asks for that surface before launching provider shims, then
// carries the returned catalog and optional remote-issued MCP bearer into the
// persistent owner.

import { RemotePromptClient, resolvePosseKey } from "../../../remote/functions/client.js";
import {
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../../../remote/functions/mode.js";
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
        read: true,
        write: bootConfig.allowWrite === true,
        shell: ["dev", "artificer", "assessor"].includes(String(bootConfig.role || "")),
        image_generation: bootConfig.allowImageGeneration === true,
      },
      atlas: atlasCapabilities,
    },
    mcp_oauth: {
      requested: true,
      audience: MCP_OAUTH_AUDIENCE,
      token_type: MCP_OAUTH_TOKEN_TYPE,
      ttl_seconds: DEFAULT_MCP_OAUTH_TTL_SECONDS,
      subject: claims.sub || null,
      capabilities,
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
  apiKey = resolvePosseKey(),
  useNativeClient = true,
} = {}) {
  if (bootConfig.remoteCatalog?.enabled !== true) return null;
  const baseUrl = String(bootConfig.remoteCatalog?.baseUrl || getPosseRemoteUrl() || "").trim();
  if (!baseUrl) return null;
  const timeoutMs = Number(bootConfig.remoteCatalog?.timeoutMs) || getPosseRemoteTimeoutMs();
  const promptClient = client || new RemotePromptClient({
    baseUrl,
    timeoutMs,
    fetchImpl,
    apiKey,
    useNativeClient,
  });
  const request = buildRemoteToolSurfaceRequestFromBootConfig(bootConfig);
  const surface = await promptClient.resolveToolSurface(request);
  return surface && typeof surface === "object" ? {
    request,
    surface,
    mcpOAuthToken: extractRemoteMcpOAuthToken(surface),
  } : null;
}
