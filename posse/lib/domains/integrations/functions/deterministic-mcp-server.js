import { COMPACT_RELATIONSHIP_PROJECTION, COMPACT_STRUCTURE_PROJECTION } from "../../../catalog/atlas-presentation.js";
import { readPlannerDispatchPolicy } from "../../planning/functions/planner-dispatch-policy.js";
import { applyPlannerSchemaDiet } from "../../../shared/tools/functions/planner-schema-diet.js";
import crypto from "node:crypto";
import process from "process";
import fs from "fs";
import path from "path";
import { inspect } from "util";
import { atlasNativeToolIsComplementary, atlasReplacesNativeTool } from "../../../catalog/tools/source-navigation.js";
import { blameWithoutLineText } from "../../git/functions/history.js";
import { redactComplementaryReadResult } from "./deterministic-mcp/read-file-redaction.js";
import { createScopedMutationTools } from "./deterministic-mcp/scoped-mutations.js";
import { ResearchSessionStore } from "../classes/ResearchSessionStore.js";
import { redactComplementarySearchRows } from "./deterministic-mcp/search-file-redaction.js";
import { TOOL_HASH_FILE, TOOL_LIST_FILES, TOOL_READ_FILE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_REQUEST_SCOPE, TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT, TOOL_RUN_UNIT_TEST, TOOL_SEARCH_FILES, TOOL_GIT_HISTORY, TOOL_INSPECT_FILE, TOOL_BASH, TOOL_AGENT_FEEDBACK, TOOL_GET_OPERATOR_FEEDBACK, TOOL_ACK_OPERATOR_FEEDBACK, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR, TOOL_CHAIN_READ, TOOL_CHAIN_VERDICT, TOOL_GENERATE_IMAGE, TOOL_GET_BRIEF, buildScopePredicates, createDeterministicToolkit, createBashExecutor, safePath } from "../../../shared/tools/functions/toolkit/index.js";
import { TOOL_PROJECT_DB_QUERY, TOOL_AGENT_CLAIM, TOOL_REPORT_CLAIMS, TOOL_SUB_AGENT, TOOL_SUB_AGENT_NEXT_INPUT, TOOL_WEB_RESEARCH_HANDOFF, TOOL_DOWNLOAD_FILE, TOOL_COMPOSE_SPRITE_SHEET, TOOL_VIEW_IMAGE } from "../../../catalog/native-tools.js";
import { downloadFilesWithinScope } from "../../web-research/functions/download-files.js";
import { composeSpriteSheetWithinScope } from "../../../shared/tools/functions/toolkit/sprite-sheet.js";
import { viewImageWithinScope } from "../../../shared/tools/functions/toolkit/view-image.js";
import { asMcpContentResult } from "../../../shared/tools/functions/mcp-content-result.js";
import { resolveWebToolsEnabled } from "../../providers/functions/shared/tool-policy-settings.js";
import { CUSTOM_TOOLS_AGENT_REQUEST_TIMEOUT_MS, TOOL_CUSTOM_TOOLS } from "../../../catalog/custom-tools.js";
import { MCP_SESSION_RELEASED_NOTIFICATION } from "../../../catalog/mcp.js";
import { IMAGE_GENERATION_MAX_CALLS_PER_JOB } from "../../../catalog/artifact.js";
import { TOOL_SURFACE_ISSUED_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { discoverUnitTestCapability } from "../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { roleUsesCanonicalRefTraversal } from "../../../catalog/tool-surface/ref-traversal.js";
import { assessorFallbackReadCallKey, isAssessorFallbackReadKey } from "../../assessment/functions/fallback-read-tools.js";
import { assessorToolBudgetApplies, assessorToolCallCeilingDecision, ASSESSOR_READ_ALLOWANCE_ADVISORY_TEXT } from "../../../shared/tools/functions/assessor-tool-budget.js";
import { execProjectDbQuery } from "../../../shared/tools/functions/toolkit/project-db/query.js";
import { recordAgentHandoffRejection, rejectAgentHandoffForLaterTool, stageAgentHandoff, getTraversalCompletionSnapshotForCall } from "../../handoff/functions/agent-handoff.js";
import { executeResearchReportClaims } from "../../handoff/functions/research-report-claim-drafts.js";
import { assertSubAgentParentReady, executeSubAgent, executeSubAgentNextInput, prepareSubAgentHandoff, sealSubAgentHandoff } from "../../sub-agent/classes/SubAgentRuntime.js";
import { executeDispatchAgent, submitWebResearchHandoff } from "../../web-research/classes/WebResearchRuntime.js";
import { capProjectDbPermissions, readProjectDbConfig } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { projectDbQuerySchemaForPermissions } from "../../../shared/tools/functions/toolkit/project-db/schema.js";
import { ToolRegistry } from "../../../shared/tools/classes/ToolRegistry.js";
import { AutomationOwnerClient } from "../../automation/classes/AutomationOwnerClient.js";
import { declareToolSuites, registeredToolNames } from "../../../shared/tools/functions/tool-suites.js";
import { appendHashRefIfMajor } from "../../../shared/tools/functions/hash-adder.js";
import { ContextMeter } from "../../../shared/classes/ContextMeter.js";
import { normalizeProjectDbCapability } from "../../../shared/tools/functions/issued-tool-policy.js";
import { execGenerateImageInternal } from "../../providers/functions/shared/image-generate-internal.js";
import { operatorFeedbackDeliveryForJob, operatorFeedbackDeliveryText } from "../../providers/functions/shared/operator-feedback-delivery.js";
import { recordToolInvocation as _recordToolInvocation, recordObservation as _recordObservation, beginToolInvocation as _beginToolInvocation, finishToolInvocation as _finishToolInvocation, enterObservationContext, nativeReadResultStats, researchExplorationObservationStatus, runWithObservationContext } from "../../observability/functions/observations.js";
import { scopedCheckToolResultObservation } from "../../observability/functions/scoped-check-tool-result.js";
import { unitTestToolResultObservation } from "../../observability/functions/unit-test-tool-result.js";
import { acknowledgeOperatorFeedback, awaitJobScopeExpansionDecision, countPendingOperatorFeedbackForJob, getIntSetting, getOperatorFeedbackForJob, grantApprovedScopeEntries, LIVE_SCOPE_WAIT_TIMEOUT_MS, recordAgentActivity } from "../../queue/functions/index.js";
import { runWithTeamManagedToolGrant } from "../../pairing/functions/team-managed-write.js";
import { getAtlasIntegrationConfig, getAtlasRouteForRole } from "./atlas/config.js";
import "./atlas-v2-mode.js";
import { atlasBackendLabel } from "./atlas-label.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { PulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import { ParentPulseTokenManager } from "../../../shared/native/classes/ParentPulseTokenManager.js";
import { prewarmNativeGitAuth } from "../../git/functions/native/prewarm.js";
import { DEFAULT_MCP_OAUTH_TTL_SECONDS, MCP_OAUTH_AUDIENCE, MCP_OAUTH_TOKEN_TYPE, MCP_PROTOCOL_VERSION, POSSE_MCP_GATEWAY_SERVER_INFO_NAME, POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../catalog/mcp.js";
import { renderAgentHandoffCallableName } from "../../../shared/tools/functions/mcp-surface.js";
import { AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";
import { REMOTE_CATALOG_READ_ROUTE } from "../../../catalog/binary.js";
import { buildAtlasGateScopeKey, configureGate, isGateActive, ATLAS_CHAIN_READ_MAX_LINES, ATLAS_RESEARCHER_READ_MAX_LINES, isIndexableSourcePath, noteAtlasCall, releaseGate, unlockForAtlasUnavailable, isFallbackAtlasPrefetchStatus } from "./deterministic-mcp/gate.js";
import { resolveAtlasGatewayDedupAdvertise, resolveAtlasResearcherSchemaDiet, resolveResearchSynthesisPolicySnapshot } from "./deterministic-mcp/gate-settings.js";
import { applyResearcherTypedNativeToolShape, buildResearcherDirectTools, researcherTypedLanguageLeversForRootEntries } from "./deterministic-mcp/researcher-dispatcher.js";
import { applyResearcherSchemaDiet } from "./deterministic-mcp/researcher-schema-diet.js";
import { bootConfigFromMcpOAuthClaims, buildMcpOAuthClaimsFromBootConfig, verifyMcpOAuthToken } from "./deterministic-mcp/oauth-token.js";
import { DETERMINISTIC_IMAGE_HELPER_TOOLS, DETERMINISTIC_IMAGE_TOOLS, DETERMINISTIC_IMAGE_VIEW_TOOLS, DETERMINISTIC_OCR_TOOLS, DETERMINISTIC_WRITE_TOOLS, SURFACED_ATLAS_TOOL_DEFS, buildFoldedAtlasToolDescriptor, buildNativeToolDescriptor, getDeterministicMcpToolNames, getToolSchemaForRole, isBlockedFoldedAtlasTool, isExternallyRoutedAtlasTool, isFallbackOnlyAtlasTool } from "./deterministic-mcp/tool-descriptors.js";
import { ATLAS_TOOL_ACTIONS } from "../../atlas/functions/v2/contracts/tool-params.js";
import { stripPosseMcpGatewayPrefix } from "./mcp-gateway.js";
import { setRuntimePathOverrides } from "../../runtime/functions/paths.js";
import { AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { readResponseTextWithLimit } from "../../remote/functions/client.js";
import { sanitizeAbsolutePathsInText } from "../../../shared/format/functions/display-paths.js";
import { parseEnvBool, parseBoolOverride, bootString, nonNegativeIntegerOrNull } from "./deterministic-mcp/boot-config-parse.js";
import { capString, sanitizeForLog } from "./deterministic-mcp/log-helpers.js";
import { projectAgentToolSchema, sortAgentToolDefinitions } from "../../../shared/tools/functions/agent-schema.js";
import { resolveAgentFileAuthority } from "./deterministic-mcp/agent-file-authority.js";
import { RESEARCH_CITATION_FETCH_GATE_ENABLED, RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS, NATIVE_DUPLICATE_READ_SUPPRESSED_PREFIX, RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS, RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS, RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS, buildResearchCitationFetchGateText, buildResearchCurtainCallText, buildResearchSynthesisRequiredText, isResearchAtlasCitationFetchAction, isResearchAtlasExplorationAction, researchSynthesisDecision, researchSynthesisExplorationCeiling } from "./deterministic-mcp/research-synthesis.js";
import { jsonRpcSuccess, jsonRpcError, hiddenSessionFromParams, stripHiddenSessionParam, classifyNativeToolResult, isSuccessfulNativeToolResult } from "./deterministic-mcp/json-rpc.js";

/** Safe wrapper — recording must never break tool execution in the MCP subprocess. */


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

// A tools/call answered by a gate never reaches the handler's begin/finish
// pair. Record it as rejected and not executed, or provider-replay
// reconciliation files it as an executed call and research counts it as a step.
function recordRejectedToolCall({ toolName, args, text, reason }) {
  const invocation = beginToolInvocation({ tool: toolName, input: args, cwd: workspaceCwd });
  finishToolInvocation(invocation, {
    tool: toolName,
    input: args,
    cwd: workspaceCwd,
    ok: false,
    outcome: "rejected",
    rejection: text,
    extraDetail: {
      executed: false,
      consumed_step: false,
      gate_reason: reason || null,
      transport: "deterministic_mcp",
    },
  });
}

const SERVER_INFO = { name: POSSE_MCP_GATEWAY_SERVER_INFO_NAME, version: "1.0.0" };
// Atlas325 P0.1: no run artifact recorded the tool surface the provider
// actually saw (names, atlas.query action enum, schema digest, effective
// policy, research limits). Record it once per attempt and issued digest.
// The observation type deliberately starts with "tool." so it sits beside the
// tool ledger, but every tool-mix consumer must skip it: it is not a call.
export { TOOL_SURFACE_ISSUED_OBSERVATION_TYPE } from "../../../catalog/observation.js";
const issuedToolSurfaceRecords = new Map();
const ISSUED_TOOL_SURFACE_RECORD_LIMIT = 256;

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function recordIssuedToolSurfaceObservation({
  tools = [],
  atlasTools = [],
  effectivePolicy = {},
  projections = {},
} = {}) {
  try {
    const canonical = JSON.stringify(tools);
    const schemaSha256 = sha256Hex(canonical);
    const attemptKey = `${mcpAttemptId ?? "none"}|${mcpJobId ?? "none"}|${schemaSha256}`;
    if (issuedToolSurfaceRecords.has(attemptKey)) return null;
    issuedToolSurfaceRecords.set(attemptKey, Date.now());
    while (issuedToolSurfaceRecords.size > ISSUED_TOOL_SURFACE_RECORD_LIMIT) {
      issuedToolSurfaceRecords.delete(issuedToolSurfaceRecords.keys().next().value);
    }
    const names = tools.map((tool) => String(tool?.name || "")).filter(Boolean);
    const actionEnum = atlasTools.map((tool) => _stripAtlasPrefix(String(tool?.name || ""))).filter(Boolean);
    const instructions = mcpServerInstructions();
    const detail = {
      kind: "tool_surface_issued",
      // The hot gateway loads a union catalog and the persistent owner applies
      // the final per-session allowlist to its response. Do not mistake this
      // internal candidate surface for the provider-visible surface.
      projection_stage: ownerHotGateway ? "gateway_candidate" : "provider_issued",
      names,
      tool_count: names.length,
      action_enum: actionEnum,
      action_enum_source: "atlas_tool_names",
      schema_sha256: schemaSha256,
      schema_chars: canonical.length,
      effective_policy: effectivePolicy,
      limits: { ...currentResearchSynthesisPolicySnapshot() },
      projections,
      instructions_sha256: instructions ? sha256Hex(instructions) : null,
      role: roleName,
      provider: providerName,
      agent_call_id: mcpAgentCallId ?? null,
    };
    _recordObservation({
      work_item_id: mcpWorkItemId ?? undefined,
      job_id: mcpJobId ?? undefined,
      attempt_id: mcpAttemptId ?? undefined,
      observation_type: TOOL_SURFACE_ISSUED_OBSERVATION_TYPE,
      summary: `${ownerHotGateway ? "Gateway candidate" : "Issued"} tool surface: ${names.length} tool${names.length === 1 ? "" : "s"}; ${actionEnum.length} Atlas action${actionEnum.length === 1 ? "" : "s"}; schema ${schemaSha256.slice(0, 12)}`,
      detail,
    });
    return detail;
  } catch {
    return null; // advisory telemetry must never break tools/list
  }
}
function mcpServerInstructions() {
  if (!allowWrite || (roleName !== "dev" && roleName !== "artificer" && roleName !== "fix")) return null;
  return "Use the exposed Posse mutation tool for permitted changes; native apply_patch and shell writes are unavailable.";
}
const MAX_STDIN_CONTENT_LENGTH_BYTES = 16 * 1024 * 1024;
// Hard ceiling on accumulated, unframed stdin. A complete legal frame is
// consumed as soon as it arrives, so the buffer only approaches this when a
// writer streams bytes with no newline / short Content-Length body — 2x the
// frame max leaves room for one max-size body plus headers and pipelining.
const MAX_STDIN_BUFFER_BYTES = MAX_STDIN_CONTENT_LENGTH_BYTES * 2;
const scopeParseState = { invalid: false };
const DETERMINISTIC_TOOL_GATE = new AsyncResourceGate({ name: "deterministic native tool" });
((() => {
  const parsed = Number(process.env.POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFER_TOOL_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
})());

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
    attemptId: String(env.POSSE_DETERMINISTIC_MCP_ATTEMPT_ID || "").trim(),
    atlasAvailable: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE),
    atlasGateEnabled: parseEnvBool(env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED),
    atlasPrefetchStatus: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_PREFETCH_STATUS || "").trim(),
    imageGenerationMaxCalls: String(env.POSSE_DETERMINISTIC_MCP_IMAGE_GENERATION_MAX_CALLS || "").trim(),
    atlas: {
      repoPath: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH || "").trim(),
      repoId: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID || "").trim(),
      graphDbPath: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_GRAPH_DB_PATH || "").trim(),
      liveBuffers: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFERS || env.POSSE_ATLAS_LIVE_BUFFERS || "").trim(),
      codeWindowPolicy: {
        maxWindowLines: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_MAX_WINDOW_LINES || "").trim(),
        maxWindowTokens: String(env.POSSE_DETERMINISTIC_MCP_ATLAS_MAX_WINDOW_TOKENS || "").trim(),
      },
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

let testOAuthVerificationAttempts = 0;

