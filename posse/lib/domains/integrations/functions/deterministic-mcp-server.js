import process from "process";
import fs from "fs";
import path from "path";
import { inspect } from "util";
import {
  TOOL_HASH_FILE,
  TOOL_LIST_FILES,
  TOOL_READ_FILE,
  TOOL_WRITE_FILE,
  TOOL_EDIT_FILE,
  TOOL_CREATE_TEST_SUITE,
  TOOL_CREATE_TEST,
  TOOL_READ_IMAGE_METADATA,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_CLEAN_IMAGE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_SEARCH_FILES,
  TOOL_GIT_HISTORY,
  TOOL_INSPECT_FILE,
  TOOL_BASH,
  TOOL_AGENT_FEEDBACK,
  TOOL_GET_OPERATOR_FEEDBACK,
  TOOL_ACK_OPERATOR_FEEDBACK,
  TOOL_MOVE_FILE,
  TOOL_COPY_FILE,
  TOOL_MAKE_DIR,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_GENERATE_IMAGE,
  TOOL_GET_BRIEF,
  buildScopePredicates,
  createDeterministicToolkit,
  createBashExecutor,
  isSensitiveEnvFileOrTargetPath,
  safePath,
} from "../../../shared/tools/functions/toolkit/index.js";
import { TOOL_PROJECT_DB_QUERY } from "../../../catalog/native-tools.js";
import { execProjectDbQuery } from "../../../shared/tools/functions/toolkit/project-db/query.js";
import { capProjectDbPermissions, readProjectDbConfig } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { ToolRegistry } from "../../../shared/tools/classes/ToolRegistry.js";
import { declareToolSuites, LIVE_CHANNEL_TOOL_NAMES } from "../../../shared/tools/functions/tool-suites.js";
import { appendHashRefIfMajor } from "../../../shared/tools/functions/hash-adder.js";
import { execGenerateImageInternal } from "../../providers/functions/shared/image-generate-internal.js";
import { recordToolInvocation as _recordToolInvocation, recordObservation as _recordObservation, beginToolInvocation as _beginToolInvocation, finishToolInvocation as _finishToolInvocation, enterObservationContext, nativeReadResultStats, runWithObservationContext } from "../../observability/functions/observations.js";
import {
  acknowledgeOperatorFeedback,
  countPendingOperatorFeedbackForJob,
  getOperatorFeedbackForJob,
  recordAgentActivity,
} from "../../queue/functions/index.js";
import { guardToolWriteLock } from "../../queue/functions/write-lock-guard.js";
import { getAtlasIntegrationConfig, getAtlasRouteForRole } from "./atlas/config.js";
import { resolveAtlasRepoTarget } from "./atlas/repo.js";
import { shouldUseAtlasV2 } from "./atlas-v2-mode.js";
import { atlasBackendLabel } from "./atlas-label.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import {
  configureGate,
  isGateActive,
  isGatedTool,
  isUnlocked as isGateUnlocked,
  checkNativeToolAllowed,
  buildLockedToolError,
  unlockForAtlasUnavailable,
  isFallbackAtlasPrefetchStatus,
} from "./deterministic-mcp/gate.js";
import {
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  MCP_OAUTH_AUDIENCE,
  MCP_OAUTH_TOKEN_TYPE,
  bootConfigFromMcpOAuthClaims,
  buildMcpOAuthClaimsFromBootConfig,
  verifyMcpOAuthToken,
} from "./deterministic-mcp/oauth-token.js";
import { CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES } from "../../../catalog/context.js";
import {
  DETERMINISTIC_IMAGE_HELPER_TOOLS,
  DETERMINISTIC_IMAGE_TOOLS,
  DETERMINISTIC_OCR_TOOLS,
  DETERMINISTIC_WRITE_TOOLS,
  SURFACED_ATLAS_TOOL_DEFS,
  buildFoldedAtlasToolDescriptor,
  buildNativeToolDescriptor,
  getDeterministicMcpToolNames,
  isBlockedFoldedAtlasTool,
  isExternallyRoutedAtlasTool,
  isFallbackOnlyAtlasTool,
} from "./deterministic-mcp/tool-descriptors.js";
import { ATLAS_TOOL_ACTIONS } from "../../atlas/functions/v2/contracts/tool-params.js";
import { POSSE_MCP_GATEWAY_SERVER_INFO_NAME, stripPosseMcpGatewayPrefix } from "./mcp-gateway.js";
import { setRuntimePathOverrides } from "../../runtime/functions/paths.js";
import { AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { assertSafeRemoteAuthUrl, readResponseTextWithLimit, resolvePosseKey } from "../../remote/functions/client.js";
import { protectedMutablePathReason, relativePathFromCwd } from "../../runtime/functions/protected-paths.js";
import {
  parseEnvBool,
  parseBoolOverride,
  bootString,
  bootHeadersOverride,
  nonNegativeIntegerOrNull,
} from "./deterministic-mcp/boot-config-parse.js";
import { capString, sanitizeForLog } from "./deterministic-mcp/log-helpers.js";
import {
  jsonRpcSuccess,
  jsonRpcError,
  hiddenSessionFromParams,
  stripHiddenSessionParam,
  isSuccessfulNativeToolResult,
} from "./deterministic-mcp/json-rpc.js";

/** Safe wrapper — recording must never break tool execution in the MCP subprocess. */
function recordToolInvocation(opts) {
  try {
    _recordToolInvocation({
      ...opts,
      job_id: opts.job_id ?? mcpJobId ?? undefined,
      work_item_id: opts.work_item_id ?? mcpWorkItemId ?? undefined,
    });
  } catch { /* best effort */ }
}

/** Safe wrappers for the start/finish invocation pair (see observations.js). */
function beginToolInvocation(opts) {
  try {
    return _beginToolInvocation({
      ...opts,
      job_id: opts.job_id ?? mcpJobId ?? undefined,
      work_item_id: opts.work_item_id ?? mcpWorkItemId ?? undefined,
    });
  } catch { return null; }
}
function finishToolInvocation(invocation, opts) {
  try {
    _finishToolInvocation(invocation, {
      ...opts,
      job_id: opts.job_id ?? mcpJobId ?? undefined,
      work_item_id: opts.work_item_id ?? mcpWorkItemId ?? undefined,
    });
  } catch { /* best effort */ }
}

const SERVER_INFO = { name: POSSE_MCP_GATEWAY_SERVER_INFO_NAME, version: "1.0.0" };
const SUPPORTED_PROTOCOL = "2024-11-05";
const MAX_STDIN_CONTENT_LENGTH_BYTES = 16 * 1024 * 1024;
// Hard ceiling on accumulated, unframed stdin. A complete legal frame is
// consumed as soon as it arrives, so the buffer only approaches this when a
// writer streams bytes with no newline / short Content-Length body — 2x the
// frame max leaves room for one max-size body plus headers and pipelining.
const MAX_STDIN_BUFFER_BYTES = MAX_STDIN_CONTENT_LENGTH_BYTES * 2;
const scopeParseState = { invalid: false };
const ATLAS_LIVE_BUFFER_GATE = new AsyncResourceGate({ name: "ATLAS live buffer" });
const DETERMINISTIC_TOOL_GATE = new AsyncResourceGate({ name: "deterministic native tool" });
const DEFAULT_ATLAS_LIVE_BUFFER_TOOL_WAIT_MS = (() => {
  const parsed = Number(process.env.POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFER_TOOL_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
})();

function parseScopeEnvArray(env, key) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === "") return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    // handled below
  }
  scopeParseState.invalid = true;
  return [];
}

function envBootConfig(env = process.env) {
  return {
    cwd: String(env.POSSE_DETERMINISTIC_MCP_CWD || "").trim(),
    scopedFiles: parseScopeEnvArray(env, "POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES"),
    createFiles: parseScopeEnvArray(env, "POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES"),
    deleteFiles: parseScopeEnvArray(env, "POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES"),
    createRoots: parseScopeEnvArray(env, "POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS"),
    readRoots: parseScopeEnvArray(env, "POSSE_DETERMINISTIC_MCP_SCOPE_READ_ROOTS"),
    allowWrite: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ALLOW_WRITE),
    allowImageHelpers: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_HELPERS),
    allowImageGeneration: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION),
    role: String(env.POSSE_DETERMINISTIC_MCP_ROLE || "").trim(),
    providerName: String(env.POSSE_DETERMINISTIC_MCP_PROVIDER || env.POSSE_DETERMINISTIC_MCP_PROVIDER_NAME || "").trim(),
    disableSystemTools: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_DISABLE_SYSTEM_TOOLS),
    runId: String(env.POSSE_DETERMINISTIC_MCP_RUN_ID || "").trim(),
    toolLogPath: String(env.POSSE_DETERMINISTIC_MCP_TOOL_LOG_PATH || "").trim(),
    dbPath: String(env.POSSE_DETERMINISTIC_MCP_DB_PATH || "").trim(),
    jobId: String(env.POSSE_DETERMINISTIC_MCP_JOB_ID || "").trim(),
    workItemId: String(env.POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID || "").trim(),
    atlasAvailable: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE),
    atlasGateEnabled: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED),
    atlasPrefetchStatus: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_PREFETCH_STATUS || "").trim(),
    imageGenerationMaxCalls: String(env.POSSE_DETERMINISTIC_MCP_IMAGE_GENERATION_MAX_CALLS || "").trim(),
    atlas: {
      repoPath: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH || "").trim(),
      repoId: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID || "").trim(),
      graphDbPath: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_GRAPH_DB_PATH || "").trim(),
      liveBuffers: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFERS || env.POSSE_ATLAS_LIVE_BUFFERS || "").trim(),
      embeddingApiKey: String(env.POSSE_ATLAS_EMBEDDING_API_KEY || "").trim(),
    },
    remoteCatalog: {
      enabled: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED),
      mode: String(env.POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE || "").trim(),
      baseUrl: String(env.POSSE_REMOTE_URL || env.POSSE_REMOTE_BASE_URL || "").trim(),
      timeoutMs: String(env.POSSE_REMOTE_TIMEOUT_MS || "").trim(),
      requestedSuites: String(env.POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
  };
}

function parseBootConfig(argv = process.argv) {
  const index = argv.indexOf("--config-json");
  if (index < 0 || !argv[index + 1]) return envBootConfig();
  try {
    const json = Buffer.from(String(argv[index + 1]), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    scopeParseState.invalid = true;
    return {};
  }
}

function bootConfigFromOAuthToken(config = {}) {
  const token = String(
    config.mcpOAuthToken
    || config.mcpOauthToken
    || config.mcpAuth?.accessToken
    || config.mcpAuth?.token
    || "",
  ).trim();
  if (!token) return config;
  try {
    const claims = verifyMcpOAuthToken(token);
    return {
      ...config,
      ...bootConfigFromMcpOAuthClaims(claims),
      mcpOAuth: {
        verified: true,
        tokenId: claims.jti || null,
        expiresAt: claims.exp || null,
      },
    };
  } catch (err) {
    scopeParseState.invalid = true;
    return {
      cwd: String(config.cwd || "").trim(),
      dbPath: String(config.dbPath || "").trim(),
      role: "",
      providerName: "",
      scopedFiles: [],
      createFiles: [],
      deleteFiles: [],
      createRoots: [],
      readRoots: [],
      allowWrite: false,
      allowImageHelpers: false,
      allowImageGeneration: false,
      disableSystemTools: true,
      atlasAvailable: false,
      atlasGateEnabled: false,
      atlasPrefetchStatus: "",
      atlas: {},
      remoteCatalog: { enabled: false },
      nativeAuth: config.nativeAuth,
      mcpOAuth: {
        verified: false,
        errorCode: err?.code || "invalid_token",
        error: String(err?.message || err),
      },
    };
  }
}

let bootConfig = bootConfigFromOAuthToken(parseBootConfig());
const ownerHotProcess = bootConfig.ownerHotGateway === true;
let ownerHotGateway = ownerHotProcess || bootConfig.ownerHotGateway === true;
let workspaceCwd = String(bootConfig.cwd || "").trim() || process.cwd();
let allowWrite = bootConfig.allowWrite === true || ownerHotGateway;
// db-mode dev jobs run with allowWrite=false (no file tools) but carry the
// projectDbWrite capability: project_db_query stays on the write lane.
let projectDbWrite = bootConfig.projectDbWrite === true;
let allowImageHelpers = bootConfig.allowImageHelpers === true || ownerHotGateway;
let allowImageGeneration = bootConfig.allowImageGeneration === true || ownerHotGateway;
let roleName = String(bootConfig.role || "").trim() || null;
let isResearcherRole = roleName === "researcher";
let providerName = String(bootConfig.providerName || "").trim() || null;
let runId = String(bootConfig.runId || "").trim() || null;
let toolLogPath = String(bootConfig.toolLogPath || "").trim() || null;
let mcpDbPath = String(bootConfig.dbPath || "").trim() || null;
let mcpJobId = Number(bootConfig.jobId) || null;
let mcpWorkItemId = Number(bootConfig.workItemId) || null;
// True while handling a message that carried its own hidden session param
// (owner-hot per-message scoping). See handleRequest.
let mcpMessageSessionScoped = false;
// Attempt scoping for the live operator channel: with it, get_operator_feedback
// takes the transactional once-per-attempt delivery branch with audit rows —
// the same semantics as the embedded transport (they used to diverge:
// unbounded re-delivery and zero delivery audit on MCP).
let mcpAttemptId = Number(bootConfig.attemptId) || null;
let atlasAvailable = bootConfig.atlasAvailable === true;
let atlasGateEnabled = bootConfig.atlasGateEnabled === true;
let atlasPrefetchStatus = String(bootConfig.atlasPrefetchStatus || "").trim().toLowerCase();
let gateBootedAtMs = Date.now();
// Fail-open deadman: if ATLAS-first gate remains locked while ATLAS calls are
// stuck/cancelled in the host bridge, unlock native tools to avoid permanent
// job deadlock. Keep this short so blocked runs recover promptly.
const GATE_FAIL_OPEN_MS = 15000;
let imageGenerationMaxCalls = Number.isInteger(Number(bootConfig.imageGenerationMaxCalls)) && Number(bootConfig.imageGenerationMaxCalls) >= 0
  ? Number(bootConfig.imageGenerationMaxCalls)
  : 12;
let imageGenerationCallCount = 0;
let remoteToolCatalogConfig = bootConfig.remoteCatalog && typeof bootConfig.remoteCatalog === "object"
  ? bootConfig.remoteCatalog
  : {};
let remoteToolCatalogPreload = bootConfig.remoteToolSurface && typeof bootConfig.remoteToolSurface === "object"
  ? bootConfig.remoteToolSurface
  : null;
const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
const RESEARCH_NATIVE_EXPLORATION_TOOLS = new Set([
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
]);
const RESEARCH_NATIVE_SYNTHESIS_GATED_TOOLS = new Set([
  "chain_read",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
]);

if (mcpDbPath) {
  setRuntimePathOverrides({ dbPath: mcpDbPath });
}

// Native-binary auth: when the parent supplied a non-secret heartbeat capability
// (config-json boots), install it as this child's auth authority so ATLAS/git
// native calls share the parent's heartbeat envelope. Current compiled helpers
// still need the manager-owned compatibility launch key; raw POSSE_KEY is
// scrubbed from native child env and never resolved per leaf call.
if (!ownerHotProcess && bootConfig.nativeAuth && typeof bootConfig.nativeAuth === "object") {
  try {
    nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(bootConfig.nativeAuth));
  } catch { /* best effort: leave the default manager in place */ }
}

// Tag all tool observations with the job context so the display can query by job_id
if (mcpJobId || mcpWorkItemId) {
  enterObservationContext({ work_item_id: mcpWorkItemId, job_id: mcpJobId });
}

