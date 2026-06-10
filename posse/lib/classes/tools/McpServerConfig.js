import path from "path";
import { fileURLToPath } from "url";
import { getAtlasIntegrationConfig } from "../../domains/integrations/functions/atlas.js";
import { getRuntimeDbPath } from "../../domains/runtime/functions/paths.js";
import {
  roleUsesDeterministicImageHelpers,
  roleUsesDeterministicImageMcp,
  roleUsesDeterministicReadMcp,
  roleUsesDeterministicWriteMcp,
} from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../domains/integrations/functions/mcp-gateway.js";
import {
  getPosseRemoteMode,
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "../../domains/remote/functions/mode.js";
import { resolvePosseKey } from "../../domains/remote/functions/client.js";
import { McpServer } from "./McpServer.js";

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

function boolEnv(value) {
  return value ? "true" : "false";
}

function deterministicMcpCompatibilityEnv(payload = {}, atlasConfig = {}) {
  const out = {
    POSSE_DETERMINISTIC_MCP_DB_PATH: String(payload.dbPath || ""),
    POSSE_DETERMINISTIC_MCP_CWD: String(payload.cwd || ""),
    POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: boolEnv(payload.allowWrite === true),
    POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_HELPERS: boolEnv(payload.allowImageHelpers === true),
    POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: boolEnv(payload.allowImageGeneration === true),
    POSSE_DETERMINISTIC_MCP_ROLE: String(payload.role || ""),
    POSSE_DETERMINISTIC_MCP_DISABLE_SYSTEM_TOOLS: boolEnv(payload.disableSystemTools === true),
    POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(Array.isArray(payload.scopedFiles) ? payload.scopedFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(Array.isArray(payload.createFiles) ? payload.createFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: JSON.stringify(Array.isArray(payload.deleteFiles) ? payload.deleteFiles : []),
    POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: JSON.stringify(Array.isArray(payload.createRoots) ? payload.createRoots : []),
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
  // Credential transport intentionally stays env-backed; the boot JSON payload
  // is carried in process args and must not contain provider secrets.
  if (atlasConfig?.embeddingApiKey) out.POSSE_ATLAS_EMBEDDING_API_KEY = String(atlasConfig.embeddingApiKey);
  if (payload.remoteCatalog?.enabled === true) {
    const posseKey = resolvePosseKey();
    if (posseKey) {
      out.POSSE_KEY = posseKey;
    }
  }
  if (payload.providerName) out.POSSE_DETERMINISTIC_MCP_PROVIDER = String(payload.providerName);
  if (payload.jobId != null) out.POSSE_DETERMINISTIC_MCP_JOB_ID = String(payload.jobId);
  if (payload.workItemId != null) out.POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID = String(payload.workItemId);
  if (payload.atlasPrefetchStatus) out.POSSE_DETERMINISTIC_MCP_ATLAS_PREFETCH_STATUS = String(payload.atlasPrefetchStatus);
  return out;
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
  } = {}) {
    this.ready = !!ready;
    this.reason = reason || null;
    this.name = name || POSSE_MCP_GATEWAY_SERVER_NAME;
    this.transport = transport || "stdio";
    this.command = command || null;
    this.args = Array.isArray(args) ? [...args] : [];
    this.cwd = cwd || process.cwd();
    this.env = normalizedEnv(env);
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
    };
  }

  spawn(opts = {}) {
    return new McpServer({ config: this, ...opts });
  }

  static forDeterministicRead(role, {
    cwd = process.cwd(),
    scopedFiles = [],
    createFiles = [],
    deleteFiles = [],
    createRoots = [],
    needsImageGeneration = false,
    providerName = null,
    disableSystemTools = false,
    jobId = null,
    workItemId = null,
    atlasPrefetchStatus = null,
    atlasAvailable = null,
    atlasGateEnabled = true,
    atlasConfig = null,
  } = {}) {
    if (!roleUsesDeterministicReadMcp(role)) {
      return new McpServerConfig({
        ready: false,
        reason: "role_not_enabled",
        name: POSSE_MCP_GATEWAY_SERVER_NAME,
      });
    }

    const command = process.execPath;
    const scriptPath = path.resolve(__dirname, "..", "..", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
    const atlasEnabled = (typeof atlasAvailable === "boolean")
      ? atlasAvailable
      : resolvedAtlasConfig.enabled;
    const allowImageGeneration = roleUsesDeterministicImageMcp(role) && !!needsImageGeneration;
    const remoteCatalogMode = getPosseRemoteMode();
    const remoteCatalogEnabled = remoteCatalogMode !== "off";
    const bootPayload = {
      cwd,
      scopedFiles: Array.isArray(scopedFiles) ? scopedFiles : [],
      createFiles: Array.isArray(createFiles) ? createFiles : [],
      deleteFiles: Array.isArray(deleteFiles) ? deleteFiles : [],
      createRoots: Array.isArray(createRoots) ? createRoots : [],
      allowWrite: roleUsesDeterministicWriteMcp(role),
      allowImageHelpers: roleUsesDeterministicImageHelpers(role),
      allowImageGeneration,
      role,
      providerName: providerName || null,
      disableSystemTools,
      jobId,
      workItemId,
      atlasAvailable: atlasEnabled,
      atlasGateEnabled,
      atlasPrefetchStatus: atlasPrefetchStatus != null ? String(atlasPrefetchStatus) : "",
      atlas: {
        repoPath: resolvedAtlasConfig?.requestedRepoPath || "",
        repoId: resolvedAtlasConfig?.requestedRepoId || "",
        graphDbPath: resolvedAtlasConfig?.requestedGraphDbPath || "",
        liveBuffers: resolvedAtlasConfig?.liveBuffersEnabled === false ? "off" : "deterministic-writes",
        semanticEnabled: resolvedAtlasConfig?.semanticEnabled === true,
        vectorBackend: resolvedAtlasConfig?.vectorBackend || "auto",
        viewWaitMs: resolvedAtlasConfig?.viewWaitMs ?? null,
        autoRefreshStale: resolvedAtlasConfig?.autoRefreshStale ?? null,
        embeddingProvider: resolvedAtlasConfig?.embeddingProvider || resolvedAtlasConfig?.atlasEmbeddingProvider || "",
        embeddingEndpoint: resolvedAtlasConfig?.embeddingEndpoint || "",
        embeddingModel: resolvedAtlasConfig?.embeddingModel || "",
        embeddingDim: resolvedAtlasConfig?.embeddingDim ?? null,
        embeddingModelVersion: resolvedAtlasConfig?.embeddingModelVersion || "",
        embeddingTimeoutMs: resolvedAtlasConfig?.embeddingTimeoutMs ?? null,
        embeddingHeaders: resolvedAtlasConfig?.embeddingHeaders || null,
        embeddingSendDimensions: resolvedAtlasConfig?.embeddingSendDimensions === true,
        remoteEncoderMode: resolvedAtlasConfig?.remoteEncoderMode || "off",
        remoteEncoderUrl: resolvedAtlasConfig?.remoteEncoderUrl || "",
        remoteEncoderModel: resolvedAtlasConfig?.remoteEncoderModel || "",
        remoteEncoderDim: resolvedAtlasConfig?.remoteEncoderDim ?? null,
        remoteEncoderModelVersion: resolvedAtlasConfig?.remoteEncoderModelVersion || "",
        remoteEncoderTimeoutMs: resolvedAtlasConfig?.remoteEncoderTimeoutMs ?? null,
      },
      remoteCatalog: {
        enabled: remoteCatalogEnabled,
        mode: remoteCatalogMode,
        baseUrl: remoteCatalogEnabled ? getPosseRemoteUrl() : "",
        timeoutMs: remoteCatalogEnabled ? getPosseRemoteTimeoutMs() : "",
        requestedSuites: [
          "tools",
          ...(atlasEnabled ? ["atlas"] : []),
        ],
      },
      dbPath: getRuntimeDbPath(),
    };

    return new McpServerConfig({
      ready: true,
      name: POSSE_MCP_GATEWAY_SERVER_NAME,
      transport: "stdio",
      command,
      args: [scriptPath, "--config-json", deterministicMcpBootArg(bootPayload)],
      cwd,
      env: {
        ...deterministicMcpBaseEnv(process.env),
        ...(allowImageGeneration ? imageGenerationCredentialEnv(process.env) : {}),
        ...deterministicMcpCompatibilityEnv(bootPayload, resolvedAtlasConfig),
      },
    });
  }
}