function bootConfigFromOAuthToken(config = {}, { markInvalid = true } = {}) {
  const token = String(
    config.mcpOAuthToken
    || config.mcpOauthToken
    || config.mcpAuth?.accessToken
    || config.mcpAuth?.token
    || "",
  ).trim();
  if (!token) return config;
  try {
    if (
      (process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN)
      && process.env.POSSE_TEST_MCP_OAUTH_FAIL_AFTER_FIRST_VERIFY === "1"
      && testOAuthVerificationAttempts++ > 0
    ) {
      throw Object.assign(new Error("synthetic MCP OAuth expiry during deferred resume"), {
        code: "token_expired",
      });
    }
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
    if (markInvalid) scopeParseState.invalid = true;
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
if (bootConfig?.mcpOAuth?.verified === false) scopeParseState.invalid = true;
const ownerHotProcess = bootConfig.ownerHotGateway === true;
let ownerHotGateway = ownerHotProcess || bootConfig.ownerHotGateway === true;
let workspaceCwd = String(bootConfig.cwd || "").trim() || process.cwd();
let allowWrite = bootConfig.allowWrite === true || ownerHotGateway;
// db-mode dev jobs run with allowWrite=false (no file tools) but carry the
// projectDbWrite capability: project_db_query stays on the write lane.
let projectDbWrite = bootConfig.projectDbWrite === true;
let projectDbCapabilityGrant = normalizeProjectDbCapability(
  bootConfig.projectDbCapability || (projectDbWrite ? "write" : "none"),
);
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
// Attempt scoping for the live operator channel makes automatic result
// attachment transactional and once-per-attempt, with the same audit semantics
// as the embedded transport.
let mcpAttemptId = Number(bootConfig.attemptId) || null;
let mcpAgentCallId = Number(bootConfig.agentCallId) || null;
let agentAuthorityError = null;
let mcpPromptChars = Math.max(0, Number(bootConfig.promptChars) || 0);
let atlasAvailable = bootConfig.atlasAvailable === true;
// Legacy boot configurations may still carry this flag. It no longer gates reads.
const atlasGateEnabled = false;
let atlasPrefetchStatus = String(bootConfig.atlasPrefetchStatus || "").trim().toLowerCase();
const GATEWAY_SCOPE_STATE_LIMIT = 5000;
const gatewayScopeStateByKey = new Map();
const ownerAtlasGateEventSeqByScope = new Map();
let imageGenerationMaxCalls = Number.isInteger(Number(bootConfig.imageGenerationMaxCalls)) && Number(bootConfig.imageGenerationMaxCalls) >= 0
  ? Number(bootConfig.imageGenerationMaxCalls)
  : IMAGE_GENERATION_MAX_CALLS_PER_JOB;
let remoteToolCatalogConfig = bootConfig.remoteCatalog && typeof bootConfig.remoteCatalog === "object"
  ? bootConfig.remoteCatalog
  : {};
let remoteToolCatalogPreload = bootConfig.remoteToolSurface && typeof bootConfig.remoteToolSurface === "object"
  ? bootConfig.remoteToolSurface
  : null;
const RESEARCH_NATIVE_EXPLORATION_TOOLS = new Set([
  "read_file",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
]);
const RESEARCH_NATIVE_SYNTHESIS_GATED_TOOLS = new Set([
  "read_file",
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

// Compatibility-only public trust metadata for direct config-json boots. The
// trusted owner-hot gateway replaces its pulse manager from the private startup
// handshake before MCP traffic; neither process receives POSSE_KEY, and native
// daemons pull signed pulse grants from their parent instead of authenticating
// each request.
if (!ownerHotProcess && bootConfig.nativeAuth && typeof bootConfig.nativeAuth === "object") {
  try {
    nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(bootConfig.nativeAuth));
  } catch { /* best effort: leave the default manager in place */ }
}

// Tag all tool observations with the job context so the display can query by job_id
if (mcpJobId || mcpWorkItemId) {
  enterObservationContext({
    work_item_id: mcpWorkItemId,
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    agent_call_id: mcpAgentCallId,
  });
}
ContextMeter.forContext({
  work_item_id: mcpWorkItemId,
  job_id: mcpJobId,
  attempt_id: mcpAttemptId,
  agent_call_id: mcpAgentCallId,
}, { promptChars: mcpPromptChars });

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

function gatewayScopeState(scopeKey = gateScopeKey, { gateConfiguration = null } = {}) {
  const key = String(scopeKey || "").trim();
  if (!key) throw new Error("Gateway scope state requires a scope key");
  let state = gatewayScopeStateByKey.get(key);
  if (!state) {
    state = {
      gateBootedAtMs: Date.now(),
      gateConfiguration,
      imageGenerationCallCount: 0,
      downloadBytes: 0,
      assessorToolCallCount: 0,
      assessorFallbackReadCount: 0,
      lastReadMeta: null,
    };
    gatewayScopeStateByKey.set(key, state);
  } else if (gateConfiguration != null && state.gateConfiguration !== gateConfiguration) {
    state.gateBootedAtMs = Date.now();
    state.gateConfiguration = gateConfiguration;
    ownerAtlasGateEventSeqByScope.delete(key);
  }
  return state;
}

function researcherTypedLanguageLevers(cwd = workspaceCwd) {
  const root = String(cwd || "").trim();
  if (!root) return researcherTypedLanguageLeversForRootEntries([]);
  try {
    return researcherTypedLanguageLeversForRootEntries(fs.readdirSync(root));
  } catch {
    return researcherTypedLanguageLeversForRootEntries([]);
  }
}

function assessorToolBudgetDecision(toolName, args = {}) {
  if (!assessorToolBudgetApplies(roleName, toolName)) return null;
  const state = gatewayScopeState(gateScopeKey);
  state.assessorToolCallCount += 1;
  const ceiling = assessorToolCallCeilingDecision({
    role: roleName,
    toolName,
    usedToolCalls: state.assessorToolCallCount,
    maxToolCalls: bootConfig.assessorMaxToolCalls,
  });
  if (ceiling.blocked) {
    return {
      reason: ceiling.reason,
      text: ceiling.text,
      used: ceiling.used,
      cap: ceiling.cap,
    };
  }
  if (!isAssessorFallbackReadKey(assessorFallbackReadCallKey(toolName, args))) return null;
  const fallbackReadCap = Number.isFinite(Number(bootConfig.fallbackReads))
    ? Math.max(0, Math.floor(Number(bootConfig.fallbackReads)))
    : 0;
  state.assessorFallbackReadCount += 1;
  if (state.assessorFallbackReadCount > fallbackReadCap) {
    // Past the allowance the read still runs; the decision is advisory so
    // an assessor that needs one more bounded read is never pushed into a
    // needs_review it did not mean, nor into a harness "exhaustion" requeue.
    return {
      advisory: true,
      reason: "fallback_read_ceiling",
      text: ASSESSOR_READ_ALLOWANCE_ADVISORY_TEXT,
      used: state.assessorFallbackReadCount,
      cap: fallbackReadCap,
    };
  }
  return null;
}

function assertGatewayScopeCapacity(scopeKey) {
  const key = String(scopeKey || "").trim();
  if (!key) throw new Error("Gateway scope state requires a scope key");
  if (gatewayScopeStateByKey.has(key) || gatewayScopeStateByKey.size < GATEWAY_SCOPE_STATE_LIMIT) return;
  const error = new Error(`MCP gateway scope capacity exhausted (${GATEWAY_SCOPE_STATE_LIMIT})`);
  error.code = "POSSE_MCP_GATEWAY_SCOPE_LIMIT";
  throw error;
}

function gatewayGateConfiguration({ role, atlasAvailable, enabled, atlasLabel }) {
  return JSON.stringify([
    String(role || "").trim() || null,
    enabled === true && atlasAvailable === true,
    String(atlasLabel || "ATLAS").trim() || "ATLAS",
  ]);
}

function releaseGatewayScope(scopeKey) {
  const key = String(scopeKey || "").trim();
  if (!key) return false;
  releaseGate({ scopeKey: key });
  ownerAtlasGateEventSeqByScope.delete(key);
  gatewayScopeStateByKey.delete(key);
  return true;
}

// ── ATLAS-first gate + gateway ATLAS proxy ────────────────────────────────────
// This single MCP process is a neutral gateway: native deterministic tools and
// ATLAS tools are separate suites on one transport. When ATLAS is available,
// the gateway forwards atlas.* calls to the native v2 ledger/view backend. The
// proxy notifies the gate, which locks deterministic research fallback tools
// until the agent makes the required real ATLAS retrieval calls after prefetch,
// or until ATLAS is unavailable. Scoped write, shell, verification, and artifact
// tools keep their normal scope/security checks but are not ATLAS-gated.
// Researcher, planner, dev, and assessor are all gated; artificer is
// exempt. Both modules live under ./deterministic-mcp/.
const initialGateAtlasLabel = atlasBackendLabel(atlasAvailable ? getAtlasIntegrationConfig() : null);
const initialGateScopeKey = gateScopeKeyForBootConfig(bootConfig);
assertGatewayScopeCapacity(initialGateScopeKey);
let gateScopeKey = configureGate({
  role: roleName,
  atlasAvailable,
  enabled: atlasGateEnabled,
  atlasLabel: initialGateAtlasLabel,
  scopeKey: initialGateScopeKey,
});
gatewayScopeState(gateScopeKey, {
  gateConfiguration: gatewayGateConfiguration({
    role: roleName,
    atlasAvailable,
    enabled: atlasGateEnabled,
    atlasLabel: initialGateAtlasLabel,
  }),
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

function getDeterministicAtlasConfig() {
  const base = getAtlasIntegrationConfig();
  const atlasConfig = bootConfig.atlas && typeof bootConfig.atlas === "object" ? bootConfig.atlas : {};
  const repoPath = bootString(atlasConfig.repoPath);
  const repoId = bootString(atlasConfig.repoId);
  const graphDbPath = bootString(atlasConfig.graphDbPath);
  const viewWaitMs = bootString(atlasConfig.viewWaitMs);
  const codeWindowPolicy = atlasConfig.codeWindowPolicy
    && typeof atlasConfig.codeWindowPolicy === "object"
    ? atlasConfig.codeWindowPolicy
    : null;
  const autoRefreshStale = typeof atlasConfig.autoRefreshStale === "boolean"
    ? atlasConfig.autoRefreshStale
    : parseBoolOverride(atlasConfig.autoRefreshStale);
  if (
    !repoPath
    && !repoId
    && !graphDbPath
    && !viewWaitMs
    && !codeWindowPolicy
    && autoRefreshStale == null
  ) return base;
  return {
    ...base,
    requestedRepoPath: repoPath ? path.resolve(repoPath) : base.requestedRepoPath,
    requestedRepoId: repoId || base.requestedRepoId,
    requestedGraphDbPath: graphDbPath ? path.resolve(graphDbPath) : base.requestedGraphDbPath,
    viewWaitMs: viewWaitMs === "" ? base.viewWaitMs : viewWaitMs,
    autoRefreshStale: autoRefreshStale == null ? base.autoRefreshStale : autoRefreshStale,
    ...(codeWindowPolicy ? { codeWindowPolicy: { ...codeWindowPolicy } } : {}),
  };
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
    inputSchema: projectAgentToolSchema(def.parameters || { type: "object", properties: {}, additionalProperties: false }),
    annotations: { title: `ATLAS ${action}` },
  })));
const STATIC_ATLAS_TOOL_NAMES = new Set(STATIC_ATLAS_TOOL_SCHEMAS.map((tool) => tool.name));

function getStaticAtlasToolSchemas() {
  return STATIC_ATLAS_TOOL_SCHEMAS.map((schema) => ({ ...schema, annotations: { ...(schema.annotations || {}) } }));
}

function projectCanonicalTraversalTools(tools, role, contractedTools = null) {
  const rows = Array.isArray(tools) ? tools : [];
  if (!roleUsesCanonicalRefTraversal(role)) return rows;
  const contract = Array.isArray(contractedTools) ? contractedTools : [];
  const hasTraversal = contract.length > 0
    ? contract.some((name) => _normalizeAtlasActionForAllowlist(name) === "traverse_ref")
    : rows.some((tool) => _stripAtlasPrefix(tool?.name) === "traverse_ref");
  if (!hasTraversal) return rows;
  // fetch_ref remains an accepted execution alias for rolling compatibility,
  // but a role on the array-only traversal contract must never
  // see the scalar alias in tools/list.
  return rows.filter((tool) => _stripAtlasPrefix(tool?.name) !== "fetch_ref");
}

function isStaticAtlasToolName(toolName) {
  return STATIC_ATLAS_TOOL_NAMES.has(String(toolName || ""));
}

const ATLAS_GATEWAY_TOOL_NAMES = new Set(["query", "code", "repo", "agent"]);
const RESEARCHER_TYPED_DISPATCHER_QUALIFIED_ZERO_CALL_NATIVE_TOOLS = new Set([
  "git_history",
  "hash_file",
  "inspect_file",
]);
// An investigating research child answers one delegated question, often about
// when or why code changed, and has no shell or parent to ask. It keeps the
// Remote-issued git_history that the parent researcher's diet drops.
const RESEARCH_CHILD_RETAINED_NATIVE_TOOLS = new Set(["git_history"]);

function researcherDietDropsNativeTool(toolName) {
  if (!RESEARCHER_TYPED_DISPATCHER_QUALIFIED_ZERO_CALL_NATIVE_TOOLS.has(toolName)) return false;
  return !(bootConfig?.researchInvestigation === true && RESEARCH_CHILD_RETAINED_NATIVE_TOOLS.has(toolName));
}

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
let _remotePulseTokens = null;
let _remotePulseAuthManager = null;

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

function remotePulseTokens() {
  const authManager = nativeBinaries.nativeAuthManager;
  if (!_remotePulseTokens || _remotePulseAuthManager !== authManager) {
    _remotePulseAuthManager = authManager;
    _remotePulseTokens = new PulseTokenManager({ authManager });
  }
  return _remotePulseTokens;
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
      let timer = null;
      try {
        const headers = { "content-type": "application/json" };
        const tokens = remotePulseTokens();
        const pulseToken = await tokens.getPulseToken({ requiredRoute: REMOTE_CATALOG_READ_ROUTE });
        if (pulseToken) {
          tokens.assertTrustedResourceUrl(url, "remote tool catalog");
          headers.authorization = `Bearer ${pulseToken}`;
        }
        timer = setTimeout(() => ac.abort(), remoteToolCatalogTimeoutMs());
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          redirect: "error",
          signal: ac.signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) tokens.clearAuthentication();
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
        if (timer) clearTimeout(timer);
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
        tests: bootConfig.allowTests === true,
        image_generation: allowImageGeneration,
        image_inspection: tokenToolAllowlistForSuite("tools")?.has("read_image_metadata") === true,
        artifact_validation: tokenToolAllowlistForSuite("tools")?.has("validate_artifact_output") === true,
        integrity_verification: tokenToolAllowlistForSuite("tools")?.has("hash_file") === true,
        project_db: projectDbCapabilityGrant,
      },
      atlas: atlasCapabilities,
      coordination: {
        agent_handoff_v1: tokenToolAllowlistForSuite("tools")?.has("agent_handoff") === true,
        agent_handoff_compact_v1: tokenToolAllowlistForSuite("tools")?.has("agent_handoff") === true,
        agent_handoff_compact_v2: tokenToolAllowlistForSuite("tools")?.has("agent_handoff") === true,
        agent_handoff_compact_v3: tokenToolAllowlistForSuite("tools")?.has("agent_handoff") === true,
        sub_agent_v1: tokenToolAllowlistForSuite("tools")?.has("sub_agent") === true,
      },
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
  if (hasTokenToolAllowlist()) return tokenToolAllowlistForSuite("atlas");
  if (ownerHotGateway && atlasAvailable) return new Set(ATLAS_TOOL_ACTIONS.filter(isExternallyRoutedAtlasTool));
  if (!atlasAvailable || !roleName) return _atlasAllowedActions;
  const catalog = await fetchRemoteToolCatalog();
  if (catalog && Array.isArray(catalog.tools)) return new Set(remoteAtlasRouteTools(catalog));
  if (remoteToolCatalogRequired()) throw remoteToolCatalogUnavailableError();
  return _atlasAllowedActions;
}

// Atlas actions issued to this session, for model-visible text only. Uses the
// boot allowlist or a remote catalog already loaded for this session's
// request; never fetches. The owner-hot unscoped superset is not a session
// issuance, so it yields null and callers fall back to tool-neutral wording.
function issuedAtlasActionsForModelText() {
  if (!atlasAvailable || (ownerHotGateway && !mcpMessageSessionScoped)) return null;
  if (hasTokenToolAllowlist()) return tokenToolAllowlistForSuite("atlas");
  // An empty local route defers to the remote catalog when one is enabled.
  if (_atlasAllowedActions?.size > 0 || !remoteToolCatalogEnabled()) return _atlasAllowedActions;
  let catalog = preloadedRemoteToolCatalog();
  if (!catalog && _remoteToolCatalogCache && _remoteToolSurfaceRequest
    && _remoteToolCatalogCache.key === remoteToolCatalogCacheKey(_remoteToolSurfaceRequest)) {
    catalog = _remoteToolCatalogCache.catalog;
  }
  return catalog && Array.isArray(catalog.tools) ? new Set(remoteAtlasRouteTools(catalog)) : null;
}

// Issuance withdraws read_file from a role once ATLAS is issued; blame would
// otherwise return the same indexed source line by line.
async function execGitHistoryForRole(args = {}) {
  const output = await execGitHistory(args, workspaceCwd, effectiveScopePredicates);
  const op = String(args?.op || "").trim();
  if (op === "show" && args?.path && roleName === "planner" && !String(output).startsWith("Error:")) {
    const issuedAtlasActions = issuedAtlasActionsForModelText();
    return `${output}\n\nContent note: git_history show does not return current worktree file content. Use read_file for a non-indexed file, or ${issuedIndexedSourceReadPhrase(issuedAtlasActions)} for indexed source.`;
  }
  if (op !== "blame") return output;
  const issuedAtlasActions = issuedAtlasActionsForModelText();
  if (!(issuedAtlasActions?.size > 0) || !atlasReplacesNativeTool("read_file", roleName)) return output;
  return blameWithoutLineText(output);
}

// Names only the issued members of the indexed-source read redirect.
function issuedIndexedSourceReadPhrase(issuedAtlasActions) {
  const names = [];
  if (issuedAtlasActions?.has("code.window")) names.push("code.window in file mode", "its continuation handle");
  if (issuedAtlasActions?.has("code.lens")) names.push("code.lens");
  if (names.length === 0) return "an issued Atlas exact-source tool";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
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
  execRunUnitTest,
  execGetBrief,
} = createDeterministicToolkit({
  safePath,
  skipObservationLogging: true,
  transformSearchRows: (rows, context) => (atlasAvailable && atlasNativeToolIsComplementary("search_files", roleName)
    ? redactComplementarySearchRows(rows, context, {
      onFallback: (error) => appendToolLog({ event: "search_files_redaction_fallback", error }),
    })
    : rows),
});

const {
  LIVE_SCOPE_WAIT,
  requestScopeWithinJob,
  writeFileWithinScope,
  editFileWithinScope,
  moveFileWithinScope,
  copyFileWithinScope,
  makeDirWithinScope,
} = createScopedMutationTools({
  get workspaceCwd() { return workspaceCwd; },
  get effectiveScopePredicates() { return effectiveScopePredicates; },
  get mcpJobId() { return mcpJobId; },
  get mcpWorkItemId() { return mcpWorkItemId; },
  get mcpAttemptId() { return mcpAttemptId; },
  get mcpAgentCallId() { return mcpAgentCallId; },
  get writeEnabled() { return writeEnabled; },
  execWriteFile,
  execEditFile,
});

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

async function dedupeReadFile(args = {}) {
  const complementary = atlasAvailable && atlasNativeToolIsComplementary("read_file", roleName);
  const normalizedArgs = complementary ? boundForwardedReadArgs("read_file", args) : args || {};
  const now = Date.now();
  const key = _buildReadDedupeKey(normalizedArgs);
  const stat = _statReadTarget(normalizedArgs);
  const state = gatewayScopeState(gateScopeKey);
  const lastReadMeta = state.lastReadMeta;
  if (
    READ_DEDUPE_WINDOW_MS > 0
    && lastReadMeta
    && lastReadMeta.key === key
    && (now - lastReadMeta.atMs) <= READ_DEDUPE_WINDOW_MS
    && stat
    && lastReadMeta.path === stat.fullPath
    && lastReadMeta.size === stat.size
    && lastReadMeta.mtimeMs === stat.mtimeMs
  ) {
    const elapsed = Math.max(0, now - lastReadMeta.atMs);
    return `${NATIVE_DUPLICATE_READ_SUPPRESSED_PREFIX} ${normalizedArgs.path} (same range, unchanged file, ${elapsed}ms since last read). Reuse the previous read result or change offset/limit.`;
  }

  let result = execReadFile(normalizedArgs, workspaceCwd, effectiveScopePredicates);
  if (complementary && typeof result === "string" && !/^Error:/i.test(result)) {
    result = await redactComplementaryReadResult({
      result,
      args: normalizedArgs,
      stat,
      defaultLimit: nativeReadMaxLines(normalizedArgs),
      onFallback: (error) => appendToolLog({ event: "read_file_redaction_fallback", error }),
    });
  }
  if (typeof result === "string" && !/^Error:/i.test(result)) {
    state.lastReadMeta = {
      key,
      atMs: now,
      path: stat?.fullPath || null,
      size: stat?.size ?? null,
      mtimeMs: stat?.mtimeMs ?? null,
    };
  } else {
    state.lastReadMeta = null;
  }
  return result;
}

// Shape of a planner handoff's `tasks` argument for telemetry: enough to
// diagnose a schema rejection (string-encoded array, keyed object, empty)
// without recording the tasks themselves.
// The shape of each handoff's target, recorded on the way in so a rejection
// like "target must be an object" leaves behind what was actually sent
// (a value the normalizer can then learn to accept). Strings are kept
// short; a target never carries source or secrets.
function describeTargetShapes(handoffs) {
  if (!Array.isArray(handoffs)) return null;
  return handoffs.slice(0, 12).map((entry) => {
    const target = entry && typeof entry === "object" ? entry.target : undefined;
    if (target === undefined) return "missing";
    if (target === null) return "null";
    if (typeof target === "string") return `string:${target.slice(0, 80)}`;
    if (Array.isArray(target)) return `array[${target.map((item) => typeof item).join(",")}]`;
    if (typeof target === "object") return `object{${Object.keys(target).slice(0, 6).join(",")}}`;
    return typeof target;
  });
}

function describeTasksShape(tasks) {
  if (tasks === undefined) return null;
  if (tasks === null) return "null";
  if (Array.isArray(tasks)) return `array[${tasks.length}]`;
  if (typeof tasks === "string") return `string[${tasks.length}]`;
  if (typeof tasks === "object") return `object{${Object.keys(tasks).slice(0, 6).join(",")}}`;
  return typeof tasks;
}

async function generateImageWithinScope(args = {}) {
  const state = gatewayScopeState(gateScopeKey);
  if (state.imageGenerationCallCount >= imageGenerationMaxCalls) {
    return `Error: generate_image call limit reached for this job (${imageGenerationMaxCalls}). Ask for operator guidance before generating more images.`;
  }
  state.imageGenerationCallCount += 1;
  const result = await execGenerateImageInternal(args, {
    cwd: workspaceCwd,
    scopePredicates: effectiveScopePredicates,
  });
  if (typeof result === "string" && result.startsWith("Error:")) {
    state.imageGenerationCallCount = Math.max(0, state.imageGenerationCallCount - 1);
  }
  return result;
}

// The artificer's external download lane. The operator web-tools switch is a
// global kill switch for it, read per call so a change applies immediately.
async function downloadFilesForCurrentScope(args = {}) {
  if (!writeEnabled) return "Error: Write access is not granted for this role.";
  if (!resolveWebToolsEnabled()) {
    return "Error: download_file is disabled by the operator web tools setting.";
  }
  return await downloadFilesWithinScope(args, {
    cwd: workspaceCwd,
    scopePredicates: effectiveScopePredicates,
    jobState: gatewayScopeState(gateScopeKey),
    context: {
      work_item_id: mcpWorkItemId,
      job_id: mcpJobId,
      attempt_id: mcpAttemptId,
      agent_call_id: mcpAgentCallId,
    },
  });
}

// The artificer packs scoped images into one sheet. Converter runs are async,
// so a large sheet does not block other calls on this gateway.
async function composeSpriteSheetForCurrentScope(args = {}) {
  if (!writeEnabled) return "Error: Write access is not granted for this role.";
  return await composeSpriteSheetWithinScope(args, {
    cwd: workspaceCwd,
    scopePredicates: effectiveScopePredicates,
    context: {
      work_item_id: mcpWorkItemId,
      job_id: mcpJobId,
      attempt_id: mcpAttemptId,
      agent_call_id: mcpAgentCallId,
    },
  });
}

// The assessor looks at an in-scope image's pixels. Read-only and async: a
// converter run for a large non-PNG image does not block other calls.
async function viewImageForCurrentScope(args = {}) {
  return await viewImageWithinScope(args, {
    cwd: workspaceCwd,
    scopePredicates: effectiveScopePredicates,
  });
}

// DEV authors source (including test source) through scoped deterministic file
// tools. Command execution belongs to the assessor, so DEV must not receive a
// generic shell escape hatch that can bypass the test/check role boundary.
let allowBash = ownerHotGateway || ["artificer", "assessor"].includes(roleName);
let execBash = allowBash ? createBashExecutor({ onAuthorization: recordBashPolicyObservation }) : null;
// Opt-in project DB access: advertised + attached only when this repo has it
// configured (enabled + a db type + a grant usable by this session's
// capability lane — write sessions take the full grant, read sessions need
// the `read` permission). Off by default.
function projectDbCapability() {
  if (ownerHotGateway && !mcpMessageSessionScoped) return "write";
  if (projectDbCapabilityGrant === "write" && projectDbWrite) return "write";
  if (projectDbCapabilityGrant === "read" || projectDbCapabilityGrant === "write") return "read";
  return "none";
}
function computeProjectDbAccessEnabled() {
  try {
    if (projectDbCapability() === "none") return false;
    const cfg = readProjectDbConfig({ projectDir: workspaceCwd });
    if (!cfg.enabled || !cfg.dbType) return false;
    return capProjectDbPermissions(cfg.permissions, projectDbCapability()).length > 0;
  } catch {
    return false;
  }
}
let projectDbAccessEnabled = computeProjectDbAccessEnabled();
// The advertised description names only the statements this session's
// capability lane may run against the operator grant.
function projectDbQuerySchemaForCurrentBoot() {
  try {
    const cfg = readProjectDbConfig({ projectDir: workspaceCwd });
    return projectDbQuerySchemaForPermissions(capProjectDbPermissions(cfg.permissions, projectDbCapability()));
  } catch {
    return TOOL_PROJECT_DB_QUERY;
  }
}
const WRITE_TOOL_NAMES = new Set(DETERMINISTIC_WRITE_TOOLS);
const IMAGE_HELPER_TOOL_NAMES = new Set(DETERMINISTIC_IMAGE_HELPER_TOOLS);
const IMAGE_GENERATION_TOOL_NAMES = new Set(DETERMINISTIC_IMAGE_TOOLS);
const OCR_TOOL_NAMES = new Set(DETERMINISTIC_OCR_TOOLS);
const IMAGE_VIEW_TOOL_NAMES = new Set(DETERMINISTIC_IMAGE_VIEW_TOOLS);
const TEST_TOOL_NAMES = new Set([
  "run_scoped_checks",
  "run_unit_test",
]);

// Freeze adapter discovery for each runtime session. A runner cannot appear or
// disappear halfway through an agent turn, but a persistent owner serves later
// sessions in other worktrees, where tests merged since boot must resolve.
let unitTestCapability = discoverUnitTestCapability({
  projectDir: workspaceCwd,
  scipAvailable: atlasAvailable,
});
let unitTestCapabilityKey = `${workspaceCwd}\0${atlasAvailable}`;

// Owner-hot declaration must follow the canonical registry. A hand-maintained
// copy silently dropped request_scope (and previously get_brief and
// web_research_handoff) even though executors and remote issuance were valid.
const ALL_NATIVE_TOOL_NAMES = Object.freeze(registeredToolNames());

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
  if (toolName === "custom_tools") return ownerHotGateway || bootConfig.customTools === true;
  if (WRITE_TOOL_NAMES.has(toolName)) return writeEnabled;
  if (toolName === "download_file" || toolName === "compose_sprite_sheet") return writeEnabled;
  if (TEST_TOOL_NAMES.has(toolName)) {
    const legacyRoleAllowsTests = bootConfig?.mcpOAuth?.verified !== true
      && roleName === "assessor";
    const permitted = (ownerHotGateway && !mcpMessageSessionScoped)
      || bootConfig.allowTests === true
      || legacyRoleAllowsTests;
    return toolName === "run_scoped_checks" ? permitted : permitted && unitTestCapability.available;
  }
  if (IMAGE_HELPER_TOOL_NAMES.has(toolName)) return allowImageHelpers;
  if (OCR_TOOL_NAMES.has(toolName)) return allowImageHelpers;
  // Assessor-only even when a token or role list would carry it elsewhere.
  if (IMAGE_VIEW_TOOL_NAMES.has(toolName)) {
    return allowImageHelpers && ((ownerHotGateway && !mcpMessageSessionScoped) || roleName === "assessor");
  }
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
    ? getDeterministicMcpToolNames(roleName, {
      needsImageGeneration: allowImageGeneration,
      atlasAvailable,
      disableSystemTools: bootConfig.disableSystemTools === true,
      researchInvestigation: bootConfig.researchInvestigation === true,
    })
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

function readFileSchemaForCurrentBoot() {
  if (!atlasAvailable) return TOOL_READ_FILE;
  if (atlasNativeToolIsComplementary("read_file", roleName)) {
    const maxLines = roleName === "researcher"
      ? ATLAS_RESEARCHER_READ_MAX_LINES
      : ATLAS_CHAIN_READ_MAX_LINES;
    const limitDescription = roleName === "researcher"
      ? `Maximum lines to return; indexed source defaults to ${ATLAS_RESEARCHER_READ_MAX_LINES}, while non-indexed files remain capped at ${ATLAS_CHAIN_READ_MAX_LINES}.`
      : `Maximum lines to return; defaults to ${maxLines}.`;
    return {
      ...TOOL_READ_FILE,
      description: roleName === "researcher"
        ? `Read source or text from a known file as numbered lines. Use offset and limit for a precise range; indexed source returns at most ${ATLAS_RESEARCHER_READ_MAX_LINES} lines per call and non-indexed files at most ${ATLAS_CHAIN_READ_MAX_LINES}.`
        : `Read source or text from a known file as numbered lines. Use offset and limit for a precise range; returns at most ${maxLines} lines per call.`,
      parameters: {
        ...TOOL_READ_FILE.parameters,
        properties: {
          path: TOOL_READ_FILE.parameters.properties.path,
          offset: TOOL_READ_FILE.parameters.properties.offset,
          limit: { type: "integer", minimum: 1, maximum: maxLines,
            description: limitDescription },
        },
      },
    };
  }
  return TOOL_READ_FILE;
}

function compactAgentHandoffIssued() {
  return bootConfig?.agentHandoffContract?.compactV1 === true
    || remoteToolCatalogPreload?.coordination?.agent_handoff_compact_v1 === true;
}

function compactAgentHandoffV3Issued() {
  return bootConfig?.agentHandoffContract?.compactV3 === true
    || remoteToolCatalogPreload?.coordination?.agent_handoff_compact_v3 === true;
}

function compactAgentHandoffV4Issued() {
  return isResearcherRole
    && compactAgentHandoffV3Issued()
    && bootConfig.agentHandoffReportOnly === true;
}

function researcherTraversalCoverageRequired() {
  if (!isResearcherRole || mcpJobId == null) return false;
  return getTraversalCompletionSnapshotForCall({
    jobId: mcpJobId,
    attemptId: mcpAttemptId,
  })?.active === true;
}

addToolSchema(getToolSchemaForRole("agent_handoff", roleName, {
  compactCompletion: compactAgentHandoffIssued(),
  compactV3: compactAgentHandoffV3Issued(),
  compactV4: compactAgentHandoffV4Issued(),
  requireResearcherCoverage: researcherTraversalCoverageRequired(),
  researchInvestigation: bootConfig.researchInvestigation === true,
}));
addToolSchema(TOOL_AGENT_CLAIM);
addToolSchema(TOOL_REPORT_CLAIMS);
addToolSchema(TOOL_SUB_AGENT);
addToolSchema(TOOL_SUB_AGENT_NEXT_INPUT);
addToolSchema(getToolSchemaForRole("dispatch_agent", roleName, {
  plannerMaxChildren: roleName === "planner" ? readPlannerDispatchPolicy({ projectDir: workspaceCwd }).maxChildren : null,
  researchInvestigation: bootConfig.researchInvestigation === true,
}));
addToolSchema(TOOL_WEB_RESEARCH_HANDOFF);
addToolSchema(getToolSchemaForRole("final_review", roleName));

// Atlas-active researchers use the ordinary bounded read_file fallback. The
// chain ledger remains available only when Atlas is absent.
// Owner-hot mode keeps every tool implementation loaded; per-session shims/owner
// gates decide which of these schemas an agent sees and may call.
if (ownerHotGateway) {
  addToolSchema(readFileSchemaForCurrentBoot());
  addToolSchema(TOOL_CHAIN_READ);
  addToolSchema(TOOL_CHAIN_VERDICT);
} else if (isResearcherRole && !atlasAvailable) {
  addToolSchema(TOOL_CHAIN_READ);
  addToolSchema(TOOL_CHAIN_VERDICT);
} else {
  addToolSchema(readFileSchemaForCurrentBoot());
}
for (const schema of [TOOL_LIST_FILES, TOOL_SEARCH_FILES, TOOL_GIT_HISTORY, TOOL_INSPECT_FILE, TOOL_HASH_FILE]) {
  addToolSchema(schema);
}
addToolSchema(TOOL_AGENT_FEEDBACK);
addToolSchema(TOOL_GET_OPERATOR_FEEDBACK);
addToolSchema(TOOL_ACK_OPERATOR_FEEDBACK);
addToolSchema(TOOL_GET_BRIEF);
addToolSchema(projectDbQuerySchemaForCurrentBoot());
addToolSchema(TOOL_CUSTOM_TOOLS);
if (writeEnabled) {
  for (const schema of [TOOL_REQUEST_SCOPE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR, TOOL_DOWNLOAD_FILE, TOOL_COMPOSE_SPRITE_SHEET]) {
    addToolSchema(schema.name === "request_scope" ? getToolSchemaForRole("request_scope", roleName) : schema);
  }
}
if (allowBash) {
  addToolSchema(TOOL_BASH);
}
if (ownerHotGateway || roleName === "assessor") {
  addToolSchema(getToolSchemaForRole("run_scoped_checks", roleName));
}
if (unitTestCapability.available && (ownerHotGateway || ["planner", "dev", "assessor"].includes(roleName))) addToolSchema(TOOL_RUN_UNIT_TEST);

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
  for (const schema of [TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT, TOOL_VIEW_IMAGE]) {
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

function normalizeGatewayToolInputSchema(tool) {
  const inputSchema = tool?.inputSchema;
  const normalized = inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? inputSchema
    : { properties: {}, additionalProperties: false };
  if (normalized.type === "object") return tool;
  // Claude Code 2.1 validates MCP inputSchema more narrowly than JSON Schema:
  // a top-level oneOf is valid MCP, but Claude rejects the entire tools/list
  // unless every schema also declares type:"object". Gateway tools always
  // receive an argument object, so adding the explicit type preserves the
  // existing branch constraints while keeping the catalog interoperable.
  return {
    ...tool,
    inputSchema: {
      ...normalized,
      type: "object",
    },
  };
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
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Use only the deterministic verification tools issued for this role.`;
  }
  if (action === "policy.set") {
    return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Policy changes are operator-controlled and cannot be made from this job.`;
  }
  return `ATLAS tool ${toolName} is not exposed through the Posse MCP gateway. Continue with the deterministic tools exposed for this role.`;
}

// Research progress belongs to one ledger/notice/novelty owner per MCP session.
const researchSessionStore = new ResearchSessionStore({
  getRuntime: () => ({
    isResearcherRole,
    mcpJobId,
    mcpWorkItemId,
    mcpAttemptId,
    workspaceCwd,
    effectiveScopePredicates,
  }),
  execReadFile,
});
researchSessionStore.select(runtimeSessionKey());

function isResearchExplorationTool(toolName, { requestedAtlasTool = false } = {}) {
  const normalized = String(toolName || "");
  if (requestedAtlasTool || normalized.startsWith("atlas.") || normalized.startsWith("atlas_")) {
    return isResearchAtlasExplorationAction(normalized);
  }
  return RESEARCH_NATIVE_EXPLORATION_TOOLS.has(normalized);
}

function researchSynthesisStaleStepCount() {
  return Math.max(0, Number(researchSessionStore.state.explorationSteps || 0) - Number(researchSessionStore.state.lastNovelEvidenceStep || 0));
}

function syncResearchSynthesisStateFromObservations() {
  if (!isResearcherRole || !mcpJobId) return;
  const observed = researchExplorationObservationStatus({
    jobId: mcpJobId,
    attemptId: mcpAttemptId,
    agentCallId: mcpAgentCallId,
  });
  const priorExplorationSteps = Number(researchSessionStore.state.explorationSteps || 0);
  const observedExplorationSteps = Number(observed.exploration_steps || 0);
  researchSessionStore.state.explorationSteps = Math.max(
    priorExplorationSteps,
    observedExplorationSteps,
  );
  // Owner-executed success is not automatically progress. The shared ledger
  // resolves novelty from bounded evidence identities/result digests, so a
  // duplicate successful Atlas response advances the stale streak instead of
  // resetting it.
  const lastNovelEvidenceStep = Number(observed.last_novel_evidence_step || 0);
  if (observedExplorationSteps > priorExplorationSteps && lastNovelEvidenceStep > 0) {
    researchSessionStore.state.lastNovelEvidenceStep = Math.max(
      Number(researchSessionStore.state.lastNovelEvidenceStep || 0),
      lastNovelEvidenceStep,
    );
  }
  if (observed.synthesis_required && !researchSessionStore.state.synthesisRequiredAt) {
    researchSessionStore.state.synthesisRequiredAt = new Date().toISOString();
    researchSessionStore.state.synthesisReason = `exploration_steps=${researchSessionStore.state.explorationSteps}; absolute_ceiling=${RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS}; source=owner_observation`;
    researchSessionStore.state.synthesisNoticeEmitted = true;
  }
}

function researchSynthesisStatus() {
  if (!researchSessionStore.state.synthesisRequiredAt) return null;
  return {
    required: true,
    required_at: researchSessionStore.state.synthesisRequiredAt,
    reason: researchSessionStore.state.synthesisReason || null,
    exploration_steps: researchSessionStore.state.explorationSteps,
    stale_steps: researchSynthesisStaleStepCount(),
    last_novel_evidence_step: researchSessionStore.state.lastNovelEvidenceStep,
    relevant_files: researchSessionStore.state.relevant.size,
    irrelevant_files: researchSessionStore.state.irrelevant.size,
  };
}

function recordResearchSynthesisRequiredObservation() {
  if (!isResearcherRole || researchSessionStore.state.synthesisNoticeEmitted) return;
  try {
    _recordObservation({
      work_item_id: mcpWorkItemId ?? undefined,
      job_id: mcpJobId ?? undefined,
      attempt_id: mcpAttemptId ?? undefined,
      observation_type: "research.synthesis_required",
      summary: `Research synthesis required after ${researchSessionStore.state.explorationSteps} exploration calls with ${researchSynthesisStaleStepCount()} stale calls`,
      detail: {
        kind: "research_synthesis_required",
        exploration_steps: researchSessionStore.state.explorationSteps,
        stale_steps: researchSynthesisStaleStepCount(),
        min_exploration_steps: RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS,
        stale_exploration_steps: RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS,
        last_novel_evidence_step: researchSessionStore.state.lastNovelEvidenceStep,
        relevant_files: researchSessionStore.state.relevant.size,
        irrelevant_files: researchSessionStore.state.irrelevant.size,
        reason: researchSessionStore.state.synthesisReason || null,
      },
    });
    researchSessionStore.state.synthesisNoticeEmitted = true;
  } catch { /* best effort */ }
}

function maybeMarkResearchSynthesisRequired({ toolName = null } = {}) {
  syncResearchSynthesisStateFromObservations();
  if (!isResearcherRole || researchSessionStore.state.synthesisRequiredAt) return false;
  const explorationSteps = Number(researchSessionStore.state.explorationSteps || 0);
  const staleSteps = researchSynthesisStaleStepCount();
  const decision = researchSynthesisDecision({ explorationSteps, staleSteps });
  if (!decision.required) return false;

  researchSessionStore.state.synthesisRequiredAt = new Date().toISOString();
  researchSessionStore.state.synthesisReason = [
    `exploration_steps=${explorationSteps}`,
    `stale_steps=${staleSteps}`,
    decision.absoluteCeilingReached ? `absolute_ceiling=${decision.explorationCeiling}` : null,
    toolName ? `last_tool=${toolName}` : null,
  ].filter(Boolean).join("; ");
  recordResearchSynthesisRequiredObservation();
  return true;
}

function noteResearchExplorationStep({ toolName, requestedAtlasTool = false, novelRelevantFile = false } = {}) {
  if (!isResearcherRole || !isResearchExplorationTool(toolName, { requestedAtlasTool })) return null;
  researchSessionStore.state.explorationSteps += 1;
  if (novelRelevantFile) {
    researchSessionStore.state.lastNovelEvidenceStep = researchSessionStore.state.explorationSteps;
  }
  maybeMarkResearchSynthesisRequired({ toolName });
  researchSessionStore.save();
  return researchSynthesisStatus();
}

function shouldBlockForResearchSynthesis(toolName, { requestedAtlasTool = false } = {}) {
  maybeMarkResearchSynthesisRequired({ toolName });
  if (!isResearcherRole || !researchSessionStore.state.synthesisRequiredAt) return false;
  const normalized = String(toolName || "");
  if (normalized === "chain_verdict" && researchSessionStore.state.currentlyReading) return false;
  if (requestedAtlasTool || normalized.startsWith("atlas.") || normalized.startsWith("atlas_")) {
    return isResearchAtlasExplorationAction(normalized);
  }
  return RESEARCH_NATIVE_SYNTHESIS_GATED_TOOLS.has(normalized);
}

function researchCitationFetchGate(toolName) {
  if (!RESEARCH_CITATION_FETCH_GATE_ENABLED) return null;
  if (!isResearcherRole || !isResearchAtlasCitationFetchAction(toolName)) return null;
  maybeMarkResearchSynthesisRequired({ toolName });
  syncResearchSynthesisStateFromObservations();
  const observed = researchExplorationObservationStatus({
    jobId: mcpJobId,
    attemptId: mcpAttemptId,
    agentCallId: mcpAgentCallId,
  });
  if (
    researchSessionStore.state.synthesisRequiredAt
    && Number(observed.citation_fetch_batches || 0) >= 1
  ) {
    return {
      reason: "budget_exhausted",
      citationFetches: Number(observed.citation_fetches || 0),
      citationFetchBatches: Number(observed.citation_fetch_batches || 0),
    };
  }
  return null;
}

// A research child's granted retrieval budget lowers its rail, so closeout
// texts count against the budget the child was told.
function currentResearchSynthesisPolicySnapshot() {
  return resolveResearchSynthesisPolicySnapshot({
    workBudgetCalls: isResearcherRole ? bootConfig?.researchWorkBudgetCalls ?? null : null,
  });
}

// Closeout texts name the handoff tool exactly as this provider exposes it.
function embeddedAgentHandoffCallableName() {
  return renderAgentHandoffCallableName({
    providerName,
    agentHandoff: bootConfig?.agentHandoff === true,
    issuedTools: tokenToolAllowlistForSuite("tools"),
    serverName: POSSE_MCP_GATEWAY_SERVER_NAME,
  });
}

function buildResearchSynthesisRequiredMessage({ includeCurrentCall = false } = {}) {
  const status = researchSynthesisStatus() || {};
  const absoluteCeilingReached = String(status.reason || "").includes("absolute_ceiling=");
  const observed = researchExplorationObservationStatus({
    jobId: mcpJobId,
    attemptId: mcpAttemptId,
    agentCallId: mcpAgentCallId,
  });
  const maxPhysicalCalls = currentResearchSynthesisPolicySnapshot().maxPhysicalCalls;
  const physicalCalls = Math.max(0, Number(observed.call_steps || 0))
    + (includeCurrentCall ? 1 : 0);
  return buildResearchSynthesisRequiredText({
    explorationSteps: status.exploration_steps || 0,
    staleSteps: status.stale_steps || 0,
    absoluteCeilingReached,
    explorationCeiling: researchSynthesisExplorationCeiling({ staleSteps: status.stale_steps || 0 }),
    finalTraversalAvailable: physicalCalls < maxPhysicalCalls,
    handoffToolName: embeddedAgentHandoffCallableName(),
  });
}

// Record read-only bash policy outcomes so audits can separate real denials
// (a genuine mutation/escape attempt) from false positives, and can see when a
// command was auto-repaired (benign `>/dev/null` stripped, no-op `cd <cwd>`
// removed) before it ran. Advisory only: never break the bash call.
function recordBashPolicyObservation({ command, ok, reasonClass, repairs, repairedCommand } = {}) {
  try {
    const original = String(command || "");
    if (Array.isArray(repairs) && repairs.length > 0) {
      _recordObservation({
        work_item_id: mcpWorkItemId ?? null,
        job_id: mcpJobId ?? null,
        attempt_id: mcpAttemptId ?? null,
        observation_type: "bash.command_repaired",
        summary: `bash command auto-repaired (${repairs.join(", ")})`,
        detail: {
          repairs,
          original: original.slice(0, 500),
          repaired: String(repairedCommand ?? "").slice(0, 500),
        },
      });
    }
    if (!ok) {
      _recordObservation({
        work_item_id: mcpWorkItemId ?? null,
        job_id: mcpJobId ?? null,
        attempt_id: mcpAttemptId ?? null,
        observation_type: "bash.policy_denied",
        summary: `bash command denied by read-only policy (${reasonClass || "unknown"})`,
        detail: {
          reason_class: reasonClass || "unknown",
          command: original.slice(0, 500),
        },
      });
    }
  } catch {
    // Bash policy telemetry is advisory and must not break a tool result.
  }
}

// Parity with the owner path's recordOwnerModelControlNotice: every
// runtime-appended, model-visible control notice must be recorded with its
// exact text, or run telemetry under-represents what steered the next turn.
function recordEmbeddedModelControlNotice(toolName, notice = {}) {
  try {
    _recordObservation({
      work_item_id: mcpWorkItemId ?? null,
      job_id: mcpJobId ?? null,
      attempt_id: mcpAttemptId ?? null,
      observation_type: "tool.response_control",
      summary: `Model-visible ${notice.kind || "runtime"} notice appended to ${toolName || "tool result"}`,
      detail: {
        kind: notice.kind || "runtime_control",
        tool: toolName || null,
        text: String(notice.text || ""),
        chars: String(notice.text || "").length,
        trigger: notice.trigger || null,
        exploration_step: notice.explorationStep ?? null,
        source: "mcp_embedded",
      },
    });
  } catch {
    // Response-control telemetry is advisory and must not break a tool result.
  }
}

function embeddedControlNoticeMetadata(kind, text, trigger = null) {
  const value = String(text || "");
  return {
    kind: String(kind || "runtime_control"),
    chars: value.length,
    sha256: crypto.createHash("sha256").update(value, "utf8").digest("hex"),
    ...(trigger ? { trigger: String(trigger) } : {}),
  };
}

function embeddedControlResult(text, kind, trigger = null) {
  return {
    content: [{ type: "text", text }],
    isError: false,
    _meta: {
      posseControlOnly: true,
      posseControlNotices: [embeddedControlNoticeMetadata(kind, text, trigger)],
    },
  };
}

// One-shot notice progress. Exploration steps sync from the shared ledger and
// can skip numbers (owner-side ATLAS work advances the count between native
// calls), so equality triggers can silently skip the midpoint/final-window
// warnings; threshold-crossing flags cannot. In-memory: a gateway restart
// re-emits at most one already-shown notice.
//
// RS-1: both the flags and the novelty tracker live on the keyed research
// session owner (see createResearchSessionOwner). The module-level bindings are
// only pointers at the currently selected owner, so one session can neither
// suppress another session's notice nor make another session's evidence look
// stale.

function researchExplorationNoticeResult(text, toolName) {
  if (!isResearcherRole || !isResearchExplorationTool(toolName)) return { text, kind: null };
  const explorationSteps = Number(researchSessionStore.state.explorationSteps || 0);
  const curtainStart = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS;
  let notice = null;
  let noticeKind = null;
  if (researchSessionStore.state.synthesisRequiredAt) {
    researchSessionStore.noticeFlags.midpoint = true;
    researchSessionStore.noticeFlags.curtain = true;
    notice = buildResearchSynthesisRequiredMessage({ includeCurrentCall: true });
    noticeKind = "research_closeout";
  } else if (explorationSteps >= curtainStart && !researchSessionStore.noticeFlags.curtain) {
    researchSessionStore.noticeFlags.midpoint = true;
    researchSessionStore.noticeFlags.curtain = true;
    notice = buildResearchCurtainCallText({ explorationSteps, handoffToolName: embeddedAgentHandoffCallableName() });
    noticeKind = "research_curtain";
  }
  if (!notice) return { text, kind: null };
  recordEmbeddedModelControlNotice(toolName, {
    kind: noticeKind,
    text: `\n\n${notice}`,
    trigger: noticeKind,
    explorationStep: explorationSteps,
  });
  return { text: `${text}\n\n${notice}`, kind: noticeKind };
}

function appendResearchExplorationNotice(text, toolName) {
  return researchExplorationNoticeResult(text, toolName).text;
}

function chainRead(args) {
  let raw = researchSessionStore.ledger.chainRead(args || {});
  const inherited = researchSessionStore.ledger.takeInheritedVerdict?.();
  if (inherited) {
    recordResearchEvidenceObservation({
      filePath: inherited.path,
      verdict: inherited.verdict,
      summary: inherited.summary,
      continuation: true,
      ledger: inherited.ledger,
      novelRelevantFile: false,
    });
    // chain_read is normally paired with chain_verdict and the pair consumes
    // one exploration step. Preserve that accounting when a relevant
    // continuation inherits its verdict and skips the second tool call.
    noteResearchExplorationStep({ toolName: "chain_verdict", novelRelevantFile: false });
    raw = appendResearchExplorationNotice(raw, "chain_verdict");
  }
  return raw;
}

function chainVerdict(args) {
  const raw = researchSessionStore.ledger.chainVerdict(args || {});
  let response;
  try {
    response = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (response?.ok !== true) return raw;

  const filePath = response.tagged;
  const verdict = response.verdict;
  const summary = response.summary || "";
  const continuation = response.evidence?.continuation === true;
  const novelRelevantFile = response.evidence?.novel_relevant_file === true;
  recordResearchEvidenceObservation({
    filePath,
    verdict,
    summary,
    continuation,
    ledger: response.ledger,
    novelRelevantFile,
  });
  noteResearchExplorationStep({ toolName: "chain_verdict", novelRelevantFile });
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
    attempt_id: mcpAttemptId,
    agent_call_id: mcpAgentCallId,
    phase: args.phase,
    status: args.status,
    body: args.summary,
    role: roleName,
    detail: args.detail,
    source: "mcp_tool",
    metadata_json: { role: roleName || null },
  });
  return "Agent feedback recorded for Monitor Agents.";
}

