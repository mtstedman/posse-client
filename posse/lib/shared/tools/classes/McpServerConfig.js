import path from "path";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import { getAtlasIntegrationConfig } from "../../../domains/integrations/functions/atlas.js";
import {
  getRuntimeDbPath,
  getRuntimeResourcesDir,
} from "../../../domains/runtime/functions/paths.js";
import {
  getDeterministicMcpToolNames,
  roleUsesDeterministicImageHelpers,
  roleUsesDeterministicImageMcp,
  roleUsesDeterministicReadMcp,
  roleUsesDeterministicWriteMcp,
} from "../../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../domains/integrations/functions/mcp-gateway.js";
import {
  getPosseRemoteMode,
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../../../domains/remote/functions/mode.js";
import { heartbeatAuthManager } from "../../native/classes/HeartbeatAuthManager.js";
import {
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  mintMcpOAuthTokenForBootConfig,
  verifyMcpOAuthToken,
} from "../../../domains/integrations/functions/deterministic-mcp/oauth-token.js";
import { resolveRemoteMcpToolSurfaceForBootConfig } from "../../../domains/integrations/functions/deterministic-mcp/remote-tool-surface.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import {
  issuedToolNamesForSuite,
  narrowBootConfigToRemoteSurface,
  normalizeProjectDbCapability,
} from "../functions/issued-tool-policy.js";
import { persistentMcpOwner } from "./PersistentMcpOwner.js";
import { McpServer } from "./McpServer.js";
import { McpGate } from "./McpGate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizedEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!key) continue;
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

const DETERMINISTIC_MCP_ENV_EXACT = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

const DETERMINISTIC_MCP_PROXY_ENV_EXACT = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

const DETERMINISTIC_MCP_NPM_ENV_EXACT = new Set([
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_STRICT_SSL",
]);

const DETERMINISTIC_MCP_SECRET_RE = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|OAUTH[_-]?TOKEN|(?:^|[_-])TOKEN(?:$|[_-])|SECRET|PASSWORD|GITHUB[_-]?TOKEN|ANTHROPIC|OPENAI|XAI|CODEX|^POSSE_KEY$)/i;

function deterministicMcpBaseEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!key || value == null) continue;
    const upper = key.toUpperCase();
    const allowed = DETERMINISTIC_MCP_ENV_EXACT.has(upper)
      || DETERMINISTIC_MCP_PROXY_ENV_EXACT.has(upper)
      || DETERMINISTIC_MCP_NPM_ENV_EXACT.has(upper);
    if (!allowed) continue;
    if (DETERMINISTIC_MCP_SECRET_RE.test(key)) continue;
    let nextValue = String(value);
    if (DETERMINISTIC_MCP_PROXY_ENV_EXACT.has(upper) || upper === "NPM_CONFIG_REGISTRY") {
      nextValue = stripUrlCredentials(nextValue);
      if (!nextValue) continue;
    }
    out[key] = nextValue;
  }
  return out;
}