let scopePredicates = buildScopePredicates(workspaceCwd, {
  modifyFiles: Array.isArray(bootConfig.scopedFiles) ? bootConfig.scopedFiles : [],
  createFiles: Array.isArray(bootConfig.createFiles) ? bootConfig.createFiles : [],
  deleteFiles: Array.isArray(bootConfig.deleteFiles) ? bootConfig.deleteFiles : [],
  createRoots: Array.isArray(bootConfig.createRoots) ? bootConfig.createRoots : [],
  readRoots: Array.isArray(bootConfig.readRoots) ? bootConfig.readRoots : [],
});
let declaredJobScope = Object.freeze({
  modifyFiles: Array.isArray(bootConfig.scopedFiles) ? [...bootConfig.scopedFiles] : [],
  createFiles: Array.isArray(bootConfig.createFiles) ? [...bootConfig.createFiles] : [],
  deleteFiles: Array.isArray(bootConfig.deleteFiles) ? [...bootConfig.deleteFiles] : [],
  createRoots: Array.isArray(bootConfig.createRoots) ? [...bootConfig.createRoots] : [],
  readRoots: Array.isArray(bootConfig.readRoots) ? [...bootConfig.readRoots] : [],
});
if (scopeParseState.invalid) {
  appendToolLog({
    event: "scope_parse_invalid",
    error: "One or more scope env JSON values were malformed; forcing write-disabled scope.",
  });
}
let writeEnabled = allowWrite && !scopeParseState.invalid;
let effectiveScopePredicates = scopeParseState.invalid
  ? {
    canEdit: () => false,
    canCreate: () => false,
    isWithinScopeRoot: () => false,
    hasScope: true,
  }
  : scopePredicates;

// Tight-loop duplicate read guard:
// Short-circuit identical read_file calls against unchanged files.
const READ_DEDUPE_WINDOW_MS = 8000;
let _lastReadMeta = null;

// ── ATLAS-first gate + gateway ATLAS proxy ────────────────────────────────────
// This single MCP process is a neutral gateway: native deterministic tools and
// ATLAS tools are separate suites on one transport. When ATLAS is available,
// the gateway forwards atlas.* calls to the native v2 ledger/view backend. The
// proxy notifies the gate, which locks deterministic research fallback tools
// until the agent makes the required real ATLAS retrieval calls after prefetch,
// or until ATLAS is unavailable. Scoped write, shell, verification, and artifact
// tools keep their normal scope/security checks but are not ATLAS-gated.
// Researcher, planner, dev, and assessor are all gated; artificer/delegator
// are exempt. Both modules live under ./deterministic-mcp/.
let gateScopeKey = configureGate({
  role: roleName,
  atlasAvailable,
  enabled: atlasGateEnabled,
  atlasLabel: atlasBackendLabel(atlasAvailable ? getAtlasIntegrationConfig() : null),
  scopeKey: gateScopeKeyForBootConfig(bootConfig),
});
if (atlasAvailable && isFallbackAtlasPrefetchStatus(atlasPrefetchStatus)) {
  unlockForAtlasUnavailable({ reason: `prefetch_${atlasPrefetchStatus}`, scopeKey: gateScopeKey });
}
appendToolLog({
  event: "atlas_gate_posture",
  atlasAvailable,
  atlasGateEnabled,
  gateActive: isGateActive({ scopeKey: gateScopeKey }),
  posture: atlasAvailable
    ? (atlasGateEnabled ? "tool-gated" : "prefetch-only")
    : "unavailable",
  role: roleName,
  atlasPrefetchStatus: atlasPrefetchStatus || null,
});
if (atlasAvailable && !atlasGateEnabled) {
  appendToolLog({
    event: "atlas_gate_passive_warning",
    message: "ATLAS is available but atlas_tool_gate_enabled=false; agents can use native list/search/read before real ATLAS retrieval.",
    role: roleName,
  });
}

function getDeterministicAtlasConfig() {
  const base = getAtlasIntegrationConfig();
  const atlasConfig = bootConfig.atlas && typeof bootConfig.atlas === "object" ? bootConfig.atlas : {};
  const repoPath = bootString(atlasConfig.repoPath);
  const repoId = bootString(atlasConfig.repoId);
  const graphDbPath = bootString(atlasConfig.graphDbPath);
  const semanticEnabled = typeof atlasConfig.semanticEnabled === "boolean" ? atlasConfig.semanticEnabled : null;
  const vectorBackend = bootString(atlasConfig.vectorBackend);
  const viewWaitMs = bootString(atlasConfig.viewWaitMs);
  const autoRefreshStale = typeof atlasConfig.autoRefreshStale === "boolean"
    ? atlasConfig.autoRefreshStale
    : parseBoolOverride(atlasConfig.autoRefreshStale);
  const embeddingProvider = bootString(atlasConfig.embeddingProvider);
  const embeddingEndpoint = bootString(atlasConfig.embeddingEndpoint);
  const embeddingModel = bootString(atlasConfig.embeddingModel);
  const embeddingDim = bootString(atlasConfig.embeddingDim);
  // Provider credentials are the one ATLAS config value that remains env-backed:
  // boot config is passed as process args, so it must stay non-secret.
  const embeddingApiKey = String(atlasConfig.embeddingApiKey || process.env.POSSE_ATLAS_EMBEDDING_API_KEY || "").trim();
  const embeddingModelVersion = bootString(atlasConfig.embeddingModelVersion);
  const embeddingTimeoutMs = bootString(atlasConfig.embeddingTimeoutMs);
  const embeddingHeaders = bootHeadersOverride(atlasConfig.embeddingHeaders);
  const embeddingSendDimensions = typeof atlasConfig.embeddingSendDimensions === "boolean"
    ? atlasConfig.embeddingSendDimensions
    : parseBoolOverride(atlasConfig.embeddingSendDimensions);
  const remoteEncoderMode = bootString(atlasConfig.remoteEncoderMode);
  const remoteEncoderUrl = bootString(atlasConfig.remoteEncoderUrl);
  const remoteEncoderModel = bootString(atlasConfig.remoteEncoderModel);
  const remoteEncoderDim = bootString(atlasConfig.remoteEncoderDim);
  const remoteEncoderModelVersion = bootString(atlasConfig.remoteEncoderModelVersion);
  const remoteEncoderTimeoutMs = bootString(atlasConfig.remoteEncoderTimeoutMs);
  if (
    !repoPath
    && !repoId
    && !graphDbPath
    && semanticEnabled == null
    && !vectorBackend
    && !viewWaitMs
    && autoRefreshStale == null
    && !embeddingProvider
    && !embeddingEndpoint
    && !embeddingModel
    && !embeddingDim
    && !embeddingApiKey
    && !embeddingModelVersion
    && !embeddingTimeoutMs
    && embeddingHeaders == null
    && embeddingSendDimensions == null
    && !remoteEncoderMode
    && !remoteEncoderUrl
    && !remoteEncoderModel
    && !remoteEncoderDim
    && !remoteEncoderModelVersion
    && !remoteEncoderTimeoutMs
  ) return base;
  return {
    ...base,
    requestedRepoPath: repoPath ? path.resolve(repoPath) : base.requestedRepoPath,
    requestedRepoId: repoId || base.requestedRepoId,
    requestedGraphDbPath: graphDbPath ? path.resolve(graphDbPath) : base.requestedGraphDbPath,
    semanticEnabled: semanticEnabled == null ? base.semanticEnabled : semanticEnabled,
    vectorBackend: vectorBackend || base.vectorBackend,
    viewWaitMs: viewWaitMs === "" ? base.viewWaitMs : viewWaitMs,
    autoRefreshStale: autoRefreshStale == null ? base.autoRefreshStale : autoRefreshStale,
    embeddingProvider: embeddingProvider || base.embeddingProvider,
    atlasEmbeddingProvider: embeddingProvider || base.atlasEmbeddingProvider,
    embeddingEndpoint: embeddingEndpoint || base.embeddingEndpoint,
    embeddingModel: embeddingModel || base.embeddingModel,
    embeddingDim: embeddingDim === "" ? base.embeddingDim : embeddingDim,
    embeddingApiKey: embeddingApiKey || base.embeddingApiKey,
    embeddingModelVersion: embeddingModelVersion === "" ? base.embeddingModelVersion : embeddingModelVersion,
    embeddingTimeoutMs: embeddingTimeoutMs === "" ? base.embeddingTimeoutMs : embeddingTimeoutMs,
    embeddingHeaders: embeddingHeaders == null ? base.embeddingHeaders : embeddingHeaders,
    embeddingSendDimensions: embeddingSendDimensions == null ? base.embeddingSendDimensions : embeddingSendDimensions,
    remoteEncoderMode: remoteEncoderMode || base.remoteEncoderMode,
    remoteEncoderUrl: remoteEncoderUrl || base.remoteEncoderUrl,
    remoteEncoderModel: remoteEncoderModel || base.remoteEncoderModel,
    remoteEncoderDim: remoteEncoderDim === "" ? base.remoteEncoderDim : remoteEncoderDim,
    remoteEncoderModelVersion: remoteEncoderModelVersion === "" ? base.remoteEncoderModelVersion : remoteEncoderModelVersion,
    remoteEncoderTimeoutMs: remoteEncoderTimeoutMs === "" ? base.remoteEncoderTimeoutMs : remoteEncoderTimeoutMs,
  };
}

function getDeterministicAtlasRepoTarget(atlasCfg = getDeterministicAtlasConfig()) {
  try {
    return resolveAtlasRepoTarget({ cwd: workspaceCwd, config: atlasCfg });
  } catch {
    return {
      repoPath: atlasCfg?.requestedRepoPath || workspaceCwd,
      repoId: atlasCfg?.requestedRepoId || null,
      source: "fallback",
      ready: true,
    };
  }
}

let _atlasMemoryCountResolved = false;
let _atlasMemoryCount = null;
function getAtlasMemoryCountForRemoteCatalog() {
  if (_atlasMemoryCountResolved) return _atlasMemoryCount;
  _atlasMemoryCountResolved = true;

  const explicit = nonNegativeIntegerOrNull(
    bootConfig?.atlas?.memoryStats?.memories
    ?? bootConfig?.atlas?.memory_count
    ?? bootConfig?.atlas?.memoryCount
    ?? bootConfig?.atlas?.memories,
  );
  if (explicit != null) {
    _atlasMemoryCount = explicit;
    return _atlasMemoryCount;
  }

  // ATLAS storage reads belong to the owner/conductor lane. The MCP gateway can
  // surface explicit boot metadata, but should not open the ledger for catalog
  // decoration.
  return null;
}

function getDeterministicAtlasBranch() {
  if (mcpWorkItemId != null) return `wi-${mcpWorkItemId}`;
  return null;
}

// Optional compatibility fallback for local ATLAS route libraries. In
// remote-required mode, the remote catalog is the authority and this stays
// null; local schemas/descriptors still execute tools after remote issuance.
let _atlasAllowedActions = null;
function _stripAtlasPrefix(name) {
  const raw = String(name || "");
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

function _normalizeAtlasToolRequestName(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas_")) return `atlas.${_normalizeAtlasActionForAllowlist(raw)}`;
  return raw;
}

function _normalizeGatewayToolRequestName(name) {
  const stripped = stripPosseMcpGatewayPrefix(name);
  return _normalizeAtlasToolRequestName(stripped);
}

const STATIC_ATLAS_TOOL_SCHEMAS = Object.freeze(Object.entries(SURFACED_ATLAS_TOOL_DEFS)
  .filter(([action]) => ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (action)))
  .map(([action, def]) => Object.freeze({
    name: `atlas.${action}`,
    description: def.description,
    inputSchema: def.parameters || { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: `ATLAS ${action}` },
  })));
const STATIC_ATLAS_TOOL_NAMES = new Set(STATIC_ATLAS_TOOL_SCHEMAS.map((tool) => tool.name));

function getStaticAtlasToolSchemas() {
  return STATIC_ATLAS_TOOL_SCHEMAS.map((schema) => ({ ...schema, annotations: { ...(schema.annotations || {}) } }));
}

function isStaticAtlasToolName(toolName) {
  return STATIC_ATLAS_TOOL_NAMES.has(String(toolName || ""));
}

const ATLAS_GATEWAY_TOOL_NAMES = new Set(["query", "code", "repo", "agent"]);

function _normalizeAtlasActionForAllowlist(name) {
  const value = String(name || "").trim();
  const raw = value.startsWith("atlas.")
    ? value.slice("atlas.".length).trim()
    : (value.startsWith("atlas_") ? value.slice("atlas_".length).trim() : value);
  if (!raw) return "";
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (raw))) return raw;
  const dotted = raw.replace(/^atlas_/, "").replace(/_/g, ".").trim();
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (dotted))) return dotted;
  const lowered = dotted.toLowerCase();
  for (const action of ATLAS_TOOL_ACTIONS) {
    if (String(action).toLowerCase() === lowered) return action;
  }
  return raw;
}

function _effectiveAtlasActionForAllowlist(toolName, args = {}) {
  const outer = _normalizeAtlasActionForAllowlist(toolName);
  if (!ATLAS_GATEWAY_TOOL_NAMES.has(outer)) return outer;
  const nested = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  return nested ? _normalizeAtlasActionForAllowlist(nested) : outer;
}

function _atlasCallAllowedByRoute(toolName, args, atlasAllowedActions) {
  const effectiveAction = _effectiveAtlasActionForAllowlist(toolName, args);
  return {
    effectiveAction,
    allowed: !!effectiveAction && atlasAllowedActions?.has(effectiveAction),
  };
}

function tokenToolAllowlistForSuite(suiteName) {
  const suite = String(suiteName || "").trim();
  const allowlist = bootConfig?.toolAllowlist;
  if (!suite || !allowlist || typeof allowlist !== "object" || Array.isArray(allowlist)) return null;
  const names = allowlist[suite];
  if (!Array.isArray(names)) return new Set();
  return new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
}

function hasTokenToolAllowlist() {
  return !!(bootConfig?.toolAllowlist && typeof bootConfig.toolAllowlist === "object" && !Array.isArray(bootConfig.toolAllowlist));
}

if (atlasAvailable && roleName) {
  if (hasTokenToolAllowlist()) {
    _atlasAllowedActions = tokenToolAllowlistForSuite("atlas");
  } else if (!remoteToolCatalogRequired()) {
    try {
      const route = getAtlasRouteForRole(roleName, { config: getDeterministicAtlasConfig() });
      if (route?.tools?.length > 0) {
        _atlasAllowedActions = new Set(route.tools.map(_stripAtlasPrefix).filter(isExternallyRoutedAtlasTool));
      } else {
        _atlasAllowedActions = new Set();
      }
    } catch {
      _atlasAllowedActions = new Set();
    }
  }
}

if (!remoteToolCatalogEnabled() && atlasAvailable && roleName && _atlasAllowedActions?.size === 0) {
  unlockForAtlasUnavailable({ reason: "atlas_no_allowed_actions", scopeKey: gateScopeKey });
}

let _remoteToolCatalogPromise = null;
let _remoteToolCatalogCache = null;
let _remoteToolSurfaceRequest = null;

function remoteToolCatalogEnabled() {
  return remoteToolCatalogConfig.enabled === true
    && !!String(remoteToolCatalogConfig.baseUrl || "").trim()
    && typeof fetch === "function";
}

function remoteToolCatalogRequired() {
  return String(remoteToolCatalogConfig.mode || "").trim().toLowerCase() === "required";
}

function remoteToolSurfaceUrl() {
  return `${String(remoteToolCatalogConfig.baseUrl || "").replace(/\/+$/, "")}/v1/catalog/tool-surface`;
}