function appendOperatorFeedbackDelivery(text, toolName) {
  const delivery = operatorFeedbackDeliveryForJob(mcpJobId, {
    attemptId: mcpAttemptId,
    agentCallId: mcpAgentCallId,
    toolName,
  });
  if (!delivery) return { text, delivery: null };
  const deliveryText = `\n\n${operatorFeedbackDeliveryText(delivery)}`;
  recordEmbeddedModelControlNotice(toolName, {
    kind: "operator_feedback_delivery",
    text: deliveryText,
    trigger: "operator_feedback_pending",
  });
  return { text: `${text}${deliveryText}`, delivery };
}

function getOperatorFeedback(args = {}) {
  const scopeError = liveChannelSessionScopeError("get_operator_feedback");
  if (scopeError) return scopeError;
  if (!mcpJobId) return "No active job context is available for get_operator_feedback.";
  if (countPendingOperatorFeedbackForJob(mcpJobId, mcpAgentCallId) <= 0) {
    const error = new Error("POSSE_FEEDBACK_RECOVERY_UNAVAILABLE: no unacknowledged operator feedback is pending. This internal recovery endpoint must not be polled.");
    error.code = "POSSE_FEEDBACK_POLL_LIMIT";
    throw error;
  }
  const feedback = getOperatorFeedbackForJob({
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    agent_call_id: mcpAgentCallId,
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
    agent_call_id: mcpAgentCallId,
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

function executeAgentHandoff(args = {}) {
  // The persistent owner holds the live child binding and validates this
  // handoff before forwarding it. Its gateway runs in another process and
  // cannot inspect that binding's in-memory runtime.
  const ownerValidatedHandoff = ownerHotGateway && mcpMessageSessionScoped;
  if (!ownerValidatedHandoff) assertSubAgentParentReady(mcpAgentCallId);
  const preparedSubAgentHandoff = ownerValidatedHandoff
    ? false
    : prepareSubAgentHandoff(mcpAgentCallId, args);
  const receipt = stageAgentHandoff(args, {
    context: {
      workItemId: mcpWorkItemId,
      jobId: mcpJobId,
      attemptId: mcpAttemptId,
      agentCallId: mcpAgentCallId,
    },
    role: roleName,
    projectDir: workspaceCwd,
    maxHandoffs: roleName === "planner" ? getIntSetting("planner_max_tasks", 50) : 1,
  });
  if (receipt.diagnostics) {
    if (receipt.diagnostics.ignored_field_count > 0) {
      try {
        _recordObservation({
          work_item_id: mcpWorkItemId ?? undefined,
          job_id: mcpJobId ?? undefined,
          attempt_id: mcpAttemptId ?? undefined,
          observation_type: "handoff.unknown_fields_ignored",
          summary: `Agent handoff ignored ${receipt.diagnostics.ignored_field_count} unrecognized field(s)`,
          detail: {
            severity: "warn",
            agent_call_id: mcpAgentCallId ?? null,
            ignored_field_count: receipt.diagnostics.ignored_field_count,
            ignored_fields: receipt.diagnostics.ignored_fields,
          },
        });
      } catch { /* best effort */ }
    }
  }
  if (preparedSubAgentHandoff) sealSubAgentHandoff(mcpAgentCallId);
  return JSON.stringify({
    ok: true,
    protocol: AGENT_HANDOFF_PROTOCOL,
    status: receipt.status,
    digest: receipt.digest,
    call_count: receipt.callCount,
    terminal: true,
    ...(receipt.diagnostics ? { diagnostics: receipt.diagnostics } : {}),
  });
}

function executeReportClaims(args = {}) {
  return JSON.stringify(executeResearchReportClaims(args, {
    context: {
      workItemId: mcpWorkItemId,
      jobId: mcpJobId,
      attemptId: mcpAttemptId,
      agentCallId: mcpAgentCallId,
    },
    role: roleName,
  }));
}

async function executeSubAgentTool(args = {}) {
  const result = await executeSubAgent(args, {
    context: {
      workItemId: mcpWorkItemId,
      jobId: mcpJobId,
      attemptId: mcpAttemptId,
      agentCallId: mcpAgentCallId,
    },
  });
  return JSON.stringify(result);
}

async function executeSubAgentNextInputTool(args = {}) {
  const result = await executeSubAgentNextInput(args, {
    context: {
      workItemId: mcpWorkItemId,
      jobId: mcpJobId,
      attemptId: mcpAttemptId,
      agentCallId: mcpAgentCallId,
    },
  });
  return JSON.stringify(result);
}

async function executeDispatchAgentTool(args = {}) {
  const result = await executeDispatchAgent(args, {
    context: {
      workItemId: mcpWorkItemId,
      jobId: mcpJobId,
      attemptId: mcpAttemptId,
      agentCallId: mcpAgentCallId,
    },
  });
  return JSON.stringify(result);
}

// The owner runs final_review (it needs the agent call's registration in the
// Posse process); a call that reaches this child process has no reviewer.
function executeFinalReviewTool() {
  return "Error: final_review is unavailable on this connection; hand off when the change is complete.";
}

function executeWebResearchHandoffTool(args = {}) {
  return JSON.stringify(submitWebResearchHandoff(mcpAgentCallId, args));
}

async function executeCustomToolsTool(args = {}) {
  const token = String(
    bootConfig.mcpOAuthToken
    || bootConfig.mcpOauthToken
    || bootConfig.mcpAuth?.accessToken
    || bootConfig.mcpAuth?.token
    || "",
  ).trim();
  if (!token) {
    throw Object.assign(new Error("Custom Tools requires a bound MCP agent token"), {
      code: "custom_tools_auth_required",
    });
  }
  const result = await new AutomationOwnerClient({ token, timeoutMs: CUSTOM_TOOLS_AGENT_REQUEST_TIMEOUT_MS }).request("tool", args);
  return JSON.stringify(result);
}

// Attach this server's executors to a ToolRegistry seeded with the shared suite
// metadata, so the MCP runtime's handler set flows through the same registry the
// embedded OpenAI/Grok runtime builds from. Executors and role gating are
// unchanged; the registry is the single declaration both runtimes share.
let mcpToolRegistry = declareToolSuites(new ToolRegistry());
mcpToolRegistry.attach("custom_tools", (args) => executeCustomToolsTool(args || {}));
mcpToolRegistry.attach("request_scope", (args) => requestScopeWithinJob(args || {}));
mcpToolRegistry.attach("agent_handoff", (args) => executeAgentHandoff(args || {}));
mcpToolRegistry.attach("agent_claim", (args) => executeReportClaims(args || {}));
mcpToolRegistry.attach("report_claims", (args) => executeReportClaims(args || {}));
mcpToolRegistry.attach("sub_agent", (args) => executeSubAgentTool(args || {}));
mcpToolRegistry.attach("sub_agent_next_input", (args) => executeSubAgentNextInputTool(args || {}));
mcpToolRegistry.attach("dispatch_agent", (args) => executeDispatchAgentTool(args || {}));
mcpToolRegistry.attach("web_research_handoff", (args) => executeWebResearchHandoffTool(args || {}));
mcpToolRegistry.attach("final_review", () => executeFinalReviewTool());
mcpToolRegistry.attach("read_file", (args) => dedupeReadFile(args || {}));
mcpToolRegistry.attach("get_brief", (args) => execGetBrief(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("list_files", (args) => execListFiles(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("search_files", (args) => execSearchFiles(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("git_history", (args) => execGitHistoryForRole(args || {}));
mcpToolRegistry.attach("inspect_file", (args) => execInspectFile(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("hash_file", (args) => execHashFile(args || {}, workspaceCwd, effectiveScopePredicates));
mcpToolRegistry.attach("agent_feedback", (args) => agentFeedback(args || {}));
mcpToolRegistry.attach("get_operator_feedback", (args) => getOperatorFeedback(args || {}));
mcpToolRegistry.attach("ack_operator_feedback", (args) => ackOperatorFeedback(args || {}));

if (writeEnabled) {
  mcpToolRegistry.attach("write_file", (args) => writeFileWithinScope(args || {}));
  mcpToolRegistry.attach("edit_file", (args) => editFileWithinScope(args || {}));
  mcpToolRegistry.attach("prune_artifact_output", (args) => execPruneArtifactOutput({ output_root: bootConfig.artifactOutputRoot, ...args }, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("move_file", (args) => moveFileWithinScope(args || {}));
  mcpToolRegistry.attach("copy_file", (args) => copyFileWithinScope(args || {}));
  mcpToolRegistry.attach("make_dir", (args) => makeDirWithinScope(args || {}));
}
if (allowBash && execBash) {
  mcpToolRegistry.attach("bash", (args) => execBash(args || {}, workspaceCwd, effectiveScopePredicates));
}
if (ownerHotGateway || roleName === "dev" || roleName === "assessor" || roleName === "planner") {
  mcpToolRegistry.attach("run_scoped_checks", (args) => execRunScopedChecks(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope));
  mcpToolRegistry.attach("run_unit_test", (args) => execRunUnitTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, { unitTestCapability, scipAvailable: atlasAvailable, agentCallId: mcpAgentCallId }));
}
if (allowImageHelpers) {
  mcpToolRegistry.attach("read_image_metadata", (args) => execReadImageMetadata(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("validate_artifact_output", (args) => execValidateArtifactOutput({ output_root: bootConfig.artifactOutputRoot, ...args }, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("extract_image_text", (args) => execExtractImageText(args || {}, workspaceCwd, effectiveScopePredicates));
  // view_image is assessor-only; owner-hot attaches every executor and the
  // remote token gates each call.
  if (ownerHotGateway || roleName === "assessor") {
    mcpToolRegistry.attach("view_image", (args) => viewImageForCurrentScope(args || {}));
  }
}
// clean_image, compose_sprite_sheet, and download_file write artifacts and are
// artificer-only. Owner-hot attaches every executor (the remote token gates per
// call); scoped boots attach them only for the artificer role so a read-only
// assessor cannot reach them in a no-token boot.
if (ownerHotGateway || roleName === "artificer") {
  mcpToolRegistry.attach("clean_image", (args) => execCleanImage(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("compose_sprite_sheet", (args) => composeSpriteSheetForCurrentScope(args || {}));
  mcpToolRegistry.attach("download_file", (args) => downloadFilesForCurrentScope(args || {}));
}
if (allowImageGeneration) {
  mcpToolRegistry.attach("generate_image", (args) => generateImageWithinScope(args || {}));
}
if (ownerHotGateway || isResearcherRole) {
  mcpToolRegistry.attach("chain_read", (args) => chainRead(args || {}));
  mcpToolRegistry.attach("chain_verdict", (args) => chainVerdict(args || {}));
}
if (projectDbAccessEnabled) {
  mcpToolRegistry.attach("project_db_query", (args) => execProjectDbQuery(args || {}, { projectDir: workspaceCwd, capability: projectDbCapability(), observationContext: { job_id: mcpJobId, work_item_id: mcpWorkItemId, attempt_id: mcpAttemptId } }));
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
  TOOL_EXECUTORS.set(toolName, (args) => (
    runNativeToolThroughGate(toolName, args || {}, handler)
  ));
}

let activeRuntimeSessionKey = "";

function runtimeSessionKey(config = bootConfig, sessionId = null) {
  const token = String(config?.mcpOAuth?.tokenId || "").trim();
  const ownerSession = String(sessionId || "").trim();
  const job = config?.jobId != null && config.jobId !== "" ? `job:${config.jobId}` : "";
  const workItem = config?.workItemId != null && config.workItemId !== "" ? `wi:${config.workItemId}` : "";
  const attempt = config?.attemptId != null && config.attemptId !== "" ? `attempt:${config.attemptId}` : "";
  const agentCall = config?.agentCallId != null && config.agentCallId !== "" ? `call:${config.agentCallId}` : "";
  const role = String(config?.role || "").trim();
  const cwd = String(config?.cwd || "").trim();
  const bindingEpoch = Number(config?.ownerGatewayBindingEpoch);
  const binding = Number.isSafeInteger(bindingEpoch) && bindingEpoch > 0 ? `binding:${bindingEpoch}` : "";
  return [token ? `mcp:${token}` : (ownerSession ? `session:${ownerSession}` : ""), job, workItem, attempt, agentCall, role, cwd, binding]
    .filter(Boolean).join("|") || "owner-hot";
}

function gateScopeKeyForBootConfig(config = bootConfig, { sessionId = null } = {}) {
  const scopeKey = buildAtlasGateScopeKey({
    tokenId: config?.mcpOAuth?.tokenId,
    jobId: config?.jobId,
    attemptId: config?.attemptId,
    agentCallId: config?.agentCallId,
    fallback: runtimeSessionKey(config, sessionId),
  });
  const bindingEpoch = Number(config?.ownerGatewayBindingEpoch);
  return Number.isSafeInteger(bindingEpoch) && bindingEpoch > 0
    ? `${scopeKey}|binding:${bindingEpoch}`
    : scopeKey;
}

function releaseGatewaySessionState(config, { sessionId = null } = {}) {
  const released = releaseGatewayScope(gateScopeKeyForBootConfig(config, { sessionId }));
  researchSessionStore.release(runtimeSessionKey(config, sessionId));
  return released;
}

function applyOwnerAtlasGateEvents(config = bootConfig, scopeKey = gateScopeKey) {
  const events = Array.isArray(config?.ownerAtlasGateEvents) ? config.ownerAtlasGateEvents : [];
  if (!scopeKey || events.length === 0) return;
  let seenSeq = Number(ownerAtlasGateEventSeqByScope.get(scopeKey) || 0);
  for (const event of events) {
    const seq = Number(event?.seq) || 0;
    if (seq <= seenSeq) continue;
    noteAtlasCall({
      action: String(event?.action || ""),
      args: event?.args && typeof event.args === "object" ? event.args : {},
      ok: event?.ok === true,
      empty: event?.empty === true,
      cwd: workspaceCwd,
      scopeKey,
      telemetryContext: {
        work_item_id: Number(config?.workItemId) || null,
        job_id: Number(config?.jobId) || null,
        attempt_id: Number(config?.attemptId) || null,
        agent_call_id: Number(config?.agentCallId) || null,
      },
    });
    seenSeq = seq;
  }
  ownerAtlasGateEventSeqByScope.set(scopeKey, seenSeq);
}

function computeDeclaredNativeToolNamesForCurrentBoot() {
  return (ownerHotGateway
    ? [...ALL_NATIVE_TOOL_NAMES]
    : (hasTokenToolAllowlist()
      ? [...(tokenToolAllowlistForSuite("tools") || new Set())]
    : (roleName
      ? getDeterministicMcpToolNames(roleName, {
        needsImageGeneration: allowImageGeneration,
        atlasAvailable,
        disableSystemTools: bootConfig.disableSystemTools === true,
        researchInvestigation: bootConfig.researchInvestigation === true,
      })
      : legacyToolNamesForUnscopedRole()))
  ).filter(runtimeToolAvailable);
}

function rebuildNativeToolSchemas() {
  DECLARED_NATIVE_TOOL_NAMES = computeDeclaredNativeToolNamesForCurrentBoot();
  DECLARED_NATIVE_TOOL_NAME_SET = new Set(DECLARED_NATIVE_TOOL_NAMES);
  TOOL_SCHEMAS = [];
  addToolSchema(getToolSchemaForRole("agent_handoff", roleName, {
    compactCompletion: compactAgentHandoffIssued(),
    compactV3: compactAgentHandoffV3Issued(),
    compactV4: compactAgentHandoffV4Issued(),
    requireResearcherCoverage: researcherTraversalCoverageRequired(),
    researchInvestigation: bootConfig.researchInvestigation === true,
  }));
  addToolSchema(TOOL_AGENT_CLAIM);
  addToolSchema(TOOL_REPORT_CLAIMS);
  addToolSchema(TOOL_SUB_AGENT);
  addToolSchema(TOOL_SUB_AGENT_NEXT_INPUT);
  addToolSchema(getToolSchemaForRole("dispatch_agent", roleName, {
    plannerMaxChildren: roleName === "planner" ? readPlannerDispatchPolicy({ projectDir: workspaceCwd }).maxChildren : null,
    researchInvestigation: bootConfig.researchInvestigation === true,
  }));
  addToolSchema(TOOL_WEB_RESEARCH_HANDOFF);
  addToolSchema(getToolSchemaForRole("final_review", roleName));
  if (ownerHotGateway) {
    addToolSchema(readFileSchemaForCurrentBoot());
    addToolSchema(TOOL_CHAIN_READ);
    addToolSchema(TOOL_CHAIN_VERDICT);
  } else if (isResearcherRole && !atlasAvailable) {
    addToolSchema(TOOL_CHAIN_READ);
    addToolSchema(TOOL_CHAIN_VERDICT);
  } else {
    addToolSchema(readFileSchemaForCurrentBoot());
  }
  for (const schema of [TOOL_LIST_FILES, TOOL_SEARCH_FILES, TOOL_GIT_HISTORY, TOOL_INSPECT_FILE, TOOL_HASH_FILE]) {
    addToolSchema(schema);
  }
  addToolSchema(TOOL_AGENT_FEEDBACK);
  addToolSchema(TOOL_GET_OPERATOR_FEEDBACK);
  addToolSchema(TOOL_ACK_OPERATOR_FEEDBACK);
  addToolSchema(TOOL_GET_BRIEF);
  addToolSchema(projectDbQuerySchemaForCurrentBoot());
  addToolSchema(TOOL_CUSTOM_TOOLS);
  if (writeEnabled) {
    for (const schema of [TOOL_REQUEST_SCOPE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_PRUNE_ARTIFACT_OUTPUT, TOOL_MOVE_FILE, TOOL_COPY_FILE, TOOL_MAKE_DIR, TOOL_DOWNLOAD_FILE, TOOL_COMPOSE_SPRITE_SHEET]) {
      addToolSchema(schema.name === "request_scope" ? getToolSchemaForRole("request_scope", roleName) : schema);
    }
  }
  if (allowBash) addToolSchema(TOOL_BASH);
  if (ownerHotGateway || roleName === "assessor") {
    addToolSchema(getToolSchemaForRole("run_scoped_checks", roleName));
  }
  if (unitTestCapability.available && (ownerHotGateway || ["planner", "dev", "assessor"].includes(roleName))) addToolSchema(TOOL_RUN_UNIT_TEST);
  if (allowImageHelpers) {
    for (const schema of [TOOL_READ_IMAGE_METADATA, TOOL_VALIDATE_ARTIFACT_OUTPUT, TOOL_CLEAN_IMAGE, TOOL_EXTRACT_IMAGE_TEXT, TOOL_VIEW_IMAGE]) {
      addToolSchema(schema);
    }
  }
  if (allowImageGeneration) addToolSchema(TOOL_GENERATE_IMAGE);
  TOOL_SCHEMA_MAP = new Map(TOOL_SCHEMAS.map((schema) => [schema.name, schema]));
}

function attachToolExecutorsForCurrentBoot() {
  mcpToolRegistry = declareToolSuites(new ToolRegistry());
  mcpToolRegistry.attach("custom_tools", (args) => executeCustomToolsTool(args || {}));
  mcpToolRegistry.attach("request_scope", (args) => requestScopeWithinJob(args || {}));
  mcpToolRegistry.attach("agent_handoff", (args) => executeAgentHandoff(args || {}));
  mcpToolRegistry.attach("agent_claim", (args) => executeReportClaims(args || {}));
  mcpToolRegistry.attach("report_claims", (args) => executeReportClaims(args || {}));
  mcpToolRegistry.attach("sub_agent", (args) => executeSubAgentTool(args || {}));
  mcpToolRegistry.attach("sub_agent_next_input", (args) => executeSubAgentNextInputTool(args || {}));
  mcpToolRegistry.attach("dispatch_agent", (args) => executeDispatchAgentTool(args || {}));
  mcpToolRegistry.attach("web_research_handoff", (args) => executeWebResearchHandoffTool(args || {}));
  mcpToolRegistry.attach("final_review", () => executeFinalReviewTool());
  mcpToolRegistry.attach("read_file", (args) => dedupeReadFile(args || {}));
mcpToolRegistry.attach("get_brief", (args) => execGetBrief(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("list_files", (args) => execListFiles(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("search_files", (args) => execSearchFiles(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("git_history", (args) => execGitHistoryForRole(args || {}));
  mcpToolRegistry.attach("inspect_file", (args) => execInspectFile(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("hash_file", (args) => execHashFile(args || {}, workspaceCwd, effectiveScopePredicates));
  mcpToolRegistry.attach("agent_feedback", (args) => agentFeedback(args || {}));
  mcpToolRegistry.attach("get_operator_feedback", (args) => getOperatorFeedback(args || {}));
  mcpToolRegistry.attach("ack_operator_feedback", (args) => ackOperatorFeedback(args || {}));

  if (writeEnabled) {
    mcpToolRegistry.attach("write_file", (args) => writeFileWithinScope(args || {}));
    mcpToolRegistry.attach("edit_file", (args) => editFileWithinScope(args || {}));
    mcpToolRegistry.attach("prune_artifact_output", (args) => execPruneArtifactOutput({ output_root: bootConfig.artifactOutputRoot, ...args }, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("move_file", (args) => moveFileWithinScope(args || {}));
    mcpToolRegistry.attach("copy_file", (args) => copyFileWithinScope(args || {}));
    mcpToolRegistry.attach("make_dir", (args) => makeDirWithinScope(args || {}));
  }
  if (allowBash && execBash) {
    mcpToolRegistry.attach("bash", (args) => execBash(args || {}, workspaceCwd, effectiveScopePredicates));
  }
  if (ownerHotGateway || roleName === "dev" || roleName === "assessor" || roleName === "planner") {
    mcpToolRegistry.attach("run_scoped_checks", (args) => execRunScopedChecks(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope));
    mcpToolRegistry.attach("run_unit_test", (args) => execRunUnitTest(args || {}, workspaceCwd, effectiveScopePredicates, declaredJobScope, { unitTestCapability, scipAvailable: atlasAvailable, agentCallId: mcpAgentCallId }));
  }
  if (allowImageHelpers) {
    mcpToolRegistry.attach("read_image_metadata", (args) => execReadImageMetadata(args || {}, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("validate_artifact_output", (args) => execValidateArtifactOutput({ output_root: bootConfig.artifactOutputRoot, ...args }, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("extract_image_text", (args) => execExtractImageText(args || {}, workspaceCwd, effectiveScopePredicates));
    if (ownerHotGateway || roleName === "assessor") {
      mcpToolRegistry.attach("view_image", (args) => viewImageForCurrentScope(args || {}));
    }
  }
  // clean_image, compose_sprite_sheet, and download_file are artificer-only
  // mutations; owner-hot attaches all executors (remote token gates per call),
  // scoped boots only for the artificer role.
  if (ownerHotGateway || roleName === "artificer") {
    mcpToolRegistry.attach("clean_image", (args) => execCleanImage(args || {}, workspaceCwd, effectiveScopePredicates));
    mcpToolRegistry.attach("compose_sprite_sheet", (args) => composeSpriteSheetForCurrentScope(args || {}));
    mcpToolRegistry.attach("download_file", (args) => downloadFilesForCurrentScope(args || {}));
  }
  if (allowImageGeneration) {
    mcpToolRegistry.attach("generate_image", (args) => generateImageWithinScope(args || {}));
  }
  if (ownerHotGateway || isResearcherRole) {
    mcpToolRegistry.attach("chain_read", (args) => chainRead(args || {}));
    mcpToolRegistry.attach("chain_verdict", (args) => chainVerdict(args || {}));
  }
  if (projectDbAccessEnabled) {
    mcpToolRegistry.attach("project_db_query", (args) => execProjectDbQuery(args || {}, { projectDir: workspaceCwd, capability: projectDbCapability(), observationContext: { job_id: mcpJobId, work_item_id: mcpWorkItemId, attempt_id: mcpAttemptId } }));
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
    TOOL_EXECUTORS.set(toolName, (args) => (
      runNativeToolThroughGate(toolName, args || {}, handler)
    ));
  }
}

function recomputeAtlasAllowedActionsForCurrentBoot() {
  if (ownerHotGateway && !mcpMessageSessionScoped && atlasAvailable) {
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

function applyRuntimeBootConfig(nextConfig = {}, {
  sessionId = null,
  fallbackVerifiedConfig = null,
} = {}) {
  let parsedConfig = bootConfigFromOAuthToken(
    nextConfig && typeof nextConfig === "object" ? nextConfig : {},
    { markInvalid: false },
  );
  const oauthVerificationFailed = parsedConfig?.mcpOAuth?.verified === false;
  if (oauthVerificationFailed && fallbackVerifiedConfig?.mcpOAuth?.verified === true) {
    parsedConfig = fallbackVerifiedConfig;
  }
  const parsedDbPath = String(parsedConfig.dbPath || "").trim();
  if (parsedDbPath) setRuntimePathOverrides({ dbPath: parsedDbPath });
  agentAuthorityError = null;
  if (parsedConfig.scopeBindingMode === "dispatcher") {
    try {
      const authority = resolveAgentFileAuthority(parsedConfig);
      parsedConfig = { ...parsedConfig, ...authority.scope };
    } catch (error) {
      agentAuthorityError = error;
      parsedConfig = {
        ...parsedConfig,
        scopedFiles: [],
        createFiles: [],
        deleteFiles: [],
        createRoots: [],
        readRoots: [],
        allowWrite: false,
        allowShell: false,
        allowTests: false,
        projectDbWrite: false,
        projectDbCapability: "none",
        allowImageGeneration: false,
      };
    }
  }
  const nextSessionKey = runtimeSessionKey(parsedConfig, sessionId);
  const nextGateScopeKey = gateScopeKeyForBootConfig(parsedConfig, { sessionId });
  assertGatewayScopeCapacity(nextGateScopeKey);
  const sessionChanged = nextSessionKey !== activeRuntimeSessionKey;
  const previousMeterContext = {
    work_item_id: mcpWorkItemId,
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    agent_call_id: mcpAgentCallId,
  };
  bootConfig = parsedConfig;
  ownerHotGateway = ownerHotProcess || bootConfig.ownerHotGateway === true;
  const ownerHotUnscoped = ownerHotGateway && !mcpMessageSessionScoped;
  scopeParseState.invalid = bootConfig?.mcpOAuth?.verified === false || !!agentAuthorityError;
  workspaceCwd = String(bootConfig.cwd || "").trim() || process.cwd();
  allowWrite = bootConfig.allowWrite === true || ownerHotUnscoped;
  projectDbWrite = bootConfig.projectDbWrite === true;
  projectDbCapabilityGrant = normalizeProjectDbCapability(
    bootConfig.projectDbCapability || (projectDbWrite ? "write" : "none"),
  );
  allowImageHelpers = bootConfig.allowImageHelpers === true || ownerHotUnscoped;
  allowImageGeneration = bootConfig.allowImageGeneration === true || ownerHotUnscoped;
  roleName = String(bootConfig.role || "").trim() || null;
  isResearcherRole = roleName === "researcher";
  providerName = String(bootConfig.providerName || "").trim() || null;
  runId = String(bootConfig.runId || "").trim() || null;
  toolLogPath = String(bootConfig.toolLogPath || "").trim() || null;
  mcpDbPath = String(bootConfig.dbPath || "").trim() || null;
  mcpJobId = Number(bootConfig.jobId) || null;
  mcpWorkItemId = Number(bootConfig.workItemId) || null;
  mcpAttemptId = Number(bootConfig.attemptId) || null;
  mcpAgentCallId = Number(bootConfig.agentCallId) || null;
  mcpPromptChars = Math.max(0, Number(bootConfig.promptChars) || 0);
  atlasAvailable = bootConfig.atlasAvailable === true;
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
  allowBash = ownerHotUnscoped || (
    bootConfig.allowShell === true
    && ["dev", "artificer", "assessor"].includes(roleName)
  );
  execBash = allowBash ? createBashExecutor({ onAuthorization: recordBashPolicyObservation }) : null;
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
  const gateAtlasLabel = atlasBackendLabel(atlasAvailable ? getAtlasIntegrationConfig() : null);
  gateScopeKey = configureGate({
    role: roleName,
    atlasAvailable,
    enabled: atlasGateEnabled,
    atlasLabel: gateAtlasLabel,
    scopeKey: nextGateScopeKey,
  });
  gatewayScopeState(gateScopeKey, {
    gateConfiguration: gatewayGateConfiguration({
      role: roleName,
      atlasAvailable,
      enabled: atlasGateEnabled,
      atlasLabel: gateAtlasLabel,
    }),
  });
  applyOwnerAtlasGateEvents(bootConfig, gateScopeKey);
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
    ContextMeter.release(previousMeterContext);
    activeRuntimeSessionKey = nextSessionKey;
  }
  ContextMeter.forContext({
    work_item_id: mcpWorkItemId,
    job_id: mcpJobId,
    attempt_id: mcpAttemptId,
    agent_call_id: mcpAgentCallId,
  }, { promptChars: mcpPromptChars });
  const nextUnitTestCapabilityKey = `${workspaceCwd}\0${atlasAvailable}`;
  if (sessionChanged || nextUnitTestCapabilityKey !== unitTestCapabilityKey) {
    unitTestCapability = discoverUnitTestCapability({ projectDir: workspaceCwd, scipAvailable: atlasAvailable });
    unitTestCapabilityKey = nextUnitTestCapabilityKey;
  }
  rebuildNativeToolSchemas();
  rebuildToolExecutors();
  researchSessionStore.select(nextSessionKey);
  return { applied: true, usedVerifiedFallback: oauthVerificationFailed && parsedConfig === fallbackVerifiedConfig };
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
  "agent_claim",
  "report_claims",
  "reencode_image",
  "resize_image",
  "run_scoped_checks",
  "run_unit_test",
  "write_file",
]);

function nativeToolGateKey() {
  const normalized = path.resolve(workspaceCwd || process.cwd()).replace(/\\/g, "/");
  return `native-tools:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

async function runNativeToolThroughGate(toolName, args, handler) {
  const label = `tool.${toolName}`;
  const key = nativeToolGateKey();
  const run = () => runWithTeamManagedToolGrant({
    toolName,
    args,
    cwd: workspaceCwd,
    workItemId: mcpWorkItemId,
    run: () => handler(args),
  });
  const result = BLOCKING_NATIVE_TOOL_NAMES.has(toolName)
    ? await DETERMINISTIC_TOOL_GATE.write(key, run, { label, waitMs: 120000 })
    : await DETERMINISTIC_TOOL_GATE.read(key, run, { label, waitMs: 30000 });
  return appendHashRefIfMajor(toolName, result, {
    args,
    context: {
      cwd: workspaceCwd,
      work_item_id: mcpWorkItemId,
      job_id: mcpJobId,
      attempt_id: mcpAttemptId,
      agent_call_id: mcpAgentCallId,
    },
    ...(atlasAvailable && toolName === "read_file"
      && atlasNativeToolIsComplementary(toolName, roleName) ? { minChars: 1 } : {}),
  });
}

function boundForwardedReadArgs(toolName, args = {}) {
  if (toolName !== "read_file") return args;
  const maxLines = nativeReadMaxLines(args);
  const requested = Number(args?.limit);
  return {
    ...args,
    limit: Number.isInteger(requested) && requested > 0
      ? Math.min(requested, maxLines)
      : maxLines,
  };
}

function nativeReadMaxLines(args = {}) {
  return roleName === "researcher"
    && isIndexableSourcePath(args?.path, { cwd: workspaceCwd })
    ? ATLAS_RESEARCHER_READ_MAX_LINES
    : ATLAS_CHAIN_READ_MAX_LINES;
}

function atlasLiveBufferMode() {
  const atlasConfig = bootConfig.atlas && typeof bootConfig.atlas === "object" ? bootConfig.atlas : {};
  const raw = String(atlasConfig.liveBuffers || "off").trim().toLowerCase();
  if (raw === "1") return "deterministic-writes";
  if (raw === "true") return "deterministic-writes";
  if (raw === "deterministic-writes") return "deterministic-writes";
  return "off";
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

async function completeNativeToolCall({
  id,
  requestedToolName,
  toolName,
  args,
  recordInput,
  start,
  toolInvocation,
  result,
  deferred = false,
}) {
  // A content result (view_image) carries extra MCP blocks after its text; the
  // text alone drives classification, telemetry, and notices.
  const contentResult = asMcpContentResult(result);
  const text = contentResult
    ? contentResult.text
    : (typeof result === "string" ? result : inspect(result, { depth: 4, breakLength: 120 }));
  const controlNotices = [];
  let feedbackResult;
  try {
    feedbackResult = appendOperatorFeedbackDelivery(text, toolName);
  } catch {
    // Feedback delivery is additive; storage trouble cannot rewrite an
    // otherwise valid tool outcome.
    feedbackResult = { text, delivery: null };
  }
  if (feedbackResult.text !== text && feedbackResult.text.startsWith(text)) {
    const suffix = feedbackResult.text.slice(text.length);
    if (suffix) {
      controlNotices.push(embeddedControlNoticeMetadata(
        "operator_feedback_delivery",
        suffix,
        "operator_feedback_pending",
      ));
    }
  }
  let responseText = feedbackResult.text;
  const outcome = classifyNativeToolResult(text);
  const ok = isSuccessfulNativeToolResult(text);
  if (ok && toolName !== "chain_verdict") {
    // A first successful native read of a given signature is novel evidence;
    // only exact repeats advance the stale streak. Without this, every native
    // read scores as stale and can force a spurious mid-traversal closeout.
    noteResearchExplorationStep({
      toolName,
      novelRelevantFile: researchSessionStore.novelty.isNovel(toolName, args, text),
    });
  }
  if (ok) {
    const beforeNotice = responseText;
    const noticeResult = researchExplorationNoticeResult(responseText, toolName);
    responseText = noticeResult.text;
    const suffix = responseText.slice(beforeNotice.length);
    if (suffix) {
      controlNotices.push(embeddedControlNoticeMetadata(
        noticeResult.kind,
        suffix,
        noticeResult.kind,
      ));
    }
  }
  const atlasLiveBuffer = ok ? await maybePushAtlasLiveBufferForToolObservation({ toolName, args }) : null;
  const readStats = ok ? nativeReadResultStats(toolName, text) : null;
  const scopedCheckResult = scopedCheckToolResultObservation({
    tool: toolName,
    resultText: text,
  });
  const unitTestResult = unitTestToolResultObservation({
    tool: toolName,
    resultText: text,
  });
  const resultDiagnostic = scopedCheckResult?.error || unitTestResult?.error || capString(text, 300);
  const resultSummary = scopedCheckResult?.summary || unitTestResult?.summary || null;
  finishToolInvocation(toolInvocation, {
    tool: toolName,
    input: recordInput,
    cwd: workspaceCwd,
    ok,
    outcome,
    ...(resultSummary ? { resultSummary } : {}),
    ...(outcome === "failed" ? { error: resultDiagnostic } : {}),
    ...(outcome === "rejected" ? { rejection: resultDiagnostic } : {}),
    ...(atlasLiveBuffer || readStats || scopedCheckResult?.detail || unitTestResult?.detail ? {
      extraDetail: {
        ...(atlasLiveBuffer ? { atlas_live_buffer: atlasLiveBuffer } : {}),
        ...(readStats || {}),
        ...(scopedCheckResult?.detail ? { scoped_check_result: scopedCheckResult.detail } : {}),
        ...(unitTestResult?.detail ? { unit_test_result: unitTestResult.detail } : {}),
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
  if (
    deferred
    && (process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN)
    && process.env.POSSE_TEST_DEFERRED_SCOPE_COMPLETION_THROW === "1"
  ) {
    throw new Error("synthetic deferred scope completion failure");
  }
  sendMessage(jsonRpcSuccess(id, {
    content: [
      { type: "text", text: responseText },
      ...(ok && contentResult ? contentResult.content.map((block) => ({ ...block })) : []),
    ],
    ...(feedbackResult.delivery || controlNotices.length > 0 ? {
      _meta: {
        ...(feedbackResult.delivery ? { posseOperatorFeedback: feedbackResult.delivery } : {}),
        ...(controlNotices.length > 0 ? { posseControlNotices: controlNotices } : {}),
      },
    } : {}),
    ...(!ok ? { isError: true } : {}),
  }));
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendMessage(jsonRpcError(null, -32600, "Invalid request: expected an object"));
    return;
  }
  const privateSession = hiddenSessionFromParams(msg?.params);
  const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  if (privateSession && !ownerHotProcess) {
    if (id != null) sendMessage(jsonRpcError(id, -32602, "Private owner session context is not accepted by direct MCP servers"));
    return;
  }
  const session = ownerHotProcess ? privateSession : null;
  if (msg?.method === MCP_SESSION_RELEASED_NOTIFICATION) {
    if (ownerHotProcess && session) {
      abortLiveScopeWaitsForSession(session.sessionId);
      releaseGatewaySessionState(session.bootConfig, { sessionId: session.sessionId });
    }
    return;
  }
  (session?.bootConfig?.delegatedEvidenceCursor === true);
  // Owner-hot messages are session-scoped per message; without the hidden
  // param the module globals (mcpJobId/mcpAttemptId/role/cwd) are STICKY
  // leftovers from the previous message. Job-scoped tools consult this flag
  // so a message whose shim handshake failed to attach the param can never
  // read or ack ANOTHER session's operator feedback. Requests are serialized
  // by requestQueue, so a module flag is race-free.
  mcpMessageSessionScoped = !!session;
  if (session) {
    applyRuntimeBootConfig(session.bootConfig, { sessionId: session.sessionId });
    msg = { ...msg, params: stripHiddenSessionParam(msg?.params) };
  }
  const { method, params } = msg || {};
  if (!method) {
    if (id != null) sendMessage(jsonRpcError(id, -32600, "Invalid request: missing method"));
    return;
  }

  if (method === "initialize") {
    const instructions = mcpServerInstructions();
    sendMessage(jsonRpcSuccess(id, {
      protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      ...(instructions ? { instructions } : {}),
    }));
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "ping") {
    sendMessage(jsonRpcSuccess(id, {}));
    return;
  }

  // Compatibility response for clients that probe every configured MCP
  // server for resources even when initialize advertised only tools. Posse
  // does not issue a resource surface; an empty list tells the client to
  // discard that verification/discovery route without generating a bad
  // request or implying a capability the agent does not have.
  if (method === "resources/list") {
    sendMessage(jsonRpcSuccess(id, { resources: [] }));
    return;
  }

  if (method === "resources/templates/list") {
    sendMessage(jsonRpcSuccess(id, { resourceTemplates: [] }));
    return;
  }

  if (method === "tools/list") {
    if (agentAuthorityError) {
      sendMessage(jsonRpcError(id, -32041, "Agent file authority is unavailable", {
        code: agentAuthorityError?.code || "POSSE_AGENT_AUTHORITY_INVALID",
      }));
      return;
    }
    let nativeAllowedToolNames;
    let atlasAllowedActions;
    try {
      nativeAllowedToolNames = await resolveNativeAllowedToolNames();
      atlasAllowedActions = await resolveAtlasAllowedActions();
    } catch (err) {
      sendRemoteToolCatalogError(id, err, "tools/list");
      return;
    }
    // Every researcher with Atlas gets the direct surface, on any provider.
    const researcherDirect = isResearcherRole && atlasAvailable;
    const researcherReadSurface = researcherDirect;
    const languageLevers = researcherReadSurface
      ? researcherTypedLanguageLevers(workspaceCwd)
      : researcherTypedLanguageLeversForRootEntries([]);
    const researcherTypedPurposeGuidance = researcherReadSurface
      && languageLevers.purposeGuidance;
    const researcherTypedSymbolCardGuidance = researcherReadSurface
      && languageLevers.symbolCardGuidance;
    const nativeToolSchemas = [...TOOL_SCHEMA_MAP.values()]
      .filter((schema) => !nativeAllowedToolNames || nativeAllowedToolNames.has(schema.name))
      // Keep native utility projection identical on direct and query Atlas
      // surfaces. Non-Atlas sessions retain their ordinary native tool set.
      .filter((schema) => (
        !researcherReadSurface
        || !researcherDietDropsNativeTool(schema.name)
      ));
    const nativeTools = nativeToolSchemas
      .map(buildGatewayNativeToolDescriptor)
      .map((tool) => (researcherReadSurface
        ? applyResearcherTypedNativeToolShape(tool, { direct: researcherDirect })
        : tool));
    const allAtlasTools = atlasAvailable ? getStaticAtlasToolSchemas() : [];
    const atlasToolsRawCount = allAtlasTools.length;
    // Filter to the per-role allowlist so the LLM physically can't see ATLAS
    // tools its role isn't routed to. Actual execution is intercepted by the
    // parent MCP owner and routed through AtlasToolExecutor/conductor.
    // L5a (TOKEN-LEVERS): on the owner-hot path the gateway wrappers duplicate
    // the individual per-action tools already advertised; drop them from the
    // advertisement when the flag is on. Role-scoped paths never carry the
    // gateway names in atlasAllowedActions, so this is a no-op for them.
    const dedupGateways = ownerHotGateway && resolveAtlasGatewayDedupAdvertise();
    const researcherSchemaDiet = isResearcherRole
      && resolveAtlasResearcherSchemaDiet();
    const routedAtlasTools = projectCanonicalTraversalTools(
      allAtlasTools
        .filter((tool) => atlasAllowedActions?.has(_stripAtlasPrefix(tool?.name)))
        .filter((tool) => isExternallyRoutedAtlasTool(tool?.name))
        .filter((tool) => !dedupGateways || !ATLAS_GATEWAY_TOOL_NAMES.has(_stripAtlasPrefix(tool?.name))),
      roleName,
      bootConfig?.toolAllowlist?.atlas,
    )
      .filter((tool) => !researcherSchemaDiet || _stripAtlasPrefix(tool?.name) !== "fetch_ref");
    const atlasTools = researcherDirect ? buildResearcherDirectTools(routedAtlasTools, {
        purposeGuidance: researcherTypedPurposeGuidance,
        symbolCardGuidance: researcherTypedSymbolCardGuidance,
      }) : routedAtlasTools.map((tool) => buildFoldedAtlasToolDescriptor(tool, {
        role: roleName,
        codeWindowPolicy: bootConfig?.atlas?.codeWindowPolicy || null,
      }));
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
    const tools = sortAgentToolDefinitions([...nativeTools, ...atlasTools]
      .map(normalizeGatewayToolInputSchema)
      .map((tool) => (researcherSchemaDiet ? applyResearcherSchemaDiet(tool, {
        preserveDescription: researcherDirect && String(tool.name).startsWith("atlas."),
      }) : roleName === "planner" ? applyPlannerSchemaDiet(tool, { dbExecutionAvailable: nativeTools.some((entry) => entry.name === "project_db_query" || entry.name === "tools.project_db_query") }) : tool)));
    appendToolLog({
      event: "tools_list",
      requestId: id ?? null,
      toolCount: tools.length,
      nativeCount: nativeTools.length,
      atlasCount: atlasTools.length,
      atlasCountFiltered: atlasToolsRawCount - atlasTools.length,
      toolCatalogSource: (nativeAllowedToolNames || (atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions)) ? "remote" : "local",
      atlasCatalogSource: atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions ? "remote" : "local",
      researcherTypedPrimaryLanguage: languageLevers.primaryLanguage,
      researcherTypedDetectedLanguages: languageLevers.detectedLanguages,
      researcherTypedPurposeGuidance,
      researcherTypedSymbolCardGuidance,
      tools: tools.map((tool) => tool.name),
    });
    recordIssuedToolSurfaceObservation({
      tools,
      atlasTools,
      effectivePolicy: {
        disable_system_tools: bootConfig.disableSystemTools === true,
        atlas_available: atlasAvailable === true,
        traversal_coverage_required: researcherTraversalCoverageRequired(),
        direct: researcherDirect === true,
        purpose_guidance: researcherTypedPurposeGuidance === true,
        symbol_card_guidance: researcherTypedSymbolCardGuidance === true,
        primary_language: languageLevers.primaryLanguage,
        detected_languages: [...languageLevers.detectedLanguages],
        schema_diet: researcherSchemaDiet === true,
        gateway_dedup: dedupGateways === true,
        atlas_catalog_source: atlasAllowedActions && atlasAllowedActions !== _atlasAllowedActions ? "remote" : "local",
      },
      projections: researcherDirect
        ? { "symbol.callers": COMPACT_RELATIONSHIP_PROJECTION, "code.structure": COMPACT_STRUCTURE_PROJECTION }
        : {},
    });
    sendMessage(jsonRpcSuccess(id, { tools }));
    return;
  }

  if (method === "tools/call") {
    if (agentAuthorityError) {
      sendMessage(jsonRpcError(id, -32041, "Agent file authority is unavailable", {
        code: agentAuthorityError?.code || "POSSE_AGENT_AUTHORITY_INVALID",
      }));
      return;
    }
    await nativeGitAuthReady();
    const requestedToolName = String(params?.name || "");
    const normalizedRequestToolName = _normalizeGatewayToolRequestName(requestedToolName);
    const requestedAtlasTool = normalizedRequestToolName.startsWith("atlas.") || normalizedRequestToolName.startsWith("atlas_");
    const toolName = requestedAtlasTool ? normalizedRequestToolName : _stripToolsPrefix(normalizedRequestToolName);
    let args = params?.arguments || {};
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
      arguments: toolName === "agent_handoff"
        ? {
            protocol: args?.protocol || null,
            profile: args?.profile || null,
            outcome: args?.outcome || null,
            handoff_count: Array.isArray(args?.handoffs) ? args.handoffs.length : null,
            tasks_shape: describeTasksShape(args?.tasks),
            handoff_targets: describeTargetShapes(args?.handoffs),
          }
        : sanitizeForLog(args),
    });

    const assessorBudget = assessorToolBudgetDecision(toolName, args);
    if (assessorBudget?.advisory) {
      appendToolLog({
        event: "assessor_read_allowance_advisory",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        reason: assessorBudget.reason,
        used: assessorBudget.used,
        cap: assessorBudget.cap,
      });
      try {
        _recordObservation({
          work_item_id: mcpWorkItemId ?? null,
          job_id: mcpJobId ?? null,
          attempt_id: mcpAttemptId ?? null,
          observation_type: "tool.budget_advisory",
          summary: `Assessor read past allowance: ${toolName} (${assessorBudget.used}/${assessorBudget.cap})`,
          detail: {
            assessment_budget_advisory: true,
            assessment_budget_reason: assessorBudget.reason,
            assessment_budget_used: assessorBudget.used,
            assessment_budget_cap: assessorBudget.cap,
            tool_name: toolName,
            transport: "deterministic_mcp",
            agent_call_id: mcpAgentCallId ?? null,
          },
        });
      } catch { /* advisory telemetry never blocks a tool */ }
    } else if (assessorBudget) {
      appendToolLog({
        event: "assessor_tool_budget_exhausted",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        reason: assessorBudget.reason,
        used: assessorBudget.used,
        cap: assessorBudget.cap,
      });
      const budgetInvocation = beginToolInvocation({
        tool: toolName,
        input: args,
        cwd: workspaceCwd,
      });
      finishToolInvocation(budgetInvocation, {
        tool: toolName,
        input: args,
        cwd: workspaceCwd,
        ok: false,
        outcome: "rejected",
        rejection: assessorBudget.text,
        extraDetail: {
          assessment_budget_exhausted: true,
          assessment_budget_reason: assessorBudget.reason,
          assessment_budget_used: assessorBudget.used,
          assessment_budget_cap: assessorBudget.cap,
          tool_name: toolName,
          transport: "deterministic_mcp",
        },
      });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: assessorBudget.text }],
        isError: false,
      }));
      return;
    }

    if (toolName !== "agent_handoff" && rejectAgentHandoffForLaterTool(mcpAgentCallId, toolName)) {
      const errorText = "agent_handoff was already staged; later tool calls invalidate the terminal report";
      appendToolLog({
        event: "agent_handoff_terminal_violation",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
      });
      recordRejectedToolCall({ toolName, args, text: errorText, reason: "agent_handoff_terminal_violation" });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: errorText }],
        isError: true,
      }));
      return;
    }

    const citationFetchGate = researchCitationFetchGate(requestedToolName);
    if (citationFetchGate) {
      appendToolLog({
        event: "research_citation_fetch_gate",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        reason: citationFetchGate.reason,
        citationFetches: citationFetchGate.citationFetches,
        citationFetchBatches: citationFetchGate.citationFetchBatches,
      });
      const citationGateText = buildResearchCitationFetchGateText({
        reason: citationFetchGate.reason,
        handoffToolName: embeddedAgentHandoffCallableName(),
      });
      recordEmbeddedModelControlNotice(toolName, {
        kind: "citation_fetch_gate",
        text: citationGateText,
        trigger: citationFetchGate.reason || "citation_fetch_gate",
      });
      recordRejectedToolCall({
        toolName,
        args,
        text: citationGateText,
        reason: citationFetchGate.reason || "citation_fetch_gate",
      });
      sendMessage(jsonRpcSuccess(id, embeddedControlResult(
        citationGateText,
        "citation_fetch_gate",
        citationFetchGate.reason || "citation_fetch_gate",
      )));
      return;
    }

    if (shouldBlockForResearchSynthesis(requestedToolName, { requestedAtlasTool })) {
      const errorText = buildResearchSynthesisRequiredMessage(requestedToolName);
      appendToolLog({
        event: "research_synthesis_gate",
        requestId: id ?? null,
        tool: requestedToolName,
        canonicalTool: toolName,
        explorationSteps: researchSessionStore.state.explorationSteps,
        staleSteps: researchSynthesisStaleStepCount(),
      });
      recordEmbeddedModelControlNotice(toolName, {
        kind: "research_closeout_gate",
        text: errorText,
        trigger: "research_synthesis_gate",
        explorationStep: Number(researchSessionStore.state.explorationSteps || 0),
      });
      recordRejectedToolCall({ toolName, args, text: errorText, reason: "research_synthesis_gate" });
      sendMessage(jsonRpcSuccess(id, embeddedControlResult(
        errorText,
        "research_closeout_gate",
        "research_synthesis_gate",
      )));
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
        const deniedText = `Unknown ATLAS tool "${requestedToolName}"`;
        recordRejectedToolCall({ toolName, args, text: deniedText, reason: "unknown_atlas_tool" });
        sendMessage(jsonRpcSuccess(id, {
          content: [{ type: "text", text: deniedText }],
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
        const deniedText = blockedAtlasMutationMessage(toolName);
        recordRejectedToolCall({ toolName, args, text: deniedText, reason: "mutating_atlas_tool_blocked_in_gateway" });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: deniedText,
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
        const deniedText = `ATLAS tool ${toolName} is intentionally not exposed. Use ${issuedIndexedSourceReadPhrase(issuedAtlasActionsForModelText())} for indexed source. Use the issued deterministic ${isResearcherRole && !atlasAvailable ? "chain_read" : "read_file"} tool for exact file content.`;
        recordRejectedToolCall({ toolName, args, text: deniedText, reason: "fallback_only_atlas_tool" });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: deniedText,
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
        const deniedText = `ATLAS action ${routeCheck.effectiveAction || requestedToolName} is not allowed for the ${roleName || "this"} role. Use one of the role's allowed ATLAS tools instead.`;
        recordRejectedToolCall({ toolName, args, text: deniedText, reason: "atlas_action_not_allowed" });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: deniedText,
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
        const deniedText = `ATLAS tool ${requestedToolName} must be executed by the Posse MCP owner through AtlasToolExecutor; direct gateway execution is disabled.`;
        recordRejectedToolCall({ toolName, args, text: deniedText, reason: "atlas_call_deferred_to_owner_required" });
        sendMessage(jsonRpcSuccess(id, {
          content: [{
            type: "text",
            text: deniedText,
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
          content: [{ type: "text", text: `Error executing ${requestedToolName}: ${sanitizeAbsolutePathsInText(safeError, workspaceCwd)}` }],
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
      const deniedText = `Tool ${requestedToolName} is not allowed for the ${roleName || "current"} remote-issued tool surface.`;
      recordRejectedToolCall({ toolName, args, text: deniedText, reason: "native_call_denied" });
      sendMessage(jsonRpcSuccess(id, {
        content: [{
          type: "text",
          text: deniedText,
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
        explorationSteps: researchSessionStore.state.explorationSteps,
        staleSteps: researchSynthesisStaleStepCount(),
      });
      recordEmbeddedModelControlNotice(toolName, {
        kind: "research_closeout_gate",
        text: errorText,
        trigger: "research_synthesis_gate",
        explorationStep: Number(researchSessionStore.state.explorationSteps || 0),
      });
      recordRejectedToolCall({ toolName, args, text: errorText, reason: "research_synthesis_gate" });
      sendMessage(jsonRpcSuccess(id, embeddedControlResult(
        errorText,
        "research_closeout_gate",
        "research_synthesis_gate",
      )));
      return;
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
      const deniedText = `Error: Unknown tool "${requestedToolName}"`;
      recordRejectedToolCall({ toolName, args, text: deniedText, reason: "unknown_tool" });
      sendMessage(jsonRpcSuccess(id, {
        content: [{ type: "text", text: deniedText }],
        isError: true,
      }));
      return;
    }
    // For chain_verdict the file path lives in the server's chain state, not
    // in the tool args. Enrich the recorded input so the observation actually
    // identifies which file the verdict applies to.
    const recordInput = toolName === "agent_handoff"
      ? {
          protocol: args?.protocol || null,
          profile: args?.profile || null,
          outcome: args?.outcome || null,
          handoff_count: Array.isArray(args?.handoffs) ? args.handoffs.length : null,
          tasks_shape: describeTasksShape(args?.tasks),
          handoff_targets: describeTargetShapes(args?.handoffs),
        }
      : (toolName === "chain_verdict" && researchSessionStore.state?.currentlyReading?.path)
        ? { ...args, path: researchSessionStore.state.currentlyReading.path }
        : args;
    // Record the request the moment it's made (append-only "<type>.started"),
    // then close it with the completion row on every exit path so duration and
    // success/failure are captured — not just successful completions.
    const toolInvocation = beginToolInvocation({ tool: toolName, input: recordInput, cwd: workspaceCwd });
    try {
      if (toolName === "agent_handoff" && countPendingOperatorFeedbackForJob(mcpJobId, mcpAgentCallId) > 0) {
        await completeNativeToolCall({
          id,
          requestedToolName,
          toolName,
          args,
          recordInput,
          start,
          toolInvocation,
          result: "Error: agent_handoff paused: acknowledge pending operator feedback with ack_operator_feedback before terminal handoff.",
        });
        return;
      }
      const result = await handler(args);
      if (result?.[LIVE_SCOPE_WAIT] === true) {
        scheduleDeferredLiveScopeTool({
          marker: result,
          id,
          requestedToolName,
          toolName,
          args,
          recordInput,
          start,
          toolInvocation,
          runtime: {
            bootConfig: session?.bootConfig || bootConfig,
            resolvedBootConfig: bootConfig,
            grantedWritePaths: effectiveScopePredicates?.policy?.grantedWritePaths?.() || [],
            sessionId: session?.sessionId || null,
            observation: {
              work_item_id: mcpWorkItemId,
              job_id: mcpJobId,
              attempt_id: mcpAttemptId,
              agent_call_id: mcpAgentCallId,
            },
          },
        });
        return;
      }
      await completeNativeToolCall({
        id,
        requestedToolName,
        toolName,
        args,
        recordInput,
        start,
        toolInvocation,
        result,
      });
    } catch (err) {
      if (toolName === "agent_handoff") {
        recordAgentHandoffRejection(mcpAgentCallId, err);
      }
      const handoffIssues = toolName === "agent_handoff" && Array.isArray(err?.issues)
        ? err.issues.slice(0, 24).map((issue) => ({
            code: String(issue?.code || "AGENT_HANDOFF_SCHEMA_INVALID").slice(0, 120),
            message: sanitizeAbsolutePathsInText(capString(issue?.message || "Invalid agent_handoff arguments", 500), workspaceCwd),
          }))
        : [];
      const safeError = capString(err?.message || String(err), toolName === "agent_handoff" ? 2400 : 300);
      // Everything the agent sees — text block and structured channel alike —
      // gets the scrub; the raw form stays in local telemetry below.
      const displayError = sanitizeAbsolutePathsInText(safeError, workspaceCwd);
      finishToolInvocation(toolInvocation, {
        tool: toolName,
        input: recordInput,
        cwd: workspaceCwd,
        ok: false,
        outcome: "failed",
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
        content: [{ type: "text", text: `Error executing ${requestedToolName}: ${displayError}` }],
        isError: true,
        ...(toolName === "agent_handoff" ? {
          structuredContent: {
            error: {
              code: String(err?.code || "AGENT_HANDOFF_REJECTED").slice(0, 120),
              message: displayError,
              ...(handoffIssues.length > 0 ? { issues: handoffIssues } : {}),
            },
          },
        } : {}),
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
let capabilityBrokerInstalled = false;
let mcpTrafficStarted = false;
/** @type {Promise<unknown> | null} */
let nativeGitAuthPrewarm = null;

/**
 * Sync native Git (list_files/search_files ignore checks, ...) reads only the
 * pulse cache, so no tool may run before this process holds both Git route
 * grants. Owner-hot gateways start the prewarm as soon as the parent's
 * capability frame installs their pulse broker; direct (compatibility/test)
 * servers start it at their first tool call. Tool calls await it; handshake
 * methods never do. Bounded and best-effort: it never rejects, waits at most
 * NATIVE_GIT_PREWARM_TIMEOUT_MS, and unavailable native auth never fails
 * serving (the Git call itself then fails closed as before).
 */
function nativeGitAuthReady() {
  nativeGitAuthPrewarm ||= prewarmNativeGitAuth();
  return nativeGitAuthPrewarm;
}
const sharedLiveScopeDecisionWaits = new Map();
const pendingLiveScopeTasks = new Set();

function liveScopeWaitTimeoutMs() {
  const runningTests = !!(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
  const testOverride = runningTests ? Number(process.env.POSSE_TEST_SCOPE_WAIT_TIMEOUT_MS) : NaN;
  return Number.isFinite(testOverride) && testOverride >= 25
    ? Math.min(LIVE_SCOPE_WAIT_TIMEOUT_MS, testOverride)
    : LIVE_SCOPE_WAIT_TIMEOUT_MS;
}

function liveScopeDecisionKey(runtime, request) {
  return `${Number(runtime?.observation?.job_id) || 0}:${String(request?.request_id || "")}`;
}

function sharedLiveScopeDecision(runtime, request) {
  const key = liveScopeDecisionKey(runtime, request);
  const existing = sharedLiveScopeDecisionWaits.get(key);
  if (existing) {
    if (runtime?.sessionId) existing.sessionIds.add(runtime.sessionId);
    return existing;
  }
  const controller = new AbortController();
  const record = {
    controller,
    sessionIds: new Set(runtime?.sessionId ? [runtime.sessionId] : []),
    promise: null,
  };
  record.promise = awaitJobScopeExpansionDecision({
    jobId: runtime?.observation?.job_id,
    requestId: request?.request_id,
    attemptId: runtime?.observation?.attempt_id,
    signal: controller.signal,
    timeoutMs: liveScopeWaitTimeoutMs(),
    // The MCP process has its own memory space, so only durable queue reads
    // can observe the human answer.
    useQueueWake: false,
  }).finally(() => {
    if (sharedLiveScopeDecisionWaits.get(key) === record) {
      sharedLiveScopeDecisionWaits.delete(key);
    }
  });
  sharedLiveScopeDecisionWaits.set(key, record);
  return record;
}

function abortLiveScopeWaitsForSession(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return;
  for (const record of sharedLiveScopeDecisionWaits.values()) {
    if (!record.sessionIds.has(normalized)) continue;
    // Only the LAST member's release may abort the shared wait. A stale
    // session (e.g. the client reconnected and its batched write joined the
    // same record) releasing must not abandon the request and force-cancel
    // the human gate out from under sessions still waiting on the answer.
    record.sessionIds.delete(normalized);
    if (record.sessionIds.size === 0) record.controller.abort();
  }
}

function abortAllLiveScopeWaits() {
  for (const record of sharedLiveScopeDecisionWaits.values()) {
    record.controller.abort();
  }
}

async function resumeDeferredLiveScopeTool(call) {
  let decision;
  try {
    decision = await sharedLiveScopeDecision(call.runtime, call.marker.request).promise;
  } catch (err) {
    decision = {
      ok: false,
      approved: false,
      code: "scope_wait_failed",
      message: `The active scope wait failed: ${capString(err?.message || String(err), 240)}`,
    };
  }

  const completion = requestQueue.then(() => runWithObservationContext(
    call.runtime.observation,
    async () => {
      try {
        mcpMessageSessionScoped = !!call.runtime.sessionId;
        if (call.runtime.sessionId) {
          applyRuntimeBootConfig(call.runtime.bootConfig, {
            sessionId: call.runtime.sessionId,
            fallbackVerifiedConfig: call.runtime.resolvedBootConfig,
          });
        }
        for (const grantedPath of call.runtime.grantedWritePaths || []) {
          effectiveScopePredicates?.policy?.grantWritePath?.(grantedPath);
        }
        let result;
        if (decision?.approved === true) {
          grantApprovedScopeEntries(decision, effectiveScopePredicates);
          if (call.marker.operation === "write_file") {
            result = await runWithTeamManagedToolGrant({
              toolName: "write_file", args: call.marker.args || {}, cwd: workspaceCwd,
              workItemId: mcpWorkItemId, run: () => writeFileWithinScope(call.marker.args || {}),
            });
          } else if (call.marker.operation === "edit_file") {
            result = await runWithTeamManagedToolGrant({
              toolName: "edit_file", args: call.marker.args || {}, cwd: workspaceCwd,
              workItemId: mcpWorkItemId, run: () => editFileWithinScope(call.marker.args || {}),
            });
          } else {
            result = JSON.stringify(decision, null, 2);
          }
        } else {
          result = JSON.stringify(decision, null, 2);
        }
        await completeNativeToolCall({ ...call, result, deferred: true });
      } catch (err) {
        const safeError = capString(err?.message || String(err), 300);
        let displayError = safeError;
        try { displayError = sanitizeAbsolutePathsInText(safeError, workspaceCwd) || safeError; } catch { /* use capped raw error */ }
        if (call.id != null) {
          try {
            sendMessage(jsonRpcError(
              call.id,
              -32603,
              displayError || "Deferred scope tool completion failed",
            ));
          } catch {
            // stdout may already be closed; the outer guard still records it.
          }
        }
        try {
          appendToolLog({
            event: "deferred_scope_tool_error",
            requestId: call.id ?? null,
            tool: call.requestedToolName,
            canonicalTool: call.toolName,
            error: safeError,
          });
        } catch { /* protocol response takes precedence over telemetry */ }
      }
    },
  ));
  const guarded = completion.catch((err) => {
    appendToolLog({
      event: "deferred_scope_tool_error",
      requestId: call.id ?? null,
      tool: call.requestedToolName,
      canonicalTool: call.toolName,
      error: capString(err?.message || String(err), 300),
    });
  });
  requestQueue = guarded;
  await guarded;
}

function scheduleDeferredLiveScopeTool(call) {
  const task = resumeDeferredLiveScopeTool(call);
  pendingLiveScopeTasks.add(task);
  void task.finally(() => pendingLiveScopeTasks.delete(task));
}

function dispatchParsed(parsed) {
  if (parsed?.__posse_control === "capabilityBroker") {
    if (!ownerHotProcess || mcpTrafficStarted || capabilityBrokerInstalled) return;
    try {
      nativeBinaries.setPulseManager(new ParentPulseTokenManager(parsed.capability));
      capabilityBrokerInstalled = true;
      void nativeGitAuthReady();
    } catch {
      scopeParseState.invalid = true;
    }
    return;
  }
  mcpTrafficStarted = true;
  // Re-establish observation context per-message — stdin's async scope
  // predates module-level enterObservationContext, so ALS values set at
  // load time don't propagate into data events.
  const session = ownerHotProcess ? hiddenSessionFromParams(parsed?.params) : null;
  const sessionBoot = session?.bootConfig || {};
  requestQueue = requestQueue.then(() => runWithObservationContext(
    {
      work_item_id: session ? Number(sessionBoot.workItemId) || null : mcpWorkItemId,
      job_id: session ? Number(sessionBoot.jobId) || null : mcpJobId,
      attempt_id: session ? Number(sessionBoot.attemptId) || null : mcpAttemptId,
      agent_call_id: session ? Number(sessionBoot.agentCallId) || null : mcpAgentCallId,
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
      sendMessage(jsonRpcError(id, -32603, sanitizeAbsolutePathsInText(safeError, workspaceCwd) || "Internal error"));
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
      if (separatorIndex < 0) {
        const headerText = inputBuffer.toString("utf8");
        const invalidLine = /\n(?=[{\[]|content-length:)/iu.exec(headerText);
        if (invalidLine || inputBuffer.length > 8192) {
          const consumed = invalidLine ? invalidLine.index + 1 : inputBuffer.length;
          inputBuffer = inputBuffer.subarray(consumed);
          reportParseError("lsp", new Error("Unterminated Content-Length header"), consumed);
          continue;
        }
        return; // A bounded partial header may still arrive in another chunk.
      }
      const headerBlock = inputBuffer.subarray(0, separatorIndex).toString("utf8");
      if (!headerBlock.split("\r\n").every((line) => /^[\w-]+:[^\r\n]*$/u.test(line))
        || headerBlock.split("\r\n").filter(line => /^content-length:/iu.test(line)).length !== 1) {
        const consumed = inputBuffer.indexOf(0x0a) + 1;
        inputBuffer = inputBuffer.subarray(consumed);
        reportParseError("lsp", new Error("Malformed Content-Length header"), consumed);
        continue;
      }
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
  abortAllLiveScopeWaits();
  try { await Promise.allSettled([...pendingLiveScopeTasks]); } catch { /* best-effort live wait teardown */ }
  try { await requestQueue; } catch { /* requestQueue is best-effort guarded */ }
  try { await nativeBinaries.disposeAll(); } catch { /* teardown is best effort */ }
  process.exit(code);
}

process.stdin.on("error", () => { void shutdownAndExit(0); });
process.stdin.on("end", () => { void shutdownAndExit(0); });
process.once("SIGINT", () => { void shutdownAndExit(130); });
process.once("SIGTERM", () => { void shutdownAndExit(143); });