function stripUrlCredentials(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    return raw.includes("@") ? "" : raw;
  }
  if (!url.username && !url.password && !url.search && !url.hash) return raw;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function imageGenerationCredentialEnv(env = process.env) {
  const out = {};
  for (const key of ["OPENAI_API_KEY", "XAI_API_KEY"]) {
    const value = env?.[key];
    if (value == null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

function deterministicMcpBootArg(payload = {}) {
  const json = JSON.stringify(payload || {});
  return Buffer.from(json, "utf8").toString("base64");
}

function stripMcpOwnerOnlyBootFields(payload = {}) {
  const out = JSON.parse(JSON.stringify(payload || {}));
  delete out.mcpOAuthToken;
  delete out.mcpOauthToken;
  if (out.mcpAuth && typeof out.mcpAuth === "object") {
    delete out.mcpAuth.accessToken;
    delete out.mcpAuth.token;
  }
  return out;
}

function sanitizeRemoteToolSurfaceForBoot(surface = null) {
  if (!surface || typeof surface !== "object") return null;
  const out = JSON.parse(JSON.stringify(surface));
  delete out.mcp_oauth_token;
  delete out.mcpOAuthToken;
  delete out.oauth_token;
  delete out.access_token;
  delete out.token;
  if (out.mcp_auth && typeof out.mcp_auth === "object") {
    delete out.mcp_auth.access_token;
    delete out.mcp_auth.token;
  }
  if (out.mcpAuth && typeof out.mcpAuth === "object") {
    delete out.mcpAuth.accessToken;
    delete out.mcpAuth.token;
  }
  return out;
}

function boolEnv(value) {
  return value ? "true" : "false";
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

function expectedMcpToolNames(role, bootPayload = {}) {
  try {
    return getDeterministicMcpToolNames(role, {
      needsImageGeneration: bootPayload.allowImageGeneration === true,
    });
  } catch {
    return [];
  }
}

function logMcpBootTelemetry(kind, role, bootPayload = {}, extra = {}) {
  const remoteCatalog = bootPayload.remoteCatalog || {};
  const expectedTools = expectedMcpToolNames(role, bootPayload);
  appendRunTelemetry("diagnostics", {
    kind,
    component: "deterministic_mcp",
    role: role || bootPayload.role || null,
    provider: bootPayload.providerName || null,
    work_item_id: bootPayload.workItemId ?? null,
    job_id: bootPayload.jobId ?? null,
    attempt_id: bootPayload.attemptId ?? null,
    remote_catalog_enabled: remoteCatalog.enabled === true,
    remote_catalog_mode: remoteCatalog.mode || "",
    remote_catalog_base_present: !!String(remoteCatalog.baseUrl || "").trim(),
    remote_catalog_origin: safeRemoteOrigin(remoteCatalog.baseUrl),
    remote_catalog_timeout_ms: Number(remoteCatalog.timeoutMs) || null,
    requested_suites: Array.isArray(remoteCatalog.requestedSuites) ? remoteCatalog.requestedSuites : [],
    expected_tool_count: expectedTools.length,
    expected_tool_names_sample: expectedTools.slice(0, 30),
    ...extra,
  });
}

function deterministicMcpCompatibilityEnv(payload = {}, atlasConfig = {}) {
  const out = {
    POSSE_DETERMINISTIC_MCP_DB_PATH: String(payload.dbPath || ""),
    POSSE_DETERMINISTIC_MCP_CWD: String(payload.cwd || ""),
    POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: boolEnv(payload.allowWrite === true),
    POSSE_DETERMINISTIC_MCP_PROJECT_DB_WRITE: boolEnv(payload.projectDbWrite === true),
    POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_HELPERS: boolEnv(payload.allowImageHelpers === true),
    POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: boolEnv(payload.allowImageGeneration === true),
    POSSE_DETERMINISTIC_MCP_ROLE: String(payload.role || ""),
    POSSE_DETERMINISTIC_MCP_DISABLE_SYSTEM_TOOLS: boolEnv(payload.disableSystemTools === true),
    POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(Array.isArray(payload.scopedFiles) ? payload.scopedFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(Array.isArray(payload.createFiles) ? payload.createFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: JSON.stringify(Array.isArray(payload.deleteFiles) ? payload.deleteFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: JSON.stringify(Array.isArray(payload.createRoots) ? payload.createRoots : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_READ_ROOTS: JSON.stringify(Array.isArray(payload.readRoots) ? payload.readRoots : []),
    POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: boolEnv(payload.atlasAvailable === true),
    POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: boolEnv(payload.atlasGateEnabled === true),
    POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH: String(payload.atlas?.repoPath || ""),
    POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID: String(payload.atlas?.repoId || ""),
    POSSE_DETERMINISTIC_MCP_ATLAS_GRAPH_DB_PATH: String(payload.atlas?.graphDbPath || ""),
    POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: boolEnv(payload.remoteCatalog?.enabled === true),
    POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: String(payload.remoteCatalog?.mode || ""),
    POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: Array.isArray(payload.remoteCatalog?.requestedSuites)
      ? payload.remoteCatalog.requestedSuites.join(",")
      : "",
    POSSE_REMOTE_URL: String(payload.remoteCatalog?.baseUrl || ""),
    POSSE_REMOTE_TIMEOUT_MS: String(payload.remoteCatalog?.timeoutMs || ""),
    POSSE_ATLAS_LIVE_BUFFERS: payload.atlas?.liveBuffers || "off",
    POSSE_ATLAS_AUTO_FEEDBACK: String(atlasConfig?.autoFeedbackMode || "write"),
  };
  if (payload.providerName) out.POSSE_DETERMINISTIC_MCP_PROVIDER = String(payload.providerName);
  if (payload.jobId != null) out.POSSE_DETERMINISTIC_MCP_JOB_ID = String(payload.jobId);
  if (payload.workItemId != null) out.POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID = String(payload.workItemId);
  if (payload.atlasPrefetchStatus) out.POSSE_DETERMINISTIC_MCP_ATLAS_PREFETCH_STATUS = String(payload.atlasPrefetchStatus);
  return out;
}

function deterministicMcpShimMetadataEnv(payload = {}, atlasConfig = {}) {
  const metadataPayload = payload.scopeBindingMode === "dispatcher"
    ? {
        ...payload,
        scopedFiles: [],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
        readRoots: [],
      }
    : payload;
  const out = deterministicMcpCompatibilityEnv(metadataPayload, atlasConfig);
  // The stdio shim is a forwarding gate only. Keep non-secret deterministic
  // metadata for diagnostics/back-compat, but never give the shim credentials
  // or values that would let it perform remote/catalog/native work itself.
  return out;
}

function deterministicMcpScriptPaths() {
  return {
    serverScriptPath: path.resolve(__dirname, "..", "..", "..", "domains", "integrations", "functions", "deterministic-mcp-server.js"),
    shimScriptPath: path.resolve(__dirname, "..", "..", "..", "domains", "integrations", "functions", "deterministic-mcp-shim.js"),
  };
}

function agentContractBootPayload(bootPayload, agentId) {
  return {
    ...bootPayload,
    agentId,
    scopeBindingMode: "dispatcher",
    cwd: "",
    jobId: null,
    workItemId: null,
    attemptId: null,
    agentCallId: null,
    promptChars: 0,
    scopedFiles: [],
    createFiles: [],
    deleteFiles: [],
    createRoots: [],
    readRoots: [],
  };
}

function ownerHotBootPayloadFor(contractBootPayload) {
  return stripMcpOwnerOnlyBootFields({
    ...contractBootPayload,
    ownerHotGateway: true,
    agentId: "",
    scopeBindingMode: "",
    role: "",
    providerName: "",
    jobId: null,
    workItemId: null,
    attemptId: null,
    agentCallId: null,
    promptChars: 0,
    scopedFiles: [],
    createFiles: [],
    deleteFiles: [],
    createRoots: [],
    readRoots: [],
    allowWrite: true,
    allowImageHelpers: true,
    allowImageGeneration: true,
    atlasGateEnabled: false,
    atlasPrefetchStatus: "",
    atlas: {},
    remoteToolSurface: null,
    nativeAuth: null,
  });
}

function ownerServerSpecFor(contractBootPayload, resolvedAtlasConfig, cwd) {
  const { serverScriptPath } = deterministicMcpScriptPaths();
  const ownerHotBootPayload = ownerHotBootPayloadFor(contractBootPayload);
  return {
    command: process.execPath,
    args: [serverScriptPath, "--config-json", deterministicMcpBootArg(ownerHotBootPayload)],
    cwd,
    env: {
      ...deterministicMcpBaseEnv(process.env),
      ...imageGenerationCredentialEnv(process.env),
      ...deterministicMcpCompatibilityEnv(ownerHotBootPayload, resolvedAtlasConfig),
    },
    startupFrames: [{
      __posse_control: "capabilityBroker",
      capability: persistentMcpOwner.nativeAuthBrokerCapability(),
    }],
  };
}

function buildDeterministicMcpBootPayload(role, {
  agentId = null,
  scopeBindingMode = null,
  projectRoot = null,
  cwd = process.cwd(),
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  providerName = null,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = true,
  atlasConfig = null,
  // Caller override for the role-derived write capability (null = role
  // default). db-mode dev jobs pass allowWrite:false + projectDbWrite:true:
  // file tools off, project_db_query on the write lane. The override can only
  // narrow — it is ANDed with the role capability, never widens it.
  allowWrite = null,
  projectDbWrite = false,
  projectDbCapability = null,
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot || cwd || process.cwd());
  const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
  const atlasEnabled = (typeof atlasAvailable === "boolean")
    ? atlasAvailable
    : resolvedAtlasConfig.enabled;
  const allowImageGeneration = roleUsesDeterministicImageMcp(role) && !!needsImageGeneration;
  const expectedTools = getDeterministicMcpToolNames(role, { needsImageGeneration: allowImageGeneration });
  const allowShell = expectedTools.includes("bash");
  const requestedProjectDbCapability = normalizeProjectDbCapability(
    projectDbCapability || (projectDbWrite === true ? "write" : "none"),
  );
  const allowTests = requestedProjectDbCapability !== "write" && expectedTools.some((name) => [
    "run_scoped_checks",
    "create_test_suite",
    "create_test",
    "run_test",
    "run_test_suite",
  ].includes(name));
  const remoteCatalogMode = getPosseRemoteMode();
  const remoteCatalogEnabled = remoteCatalogMode !== "off";
  return {
    bootPayload: {
      agentId: agentId ? String(agentId) : "",
      scopeBindingMode: scopeBindingMode ? String(scopeBindingMode) : "",
      cwd,
      projectRoot: resolvedProjectRoot,
      resourcesRoot: getRuntimeResourcesDir(resolvedProjectRoot),
      scopedFiles: Array.isArray(scopedFiles) ? scopedFiles : [],
      createFiles: Array.isArray(createFiles) ? createFiles : [],
      deleteFiles: Array.isArray(deleteFiles) ? deleteFiles : [],
      createRoots: Array.isArray(createRoots) ? createRoots : [],
      readRoots: Array.isArray(readRoots) ? readRoots : [],
      allowWrite: roleUsesDeterministicWriteMcp(role) && allowWrite !== false,
      allowShell,
      allowTests,
      projectDbCapability: requestedProjectDbCapability,
      projectDbWrite: projectDbWrite === true && requestedProjectDbCapability === "write",
      allowImageHelpers: roleUsesDeterministicImageHelpers(role),
      allowImageGeneration,
      role,
      providerName: providerName || null,
      disableSystemTools,
      jobId,
      workItemId,
      attemptId,
      agentCallId,
      promptChars: Math.max(0, Number(promptChars) || 0),
      atlasAvailable: atlasEnabled,
      atlasGateEnabled,
      atlasPrefetchStatus: atlasPrefetchStatus != null ? String(atlasPrefetchStatus) : "",
      atlas: {
        repoPath: resolvedAtlasConfig?.requestedRepoPath || "",
        repoId: resolvedAtlasConfig?.requestedRepoId || "",
        graphDbPath: resolvedAtlasConfig?.requestedGraphDbPath || "",
        liveBuffers: resolvedAtlasConfig?.liveBuffersEnabled === false ? "off" : "deterministic-writes",
        viewWaitMs: resolvedAtlasConfig?.viewWaitMs ?? null,
        jobCacheEnabled: resolvedAtlasConfig?.jobCacheEnabled === true,
        jobCacheTtlMs: resolvedAtlasConfig?.jobCacheTtlMs ?? null,
        autoRefreshStale: resolvedAtlasConfig?.autoRefreshStale ?? null,
      },
      remoteCatalog: {
        enabled: remoteCatalogEnabled,
        mode: remoteCatalogMode,
        baseUrl: remoteCatalogEnabled ? getPosseRemoteUrl() : "",
        timeoutMs: remoteCatalogEnabled ? getPosseRemoteTimeoutMs() : "",
        requestMcpOAuth: expectedTools.length > 0,
        requestedSuites: [
          "tools",
          ...(atlasEnabled ? ["atlas"] : []),
        ],
      },
      dbPath: getRuntimeDbPath(resolvedProjectRoot),
      // Native-binary auth as a parent-minted, NON-SECRET capability (heartbeat
      // URL + pinned public verification key + audience — no POSSE_KEY). The
      // sidecar reconstructs a child-scoped auth manager from this. The raw
      // Posse credential is never part of the boot payload.
      nativeAuth: heartbeatAuthManager.getCapability(),
    },
    resolvedAtlasConfig,
    allowImageGeneration,
  };
}

function buildDeterministicMcpConfigFromBootPayload(role, {
  bootPayload,
  resolvedAtlasConfig,
  cwd = process.cwd(),
  allowImageGeneration = false,
  remoteToolSurface = null,
  remoteMcpOAuthToken = "",
  mcpGate = null,
} = {}) {
  const command = process.execPath;
  const { shimScriptPath } = deterministicMcpScriptPaths();
  if (!remoteToolSurface || typeof remoteToolSurface !== "object") {
    throw requiredRemoteToolSurfaceError(role, null, "did not include a remote-issued tool surface");
  }
  if (!mcpGate || typeof mcpGate.assertAttached !== "function" || !mcpGate.token) {
    const error = new Error(`Agent role ${role || "unknown"} has no MCP gate dependency`);
    error.code = "POSSE_AGENT_MCP_GATE_REQUIRED";
    throw error;
  }
  mcpGate.assertCompatible({ role, providerName: bootPayload.providerName });
  const narrowedBootPayload = narrowBootConfigToRemoteSurface(bootPayload, remoteToolSurface);
  if (!narrowedBootPayload.remoteToolSurface) {
    throw requiredRemoteToolSurfaceError(role, null, "returned an invalid or mismatched remote-issued tool surface");
  }
  narrowedBootPayload.remoteToolSurface = sanitizeRemoteToolSurfaceForBoot(
    narrowedBootPayload.remoteToolSurface,
  );
  Object.assign(bootPayload, narrowedBootPayload);
  // The Dispatcher already attached this Agent to the Job. Provider projection
  // can only prove it is using that attachment; tools resolve file authority
  // from the persisted Agent -> Job -> Work Item chain.
  mcpGate.assertAttached({
    jobId: bootPayload.jobId,
    workItemId: bootPayload.workItemId,
    agentCallId: bootPayload.agentCallId,
  });
  bootPayload.agentId = mcpGate.id;
  bootPayload.scopeBindingMode = "dispatcher";
  bootPayload.mcpOAuthToken = mcpGate.token;
  let ownerEndpoint = null;
  const ownerStartAt = Date.now();
  try {
    ownerEndpoint = persistentMcpOwner.ensureStarted();
    logMcpBootTelemetry("mcp.owner.ensure_started", role, bootPayload, {
      outcome: "ok",
      duration_ms: Date.now() - ownerStartAt,
      owner_boot_id: ownerEndpoint?.bootId || null,
      owner_transport: ownerEndpoint?.transport || null,
      remote_oauth_present: !!remoteMcpOAuthToken,
      oauth_source: "local",
    });
  } catch (err) {
    logMcpBootTelemetry("mcp.owner.ensure_started", role, bootPayload, {
      outcome: "error",
      duration_ms: Date.now() - ownerStartAt,
      remote_oauth_present: !!remoteMcpOAuthToken,
      oauth_source: "local",
      error: errorSummary(err),
    });
    throw err;
  }
  logMcpBootTelemetry("mcp.config.ready", role, bootPayload, {
    outcome: "ok",
    server_name: POSSE_MCP_GATEWAY_SERVER_NAME,
    transport: "stdio",
    remote_surface_present: !!remoteToolSurface,
    remote_oauth_present: !!remoteMcpOAuthToken,
    oauth_source: "local",
    remote_surface: remoteSurfaceSummary(remoteToolSurface),
  });

  return new McpServerConfig({
    ready: true,
    name: POSSE_MCP_GATEWAY_SERVER_NAME,
    transport: "stdio",
    command,
    args: [
      shimScriptPath,
      "--owner-pipe",
      ownerEndpoint.pipePath,
      "--owner-token",
      ownerEndpoint.token,
      "--mcp-oauth-token",
      bootPayload.mcpOAuthToken,
    ],
    cwd,
    env: {
      ...deterministicMcpBaseEnv(process.env),
      ...deterministicMcpShimMetadataEnv(bootPayload, resolvedAtlasConfig),
    },
    tools: mcpGate.contractBootConfig.toolAllowlist?.tools || [],
    atlasTools: mcpGate.contractBootConfig.toolAllowlist?.atlas || [],
    remoteToolSurface: mcpGate.remoteToolSurface,
    ownerSession: mcpGate.ownerSession,
  });
}

function buildDeterministicMcpConfigWithTelemetry(role, args = {}) {
  const bootPayload = args?.bootPayload || {};
  const remoteToolSurface = args?.remoteToolSurface || null;
  const remoteMcpOAuthToken = args?.remoteMcpOAuthToken || "";
  const startedAt = Date.now();
  logMcpBootTelemetry("mcp.config.create_start", role, bootPayload, {
    outcome: "started",
    remote_surface_present: !!remoteToolSurface,
    remote_oauth_present: !!remoteMcpOAuthToken,
    oauth_source: remoteMcpOAuthToken ? "remote" : "missing",
    remote_surface: remoteSurfaceSummary(remoteToolSurface),
  });
  try {
    const config = buildDeterministicMcpConfigFromBootPayload(role, args);
    logMcpBootTelemetry("mcp.config.create_result", role, bootPayload, {
      outcome: "ok",
      duration_ms: Date.now() - startedAt,
      ready: config?.ready === true,
      reason: config?.reason || null,
      server_name: config?.name || null,
      transport: config?.transport || null,
      remote_surface_present: !!remoteToolSurface,
      remote_oauth_present: !!remoteMcpOAuthToken,
      oauth_source: remoteMcpOAuthToken ? "remote" : "missing",
      remote_surface: remoteSurfaceSummary(remoteToolSurface),
    });
    return config;
  } catch (err) {
    logMcpBootTelemetry("mcp.config.create_result", role, bootPayload, {
      outcome: "error",
      duration_ms: Date.now() - startedAt,
      remote_surface_present: !!remoteToolSurface,
      remote_oauth_present: !!remoteMcpOAuthToken,
      oauth_source: remoteMcpOAuthToken ? "remote" : "missing",
      remote_surface: remoteSurfaceSummary(remoteToolSurface),
      error: errorSummary(err),
    });
    throw err;
  }
}

function requiredRemoteToolSurfaceError(role, cause = null, reason = "unavailable") {
  const err = new Error(`Required remote MCP tool surface ${reason} for ${role || "unknown-role"}; refusing local shim gate fallback.`);
  err.code = "POSSE_REMOTE_MCP_TOOL_SURFACE_REQUIRED";
  if (cause) err.cause = cause;
  return err;
}

function remoteToolSurfaceRequired(bootPayload = {}) {
  void bootPayload;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveRemoteMcpToolSurfaceWithRetry(bootPayload = {}, opts = {}) {
  const attempts = Math.max(1, Number(opts?.attempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const resolution = await resolveRemoteMcpToolSurfaceForBootConfig(bootPayload, opts.remoteToolSurfaceOptions || {});
      if (resolution?.surface) return resolution;
      lastError = requiredRemoteToolSurfaceError(
        bootPayload.role,
        null,
        "did not include a remote-issued tool surface",
      );
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(250 * attempt);
  }
  throw requiredRemoteToolSurfaceError(bootPayload.role, lastError);
}

export class McpServerConfig {
  constructor({
    ready = false,
    reason = null,
    name = POSSE_MCP_GATEWAY_SERVER_NAME,
    transport = "stdio",
    command = null,
    args = [],
    cwd = process.cwd(),
    env = {},
    ownerSession = null,
    tools = [],
    atlasTools = [],
    remoteToolSurface = null,
  } = {}) {
    this.ready = !!ready;
    this.reason = reason || null;
    this.name = name || POSSE_MCP_GATEWAY_SERVER_NAME;
    this.transport = transport || "stdio";
    this.command = command || null;
    this.args = Array.isArray(args) ? [...args] : [];
    this.cwd = cwd || process.cwd();
    this.env = normalizedEnv(env);
    this.tools = Array.isArray(tools) ? [...tools] : [];
    this.atlasTools = Array.isArray(atlasTools) ? [...atlasTools] : [];
    this.remoteToolSurface = remoteToolSurface && typeof remoteToolSurface === "object"
      ? JSON.parse(JSON.stringify(remoteToolSurface))
      : null;
    this.ownerSession = ownerSession && typeof ownerSession === "object"
      ? {
          sessionId: ownerSession.sessionId || null,
          ownerBootId: ownerSession.ownerBootId || null,
          ownerTransport: ownerSession.ownerTransport || null,
          agentOwned: ownerSession.agentOwned === true,
          gateId: ownerSession.gateId || null,
        }
      : null;
  }

  toEnv() {
    return { ...this.env };
  }

  toSpawnArgs() {
    return {
      ready: this.ready,
      reason: this.reason,
      name: this.name,
      transport: this.transport,
      command: this.command,
      args: [...this.args],
      cwd: this.cwd,
      env: this.toEnv(),
      tools: [...this.tools],
      atlasTools: [...this.atlasTools],
      remoteToolSurface: this.remoteToolSurface ? JSON.parse(JSON.stringify(this.remoteToolSurface)) : null,
      ownerSession: this.ownerSession ? { ...this.ownerSession } : null,
    };
  }

  spawn(opts = {}) {
    return new McpServer({ config: this, ...opts });
  }

  static releaseOwnerSession(ownerSession = null, opts = {}) {
    const session = ownerSession && typeof ownerSession === "object" ? ownerSession : null;
    if (!session?.sessionId) {
      return { released: false, reason: "missing_session" };
    }
    if (session.agentOwned === true) {
      return { released: false, reason: "agent_owned" };
    }
    return persistentMcpOwner.unregisterSession({
      sessionId: session.sessionId,
      expectedBootId: session.ownerBootId || null,
      reason: opts.reason || "provider_exit",
      context: opts.context || null,
    });
  }

  static async mintAgentGate(role, opts = {}) {
    const agentId = String(opts.agentId || opts.key || crypto.randomUUID());
    const agentRuntimeCwd = path.resolve(opts.agentRuntimeCwd || opts.projectDir || process.cwd());
    const { bootPayload, resolvedAtlasConfig } = buildDeterministicMcpBootPayload(role, {
      ...opts,
      agentId,
      scopeBindingMode: "dispatcher",
      projectRoot: agentRuntimeCwd,
    });
    let remoteResolution = null;
    let remoteResolutionError = null;
    try {
      remoteResolution = opts.remoteToolSurface && typeof opts.remoteToolSurface === "object"
        ? {
            surface: opts.remoteToolSurface,
            mcpOAuthToken: String(opts.remoteMcpOAuthToken || ""),
          }
        : await resolveRemoteMcpToolSurfaceWithRetry(bootPayload, {
            attempts: opts.remoteToolSurfaceAttempts || 3,
            remoteToolSurfaceOptions: opts.remoteToolSurfaceOptions || {},
          });
    } catch (error) {
      remoteResolutionError = error;
    }
    if (!remoteResolution?.surface) {
      throw requiredRemoteToolSurfaceError(
        role,
        remoteResolutionError,
        "did not include a remote-issued agent tool contract",
      );
    }
    const narrowedBootPayload = narrowBootConfigToRemoteSurface(bootPayload, remoteResolution.surface);
    if (!narrowedBootPayload.remoteToolSurface) {
      throw requiredRemoteToolSurfaceError(role, null, "returned an invalid or mismatched agent tool contract");
    }
    narrowedBootPayload.remoteToolSurface = sanitizeRemoteToolSurfaceForBoot(
      narrowedBootPayload.remoteToolSurface,
    );
    const contractBootPayload = agentContractBootPayload(narrowedBootPayload, agentId);
    const token = mintMcpOAuthTokenForBootConfig(contractBootPayload, {
      expiresInSeconds: DEFAULT_MCP_OAUTH_TTL_SECONDS,
      jti: `agent-${crypto.randomUUID()}`,
    });
    const claims = verifyMcpOAuthToken(token);
    const ownerEndpoint = persistentMcpOwner.ensureStarted();
    const registration = persistentMcpOwner.registerSession({
      token,
      bootConfig: contractBootPayload,
      serverSpec: ownerServerSpecFor(
        contractBootPayload,
        resolvedAtlasConfig,
        agentRuntimeCwd,
      ),
      prewarm: opts.prewarm ?? !process.env.NODE_TEST_CONTEXT,
      agentOwned: true,
    });
    logMcpBootTelemetry("mcp.agent_gate.minted", role, contractBootPayload, {
      outcome: "ok",
      agent_id: agentId,
      owner_boot_id: registration?.bootId || ownerEndpoint?.bootId || null,
      remote_surface_present: true,
      remote_oauth_present: !!remoteResolution?.mcpOAuthToken,
      oauth_source: "local-agent",
      session_count: persistentMcpOwner.status()?.sessionCount ?? null,
    });
    return new McpGate({
      id: agentId,
      role,
      providerName: bootPayload.providerName,
      token,
      claims,
      contractBootConfig: contractBootPayload,
      remoteToolSurface: contractBootPayload.remoteToolSurface,
      owner: persistentMcpOwner,
      ownerSession: registration,
    });
  }

  static forDeterministicRead(role, {
    cwd = process.cwd(),
    scopedFiles = [],
    createFiles = [],
    deleteFiles = [],
    createRoots = [],
    readRoots = [],
    needsImageGeneration = false,
    providerName = null,
    disableSystemTools = false,
    jobId = null,
    workItemId = null,
    attemptId = null,
    agentCallId = null,
    promptChars = 0,
    atlasPrefetchStatus = null,
    atlasAvailable = null,
    atlasGateEnabled = true,
    atlasConfig = null,
    remoteToolSurface = null,
    remoteMcpOAuthToken = "",
  } = {}) {
    if (!roleUsesDeterministicReadMcp(role)) {
      return new McpServerConfig({
        ready: false,
        reason: "role_not_enabled",
        name: POSSE_MCP_GATEWAY_SERVER_NAME,
      });
    }

    void cwd;
    void scopedFiles;
    void createFiles;
    void deleteFiles;
    void createRoots;
    void readRoots;
    void needsImageGeneration;
    void providerName;
    void disableSystemTools;
    void jobId;
    void workItemId;
    void attemptId;
    void agentCallId;
    void promptChars;
    void atlasPrefetchStatus;
    void atlasAvailable;
    void atlasGateEnabled;
    void atlasConfig;
    void remoteToolSurface;
    void remoteMcpOAuthToken;
    throw requiredRemoteToolSurfaceError(role, null, "requires async remote tool-surface resolution");
  }

  static async forDeterministicReadAsync(role, opts = {}) {
    if (!roleUsesDeterministicReadMcp(role)) {
      return McpServerConfig.forDeterministicRead(role, opts);
    }
    if (!opts.mcpGate || typeof opts.mcpGate.assertAttached !== "function") {
      const error = new Error(`Agent role ${role || "unknown"} must be constructed with an MCP gate`);
      error.code = "POSSE_AGENT_MCP_GATE_REQUIRED";
      throw error;
    }
    const { bootPayload, resolvedAtlasConfig, allowImageGeneration } = buildDeterministicMcpBootPayload(role, opts);
    let remoteResolution = null;
    let remoteResolutionError = null;
    const remoteStartedAt = Date.now();
    logMcpBootTelemetry("mcp.remote_surface.resolve_start", role, bootPayload, {
      outcome: "started",
      required: remoteToolSurfaceRequired(bootPayload),
      source: opts.remoteToolSurface ? "prompt_issuance" : "catalog_endpoint",
    });
    try {
      // Prompt composition already resolved this exact remote-issued policy.
      // Revalidate it below against role/provider and reuse it so a redundant
      // catalog request cannot turn a successful issuance into an outage.
      remoteResolution = opts.mcpGate.remoteToolSurface
        ? {
            surface: opts.mcpGate.remoteToolSurface,
            mcpOAuthToken: "",
          }
        : opts.remoteToolSurface && typeof opts.remoteToolSurface === "object"
        ? {
            surface: opts.remoteToolSurface,
            mcpOAuthToken: String(opts.remoteMcpOAuthToken || ""),
          }
        : await resolveRemoteMcpToolSurfaceWithRetry(bootPayload, {
            attempts: opts.remoteToolSurfaceAttempts || 3,
            remoteToolSurfaceOptions: opts.remoteToolSurfaceOptions || {},
          });
    } catch (err) {
      remoteResolutionError = err;
      remoteResolution = null;
    }
    const remoteDurationMs = Date.now() - remoteStartedAt;
    logMcpBootTelemetry("mcp.remote_surface.resolve_result", role, bootPayload, {
      outcome: remoteResolution?.surface ? "ok" : (remoteResolutionError ? "error" : "unavailable"),
      required: remoteToolSurfaceRequired(bootPayload),
      duration_ms: remoteDurationMs,
      remote_surface_present: !!remoteResolution?.surface,
      remote_oauth_present: !!remoteResolution?.mcpOAuthToken,
      source: opts.remoteToolSurface ? "prompt_issuance" : "catalog_endpoint",
      remote_surface: remoteSurfaceSummary(remoteResolution?.surface || null),
      error: errorSummary(remoteResolutionError),
    });
    if (!remoteResolution?.surface) {
      logMcpBootTelemetry("mcp.remote_surface.required_refused", role, bootPayload, {
        outcome: "missing_surface",
        duration_ms: remoteDurationMs,
        remote_surface_present: false,
        remote_oauth_present: !!remoteResolution?.mcpOAuthToken,
        remote_surface: remoteSurfaceSummary(remoteResolution?.surface || null),
        error: errorSummary(remoteResolutionError),
      });
      throw requiredRemoteToolSurfaceError(role, remoteResolutionError, "did not include a remote-issued tool surface");
    }
    return buildDeterministicMcpConfigWithTelemetry(role, {
      bootPayload,
      resolvedAtlasConfig,
      cwd: opts.cwd || process.cwd(),
      allowImageGeneration,
      remoteToolSurface: remoteResolution?.surface || null,
      remoteMcpOAuthToken: remoteResolution?.mcpOAuthToken || "",
      mcpGate: opts.mcpGate,
    });
  }
}