function remoteToolCatalogTimeoutMs() {
  const parsed = Number(remoteToolCatalogConfig.timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
}

function resolveRemoteCatalogApiKey() {
  return resolvePosseKey();
}

function remoteToolCatalogCacheKey(request) {
  return JSON.stringify({
    url: remoteToolSurfaceUrl(),
    mode: String(remoteToolCatalogConfig.mode || "").trim().toLowerCase(),
    request,
  });
}

function preloadedRemoteToolCatalog() {
  if (!remoteToolCatalogPreload || !Array.isArray(remoteToolCatalogPreload.tools)) return null;
  return remoteToolCatalogPreload;
}

function remoteToolCatalogUnavailableError() {
  const err = new Error(
    `Required remote tool catalog unavailable for ${providerName || "unknown-provider"}/${roleName || "unknown-role"}; refusing to expose an empty MCP tool surface.`,
  );
  err.code = "POSSE_REMOTE_TOOL_CATALOG_UNAVAILABLE";
  return err;
}

function sendRemoteToolCatalogError(id, err, operation) {
  const safeError = capString(err?.message || String(err), 300);
  appendToolLog({
    event: "remote_tool_surface_required_unavailable",
    operation,
    error: safeError,
    code: err?.code || null,
  });
  sendMessage(jsonRpcError(id, -32040, safeError, {
    code: err?.code || "POSSE_REMOTE_TOOL_CATALOG_UNAVAILABLE",
    operation,
  }));
}

async function fetchRemoteToolCatalog() {
  if (!remoteToolCatalogEnabled()) return null;
  const request = buildRemoteToolSurfaceRequest();
  const cacheKey = remoteToolCatalogCacheKey(request);
  const preloadedCatalog = preloadedRemoteToolCatalog();
  if (preloadedCatalog) {
    _remoteToolCatalogCache = { key: cacheKey, catalog: preloadedCatalog };
    appendToolLog({
      event: "remote_tool_surface_preloaded",
      source: "posse-remote",
      suiteCount: Array.isArray(preloadedCatalog?.suites) ? preloadedCatalog.suites.length : 0,
      toolCount: Array.isArray(preloadedCatalog?.tools) ? preloadedCatalog.tools.length : 0,
    });
    return preloadedCatalog;
  }
  if (_remoteToolCatalogCache?.key === cacheKey) {
    appendToolLog({
      event: "remote_tool_surface_cache_hit",
      source: "posse-remote",
      suiteCount: Array.isArray(_remoteToolCatalogCache.catalog?.suites) ? _remoteToolCatalogCache.catalog.suites.length : 0,
      toolCount: Array.isArray(_remoteToolCatalogCache.catalog?.tools) ? _remoteToolCatalogCache.catalog.tools.length : 0,
    });
    return _remoteToolCatalogCache.catalog;
  }
  if (_remoteToolCatalogPromise?.key === cacheKey) return await _remoteToolCatalogPromise.promise;
  _remoteToolCatalogPromise = {
    key: cacheKey,
    promise: (async () => {
      const url = remoteToolSurfaceUrl();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), remoteToolCatalogTimeoutMs());
      try {
        const headers = { "content-type": "application/json" };
        const apiKey = resolveRemoteCatalogApiKey();
        if (apiKey) {
          assertSafeRemoteAuthUrl(url, apiKey, "remote tool catalog");
          headers.authorization = `Bearer ${apiKey}`;
        }
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: ac.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        // Same 1MB response cap as every other posse-remote call; a bare
        // response.json() would buffer an unbounded body.
        const text = await readResponseTextWithLimit(response, {
          operation: "remote tool catalog",
          url,
        });
        const catalog = text ? JSON.parse(text) : null;
        const remoteToolCatalog = catalog && typeof catalog === "object" ? catalog : null;
        if (remoteToolCatalog) {
          _remoteToolCatalogCache = { key: cacheKey, catalog: remoteToolCatalog };
        }
        appendToolLog({
          event: "remote_tool_surface_loaded",
          source: "posse-remote",
          suiteCount: Array.isArray(remoteToolCatalog?.suites) ? remoteToolCatalog.suites.length : 0,
          toolCount: Array.isArray(remoteToolCatalog?.tools) ? remoteToolCatalog.tools.length : 0,
        });
        return remoteToolCatalog;
      } catch (err) {
        appendToolLog({
          event: "remote_tool_surface_unavailable",
          error: capString(err?.message || String(err), 300),
        });
        return null;
      } finally {
        clearTimeout(timer);
        _remoteToolCatalogPromise = null;
      }
    })(),
  };
  return await _remoteToolCatalogPromise.promise;
}

function requestedRemoteToolSuites() {
  const configured = Array.isArray(remoteToolCatalogConfig.requestedSuites)
    ? remoteToolCatalogConfig.requestedSuites
    : [];
  const suites = configured.length > 0
    ? configured
    : ["tools", ...(atlasAvailable ? ["atlas"] : [])];
  const out = [];
  for (const suite of suites) {
    const normalized = String(suite || "").trim().toLowerCase();
    const value = normalized === "deterministic" ? "tools" : normalized;
    if ((value === "tools" || value === "atlas") && !out.includes(value)) out.push(value);
  }
  return out;
}

function buildRemoteToolSurfaceRequest() {
  if (_remoteToolSurfaceRequest) return _remoteToolSurfaceRequest;
  const claims = buildMcpOAuthClaimsFromBootConfig(bootConfig);
  const capabilities = claims.capabilities && typeof claims.capabilities === "object"
    ? claims.capabilities
    : {};
  const atlasCapabilities = {
    available: atlasAvailable,
    backend: atlasAvailable ? "v2" : "",
  };
  const memoryCount = getAtlasMemoryCountForRemoteCatalog();
  if (memoryCount != null) atlasCapabilities.memory_count = memoryCount;

  _remoteToolSurfaceRequest = {
    role: roleName || "",
    provider: providerName || "",
    requested_suites: requestedRemoteToolSuites(),
    local_capabilities: {
      tools: {
        read: true,
        write: writeEnabled,
        shell: allowBash,
        image_generation: allowImageGeneration,
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
  return _remoteToolSurfaceRequest;
}

function _stripToolsPrefix(name) {
  const raw = _normalizeGatewayToolRequestName(name);
  if (raw.startsWith("tools.")) return raw.slice("tools.".length);
  if (raw.startsWith("tools_")) return raw.slice("tools_".length);
  return raw;
}

function remoteSurfaceToolEntries(catalog, suite) {
  const target = String(suite || "").trim().toLowerCase();
  return (Array.isArray(catalog?.tools) ? catalog.tools : [])
    .filter((entry) => String(entry?.suite || "").trim().toLowerCase() === target);
}

function remoteNativeToolNames(catalog) {
  return remoteSurfaceToolEntries(catalog, "tools")
    .map((entry) => _stripToolsPrefix(entry?.local_name || entry?.name))
    .filter(Boolean);
}

function remoteAtlasRouteTools(catalog) {
  return remoteSurfaceToolEntries(catalog, "atlas")
    .map((entry) => _stripAtlasPrefix(entry?.local_name || entry?.name))
    .filter(isExternallyRoutedAtlasTool)
    .filter(Boolean);
}

async function resolveNativeAllowedToolNames() {
  if (ownerHotGateway) return null;
  if (hasTokenToolAllowlist()) return tokenToolAllowlistForSuite("tools");
  if (!remoteToolCatalogEnabled()) return null;
  const catalog = await fetchRemoteToolCatalog();
  if (catalog && Array.isArray(catalog.tools)) {
    return new Set(remoteNativeToolNames(catalog));
  }
  if (remoteToolCatalogRequired()) throw remoteToolCatalogUnavailableError();
  return null;
}

async function resolveAtlasAllowedActions() {
  if (ownerHotGateway && atlasAvailable) return new Set(ATLAS_TOOL_ACTIONS.filter(isExternallyRoutedAtlasTool));
  if (hasTokenToolAllowlist()) return tokenToolAllowlistForSuite("atlas");
  if (!atlasAvailable || !roleName) return _atlasAllowedActions;
  const catalog = await fetchRemoteToolCatalog();
  if (catalog && Array.isArray(catalog.tools)) return new Set(remoteAtlasRouteTools(catalog));
  if (remoteToolCatalogRequired()) throw remoteToolCatalogUnavailableError();
  return _atlasAllowedActions;
}

function appendToolLog(entry = {}) {
  if (!toolLogPath) return;
  try {
    fs.mkdirSync(path.dirname(toolLogPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      provider: providerName,
      role: roleName,
      runId,
      cwd: workspaceCwd,
      ...entry,
    };
    fs.appendFileSync(toolLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Logging must never break tool execution.
  }
}

function maybeFailOpenLockedGate(reason = "limbo_timeout") {
  try {
    if (!isGateActive({ scopeKey: gateScopeKey }) || isGateUnlocked({ scopeKey: gateScopeKey })) return false;
    if ((Date.now() - gateBootedAtMs) < GATE_FAIL_OPEN_MS) return false;
    unlockForAtlasUnavailable({ reason, scopeKey: gateScopeKey });
    appendToolLog({
      event: "atlas_gate_fail_open",
      reason,
      elapsedMs: Date.now() - gateBootedAtMs,
      role: roleName,
    });
    return true;
  } catch {
    return false;
  }
}

const {
  execReadFile,
  execWriteFile,
  execEditFile,
  execListFiles,
  execSearchFiles,
  execGitHistory,
  execInspectFile,
  execHashFile,
  execReadImageMetadata,
  execValidateArtifactOutput,
  execPruneArtifactOutput,
  execCleanImage,
  execExtractImageText,
  execRunScopedChecks,
  execCreateTestSuite,
  execCreateTest,
  execRunTest,
  execRunTestSuite,
  execGetBrief,
} = createDeterministicToolkit({ safePath, skipObservationLogging: true });

function _normalizeReadRange(argVal, fallback) {
  const n = Number.parseInt(String(argVal ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function _buildReadDedupeKey(args = {}) {
  const relPath = String(args.path || "").replace(/\\/g, "/");
  const offset = _normalizeReadRange(args.offset, 1);
  const limit = _normalizeReadRange(args.limit, 2000);
  const structured = [
    args.maxBytes == null ? "" : `maxBytes=${args.maxBytes}`,
    args.search == null ? "" : `search=${args.search}`,
    args.searchContext == null ? "" : `searchContext=${args.searchContext}`,
    args.jsonPath == null ? "" : `jsonPath=${args.jsonPath}`,
  ].filter(Boolean).join("|");
  return `${relPath}|${offset}|${limit}|${structured}`;
}

function _statReadTarget(args = {}) {
  try {
    const fullPath = safePath(workspaceCwd, args.path, effectiveScopePredicates);
    if (!fs.existsSync(fullPath)) return null;
    const st = fs.statSync(fullPath);
    if (!st.isFile()) return null;
    return {
      fullPath,
      size: Number(st.size || 0),
      mtimeMs: Number(st.mtimeMs || 0),
    };
  } catch {
    return null;
  }
}

function dedupeReadFile(args = {}) {
  const normalizedArgs = args || {};
  const now = Date.now();
  const key = _buildReadDedupeKey(normalizedArgs);
  const stat = _statReadTarget(normalizedArgs);
  if (
    READ_DEDUPE_WINDOW_MS > 0
    && _lastReadMeta
    && _lastReadMeta.key === key
    && (now - _lastReadMeta.atMs) <= READ_DEDUPE_WINDOW_MS
    && stat
    && _lastReadMeta.path === stat.fullPath
    && _lastReadMeta.size === stat.size
    && _lastReadMeta.mtimeMs === stat.mtimeMs
  ) {
    const elapsed = Math.max(0, now - _lastReadMeta.atMs);
    return `Duplicate read suppressed: ${normalizedArgs.path} (same range, unchanged file, ${elapsed}ms since last read). Reuse the previous read result or change offset/limit.`;
  }

  const result = execReadFile(normalizedArgs, workspaceCwd, effectiveScopePredicates);
  if (typeof result === "string" && !/^Error:/i.test(result)) {
    _lastReadMeta = {
      key,
      atMs: now,
      path: stat?.fullPath || null,
      size: stat?.size ?? null,
      mtimeMs: stat?.mtimeMs ?? null,
    };
  } else {
    _lastReadMeta = null;
  }
  return result;
}

let allowBash = ownerHotGateway || ["dev", "artificer", "assessor"].includes(roleName);
let execBash = allowBash ? createBashExecutor() : null;
// Opt-in project DB access: advertised + attached only when this repo has it
// configured (enabled + a db type + a grant usable by this session's
// capability lane — write sessions take the full grant, read sessions need
// the `read` permission). Off by default.
function projectDbCapability() {
  return (writeEnabled || projectDbWrite) ? "write" : "read";
}
function computeProjectDbAccessEnabled() {
  try {
    const cfg = readProjectDbConfig({ projectDir: workspaceCwd });
    if (!cfg.enabled || !cfg.dbType) return false;
    return capProjectDbPermissions(cfg.permissions, projectDbCapability()).length > 0;
  } catch {
    return false;
  }
}
let projectDbAccessEnabled = computeProjectDbAccessEnabled();
const WRITE_TOOL_NAMES = new Set(DETERMINISTIC_WRITE_TOOLS);
const IMAGE_HELPER_TOOL_NAMES = new Set(DETERMINISTIC_IMAGE_HELPER_TOOLS);
const IMAGE_GENERATION_TOOL_NAMES = new Set(DETERMINISTIC_IMAGE_TOOLS);
const OCR_TOOL_NAMES = new Set(DETERMINISTIC_OCR_TOOLS);

const ALL_NATIVE_TOOL_NAMES = Object.freeze([
  "read_file",
  "chain_read",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
  // Planner-only pre-staged research brief bundle. Has an executor attached
  // below; without it here the owner-hot gateway never declares it and a
  // planner issued get_brief by the remote surface gets "No such tool".
  "get_brief",
  // Monitor Agents live-channel coordination tools. These are always-present,
  // budget-exempt tools the owner-hot gateway must advertise so every role can
  // actually CALL them — without this they are attached as executors but never
  // declared, so tools/list omits them and the agent gets "No such tool available".
  "agent_feedback",
  "get_operator_feedback",
  "ack_operator_feedback",
  "write_file",
  "edit_file",
  "prune_artifact_output",
  "move_file",
  "copy_file",
  "make_dir",
  "bash",
  "run_scoped_checks",
  "create_test_suite",
  "create_test",
  "run_test",
  "run_test_suite",
  "read_image_metadata",
  "validate_artifact_output",
  "clean_image",
  "extract_image_text",
  "generate_image",
  // Opt-in; runtimeToolAvailable() keeps it filtered out unless this repo has
  // project DB access configured.
  "project_db_query",
]);

function legacyToolNamesForUnscopedRole() {
  return [
    "read_file",
    "list_files",
    "search_files",
    "git_history",
    "inspect_file",
    "hash_file",
    "agent_feedback",
    "get_operator_feedback",
    "ack_operator_feedback",
    ...(writeEnabled ? [...WRITE_TOOL_NAMES] : []),
    ...(allowBash ? ["bash"] : []),
    ...(allowImageHelpers ? [...IMAGE_HELPER_TOOL_NAMES] : []),
    ...(allowImageHelpers ? [...OCR_TOOL_NAMES] : []),
    ...(allowImageGeneration ? [...IMAGE_GENERATION_TOOL_NAMES] : []),
    ...(projectDbAccessEnabled ? ["project_db_query"] : []),
  ];
}

function runtimeToolAvailable(toolName) {
  if (WRITE_TOOL_NAMES.has(toolName)) return writeEnabled;
  if (IMAGE_HELPER_TOOL_NAMES.has(toolName)) return allowImageHelpers;
  if (OCR_TOOL_NAMES.has(toolName)) return allowImageHelpers;
  if (IMAGE_GENERATION_TOOL_NAMES.has(toolName)) return allowImageGeneration;
  if (toolName === "bash") return allowBash;
  if (toolName === "project_db_query") return projectDbAccessEnabled;
  return true;
}

let DECLARED_NATIVE_TOOL_NAMES = (ownerHotGateway
  ? [...ALL_NATIVE_TOOL_NAMES]
  : (hasTokenToolAllowlist()
    ? [...(tokenToolAllowlistForSuite("tools") || new Set())]
  : (roleName
    ? getDeterministicMcpToolNames(roleName, { needsImageGeneration: allowImageGeneration })
    : legacyToolNamesForUnscopedRole()))
).filter(runtimeToolAvailable);
let DECLARED_NATIVE_TOOL_NAME_SET = new Set(DECLARED_NATIVE_TOOL_NAMES);


let TOOL_SCHEMAS = [];
function addToolSchema(schema) {
  const toolName = schema?.name;
  if (DECLARED_NATIVE_TOOL_NAME_SET.has(toolName) && runtimeToolAvailable(toolName)) {
    TOOL_SCHEMAS.push(schema);
  }
}

// Researcher gets chain_read + chain_verdict instead of read_file — enforces the audit ledger.
// Owner-hot mode keeps every tool implementation loaded; per-session shims/owner
// gates decide which of these schemas an agent sees and may call.
if (ownerHotGateway) {
  addToolSchema(TOOL_READ_FILE);
  addToolSchema(TOOL_CHAIN_READ);
  addToolSchema(TOOL_CHAIN_VERDICT);
} else if (isResearcherRole) {
  addToolSchema(TOOL_CHAIN_READ);
  addToolSchema(TOOL_CHAIN_VERDICT);
} else {
  addToolSchema(TOOL_READ_FILE);
}
for (const schema of [TOOL_LIST_FILES, TOOL_SEARCH_FILES, TOOL_GIT_HISTORY, TOOL_INSPECT_FILE, TOOL_HASH_FILE]) {
  addToolSchema(schema);
}
addToolSchema(TOOL_AGENT_FEEDBACK);
addToolSchema(TOOL_GET_OPERATOR_FEEDBACK);
addToolSchema(TOOL_ACK_OPERATOR_FEEDBACK);
addToolSchema(TOOL_GET_BRIEF);
addToolSchema(TOOL_PROJECT_DB_QUERY);
if (writeEnabled) {
  for (const schema of [TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR]) {
    addToolSchema(schema);
  }
}
if (allowBash) {
  addToolSchema(TOOL_BASH);
}
if (ownerHotGateway || roleName === "dev" || roleName === "assessor") {
  addToolSchema(TOOL_RUN_SCOPED_CHECKS);
  addToolSchema(TOOL_CREATE_TEST_SUITE);
  addToolSchema(TOOL_CREATE_TEST);
  addToolSchema(TOOL_RUN_TEST);
  addToolSchema(TOOL_RUN_TEST_SUITE);
}

function recordAtlasLiveObservation(entry = {}) {
  const observationType = String(entry.observation_type || "").trim();
  if (!observationType) return;
  try {
    _recordObservation({
      work_item_id: mcpWorkItemId ?? undefined,
      job_id: mcpJobId ?? undefined,
      observation_type: observationType,
      summary: entry.summary || `ATLAS ${entry.action || observationType}`,
      detail: entry.detail || entry,
    });
  } catch { /* best effort */ }
}
if (allowImageHelpers) {
  for (const schema of [TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT]) {
    addToolSchema(schema);
  }
}
if (allowImageGeneration) {
  addToolSchema(TOOL_GENERATE_IMAGE);
}

let TOOL_SCHEMA_MAP = new Map(TOOL_SCHEMAS.map((schema) => [schema.name, schema]));

function buildGatewayNativeToolDescriptor(schema) {
  const descriptor = buildNativeToolDescriptor(schema);
  return {
    ...descriptor,
    name: `tools.${schema.name}`,
    annotations: {
      ...(descriptor.annotations || {}),
      title: `tools.${schema.name}`,
    },
  };
}

function protectedMutationError(toolName, displayPath, absolutePath) {
  const relPath = relativePathFromCwd(workspaceCwd, absolutePath);
  const reason = protectedMutablePathReason(relPath);
  return reason ? `Error: ${toolName} blocked - ${displayPath} is protected: ${reason}.` : null;
}

function resolveMutationPath(toolName, displayPath) {
  try {
    return { path: safePath(workspaceCwd, displayPath, effectiveScopePredicates) };
  } catch (err) {
    return { error: `Error: ${toolName} blocked - ${err?.message || String(err)}` };
  }
}

function writeFileWithinScope(args = {}) {
  if (!writeEnabled) return "Error: Write access is not granted for this role.";
  const resolved = resolveMutationPath("write_file", args.path);
  if (resolved.error) return resolved.error;
  const protectedErr = protectedMutationError("write_file", args.path, resolved.path);
  if (protectedErr) return protectedErr;
  return execWriteFile(args || {}, workspaceCwd, effectiveScopePredicates);
}

function editFileWithinScope(args = {}) {
  if (!writeEnabled) return "Error: Write access is not granted for this role.";
  const resolved = resolveMutationPath("edit_file", args.path);
  if (resolved.error) return resolved.error;
  const protectedErr = protectedMutationError("edit_file", args.path, resolved.path);
  if (protectedErr) return protectedErr;
  return execEditFile(args || {}, workspaceCwd, effectiveScopePredicates);
}

function pathsReferToSameExistingFile(a, b) {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    if (aStat.dev === bStat.dev && aStat.ino !== 0 && aStat.ino === bStat.ino) return true;
  } catch {
    return false;
  }
  try {
    const realA = fs.realpathSync.native ? fs.realpathSync.native(a) : fs.realpathSync(a);
    const realB = fs.realpathSync.native ? fs.realpathSync.native(b) : fs.realpathSync(b);
    return process.platform === "win32"
      ? realA.toLowerCase() === realB.toLowerCase()
      : realA === realB;
  } catch {
    return false;
  }
}

function blockedAtlasMutationMessage(toolName) {
  const action = String(toolName || "")
    .replace(/^tools\./, "")
    .replace(/^atlas\./, "")
    .replace(/^atlas_/, "")
    .replace(/_/g, ".");
  if (action === "file.write") {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Use scoped write_file/edit_file for job writes so file scope and worktree isolation are enforced.`;
  }
  if (action.startsWith("memory.")) {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Memory persistence is managed by Posse; do not call memory mutation tools directly.`;
  }
  if (action === "index.refresh" || action === "scip.ingest") {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Index refreshes are scheduled by Posse after scoped file edits; continue with deterministic file/test tools.`;
  }
  if (action === "runtime.execute") {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Use deterministic bash/run_test tools only when shell execution is allowed for this role.`;
  }
  if (action === "policy.set") {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Policy changes are operator-controlled and cannot be made from this job.`;
  }
  return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Continue with the deterministic tools exposed for this role.`;
}

function moveFileWithinScope(args = {}) {
  if (!writeEnabled) return "Error: move_file is not available for this role.";
  const sourcePath = safePath(workspaceCwd, args.source, effectiveScopePredicates);
  const destinationPath = safePath(workspaceCwd, args.destination, effectiveScopePredicates);
  const protectedSourceErr = protectedMutationError("move_file", args.source, sourcePath);
  if (protectedSourceErr) return protectedSourceErr;
  const protectedDestinationErr = protectedMutationError("move_file", args.destination, destinationPath);
  if (protectedDestinationErr) return protectedDestinationErr;
  if (isSensitiveEnvFileOrTargetPath(sourcePath)) {
    return "Error: move_file blocked - reading .env files is blocked.";
  }
  if (isSensitiveEnvFileOrTargetPath(destinationPath)) {
    return "Error: move_file blocked - writing .env files is blocked.";
  }
  if (!fs.existsSync(sourcePath)) return `Error: Source file not found: ${args.source}`;
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) return `Error: Source path is not a file: ${args.source}`;
  if (!effectiveScopePredicates.canEdit(sourcePath)) {
    return `Error: move_file blocked - ${args.source} is outside the allowed edit scope.`;
  }

  const overwrite = args.overwrite === true;
  const destinationExists = fs.existsSync(destinationPath);
  const destinationIsSource = destinationExists && pathsReferToSameExistingFile(sourcePath, destinationPath);
  if (destinationExists && !destinationIsSource && !overwrite) {
    return `Error: Destination already exists: ${args.destination} (set overwrite=true to replace).`;
  }
  if (destinationExists && !effectiveScopePredicates.canEdit(destinationPath)) {
    return `Error: move_file blocked - ${args.destination} is outside the allowed edit scope.`;
  }
  if (!destinationExists && !effectiveScopePredicates.canCreate(destinationPath)) {
    return `Error: move_file blocked - ${args.destination} is outside the allowed creation scope.`;
  }
  const sourceLockErr = guardToolWriteLock("move_file", args.source, workspaceCwd);
  if (sourceLockErr) return sourceLockErr;
  const destinationLockErr = guardToolWriteLock("move_file", args.destination, workspaceCwd);
  if (destinationLockErr) return destinationLockErr;

  const destinationDir = path.dirname(destinationPath);
  const replacementTempPath = () => path.join(destinationDir, `.posse-move-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const replaceDestination = (fromPath) => {
    if (!destinationExists) {
      fs.renameSync(fromPath, destinationPath);
      return;
    }
    const backupPath = replacementTempPath();
    let backupCreated = false;
    try {
      fs.renameSync(destinationPath, backupPath);
      backupCreated = true;
      fs.renameSync(fromPath, destinationPath);
      fs.rmSync(backupPath, { force: true });
    } catch (err) {
      if (backupCreated && !fs.existsSync(destinationPath) && fs.existsSync(backupPath)) {
        try { fs.renameSync(backupPath, destinationPath); } catch { /* preserve error below */ }
      }
      throw err;
    }
  };

  try {
    fs.mkdirSync(destinationDir, { recursive: true });
    if (destinationIsSource) {
      if (path.normalize(sourcePath) !== path.normalize(destinationPath)) {
        const tempPath = replacementTempPath();
        fs.renameSync(sourcePath, tempPath);
        fs.renameSync(tempPath, destinationPath);
      }
    } else {
      replaceDestination(sourcePath);
    }
  } catch (err) {
    if (err?.code !== "EXDEV") {
      const reason = err?.code ? ` (${err.code})` : "";
      return `Error: move_file failed for ${args.source} -> ${args.destination}${reason}.`;
    }
    const tempPath = replacementTempPath();
    try {
      fs.copyFileSync(sourcePath, tempPath);
      replaceDestination(tempPath);
      fs.rmSync(sourcePath, { force: true });
    } catch (copyErr) {
      try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
      const reason = copyErr?.code ? ` (${copyErr.code})` : "";
      return `Error: move_file failed for ${args.source} -> ${args.destination}${reason}.`;
    }
  }

  return JSON.stringify({
    ok: true,
    source: path.relative(workspaceCwd, sourcePath).replace(/\\/g, "/"),
    destination: path.relative(workspaceCwd, destinationPath).replace(/\\/g, "/"),
    overwritten: destinationExists && overwrite && !destinationIsSource,
  }, null, 2);
}

function copyFileWithinScope(args = {}) {
  if (!writeEnabled) return "Error: copy_file is not available for this role.";
  const sourcePath = safePath(workspaceCwd, args.source, effectiveScopePredicates);
  const destinationPath = safePath(workspaceCwd, args.destination, effectiveScopePredicates);
  const protectedSourceErr = protectedMutationError("copy_file", args.source, sourcePath);
  if (protectedSourceErr) return protectedSourceErr;
  const protectedDestinationErr = protectedMutationError("copy_file", args.destination, destinationPath);
  if (protectedDestinationErr) return protectedDestinationErr;
  if (isSensitiveEnvFileOrTargetPath(sourcePath)) {
    return "Error: copy_file blocked - reading .env files is blocked.";
  }
  if (isSensitiveEnvFileOrTargetPath(destinationPath)) {
    return "Error: copy_file blocked - writing .env files is blocked.";
  }
  if (!fs.existsSync(sourcePath)) return `Error: Source file not found: ${args.source}`;
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) return `Error: Source path is not a file: ${args.source}`;

  const overwrite = args.overwrite === true;
  const destinationExists = fs.existsSync(destinationPath);
  if (destinationExists && !overwrite) {
    return `Error: Destination already exists: ${args.destination} (set overwrite=true to replace).`;
  }
  if (destinationExists && !effectiveScopePredicates.canEdit(destinationPath)) {
    return `Error: copy_file blocked - ${args.destination} is outside the allowed edit scope.`;
  }
  if (!destinationExists && !effectiveScopePredicates.canCreate(destinationPath)) {
    return `Error: copy_file blocked - ${args.destination} is outside the allowed creation scope.`;
  }
  const destinationLockErr = guardToolWriteLock("copy_file", args.destination, workspaceCwd);
  if (destinationLockErr) return destinationLockErr;

  try {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (destinationExists && overwrite) fs.rmSync(destinationPath, { force: true });
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (err) {
    const reason = err?.code ? ` (${err.code})` : "";
    return `Error: copy_file failed for ${args.source} -> ${args.destination}${reason}.`;
  }
  return JSON.stringify({
    ok: true,
    source: path.relative(workspaceCwd, sourcePath).replace(/\\/g, "/"),
    destination: path.relative(workspaceCwd, destinationPath).replace(/\\/g, "/"),
    overwritten: destinationExists && overwrite,
  }, null, 2);
}

function makeDirWithinScope(args = {}) {
  if (!writeEnabled) return "Error: make_dir is not available for this role.";
  if (!args.path || typeof args.path !== "string") return "Error: path is required.";
  const dirPath = safePath(workspaceCwd, args.path, effectiveScopePredicates);
  const protectedErr = protectedMutationError("make_dir", args.path, dirPath);
  if (protectedErr) return protectedErr;
  if (fs.existsSync(dirPath)) {
    if (!fs.statSync(dirPath).isDirectory()) {
      return `Error: Path exists and is not a directory: ${args.path}`;
    }
    return JSON.stringify({
      ok: true,
      path: path.relative(workspaceCwd, dirPath).replace(/\\/g, "/"),
      created: false,
    }, null, 2);
  }
  if (!effectiveScopePredicates.canCreate(dirPath)) {
    return `Error: make_dir blocked - ${args.path} is outside the allowed creation scope.`;
  }
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    const reason = err?.code ? ` (${err.code})` : "";
    return `Error: make_dir failed for ${args.path}${reason}.`;
  }
  return JSON.stringify({
    ok: true,
    path: path.relative(workspaceCwd, dirPath).replace(/\\/g, "/"),
    created: true,
  }, null, 2);
}

// ── Researcher read-gate state machine ─────────────────────────────────────
// Tracks what the researcher has read, gates the next read until a verdict is
// emitted (relevant/irrelevant). Persists to a JSONL file so restarts resume.

function createResearchState() {
  return {
  currentlyReading: null,      // { path, content } — awaiting verdict
  relevant: new Map(),         // path → { summary, content }
  irrelevant: new Set(),       // paths tagged irrelevant
  readOrder: [],               // ordered list of all reads
  explorationSteps: 0,
  lastNovelEvidenceStep: 0,
  synthesisRequiredAt: null,
  synthesisReason: null,
  synthesisNoticeEmitted: false,
  };
}

let researchState = createResearchState();
const researchStatesByKey = new Map();

let researchLogPath = (() => {
  if (!isResearcherRole || !mcpJobId) return null;
  const logDir = path.join(workspaceCwd, ".posse", "research-state");
  return path.join(logDir, `job-${mcpJobId}.json`);
})();

function loadResearchState() {
  if (!researchLogPath) return;
  try {
    if (!fs.existsSync(researchLogPath)) return;
    const data = JSON.parse(fs.readFileSync(researchLogPath, "utf8"));
    if (data.relevant) {
      for (const [p, v] of Object.entries(data.relevant)) {
        researchState.relevant.set(p, v);
      }
    }
    if (Array.isArray(data.irrelevant)) {
      for (const p of data.irrelevant) researchState.irrelevant.add(p);
    }
    if (Array.isArray(data.readOrder)) {
      researchState.readOrder = data.readOrder;
    }
    if (data.currentlyReading) {
      researchState.currentlyReading = data.currentlyReading;
    }
    const explorationSteps = Number(data.explorationSteps);
    if (Number.isFinite(explorationSteps) && explorationSteps >= 0) {
      researchState.explorationSteps = Math.floor(explorationSteps);
    }
    const lastNovelEvidenceStep = Number(data.lastNovelEvidenceStep);
    if (Number.isFinite(lastNovelEvidenceStep) && lastNovelEvidenceStep >= 0) {
      researchState.lastNovelEvidenceStep = Math.floor(lastNovelEvidenceStep);
    }
    if (data.synthesisRequiredAt) {
      researchState.synthesisRequiredAt = String(data.synthesisRequiredAt);
      researchState.synthesisNoticeEmitted = data.synthesisNoticeEmitted !== false;
    }
    if (data.synthesisReason) {
      researchState.synthesisReason = String(data.synthesisReason);
    }
  } catch { /* fresh start */ }
}

function saveResearchState() {
  if (!researchLogPath) return;
  try {
    const researchLogDir = path.dirname(researchLogPath);
    fs.mkdirSync(researchLogDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(researchLogDir, 0o700); } catch { /* best effort */ }
    const data = {
      jobId: mcpJobId,
      workItemId: mcpWorkItemId,
      currentlyReading: researchState.currentlyReading,
      relevant: Object.fromEntries(researchState.relevant),
      irrelevant: [...researchState.irrelevant],
      readOrder: researchState.readOrder,
      explorationSteps: researchState.explorationSteps,
      lastNovelEvidenceStep: researchState.lastNovelEvidenceStep,
      synthesisRequiredAt: researchState.synthesisRequiredAt,
      synthesisReason: researchState.synthesisReason,
      synthesisNoticeEmitted: researchState.synthesisNoticeEmitted,
    };
    fs.writeFileSync(researchLogPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(researchLogPath, 0o600); } catch { /* best effort */ }
  } catch { /* best effort */ }
}

if (isResearcherRole) loadResearchState();

function isResearchExplorationTool(toolName, { requestedAtlasTool = false } = {}) {
  if (requestedAtlasTool) return true;
  const normalized = String(toolName || "");
  if (normalized.startsWith("atlas.") || normalized.startsWith("atlas_")) return true;
  return RESEARCH_NATIVE_EXPLORATION_TOOLS.has(normalized);
}

function researchSynthesisStaleStepCount() {
  return Math.max(0, Number(researchState.explorationSteps || 0) - Number(researchState.lastNovelEvidenceStep || 0));
}

function researchSynthesisStatus() {
  if (!researchState.synthesisRequiredAt) return null;
  return {
    required: true,
    required_at: researchState.synthesisRequiredAt,
    reason: researchState.synthesisReason || null,
    exploration_steps: researchState.explorationSteps,
    stale_steps: researchSynthesisStaleStepCount(),
    last_novel_evidence_step: researchState.lastNovelEvidenceStep,
    relevant_files: researchState.relevant.size,
    irrelevant_files: researchState.irrelevant.size,
  };
}

function recordResearchSynthesisRequiredObservation() {
  if (!isResearcherRole || researchState.synthesisNoticeEmitted) return;
  try {
    _recordObservation({
      work_item_id: mcpWorkItemId ?? undefined,
      job_id: mcpJobId ?? undefined,
      observation_type: "research.synthesis_required",
      summary: `Research synthesis required after ${researchState.explorationSteps} exploration calls with ${researchSynthesisStaleStepCount()} stale calls`,
      detail: {
        kind: "research_synthesis_required",
        exploration_steps: researchState.explorationSteps,
        stale_steps: researchSynthesisStaleStepCount(),
        min_exploration_steps: RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS,
        stale_exploration_steps: RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS,
        last_novel_evidence_step: researchState.lastNovelEvidenceStep,
        relevant_files: researchState.relevant.size,
        irrelevant_files: researchState.irrelevant.size,
        reason: researchState.synthesisReason || null,
      },
    });
    researchState.synthesisNoticeEmitted = true;
  } catch { /* best effort */ }
}

function maybeMarkResearchSynthesisRequired({ toolName = null } = {}) {
  if (!isResearcherRole || researchState.synthesisRequiredAt) return false;
  const explorationSteps = Number(researchState.explorationSteps || 0);
  const staleSteps = researchSynthesisStaleStepCount();
  if (explorationSteps < RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS) return false;
  if (staleSteps < RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS) return false;

  researchState.synthesisRequiredAt = new Date().toISOString();
  researchState.synthesisReason = [
    `exploration_steps=${explorationSteps}`,
    `stale_steps=${staleSteps}`,
    toolName ? `last_tool=${toolName}` : null,
  ].filter(Boolean).join("; ");
  recordResearchSynthesisRequiredObservation();
  return true;
}

function noteResearchExplorationStep({ toolName, requestedAtlasTool = false, novelRelevantFile = false } = {}) {
  if (!isResearcherRole || !isResearchExplorationTool(toolName, { requestedAtlasTool })) return null;
  researchState.explorationSteps += 1;
  if (novelRelevantFile) {
    researchState.lastNovelEvidenceStep = researchState.explorationSteps;
  }
  maybeMarkResearchSynthesisRequired({ toolName });
  saveResearchState();
  return researchSynthesisStatus();
}

function shouldBlockForResearchSynthesis(toolName, { requestedAtlasTool = false } = {}) {
  if (!isResearcherRole || !researchState.synthesisRequiredAt) return false;
  const normalized = String(toolName || "");
  if (normalized === "chain_verdict" && researchState.currentlyReading) return false;
  if (requestedAtlasTool || normalized.startsWith("atlas.") || normalized.startsWith("atlas_")) return true;
  return RESEARCH_NATIVE_SYNTHESIS_GATED_TOOLS.has(normalized);
}

function buildResearchSynthesisRequiredMessage(toolName) {
  const status = researchSynthesisStatus() || {};
  return [
    `RESEARCH SYNTHESIS REQUIRED: deterministic cap reached before ${toolName || "another tool call"}.`,
    `Exploration calls: ${status.exploration_steps || 0}; no new relevant file in the last ${status.stale_steps || 0} exploration calls.`,
    "Stop tool use and return a partial planner-ready brief now.",
    "Include files/symbols consulted, why each mattered, unknowns, and stop_reason=deterministic_synthesize_now_no_novel_evidence.",
  ].join("\n");
}

// Matches the out-of-range sentinel returned by execReadFile (toolkit/index.js)
// when the requested offset is past EOF. It is NOT an "Error:" string but is
// also not file content, so chainRead must not store it in the research buffer.
const READ_FILE_EOF_SENTINEL_RE = /^File has \d+ lines\. Requested offset \d+ is beyond end of file\.$/;

function chainRead(args) {
  const requestedPath = args.path;

  if (!requestedPath) {
    return "Error: path is required.";
  }

  // ── Gate: chain is locked until verdict is issued ──────────────────────
  if (researchState.currentlyReading) {
    const pending = researchState.currentlyReading.path;
    return `AUDIT ERROR: Chain is locked. You must call chain_verdict on "${pending}" before reading another file.`;
  }

  // ── Enforce single-read rule ──────────────────────────────────────────
  const resolvedPath = path.resolve(workspaceCwd, requestedPath).replace(/\\/g, "/");
  const relPath = path.relative(workspaceCwd, resolvedPath).replace(/\\/g, "/");
  const offset = _normalizeReadRange(args.offset, 1);
  const limit = _normalizeReadRange(args.limit, CONTEXT_CHAIN_READ_DEFAULT_LIMIT_LINES);
  const continuationRead = offset > 1;

  if (researchState.relevant.has(relPath) && !continuationRead) {
    const cached = researchState.relevant.get(relPath) || {};
    const relevantCount = researchState.relevant.size;
    const irrelevantCount = researchState.irrelevant.size;
    const ledgerLine = `[audit ledger: ${relevantCount} relevant, ${irrelevantCount} irrelevant, ${researchState.readOrder.length} total reads]`;
    return [
      ledgerLine,
      `[chain restored from ledger: "${relPath}" was already tagged relevant; verdict carries over, do not call chain_verdict again for this restored view]`,
      cached.summary ? `[prior verdict summary: ${cached.summary}]` : "[prior verdict summary: none]",
      "",
      cached.content || "",
    ].join("\n");
  }
  if (researchState.irrelevant.has(relPath) && !continuationRead) {
    return `AUDIT ERROR: "${relPath}" was already read and tagged irrelevant. ` +
      `Each file may only be read once unless you request a continuation with offset/limit.`;
  }

  // ── Read the file ─────────────────────────────────────────────────────
  const result = execReadFile({ ...args, path: requestedPath, limit }, workspaceCwd, effectiveScopePredicates);

  // The offset-past-EOF sentinel is not file content. Surface it as an audit
  // error without locking the chain or recording it — otherwise chain_verdict
  // would persist the placeholder string as the file's "relevant content".
  if (READ_FILE_EOF_SENTINEL_RE.test(result.trim())) {
    return `AUDIT ERROR: ${result.trim()} Nothing was recorded; re-read "${relPath}" with a valid offset.`;
  }

  if (/^Error:/i.test(result.trim())) {
    const message = result.trim().replace(/^Error:\s*/i, "");
    return `AUDIT ERROR: ${message || "read failed"} Nothing was recorded.`;
  }

  if (!result.startsWith("Error:")) {
    researchState.currentlyReading = { path: relPath, content: result, offset, limit, continuation: continuationRead };
    researchState.readOrder.push(relPath);
    saveResearchState();
  }

  const relevantCount = researchState.relevant.size;
  const irrelevantCount = researchState.irrelevant.size;
  const ledgerLine = `[audit ledger: ${relevantCount} relevant, ${irrelevantCount} irrelevant, ${researchState.readOrder.length} total reads]`;

  return `${ledgerLine}\n[chain locked — call chain_verdict when done reviewing this file]\n\n${result}`;
}

function chainVerdict(args) {
  if (!researchState.currentlyReading) {
    return "AUDIT ERROR: No file pending verdict. Call chain_read first.";
  }

  const { path: filePath, content, continuation = false } = researchState.currentlyReading;
  const verdict = String(args.verdict || "").toLowerCase();
  const summary = String(args.summary || "").trim();

  if (verdict !== "relevant" && verdict !== "irrelevant") {
    return `AUDIT ERROR: verdict must be "relevant" or "irrelevant", got "${args.verdict}".`;
  }
  if (verdict === "irrelevant" && !summary) {
    return "AUDIT ERROR: summary is required when verdict is \"irrelevant\" so pruning can preserve why this file was excluded.";
  }

  const wasRelevant = researchState.relevant.has(filePath);
  if (verdict === "relevant") {
    const previous = researchState.relevant.get(filePath);
    const nextSummary = summary || "(no summary)";
    researchState.relevant.set(filePath, previous ? {
      summary: [previous.summary, continuation ? `continuation: ${nextSummary}` : nextSummary].filter(Boolean).join("; "),
      content: [previous.content, content].filter(Boolean).join("\n\n--- chain_read continuation ---\n\n"),
    } : {
      summary: nextSummary,
      content,
    });
    researchState.irrelevant.delete(filePath);
  } else {
    if (!researchState.relevant.has(filePath)) {
      researchState.irrelevant.add(filePath);
    }
  }

  researchState.currentlyReading = null;
  saveResearchState();

  const relevantCount = researchState.relevant.size;
  const irrelevantCount = researchState.irrelevant.size;
  const ledger = { relevant: relevantCount, irrelevant: irrelevantCount, total: researchState.readOrder.length };
  const novelRelevantFile = verdict === "relevant" && !wasRelevant;
  recordResearchEvidenceObservation({
    filePath,
    verdict,
    summary,
    continuation,
    ledger,
    novelRelevantFile,
  });
  noteResearchExplorationStep({ toolName: "chain_verdict", novelRelevantFile });
  const response = {
    ok: true,
    tagged: filePath,
    verdict,
    summary: summary || null,
    ledger,
    evidence: {
      novel_relevant_file: novelRelevantFile,
      continuation,
    },
    chain: "unlocked",
  };
  const synthesis = researchSynthesisStatus();
  if (synthesis) response.synthesis = synthesis;

  // When ATLAS is available and the researcher found something relevant,
  // nudge it to use symbol lookup instead of more blind file browsing
  if (atlasAvailable && verdict === "relevant") {
    response.hint = "You have symbol.search and slice.build available. " +
      "Use them to trace connections from what you just found instead of browsing more files manually.";
  }

  return JSON.stringify(response, null, 2);
}

function recordResearchEvidenceObservation({
  filePath,
  verdict,
  summary = "",
  continuation = false,
  ledger = null,
  novelRelevantFile = false,
} = {}) {
  try {
    _recordObservation({
      work_item_id: mcpWorkItemId ?? undefined,
      job_id: mcpJobId ?? undefined,
      observation_type: "research.evidence",
      summary: `Research evidence: ${capString(filePath || "(unknown)", 120)} -> ${verdict}${novelRelevantFile ? " (new relevant file)" : ""}`,
      detail: {
        kind: "research_evidence",
        path: filePath || null,
        verdict,
        relevant: verdict === "relevant",
        summary: summary ? capString(summary, 300) : null,
        continuation: !!continuation,
        novel_relevant_file: !!novelRelevantFile,
        ledger,
      },
    });
  } catch { /* best effort */ }
}

// ── Standard tool executors ────────────────────────────────────────────────

/**
 * In the owner-hot gateway every message must carry its own session scope: a
 * call without it would execute against the PREVIOUS session's sticky
 * mcpJobId — cross-job feedback reads/acks with no error. Same failure
 * family as the 2026-06-20 attach-under-load fixes; failing loudly makes the
 * shim retry the handshake instead of silently leaking across sessions.
 *
 * @param {string} toolName
 * @returns {string | null}
 */
function liveChannelSessionScopeError(toolName) {
  if (!ownerHotGateway || mcpMessageSessionScoped) return null;
  return `Error: ${toolName} requires session-scoped context in the owner-hot gateway (the session handshake did not attach to this call). Retry the tool call.`;
}

function agentFeedback(args = {}) {
  const scopeError = liveChannelSessionScopeError("agent_feedback");
  if (scopeError) return scopeError;
  if (!mcpJobId) return "No active job context is available for agent_feedback.";
  recordAgentActivity({
    work_item_id: mcpWorkItemId,
    job_id: mcpJobId,
    phase: args.phase,
    action: args.status,
    body: args.summary,
    source: "mcp_tool",
    metadata_json: { status: args.status || null, role: roleName || null },
  });
  return "Agent feedback recorded for Monitor Agents.";
}

function operatorFeedbackSignalText(toolName) {
  if (LIVE_CHANNEL_TOOL_NAMES.has(toolName)) return "";
  if (!mcpJobId) return "";
  const pendingCount = countPendingOperatorFeedbackForJob(mcpJobId);
  if (pendingCount <= 0) return "";
  return [
    "",
    "OPERATOR_FEEDBACK_SIGNAL:",
    JSON.stringify({
      operator_feedback_available: true,
      pending_count: pendingCount,
      next_tool: "get_operator_feedback",
      ack_tool: "ack_operator_feedback",
    }),
  ].join("\n");
}

function appendOperatorFeedbackSignal(text, toolName) {
  const signal = operatorFeedbackSignalText(toolName);
  return signal ? `${text}${signal}` : text;
}

function getOperatorFeedback(args = {}) {
  const scopeError = liveChannelSessionScopeError("get_operator_feedback");
  if (scopeError) return scopeError;
  if (!mcpJobId) return "No active job context is available for get_operator_feedback.";
  const feedback = getOperatorFeedbackForJob({
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    limit: args.limit,
  });
  return JSON.stringify({
    ok: true,
    acknowledgement_required: feedback.length > 0,
    default_ack_decision: "accepted",
    ack_tool: "ack_operator_feedback",
    feedback,
  }, null, 2);
}

function ackOperatorFeedback(args = {}) {
  const scopeError = liveChannelSessionScopeError("ack_operator_feedback");
  if (scopeError) return scopeError;
  if (!mcpJobId) return "No active job context is available for ack_operator_feedback.";
  const row = acknowledgeOperatorFeedback({
    interaction_id: args.interaction_id,
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    decision: args.decision || "accepted",
    reason: args.reason || "",
  });
  if (!row) return `No operator feedback item found for id ${args.interaction_id}.`;
  return JSON.stringify({
    ok: true,
    interaction_id: row.id,
    decision: row.ack_decision || "accepted",
    reason: row.ack_reason || null,
    acknowledged_at: row.acknowledged_at || null,
    // First ack wins; a repeat ack reads back the recorded decision.
    ...(row.already_acknowledged ? { already_acknowledged: true } : {}),
  }, null, 2);
}

// Attach this server's executors to a ToolRegistry seeded with the shared suite
// metadata, so the MCP runtime's handler set flows through the same registry the
// embedded OpenAI/Grok runtime builds from. Executors and role gating are
// unchanged; the registry is the single declaration both runtimes share.
let mcpToolRegistry = declareToolSuites(new ToolRegistry());
mcpToolRegistry.attach("read_file", (args) => dedupeReadFile(args || {}));
mcpToolRegistry.attach("get_brief", (args) => execGetBrief(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("list_files", (args) => execListFiles(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("search_files", (args) => execSearchFiles(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("git_history", (args) => execGitHistory(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("inspect_file", (args) => execInspectFile(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("hash_file", (args) => execHashFile(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("agent_feedback", (args) => agentFeedback(args || {}));
mcpToolRegistry.attach("get_operator_feedback", (args) => getOperatorFeedback(args || {}));
mcpToolRegistry.attach("ack_operator_feedback", (args) => ackOperatorFeedback(args || {}));

if (writeEnabled) {
  mcpToolRegistry.attach("write_file", (args) => writeFileWithinScope(args || {}));
  mcpToolRegistry.attach("edit_file", (args) => editFileWithinScope(args || {}));
  mcpToolRegistry.attach("prune_artifact_output", (args) => execPruneArtifactOutput(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("move_file", (args) => moveFileWithinScope(args || {}));
  mcpToolRegistry.attach("copy_file", (args) => copyFileWithinScope(args || {}));
  mcpToolRegistry.attach("make_dir", (args) => makeDirWithinScope(args || {}));
}
if (allowBash && execBash) {
  mcpToolRegistry.attach("bash", (args) => execBash(args || {}, workspaceCwd));
}
if (ownerHotGateway || roleName === "dev" || roleName === "assessor") {
  const actor = { role: roleName, jobId: mcpJobId, workItemId: mcpWorkItemId };
  mcpToolRegistry.attach("run_scoped_checks", (args) => execRunScopedChecks(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope));
  mcpToolRegistry.attach("run_test", (args) => execRunTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
  mcpToolRegistry.attach("run_test_suite", (args) => execRunTestSuite(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
  // Test authoring is a dev-only mutation; the assessor may run tests to verify
  // but must not create them.
  if (ownerHotGateway || roleName === "dev") {
    mcpToolRegistry.attach("create_test_suite", (args) => execCreateTestSuite(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
    mcpToolRegistry.attach("create_test", (args) => execCreateTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
  }
}
if (allowImageHelpers) {
  mcpToolRegistry.attach("read_image_metadata", (args) => execReadImageMetadata(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("validate_artifact_output", (args) => execValidateArtifactOutput(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("extract_image_text", (args) => execExtractImageText(args || {}, workspaceCwd, effectiveScopePredicates));
}
// clean_image mutates images and is artificer-only. Owner-hot attaches every
// executor (the remote token gates per call); scoped boots attach it only for
// the artificer role so a read-only assessor cannot reach it in a no-token boot.
if (ownerHotGateway || roleName === "artificer") {
  mcpToolRegistry.attach("clean_image", (args) => execCleanImage(args || {}, workspaceCwd, effectiveScopePredicates));
}
if (allowImageGeneration) {
  mcpToolRegistry.attach("generate_image", async (args) => {
    if (imageGenerationCallCount >= imageGenerationMaxCalls) {
      return `Error: generate_image call limit reached for this job (${imageGenerationMaxCalls}). Ask for operator guidance before generating more images.`;
    }
    imageGenerationCallCount += 1;
    const result = await execGenerateImageInternal(args || {}, {
      cwd: workspaceCwd,
      scopePredicates: effectiveScopePredicates,
      safePathImpl: safePath,
    });
    if (typeof result === "string" && result.startsWith("Error:")) {
      imageGenerationCallCount = Math.max(0, imageGenerationCallCount - 1);
    }
    return result;
  });
}
if (ownerHotGateway || isResearcherRole) {
  mcpToolRegistry.attach("chain_read", (args) => chainRead(args || {}));
  mcpToolRegistry.attach("chain_verdict", (args) => chainVerdict(args || {}));
}
if (projectDbAccessEnabled) {
  mcpToolRegistry.attach("project_db_query", (args) => execProjectDbQuery(args || {}, { projectDir: workspaceCwd, capability: projectDbCapability() }));
}

let TOOL_EXECUTORS = new Map(Object.entries(mcpToolRegistry.handlerMap()));
for (const toolName of [...TOOL_EXECUTORS.keys()]) {
  if (!TOOL_SCHEMA_MAP.has(toolName)) TOOL_EXECUTORS.delete(toolName);
}
// Parity: every advertised deterministic ("tools" suite) tool for this role
// must have an attached executor. ATLAS schemas are served elsewhere and are
// not registry-declared, so they are skipped.
for (const schemaName of TOOL_SCHEMA_MAP.keys()) {
  if (mcpToolRegistry.has(schemaName) && !TOOL_EXECUTORS.has(schemaName)) {
    throw new Error(`deterministic MCP tool "${schemaName}" is advertised but has no attached executor`);
  }
}
for (const [toolName, handler] of [...TOOL_EXECUTORS.entries()]) {
  TOOL_EXECUTORS.set(toolName, (args) => runNativeToolThroughGate(toolName, args || {}, handler));
}

let activeRuntimeSessionKey = "";

function runtimeSessionKey(config = bootConfig) {
  const token = String(config?.mcpOAuth?.tokenId || "").trim();
  const job = config?.jobId != null && config.jobId !== "" ? `job:${config.jobId}` : "";
  const workItem = config?.workItemId != null && config.workItemId !== "" ? `wi:${config.workItemId}` : "";
  const role = String(config?.role || "").trim();
  const cwd = String(config?.cwd || "").trim();
  return [token ? `mcp:${token}` : "", job, workItem, role, cwd].filter(Boolean).join("|") || "owner-hot";
}

function gateScopeKeyForBootConfig(config = bootConfig) {
  const token = String(config?.mcpOAuth?.tokenId || "").trim();
  if (token) return `mcp:${token}`;
  const jobId = Number(config?.jobId) || null;
  return jobId != null ? `job:${jobId}` : null;
}

function computeDeclaredNativeToolNamesForCurrentBoot() {
  return (ownerHotGateway
    ? [...ALL_NATIVE_TOOL_NAMES]
    : (hasTokenToolAllowlist()
      ? [...(tokenToolAllowlistForSuite("tools") || new Set())]
    : (roleName
      ? getDeterministicMcpToolNames(roleName, { needsImageGeneration: allowImageGeneration })
      : legacyToolNamesForUnscopedRole()))
  ).filter(runtimeToolAvailable);
}

function rebuildNativeToolSchemas() {
  DECLARED_NATIVE_TOOL_NAMES = computeDeclaredNativeToolNamesForCurrentBoot();
  DECLARED_NATIVE_TOOL_NAME_SET = new Set(DECLARED_NATIVE_TOOL_NAMES);
  TOOL_SCHEMAS = [];
  if (ownerHotGateway) {
    addToolSchema(TOOL_READ_FILE);
    addToolSchema(TOOL_CHAIN_READ);
    addToolSchema(TOOL_CHAIN_VERDICT);
  } else if (isResearcherRole) {
    addToolSchema(TOOL_CHAIN_READ);
    addToolSchema(TOOL_CHAIN_VERDICT);
  } else {
    addToolSchema(TOOL_READ_FILE);
  }
  for (const schema of [TOOL_LIST_FILES, TOOL_SEARCH_FILES, TOOL_GIT_HISTORY, TOOL_INSPECT_FILE, TOOL_HASH_FILE]) {
    addToolSchema(schema);
  }
  addToolSchema(TOOL_AGENT_FEEDBACK);
  addToolSchema(TOOL_GET_OPERATOR_FEEDBACK);
  addToolSchema(TOOL_ACK_OPERATOR_FEEDBACK);
  addToolSchema(TOOL_GET_BRIEF);
  addToolSchema(TOOL_PROJECT_DB_QUERY);
  if (writeEnabled) {
    for (const schema of [TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR]) {
      addToolSchema(schema);
    }
  }
  if (allowBash) addToolSchema(TOOL_BASH);
  if (ownerHotGateway || roleName === "dev" || roleName === "assessor") {
    addToolSchema(TOOL_RUN_SCOPED_CHECKS);
    addToolSchema(TOOL_CREATE_TEST_SUITE);
    addToolSchema(TOOL_CREATE_TEST);
    addToolSchema(TOOL_RUN_TEST);
    addToolSchema(TOOL_RUN_TEST_SUITE);
  }
  if (allowImageHelpers) {
    for (const schema of [TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT]) {
      addToolSchema(schema);
    }
  }
  if (allowImageGeneration) addToolSchema(TOOL_GENERATE_IMAGE);
  TOOL_SCHEMA_MAP = new Map(TOOL_SCHEMAS.map((schema) => [schema.name, schema]));
}

function attachToolExecutorsForCurrentBoot() {
  mcpToolRegistry = declareToolSuites(new ToolRegistry());
  mcpToolRegistry.attach("read_file", (args) => dedupeReadFile(args || {}));
mcpToolRegistry.attach("get_brief", (args) => execGetBrief(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("list_files", (args) => execListFiles(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("search_files", (args) => execSearchFiles(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("git_history", (args) => execGitHistory(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("inspect_file", (args) => execInspectFile(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("hash_file", (args) => execHashFile(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("agent_feedback", (args) => agentFeedback(args || {}));
  mcpToolRegistry.attach("get_operator_feedback", (args) => getOperatorFeedback(args || {}));
  mcpToolRegistry.attach("ack_operator_feedback", (args) => ackOperatorFeedback(args || {}));

  if (writeEnabled) {
    mcpToolRegistry.attach("write_file", (args) => writeFileWithinScope(args || {}));
    mcpToolRegistry.attach("edit_file", (args) => editFileWithinScope(args || {}));
    mcpToolRegistry.attach("prune_artifact_output", (args) => execPruneArtifactOutput(args || {}, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("move_file", (args) => moveFileWithinScope(args || {}));
    mcpToolRegistry.attach("copy_file", (args) => copyFileWithinScope(args || {}));
    mcpToolRegistry.attach("make_dir", (args) => makeDirWithinScope(args || {}));
  }
  if (allowBash && execBash) {
    mcpToolRegistry.attach("bash", (args) => execBash(args || {}, workspaceCwd));
  }
  if (ownerHotGateway || roleName === "dev" || roleName === "assessor") {
    const actor = { role: roleName, jobId: mcpJobId, workItemId: mcpWorkItemId };
    mcpToolRegistry.attach("run_scoped_checks", (args) => execRunScopedChecks(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope));
    mcpToolRegistry.attach("run_test", (args) => execRunTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
    mcpToolRegistry.attach("run_test_suite", (args) => execRunTestSuite(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
    // Test authoring is a dev-only mutation; the assessor may run but not create.
    if (ownerHotGateway || roleName === "dev") {
      mcpToolRegistry.attach("create_test_suite", (args) => execCreateTestSuite(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
      mcpToolRegistry.attach("create_test", (args) => execCreateTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, actor));
    }
  }
  if (allowImageHelpers) {
    mcpToolRegistry.attach("read_image_metadata", (args) => execReadImageMetadata(args || {}, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("validate_artifact_output", (args) => execValidateArtifactOutput(args || {}, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("extract_image_text", (args) => execExtractImageText(args || {}, workspaceCwd, effectiveScopePredicates));
  }
  // clean_image is artificer-only mutation; owner-hot attaches all executors
  // (remote token gates per call), scoped boots only for the artificer role.
  if (ownerHotGateway || roleName === "artificer") {
    mcpToolRegistry.attach("clean_image", (args) => execCleanImage(args || {}, workspaceCwd, effectiveScopePredicates));
  }
  if (allowImageGeneration) {
    mcpToolRegistry.attach("generate_image", async (args) => {
      if (imageGenerationCallCount >= imageGenerationMaxCalls) {
        return `Error: generate_image call limit reached for this job (${imageGenerationMaxCalls}). Ask for operator guidance before generating more images.`;
      }
      imageGenerationCallCount += 1;
      const result = await execGenerateImageInternal(args || {}, {
        cwd: workspaceCwd,
        scopePredicates: effectiveScopePredicates,
        safePathImpl: safePath,
      });
      if (typeof result === "string" && result.startsWith("Error:")) {
        imageGenerationCallCount = Math.max(0, imageGenerationCallCount - 1);
      }
      return result;
    });
  }
  if (ownerHotGateway || isResearcherRole) {
    mcpToolRegistry.attach("chain_read", (args) => chainRead(args || {}));
    mcpToolRegistry.attach("chain_verdict", (args) => chainVerdict(args || {}));
  }
  if (projectDbAccessEnabled) {
    mcpToolRegistry.attach("project_db_query", (args) => execProjectDbQuery(args || {}, { projectDir: workspaceCwd, capability: projectDbCapability() }));
  }
}

function rebuildToolExecutors() {
  attachToolExecutorsForCurrentBoot();
  TOOL_EXECUTORS = new Map(Object.entries(mcpToolRegistry.handlerMap()));
  for (const toolName of [...TOOL_EXECUTORS.keys()]) {
    if (!TOOL_SCHEMA_MAP.has(toolName)) TOOL_EXECUTORS.delete(toolName);
  }
  for (const schemaName of TOOL_SCHEMA_MAP.keys()) {
    if (mcpToolRegistry.has(schemaName) && !TOOL_EXECUTORS.has(schemaName)) {
      throw new Error(`deterministic MCP tool "${schemaName}" is advertised but has no attached executor`);
    }
  }
  for (const [toolName, handler] of [...TOOL_EXECUTORS.entries()]) {
    TOOL_EXECUTORS.set(toolName, (args) => runNativeToolThroughGate(toolName, args || {}, handler));
  }
}

function recomputeAtlasAllowedActionsForCurrentBoot() {
  if (ownerHotGateway && atlasAvailable) {
    return new Set(ATLAS_TOOL_ACTIONS.filter(isExternallyRoutedAtlasTool));
  }
  if (hasTokenToolAllowlist()) {
    return tokenToolAllowlistForSuite("atlas");
  }
  if (!atlasAvailable || !roleName || remoteToolCatalogRequired()) return null;
  try {
    const route = getAtlasRouteForRole(roleName, { config: getDeterministicAtlasConfig() });
    if (route?.tools?.length > 0) {
      return new Set(route.tools.map(_stripAtlasPrefix).filter(isExternallyRoutedAtlasTool));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function selectResearchStateForCurrentBoot() {
  researchLogPath = (() => {
    if (!isResearcherRole || !mcpJobId) return null;
    const logDir = path.join(workspaceCwd, ".posse", "research-state");
    return path.join(logDir, `job-${mcpJobId}.json`);
  })();
  const key = runtimeSessionKey();
  let entry = researchStatesByKey.get(key);
  if (!entry) {
    entry = { state: createResearchState(), loaded: false };
    researchStatesByKey.set(key, entry);
  }
  researchState = entry.state;
  if (!entry.loaded) {
    loadResearchState();
    entry.loaded = true;
  }
}

function applyRuntimeBootConfig(nextConfig = {}) {
  const parsedConfig = bootConfigFromOAuthToken(nextConfig && typeof nextConfig === "object" ? nextConfig : {});
  const nextSessionKey = runtimeSessionKey(parsedConfig);
  const sessionChanged = nextSessionKey !== activeRuntimeSessionKey;
  bootConfig = parsedConfig;
  ownerHotGateway = ownerHotProcess || bootConfig.ownerHotGateway === true;
  scopeParseState.invalid = bootConfig?.mcpOAuth?.verified === false;
  workspaceCwd = String(bootConfig.cwd || "").trim() || process.cwd();
  allowWrite = bootConfig.allowWrite === true || ownerHotGateway;
  projectDbWrite = bootConfig.projectDbWrite === true;
  allowImageHelpers = bootConfig.allowImageHelpers === true || ownerHotGateway;
  allowImageGeneration = bootConfig.allowImageGeneration === true || ownerHotGateway;
  roleName = String(bootConfig.role || "").trim() || null;
  isResearcherRole = roleName === "researcher";
  providerName = String(bootConfig.providerName || "").trim() || null;
  runId = String(bootConfig.runId || "").trim() || null;
  toolLogPath = String(bootConfig.toolLogPath || "").trim() || null;
  mcpDbPath = String(bootConfig.dbPath || "").trim() || null;
  mcpJobId = Number(bootConfig.jobId) || null;
  mcpWorkItemId = Number(bootConfig.workItemId) || null;
  mcpAttemptId = Number(bootConfig.attemptId) || null;
  atlasAvailable = bootConfig.atlasAvailable === true;
  atlasGateEnabled = bootConfig.atlasGateEnabled === true;
  atlasPrefetchStatus = String(bootConfig.atlasPrefetchStatus || "").trim().toLowerCase();
  imageGenerationMaxCalls = Number.isInteger(Number(bootConfig.imageGenerationMaxCalls)) && Number(bootConfig.imageGenerationMaxCalls) >= 0
    ? Number(bootConfig.imageGenerationMaxCalls)
    : 12;
  remoteToolCatalogConfig = bootConfig.remoteCatalog && typeof bootConfig.remoteCatalog === "object"
    ? bootConfig.remoteCatalog
    : {};
  remoteToolCatalogPreload = bootConfig.remoteToolSurface && typeof bootConfig.remoteToolSurface === "object"
    ? bootConfig.remoteToolSurface
    : null;
  allowBash = ownerHotGateway || ["dev", "artificer", "assessor"].includes(roleName);
  execBash = allowBash ? createBashExecutor() : null;
  scopePredicates = buildScopePredicates(workspaceCwd, {
    modifyFiles: Array.isArray(bootConfig.scopedFiles) ? bootConfig.scopedFiles : [],
    createFiles: Array.isArray(bootConfig.createFiles) ? bootConfig.createFiles : [],
    deleteFiles: Array.isArray(bootConfig.deleteFiles) ? bootConfig.deleteFiles : [],
    createRoots: Array.isArray(bootConfig.createRoots) ? bootConfig.createRoots : [],
    readRoots: Array.isArray(bootConfig.readRoots) ? bootConfig.readRoots : [],
  });
  declaredJobScope = Object.freeze({
    modifyFiles: Array.isArray(bootConfig.scopedFiles) ? [...bootConfig.scopedFiles] : [],
    createFiles: Array.isArray(bootConfig.createFiles) ? [...bootConfig.createFiles] : [],
    deleteFiles: Array.isArray(bootConfig.deleteFiles) ? [...bootConfig.deleteFiles] : [],
    createRoots: Array.isArray(bootConfig.createRoots) ? [...bootConfig.createRoots] : [],
    readRoots: Array.isArray(bootConfig.readRoots) ? [...bootConfig.readRoots] : [],
  });
  writeEnabled = allowWrite && !scopeParseState.invalid;
  // After writeEnabled: the project-DB gate caps the grant by this session's
  // read/write capability lane, so it must see the updated value.
  projectDbAccessEnabled = computeProjectDbAccessEnabled();
  effectiveScopePredicates = scopeParseState.invalid
    ? {
      canEdit: () => false,
      canCreate: () => false,
      isWithinScopeRoot: () => false,
      hasScope: true,
    }
    : scopePredicates;
  if (mcpDbPath) {
    setRuntimePathOverrides({ dbPath: mcpDbPath });
  }
  if (!ownerHotProcess && bootConfig.nativeAuth && typeof bootConfig.nativeAuth === "object") {
    try {
      nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(bootConfig.nativeAuth));
    } catch { /* best effort */ }
  }
  gateScopeKey = configureGate({
    role: roleName,
    atlasAvailable,
    enabled: atlasGateEnabled,
    atlasLabel: atlasBackendLabel(atlasAvailable ? getAtlasIntegrationConfig() : null),
    scopeKey: gateScopeKeyForBootConfig(bootConfig),
  });
  if (atlasAvailable && isFallbackAtlasPrefetchStatus(atlasPrefetchStatus)) {
    unlockForAtlasUnavailable({ reason: `prefetch_${atlasPrefetchStatus}`, scopeKey: gateScopeKey });
  }
  _atlasAllowedActions = recomputeAtlasAllowedActionsForCurrentBoot();
  if (!remoteToolCatalogEnabled() && atlasAvailable && roleName && _atlasAllowedActions?.size === 0) {
    unlockForAtlasUnavailable({ reason: "atlas_no_allowed_actions", scopeKey: gateScopeKey });
  }
  _atlasMemoryCountResolved = false;
  _atlasMemoryCount = null;
  _remoteToolSurfaceRequest = null;
  _remoteToolCatalogPromise = null;
  if (sessionChanged) {
    gateBootedAtMs = Date.now();
    imageGenerationCallCount = 0;
    _lastReadMeta = null;
    activeRuntimeSessionKey = nextSessionKey;
  }
  rebuildNativeToolSchemas();
  rebuildToolExecutors();
  selectResearchStateForCurrentBoot();
}

const BLOCKING_NATIVE_TOOL_NAMES = new Set([
  "bash",
  "chain_read",
  "chain_verdict",
  "clean_image",
  "copy_file",
  "edit_file",
  "generate_image",
  "make_dir",
  "move_file",
  "optimize_image",
  "prune_artifact_output",
  "reencode_image",
  "resize_image",
  "run_scoped_checks",
  "create_test_suite",
  "create_test",
  "run_test",
  "run_test_suite",
  "write_file",
]);

function nativeToolGateKey() {
  const normalized = path.resolve(workspaceCwd || process.cwd()).replace(/\\/g, "/");
  return `native-tools:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

async function runNativeToolThroughGate(toolName, args, handler) {
  const label = `tool.${toolName}`;
  const key = nativeToolGateKey();
  const run = () => handler(args);
  const result = BLOCKING_NATIVE_TOOL_NAMES.has(toolName)
    ? await DETERMINISTIC_TOOL_GATE.write(key, run, { label, waitMs: 120000 })
    : await DETERMINISTIC_TOOL_GATE.read(key, run, { label, waitMs: 30000 });
  return appendHashRefIfMajor(toolName, result, {
    args,
    context: {
      work_item_id: mcpWorkItemId,
      job_id: mcpJobId,
      attempt_id: mcpAttemptId,
    },
  });
}

function atlasLiveBufferMode() {
  const atlasConfig = bootConfig.atlas && typeof bootConfig.atlas === "object" ? bootConfig.atlas : {};
  const raw = String(atlasConfig.liveBuffers || "off").trim().toLowerCase();
  if (raw === "1") return "deterministic-writes";
  if (raw === "true") return "deterministic-writes";
  if (raw === "deterministic-writes") return "deterministic-writes";
  return "off";
}

async function maybePushAtlasLiveBuffer({ toolName, args } = {}) {
  const queued = buildQueuedAtlasLiveBufferDetail({ toolName, args, reason: "owner_executor" });
  if (!queued) return null;
  const detail = {
    ...queued,
    attempted: false,
    queued: true,
    ok: null,
  };
  recordAtlasLiveObservation({
    ...detail,
    summary: `ATLAS buffer.push (${detail.path || "unknown path"}) deferred to owner executor`,
    detail,
  });
  appendToolLog({
    event: "atlas_live_buffer_deferred_to_owner",
    tool: toolName,
    path: queued.path || null,
    reason: "owner_executor",
  });
  return detail;
}

function buildQueuedAtlasLiveBufferDetail({ toolName, args, reason = "timeout", timeoutMs = null } = {}) {
  if (atlasLiveBufferMode() !== "deterministic-writes") return null;
  if (toolName !== "write_file" && toolName !== "edit_file") return null;
  if (!atlasAvailable) return null;
  const mode = atlasLiveBufferMode();
  let relPath = null;
  try {
    const absPath = safePath(workspaceCwd, args?.path, effectiveScopePredicates);
    relPath = path.relative(workspaceCwd, absPath).replace(/\\/g, "/");
  } catch {
    // The write already succeeded if we reached this point; keep telemetry best-effort.
  }
  return {
    kind: "deterministic_write",
    tool: toolName,
    mode,
    action: "buffer.push",
    ...(relPath ? { path: relPath } : {}),
    attempted: true,
    ok: null,
    queued: true,
    reason,
    ...(timeoutMs == null ? {} : { timeout_ms: timeoutMs }),
    observation_type: "atlas.buffer_push",
  };
}

async function maybePushAtlasLiveBufferForToolObservation({ toolName, args } = {}) {
  const queued = buildQueuedAtlasLiveBufferDetail({ toolName, args, reason: "owner_executor" });
  if (!queued) return null;
  const detail = {
    ...queued,
    attempted: false,
    queued: true,
    ok: null,
  };
  recordAtlasLiveObservation({
    ...detail,
    summary: `ATLAS buffer.push (${detail.path || "unknown path"}) deferred to owner executor`,
    detail,
  });
  const refresh = detail.path
    ? await maybeRefreshAtlasIndexAfterLiveWrite({ relPath: detail.path, toolName, source: "deterministic_write" })
    : null;
  appendToolLog({
    event: "atlas_live_buffer_deferred_to_owner",
    tool: toolName,
    path: queued.path || null,
    reason: "owner_executor",
  });
  return {
    ...detail,
    ...(refresh ? { refresh } : {}),
  };
}

async function maybeRefreshAtlasIndexAfterLiveWrite({ relPath, toolName, source }) {
  const observation = {
    action: "index.refresh",
    path: relPath,
    attempted: false,
    ok: null,
    via: "AtlasToolExecutor",
    reason: "owner_executor",
    tool: toolName,
    source,
    observation_type: "atlas.index_refresh",
  };
  recordAtlasLiveObservation({
    ...observation,
    summary: `ATLAS index.refresh (${relPath}) deferred to owner executor`,
    detail: observation,
  });
  return observation;
}

async function readAtlasLiveBufferContent({ absPath, relPath, toolName }) {
  try {
    return await ATLAS_LIVE_BUFFER_GATE.read(
      absPath,
      async () => {
        let stat = null;
        try {
          stat = await fs.promises.stat(absPath);
        } catch (err) {
          if (err?.code === "ENOENT") return { ok: false, reason: "missing" };
          return { ok: false, reason: "stat_failed", error: capString(err?.message || String(err), 240) };
        }
        if (!stat.isFile()) return { ok: false, reason: "not_file" };
        const size = Number(stat.size || 0);
        if (size > 512 * 1024) return { ok: false, reason: "file_too_large", size };
        try {
          return { ok: true, content: await fs.promises.readFile(absPath, "utf8") };
        } catch (err) {
          return { ok: false, reason: "read_failed", error: capString(err?.message || String(err), 240) };
        }
      },
      { label: `atlas.liveBuffer.${toolName}:${relPath}`, waitMs: 5000 },
    );
  } catch (err) {
    return { ok: false, reason: "gate_timeout", error: capString(err?.message || String(err), 240) };
  }
}

// Framing mode is detected from the first received message.
// "jsonl" = newline-delimited JSON (current MCP stdio spec).
// "lsp"   = LSP-style Content-Length header framing (older transport).
let outboundFraming = "jsonl";

function sendMessage(payload) {
  const body = JSON.stringify(payload);
  if (outboundFraming === "lsp") {
    const bytes = Buffer.from(body, "utf8");
    process.stdout.write(`Content-Length: ${bytes.byteLength}\r\n\r\n`, "utf8");
    process.stdout.write(bytes);
  } else {
    process.stdout.write(`${body}\n`, "utf8");
  }
}

async function handleRequest(msg) {
  const session = hiddenSessionFromParams(msg?.params);
  // Owner-hot messages are session-scoped per message; without the hidden
  // param the module globals (mcpJobId/mcpAttemptId/role/cwd) are STICKY
  // leftovers from the previous message. Job-scoped tools consult this flag
  // so a message whose shim handshake failed to attach the param can never
  // read or ack ANOTHER session's operator feedback. Requests are serialized
  // by requestQueue, so a module flag is race-free.
  mcpMessageSessionScoped = !!session;
  if (session) {
    applyRuntimeBootConfig(session.bootConfig);
    msg = { ...msg, params: stripHiddenSessionParam(msg?.params) };
  }
  const { id, method, params } = msg || {};
  if (!method) {
    if (id != null) sendMessage(jsonRpcError(id, -32600, "Invalid request: missing method"));
    return;
  }

  if (method === "initialize") {
    sendMessage(jsonRpcSuccess(id, {
      protocolVersion: params?.protocolVersion || SUPPORTED_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    maybeFailOpenLockedGate("limbo_timeout_tools_list");
    let nativeAllowedToolNames;
    let atlasAllowedActions;
    try {
      nativeAllowedToolNames = await resolveNativeAllowedToolNames();
      atlasAllowedActions = await resolveAtlasAllowedActions();
    } catch (err) {
      sendRemoteToolCatalogError(id, err, "tools/list");
      return;
    }
    const nativeToolSchemas = [...TOOL_SCHEMA_MAP.values()]
      .filter((schema) => !nativeAllowedToolNames || nativeAllowedToolNames.has(schema.name));
    const nativeTools = nativeToolSchemas.map(buildGatewayNativeToolDescriptor);
    const allAtlasTools = atlasAvailable ? getStaticAtlasToolSchemas() : [];
    const atlasToolsRawCount = allAtlasTools.length;
    // Filter to the per-role allowlist so the LLM physically can't see ATLAS
    // tools its role isn't routed to. Actual execution is intercepted by the
    // parent MCP owner and routed through AtlasToolExecutor/conductor.
    const atlasTools = allAtlasTools
      .filter((tool) => atlasAllowedActions?.has(_stripAtlasPrefix(tool?.name)))
      .filter((tool) => isExternallyRoutedAtlasTool(tool?.name))
      .map(buildFoldedAtlasToolDescriptor);
    if (isGateActive({ scopeKey: gateScopeKey }) && atlasTools.length === 0) {
      unlockForAtlasUnavailable({ reason: "atlas_tools_unavailable", scopeKey: gateScopeKey });
      appendToolLog({
        event: "atlas_gate_released_no_tools",
        requestId: id ?? null,
        role: roleName,
        atlasRawCount: atlasToolsRawCount,
        atlasCatalogSource: atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions ? "remote" : "local",
      });
    }
    const tools = [...nativeTools, ...atlasTools];
    appendToolLog({
      event: "tools_list",
      requestId: id ?? null,
      toolCount: tools.length,
      nativeCount: nativeTools.length,
      atlasCount: atlasTools.length,
      atlasCountFiltered: atlasToolsRawCount - atlasTools.length,
      toolCatalogSource: (nativeAllowedToolNames || (atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions)) ? "remote" : "local",
      atlasCatalogSource: atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions ? "remote" : "local",
      tools: tools.map((tool) => tool.name),
    });
    sendMessage(jsonRpcSuccess(id, { tools }));
    return;
  }

  if (method === "tools/call") {
    maybeFailOpenLockedGate("limbo_timeout_tools_call");
    const requestedToolName = String(params?.name || "");
    const normalizedRequestToolName = _normalizeGatewayToolRequestName(requestedToolName);
    const requestedAtlasTool = normalizedRequestToolName.startsWith("atlas.") || normalizedRequestToolName.startsWith("atlas_");
    const toolName = requestedAtlasTool ? normalizedRequestToolName : _stripToolsPrefix(normalizedRequestToolName);
    const args = params?.arguments || {};
    const start = Date.now();
    let nativeAllowedToolNames;
    let atlasAllowedActions;
    try {
      nativeAllowedToolNames = requestedAtlasTool ? null : await resolveNativeAllowedToolNames();
      atlasAllowedActions = requestedAtlasTool
        ? await resolveAtlasAllowedActions()
        : _atlasAllowedActions;
    } catch (err) {
      sendRemoteToolCatalogError(id, err, "tools/call");
      return;
    }
    appendToolLog({
      event: "tool_call",
      requestId: id ?? null,
      tool: requestedToolName,
      canonicalTool: toolName,
      arguments: sanitizeForLog(args),
    });

    if (shouldBlockForResearchSynthesis(requestedToolName, { requestedAtlasTool })) {
      const errorText = buildResearchSynthesisRequiredMessage(requestedToolName);
      appendToolLog({
        event: "research_synthesis_gate",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        explorationSteps: researchState.explorationSteps,
        staleSteps: researchSynthesisStaleStepCount(),
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: errorText }],
        isError: true,
      }));
      return;
    }

    // Route 1: ATLAS tool names should be intercepted by the parent MCP owner
    // and executed via AtlasToolExecutor/conductor. If a direct legacy call
    // reaches this hot gateway process, enforce the same allowlist and fail
    // loudly instead of running ATLAS runtime work inside MCP.
    if (requestedAtlasTool) {
      if (!isStaticAtlasToolName(toolName)) {
        appendToolLog({
          event: "atlas_call_denied",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          role: roleName,
          reason: "unknown_atlas_tool",
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{ type: "text", text: `Unknown ATLAS tool "${requestedToolName}"` }],
          isError: true,
        }));
        return;
      }
      if (isBlockedFoldedAtlasTool(toolName)) {
        appendToolLog({
          event: "atlas_call_denied",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          role: roleName,
          reason: "mutating_atlas_tool_blocked_in_gateway",
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: blockedAtlasMutationMessage(toolName),
          }],
          isError: true,
        }));
        return;
      }
      if (isFallbackOnlyAtlasTool(toolName)) {
        appendToolLog({
          event: "atlas_call_denied",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          role: roleName,
          reason: "fallback_only_atlas_tool",
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: `ATLAS tool ${toolName} is intentionally not exposed. Use deterministic read_file/chain_read as the raw-read fallback after ATLAS discovery, or when ATLAS is unavailable or insufficient.`,
          }],
          isError: true,
        }));
        return;
      }
      const routeCheck = _atlasCallAllowedByRoute(toolName, args, atlasAllowedActions);
      if (!routeCheck.allowed) {
        appendToolLog({
          event: "atlas_call_denied",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          effectiveAction: routeCheck.effectiveAction,
          role: roleName,
          atlasCatalogSource: atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions ? "remote" : "local",
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: `ATLAS action ${routeCheck.effectiveAction || requestedToolName} is not allowed for the ${roleName || "this"} role. Use one of the role's allowed ATLAS tools instead.`,
          }],
          isError: true,
        }));
        return;
      }
      try {
        appendToolLog({
          event: "atlas_call_deferred_to_owner_required",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          via: "atlas-tool-executor",
          ok: false,
          durationMs: Date.now() - start,
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: `ATLAS tool ${requestedToolName} must be executed by the Posse MCP owner through AtlasToolExecutor; direct gateway execution is disabled.`,
          }],
          isError: true,
        }));
      } catch (err) {
        const safeError = capString(err?.message || String(err), 300);
        appendToolLog({
          event: "tool_result",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          via: "atlas-tool-executor",
          ok: false,
          durationMs: Date.now() - start,
          error: safeError,
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{ type: "text", text: `Error executing ${requestedToolName}: ${safeError}` }],
          isError: true,
        }));
      }
      return;
    }

    if (nativeAllowedToolNames && !nativeAllowedToolNames.has(toolName)) {
      appendToolLog({
        event: "native_call_denied",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        role: roleName,
        toolCatalogSource: "remote",
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{
          type: "text",
          text: `Tool ${requestedToolName} is not allowed for the ${roleName || "current"} remote-issued tool surface.`,
        }],
        isError: true,
      }));
      return;
    }

    if (shouldBlockForResearchSynthesis(toolName)) {
      const errorText = buildResearchSynthesisRequiredMessage(toolName);
      appendToolLog({
        event: "research_synthesis_gate",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        explorationSteps: researchState.explorationSteps,
        staleSteps: researchSynthesisStaleStepCount(),
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: errorText }],
        isError: true,
      }));
      return;
    }

    // Route 2: Native tool, but the ATLAS-first gate is active for this role
    // and the tool is still locked. Return a verbose isError so the LLM reads
    // the rule and redirects to an ATLAS call.
    if (isGateActive({ scopeKey: gateScopeKey }) && isGatedTool(toolName)) {
      const gateDecision = checkNativeToolAllowed(toolName, args, { cwd: workspaceCwd, scopeKey: gateScopeKey });
      if (gateDecision.allowed) {
        // Continue to the native handler below.
      } else {
        const errorText = buildLockedToolError(toolName, { args, cwd: workspaceCwd, scopeKey: gateScopeKey });
        appendToolLog({
          event: "tool_gated",
          requestId: id ?? null,
          tool: requestedToolName,
          canonicalTool: toolName,
          reason: gateDecision.reason || null,
          target: gateDecision.target || null,
        });
        sendMessage(jsonRpcSuccess(id, {
          content: [{ type: "text", text: errorText }],
          isError: true,
        }));
        return;
      }
    }

    const handler = TOOL_EXECUTORS.get(toolName);
    if (!handler) {
      appendToolLog({
        event: "tool_result",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        ok: false,
        durationMs: Date.now() - start,
        error: `Unknown tool "${toolName}"`,
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: `Error: Unknown tool "${requestedToolName}"` }],
        isError: true,
      }));
      return;
    }
    // For chain_verdict the file path lives in the server's chain state, not
    // in the tool args. Enrich the recorded input so the observation actually
    // identifies which file the verdict applies to.
    const recordInput = (toolName === "chain_verdict" && researchState?.currentlyReading?.path)
      ? { ...args, path: researchState.currentlyReading.path }
      : args;
    // Record the request the moment it's made (append-only "<type>.started"),
    // then close it with the completion row on every exit path so duration and
    // success/failure are captured — not just successful completions.
    const toolInvocation = beginToolInvocation({ tool: toolName, input: recordInput, cwd: workspaceCwd });
    try {
      const result = await handler(args);
      const text = typeof result === "string" ? result : inspect(result, { depth: 4, breakLength: 120 });
      const responseText = appendOperatorFeedbackSignal(text, toolName);
      const ok = isSuccessfulNativeToolResult(text);
      if (ok && toolName !== "chain_verdict") {
        noteResearchExplorationStep({ toolName });
      }
      const atlasLiveBuffer = ok ? await maybePushAtlasLiveBufferForToolObservation({ toolName, args }) : null;
      const readStats = ok ? nativeReadResultStats(toolName, text) : null;
      finishToolInvocation(toolInvocation, {
        tool: toolName,
        input: recordInput,
        cwd: workspaceCwd,
        ok,
        ...(atlasLiveBuffer || readStats ? {
          extraDetail: {
            ...(atlasLiveBuffer ? { atlas_live_buffer: atlasLiveBuffer } : {}),
            ...(readStats || {}),
          },
        } : {}),
      });
      appendToolLog({
        event: "tool_result",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        ok,
        durationMs: Date.now() - start,
        resultPreview: capString(text, 300),
      });
      sendMessage(jsonRpcSuccess(id, { content: [{ type: "text", text: responseText }] }));
    } catch (err) {
      const safeError = capString(err?.message || String(err), 300);
      finishToolInvocation(toolInvocation, {
        tool: toolName,
        input: recordInput,
        cwd: workspaceCwd,
        ok: false,
        error: safeError,
      });
      appendToolLog({
        event: "tool_result",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        ok: false,
        durationMs: Date.now() - start,
        error: safeError,
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: `Error executing ${requestedToolName}: ${safeError}` }],
        isError: true,
      }));
    }
    return;
  }

  if (id != null) {
    sendMessage(jsonRpcError(id, -32601, `Method not found: ${method}`));
  }
}

let inputBuffer = Buffer.alloc(0);
let requestQueue = Promise.resolve();

function dispatchParsed(parsed) {
  // Re-establish observation context per-message — stdin's async scope
  // predates module-level enterObservationContext, so ALS values set at
  // load time don't propagate into data events.
  const session = hiddenSessionFromParams(parsed?.params);
  const sessionBoot = session?.bootConfig || {};
  requestQueue = requestQueue.then(() => runWithObservationContext(
    {
      work_item_id: Number(sessionBoot.workItemId) || mcpWorkItemId,
      job_id: Number(sessionBoot.jobId) || mcpJobId,
      attempt_id: Number(sessionBoot.attemptId) || mcpAttemptId,
    },
    () => handleRequest(parsed),
  )).catch((err) => {
    const id = parsed && Object.prototype.hasOwnProperty.call(parsed, "id") ? parsed.id : null;
    const safeError = capString(err?.message || String(err), 300);
    appendToolLog({
      event: "json_rpc_request_error",
      requestId: id ?? null,
      method: parsed?.method || null,
      error: safeError,
    });
    if (id == null) return;
    try {
      sendMessage(jsonRpcError(id, -32603, safeError || "Internal error"));
    } catch {
      // If stdout is already closed (for example EPIPE), there is no
      // protocol response channel left. Keep the process from crashing.
    }
  });
}

function reportParseError(framing, err, byteLength) {
  const error = capString(err?.message || String(err || "Malformed JSON-RPC frame"), 200);
  appendToolLog({
    event: "json_rpc_parse_error",
    framing,
    byteLength,
    error,
  });
  try {
    process.stderr.write(`[posse-mcp] JSON-RPC parse error (${framing}, ${byteLength} bytes): ${error}\n`);
  } catch {
    // Diagnostics must never interfere with protocol error delivery.
  }
  sendMessage(jsonRpcError(null, -32700, "Parse error"));
}

// Supports both MCP stdio framings:
//   - Newline-delimited JSON (current MCP spec, used by claude CLI v2.1+)
//   - LSP-style Content-Length: N\r\n\r\n<json> headers (older MCP transport)
// Detection is per-message: if the buffer starts with "Content-Length:" we
// consume a header-framed message; otherwise we peel off newline-delimited JSON.
function processInputBuffer() {
  while (inputBuffer.length > 0) {
    // Skip leading whitespace/newlines between messages.
    let offset = 0;
    while (offset < inputBuffer.length) {
      const c = inputBuffer[offset];
      if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09) offset++;
      else break;
    }
    if (offset > 0) inputBuffer = inputBuffer.subarray(offset);
    if (inputBuffer.length === 0) return;

    // Header-framed (LSP-style) detection: first non-ws bytes are "Content-Length:".
    const headPreview = inputBuffer.subarray(0, Math.min(16, inputBuffer.length)).toString("utf8").toLowerCase();
    if (headPreview.startsWith("content-length:")) {
      outboundFraming = "lsp";
      const separatorIndex = inputBuffer.indexOf("\r\n\r\n");
      if (separatorIndex < 0) return; // incomplete header — wait for more
      const headerBlock = inputBuffer.subarray(0, separatorIndex).toString("utf8");
      const match = headerBlock.match(/content-length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.subarray(separatorIndex + 4);
        reportParseError("lsp", new Error("Invalid Content-Length header"), Buffer.byteLength(headerBlock));
        continue;
      }
      const contentLength = Number.parseInt(match[1], 10);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_STDIN_CONTENT_LENGTH_BYTES) {
        inputBuffer = inputBuffer.subarray(separatorIndex + 4);
        reportParseError("lsp", new Error(`Content-Length ${match[1]} exceeds maximum ${MAX_STDIN_CONTENT_LENGTH_BYTES}`), Buffer.byteLength(headerBlock));
        continue;
      }
      const messageStart = separatorIndex + 4;
      const messageEnd = messageStart + contentLength;
      if (inputBuffer.length < messageEnd) return; // body incomplete
      const jsonBody = inputBuffer.subarray(messageStart, messageEnd).toString("utf8");
      inputBuffer = inputBuffer.subarray(messageEnd);
      try {
        dispatchParsed(JSON.parse(jsonBody));
      } catch (err) {
        reportParseError("lsp", err, Buffer.byteLength(jsonBody));
      }
      continue;
    }

    // Newline-delimited JSON (current MCP stdio spec).
    const newlineIdx = inputBuffer.indexOf(0x0a); // \n
    if (newlineIdx < 0) return; // incomplete line — wait for more
    const lineBytes = inputBuffer.subarray(0, newlineIdx);
    inputBuffer = inputBuffer.subarray(newlineIdx + 1);
    let line = lineBytes.toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.trim();
    if (!line) continue;
    try {
      dispatchParsed(JSON.parse(line));
    } catch (err) {
      reportParseError("jsonl", err, Buffer.byteLength(line));
    }
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processInputBuffer();
  // Anything still buffered here is an incomplete frame. The 16MB limit on
  // Content-Length only bounds declared bodies; a frame that never completes
  // (e.g. a JSONL line with no newline) would otherwise accumulate forever.
  if (inputBuffer.length > MAX_STDIN_BUFFER_BYTES) {
    reportParseError(
      "stream",
      new Error(`stdin buffered ${inputBuffer.length} bytes without a complete frame (max ${MAX_STDIN_BUFFER_BYTES})`),
      inputBuffer.length,
    );
    inputBuffer = Buffer.alloc(0);
  }
});

let shuttingDown = false;

async function shutdownAndExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await requestQueue; } catch { /* requestQueue is best-effort guarded */ }
  process.exit(code);
}

process.stdin.on("error", () => { void shutdownAndExit(0); });
process.stdin.on("end", () => { void shutdownAndExit(0); });
process.once("SIGINT", () => { void shutdownAndExit(130); });
process.once("SIGTERM", () => { void shutdownAndExit(143); });
