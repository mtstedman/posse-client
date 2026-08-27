// @ts-check
//
// Persistent MCP owner for provider-launched stdio shims.
//
// The shim stays tiny and forwards JSON-RPC frames here over a local named-pipe
// HTTP endpoint. The owner verifies the signed job capability token, keeps the
// full deterministic MCP runtime out of each provider-launched shim process,
// and owns session lifecycle for the parent Posse process.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { AGENT_HANDOFF_RECEIPT_NOTIFICATION } from "../../../catalog/handoff.js";
import { SUB_AGENT_EVIDENCE_OUTCOMES } from "../../../catalog/sub-agent.js";
import {
  DEFAULT_MCP_OAUTH_TTL_SECONDS,
  MCP_SESSION_RELEASED_NOTIFICATION,
} from "../../../catalog/mcp.js";
import { RESPONSE_TRANSFORM_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { roleUsesBoundedRefTraversal } from "../../../catalog/tool-surface/ref-traversal.js";
import {
  assessorFallbackReadKey,
  isAssessorFallbackReadKey,
} from "../../../domains/assessment/functions/fallback-read-tools.js";
import {
  assessorToolBudgetApplies,
  assessorToolCallCeilingDecision,
} from "../functions/assessor-tool-budget.js";
import { compactResearcherTypedAtlasText } from "../functions/researcher-typed-result-compaction.js";
import { sanitizeAbsolutePathsInText } from "../../format/functions/display-paths.js";
import {
  bootConfigFromMcpOAuthClaims,
  mintMcpOAuthTokenForBootConfig,
  verifyMcpOAuthToken,
} from "../../../domains/integrations/functions/deterministic-mcp/oauth-token.js";
import { ATLAS_TOOL_ACTIONS } from "../../../domains/atlas/functions/v2/contracts/tool-params.js";
import { atlasDescriptorSchemaForAction } from "../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { resolveWorkflowRefs } from "../../../domains/atlas/functions/v2/retrieval/workflow.js";
import { getSharedAtlasToolExecutor } from "../../../domains/atlas/functions/v2/tools/executor.js";
import {
  resolveAtlasResearcherDispatcher,
  resolveAtlasResearcherTypedDispatcher,
  resolveAtlasResearcherWorkflow,
} from "../../../domains/integrations/functions/deterministic-mcp/gate-settings.js";
import {
  buildResearcherTypedReadyCallBatchingText,
  normalizeResearcherWorkflowFacadeArgs,
  researcherTypedLanguageLeversForRootEntries,
  researcherWorkflowActions,
  researcherWorkflowMaxSteps,
} from "../../../domains/integrations/functions/deterministic-mcp/researcher-dispatcher.js";
import {
  operatorFeedbackDeliveryForJob,
  operatorFeedbackDeliveryText,
} from "../../../domains/providers/functions/shared/tool-runtime.js";
import {
  getAgentHandoffRecord,
  materializeAgentHandoffEvidenceSelector,
  recordAgentHandoffRejection,
  rejectAgentHandoffForLaterTool,
} from "../../../domains/handoff/functions/agent-handoff.js";
import { agentHandoffTerminator } from "../../../domains/handoff/classes/AgentHandoffTerminator.js";
import {
  assertSubAgentParentReady,
  executeSubAgent,
  executeSubAgentNextInput,
  prepareSubAgentHandoff,
  sealSubAgentHandoff,
  subAgentCompletionSignal,
} from "../../../domains/sub-agent/classes/SubAgentRuntime.js";
import { classifyDelegatedToolResult } from "../../../domains/sub-agent/functions/delegated-evidence.js";
import { evidenceRefSurface } from "../functions/ref-surface.js";
import {
  subAgentDispatchIdentities,
  subAgentEvidenceCallIdentities,
  subAgentMutationTargetKeys,
} from "../../../domains/sub-agent/functions/routing-identity.js";
import { classifyMcpToolResult } from "../../../domains/integrations/functions/deterministic-mcp/json-rpc.js";
import {
  recordObservation,
  recordToolUseObservations,
  isResearchInfrastructureFailure,
  RESEARCH_INFRASTRUCTURE_REFUND_LIMIT,
  researchExplorationObservationStatus,
  researchSurveyCoverageStatus,
} from "../../../domains/observability/functions/observations.js";
import {
  fetchHashRefEvidenceForContext,
  issueHashRefTraversalForContext,
  listHashRefTraversalsForContext,
} from "../../../domains/queue/functions/hash-refs.js";
import {
  RESEARCH_CITATION_FETCH_GATE_ENABLED,
  RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
  RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
  RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS,
  RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS,
  RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS,
  buildResearchCitationFetchGateText,
  buildResearchCurtainCallText,
  buildResearchEarlyFetchBatchingText,
  buildResearchFinalFetchBatchText,
  buildResearchSynthesisRequiredText,
  isResearchAtlasCitationFetchAction,
  isResearchAtlasExplorationAction,
  researchSynthesisDecision,
  researchSynthesisExplorationCeiling,
} from "../../../domains/integrations/functions/deterministic-mcp/research-synthesis.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import { NativeAuthHandshake } from "../../native/classes/NativeAuthHandshake.js";
import { appendHashRefIfMajor, compactCodeSurveyResult, compactCodeWindowLensResult, createHashRefResult, fetchHashRefTool, hashRefTraversalInputs } from "../functions/hash-adder.js";
import {
  bindAgentAttachmentToSignedContract,
  isInternalAtlasAction,
  narrowBootConfigToSignedClaims,
} from "../functions/issued-tool-policy.js";
import { toolSchemaTelemetry } from "../functions/tool-schema-telemetry.js";
import { sourceSelectorFingerprint } from "../../../domains/research/classes/SourceCoverageOwner.js";
import {
  admitSourceContextHeadroom,
  releaseSourceContextHeadroomReservation,
} from "../../../domains/research/functions/context-headroom.js";
import {
  materializeSourceCoverage,
  prepareSourceCoverage,
  sourceCoverageOwnerForSession,
} from "../../../domains/research/functions/owner-source-admission.js";

const MAX_OWNER_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const MAX_OWNER_ATLAS_GATE_EVENTS = 64;
// A child that produces NO response across this many consecutive request
// timeouts is treated as wedged (event loop blocked, native deadlock) rather
// than merely slow, and is force-killed so the next request respawns it. Any
// response resets the counter, so a legitimately long single call does not
// trip it. The gateway is stateless per request, so respawn loses nothing.
const MAX_CONSECUTIVE_REQUEST_TIMEOUTS = 2;
// Minimum spacing between child (re)spawns. Without it, a server spec that
// crashes on startup turns every forwarded request into a fresh, heavy Node
// process spawn — a hot crash-loop. The shim already treats the resulting
// backoff error as a transient 5xx and retries.
const GATEWAY_RESTART_BACKOFF_MS = 2000;
const JSONL_STDOUT_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;
const OWNER_MODEL_CONTROL_NOTICES = Symbol("ownerModelControlNotices");
const SOURCE_EVIDENCE_REUSE_NOTICE_KIND = "source_evidence_reuse";
const sourceEvidenceReuseNoticeAttempts = new WeakMap();
// Codex can emit one read batch but dispatch it through the MCP transport in
// several short waves. Keep the final admitted emission alive across the
// zero-active gap between those waves; a later model turn takes materially
// longer and is admitted against the now-closed durable research lane.
const RESEARCH_ATLAS_TERMINAL_BATCH_IDLE_MS = 250;
const CONCURRENT_RESEARCH_ATLAS_ACTIONS = new Set([
  "action.search",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "buffer.status",
  "symbol.search",
  "symbol.card",
  "symbol.overview",
  "tree.overview",
  "tree.branch",
  "tree.scope",
  "tree.expand",
  "slice.build",
  "edit.plan",
  "code.skeleton",
  "code.lens",
  "code.window",
  "code.survey",
  "code.structure",
  "code.db",
  "context.summary",
  "review.delta",
  "review.analyze",
  "review.risk",
  "file.read",
  "policy.get",
  "usage.stats",
]);
const SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS = 2;
const SUB_AGENT_ROUTING_MIN_TARGETS = 2;
const SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS = 3000;
const SUB_AGENT_ROUTING_REMINDER =
  "\n\nSUB-AGENT ROUTING CHECKPOINT: multiple repository targets have now required two parent evidence calls. " +
  "Before another read or materialization call, dispatch one sub_agent batch with completion.mode=wait_all when at least two related targets still need synthesis. " +
  "Prefer one citation_synthesis.v1 request with two or three ordered inputs; use separate requests only for genuinely independent syntheses. " +
  "Treat the returned cited synthesis as a substitute for those reads rather than immediately reopening the delegated inputs. " +
  "Continue directly only when the current context already contains the answers or the remaining question needs one targeted call.";
const SUB_AGENT_ROUTING_BLOCK =
  "Sub-agent routing required before another parent evidence call: at least two reads across multiple repository targets have already completed. " +
  "Dispatch one sub_agent batch with completion.mode=wait_all, preferring one citation_synthesis.v1 request with two or three ordered inputs for related targets, " +
  "or continue without another read if current context is sufficient.";
const SUB_AGENT_DELEGATED_REPEAT_BLOCK =
  "Duplicate delegated read suppressed successfully: this exact evidence selection was already materialized and synthesized by the completed citation child. " +
  "Use the returned cited packet as the inspection result and synthesize now. " +
  "Do not retry this selection through another evidence tool. A successful write to the target still permits post-edit verification.";
const SUB_AGENT_REDUNDANT_DISPATCH_BLOCK =
  "Every requested sub-agent evidence selection is already present in the parent context from successful evidence calls. " +
  "Do not dispatch a child to reread completed parent work; make the decision or mutation directly.";

const SUB_AGENT_EVIDENCE_TOOLS = new Set([
  "tools.read_file",
  "tools.search_files",
  "tools.chain_read",
  "atlas.code.window",
  "atlas.code.survey",
  "atlas.code.structure",
]);
const SUB_AGENT_WRITE_TOOLS = new Set([
  "tools.write_file",
  "tools.edit_file",
  "tools.apply_patch",
  "atlas.edit.apply",
]);

function createSubAgentRoutingState() {
  return {
    evidenceCalls: 0,
    targets: new Set(),
    selections: new Map(),
    delegatedTargets: new Set(),
    delegatedSelections: new Map(),
    dispatched: false,
    reminderIssued: false,
    materializedChars: 0,
    mutated: false,
  };
}

function subAgentRoutingEnabled(policy) {
  return policy?.suites?.tools?.has("sub_agent") === true;
}

function subAgentIdentityOptions(context = null) {
  return {
    materializeRef: context && typeof context === "object"
      ? (ref) => materializeAgentHandoffEvidenceSelector(ref, context)
      : null,
  };
}

function subAgentRoutingContext(session) {
  const boot = session?.bootConfig || {};
  return {
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    agent_call_id: boot.agentCallId ?? null,
  };
}

function subAgentRoutingIdentities(requested, args = {}, result = null, context = null) {
  if (requested?.suite === "tools" && requested?.name === "sub_agent") {
    return subAgentDispatchIdentities(args, subAgentIdentityOptions(context));
  }
  return subAgentEvidenceCallIdentities(requested, args, result);
}

function replaceDelegatedTargetSummary(state) {
  state.delegatedTargets.clear();
  for (const targets of state.delegatedSelections.values()) {
    for (const target of targets) state.delegatedTargets.add(target);
  }
}

function subAgentRoutingBlockReason(state, requested, args = {}, context = null) {
  if (!state) return "";
  const identities = subAgentRoutingIdentities(requested, args, null, context);
  if (
    requested?.suite === "tools"
    && requested?.name === "sub_agent"
    && args?.op === "dispatch"
    && identities.selectionKeys.size > 0
    && [...identities.selectionKeys].every((selection) => state.selections.has(selection))
  ) {
    return "redundant_dispatch";
  }
  if (!SUB_AGENT_EVIDENCE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) return "";
  if (state.dispatched
    && [...identities.selectionKeys].some((selection) => state.delegatedSelections.has(selection))) {
    return "delegated_repeat";
  }
  if (state.mutated) return "";
  if (state.dispatched) return "";
  return state.evidenceCalls >= SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS
    && state.materializedChars >= SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS
    && state.targets.size >= SUB_AGENT_ROUTING_MIN_TARGETS
    ? "required"
    : "";
}

function subAgentMaterializedChars(result) {
  const content = result?.result?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => (
    total + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0)
  ), 0);
}

function noteSubAgentRoutingSuccess(state, requested, args = {}, result = null, context = null) {
  if (!state) return "";
  if (requested?.suite === "tools" && requested?.name === "sub_agent") {
    state.dispatched = true;
    const completedWaitAll = args?.op === "dispatch"
      && args?.completion?.mode === "wait_all"
      && Array.isArray(result?.results)
      && result.results.length > 0
      && result.results.every((entry) => (
        entry?.status === "completed"
        && ["complete", "partial"].includes(entry?.packet?.outcome)
    ));
    if (completedWaitAll) {
      const identities = subAgentRoutingIdentities(requested, args, result, context);
      for (const selection of identities.selectionKeys) {
        state.delegatedSelections.set(
          selection,
          new Set(identities.selectionTargets?.get(selection) || []),
        );
      }
      replaceDelegatedTargetSummary(state);
    }
    return "";
  }
  if (SUB_AGENT_WRITE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) {
    state.mutated = true;
    const mutatedTargets = subAgentMutationTargetKeys(args);
    for (const [selection, targets] of state.delegatedSelections) {
      if ([...targets].some((target) => mutatedTargets.has(target))) {
        state.delegatedSelections.delete(selection);
      }
    }
    replaceDelegatedTargetSummary(state);
    return "";
  }
  if (!SUB_AGENT_EVIDENCE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) return "";
  if (result?.result
    && classifyDelegatedToolResult(result.result).outcome !== SUB_AGENT_EVIDENCE_OUTCOMES.DELIVERED) {
    return "";
  }
  const identities = subAgentRoutingIdentities(requested, args, result, context);
  state.evidenceCalls += 1;
  state.materializedChars += subAgentMaterializedChars(result);
  for (const target of identities.targetKeys) state.targets.add(target);
  for (const selection of identities.selectionKeys) {
    state.selections.set(selection, new Set(identities.selectionTargets?.get(selection) || []));
  }
  if (
    !state.mutated
    && !state.dispatched
    && !state.reminderIssued
    && state.evidenceCalls >= SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS
    && state.materializedChars >= SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS
    && state.targets.size >= SUB_AGENT_ROUTING_MIN_TARGETS
  ) {
    state.reminderIssued = true;
    return SUB_AGENT_ROUTING_REMINDER;
  }
  return "";
}

function subAgentObservationResults(results) {
  return Array.isArray(results) ? results.map((entry) => ({
    id: entry?.id || null,
    status: entry?.status || null,
    outcome: entry?.packet?.outcome || null,
    error_code: entry?.error?.code || null,
    coverage: entry?.coverage ? {
      authorized: entry.coverage.authorized ?? null,
      consumed: entry.coverage.consumed ?? null,
      selected: entry.coverage.selected ?? null,
      unconsumed: entry.coverage.unconsumed ?? null,
      stopped_early: entry.coverage.stopped_early === true,
    } : null,
  })) : [];
}

export function __testSubAgentObservationResults(results) {
  return subAgentObservationResults(results);
}

function subAgentInputObservationDetails(result) {
  const entries = result?.op === "next_input_batch" && Array.isArray(result.results)
    ? result.results
    : result ? [result] : [];
  const inputIds = entries.map((entry) => entry?.input?.id).filter(Boolean).slice(0, 3);
  const errorCodes = [...new Set(entries.map((entry) => entry?.error?.code).filter(Boolean))].slice(0, 3);
  return {
    input_id: entries.length === 1 ? inputIds[0] || null : null,
    input_ids: inputIds,
    result_count: entries.length,
    succeeded_count: entries.filter((entry) => entry?.ok === true).length,
    failed_count: entries.filter((entry) => entry?.ok !== true).length,
    error_codes: errorCodes,
    evidence_chars: entries.reduce((total, entry) => total + (entry?.evidence?.lines || [])
      .reduce((sum, line) => sum + String(line?.text || "").length, 0), 0),
    evidence_lines: entries.reduce((total, entry) => total + (entry?.evidence?.lines?.length || 0), 0),
  };
}

export function __testSubAgentInputObservationDetails(result) {
  return subAgentInputObservationDetails(result);
}

function subAgentRoutingGuardResult(reason) {
  const delegatedRepeat = reason === "delegated_repeat";
  const redundantDispatch = reason === "redundant_dispatch";
  return {
    content: [{
      type: "text",
      text: delegatedRepeat
        ? SUB_AGENT_DELEGATED_REPEAT_BLOCK
        : redundantDispatch
          ? SUB_AGENT_REDUNDANT_DISPATCH_BLOCK
          : SUB_AGENT_ROUTING_BLOCK,
    }],
    // A delegated repeat is a successful deduplication, not an execution
    // failure. Marking it as an error makes providers troubleshoot the guard
    // by retrying the same target through alternate read tools.
    isError: !delegatedRepeat,
  };
}

export function __testSubAgentRoutingGuardResult(reason) {
  return subAgentRoutingGuardResult(reason);
}

function appendToolResultText(response, suffix, { kind = "runtime_control", trigger = null } = {}) {
  if (!suffix || !response || response?.result?.isError === true) return response;
  const result = appendOwnerModelControlNotice(response.result, suffix, { kind, trigger });
  return result === response.result ? response : { ...response, result };
}

export function __testSubAgentRoutingSequence(calls = []) {
  const state = createSubAgentRoutingState();
  return calls.map((call) => {
    const requested = {
      suite: String(call?.suite || ""),
      name: String(call?.name || ""),
    };
    const delegatedEvidence = call?.delegatedEvidence === true;
    const blockReason = delegatedEvidence
      ? ""
      : subAgentRoutingBlockReason(state, requested, call?.args || {});
    const blocked = !!blockReason;
    const reminder = blocked || delegatedEvidence
      ? ""
      : noteSubAgentRoutingSuccess(state, requested, call?.args || {}, call?.result || null);
    return {
      blocked,
      reminder: !!reminder,
      evidenceCalls: state.evidenceCalls,
      targets: state.targets.size,
      delegatedTargets: state.delegatedTargets.size,
      dispatched: state.dispatched,
    };
  });
}

export function __testSubAgentRoutingEnabled(toolNames = []) {
  return subAgentRoutingEnabled({
    suites: { tools: new Set(toolNames.map((name) => String(name))) },
  });
}
const TOKEN_CLOCK_SKEW_MS = 30 * 1000;
const SESSION_ORPHAN_TTL_MS = 8 * 60 * 60 * 1000;
const ATLAS_TOOL_ACTION_SET = /** @type {Set<string>} */ (new Set(ATLAS_TOOL_ACTIONS));
const ATLAS_NESTED_ACTION_WRAPPERS = new Set(["query", "code", "repo", "agent", "workflow"]);
const ATLAS_RESEARCHER_WORKFLOW_ACTIONS = new Set(researcherWorkflowActions());

// Research admission/classification must see the REAL action: gateway wrappers
// (atlas_query/atlas_code/atlas_repo/...) carry it nested in args.action, and
// classifying by the wrapper name would serialize concurrent-eligible reads
// and let a wrapped fetch.ref bypass the citation gate.
function effectiveAtlasResearchAction(requested) {
  if (!requested || requested.suite !== "atlas") return requested?.name || "";
  return ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name) && requested.nested
    ? requested.nested
    : requested.name;
}

function researchBudgetKey(boot = {}) {
  return [boot.jobId ?? "no-job", boot.attemptId ?? "no-attempt"].join(":");
}

// One-shot notice progress per job/attempt. Owner-assigned exploration steps
// can skip numbers (native/chain exploration recorded between owner calls also
// advances the durable count), so equality triggers can silently skip the
// midpoint/final-window warnings; threshold-crossing flags cannot. In-memory only:
// an owner restart re-emits at most one already-shown notice.
const RESEARCH_NOTICE_FLAG_LIMIT = 2000;
const researchNoticeFlagState = new Map();
function researchNoticeFlagsFor(session) {
  const key = researchBudgetKey(session?.bootConfig || {});
  let flags = researchNoticeFlagState.get(key);
  if (!flags) {
    flags = {
      midpoint: false,
      curtain: false,
      extension: false,
      earlyFetchBatching: false,
    };
    researchNoticeFlagState.set(key, flags);
    while (researchNoticeFlagState.size > RESEARCH_NOTICE_FLAG_LIMIT) {
      researchNoticeFlagState.delete(researchNoticeFlagState.keys().next().value);
    }
  }
  return flags;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeIdPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

// Unix domain socket paths are capped at ~108 bytes (sockaddr_un.sun_path). A
// long TMPDIR (some systemd/CI/sandbox setups) can push the default path past
// that and make listen() fail with ENAMETOOLONG. Keep the bound path short.
const UNIX_SOCKET_PATH_MAX = 100;

function shortenUnixSocketPath(candidate, suffix) {
  if (Buffer.byteLength(candidate) <= UNIX_SOCKET_PATH_MAX) return candidate;
  const shortId = crypto.createHash("sha1").update(String(suffix)).digest("hex").slice(0, 16);
  // POSIX-only path (this branch never runs on win32); keep forward slashes
  // regardless of the host so the bound socket path is deterministic.
  for (const base of ["/tmp", "/var/tmp"]) {
    const short = path.posix.join(base, `posse-mcp-${shortId}.sock`);
    if (Buffer.byteLength(short) <= UNIX_SOCKET_PATH_MAX) return short;
  }
  return candidate; // best effort; listen() will surface any residual error
}

export function __testShortenUnixSocketPath(candidate, suffix) {
  return shortenUnixSocketPath(candidate, suffix);
}

function defaultPipePath(bootId) {
  const suffix = `${process.pid}-${safeIdPart(bootId)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\posse-mcp-owner-${suffix}`;
  return shortenUnixSocketPath(path.join(os.tmpdir(), `posse-mcp-owner-${suffix}.sock`), suffix);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_OWNER_BODY_BYTES) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function bearerFrom(req) {
  const raw = String(req?.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : "";
}

function tokenEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}

function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function ownerErrorSummary(err) {
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

function isPowershellClixmlProgressNoise(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  return /#<\s*CLIXML/i.test(text) && /Preparing modules for first use/i.test(text);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function stripGatewaySessionTokenFields(value = {}) {
  const out = cloneJson(value);
  delete out.mcpOAuthToken;
  delete out.mcpOauthToken;
  if (out.mcpAuth && typeof out.mcpAuth === "object") {
    delete out.mcpAuth.accessToken;
    delete out.mcpAuth.token;
  }
  return out;
}

function stripToolsPrefix(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("tools.")) return raw.slice("tools.".length);
  if (raw.startsWith("tools_")) return raw.slice("tools_".length);
  return raw;
}

function stripAtlasPrefix(name) {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

function normalizeAtlasActionName(name) {
  const raw = String(name || "").trim();
  const stripped = raw.startsWith("atlas.")
    ? raw.slice("atlas.".length).trim()
    : (raw.startsWith("atlas_") ? raw.slice("atlas_".length).trim() : raw);
  if (ATLAS_TOOL_ACTION_SET.has(stripped)) return stripped;
  const dotted = stripped.replace(/^atlas_/, "").replace(/_/g, ".").trim();
  if (ATLAS_TOOL_ACTION_SET.has(dotted)) return dotted;
  const lowered = dotted.toLowerCase();
  for (const action of ATLAS_TOOL_ACTION_SET) {
    if (String(action).toLowerCase() === lowered) return action;
  }
  return stripped;
}

function nestedAtlasAction(args = {}) {
  return normalizeAtlasActionName(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  );
}

function requestedToolPolicyName(name, args = {}) {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) {
    const action = normalizeAtlasActionName(raw);
    return {
      suite: "atlas",
      name: action,
      nested: nestedAtlasAction(args),
    };
  }
  return {
    suite: "tools",
    name: stripToolsPrefix(raw),
    nested: "",
  };
}

export function __testAssessorFallbackReadKey(name, args = {}) {
  return assessorFallbackReadKey(requestedToolPolicyName(name, args));
}

function suiteToolAllowlistPolicy(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist && typeof bootConfig.toolAllowlist === "object" && !Array.isArray(bootConfig.toolAllowlist)
    ? bootConfig.toolAllowlist
    : null;
  const suites = {};
  if (source) {
    for (const [suite, names] of Object.entries(source)) {
      const suiteName = String(suite || "").trim().toLowerCase();
      if (!suiteName || !Array.isArray(names)) continue;
      suites[suiteName] = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    }
  }
  const atlasResearcherWorkflow = String(bootConfig?.role || "").trim().toLowerCase() === "researcher"
    && String(bootConfig?.providerName || "").trim().toLowerCase() === "codex"
    && resolveAtlasResearcherWorkflow();
  const atlasResearcherTypedDispatcher = String(bootConfig?.role || "").trim().toLowerCase() === "researcher"
    && String(bootConfig?.providerName || "").trim().toLowerCase() === "codex"
    && resolveAtlasResearcherTypedDispatcher();
  return {
    suites,
    source: source ? "token-allowlist" : "missing-token-allowlist",
    atlasResearcherDispatcher: String(bootConfig?.role || "").trim().toLowerCase() === "researcher"
      && String(bootConfig?.providerName || "").trim().toLowerCase() === "codex"
      && (resolveAtlasResearcherDispatcher() || atlasResearcherTypedDispatcher || atlasResearcherWorkflow),
    atlasResearcherTypedDispatcher,
    atlasResearcherWorkflow,
  };
}

function hasSuiteToolAllowlist(bootConfig = {}) {
  const source = bootConfig?.toolAllowlist;
  return !!(source && typeof source === "object" && !Array.isArray(source));
}

function sessionToolPolicy(session) {
  return suiteToolAllowlistPolicy(session?.bootConfig || {});
}

function toolAllowedByPolicy(policy, toolName, args = {}) {
  const requested = requestedToolPolicyName(toolName, args);
  const allowed = policy?.suites?.[requested.suite] || new Set();
  if (requested.suite === "atlas") {
    if (!requested.name || isInternalAtlasAction(requested.name)) return false;
    if (policy?.atlasResearcherDispatcher === true && requested.name === "query") {
      if (!requested.nested) {
        return [...allowed].some((action) => action && !isInternalAtlasAction(action));
      }
      if (requested.nested === "workflow") {
        const normalized = normalizeResearcherWorkflowFacadeArgs(args);
        if (!normalized.ok) return false;
        const steps = normalized.args.steps;
        return policy?.atlasResearcherWorkflow === true
          && steps.length >= 2
          && steps.length <= researcherWorkflowMaxSteps()
          && steps.every((step) => {
            if (!step || typeof step !== "object" || Array.isArray(step)) return false;
            const action = normalizeAtlasActionName(step.action);
            return ATLAS_RESEARCHER_WORKFLOW_ACTIONS.has(action)
              && !isInternalAtlasAction(action)
              && allowed.has(action);
          });
      }
      return !isInternalAtlasAction(requested.nested) && allowed.has(requested.nested);
    }
    if (!allowed.has(requested.name)) return false;
    if (ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name) && requested.nested) {
      return !isInternalAtlasAction(requested.nested) && allowed.has(requested.nested);
    }
    return true;
  }
  return !!requested.name && allowed.has(requested.name);
}

const ATLAS_SYMBOL_HANDLE_PATTERN = /^s[1-9][0-9]{0,5}$/;
const ATLAS_CANONICAL_SYMBOL_ID_PATTERN = /^[0-9a-f]{64}:[0-9]+$/;

function atlasSymbolHandleState(session) {
  if (!session?._atlasSymbolHandles) {
    session._atlasSymbolHandles = {
      next: 1,
      byHandle: new Map(),
      bySymbolId: new Map(),
    };
  }
  return session._atlasSymbolHandles;
}

function atlasSymbolHandleForId(session, symbolId) {
  if (!session || !ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(String(symbolId || ""))) return null;
  const state = atlasSymbolHandleState(session);
  const prior = state.bySymbolId.get(symbolId);
  if (prior) return prior;
  if (state.next > 999999) return null;
  const handle = `s${state.next}`;
  state.next += 1;
  state.byHandle.set(handle, symbolId);
  state.bySymbolId.set(symbolId, handle);
  return handle;
}

function resolveAtlasSymbolHandle(session, value) {
  const symbolId = String(value || "");
  if (!ATLAS_SYMBOL_HANDLE_PATTERN.test(symbolId)) return { ok: true, value };
  const resolved = session?._atlasSymbolHandles?.byHandle?.get(symbolId) || null;
  return resolved
    ? { ok: true, value: resolved }
    : { ok: false, handle: symbolId };
}

function appendResearcherSymbolHandles(result, session) {
  if (sessionToolPolicy(session)?.atlasResearcherTypedDispatcher !== true || result?.isError === true) {
    return result;
  }
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  let issued = 0;
  const text = first.text.replace(
    /("symbolId"\s*:\s*")([0-9a-f]{64}:[0-9]+)(")/g,
    (match, prefix, symbolId, suffix) => {
      const handle = atlasSymbolHandleForId(session, symbolId);
      if (!handle) return match;
      issued += 1;
      return `${prefix}${symbolId}${suffix},"symbolHandle":"${handle}"`;
    },
  );
  if (issued === 0 || text === first.text) return result;
  return annotateOwnerResultTransform({
    ...result,
    content: [{ ...first, text }, ...result.content.slice(1)],
  }, {
    kind: "atlas_symbol_handles",
    issued,
    scope: "job_bound_agent_session",
    before_chars: first.text.length,
    after_chars: text.length,
  });
}

function compactResearcherTypedAtlasResult(result, session, toolName, toolArgs = {}) {
  if (
    sessionToolPolicy(session)?.atlasResearcherTypedDispatcher !== true
    || researcherTypedLanguageLeversForSession(session).resultCompaction !== true
    || result?.isError === true
  ) {
    return result;
  }
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const compacted = compactResearcherTypedAtlasText(first.text, {
    action: requested.suite === "atlas" ? requested.name : null,
  });
  if (!compacted) return result;
  return annotateOwnerResultTransform({
    ...result,
    content: [{ ...first, text: compacted.text }, ...result.content.slice(1)],
  }, {
    kind: "atlas_typed_result_compaction",
    action: requested.name || toolName,
    removed_canonical_symbol_ids: compacted.removedCanonicalSymbolIds,
    removed_digest_fields: compacted.removedDigestFields,
    removed_default_fields: compacted.removedDefaultFields,
    before_chars: first.text.length,
    after_chars: compacted.text.length,
  });
}

const TYPED_FLAT_WINDOW_FIELDS = new Set([
  "file",
  "granularity",
  "identifiersToFind",
  "maxTokens",
  "symbolId",
]);

function normalizeResearcherTypedDispatcherEnvelope(policy, toolName, toolArgs = {}) {
  if (policy?.atlasResearcherTypedDispatcher !== true) {
    return { toolArgs, transforms: [] };
  }
  const requested = requestedToolPolicyName(toolName, toolArgs);
  if (
    requested.suite !== "atlas"
    || requested.name !== "query"
    || requested.nested
    || !toolArgs
    || typeof toolArgs !== "object"
    || Array.isArray(toolArgs)
    || Object.prototype.hasOwnProperty.call(toolArgs, "action")
    || Object.prototype.hasOwnProperty.call(toolArgs, "args")
  ) {
    return { toolArgs, transforms: [] };
  }
  if (Object.keys(toolArgs).some((field) => !TYPED_FLAT_WINDOW_FIELDS.has(field))) {
    return { toolArgs, transforms: [] };
  }
  const flatArgs = /** @type {Record<string, any>} */ (toolArgs);
  const hasSymbol = typeof flatArgs.symbolId === "string" && flatArgs.symbolId.trim() !== "";
  const hasAnchoredFile = typeof flatArgs.file === "string"
    && flatArgs.file.trim() !== ""
    && Array.isArray(flatArgs.identifiersToFind)
    && flatArgs.identifiersToFind.length > 0;
  if (hasSymbol === hasAnchoredFile) return { toolArgs, transforms: [] };
  return {
    toolArgs: { action: "code.window", args: { ...toolArgs } },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "infer_unambiguous_flat_action",
      inferred_action: "code.window",
    }],
  };
}

function normalizeTypedWindowSymbolRef(action, supplied = {}) {
  if (
    action !== "code.window"
    || supplied.symbolId != null
    || supplied.file != null
    || !supplied.symbolRef
    || typeof supplied.symbolRef !== "object"
    || Array.isArray(supplied.symbolRef)
  ) {
    return { supplied, transforms: [] };
  }
  const symbolRef = supplied.symbolRef;
  const fields = Object.keys(symbolRef);
  if (
    fields.some((field) => !["file", "kind", "name"].includes(field))
    || typeof symbolRef.file !== "string"
    || symbolRef.file.trim() === ""
    || typeof symbolRef.name !== "string"
    || symbolRef.name.trim() === ""
    || (symbolRef.kind != null && (typeof symbolRef.kind !== "string" || symbolRef.kind.trim() === ""))
  ) {
    return { supplied, transforms: [] };
  }
  const { symbolRef: _symbolRef, ...rest } = supplied;
  return {
    supplied: {
      ...rest,
      file: symbolRef.file,
      identifiersToFind: [symbolRef.name],
    },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "window_symbol_ref_to_file_anchor",
      symbol_name: symbolRef.name,
      symbol_kind: symbolRef.kind || null,
    }],
  };
}

function normalizeTypedFileWindowOrientation(action, supplied = {}) {
  if (
    action !== "code.window"
    || typeof supplied.file !== "string"
    || supplied.file.trim() === ""
    || supplied.granularity !== "fileWindow"
    || supplied.symbolId != null
    || (Array.isArray(supplied.identifiersToFind) && supplied.identifiersToFind.length > 0)
    || Object.keys(supplied).some((field) => ![
      "file",
      "granularity",
      "identifiersToFind",
      "maxTokens",
    ].includes(field))
  ) {
    return { action, supplied, transforms: [] };
  }
  return {
    action: "code.skeleton",
    supplied: {
      file: supplied.file,
      ...(supplied.maxTokens == null ? {} : { maxTokens: supplied.maxTokens }),
    },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "window_file_only_to_skeleton_orientation",
    }],
  };
}

function researcherTypedLanguageLeversForSession(session) {
  const cwd = String(session?.bootConfig?.cwd || "").trim();
  if (!cwd) return researcherTypedLanguageLeversForRootEntries([]);
  try {
    return researcherTypedLanguageLeversForRootEntries(fs.readdirSync(cwd));
  } catch {
    return researcherTypedLanguageLeversForRootEntries([]);
  }
}

function normalizeTypedAnchoredFileWindowBudget(session, action, supplied = {}) {
  const maxTokens = researcherTypedLanguageLeversForSession(session).anchoredFileWindowMaxTokens;
  const requestedMaxTokens = Number(supplied.maxTokens);
  if (
    action !== "code.window"
    || !Number.isInteger(maxTokens)
    || maxTokens <= 0
    || typeof supplied.file !== "string"
    || supplied.file.trim() === ""
    || supplied.symbolId != null
    || !Array.isArray(supplied.identifiersToFind)
    || supplied.identifiersToFind.length === 0
    || (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0 && requestedMaxTokens <= maxTokens)
  ) {
    return { supplied, transforms: [] };
  }
  return {
    supplied: { ...supplied, maxTokens },
    transforms: [{
      kind: "atlas_typed_call_shape",
      shape: "bound_anchored_file_window",
      requested_max_tokens: Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? requestedMaxTokens
        : null,
      effective_max_tokens: maxTokens,
    }],
  };
}

function promotedTraversalRefsFor(session) {
  if (!session) return new Set();
  if (!(session?._atlasPromotedTraversalRefs instanceof Set)) {
    session._atlasPromotedTraversalRefs = new Set();
  }
  return session._atlasPromotedTraversalRefs;
}

function noteResearcherTypedTraversalPromotion(session, toolName, toolArgs = {}, result = null) {
  if (
    sessionToolPolicy(session)?.atlasResearcherTypedDispatcher !== true
    || requestedToolPolicyName(toolName, toolArgs).name !== "traverse_ref"
    || result?.isError === true
    || typeof toolArgs.traversal_ref !== "string"
  ) return;
  const rendered = firstStructuredJsonValue(result?.content?.[0]?.text || "").value;
  if (rendered?.ok !== true || rendered?.evidence_ref?.ref !== toolArgs.traversal_ref) return;
  const refs = promotedTraversalRefsFor(session);
  refs.add(toolArgs.traversal_ref);
  while (refs.size > 512) refs.delete(refs.values().next().value);
}

function normalizePromotedTraversalAlias(session, action, supplied = {}) {
  const ref = typeof supplied.traversal_ref === "string"
    ? supplied.traversal_ref.trim()
    : "";
  const hasAlternateSelector = Number(supplied.offset || 0) > 0
    || (typeof supplied.search === "string" && supplied.search !== "");
  if (
    action !== "traverse_ref"
    || !ref
    || !hasAlternateSelector
    || !promotedTraversalRefsFor(session).has(ref)
    || supplied.reaccessAuthorization != null
  ) {
    return { supplied, transforms: [] };
  }
  const context = hashRefToolContext(session);
  const evidence = fetchHashRefEvidenceForContext(context, ref);
  if (!evidence?.found || !evidence.source || !evidence.capability) {
    return { supplied, transforms: [] };
  }
  const selector = typeof supplied.search === "string" && supplied.search !== ""
    ? {
      mode: "search",
      search: supplied.search,
      search_mode: supplied.search_mode || "auto",
      offset: Math.max(0, Number(supplied.offset) || 0),
      ...(supplied.limit != null ? { limit: Number(supplied.limit) } : {}),
    }
    : {
      mode: "offset",
      offset: Math.max(0, Number(supplied.offset) || 0),
      ...(supplied.limit != null ? { limit: Number(supplied.limit) } : {}),
    };
  const traversalRequest = {
    sourceRef: evidence.source.ref,
    selector,
    sourceContentHash: evidence.source.content_hash || null,
  };
  const issued = issueHashRefTraversalForContext(context, traversalRequest);
  if (!issued?.ok || !issued.capability?.ref) return { supplied, transforms: [] };
  return {
    supplied: { ...supplied, traversal_ref: issued.capability.ref },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "promoted_traversal_alias_to_authorized_slice",
      selector_mode: selector.mode,
      selector_offset: selector.offset,
    }],
  };
}

function routeResearcherDispatcherCall(policy, toolName, toolArgs = {}, session = null) {
  const envelope = normalizeResearcherTypedDispatcherEnvelope(policy, toolName, toolArgs);
  toolArgs = envelope.toolArgs;
  const transforms = [...envelope.transforms];
  const requested = requestedToolPolicyName(toolName, toolArgs);
  if (
    policy?.atlasResearcherDispatcher !== true
    || requested.suite !== "atlas"
    || requested.name !== "query"
    || !requested.nested
  ) {
    return { toolName, toolArgs, transforms };
  }
  if (requested.nested === "workflow") {
    const normalized = normalizeResearcherWorkflowFacadeArgs(toolArgs);
    return {
      toolName: "atlas.workflow",
      toolArgs: normalized.ok ? normalized.args : {},
      transforms,
    };
  }
  let supplied = toolArgs?.args && typeof toolArgs.args === "object" && !Array.isArray(toolArgs.args)
    ? toolArgs.args
    : {};
  const symbolRefCleanup = normalizeTypedWindowSymbolRef(requested.nested, supplied);
  supplied = symbolRefCleanup.supplied;
  transforms.push(...symbolRefCleanup.transforms);
  const fileWindowCleanup = normalizeTypedFileWindowOrientation(requested.nested, supplied);
  const routedAction = fileWindowCleanup.action;
  supplied = fileWindowCleanup.supplied;
  transforms.push(...fileWindowCleanup.transforms);
  const anchoredWindowBudget = normalizeTypedAnchoredFileWindowBudget(
    session,
    routedAction,
    supplied,
  );
  supplied = anchoredWindowBudget.supplied;
  transforms.push(...anchoredWindowBudget.transforms);
  const traversalCleanup = normalizePromotedTraversalAlias(session, routedAction, supplied);
  supplied = traversalCleanup.supplied;
  transforms.push(...traversalCleanup.transforms);
  const schema = atlasDescriptorSchemaForAction(routedAction);
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const routedArgs = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    // expectedLines is optional retrieval telemetry rather than a selector.
    // Omitting it avoids rejecting qualitative provider guesses while leaving
    // the source selection and canonical action validation unchanged.
    if (routedAction === "code.window" && key === "expectedLines") continue;
    if (key === "symbolId") {
      const resolved = resolveAtlasSymbolHandle(session, value);
      if (!resolved.ok) {
        return {
          toolName: `atlas.${routedAction}`,
          toolArgs: supplied,
          routingError: `Unknown Atlas symbolHandle ${resolved.handle}; reuse only a handle returned in this job-bound agent session`,
          transforms,
        };
      }
      routedArgs[key] = resolved.value;
    } else if (key === "symbolIds" && Array.isArray(value)) {
      const resolved = value.map((entry) => resolveAtlasSymbolHandle(session, entry));
      const unknown = resolved.find((entry) => !entry.ok);
      if (unknown) {
        return {
          toolName: `atlas.${routedAction}`,
          toolArgs: supplied,
          routingError: `Unknown Atlas symbolHandle ${unknown.handle}; reuse only a handle returned in this job-bound agent session`,
          transforms,
        };
      }
      routedArgs[key] = resolved.map((entry) => entry.value);
    } else {
      routedArgs[key] = value;
    }
  }
  if (
    policy?.atlasResearcherTypedDispatcher === true
    && routedAction === "code.window"
    && routedArgs.reason == null
  ) {
    // The typed facade itself proves that this is a researcher-owned exact
    // source read. Avoid billing the provider for restating that invariant on
    // every scalar window while retaining the canonical native contract.
    routedArgs.reason = "typed researcher exact-source read";
  }
  return {
    toolName: `atlas.${routedAction}`,
    toolArgs: routedArgs,
    transforms,
  };
}

function firstStructuredJsonValue(text = "") {
  const source = String(text || "");
  const start = source.search(/[\[{]/u);
  if (start < 0) return { value: null, remainder: source.trim() };
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        return {
          value: JSON.parse(source.slice(start, index + 1)),
          remainder: `${source.slice(0, start)}${source.slice(index + 1)}`.trim(),
        };
      } catch {
        return { value: null, remainder: source.trim() };
      }
    }
  }
  return { value: null, remainder: source.trim() };
}

function researcherWorkflowStepOutput(result = null) {
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").filter(Boolean).join("\n")
    : "";
  const parsed = firstStructuredJsonValue(text);
  return {
    value: parsed.value ?? (text ? { text } : null),
    ...(parsed.remainder ? { remainder: parsed.remainder } : {}),
  };
}

function researcherWorkflowInputProblem(toolArgs = {}) {
  const allowedKeys = new Set(["steps", "onError"]);
  const unknownKey = Object.keys(toolArgs || {}).find((key) => !allowedKeys.has(key));
  if (unknownKey) return `workflow field is not allowed: ${unknownKey}`;
  if (toolArgs.onError != null && toolArgs.onError !== "stop") return "workflow onError must be stop";
  const steps = Array.isArray(toolArgs.steps) ? toolArgs.steps : [];
  if (steps.length < 2 || steps.length > researcherWorkflowMaxSteps()) {
    return `workflow requires 2-${researcherWorkflowMaxSteps()} steps`;
  }
  const ids = new Set();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== "object" || Array.isArray(step)) return `workflow step ${index} must be an object`;
    const stepKeys = new Set(["id", "action", "args", "maxResponseTokens"]);
    const unknownStepKey = Object.keys(step).find((key) => !stepKeys.has(key));
    if (unknownStepKey) return `workflow step ${index} field is not allowed: ${unknownStepKey}`;
    if (step.maxResponseTokens != null) return `workflow step ${index} maxResponseTokens is not supported by the owner-routed facade`;
    const action = normalizeAtlasActionName(step.action);
    if (!ATLAS_RESEARCHER_WORKFLOW_ACTIONS.has(action)) return `workflow step ${index} action is not allowed: ${action}`;
    if (!step.args || typeof step.args !== "object" || Array.isArray(step.args)) return `workflow step ${index} args must be an object`;
    if (action === "traverse_ref" && Number(step.args.limit || 0) > 20_000) {
      return `workflow step ${index} traverse_ref limit exceeds 20000`;
    }
    if (step.id != null) {
      const id = String(step.id || "").trim();
      if (!id) return `workflow step ${index} id must be non-empty`;
      if (ids.has(id)) return `workflow step id must be unique: ${id}`;
      ids.add(id);
    }
  }
  return "";
}

function filterToolsListMessage(message, policy) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.filter((tool) => toolAllowedByPolicy(policy, tool?.name)),
    },
  };
}

function toolsListCount(message) {
  const tools = message?.result?.tools;
  return Array.isArray(tools) ? tools.length : null;
}

function toolsListNames(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return [];
  return [...new Set(tools
    .map((tool) => String(tool?.name || "").trim())
    .filter(Boolean))].sort();
}

function toolsListDigest(names = []) {
  if (!Array.isArray(names)) return null;
  return crypto.createHash("sha256").update(names.join("\n"), "utf8").digest("hex");
}

function agentHandoffSchemaTelemetry(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return null;
  const schema = tools.find((tool) => stripToolsPrefix(tool?.name) === "agent_handoff");
  return schema ? toolSchemaTelemetry(schema) : null;
}

function attachTelemetryContext(session, ownerBootId, bootConfig = session?.bootConfig || {}) {
  const boot = bootConfig || {};
  return {
    component: "deterministic_mcp",
    owner_boot_id: ownerBootId || null,
    session_id: session?.id || null,
    provider: boot.providerName || null,
    role: boot.role || null,
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
  };
}

function injectSessionContext(message, session, { delegatedEvidence = false } = {}) {
  const outbound = cloneJson(message);
  const params = outbound.params && typeof outbound.params === "object" && !Array.isArray(outbound.params)
    ? { ...outbound.params }
    : {};
  delete params._posseSession;
  const bootConfig = stripGatewaySessionTokenFields(session.bootConfig || {});
  bootConfig.ownerAtlasGateEvents = session.atlasGateEventsSnapshot();
  bootConfig.ownerGatewayBindingEpoch = Number(session?._gatewayBindingEpoch) || 1;
  if (delegatedEvidence === true) bootConfig.delegatedEvidenceCursor = true;
  params._posseSession = {
    sessionId: session.id,
    bootConfig,
  };
  outbound.params = params;
  return outbound;
}

function gatewaySessionReleaseNotification(session) {
  return injectSessionContext({
    jsonrpc: "2.0",
    method: MCP_SESSION_RELEASED_NOTIFICATION,
    params: {},
  }, session);
}

function gatewayGateBindingKey(bootConfig = {}, sessionId = null) {
  const numericPart = (value) => Number(value) || null;
  return JSON.stringify([
    String(bootConfig?.mcpOAuth?.tokenId || sessionId || "").trim(),
    numericPart(bootConfig?.jobId),
    numericPart(bootConfig?.workItemId),
    numericPart(bootConfig?.attemptId),
    numericPart(bootConfig?.agentCallId),
    String(bootConfig?.role || "").trim(),
    path.resolve(String(bootConfig?.cwd || ".")),
    bootConfig?.atlasAvailable === true,
    bootConfig?.atlasGateEnabled === true,
  ]);
}

function gatewayBindingSnapshot(session) {
  const bootConfig = cloneJson(session?.bootConfig || {});
  return {
    epoch: Number(session?._gatewayBindingEpoch) || null,
    key: gatewayGateBindingKey(bootConfig, session?.id),
    bootConfig,
  };
}

function gatewayBindingIsCurrent(session, binding) {
  if (!binding) return true;
  const currentEpoch = Number(session?._gatewayBindingEpoch) || null;
  if (binding.epoch != null && currentEpoch !== binding.epoch) return false;
  return gatewayGateBindingKey(session?.bootConfig || {}, session?.id) === binding.key;
}

function deniedToolCallMessage(message, toolName, policy) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (id == null) return null;
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: `Tool ${toolName || "(unknown)"} is not allowed for this MCP session (${policy.source} policy).`,
      }],
      isError: true,
    },
  };
}

function mcpToolErrorPayload(message, error = null, { cwd = null } = {}) {
  // Scrub here, not at call sites: the structured/_meta channels re-embed the
  // raw error, so a caller-side scrub of the message alone still leaks.
  const scrub = (value) => (cwd ? sanitizeAbsolutePathsInText(String(value), cwd) : String(value));
  const text = scrub(message || "ATLAS tool execution failed");
  const structured = error && typeof error === "object"
    ? {
        code: error.code ? String(error.code) : "atlas_tool_error",
        message: error.message ? scrub(error.message) : text,
        ...(error.details === undefined ? {} : {
          details: typeof error.details === "string" ? scrub(error.details) : error.details,
        }),
      }
    : null;
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    isError: true,
    ...(structured ? { structuredContent: { error: structured }, _meta: { atlasError: structured } } : {}),
  };
}

function mcpToolTextPayload(text) {
  const value = String(text || "");
  return {
    content: [{ type: "text", text: value }],
    isError: /^Error:/i.test(value),
  };
}

const deliveredTraversalRefsBySession = new WeakMap();

function deliveredTraversalRefs(text, requestedRefs = []) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (Array.isArray(parsed?.refs)) {
      return requestedRefs.filter((_ref, index) => parsed.refs[index]?.ok === true);
    }
    return parsed?.ok === true && requestedRefs[0] ? [requestedRefs[0]] : [];
  } catch {
    return [];
  }
}

function deliveredTraversalRefSet(session) {
  if (!session || typeof session !== "object") return new Set();
  let delivered = deliveredTraversalRefsBySession.get(session);
  if (!delivered) {
    delivered = new Set();
    deliveredTraversalRefsBySession.set(session, delivered);
  }
  return delivered;
}

function fetchRefMcpPayload(text) {
  const value = String(text || "");
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    data = {
      ok: false,
      code: "invalid_fetch_ref_payload",
      error: "fetch_ref returned an invalid result payload",
    };
  }
  if (data?.ok === true) return mcpToolTextPayload(value);

  const code = String(data?.code || "fetch_ref_rejected");
  const message = String(data?.message || data?.error || "fetch_ref was rejected");
  const structured = {
    code,
    message,
    details: {
      status: "rejected",
      retryable: data?.retryable === true,
      ...(data?.classification ? { classification: String(data.classification) } : {}),
    },
  };
  return {
    // Preserve the existing model-visible payload exactly. The failure bit and
    // structured channels make provider/owner accounting truthful.
    content: [{ type: "text", text: value }],
    isError: true,
    structuredContent: { error: structured, data },
    _meta: { atlasError: structured, fetchRefResult: data },
  };
}

function createRefMcpPayload(data = {}) {
  const result = /** @type {{ ok?: boolean, code?: string, error?: string, failed?: number, created?: number, status?: string, count?: number, [key: string]: unknown }} */ (data && typeof data === "object" ? data : {
    ok: false,
    code: "invalid_create_ref_payload",
    error: "create_ref returned an invalid result payload",
  });
  const text = JSON.stringify(result, null, 2);
  if (result.ok === true) return mcpToolTextPayload(text);

  const code = String(result.code || "create_ref_failed");
  const message = String(result.error || "create_ref failed");
  const failed = Math.max(0, Number(result.failed || 0));
  const created = Math.max(0, Number(result.created || 0));
  const status = ["failed", "rejected"].includes(String(result.status || ""))
    ? String(result.status)
    : (code === "create_ref_scope_unavailable" || code === "create_failed" || code === "create_ref_partial"
      ? "failed"
      : "rejected");
  const structured = {
    code,
    message,
    details: {
      status,
      retryable: false,
      ...(Number.isFinite(Number(result.count)) ? { count: Number(result.count) } : {}),
      ...(created > 0 ? { created } : {}),
      ...(failed > 0 ? { failed } : {}),
    },
  };
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { error: structured, data: result },
    _meta: { atlasError: structured, createRefResult: result },
  };
}

// Final pre-transport model-visible size. The downstream Codex client clips
// oversized tool results to roughly this many characters (head/tail with the
// middle discarded) without telling Posse, so anything above the clip is
// recorded here as the closest observable proxy for what the model saw.
const CLIENT_RESULT_CLIP_CHARS = 48000;
function mcpResultTextChars(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") total += part.text.length;
  }
  return total;
}

function isMemoryToolAction(action) {
  return String(action || "").startsWith("memory.");
}

function ownerControlNoticePublicMetadata(notice = {}) {
  return {
    kind: String(notice.kind || "runtime_control"),
    chars: String(notice.text || "").length,
    sha256: crypto.createHash("sha256").update(String(notice.text || ""), "utf8").digest("hex"),
    ...(notice.trigger ? { trigger: String(notice.trigger) } : {}),
    ...(notice.explorationStep != null && Number.isFinite(Number(notice.explorationStep))
      ? { exploration_step: Number(notice.explorationStep) }
      : {}),
  };
}

function appendOwnerModelControlNotice(result, suffix, detail = {}) {
  const content = result?.content;
  if (!Array.isArray(content) || !suffix) return result;
  const textIndex = content.findIndex((part) => part?.type === "text" && typeof part.text === "string");
  if (textIndex < 0) return result;
  const textPart = content[textIndex];
  const notice = {
    kind: detail.kind || "runtime_control",
    text: String(suffix),
    trigger: detail.trigger || null,
    explorationStep: detail.explorationStep ?? null,
  };
  const publicNotice = ownerControlNoticePublicMetadata(notice);
  const priorPublic = Array.isArray(result?._meta?.posseControlNotices)
    ? result._meta.posseControlNotices
    : [];
  const next = {
    ...result,
    content: content.map((part, index) => (
      index === textIndex ? { ...textPart, text: `${textPart.text}${notice.text}` } : part
    )),
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseControlNotices: [...priorPublic, publicNotice],
    },
  };
  Object.defineProperty(next, OWNER_MODEL_CONTROL_NOTICES, {
    value: [...(result?.[OWNER_MODEL_CONTROL_NOTICES] || []), notice],
    enumerable: false,
  });
  return next;
}

function tagOwnerModelControlNotice(result, text, detail = {}) {
  if (!result || !text) return result;
  const notice = {
    kind: detail.kind || "runtime_control",
    text: String(text),
    trigger: detail.trigger || null,
    explorationStep: detail.explorationStep ?? null,
  };
  const priorPublic = Array.isArray(result?._meta?.posseControlNotices)
    ? result._meta.posseControlNotices
    : [];
  const next = {
    ...result,
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseControlNotices: [...priorPublic, ownerControlNoticePublicMetadata(notice)],
    },
  };
  Object.defineProperty(next, OWNER_MODEL_CONTROL_NOTICES, {
    value: [...(result?.[OWNER_MODEL_CONTROL_NOTICES] || []), notice],
    enumerable: false,
  });
  return next;
}

function sourceEvidenceReuseNotice(coverageOwner, admission) {
  const attemptId = Number(coverageOwner?.attemptId) || null;
  const db = coverageOwner?.db;
  const ref = String(admission?.result?.evidence_ref?.ref || admission?.result?.evidenceRef?.ref || "").trim();
  if (!attemptId || !db || !ref) return null;
  const coverageScope = String(admission?.coverageScope || admission?.result?.coverage_scope || "current_attempt");
  if (coverageScope !== "current_attempt") {
    const priorScope = coverageScope === "prior_attempt" ? "an earlier attempt" : "an ancestor job";
    return `EVIDENCE_REACCESS: This source selection was delivered in ${priorScope} as ${ref}, `
      + "so its source text is not visible in the current session. If the exact source is material, call "
      + "atlas.traverse_ref with that ref and reaccessAuthorization set to reaccess.authorization from this "
      + "response. Do not treat ref metadata alone as source content or cite an uninspected claim from it.";
  }

  let issuedAttempts = sourceEvidenceReuseNoticeAttempts.get(db);
  if (!issuedAttempts) {
    issuedAttempts = new Set();
    sourceEvidenceReuseNoticeAttempts.set(db, issuedAttempts);
  }
  if (issuedAttempts.has(attemptId)) return null;

  try {
    const recorded = db.prepare(`
      SELECT 1
      FROM job_observations
      WHERE attempt_id = ?
        AND observation_type = 'tool.response_control'
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.kind') = ?
      LIMIT 1
    `).get(attemptId, SOURCE_EVIDENCE_REUSE_NOTICE_KIND);
    if (recorded) {
      issuedAttempts.add(attemptId);
      return null;
    }
  } catch {
    // Compatibility databases may not expose JSON query helpers. The in-memory
    // guard still keeps the notice one-shot for the live owner.
  }

  // Mark before returning so concurrent covered calls cannot both emit the
  // first-duplicate nudge. The response-control observation below makes the
  // decision durable across owner restarts.
  issuedAttempts.add(attemptId);
  return `EVIDENCE_REUSE: This source selection was already delivered as ${ref}. `
    + "Use that evidence ref directly in reasoning and citations. If a different code fact remains unresolved, "
    + "request only its uncovered symbol, branch, or range and issue independent reads together.";
}

function annotateOwnerResultTransform(result, detail = {}) {
  const prior = Array.isArray(result?._meta?.posseResultTransforms)
    ? result._meta.posseResultTransforms
    : [];
  return {
    ...result,
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseResultTransforms: [...prior, detail],
    },
  };
}

function terminalMemoryToolRejection(action) {
  const result = {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        action: String(action || "memory"),
        status: "rejected",
        code: "memory_tools_disabled_for_run",
        retryable: false,
        message: "Memory tools are optional and are disabled for this agent run after an earlier error. No action was performed. Do not call another memory tool; continue the primary task.",
      }),
    }],
    // This is an admission rejection, not another execution error. Returning a
    // normal MCP result lets provider agents leave their error-recovery loop;
    // the structured text still classifies as rejected in Posse telemetry.
    isError: false,
  };
  return tagOwnerModelControlNotice(result, result.content[0].text, {
    kind: "memory_tool_terminal_rejection",
    trigger: "earlier_memory_tool_error",
  });
}

function appendTerminalMemoryToolNotice(result) {
  const notice = "MEMORY_TOOL_TERMINAL: Memory is optional. Do not retry this call, invent or substitute a memory ID, or call another memory tool to report this error. Continue the assigned task without memory tools.";
  return appendOwnerModelControlNotice(result, `\n\n${notice}`, {
    kind: "memory_tool_terminal",
    trigger: "memory_tool_error",
  });
}

function mcpToolResultMessage(message, result) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (id == null) return null;
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function staleGatewayBindingToolResult(message) {
  return mcpToolResultMessage(message, mcpToolErrorPayload(
    "MCP session binding changed while the ATLAS tool was running; the obsolete result was discarded",
  ));
}

function ownerResearchSynthesisAdmission(session, requestedAction, {
  assignedExplorationStep = null,
  assignedPhysicalCallStep = null,
  explorationUnitWeight = 1,
  symbolFollowupDiscounted = false,
} = {}) {
  const boot = session?.bootConfig || {};
  const citationFetch = RESEARCH_CITATION_FETCH_GATE_ENABLED
    && isResearchAtlasCitationFetchAction(requestedAction);
  const exploration = isResearchAtlasExplorationAction(requestedAction);
  if (String(boot.role || "") !== "researcher" || (!exploration && !citationFetch)) {
    return {
      tracked: false,
      blocked: false,
      explorationSteps: 0,
      callSteps: 0,
      assignedExplorationStep: null,
      fetchBatchesTotal: 0,
      explorationFetchBatches: 0,
      singletonFetchBatches: 0,
      multiFetchBatches: 0,
    };
  }
  const status = researchExplorationObservationStatus({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
  });
  const citationFetches = Math.max(0, Number(status.citation_fetches || 0));
  const citationFetchBatches = Math.max(0, Number(status.citation_fetch_batches || 0));
  const fetchBatchesTotal = Math.max(0, Number(status.fetch_batches_total || 0));
  const explorationFetchBatches = Math.max(0, Number(status.exploration_fetch_batches || 0));
  const singletonFetchBatches = Math.max(0, Number(status.singleton_fetch_batches || 0));
  const multiFetchBatches = Math.max(0, Number(status.multi_fetch_batches || 0));
  const progressDecision = researchSynthesisDecision({
    explorationSteps: status.exploration_steps,
    callSteps: status.call_steps,
    staleSteps: status.stale_steps,
    synthesisRequired: status.synthesis_required,
  });
  if (citationFetch) {
    const synthesisRequired = progressDecision.required;
    return {
      tracked: true,
      blocked: synthesisRequired && citationFetchBatches >= 1,
      blockReason: synthesisRequired && citationFetchBatches >= 1 ? "budget_exhausted" : null,
      citationFetch: true,
      citationFetches,
      citationFetchBatches,
      fetchBatchesTotal,
      explorationFetchBatches,
      singletonFetchBatches,
      multiFetchBatches,
      explorationSteps: Math.max(0, Number(status.exploration_steps || 0)),
      callSteps: Math.max(0, Number(status.call_steps || 0)),
      symbolFollowupsDiscounted: Math.max(0, Number(status.symbol_followups_discounted || 0)),
      staleSteps: Math.max(0, Number(status.stale_steps || 0)),
      lastNovelEvidenceStep: Math.max(0, Number(status.last_novel_evidence_step || 0)),
      assignedExplorationStep: null,
      synthesisRequired,
      synthesisReason: progressDecision.reason,
      researchPhase: synthesisRequired ? "synthesis" : "exploration",
    };
  }
  const observedExplorationSteps = Math.max(0, Number(status.exploration_steps || 0));
  const assignedStep = Number.isSafeInteger(assignedExplorationStep)
    ? assignedExplorationStep
    : observedExplorationSteps + 1;
  const unitWeight = explorationUnitWeight === 0 ? 0 : 1;
  const assignedUnitCeiling = unitWeight > 0 && assignedStep > researchSynthesisExplorationCeiling({
    staleSteps: status.stale_steps,
  });
  const assignedCallStep = Number.isSafeInteger(assignedPhysicalCallStep)
    ? assignedPhysicalCallStep
    : Math.max(0, Number(status.call_steps || 0)) + 1;
  const assignedPhysicalCeiling = assignedCallStep > RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;
  const assignedAbsoluteCeiling = assignedUnitCeiling || assignedPhysicalCeiling;
  return {
    tracked: true,
    blocked: progressDecision.required || assignedAbsoluteCeiling,
    blockReason: progressDecision.reason || (assignedPhysicalCeiling
      ? "physical_call_ceiling"
      : (assignedUnitCeiling ? "exploration_ceiling" : null)),
    citationFetch: false,
    citationFetches,
    citationFetchBatches,
    fetchBatchesTotal,
    explorationFetchBatches,
    singletonFetchBatches,
    multiFetchBatches,
    explorationSteps: unitWeight === 0
      ? observedExplorationSteps
      : Math.max(observedExplorationSteps, assignedStep - 1),
    callSteps: Math.min(
      RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS,
      Math.max(0, Number(status.call_steps || 0), assignedCallStep - 1),
    ),
    symbolFollowupsDiscounted: Math.max(0, Number(status.symbol_followups_discounted || 0)),
    staleSteps: Math.max(0, Number(status.stale_steps || 0)),
    lastNovelEvidenceStep: Math.max(0, Number(status.last_novel_evidence_step || 0)),
    assignedExplorationStep: assignedStep,
    assignedPhysicalCallStep: assignedCallStep,
    explorationUnitWeight: unitWeight,
    symbolFollowupDiscounted: symbolFollowupDiscounted === true,
    synthesisRequired: progressDecision.required || assignedAbsoluteCeiling,
    synthesisReason: progressDecision.reason || (assignedPhysicalCeiling
      ? "physical_call_ceiling"
      : (assignedUnitCeiling ? "exploration_ceiling" : null)),
  };
}

function isTerminalResearchExplorationAdmission(admission) {
  if (
    !admission?.tracked
    || admission.blocked
    || admission.citationFetch
    || !Number.isSafeInteger(admission.assignedExplorationStep)
  ) {
    return false;
  }
  return admission.assignedExplorationStep >= researchSynthesisExplorationCeiling({
    staleSteps: admission.staleSteps,
  }) || admission.assignedPhysicalCallStep >= RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;
}

function surveyAwareSkeletonRedirect(session, requested, toolArgs = {}) {
  const boot = session?.bootConfig || {};
  if (String(boot.role || "") !== "researcher") return null;
  if (effectiveAtlasResearchAction(requested) !== "code.skeleton") return null;
  const file = String(toolArgs.file || "").trim();
  if (!file || String(toolArgs.surveyGap || "").trim()) return null;
  const coverage = researchSurveyCoverageStatus({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
    file,
  });
  if (!coverage) return null;
  const result = mcpToolTextPayload(JSON.stringify({
    action: "code.skeleton",
    status: "redirected",
    code: "structure_already_visible",
    structureAlreadyVisible: true,
    file: coverage.file,
    evidence_ref: evidenceRefSurface(coverage.surveyRef),
    surveyBounded: coverage.surveyTruncated || coverage.fileTruncated,
    message: "The prefetched code.survey already supplied this file's structural outline. Use that survey evidence and request exact unresolved code with code.window.",
    nextAction: {
      action: "code.window",
      // RH-1: `code.window` is scalar-only. Naming `items` here advertised a
      // call form the schema omits and the owner and native executor reject.
      instruction: "Request the exact unresolved identifier or branch; issue independent scalar calls together in one response when several targets are known.",
    },
    escapeHatch: {
      field: "surveyGap",
      instruction: "Retry code.skeleton only when the survey omitted or bounded a named structural fact, and put that fact in surveyGap.",
    },
  }));
  return annotateOwnerResultTransform(result, {
    kind: "survey_aware_skeleton_redirect",
    action: "code.skeleton",
    file: coverage.file,
    survey_ref: coverage.surveyRef,
    survey_bounded: coverage.surveyTruncated || coverage.fileTruncated,
  });
}

function recordSurveyAwareSkeletonRedirect(session, toolName, toolArgs, result) {
  const boot = session?.bootConfig || {};
  const parsed = (() => {
    try { return JSON.parse(result?.content?.[0]?.text || "{}"); } catch { return {}; }
  })();
  recordObservation({
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    observation_type: "atlas.skeleton_after_survey",
    summary: `Redirected redundant code.skeleton for ${String(toolArgs?.file || "surveyed file").slice(0, 180)}`,
    detail: {
      kind: "survey_aware_skeleton_redirect",
      action: "code.skeleton",
      tool: toolName || null,
      file: toolArgs?.file || null,
      survey_ref: parsed?.evidence_ref?.ref || parsed?.surveyRef || null,
      survey_bounded: parsed?.surveyBounded === true,
      redirected: true,
    },
  });
}

function appendOwnerResearchFinalFetchNotice(result, admission) {
  if (result?.isError === true || !admission?.citationFetch || admission.researchPhase !== "synthesis") return result;
  const notice = buildResearchFinalFetchBatchText();
  return appendOwnerModelControlNotice(result, `\n\n${notice}`, {
    kind: "research_final_fetch_batch",
    trigger: "synthesis_fetch_batch_complete",
  });
}

function requestedFetchRefCount(args = {}) {
  const refs = new Set();
  const add = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) refs.add(normalized);
  };
  const addMany = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === "string" && /[\s,;]+/.test(value.trim())) {
      for (const item of value.split(/[\s,;]+/)) add(item);
      return;
    }
    add(value);
  };
  addMany(args.refs);
  addMany(args.hashes);
  if (refs.size === 0) addMany(args.ref ?? args.hash);
  return refs.size;
}

function appendOwnerResearchEarlyFetchNotice(result, session, args, admission) {
  if (result?.isError === true || !admission?.citationFetch || admission.researchPhase !== "exploration") return result;
  const flags = researchNoticeFlagsFor(session);
  const refCount = requestedFetchRefCount(args);
  let next = result;
  if (refCount === 1 && !flags.earlyFetchBatching) {
    flags.earlyFetchBatching = true;
    next = appendOwnerModelControlNotice(next, `\n\n${buildResearchEarlyFetchBatchingText()}`, {
      kind: "research_fetch_batching",
      trigger: "exploration_singleton_fetch",
    });
  }
  return next;
}

function appendOwnerResearcherTypedReadyCallBatchingNotice(result, session) {
  const boot = session?.bootConfig || {};
  if (
    result?.isError === true
    || String(boot.role || "").toLowerCase() !== "researcher"
    || String(boot.providerName || "").toLowerCase() !== "codex"
    || !resolveAtlasResearcherTypedDispatcher()
  ) {
    return result;
  }
  const languageLevers = researcherTypedLanguageLeversForSession(session);
  if (!languageLevers.readyCallBatching) return result;
  const flags = researchNoticeFlagsFor(session);
  if (flags.typedReadyCallBatching) return result;
  flags.typedReadyCallBatching = true;
  return appendOwnerModelControlNotice(
    result,
    `\n\n${buildResearcherTypedReadyCallBatchingText()}`,
    {
      kind: "research_typed_ready_call_batching",
      trigger: `language:${languageLevers.primaryLanguage}`,
    },
  );
}

function recordOwnerResearchSynthesisRequired(session, progress = {}, toolName) {
  const boot = session?.bootConfig || {};
  const current = researchExplorationObservationStatus({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
  });
  if (current.synthesis_required) return;
  const explorationSteps = Math.max(
    0,
    Number(progress.explorationSteps ?? current.exploration_steps) || 0,
  );
  const callSteps = Math.max(0, Number(progress.callSteps ?? current.call_steps) || 0);
  const symbolFollowupsDiscounted = Math.max(
    0,
    Number(progress.symbolFollowupsDiscounted ?? current.symbol_followups_discounted) || 0,
  );
  const staleSteps = Math.max(0, Number(progress.staleSteps ?? current.stale_steps) || 0);
  const lastNovelEvidenceStep = Math.max(
    0,
    Number(progress.lastNovelEvidenceStep ?? current.last_novel_evidence_step) || 0,
  );
  const decision = researchSynthesisDecision({ explorationSteps, callSteps, staleSteps });
  recordObservation({
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    observation_type: "research.synthesis_required",
    summary: `Research synthesis required after ${explorationSteps} exploration units across ${callSteps} calls`,
    detail: {
      kind: "research_synthesis_required",
      exploration_steps: explorationSteps,
      unit_steps: explorationSteps,
      call_steps: callSteps,
      symbol_followups_discounted: symbolFollowupsDiscounted,
      stale_steps: staleSteps,
      min_exploration_steps: RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS,
      stale_exploration_steps: RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS,
      last_novel_evidence_step: lastNovelEvidenceStep,
      relevant_files: null,
      irrelevant_files: null,
      reason: `exploration_steps=${explorationSteps}; stale_steps=${staleSteps}; stop_reason=${progress.synthesisReason || decision.reason || "owner_closeout"}; last_tool=${toolName}; source=mcp_owner`,
    },
  });
}

function appendOwnerResearchSynthesisNotice(result, session, toolName, admission) {
  if (result?.isError === true || !admission?.tracked || admission.citationFetch) return result;
  const explorationSteps = admission.explorationUnitWeight === 0
    ? admission.explorationSteps
    : (admission.assignedExplorationStep ?? admission.explorationSteps + 1);
  const callSteps = admission.assignedPhysicalCallStep
    ?? admission.callSteps + 1;
  const curtainStart = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS;
  const physicalCurtainStart = RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS;
  const flags = researchNoticeFlagsFor(session);
  const explorationCeiling = researchSynthesisExplorationCeiling({
    staleSteps: admission.staleSteps,
  });
  let notice = null;
  let noticeKind = null;
  if (explorationSteps >= explorationCeiling || callSteps >= RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS) {
    flags.midpoint = true;
    flags.curtain = true;
    recordOwnerResearchSynthesisRequired(session, {
      explorationSteps,
      callSteps,
      staleSteps: admission.staleSteps,
      lastNovelEvidenceStep: admission.lastNovelEvidenceStep,
      synthesisReason: admission.synthesisReason || "exploration_ceiling",
      symbolFollowupsDiscounted: admission.symbolFollowupsDiscounted
        + (admission.symbolFollowupDiscounted ? 1 : 0),
    }, toolName);
    notice = buildResearchSynthesisRequiredText({
      explorationSteps,
      absoluteCeilingReached: true,
      explorationCeiling,
    });
    noticeKind = "research_closeout";
  } else if ((explorationSteps >= curtainStart || callSteps >= physicalCurtainStart) && !flags.curtain) {
    flags.midpoint = true;
    flags.curtain = true;
    notice = buildResearchCurtainCallText({
      explorationSteps: callSteps >= physicalCurtainStart ? callSteps : explorationSteps,
    });
    noticeKind = "research_curtain";
  }
  if (!notice) return result;
  return appendOwnerModelControlNotice(result, `\n\n${notice}`, {
    kind: noticeKind,
    trigger: noticeKind,
    explorationStep: explorationSteps,
  });
}

function atlasExecutorSessionContext(session, bootConfig = session?.bootConfig || {}) {
  return {
    id: session?.id || null,
    bootConfig: stripGatewaySessionTokenFields(bootConfig),
    tokenSource: session?.tokenSource || null,
    tokenVerified: session?.tokenVerified === true,
  };
}

function hashRefToolContext(session) {
  const boot = session?.bootConfig || {};
  return {
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    agent_call_id: boot.agentCallId ?? null,
  };
}

function isAtlasFetchRefTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && ["traverse_ref", "fetch_ref"].includes(requested.name);
}

function isCanonicalAtlasTraversalTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && requested.name === "traverse_ref";
}

function isAtlasCreateHashTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && requested.name === "create_ref";
}

function appendHashRefToMcpTextResult(result, toolName, toolArgs, session) {
  if (!result || result.isError === true) return result;
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
  const context = hashRefToolContext(session);
  const compacted = compactCodeSurveyResult(requested.name || toolName, first.text, { args, context });
  const refPaged = compacted.compacted
    ? compacted
    : compactCodeWindowLensResult(requested.name || toolName, compacted.result, { args, context });
  const stamped = appendHashRefIfMajor(requested.name || toolName, refPaged.result, {
    args,
    context,
    source: `atlas:${requested.name || toolName}`,
    objectType: requested.name ? `atlas.${requested.name}` : "atlas.tool_result",
    ...((compacted.compacted || refPaged.compacted) ? { minChars: 1 } : {}),
  });
  if (stamped === first.text) return result;
  const transformed = {
    ...result,
    content: [{ ...first, text: stamped }, ...result.content.slice(1)],
  };
  return annotateOwnerResultTransform(transformed, {
    kind: compacted.compacted
      ? "code_survey_compaction"
      : (refPaged.compacted ? "code_window_lens_compaction" : "hash_ref_surface"),
    action: requested.name || toolName,
    before_chars: first.text.length,
    after_chars: stamped.length,
  });
}

/**
 * Attach pending operator feedback directly to an ATLAS MCP result. The text
 * notice is model-visible; the mirrored _meta envelope preserves structured
 * custody for clients and telemetry. Delivery failures never break ATLAS.
 */
function appendOwnerOperatorFeedbackDelivery(result, session, toolName = "") {
  try {
    const first = result?.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") return result;
    const delivery = operatorFeedbackDeliveryForJob(session?.bootConfig?.jobId ?? null, {
      attemptId: session?.bootConfig?.attemptId ?? null,
      agentCallId: session?.bootConfig?.agentCallId ?? null,
      toolName,
    });
    if (!delivery) return result;
    const delivered = appendOwnerModelControlNotice(result, `\n\n${operatorFeedbackDeliveryText(delivery)}`, {
      kind: "operator_feedback_delivery",
      trigger: "pending_operator_feedback",
    });
    const next = {
      ...delivered,
      _meta: {
        ...(delivered?._meta && typeof delivered._meta === "object" ? delivered._meta : {}),
        posseOperatorFeedback: delivery,
      },
    };
    Object.defineProperty(next, OWNER_MODEL_CONTROL_NOTICES, {
      value: delivered?.[OWNER_MODEL_CONTROL_NOTICES] || [],
      enumerable: false,
    });
    return next;
  } catch {
    return result;
  }
}

function mcpToolCallSuccess(response = null) {
  const result = response?.result;
  if (!result || result.isError === true) return false;
  if (result?._meta?.posseControlOnly === true) return false;
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("")
    : "";
  return !/^(?:Error:|AUDIT ERROR:)/i.test(String(text || ""));
}

function atlasGateResultState(result = null) {
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("")
    : "";
  const ok = !!result && result.isError !== true && !/^(?:Error:|AUDIT ERROR:)/i.test(text.trimStart());
  return {
    ok,
    empty: ok && (text.trim().length === 0 || text.trim() === "ATLAS returned no output."),
  };
}

const OWNER_EVIDENCE_IDENTITY_VERSION = 1;
const OWNER_EVIDENCE_IDENTITY_MAX = 64;
const OWNER_EVIDENCE_KEY_NAMES = new Set([
  "content_hash",
  "contentHash",
  "file",
  "filePath",
  "path",
  "repo_rel_path",
  "repoRelPath",
  "qualifiedName",
  "symbolId",
  "symbol_id",
]);
const OWNER_EVIDENCE_COLLECTION_KEYS = new Set([
  "cards",
  "candidateFiles",
  "edges",
  "files",
  "items",
  "matches",
  "symbols",
]);
const OWNER_EVIDENCE_MATERIAL_KEY_NAMES = new Set([
  "body",
  "content",
  "signature",
  "snippet",
  "sourceText",
  "source_text",
  "text",
]);
const OWNER_SOURCE_BEARING_ACTIONS = new Set([
  "code.lens",
  "code.window",
  "file.read",
]);

function ownerResultTextWithoutControls(result = null) {
  let text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("\n")
    : "";
  for (const notice of result?.[OWNER_MODEL_CONTROL_NOTICES] || []) {
    const noticeText = String(notice?.text || "");
    if (noticeText) text = text.replace(noticeText, "");
  }
  return text.trim();
}

function normalizedEvidenceDigestValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => normalizedEvidenceDigestValue(item, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      if (/^(?:_?meta|runtimeTelemetry|timings?|duration|created_at|updated_at)$/i.test(childKey)) continue;
      if (/^(?:evidence_ref|traversal_ref|next_traversal_ref|view_ref|surveyRef|ref)$/i.test(childKey)) continue;
      out[childKey] = normalizedEvidenceDigestValue(value[childKey], childKey);
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/#[0-9a-f]{4,64}\b/gi, "#ref")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
  }
  void key;
  return value;
}

function collectOwnerEvidenceIdentities(value, identities, key = "", depth = 0) {
  if (depth > 8 || identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      collectOwnerEvidenceIdentities(item, identities, key, depth + 1);
      if (identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) break;
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (OWNER_EVIDENCE_KEY_NAMES.has(childKey) && childValue != null) {
      const normalized = String(childValue).replace(/\\/g, "/").trim().toLowerCase();
      if (normalized) identities.add(`${childKey.toLowerCase()}:${normalized.slice(0, 240)}`);
    }
    if (OWNER_EVIDENCE_MATERIAL_KEY_NAMES.has(childKey) && typeof childValue === "string") {
      const normalized = childValue.replace(/\r\n?/g, "\n").trim();
      if (normalized) {
        identities.add(
          `material:${childKey.toLowerCase()}:sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`,
        );
      }
    }
    if (OWNER_EVIDENCE_COLLECTION_KEYS.has(childKey) || (childValue && typeof childValue === "object")) {
      collectOwnerEvidenceIdentities(childValue, identities, childKey, depth + 1);
    }
    if (identities.size >= OWNER_EVIDENCE_IDENTITY_MAX) break;
  }
  void key;
}

/**
 * @param {{
 *   session?: any,
 *   toolName?: string,
 *   toolArgs?: Record<string, any>,
 *   result?: any,
 *   outcome?: string,
 * }} [input]
 */
function ownerAtlasEvidenceIdentities({ session, toolName, toolArgs, result, outcome } = {}) {
  const role = String(session?.bootConfig?.role || "");
  const action = effectiveAtlasResearchAction(requestedToolPolicyName(toolName, toolArgs));
  if (role !== "researcher" || !isResearchAtlasExplorationAction(action)) return null;
  if (outcome !== "succeeded" || result?.isError === true) return [];

  const text = ownerResultTextWithoutControls(result);
  if (!text || /^(?:Error:|AUDIT ERROR:)/i.test(text)) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain source evidence */ }
  if (
    parsed?.ok === false
    || parsed?.found === false
    || parsed?.duplicateSuppressed === true
    || parsed?.alreadySurfaced === true
    || parsed?.structureAlreadyVisible === true
    || String(parsed?.status || "").toLowerCase() === "covered"
  ) {
    return [];
  }

  const identities = new Set();
  collectOwnerEvidenceIdentities(parsed, identities);
  collectOwnerEvidenceIdentities(result?._meta?.atlasArtifacts, identities);
  collectOwnerEvidenceIdentities(result?._meta?.atlasBatch, identities);

  const hasStructuredMaterial = identities.size > 0 || (() => {
    if (!parsed || typeof parsed !== "object") return text.length > 0;
    for (const key of OWNER_EVIDENCE_COLLECTION_KEYS) {
      if (Array.isArray(parsed?.[key]) && parsed[key].length > 0) return true;
      if (Array.isArray(parsed?.data?.[key]) && parsed.data[key].length > 0) return true;
    }
    return [parsed.text, parsed.content, parsed.source, parsed.data?.text, parsed.data?.content]
      .some((value) => typeof value === "string" && value.length > 0);
  })();
  if (!hasStructuredMaterial) return [];

  // Stable paths/symbols and exact evidence-bearing source fields are the
  // monotonic novelty contract. A whole-result digest is fallback-only:
  // ranking scores, result order, pagination, and request echo fields may
  // legitimately change while returning no new repository evidence.
  if (identities.size === 0) {
    let digestSource;
    try {
      digestSource = parsed == null
        ? text.replace(/#[0-9a-z]{4,64}\b/gi, "#ref")
        : JSON.stringify(normalizedEvidenceDigestValue(parsed));
    } catch {
      digestSource = text.replace(/#[0-9a-z]{4,64}\b/gi, "#ref");
    }
    identities.add(`result:sha256:${crypto.createHash("sha256").update(digestSource).digest("hex")}`);
  }
  return [...identities].slice(0, OWNER_EVIDENCE_IDENTITY_MAX);
}

function normalizedOwnerSourcePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

function collectOwnerSourcePaths(value, paths, depth = 0) {
  if (depth > 8 || paths.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectOwnerSourcePaths(item, paths, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["repo_rel_path", "repoRelPath"].includes(key)) {
      const sourcePath = normalizedOwnerSourcePath(child);
      if (sourcePath) paths.add(sourcePath);
    }
    if (child && typeof child === "object") collectOwnerSourcePaths(child, paths, depth + 1);
  }
}

function collectOwnerSymbolSourcePaths(value, mappings, depth = 0) {
  if (depth > 8 || mappings.size >= OWNER_EVIDENCE_IDENTITY_MAX) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectOwnerSymbolSourcePaths(item, mappings, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const symbolId = String(value.symbolId || value.symbol_id || "").trim().toLowerCase();
  const sourcePath = normalizedOwnerSourcePath(
    value.location?.repo_rel_path
      || value.location?.repoRelPath
      || value.sourceExcerpt?.repo_rel_path
      || value.sourceExcerpt?.repoRelPath,
  );
  if (symbolId && sourcePath) mappings.set(symbolId, sourcePath);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectOwnerSymbolSourcePaths(child, mappings, depth + 1);
  }
}

/**
 * @param {{result?:any,outcome?:string|null}} [input]
 */
function ownerAtlasSymbolSourcePaths({ result, outcome } = {}) {
  if (outcome !== "succeeded" || result?.isError === true) return [];
  const text = ownerResultTextWithoutControls(result);
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const mappings = new Map();
  collectOwnerSymbolSourcePaths(parsed, mappings);
  return [...mappings].slice(0, OWNER_EVIDENCE_IDENTITY_MAX).map(([symbol_id, repo_rel_path]) => ({
    symbol_id,
    repo_rel_path,
  }));
}

/**
 * @param {{
 *   toolName?: string,
 *   toolArgs?: Record<string, unknown>,
 *   result?: Record<string, unknown> | null,
 *   outcome?: string,
 * }} [input]
 */
function ownerAtlasSourcePaths(input = {}) {
  const { toolName, toolArgs, result, outcome } = input;
  const action = effectiveAtlasResearchAction(requestedToolPolicyName(toolName, toolArgs));
  if (!OWNER_SOURCE_BEARING_ACTIONS.has(action) || outcome !== "succeeded" || result?.isError === true) {
    return null;
  }
  const text = ownerResultTextWithoutControls(result);
  if (!text || /^(?:Error:|AUDIT ERROR:)/i.test(text)) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* bounded or plain-text source result */ }
  if (String(parsed?.status || parsed?.data?.status || "").toLowerCase() === "covered") return [];
  const paths = new Set();
  const requestedPath = normalizedOwnerSourcePath(toolArgs?.file);
  if (requestedPath) paths.add(requestedPath);
  collectOwnerSourcePaths(parsed, paths);
  return [...paths].slice(0, OWNER_EVIDENCE_IDENTITY_MAX);
}

function mcpToolResultErrorText(result = null) {
  const structured = result?.structuredContent?.error?.message || result?._meta?.atlasError?.message || "";
  if (structured) return capString(structured, 700);
  if (!result?.isError) return "";
  const contentText = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").filter(Boolean).join("\n")
    : "";
  return capString(contentText || "ATLAS tool returned an error", 700);
}

function ownerToolStructuredError(result = null, error = null) {
  const structured = result?.structuredContent?.error || result?._meta?.atlasError || null;
  const code = String(structured?.code || error?.code || "").trim() || null;
  const message = String(
    structured?.message
      || error?.message
      || mcpToolResultErrorText(result)
      || "",
  ).trim() || null;
  const status = String(structured?.details?.status || "").trim() || null;
  return {
    ...(code ? { error_code: code } : {}),
    ...(message ? { error_message: message } : {}),
    ...(status ? { error_status: status } : {}),
  };
}

function recordOwnerModelControlNotice(session, toolName, notice = {}) {
  const boot = session?.bootConfig || {};
  try {
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "tool.response_control",
      summary: `Model-visible ${notice.kind || "runtime"} notice appended to ${toolName || "tool result"}`,
      detail: {
        kind: notice.kind || "runtime_control",
        tool: toolName || null,
        text: String(notice.text || ""),
        chars: String(notice.text || "").length,
        trigger: notice.trigger || null,
        exploration_step: notice.explorationStep ?? null,
        source: "mcp_owner",
      },
    });
  } catch (error) {
    try {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.response_control_observation_failed",
        ...attachTelemetryContext(session, null),
        tool_name: toolName || null,
        control_kind: notice.kind || "runtime_control",
        error: ownerErrorSummary(error),
      });
    } catch {
      // Response-control telemetry is advisory and must not break a tool result.
    }
  }
}

/**
 * @param {{
 *   session?: any,
 *   toolName?: string,
 *   toolArgs?: Record<string, any>,
 *   result?: any,
 *   evidenceResult?: any,
 *   error?: any,
 *   durationMs?: number | null,
 *   queueWaitMs?: number | null,
 *   executor?: Record<string, any> | null,
 *   observationDetail?: Record<string, any> | null,
 *   synthesisAdmission?: Record<string, any> | null,
 * }} [observation]
 */
function recordOwnerToolObservation({
  session,
  toolName,
  toolArgs,
  result = null,
  evidenceResult = null,
  error = null,
  durationMs = null,
  queueWaitMs = null,
  executor = null,
  observationDetail = null,
  synthesisAdmission = null,
} = {}) {
  const boot = session?.bootConfig || {};
  const outcome = error ? "failed" : classifyMcpToolResult(result);
  const resultChars = mcpResultTextChars(result);
  const errorText = error
    ? capString(error?.message || String(error), 700)
    : mcpToolResultErrorText(result);
  const structuredError = ownerToolStructuredError(result, error);
  const infrastructureFailure = (error || result?.isError === true)
    && isResearchInfrastructureFailure(structuredError);
  const evidenceIdentities = ownerAtlasEvidenceIdentities({
    session,
    toolName,
    toolArgs,
    result: evidenceResult || result,
    outcome,
  });
  const sourcePaths = ownerAtlasSourcePaths({
    toolName,
    toolArgs,
    result: evidenceResult || result,
    outcome,
  });
  const symbolSourcePaths = ownerAtlasSymbolSourcePaths({ result: evidenceResult || result, outcome });
  try {
    recordToolUseObservations({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      cwd: boot.cwd || null,
      // Every call reaching the owner was actually executed (and billed).
      // Provider replay dedupe can collapse distinct structured symbol refs
      // after display normalization, corrupting the research budget ledger.
      dedupe_replays: false,
      tool_uses: [{
        tool: toolName,
        input: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
        outcome,
        ...(outcome === "failed" && errorText ? { status: "failed", error: errorText } : {}),
        ...(outcome === "rejected" && errorText ? { status: "rejected", rejection: errorText } : {}),
        observation_detail: {
          agent_call_id: boot.agentCallId ?? null,
          duration_ms: durationMs == null ? null : Number(durationMs),
          queue_wait_ms: queueWaitMs == null ? null : Number(queueWaitMs),
          result_chars: resultChars,
          transport: "mcp_owner",
          executor: executor && typeof executor === "object" ? executor : null,
          ...(synthesisAdmission?.explorationUnitId ? {
            research_exploration_unit_version: 1,
            research_exploration_unit_id: synthesisAdmission.explorationUnitId,
            research_exploration_step: synthesisAdmission.assignedExplorationStep,
            research_exploration_unit_kind: synthesisAdmission.explorationUnitKind || "request",
            research_exploration_unit_weight: synthesisAdmission.explorationUnitWeight === 0 ? 0 : 1,
            physical_call_step: synthesisAdmission.assignedPhysicalCallStep ?? null,
            symbol_followup_discounted: synthesisAdmission.symbolFollowupDiscounted === true,
            physical_request: 1,
          } : {}),
          ...(observationDetail && typeof observationDetail === "object" ? observationDetail : {}),
          atlas_artifacts: result?._meta?.atlasArtifacts || null,
          atlas_batch: result?._meta?.atlasBatch || null,
          ...(evidenceIdentities == null ? {} : {
            evidence_identity_version: OWNER_EVIDENCE_IDENTITY_VERSION,
            evidence_identities: evidenceIdentities,
          }),
          ...(sourcePaths == null ? {} : { source_paths: sourcePaths }),
          ...(symbolSourcePaths.length > 0 ? { symbol_source_paths: symbolSourcePaths } : {}),
          response: {
            result_chars: resultChars,
            content_blocks: Array.isArray(result?.content) ? result.content.length : 0,
            is_error: result?.isError === true,
            over_client_clip: resultChars > CLIENT_RESULT_CLIP_CHARS,
          },
          ...structuredError,
          ...(infrastructureFailure ? { infrastructure_failure: true } : {}),
        },
      }],
    });
    for (const notice of result?.[OWNER_MODEL_CONTROL_NOTICES] || []) {
      recordOwnerModelControlNotice(session, toolName, notice);
    }
    for (const transform of result?._meta?.posseResultTransforms || []) {
      recordObservation({
        work_item_id: boot.workItemId ?? null,
        job_id: boot.jobId ?? null,
        attempt_id: boot.attemptId ?? null,
        observation_type: RESPONSE_TRANSFORM_OBSERVATION_TYPE,
        summary: `Model-visible ${transform.kind || "result"} transform applied to ${toolName || "ATLAS result"}`,
        detail: {
          ...transform,
          tool: toolName || null,
          source: "mcp_owner",
        },
      });
    }
  } catch (recordErr) {
    appendRunTelemetry("diagnostics", {
      kind: "mcp.owner.tool_observation_failed",
      ...attachTelemetryContext(session, null),
      tool_name: toolName || null,
      error: ownerErrorSummary(recordErr),
    });
  }
}

function sourceSelectionItems(toolArgs = {}) {
  return [toolArgs || {}];
}

function sourceSelectionCoverageCursor(coverageOwner) {
  if (!coverageOwner?.db || !coverageOwner?.attemptId) return 0;
  try {
    return Number(coverageOwner.db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS id
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'source.coverage'
    `).get(coverageOwner.attemptId)?.id || 0);
  } catch {
    return 0;
  }
}

function sourceSelectionCoverageStats(coverageOwner, sinceId, selections) {
  const byFingerprint = new Map(selections.map((selection) => [
    sourceSelectorFingerprint(selection),
    { returnedChars: 0, storedChars: 0, novel: false },
  ]));
  if (!coverageOwner?.db || !coverageOwner?.attemptId) return byFingerprint;
  try {
    const rows = coverageOwner.db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'source.coverage' AND id > ?
      ORDER BY id ASC
    `).all(coverageOwner.attemptId, Math.max(0, Number(sinceId) || 0));
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
      const stats = byFingerprint.get(String(detail?.selector_fingerprint || ""));
      if (!stats) continue;
      stats.returnedChars += Math.max(0, Number(detail?.returned_chars) || 0);
      stats.storedChars += Math.max(0, Number(detail?.stored_chars) || 0);
      if (detail?.novel_source === true || (
        detail?.novel_source !== false
        && Number(detail?.stored_chars) > 0
        && !String(detail?.origin || "").includes("reuse")
      )) stats.novel = true;
    }
  } catch {
    // Compatibility databases may not expose the coverage ledger.
  }
  return byFingerprint;
}

function parsedSourceEvidenceItems(result, selectionCount) {
  const byIndex = new Map();
  const text = result?.content?.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
  if (!text) return byIndex;
  const suffixAt = text.indexOf("\n\n[");
  let parsed;
  try { parsed = JSON.parse(suffixAt >= 0 ? text.slice(0, suffixAt) : text); } catch { return byIndex; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (selectionCount < 1) return byIndex;
  let returnedChars = typeof data?.content === "string" ? data.content.length : 0;
  for (const additional of Array.isArray(data?.additionalWindows) ? data.additionalWindows : []) {
    if (typeof additional?.content === "string") returnedChars += additional.content.length;
  }
  byIndex.set(0, { returnedChars });
  return byIndex;
}

function coveredSourceSelectionObservation(admission) {
  return {
    outcome: "covered",
    reason: admission?.reason || "covered_reuse",
    reasonClass: "reaccess",
    coverageScope: admission?.coverageScope || admission?.result?.coverage_scope || null,
    coverageOriginJobId: admission?.coverageOrigin?.job_id || admission?.result?.coverage_origin?.job_id || null,
    coverageOriginAttemptId: admission?.coverageOrigin?.attempt_id || admission?.result?.coverage_origin?.attempt_id || null,
    evidenceRef: admission?.result?.reaccess?.ref || admission?.result?.evidence_ref?.ref || null,
  };
}

/**
 * @param {{
 *   session?: any,
 *   toolArgs?: Record<string, any>,
 *   entries?: Array<Record<string, any>>,
 *   coverageOwner?: any,
 *   coverageCursor?: number,
 *   evidenceResult?: any,
 * }} input
 */
function recordSourceSelectionObservations({
  session,
  toolArgs,
  entries,
  coverageOwner = null,
  coverageCursor = 0,
  evidenceResult = null,
} = {}) {
  const boot = session?.bootConfig || {};
  const selections = sourceSelectionItems(toolArgs);
  const coverageStats = sourceSelectionCoverageStats(coverageOwner, coverageCursor, selections);
  const resultStats = parsedSourceEvidenceItems(evidenceResult, selections.length);
  for (const [index, selection] of selections.entries()) {
    const entry = entries?.[index] || {};
    const outcome = ["executed", "covered", "blocked"].includes(entry.outcome)
      ? entry.outcome
      : "blocked";
    const fingerprint = sourceSelectorFingerprint(selection);
    const coverage = coverageStats.get(fingerprint) || {};
    const returnedChars = outcome === "executed"
      ? Math.max(Number(resultStats.get(index)?.returnedChars) || 0, Number(coverage.returnedChars) || 0)
      : Math.max(0, Number(coverage.returnedChars) || 0);
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "research.source_selection",
      summary: `Source selection ${index + 1} ${outcome}: ${entry.reason || "unspecified"}`,
      detail: {
        version: 1,
        action: "code.window",
        item_index: index,
        selector_fingerprint: fingerprint,
        attempted: true,
        outcome,
        executed: outcome === "executed",
        covered: outcome === "covered",
        blocked: outcome === "blocked",
        novel_source: outcome === "executed" && coverage.novel === true,
        returned_chars: returnedChars,
        stored_chars: entry.storedChars == null
          ? Math.max(0, Number(coverage.storedChars) || 0)
          : Math.max(0, Number(entry.storedChars) || 0),
        reason: entry.reason || "unspecified",
        reason_class: entry.reasonClass || null,
        coverage_scope: entry.coverageScope || null,
        coverage_origin_job_id: entry.coverageOriginJobId || null,
        coverage_origin_attempt_id: entry.coverageOriginAttemptId || null,
        evidence_ref: entry.evidenceRef || null,
        agent_call_id: boot.agentCallId ?? null,
      },
    });
  }
}

function jsonlParseBuffer(buffer, onMessage, { onParseError = null, maxBufferBytes = JSONL_STDOUT_BUFFER_MAX_BYTES } = {}) {
  let next = buffer;
  while (next.length > 0) {
    const newlineIdx = next.indexOf(0x0a);
    if (newlineIdx < 0) break;
    const lineBytes = next.subarray(0, newlineIdx);
    next = next.subarray(newlineIdx + 1);
    if (lineBytes.length > maxBufferBytes) {
      const err = new Error(`MCP session stdout JSONL frame exceeded ${maxBufferBytes} bytes`);
      if (typeof onParseError === "function") onParseError(err, "");
      continue;
    }
    let line = lineBytes.toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.trim();
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch (err) {
      if (typeof onParseError === "function") onParseError(err, line);
    }
  }
  if (next.length > maxBufferBytes) {
    const err = new Error(`MCP session stdout JSONL buffer exceeded ${maxBufferBytes} bytes without newline`);
    if (typeof onParseError === "function") onParseError(err, "");
    return Buffer.alloc(0);
  }
  return next;
}

export function __testJsonlParseBuffer(buffer, onMessage, opts = {}) {
  return jsonlParseBuffer(buffer, onMessage, opts);
}

class PersistentMcpSession {
  /** @param {Record<string, any>} [options] */
  constructor({
    id,
    token,
    claims,
    bootConfig,
    serverSpec,
    agentOwned = false,
    spawnImpl = spawn,
  } = {}) {
    this.id = id;
    this.token = token;
    this.claims = claims || {};
    this.bootConfig = bootConfig || {};
    this.serverSpec = serverSpec || null;
    this.agentOwned = agentOwned === true;
    this._spawn = spawnImpl;
    this._proc = null;
    this._stdoutBuffer = Buffer.alloc(0);
    this._pending = new Map();
    this._seq = 0;
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    this.startedAt = null;
    this.lastExit = null;
    this.prewarmedAt = null;
    this.prewarmError = null;
    this._prewarmPromise = null;
    this.tokenVerified = !!claims?.__verified;
    this.tokenSource = claims?.__source || (this.tokenVerified ? "local" : "registered");
    const now = Date.now();
    this.registeredAt = now;
    this.updatedAt = now;
    this.lastSeenAt = now;
    this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null;
    this.attachProof = this._newAttachProof();
    this._gatewayBindingEpoch = 1;
    this._atlasGateEventSeq = 0;
    this._atlasGateEvents = [];
    this._subAgentRouting = createSubAgentRoutingState();
    this._atlasSymbolHandles = null;
    this._atlasPromotedTraversalRefs = new Set();
  }

  _newAttachProof() {
    return {
      initializeSeenAt: null,
      toolsListSeenAt: null,
      toolsListCount: null,
      toolsListNames: [],
      toolsListSha256: null,
      agentHandoffToolSchemaName: null,
      agentHandoffToolSchemaSha256: null,
      agentHandoffToolSchemaChars: null,
      firstToolCallSeenAt: null,
      firstToolName: null,
      requestCount: 0,
      lastRequestAt: null,
      lastMethod: null,
      lastOwnerError: null,
    };
  }

  /** @param {Record<string, any>} [options] */
  update({ token, claims, bootConfig, serverSpec, agentOwned = undefined } = {}) {
    if (token) this.token = token;
    if (claims) {
      this.claims = claims;
      this.tokenVerified = !!claims.__verified;
      this.tokenSource = claims.__source || (this.tokenVerified ? "local" : "registered");
      this.expiresAt = Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : this.expiresAt;
    }
    if (bootConfig) {
      const previousBindingKey = gatewayGateBindingKey(this.bootConfig, this.id);
      const nextBindingKey = gatewayGateBindingKey(bootConfig, this.id);
      this.bootConfig = bootConfig;
      if (previousBindingKey !== nextBindingKey) {
        this._gatewayBindingEpoch += 1;
        this._atlasGateEventSeq = 0;
        this._atlasGateEvents = [];
        this._subAgentRouting = createSubAgentRoutingState();
        this._atlasSymbolHandles = null;
      }
    }
    if (serverSpec) this.serverSpec = serverSpec;
    if (agentOwned !== undefined && (agentOwned === true) !== this.agentOwned) {
      throw new Error("MCP session ownership cannot change after registration");
    }
    this.updatedAt = Date.now();
    this.attachProof = this._newAttachProof();
    this.touch();
  }

  touch(now = Date.now()) {
    this.lastSeenAt = now;
  }

  snapshotAttachProof() {
    return {
      initializeSeenAt: this.attachProof.initializeSeenAt || null,
      toolsListSeenAt: this.attachProof.toolsListSeenAt || null,
      toolsListCount: this.attachProof.toolsListCount ?? null,
      toolsListNames: Array.isArray(this.attachProof.toolsListNames)
        ? [...this.attachProof.toolsListNames]
        : [],
      toolsListSha256: this.attachProof.toolsListSha256 || null,
      agentHandoffToolSchemaName: this.attachProof.agentHandoffToolSchemaName || null,
      agentHandoffToolSchemaSha256: this.attachProof.agentHandoffToolSchemaSha256 || null,
      agentHandoffToolSchemaChars: this.attachProof.agentHandoffToolSchemaChars ?? null,
      firstToolCallSeenAt: this.attachProof.firstToolCallSeenAt || null,
      firstToolName: this.attachProof.firstToolName || null,
      requestCount: this.attachProof.requestCount || 0,
      lastRequestAt: this.attachProof.lastRequestAt || null,
      lastMethod: this.attachProof.lastMethod || null,
      lastOwnerError: this.attachProof.lastOwnerError || null,
    };
  }

  noteRequest(message = {}, now = Date.now()) {
    const method = String(message?.method || "").trim();
    this.attachProof.requestCount += 1;
    this.attachProof.lastRequestAt = now;
    this.attachProof.lastMethod = method || null;
    if (method === "initialize" && !this.attachProof.initializeSeenAt) {
      this.attachProof.initializeSeenAt = now;
      return "initialize";
    }
    if (method === "tools/call" && !this.attachProof.firstToolCallSeenAt) {
      this.attachProof.firstToolCallSeenAt = now;
      this.attachProof.firstToolName = String(message?.params?.name || "").trim() || null;
      return "tools/call";
    }
    return null;
  }

  noteToolsList(response = null, now = Date.now()) {
    const count = toolsListCount(response);
    const names = toolsListNames(response);
    const handoffSchema = agentHandoffSchemaTelemetry(response);
    this.attachProof.toolsListSeenAt = this.attachProof.toolsListSeenAt || now;
    this.attachProof.toolsListCount = count;
    this.attachProof.toolsListNames = names;
    this.attachProof.toolsListSha256 = toolsListDigest(names);
    this.attachProof.agentHandoffToolSchemaName = handoffSchema?.name || null;
    this.attachProof.agentHandoffToolSchemaSha256 = handoffSchema?.sha256 || null;
    this.attachProof.agentHandoffToolSchemaChars = handoffSchema?.chars ?? null;
    return count;
  }

  noteOwnerError(err, method = null, now = Date.now()) {
    this.attachProof.lastOwnerError = {
      at: now,
      method: method || this.attachProof.lastMethod || null,
      error: ownerErrorSummary(err),
    };
  }

  noteAtlasGateEvent({ action = "", args = {}, ok = false, empty = false } = {}) {
    const normalizedAction = String(action || "").trim();
    if (!normalizedAction) return;
    this._atlasGateEvents.push({
      seq: ++this._atlasGateEventSeq,
      action: normalizedAction,
      args: cloneJson(args && typeof args === "object" ? args : {}),
      ok: ok === true,
      empty: empty === true,
    });
    if (this._atlasGateEvents.length > MAX_OWNER_ATLAS_GATE_EVENTS) {
      this._atlasGateEvents.splice(0, this._atlasGateEvents.length - MAX_OWNER_ATLAS_GATE_EVENTS);
    }
  }

  atlasGateEventsSnapshot() {
    return cloneJson(this._atlasGateEvents) || [];
  }

  isExpired(now = Date.now()) {
    // Agent-owned registration follows the authoritative in-process Agent
    // lifecycle. Its bearer has a separate hard expiry at the RPC boundary
    // and is rotated before reuse, so pruning registration by token age here
    // would strand an otherwise reusable Agent before it can rotate.
    if (this.agentOwned) return false;
    const idleMs = now - (this.lastSeenAt || this.registeredAt || now);
    if (this.expiresAt && now > this.expiresAt + SESSION_TOKEN_EXPIRY_GRACE_MS) {
      return idleMs > SESSION_TOKEN_EXPIRY_GRACE_MS;
    }
    return idleMs > SESSION_ORPHAN_TTL_MS;
  }

  isTokenExpired(now = Date.now()) {
    return !!this.expiresAt && now > this.expiresAt + TOKEN_CLOCK_SKEW_MS;
  }

  _rejectPending(error) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  ensureStarted() {
    if (this._proc && this._proc.exitCode == null) return;
    if (!this.serverSpec?.command) {
      throw new Error("MCP session has no registered server spec");
    }
    // Respawn backoff: a spec that crashes on startup would otherwise hot-loop
    // one heavy Node spawn per forwarded request. Allow the first respawn after
    // a crash immediately (a single restart is normal and several tests depend
    // on it), but once the child has died repeatedly without ever answering,
    // throttle spawns to one per backoff window. The crash counter resets on any
    // healthy response, so this only engages for a genuinely broken child.
    if (this._crashesSinceHealthy >= 2
      && this.lastExit?.at
      && Date.now() - this.lastExit.at < GATEWAY_RESTART_BACKOFF_MS) {
      const err = /** @type {Error & { code: string }} */ (
        new Error("MCP session restarting; backing off after repeated exits")
      );
      err.code = "GATEWAY_RESTART_BACKOFF";
      throw err;
    }
    const spec = this.serverSpec;
    const proc = this._spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      env: spec.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._proc = proc;
    this.startedAt = Date.now();
    this.lastExit = null;
    this._consecutiveTimeouts = 0;
    this._stdoutBuffer = Buffer.alloc(0);
    let finished = false;
    const finish = ({ code = null, signal = null, error = null } = {}) => {
      if (finished || this._proc !== proc) return;
      finished = true;
      this.lastExit = {
        at: Date.now(),
        code,
        signal,
        ...(error ? { error: ownerErrorSummary(error) } : {}),
      };
      if (this._proc === proc) this._proc = null;
      this._crashesSinceHealthy += 1;
      this._prewarmPromise = null;
      this.prewarmedAt = null;
      const failure = error || new Error(`MCP session exited (${code ?? signal ?? "unknown"})`);
      this._rejectPending(failure);
    };
    const failStream = (error) => {
      finish({ error });
      try { proc.kill?.("SIGTERM"); } catch { /* best effort */ }
    };
    proc.stdin?.on?.("error", failStream);
    proc.stdout?.on("data", (chunk) => {
      if (this._proc !== proc) return;
      this._handleStdout(chunk);
    });
    proc.stdout?.on?.("error", failStream);
    proc.stderr?.on("data", (chunk) => {
      try {
        if (isPowershellClixmlProgressNoise(chunk)) return;
        process.stderr.write(`[posse-mcp-owner:${this.id}] ${chunk}`);
      } catch {
        // diagnostics only
      }
    });
    proc.stderr?.on?.("error", failStream);
    proc.once("error", (error) => finish({ error }));
    proc.once("exit", (code, signal) => finish({ code, signal }));
    for (const frame of Array.isArray(spec.startupFrames) ? spec.startupFrames : []) {
      this._write(frame);
    }
  }

  request(message = {}) {
    this.ensureStarted();
    const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    const outbound = cloneJson(message);
    if (id == null) {
      this._write(outbound);
      return Promise.resolve(null);
    }
    const internalId = `owner-${this.id}-${++this._seq}`;
    outbound.id = internalId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(internalId);
        // A wedged child (blocked event loop, native deadlock) never answers,
        // so the caller's timeout is the only signal. Count consecutive
        // no-response timeouts; once the child looks wedged rather than slow,
        // force-kill it. Its exit drives finish() → rejects remaining pending,
        // and the next request respawns a fresh child via ensureStarted. Without
        // this the single shared gateway child stays wedged forever, costing
        // every subsequent request a full 120s timeout.
        this._consecutiveTimeouts += 1;
        if (this._consecutiveTimeouts >= MAX_CONSECUTIVE_REQUEST_TIMEOUTS) {
          try { this.stop({ force: true }); } catch { /* best effort; exit path handles pending */ }
        }
        reject(new Error(`MCP session request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this._pending.set(internalId, {
        originalId: id,
        resolve,
        reject,
        timer,
      });
      try {
        this._write(outbound);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(internalId);
        reject(err);
      }
    });
  }

  notify(message = {}) {
    if (!this._proc || this._proc.exitCode != null || this._proc.killed) return false;
    const outbound = cloneJson(message);
    if (outbound && typeof outbound === "object") delete outbound.id;
    try {
      this._write(outbound);
      return true;
    } catch {
      return false;
    }
  }

  prewarm() {
    if (this._prewarmPromise) return this._prewarmPromise;
    this._prewarmPromise = (async () => {
      this.ensureStarted();
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "posse-mcp-owner", version: "1.0.0" },
        },
      });
      await this.request({
        jsonrpc: "2.0",
        id: "owner-prewarm-tools",
        method: "tools/list",
        params: {},
      });
      this.prewarmedAt = Date.now();
      this.prewarmError = null;
      return true;
    })().catch((err) => {
      this.prewarmError = String(err?.message || err);
      this._prewarmPromise = null;
      throw err;
    });
    return this._prewarmPromise;
  }

  _write(message) {
    if (!this._proc?.stdin || this._proc.stdin.destroyed) {
      throw new Error("MCP session stdin is closed");
    }
    this._proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  _handleStdout(chunk) {
    this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, Buffer.from(chunk)]);
    this._stdoutBuffer = jsonlParseBuffer(
      this._stdoutBuffer,
      (message) => this._handleMessage(message),
      {
        onParseError: (err) => {
          try {
            process.stderr.write(`[posse-mcp-owner:${this.id}] failed to parse session stdout: ${err?.message || err}\n`);
          } catch {
            // diagnostics only
          }
        },
      },
    );
  }

  _handleMessage(message) {
    const id = String(message?.id ?? "");
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    // The child answered — it is alive and responsive, so clear any accumulated
    // timeout strikes and crash-loop history.
    this._consecutiveTimeouts = 0;
    this._crashesSinceHealthy = 0;
    const restored = { ...message, id: entry.originalId };
    entry.resolve(restored);
  }

  stop({ force = false } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return false;
    if (process.platform === "win32") {
      try {
        const args = ["/pid", String(proc.pid), "/T"];
        if (force) args.push("/F");
        const killer = this._spawn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
        return true;
      } catch {
        // Fall through to the direct child kill.
      }
    }
    try {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  close({ force = false, timeoutMs = 10000 } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let procExited = false;
      let treeKillFinished = process.platform !== "win32";
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const maybeDone = () => {
        if (procExited && treeKillFinished) done(true);
      };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
        done(false);
      }, Math.max(100, Number(timeoutMs) || 10000));
      timer.unref?.();
      proc.once("exit", () => {
        procExited = true;
        maybeDone();
      });
      try {
        if (process.platform === "win32") {
          const args = ["/pid", String(proc.pid), "/T"];
          if (force) args.push("/F");
          const killer = this._spawn("taskkill", args, {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("close", (code) => {
            treeKillFinished = true;
            if (code !== 0 && !procExited) {
              try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            }
            maybeDone();
          });
          killer.once("error", () => {
            treeKillFinished = true;
            try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { done(false); }
            maybeDone();
          });
        } else {
          proc.kill(force ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        done(false);
      }
    });
  }
}

export class PersistentMcpOwner {
  /** @param {Record<string, any>} [options] */
  constructor({
    pipePath = null,
    token = randomToken(),
    spawnImpl = spawn,
    researchAtlasTerminalBatchIdleMs = RESEARCH_ATLAS_TERMINAL_BATCH_IDLE_MS,
  } = {}) {
    this.bootId = crypto.randomUUID();
    this.pipePath = pipePath || defaultPipePath(this.bootId);
    this.token = token;
    // Separate from the agent-facing MCP token. The trusted hot gateway uses
    // this private capability to authenticate its backend daemon session.
    this.nativeAuthToken = randomToken();
    this._spawn = spawnImpl;
    this._server = null;
    this._sessions = new Map();
    this._sessionIdsByTokenHash = new Map();
    this._gatewaySession = null;
    this._gatewayRetirements = new Set();
    // Stateful ATLAS actions remain ordered per attempt. Researcher emissions
    // reserve absolute exploration slots synchronously; read-only actions may
    // execute concurrently while serialized siblings retain the same emission
    // admission without racing the deterministic closeout ceiling.
    this._atlasToolCallQueues = new Map();
    this._activeResearchAtlasReads = new Map();
    this._activeResearchAtlasBatches = new Map();
    this._researchAdmissionReservations = new Map();
    this._researchCallReservations = new Map();
    this._researchInfrastructureRefundReservations = new Map();
    this._researchExplorationUnitSequence = 0;
    const terminalBatchIdleMs = Number(researchAtlasTerminalBatchIdleMs);
    this._researchAtlasTerminalBatchIdleMs = Number.isFinite(terminalBatchIdleMs)
      && terminalBatchIdleMs >= 0
      ? Math.floor(terminalBatchIdleMs)
      : RESEARCH_ATLAS_TERMINAL_BATCH_IDLE_MS;
    // A memory failure is terminal only for the agent session that observed
    // it. Weak keys avoid extending the lifetime of detached MCP sessions.
    this._terminalMemoryToolSessions = new WeakSet();
    this._startedAt = null;
    this._listenError = null;
  }

  endpoint() {
    return {
      transport: "pipe",
      pipePath: this.pipePath,
      token: this.token,
      bootId: this.bootId,
    };
  }

  nativeAuthBrokerCapability() {
    return {
      transport: "pipe",
      pipePath: this.pipePath,
      token: this.nativeAuthToken,
    };
  }

  ensureStarted() {
    if (this._server) return this.endpoint();
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        const status = err?.message === "request_body_too_large" ? 413 : 500;
        sendJson(res, status, { ok: false, error: status === 500 ? "internal" : err.message });
      });
    });
    this._server = server;
    server.on("error", (err) => {
      this._listenError = err;
      if (this._server === server) {
        this._server = null;
        this._startedAt = null;
      }
      try { server.close(); } catch { /* best effort */ }
    });
    server.listen(this.pipePath, () => {
      this._listenError = null;
      this._startedAt = Date.now();
    });
    server.unref?.();
    return this.endpoint();
  }

  /** @param {Record<string, any>} [options] */
  registerSession({ token, bootConfig = {}, serverSpec = null, prewarm = true, agentOwned = false } = {}) {
    this.pruneExpiredSessions({ reason: "register_prune" });
    const claims = verifyMcpOAuthToken(token);
    const verified = true;
    claims.__verified = verified;
    if (!claims.__source) claims.__source = "local";
    const id = String(claims.jti || claims.sub || "");
    if (!id) throw new Error("MCP OAuth token is missing a session id");
    const signedBootConfig = bootConfigFromMcpOAuthClaims(claims);
    const resolvedBootConfig = agentOwned === true
      ? bindAgentAttachmentToSignedContract(signedBootConfig, bootConfig)
      : narrowBootConfigToSignedClaims(signedBootConfig, bootConfig);
    const sessionBootConfig = {
      ...resolvedBootConfig,
      mcpOAuth: {
        verified: true,
        tokenId: id,
        expiresAt: claims.exp || null,
        source: claims.__source || (verified ? "local" : "remote"),
      },
    };
    if (!hasSuiteToolAllowlist(sessionBootConfig)) {
      throw new Error("MCP OAuth token is missing suite-scoped toolAllowlist");
    }
    let session = this._sessions.get(id);
    if (session && !tokenEqual(session.token, token)) {
      throw new Error("MCP OAuth token session id collision");
    }
    if (!session) {
      session = new PersistentMcpSession({
        id,
        token,
        claims,
        bootConfig: sessionBootConfig,
        serverSpec: null,
        agentOwned,
        spawnImpl: this._spawn,
      });
      this._sessions.set(id, session);
    } else {
      session.update({ token, claims, bootConfig: sessionBootConfig, serverSpec: null, agentOwned });
    }
    this._ensureGatewaySession({ serverSpec, prewarm });
    this._sessionIdsByTokenHash.set(tokenHash(token), id);
    return { sessionId: id, ...this.endpoint() };
  }

  _rotateAgentSessionToken(session, now = Date.now()) {
    if (!session?.agentOwned) return null;
    const signedBootConfig = bootConfigFromMcpOAuthClaims(session.claims);
    const token = mintMcpOAuthTokenForBootConfig(signedBootConfig, {
      nowMs: now,
      expiresInSeconds: DEFAULT_MCP_OAUTH_TTL_SECONDS,
      jti: `agent-rotation-${crypto.randomUUID()}`,
    });
    const claims = verifyMcpOAuthToken(token, { nowMs: now });
    claims.__verified = true;
    claims.__source = session.claims?.__source || "local";
    this._sessionIdsByTokenHash.delete(tokenHash(session.token));
    session.update({ token, claims });
    this._sessionIdsByTokenHash.set(tokenHash(token), session.id);
    return token;
  }

  /** @param {Record<string, any>} [options] */
  attachAgentSession({
    sessionId,
    token,
    expectedBootId = null,
    bootConfig = {},
    serverSpec = null,
  } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) {
      throw new Error("MCP owner boot changed before agent scope binding");
    }
    const id = String(sessionId || "");
    const session = id ? this._sessions.get(id) : null;
    if (!session) throw new Error("MCP agent session is not registered");
    if (!session.agentOwned) throw new Error("MCP session is not owned by an agent");
    if (!token || !tokenEqual(session.token, token)) throw new Error("MCP agent session token mismatch");
    if (session.isTokenExpired()) {
      const error = /** @type {Error & { code: string }} */ (
        new Error("MCP agent session token is expired")
      );
      error.code = "POSSE_MCP_AGENT_TOKEN_EXPIRED";
      throw error;
    }
    const signedBootConfig = bootConfigFromMcpOAuthClaims(session.claims);
    const boundBootConfig = {
      ...bindAgentAttachmentToSignedContract(signedBootConfig, bootConfig),
      mcpOAuth: {
        verified: true,
        tokenId: session.id,
        expiresAt: session.claims?.exp || null,
        source: session.claims?.__source || "local",
      },
    };
    if (!hasSuiteToolAllowlist(boundBootConfig)) {
      throw new Error("MCP agent contract is missing suite-scoped toolAllowlist");
    }
    if (serverSpec?.command) this._ensureGatewaySession({ serverSpec, prewarm: true });
    const previousGatewayScopeReleaseNotified = gatewayGateBindingKey(session.bootConfig, session.id)
      !== gatewayGateBindingKey(boundBootConfig, session.id)
      && this._notifyGatewaySessionRelease(session);
    // Rotate only after every fallible validation/setup step. Otherwise an
    // attach error strands the caller with the old bearer and prevents its
    // cleanup path from unregistering the session.
    const rotatedToken = this._rotateAgentSessionToken(session);
    session.update({ bootConfig: boundBootConfig, serverSpec });
    return {
      bound: true,
      sessionId: id,
      jobId: boundBootConfig.jobId ?? null,
      workItemId: boundBootConfig.workItemId ?? null,
      previousGatewayScopeReleaseNotified,
      ...(rotatedToken ? { token: rotatedToken } : {}),
    };
  }

  /** @param {Record<string, any>} [options] */
  detachAgentSession({
    sessionId,
    token,
    expectedBootId = null,
    reason = "job_release",
  } = {}) {
    const result = this.attachAgentSession({
      sessionId,
      token,
      expectedBootId,
      bootConfig: {
        cwd: "",
        jobId: null,
        workItemId: null,
        attemptId: null,
        agentCallId: null,
        allowWrite: false,
        allowShell: false,
        allowTests: false,
        projectDbCapability: "none",
        projectDbWrite: false,
        allowImageGeneration: false,
        atlasAvailable: false,
      },
    });
    return {
      cleared: result.bound === true,
      sessionId: result.sessionId,
      reason,
      previousGatewayScopeReleaseNotified: result.previousGatewayScopeReleaseNotified === true,
      ...(result.token ? { token: result.token } : {}),
    };
  }

  _logAttachProof(session, kind, fields = {}) {
    try {
      appendRunTelemetry("diagnostics", {
        kind,
        ...attachTelemetryContext(session, this.bootId),
        ...fields,
      });
    } catch {
      // Telemetry must not affect MCP request handling.
    }
  }

  _notifyGatewaySessionRelease(session) {
    return this._gatewaySession?.notify?.(gatewaySessionReleaseNotification(session)) === true;
  }

  _removeSession(id, { reason = "released", context = null, telemetry = true } = {}) {
    const session = id ? this._sessions.get(id) : null;
    if (!session) return { released: false, reason: "not_found", sessionCount: this._sessions.size };
    const attachProof = session.snapshotAttachProof();
    this._sessions.delete(id);
    this._sessionIdsByTokenHash.delete(tokenHash(session.token));
    // Reservations are keyed per job/attempt (the exploration budget is an
    // attempt-level invariant); drop the entry only when no other live session
    // still shares that attempt, or a reconnect could re-race the ceiling.
    const reservationKey = researchBudgetKey(session.bootConfig || {});
    const reservationShared = [...this._sessions.values()].some((other) => (
      researchBudgetKey(other?.bootConfig || {}) === reservationKey
    ));
    if (!reservationShared) {
      this._researchAdmissionReservations.delete(reservationKey);
      this._researchCallReservations.delete(reservationKey);
      this._researchInfrastructureRefundReservations.delete(reservationKey);
    }
    for (const key of this._activeResearchAtlasReads.keys()) {
      if (key.endsWith(`:${id}`)) this._activeResearchAtlasReads.delete(key);
    }
    for (const [key, batch] of this._activeResearchAtlasBatches.entries()) {
      if (!key.endsWith(`:${id}`)) continue;
      if (batch?.idleTimer) clearTimeout(batch.idleTimer);
      this._activeResearchAtlasBatches.delete(key);
    }
    const gatewayScopeReleaseNotified = this._notifyGatewaySessionRelease(session);
    let gatewayReleased = false;
    let gatewayStopped = false;
    if (this._sessions.size === 0 && this._gatewaySession) {
      const gateway = this._gatewaySession;
      this._gatewaySession = null;
      gatewayReleased = true;
      // No signed sessions remain, so every process in this gateway tree is
      // run-owned and unreachable. Force the tree down on Windows; graceful
      // taskkill can leave the stdio helper alive and keep one-shot callers
      // (including provider-backed ML passes) from exiting.
      gatewayStopped = !!gateway._proc
        && gateway._proc.exitCode == null
        && !gateway._proc.killed;
      const retirement = gateway.close({ force: true });
      this._gatewayRetirements.add(retirement);
      retirement.finally(() => this._gatewayRetirements.delete(retirement));
    }
    if (telemetry) {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.unregister_session",
        component: "deterministic_mcp",
        outcome: "released",
        owner_boot_id: this.bootId,
        session_id: id,
        reason,
        session_count: this._sessions.size,
        gateway_released: gatewayReleased,
        gateway_stopped: gatewayStopped,
        gateway_scope_release_notified: gatewayScopeReleaseNotified,
        registered_at: session.registeredAt || null,
        last_seen_at: session.lastSeenAt || null,
        expires_at: session.expiresAt || null,
        attach_proof: attachProof,
        context: context && typeof context === "object" ? context : null,
      });
    }
    return {
      released: true,
      sessionId: id,
      reason,
      sessionCount: this._sessions.size,
      gatewayReleased,
      gatewayStopped,
      gatewayScopeReleaseNotified,
      attachProof,
    };
  }

  /** @param {Record<string, any>} [options] */
  unregisterSession({ sessionId = null, token = null, expectedBootId = null, reason = "provider_exit", context = null } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) {
      return { released: false, reason: "owner_mismatch", sessionCount: this._sessions.size };
    }
    const id = String(sessionId || (token ? this._sessionIdsByTokenHash.get(tokenHash(token)) : "") || "");
    const session = id ? this._sessions.get(id) : null;
    if (!session) return { released: false, reason: "not_found", sessionCount: this._sessions.size };
    if (token && !tokenEqual(session.token, token)) {
      return { released: false, reason: "token_session_mismatch", sessionCount: this._sessions.size };
    }
    return this._removeSession(id, { reason, context, telemetry: true });
  }

  snapshotSessionAttachProof({ sessionId = null, expectedBootId = null } = {}) {
    if (expectedBootId && expectedBootId !== this.bootId) return null;
    const session = sessionId ? this._sessions.get(String(sessionId)) : null;
    return session ? session.snapshotAttachProof() : null;
  }

  pruneExpiredSessions({ now = Date.now(), reason = "expired" } = {}) {
    let released = 0;
    for (const session of [...this._sessions.values()]) {
      if (!session.isExpired(now)) continue;
      const result = this._removeSession(session.id, {
        reason,
        context: { expired: true },
        telemetry: true,
      });
      if (result.released) released += 1;
    }
    return { released, sessionCount: this._sessions.size };
  }

  /** @param {Record<string, any>} [options] */
  _ensureGatewaySession({ serverSpec = null, prewarm = true } = {}) {
    if (!serverSpec?.command) return null;
    if (!this._gatewaySession) {
      this._gatewaySession = new PersistentMcpSession({
        id: "hot-gateway",
        token: this.token,
        claims: { __verified: true, __source: "owner" },
        bootConfig: { ownerHotGateway: true },
        serverSpec,
        spawnImpl: this._spawn,
      });
    } else if (!this._gatewaySession._proc || this._gatewaySession._proc.exitCode != null || this._gatewaySession._proc.killed) {
      this._gatewaySession.update({ serverSpec });
    }
    if (prewarm) {
      const startedAt = Date.now();
      this._gatewaySession.prewarm()
        .then(() => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.gateway_prewarm",
            component: "deterministic_mcp",
            outcome: "ok",
            owner_boot_id: this.bootId,
            duration_ms: Date.now() - startedAt,
            session_count: this._sessions.size,
            gateway_running: !!this._gatewaySession?._proc
              && this._gatewaySession._proc.exitCode == null
              && !this._gatewaySession._proc.killed,
            prewarmed_at: this._gatewaySession?.prewarmedAt || null,
          });
        })
        .catch((err) => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.gateway_prewarm",
            component: "deterministic_mcp",
            outcome: "error",
            owner_boot_id: this.bootId,
            duration_ms: Date.now() - startedAt,
            session_count: this._sessions.size,
            gateway_running: !!this._gatewaySession?._proc
              && this._gatewaySession._proc.exitCode == null
              && !this._gatewaySession._proc.killed,
            prewarm_error: this._gatewaySession?.prewarmError || null,
            last_exit: this._gatewaySession?.lastExit || null,
            error: ownerErrorSummary(err),
          });
        });
    }
    return this._gatewaySession;
  }

  status() {
    return {
      ok: true,
      bootId: this.bootId,
      pipePath: this.pipePath,
      startedAt: this._startedAt,
      uptimeMs: this._startedAt ? Math.max(0, Date.now() - this._startedAt) : 0,
      sessionCount: this._sessions.size,
      listenError: this._listenError ? String(this._listenError?.message || this._listenError) : null,
      gateway: this._gatewaySession ? {
        id: this._gatewaySession.id,
        startedAt: this._gatewaySession.startedAt,
        prewarmedAt: this._gatewaySession.prewarmedAt,
        prewarmError: this._gatewaySession.prewarmError,
        running: !!this._gatewaySession._proc && this._gatewaySession._proc.exitCode == null && !this._gatewaySession._proc.killed,
        lastExit: this._gatewaySession.lastExit,
      } : null,
      sessions: [...this._sessions.values()].map((session) => ({
        id: session.id,
        agentOwned: session.agentOwned,
        agentId: session.bootConfig?.agentId || null,
        jobId: session.bootConfig?.jobId ?? null,
        startedAt: this._gatewaySession?.startedAt || null,
        running: !!this._gatewaySession?._proc && this._gatewaySession._proc.exitCode == null && !this._gatewaySession._proc.killed,
        lastExit: session.lastExit,
        tokenVerified: session.tokenVerified,
        tokenSource: session.tokenSource,
        attachProof: session.snapshotAttachProof(),
      })),
    };
  }

  async close({ force = true } = {}) {
    await Promise.all([...this._sessions.values()].map((session) => session.close({ force })));
    await this._gatewaySession?.close?.({ force });
    await Promise.allSettled([...this._gatewayRetirements]);
    this._gatewaySession = null;
    this._gatewayRetirements.clear();
    this._atlasToolCallQueues.clear();
    this._activeResearchAtlasReads.clear();
    for (const batch of this._activeResearchAtlasBatches.values()) {
      if (batch?.idleTimer) clearTimeout(batch.idleTimer);
    }
    this._activeResearchAtlasBatches.clear();
    this._researchAdmissionReservations.clear();
    this._researchCallReservations.clear();
    this._researchInfrastructureRefundReservations.clear();
    this._sessions.clear();
    this._sessionIdsByTokenHash.clear();
    const server = this._server;
    this._server = null;
    if (server) {
      try { server.close(); } catch { /* best effort */ }
      try { server.closeIdleConnections?.(); } catch { /* best effort */ }
      try { server.closeAllConnections?.(); } catch { /* best effort */ }
      server.unref?.();
    }
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
  }

  async _handleRequest(req, res) {
    if (req.method === "GET" && req.url === "/v1/mcp/healthz") {
      if (!this._authorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, this.status());
      return;
    }
    if (req.method === "POST" && req.url === "/v1/capabilities/handshake") {
      if (!tokenEqual(bearerFrom(req), this.nativeAuthToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(req);
      const { pulseTokenManager } = await import("../../native/classes/PulseTokenManager.js");
      try {
        const handshakes = new NativeAuthHandshake({ pulseManager: pulseTokenManager });
        const grant = await handshakes.issue(body);
        sendJson(res, 200, { ok: true, grant });
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "POSSE_PULSE_ROUTE_DENIED" || code === "POSSE_PARENT_PULSE_DENIED") {
          sendJson(res, 403, { ok: false, error: "capability_denied", code });
        } else if (code === "POSSE_CAPABILITY_REQUEST_INVALID" || code === "POSSE_CAPABILITY_PROTOCOL_INVALID") {
          sendJson(res, 400, { ok: false, error: "invalid_capability_request", code });
        } else {
          sendJson(res, 503, { ok: false, error: "heartbeat_unavailable" });
        }
      }
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/mcp/rpc") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!this._authorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(req);
    const token = String(body?.token || "").trim();
    const message = body?.message && typeof body.message === "object" ? body.message : null;
    const delegatedEvidence = body?.delegatedEvidence === true;
    if (!token || !message) {
      sendJson(res, 400, { ok: false, error: "invalid_request" });
      return;
    }
    let id = this._sessionIdsByTokenHash.get(tokenHash(token)) || "";
    let session = id ? this._sessions.get(id) : null;
    let claims = null;
    if (session && !tokenEqual(session.token, token)) {
      sendJson(res, 403, { ok: false, error: "token_session_mismatch" });
      return;
    }
    if (session?.isTokenExpired()) {
      this._removeSession(session.id, {
        reason: "token_expired",
        context: { expired: true },
        telemetry: true,
      });
      sendJson(res, 401, { ok: false, error: "token_expired" });
      return;
    }
    if (!session) {
      try {
        claims = verifyMcpOAuthToken(token);
      } catch (err) {
        const code = String(err?.code || "invalid_token");
        sendJson(res, 401, {
          ok: false,
          error: code === "token_expired" ? "token_expired" : "invalid_token",
        });
        return;
      }
      const signedBoot = bootConfigFromMcpOAuthClaims(claims);
      if (claims.agent_id || signedBoot.scopeBindingMode === "dispatcher") {
        sendJson(res, 403, { ok: false, error: "unregistered_agent_gate" });
        return;
      }
      id = String(claims.jti || claims.sub || "");
      const bootConfig = {
        ...signedBoot,
        mcpOAuth: {
          verified: true,
          tokenId: id,
          expiresAt: claims.exp || null,
        },
      };
      if (!hasSuiteToolAllowlist(bootConfig)) {
        sendJson(res, 403, { ok: false, error: "missing_token_tool_allowlist" });
        return;
      }
      session = new PersistentMcpSession({
        id,
        token,
        claims: { ...claims, __verified: true, __source: "local" },
        bootConfig,
        serverSpec: null,
        agentOwned: false,
        spawnImpl: this._spawn,
      });
      this._sessions.set(id, session);
      this._sessionIdsByTokenHash.set(tokenHash(token), id);
    }
    session.touch();
    const method = String(message?.method || "").trim();
    if (method === MCP_SESSION_RELEASED_NOTIFICATION) {
      sendJson(res, 403, { ok: false, error: "reserved_owner_method" });
      return;
    }
    const proofEvent = session.noteRequest(message);
    if (proofEvent === "initialize") {
      this._logAttachProof(session, "mcp.attach.initialize_seen", {
        method,
        request_count: session.attachProof.requestCount,
      });
    } else if (proofEvent === "tools/call") {
      this._logAttachProof(session, "mcp.attach.first_tool_call", {
        method,
        tool_name: session.attachProof.firstToolName || null,
        request_count: session.attachProof.requestCount,
      });
    }
    try {
      if (method === AGENT_HANDOFF_RECEIPT_NOTIFICATION) {
        const agentCallId = session?.bootConfig?.agentCallId;
        const record = getAgentHandoffRecord(agentCallId);
        const accepted = record && ["staged", "committed"].includes(record.status);
        if (accepted) {
          agentHandoffTerminator.acknowledge(agentCallId, {
            source: "mcp_receipt",
            role: session?.bootConfig?.role || null,
            sessionId: id,
            digest: record.packet_digest || null,
          });
        }
        sendJson(res, 200, {
          ok: true,
          bootId: this.bootId,
          sessionId: id,
          message: null,
          acknowledged: accepted === true,
        });
        return;
      }
      if (!this._gatewaySession) {
        throw new Error("MCP hot gateway has not been registered");
      }
      const policy = sessionToolPolicy(session);
      let preparedSubAgentHandoff = false;
      if (message.method === "tools/call") {
        const providerToolName = String(message?.params?.name || "");
        const providerToolArgs = message?.params?.arguments || {};
        if (!toolAllowedByPolicy(policy, providerToolName, providerToolArgs)) {
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: deniedToolCallMessage(message, providerToolName, policy),
          });
          return;
        }
        const routedTool = routeResearcherDispatcherCall(
          policy,
          providerToolName,
          providerToolArgs,
          session,
        );
        const toolName = routedTool.toolName;
        const toolArgs = routedTool.toolArgs;
        if (routedTool.routingError) {
          const result = mcpToolErrorPayload(routedTool.routingError);
          recordOwnerToolObservation({
            session,
            toolName,
            toolArgs,
            result,
            durationMs: 0,
            executor: { via: "typed_dispatcher_symbol_handle" },
          });
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: mcpToolResultMessage(message, result),
          });
          return;
        }
        const requested = requestedToolPolicyName(toolName, toolArgs);
        const assessorRole = String(session?.bootConfig?.role || "");
        if (assessorToolBudgetApplies(assessorRole, requested.name)) {
          session._assessorToolCallCount = Number(session._assessorToolCallCount || 0) + 1;
          const ceiling = assessorToolCallCeilingDecision({
            role: assessorRole,
            toolName: requested.name,
            usedToolCalls: session._assessorToolCallCount,
            maxToolCalls: session?.bootConfig?.assessorMaxToolCalls,
          });
          if (ceiling.blocked) {
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{
                    type: "text",
                    text: ceiling.text,
                  }],
                  isError: false,
                },
              },
            });
            return;
          }
          if (isAssessorFallbackReadKey(assessorFallbackReadKey(requested))) {
            const fallbackReadCap = Number.isFinite(Number(session?.bootConfig?.fallbackReads))
              ? Math.max(0, Math.floor(Number(session.bootConfig.fallbackReads)))
              : 0;
            session._assessorFallbackReadCount = Number(session._assessorFallbackReadCount || 0);
            if (session._assessorFallbackReadCount >= fallbackReadCap) {
              sendJson(res, 200, {
                ok: true,
                bootId: this.bootId,
                sessionId: id,
                message: {
                  jsonrpc: "2.0",
                  id: message?.id ?? null,
                  result: {
                    content: [{
                      type: "text",
                      text: "Assessor read budget exhausted. Render the verdict from the evidence already provided. If material evidence is genuinely missing, return needs_review; never fabricate a pass.",
                    }],
                    isError: false,
                  },
                },
              });
              return;
            }
            session._assessorFallbackReadCount += 1;
          }
        }
        const routingState = subAgentRoutingEnabled(policy)
          ? session._subAgentRouting
          : null;
        const routingBlockReason = delegatedEvidence
          ? ""
          : subAgentRoutingBlockReason(
              routingState,
              requested,
              toolArgs,
              subAgentRoutingContext(session),
            );
        if (routingBlockReason) {
          const delegatedRepeat = routingBlockReason === "delegated_repeat";
          const redundantDispatch = routingBlockReason === "redundant_dispatch";
          recordObservation({
            work_item_id: session?.bootConfig?.workItemId ?? null,
            job_id: session?.bootConfig?.jobId ?? null,
            attempt_id: session?.bootConfig?.attemptId ?? null,
            observation_type: "sub_agent.routing_guard",
            summary: delegatedRepeat
              ? "Parent duplicate evidence call deduplicated after child synthesis"
              : redundantDispatch
                ? "Redundant sub-agent dispatch blocked after parent inspection"
                : "Parent evidence call paused for required sub-agent routing",
            detail: {
              reason: routingBlockReason,
              tool: `${requested.suite}.${requested.name}`,
              evidence_calls: routingState?.evidenceCalls ?? null,
              materialized_chars: routingState?.materializedChars ?? null,
              distinct_targets: routingState?.targets?.size ?? null,
              delegated_targets: routingState?.delegatedTargets?.size ?? null,
              mutated: routingState?.mutated ?? null,
              parent_agent_call_id: session?.bootConfig?.agentCallId ?? null,
            },
          });
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: {
              jsonrpc: "2.0",
              id: message?.id ?? null,
              result: subAgentRoutingGuardResult(routingBlockReason),
            },
          });
          return;
        }
        if (requested.suite === "tools" && requested.name === "agent_handoff") {
          try {
            assertSubAgentParentReady(session?.bootConfig?.agentCallId);
            preparedSubAgentHandoff = prepareSubAgentHandoff(
              session?.bootConfig?.agentCallId,
              toolArgs,
            );
          } catch (error) {
            recordAgentHandoffRejection(session?.bootConfig?.agentCallId, error);
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: `Error executing agent_handoff: ${String(error?.message || error).slice(0, 500)}` }],
                  isError: true,
                },
              },
            });
            return;
          }
        }
        if (requested.name !== "agent_handoff"
          && rejectAgentHandoffForLaterTool(session?.bootConfig?.agentCallId, requested.name || toolName)) {
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: {
              jsonrpc: "2.0",
              id: message?.id ?? null,
              result: {
                content: [{
                  type: "text",
                  text: "agent_handoff was already staged; later tool calls invalidate the terminal report",
                }],
                isError: true,
              },
            },
          });
          return;
        }
        if (requested.suite === "tools" && requested.name === "sub_agent_next_input") {
          const startedAt = Date.now();
          try {
            const result = await executeSubAgentNextInput(toolArgs, {
              context: {
                workItemId: session?.bootConfig?.workItemId,
                jobId: session?.bootConfig?.jobId,
                attemptId: session?.bootConfig?.attemptId,
                agentCallId: session?.bootConfig?.agentCallId,
              },
            });
            recordObservation({
              work_item_id: session?.bootConfig?.workItemId ?? null,
              job_id: session?.bootConfig?.jobId ?? null,
              attempt_id: session?.bootConfig?.attemptId ?? null,
              observation_type: "tool.sub_agent_next_input",
              summary: `Sub-agent input ${toolArgs?.position ?? "?"} materialized`,
              detail: {
                position: toolArgs?.position ?? null,
                requested_count: toolArgs?.count ?? 1,
                ...subAgentInputObservationDetails(result),
                ok: result?.ok === true,
                next_position: result?.next_position ?? null,
                child_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                duration_ms: Date.now() - startedAt,
              },
            });
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  isError: false,
                },
              },
            });
          } catch (error) {
            const rawCode = String(error?.code || "SUB_AGENT_ERROR").trim();
            const errorCode = /^[A-Z0-9_]{3,80}$/.test(rawCode)
              ? rawCode
              : "SUB_AGENT_ERROR";
            recordObservation({
              work_item_id: session?.bootConfig?.workItemId ?? null,
              job_id: session?.bootConfig?.jobId ?? null,
              attempt_id: session?.bootConfig?.attemptId ?? null,
              observation_type: "tool.sub_agent_next_input.error",
              summary: `Sub-agent input ${toolArgs?.position ?? "?"} rejected`,
              detail: {
                position: toolArgs?.position ?? null,
                code: errorCode,
                stage: String(error?.stage || "runtime").slice(0, 40),
                retryable: error?.retryable === true,
                child_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                duration_ms: Date.now() - startedAt,
              },
            });
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: `Error executing sub_agent_next_input: ${String(error?.message || error).slice(0, 500)}` }],
                  isError: true,
                },
              },
            });
          }
          return;
        }
        if (requested.suite === "tools" && requested.name === "sub_agent") {
          const startedAt = Date.now();
          try {
            const result = await executeSubAgent(toolArgs, {
              context: {
                workItemId: session?.bootConfig?.workItemId,
                jobId: session?.bootConfig?.jobId,
                attemptId: session?.bootConfig?.attemptId,
                agentCallId: session?.bootConfig?.agentCallId,
              },
            });
            recordObservation({
              work_item_id: session?.bootConfig?.workItemId ?? null,
              job_id: session?.bootConfig?.jobId ?? null,
              attempt_id: session?.bootConfig?.attemptId ?? null,
              observation_type: "tool.sub_agent",
              summary: `Sub-agent ${toolArgs?.op || "operation"} completed`,
              detail: {
                op: toolArgs?.op || null,
                batch_id: result?.batch_id || toolArgs?.batch_id || null,
                status: result?.status || null,
                completion_mode: result?.mode || toolArgs?.completion?.mode || null,
                wait_ms: toolArgs?.wait_ms ?? null,
                request_count: Array.isArray(result?.requests) ? result.requests.length : null,
                results: subAgentObservationResults(result?.results),
                parent_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                duration_ms: Date.now() - startedAt,
              },
            });
            noteSubAgentRoutingSuccess(
              routingState,
              requested,
              toolArgs,
              result,
              subAgentRoutingContext(session),
            );
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  isError: false,
                },
              },
            });
          } catch (error) {
            const rawCode = String(error?.code || "SUB_AGENT_ERROR").trim();
            const errorCode = /^[A-Z0-9_]{3,80}$/.test(rawCode)
              ? rawCode
              : "SUB_AGENT_ERROR";
            recordObservation({
              work_item_id: session?.bootConfig?.workItemId ?? null,
              job_id: session?.bootConfig?.jobId ?? null,
              attempt_id: session?.bootConfig?.attemptId ?? null,
              observation_type: "tool.sub_agent.error",
              summary: `Sub-agent ${toolArgs?.op || "operation"} rejected`,
              detail: {
                op: toolArgs?.op || null,
                code: errorCode,
                stage: String(error?.stage || "runtime").slice(0, 40),
                retryable: error?.retryable === true,
                ...(errorCode === "SUB_AGENT_INPUT_TOOL_FORBIDDEN" && error?.inputTool
                  ? { input_tool: String(error.inputTool).slice(0, 160) }
                  : {}),
                parent_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                duration_ms: Date.now() - startedAt,
              },
            });
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: `Error executing sub_agent: ${String(error?.message || error).slice(0, 500)}` }],
                  isError: true,
                },
              },
            });
          }
          return;
        }
        if (requested.suite === "atlas") {
          const response = policy?.atlasResearcherWorkflow === true
            && requested.name === "workflow"
            ? await this._executeResearcherWorkflowCall({
                message,
                session,
                toolArgs,
                delegatedEvidence,
              })
            : await this._executeAtlasToolCall({
                message,
                session,
                toolName,
                toolArgs,
                providerTransforms: routedTool.transforms,
                delegatedEvidence,
              });
          if (rejectAgentHandoffForLaterTool(
            session?.bootConfig?.agentCallId,
            requested.name || toolName,
          )) {
            sendJson(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{
                    type: "text",
                    text: "agent_handoff was staged while this ATLAS tool was running; the terminal report was invalidated",
                  }],
                  isError: true,
                },
              },
            });
            return;
          }
          const reminder = mcpToolCallSuccess(response) && !delegatedEvidence
            ? noteSubAgentRoutingSuccess(
                routingState,
                requested,
                toolArgs,
                response,
                subAgentRoutingContext(session),
              )
            : "";
          const finalizedResponse = appendToolResultText(response, reminder, {
            kind: "sub_agent_routing_checkpoint",
            trigger: "parent_evidence_threshold",
          });
          if (finalizedResponse !== response) {
            recordOwnerModelControlNotice(session, requested.name || toolName, {
              kind: "sub_agent_routing_checkpoint",
              text: reminder,
              trigger: "parent_evidence_threshold",
            });
          }
          sendJson(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: finalizedResponse,
          });
          return;
        }
      }
      let response = await this._gatewaySession.request(injectSessionContext(message, session, {
        delegatedEvidence,
      }));
      if (message.method === "tools/call") {
        const requested = requestedToolPolicyName(
          String(message?.params?.name || ""),
          message?.params?.arguments || {},
        );
        if (preparedSubAgentHandoff
          && requested.suite === "tools"
          && requested.name === "agent_handoff"
          && mcpToolCallSuccess(response)) {
          sealSubAgentHandoff(session?.bootConfig?.agentCallId);
        }
        const signal = subAgentCompletionSignal(
          session?.bootConfig?.agentCallId,
          requested.name || String(message?.params?.name || ""),
        );
        const content = response?.result?.content;
        if (signal && Array.isArray(content)) {
          const priorResponse = response;
          response = appendToolResultText(priorResponse, signal, {
            kind: "sub_agent_completion_signal",
            trigger: "completed_child_work",
          });
          if (response !== priorResponse) {
            recordOwnerModelControlNotice(session, requested.name, {
              kind: "sub_agent_completion_signal",
              text: signal,
              trigger: "completed_child_work",
            });
          }
        }
        if (mcpToolCallSuccess(response) && !delegatedEvidence) {
          const reminder = noteSubAgentRoutingSuccess(
            subAgentRoutingEnabled(policy)
              ? session._subAgentRouting
              : null,
            requested,
            message?.params?.arguments || {},
            response,
            subAgentRoutingContext(session),
          );
          const priorResponse = response;
          response = appendToolResultText(priorResponse, reminder, {
            kind: "sub_agent_routing_checkpoint",
            trigger: "parent_evidence_threshold",
          });
          if (response !== priorResponse) {
            recordOwnerModelControlNotice(session, requested.name, {
              kind: "sub_agent_routing_checkpoint",
              text: reminder,
              trigger: "parent_evidence_threshold",
            });
          }
        }
      }
      if (message.method === "tools/call" && mcpToolCallSuccess(response)) {
        void this._scheduleAtlasWriteRefresh({ message, session, response }).catch((err) => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.atlas_write_refresh",
            ...attachTelemetryContext(session, this.bootId),
            outcome: "error",
            duration_ms: 0,
            error: ownerErrorSummary(err),
          });
        });
      }
      if (message.method === "tools/list") {
        response = filterToolsListMessage(response, policy);
        const count = session.noteToolsList(response);
        this._logAttachProof(session, "mcp.attach.tools_list_seen", {
          method,
          tool_count: count,
          tool_names: session.attachProof.toolsListNames,
          tool_names_sha256: session.attachProof.toolsListSha256,
          agent_handoff_schema_name: session.attachProof.agentHandoffToolSchemaName,
          agent_handoff_schema_sha256: session.attachProof.agentHandoffToolSchemaSha256,
          agent_handoff_schema_chars: session.attachProof.agentHandoffToolSchemaChars,
          request_count: session.attachProof.requestCount,
        });
      }
      const completedTool = message.method === "tools/call"
        ? requestedToolPolicyName(
            String(message?.params?.name || ""),
            message?.params?.arguments || {},
          )
        : null;
      const terminalHandoffReceipt = completedTool?.suite === "tools"
        && completedTool.name === "agent_handoff"
        && mcpToolCallSuccess(response);
      sendJson(res, 200, {
        ok: true,
        bootId: this.bootId,
        sessionId: id,
        message: response,
        ...(terminalHandoffReceipt ? { terminalHandoffReceipt: true } : {}),
      });
    } catch (err) {
      session.noteOwnerError(err, method);
      this._logAttachProof(session, "mcp.attach.owner_error", {
        method,
        request_count: session.attachProof.requestCount,
        error: ownerErrorSummary(err),
      });
      sendJson(res, 500, {
        ok: false,
        bootId: this.bootId,
        sessionId: id,
        error: String(err?.message || err),
      });
    }
  }

  // Synchronous budget reservation shared by the concurrent and serial paths.
  // Reads durable observed steps, ratchets against the per-ATTEMPT reservation
  // map (two live sessions for one attempt must not each claim the same
  // terminal slot), and assigns the next dense step in one event-loop turn so
  // parallel admissions cannot race the exploration ceiling. Consulting the
  // reservation map on the serial path also keeps a swallowed observation
  // write from re-admitting an already-consumed step number.
  _mappedSymbolFollowup(session, effectiveAction, toolArgs = {}) {
    if (effectiveAction !== "code.window" || !toolArgs?.symbolId || toolArgs?.file) return false;
    const boot = session?.bootConfig || {};
    const attemptId = Number(boot.attemptId) || null;
    if (!attemptId) return false;
    const owner = sourceCoverageOwnerForSession(session, boot);
    const wanted = String(toolArgs.symbolId).trim().toLowerCase();
    try {
      const rows = owner.db.prepare(`
        SELECT detail_json
        FROM job_observations
        WHERE attempt_id = ? AND observation_type = 'tool.atlas'
        ORDER BY id DESC
      `).all(attemptId);
      for (const row of rows) {
        let detail;
        try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
        const mapping = (Array.isArray(detail?.symbol_source_paths) ? detail.symbol_source_paths : [])
          .find((entry) => String(entry?.symbol_id || "").trim().toLowerCase() === wanted);
        if (!mapping?.repo_rel_path) continue;
        return owner.hasDeliveredCoverageForPath(mapping.repo_rel_path);
      }
    } catch { /* fail safe: charge the unit */ }
    return false;
  }

  _reserveResearchPhysicalCall(session, effectiveAction) {
    const boot = session?.bootConfig || {};
    if (
      String(boot.role || "") !== "researcher"
      || !isResearchAtlasExplorationAction(effectiveAction)
    ) return null;
    const reservationKey = researchBudgetKey(boot);
    const observed = researchExplorationObservationStatus({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    });
    const assigned = Math.max(
      Math.max(0, Number(observed.call_steps || 0)),
      Number(this._researchCallReservations.get(reservationKey) || 0),
    ) + 1;
    this._researchCallReservations.set(reservationKey, assigned);
    return assigned;
  }

  _refundResearchInfrastructureFailure(session, admission, result, error = null) {
    if (!admission?.tracked || admission.citationFetch) return false;
    const structuredError = ownerToolStructuredError(result, error);
    if (!isResearchInfrastructureFailure(structuredError)) return false;
    const boot = session?.bootConfig || {};
    const reservationKey = researchBudgetKey(boot);
    const observed = researchExplorationObservationStatus({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    });
    const refunded = Math.max(
      Number(observed.infrastructure_refunds || 0),
      Number(this._researchInfrastructureRefundReservations.get(reservationKey) || 0),
    );
    if (refunded >= RESEARCH_INFRASTRUCTURE_REFUND_LIMIT) return false;
    this._researchInfrastructureRefundReservations.set(reservationKey, refunded + 1);
    if (admission.explorationUnitKind === "request"
      && admission.explorationUnitWeight !== 0
      && Number(this._researchAdmissionReservations.get(reservationKey)) === admission.assignedExplorationStep) {
      this._researchAdmissionReservations.set(
        reservationKey,
        Math.max(Number(observed.exploration_steps || 0), Number(admission.assignedExplorationStep || 1) - 1),
      );
    }
    if (Number(this._researchCallReservations.get(reservationKey)) === admission.assignedPhysicalCallStep) {
      this._researchCallReservations.set(
        reservationKey,
        Math.max(Number(observed.call_steps || 0), Number(admission.assignedPhysicalCallStep || 1) - 1),
      );
    }
    return true;
  }

  _admitResearchExploration(session, effectiveAction, {
    explorationUnitKind = "request",
    explorationUnitWeight = 1,
    symbolFollowupDiscounted = false,
  } = {}) {
    const boot = session?.bootConfig || {};
    if (
      String(boot.role || "") !== "researcher"
      || !isResearchAtlasExplorationAction(effectiveAction)
    ) {
      return ownerResearchSynthesisAdmission(session, effectiveAction);
    }
    const reservationKey = researchBudgetKey(boot);
    const observed = researchExplorationObservationStatus({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    });
    const observedSteps = Math.max(0, Number(observed.exploration_steps || 0));
    const highestReserved = Math.max(
      observedSteps,
      Number(this._researchAdmissionReservations.get(reservationKey) || 0),
    );
    const assignedExplorationStep = highestReserved + 1;
    const reservableCeiling = researchSynthesisExplorationCeiling({
      staleSteps: observed.stale_steps,
    });
    if (explorationUnitWeight !== 0 && assignedExplorationStep <= reservableCeiling) {
      this._researchAdmissionReservations.set(reservationKey, assignedExplorationStep);
    }
    const admission = ownerResearchSynthesisAdmission(
      session,
      effectiveAction,
      { assignedExplorationStep, explorationUnitWeight, symbolFollowupDiscounted },
    );
    return {
      ...admission,
      explorationUnitId: `${reservationKey}:${assignedExplorationStep}:${this.bootId}:${this._researchExplorationUnitSequence += 1}`,
      explorationUnitKind,
      explorationUnitWeight: explorationUnitWeight === 0 ? 0 : 1,
      symbolFollowupDiscounted: symbolFollowupDiscounted === true,
    };
  }

  _deleteResearchAtlasBatch(queueKey, expectedBatch = null) {
    const batch = this._activeResearchAtlasBatches.get(queueKey);
    if (!batch || (expectedBatch && batch !== expectedBatch)) return false;
    if (batch.idleTimer) clearTimeout(batch.idleTimer);
    batch.idleTimer = null;
    this._activeResearchAtlasBatches.delete(queueKey);
    return true;
  }

  _trackResearchAtlasBatchRequest(queueKey, batch, request, { concurrentRead = false } = {}) {
    if (!batch) return;
    if (batch.idleTimer) clearTimeout(batch.idleTimer);
    batch.idleTimer = null;
    batch.active.add(request);
    if (concurrentRead) {
      batch.reads.add(request);
      this._activeResearchAtlasReads.set(queueKey, batch.reads);
    }
    const release = () => {
      batch.active.delete(request);
      if (concurrentRead) {
        batch.reads.delete(request);
        if (
          batch.reads.size === 0
          && this._activeResearchAtlasReads.get(queueKey) === batch.reads
        ) {
          this._activeResearchAtlasReads.delete(queueKey);
        }
      }
      if (
        batch.active.size > 0
        || this._activeResearchAtlasBatches.get(queueKey) !== batch
      ) {
        return;
      }
      // Provider transports can deliver one structured parallel emission in
      // several short waves. Retain every concurrent-read unit across that
      // idle gap, not only the terminal unit.
      batch.idleTimer = setTimeout(() => {
        if (batch.active.size === 0) this._deleteResearchAtlasBatch(queueKey, batch);
      }, this._researchAtlasTerminalBatchIdleMs);
      batch.idleTimer.unref?.();
    };
    void request.then(release, release);
  }

  async _executeResearcherWorkflowCall({
    message,
    session,
    toolArgs,
    delegatedEvidence = false,
  }) {
    const startedAt = Date.now();
    const problem = researcherWorkflowInputProblem(toolArgs);
    if (problem) {
      const result = mcpToolErrorPayload(`Invalid typed Atlas workflow: ${problem}`);
      recordOwnerToolObservation({
        session,
        toolName: "atlas.workflow",
        toolArgs,
        result,
        durationMs: Date.now() - startedAt,
        executor: { via: "researcher_typed_workflow", stage: "validation" },
      });
      return mcpToolResultMessage(message, result);
    }

    const steps = toolArgs.steps;
    const priorResults = [];
    const priorById = new Map();
    const results = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const action = normalizeAtlasActionName(step.action);
      let resolvedArgs;
      try {
        resolvedArgs = resolveWorkflowRefs(step.args, priorResults, priorById);
      } catch (err) {
        const error = String(err?.message || err || "workflow reference resolution failed");
        const result = mcpToolErrorPayload(`Typed Atlas workflow step ${index} (${action}) failed before execution: ${error}`);
        recordOwnerToolObservation({
          session,
          toolName: "atlas.workflow",
          toolArgs,
          result,
          durationMs: Date.now() - startedAt,
          executor: { via: "researcher_typed_workflow", stage: "reference_resolution", step: index, action },
        });
        return mcpToolResultMessage(message, result);
      }

      const innerMessage = {
        jsonrpc: "2.0",
        id: `${String(message?.id ?? "workflow")}:${index}`,
        method: "tools/call",
        params: { name: `atlas.${action}`, arguments: resolvedArgs },
      };
      const response = await this._executeAtlasToolCall({
        message: innerMessage,
        session,
        toolName: `atlas.${action}`,
        toolArgs: resolvedArgs,
        delegatedEvidence,
      });
      const innerResult = response?.result && typeof response.result === "object"
        ? response.result
        : mcpToolErrorPayload(`Typed Atlas workflow step ${index} (${action}) returned no MCP result`);
      const output = researcherWorkflowStepOutput(innerResult);
      const entry = {
        stepIndex: index,
        ...(step.id ? { id: String(step.id) } : {}),
        action,
        status: innerResult.isError === true ? "error" : "ok",
        result: output.value,
        ...(output.remainder ? { remainder: output.remainder } : {}),
      };
      results.push(entry);
      if (innerResult.isError === true) {
        return mcpToolResultMessage(message, {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              action: "workflow",
              failedStep: index,
              results,
            }),
          }],
          isError: true,
          _meta: {
            atlasResearcherWorkflow: {
              version: 1,
              status: "error",
              stepsRequested: steps.length,
              stepsExecuted: results.length,
            },
          },
        });
      }
      priorResults.push(output.value);
      if (step.id) priorById.set(String(step.id), output.value);
      if ((innerResult?.[OWNER_MODEL_CONTROL_NOTICES] || []).length > 0) {
        return mcpToolResultMessage(message, {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: "workflow",
              stopped: true,
              reason: "owner_control_notice",
              results,
            }),
          }],
          isError: false,
          _meta: {
            atlasResearcherWorkflow: {
              version: 1,
              status: "stopped",
              stepsRequested: steps.length,
              stepsExecuted: results.length,
            },
          },
        });
      }
    }

    appendRunTelemetry("diagnostics", {
      kind: "mcp.owner.atlas_researcher_workflow",
      ...attachTelemetryContext(session, this.bootId),
      outcome: "ok",
      duration_ms: Date.now() - startedAt,
      steps_requested: steps.length,
      steps_executed: results.length,
      actions: results.map((entry) => entry.action),
    });
    return mcpToolResultMessage(message, {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, action: "workflow", results }),
      }],
      isError: false,
      _meta: {
        atlasResearcherWorkflow: {
          version: 1,
          status: "ok",
          stepsRequested: steps.length,
          stepsExecuted: results.length,
        },
      },
    });
  }

  async _executeAtlasToolCall(args) {
    const binding = args?.binding || gatewayBindingSnapshot(args?.session);
    const boot = binding.bootConfig;
    const queueKey = [
      boot.jobId ?? "no-job",
      boot.attemptId ?? "no-attempt",
      binding.epoch ?? binding.key,
      args?.session?.id || "no-session",
    ].join(":");
    const requested = requestedToolPolicyName(args?.toolName, args?.toolArgs);
    const effectiveAction = effectiveAtlasResearchAction(requested);
    const enqueuedAt = Date.now();
    const researchExploration = String(boot.role || "") === "researcher"
      && isResearchAtlasExplorationAction(effectiveAction);
    const symbolFollowupDiscounted = researchExploration
      && this._mappedSymbolFollowup(args?.session, effectiveAction, args?.toolArgs || {});
    let researchBatch = this._activeResearchAtlasBatches.get(queueKey) || null;
    if (researchExploration && !researchBatch) {
      const admission = this._admitResearchExploration(
        args?.session,
        effectiveAction,
        {
          explorationUnitKind: CONCURRENT_RESEARCH_ATLAS_ACTIONS.has(effectiveAction)
            ? "concurrent_read_batch"
            : "request",
          explorationUnitWeight: symbolFollowupDiscounted ? 0 : 1,
          symbolFollowupDiscounted,
        },
      );
      researchBatch = {
        admission,
        active: new Set(),
        reads: new Set(),
        idleTimer: null,
        terminal: isTerminalResearchExplorationAdmission(admission),
      };
      this._activeResearchAtlasBatches.set(queueKey, researchBatch);
    } else if (researchExploration && researchBatch?.admission?.explorationUnitWeight === 0 && !symbolFollowupDiscounted) {
      researchBatch.admission.explorationUnitWeight = 1;
      researchBatch.admission.symbolFollowupDiscounted = false;
      const reservationKey = researchBudgetKey(boot);
      this._researchAdmissionReservations.set(
        reservationKey,
        researchBatch.admission.assignedExplorationStep,
      );
    } else if (!researchExploration && !researchBatch?.terminal) {
      researchBatch = null;
    }
    const assignedPhysicalCallStep = researchExploration
      ? this._reserveResearchPhysicalCall(args?.session, effectiveAction)
      : null;
    const synthesisAdmission = researchExploration && researchBatch?.admission
      ? {
          ...ownerResearchSynthesisAdmission(args?.session, effectiveAction, {
            assignedExplorationStep: researchBatch.admission.assignedExplorationStep,
            assignedPhysicalCallStep,
            explorationUnitWeight: researchBatch.admission.explorationUnitWeight,
            symbolFollowupDiscounted,
          }),
          explorationUnitId: researchBatch.admission.explorationUnitId,
          explorationUnitKind: researchBatch.admission.explorationUnitKind,
          explorationUnitWeight: researchBatch.admission.explorationUnitWeight,
          symbolFollowupDiscounted,
        }
      : null;
    if (researchBatch && isTerminalResearchExplorationAdmission(synthesisAdmission)) {
      researchBatch.terminal = true;
    }
    const concurrentResearchRead = researchExploration
      && CONCURRENT_RESEARCH_ATLAS_ACTIONS.has(effectiveAction)
      && !this._atlasToolCallQueues.has(queueKey);
    if (concurrentResearchRead) {
      const current = this._executeAtlasToolCallNow({ ...args, binding, synthesisAdmission, enqueuedAt });
      this._trackResearchAtlasBatchRequest(queueKey, researchBatch, current, {
        concurrentRead: true,
      });
      return current;
    }
    const prior = this._atlasToolCallQueues.get(queueKey) || Promise.resolve();
    const current = prior
      .catch(() => {})
      .then(async () => {
        const activeReads = [...(this._activeResearchAtlasReads.get(queueKey) || [])];
        if (activeReads.length > 0) await Promise.allSettled(activeReads);
        return this._executeAtlasToolCallNow({
          ...args,
          binding,
          synthesisAdmission,
          enqueuedAt,
        });
      });
    this._trackResearchAtlasBatchRequest(queueKey, researchBatch, current);
    const tail = current.catch(() => {});
    this._atlasToolCallQueues.set(queueKey, tail);
    void tail.finally(() => {
      if (this._atlasToolCallQueues.get(queueKey) === tail) {
        this._atlasToolCallQueues.delete(queueKey);
      }
    });
    return current;
  }

  async _executeAtlasToolCallNow({
    message,
    session,
    toolName,
    toolArgs,
    binding,
    providerTransforms = [],
    delegatedEvidence = false,
    synthesisAdmission: reservedSynthesisAdmission = null,
    enqueuedAt = null,
  }) {
    const startedAt = Date.now();
    // Serial calls can sit behind the per-session promise queue; duration_ms
    // alone hides that wall-clock cost, so surface the wait separately.
    const queueWaitMs = enqueuedAt != null ? Math.max(0, startedAt - enqueuedAt) : 0;
    if (!gatewayBindingIsCurrent(session, binding)) {
      return staleGatewayBindingToolResult(message);
    }
    const context = attachTelemetryContext(session, this.bootId, binding?.bootConfig);
    const requested = requestedToolPolicyName(toolName, toolArgs);
    let coverageReservationsToRelease = [];
    let contextHeadroomReservation = null;
    let coverageObservationCursor = 0;
    let activeCoverageOwner = null;
    let activeCoverageAdmissions = [];
    let nativeSourceExecutionStarted = false;
    if (requested.name === "code.window" && Array.isArray(toolArgs?.items)) {
      const result = mcpToolErrorPayload(
        "code.window multi-selection is disabled; issue independent scalar calls together",
      );
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        executor: { via: "scalar_window_contract" },
      });
      return mcpToolResultMessage(message, result);
    }
    const memoryAction = isMemoryToolAction(requested.name);
    if (memoryAction && this._terminalMemoryToolSessions.has(session)) {
      const result = terminalMemoryToolRejection(requested.name);
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        executor: { via: "memory_terminal_gate" },
      });
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_tool_call",
        ...context,
        outcome: "rejected",
        tool_name: toolName,
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: queueWaitMs,
        reason: "memory_tools_disabled_for_run",
      });
      return mcpToolResultMessage(message, result);
    }
    const synthesisAdmission = reservedSynthesisAdmission
      || this._admitResearchExploration(session, effectiveAtlasResearchAction(requested));
    if (synthesisAdmission.synthesisRequired) {
      recordOwnerResearchSynthesisRequired(
        session,
        synthesisAdmission,
        toolName,
      );
    }
    if (synthesisAdmission.blocked) {
      if (session?.bootConfig?.attemptId != null) {
        recordObservation({
          work_item_id: session.bootConfig.workItemId ?? null,
          job_id: session.bootConfig.jobId ?? null,
          attempt_id: session.bootConfig.attemptId,
          observation_type: "research.exploration_blocked",
          summary: `Research exploration blocked: ${synthesisAdmission.blockReason || "closeout"}`,
          detail: {
            action: effectiveAtlasResearchAction(requested),
            physical_request: 1,
            consumed_step: false,
            exploration_steps: synthesisAdmission.explorationSteps,
            unit_steps: synthesisAdmission.explorationSteps,
            call_steps: synthesisAdmission.callSteps,
            symbol_followups_discounted: synthesisAdmission.symbolFollowupsDiscounted,
            stale_steps: synthesisAdmission.staleSteps,
            reason: synthesisAdmission.blockReason || "closeout",
          },
        });
      }
      const gateText = synthesisAdmission.citationFetch
        ? buildResearchCitationFetchGateText({ reason: synthesisAdmission.blockReason })
        : buildResearchSynthesisRequiredText({
          explorationSteps: synthesisAdmission.explorationSteps,
          staleSteps: synthesisAdmission.staleSteps,
          absoluteCeilingReached: ["exploration_ceiling", "physical_call_ceiling"].includes(synthesisAdmission.blockReason),
        });
      const result = tagOwnerModelControlNotice({
        content: [{
          type: "text",
          text: gateText,
        }],
        // Closeout and final-fetch gates are terminal admission decisions, not
        // execution failures. A normal MCP result prevents provider tool-error
        // recovery from reopening the exploration tail.
        isError: false,
      }, gateText, {
        kind: synthesisAdmission.citationFetch
          ? "research_citation_fetch_gate"
          : "research_closeout_gate",
        trigger: synthesisAdmission.blockReason,
        explorationStep: synthesisAdmission.assignedExplorationStep,
      });
      for (const notice of result?.[OWNER_MODEL_CONTROL_NOTICES] || []) {
        recordOwnerModelControlNotice(session, toolName, notice);
      }
      appendRunTelemetry("diagnostics", {
        kind: synthesisAdmission.citationFetch
          ? "mcp.owner.research_citation_fetch_gate"
          : "mcp.owner.research_synthesis_gate",
        ...context,
        outcome: "rejected",
        tool_name: toolName,
        exploration_steps: synthesisAdmission.explorationSteps,
        unit_steps: synthesisAdmission.explorationSteps,
        call_steps: synthesisAdmission.callSteps,
        symbol_followups_discounted: synthesisAdmission.symbolFollowupsDiscounted,
        citation_fetches: synthesisAdmission.citationFetches,
        citation_fetch_batches: synthesisAdmission.citationFetchBatches,
        reason: synthesisAdmission.blockReason,
        duration_ms: Date.now() - startedAt,
      });
      if (requested.name === "code.window") {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          entries: sourceSelectionItems(toolArgs).map(() => ({
            outcome: "blocked",
            reason: synthesisAdmission.blockReason || "research_closeout",
            reasonClass: "suppression",
          })),
        });
      }
      return mcpToolResultMessage(message, result);
    }
    try {
      const skeletonRedirect = surveyAwareSkeletonRedirect(session, requested, toolArgs || {});
      if (skeletonRedirect) {
        let result = appendOwnerOperatorFeedbackDelivery(skeletonRedirect, session, toolName);
        result = appendOwnerResearchSynthesisNotice(
          result,
          session,
          toolName,
          synthesisAdmission,
        );
        session.noteAtlasGateEvent?.({
          action: "code.skeleton",
          args: toolArgs,
          ok: true,
          empty: false,
        });
        recordSurveyAwareSkeletonRedirect(session, toolName, toolArgs, result);
        recordOwnerToolObservation({
          session,
          toolName,
          toolArgs,
          result,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          executor: { via: "survey_aware_skeleton_redirect" },
          synthesisAdmission,
        });
        appendRunTelemetry("diagnostics", {
          kind: "mcp.owner.atlas_skeleton_after_survey",
          ...context,
          outcome: "redirected",
          tool_name: toolName,
          file: toolArgs?.file || null,
          duration_ms: Date.now() - startedAt,
          queue_wait_ms: queueWaitMs,
        });
        return mcpToolResultMessage(message, result);
      }
      if (isAtlasFetchRefTool(toolName, toolArgs) || isAtlasCreateHashTool(toolName, toolArgs)) {
        const createRef = isAtlasCreateHashTool(toolName, toolArgs);
        const hashContext = { context: hashRefToolContext(session) };
        const traversalInputs = createRef ? null : hashRefTraversalInputs(toolArgs || {});
        const priorDeliveredTraversalRefs = createRef ? null : deliveredTraversalRefSet(session);
        const availableTraversalRefs = createRef
          ? null
          : listHashRefTraversalsForContext(hashContext.context)
              .filter((entry) => !priorDeliveredTraversalRefs.has(entry.ref)).length;
        const traversalText = createRef
          ? null
          : fetchHashRefTool(toolArgs || {}, {
              ...hashContext,
              researchPhase: synthesisAdmission.researchPhase || null,
              enforcePolicy: roleUsesBoundedRefTraversal(session?.bootConfig?.role),
              requireTraversal: isCanonicalAtlasTraversalTool(toolName, toolArgs),
            });
        const deliveredRefs = createRef
          ? []
          : deliveredTraversalRefs(traversalText, traversalInputs.refs);
        for (const ref of deliveredRefs) priorDeliveredTraversalRefs.add(ref);
        let result = createRef
          ? createRefMcpPayload(createHashRefResult(toolArgs || {}, hashContext))
          : fetchRefMcpPayload(traversalText);
        noteResearcherTypedTraversalPromotion(session, toolName, toolArgs, result);
        for (const transform of providerTransforms) {
          result = annotateOwnerResultTransform(result, transform);
        }
        result = appendOwnerOperatorFeedbackDelivery(result, session, toolName);
        result = appendOwnerResearchEarlyFetchNotice(
          result,
          session,
          toolArgs || {},
          synthesisAdmission,
        );
        result = appendOwnerResearchFinalFetchNotice(result, synthesisAdmission);
        result = appendOwnerResearchSynthesisNotice(
          result,
          session,
          toolName,
          synthesisAdmission,
        );
        recordOwnerToolObservation({
          session,
          toolName,
          toolArgs,
          result,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          executor: { via: "hash_ref_store" },
          observationDetail: createRef ? null : {
            traversal_telemetry_version: 1,
            available_refs: availableTraversalRefs,
            requested_refs: traversalInputs.refs.length,
            delivered_refs: deliveredRefs.length,
          },
          synthesisAdmission,
        });
        appendRunTelemetry("diagnostics", {
          kind: "mcp.owner.atlas_tool_call",
          ...context,
          outcome: result?.isError ? "tool_error" : "ok",
          tool_name: toolName,
          duration_ms: Date.now() - startedAt,
          queue_wait_ms: queueWaitMs,
          result_chars: mcpResultTextChars(result),
          executor: { via: "hash_ref_store" },
        });
        return mcpToolResultMessage(message, result);
      }
      const sourceAdmissionOwner = requested.name === "code.window";
      const coverageOwner = sourceAdmissionOwner || requested.name === "symbol.card"
        ? sourceCoverageOwnerForSession(session, binding?.bootConfig)
        : null;
      activeCoverageOwner = coverageOwner;
      coverageObservationCursor = sourceSelectionCoverageCursor(coverageOwner);
      const windowSelections = sourceAdmissionOwner
        ? [toolArgs || {}]
        : [];
      /** @type {any[]} */
      const coverageAdmissions = [];
      if (sourceAdmissionOwner) {
        for (const selection of windowSelections) {
          const admission = await coverageOwner.admitOrReserve(selection);
          coverageAdmissions.push(admission);
          if (admission?.reservation) {
            coverageReservationsToRelease.push({ owner: coverageOwner, reservation: admission.reservation });
          }
        }
      }
      activeCoverageAdmissions = coverageAdmissions;
      const uncoveredIndexes = coverageAdmissions
        .map((admission, index) => (admission.covered ? null : index))
        .filter((index) => index != null);
      if (sourceAdmissionOwner && uncoveredIndexes.length === 0) {
        const coveredAdmission = coverageAdmissions[0];
        const reuseNotice = sourceEvidenceReuseNotice(coverageOwner, coveredAdmission);
        const coveredPayload = reuseNotice
          ? { ...coveredAdmission.result, message: reuseNotice }
          : coveredAdmission.result;
        let result = mcpToolTextPayload(JSON.stringify(coveredPayload));
        if (reuseNotice) {
          result = tagOwnerModelControlNotice(result, reuseNotice, {
            kind: SOURCE_EVIDENCE_REUSE_NOTICE_KIND,
            trigger: coveredAdmission.reason || "covered_reuse",
          });
        }
        result = appendOwnerOperatorFeedbackDelivery(result, session, toolName);
        result = appendOwnerResearchSynthesisNotice(result, session, toolName, synthesisAdmission);
        recordOwnerToolObservation({
          session, toolName, toolArgs, result,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          executor: { via: "source_coverage" },
          synthesisAdmission,
        });
        recordSourceSelectionObservations({
          session,
          toolArgs,
          coverageOwner,
          coverageCursor: coverageObservationCursor,
          entries: windowSelections.map((_, index) => (
            coveredSourceSelectionObservation(coverageAdmissions[index])
          )),
        });
        return mcpToolResultMessage(message, result);
      }
      const executorArgs = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
      const contextHeadroom = sourceAdmissionOwner && !delegatedEvidence
        ? admitSourceContextHeadroom({
            boot: session?.bootConfig || {},
            args: executorArgs,
          })
        : { allowed: true, reason: delegatedEvidence ? "delegated_child_consumer" : "not_source_window" };
      contextHeadroomReservation = contextHeadroom.reservation || null;
      if (!contextHeadroom.allowed) {
        for (const entry of coverageReservationsToRelease) {
          entry.owner?.settleReservation(entry.reservation, "headroom_blocked");
        }
        coverageReservationsToRelease = [];
        // RH-1: the remediation must name a call form the schema, the owner,
        // and the native executor all accept. `code.window` is scalar-only, so
        // the executable move near the tier is a bounded scalar re-issue with a
        // smaller `maxTokens`, not a rejected `items` batch. When no result
        // budget remains at all, say so instead of proposing an impossible read.
        const result = mcpToolTextPayload(JSON.stringify({
          status: "blocked",
          executed: false,
          reason: `context_headroom_${contextHeadroom.reason}`,
          predictedNextRequestTokens: contextHeadroom.predicted,
          longContextThresholdTokens: contextHeadroom.threshold,
          requestedResultTokens: contextHeadroom.requestedResultTokens,
          availableResultTokens: contextHeadroom.availableResultTokens,
          ...(contextHeadroom.remediable
            ? {
              nextAction: {
                action: "code.window",
                instruction: `Re-issue this same scalar selection with maxTokens at most ${contextHeadroom.availableResultTokens}.`,
              },
              message: `Near the long-context tier, each source read must declare a result bound that fits the remaining budget: re-issue this scalar code.window with maxTokens at most ${contextHeadroom.availableResultTokens}. Independent scalar calls may still be issued together, but they share that remaining budget. Stored evidence re-access and final handoff remain available.`,
            }
            : {
              message: "No source-read budget remains before the long-context tier. Do not retry this read at any maxTokens. Use the evidence already gathered, re-access stored refs, and hand off.",
            }),
        }));
        recordOwnerToolObservation({
          session, toolName, toolArgs, result,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          executor: { via: "context_headroom" },
          synthesisAdmission,
        });
        recordSourceSelectionObservations({
          session,
          toolArgs,
          coverageOwner,
          coverageCursor: coverageObservationCursor,
          entries: windowSelections.map((_, index) => {
            const admission = coverageAdmissions[index];
            if (admission?.covered) return coveredSourceSelectionObservation(admission);
            return {
              outcome: "blocked",
              reason: contextHeadroom.reason || "context_headroom",
              reasonClass: "headroom",
            };
          }),
        });
        return mcpToolResultMessage(message, result);
      }
      const executor = getSharedAtlasToolExecutor();
      const executorStartedAt = Date.now();
      nativeSourceExecutionStarted = sourceAdmissionOwner;
      const executed = await executor.executeTool({
        toolName,
        args: executorArgs,
        session: atlasExecutorSessionContext(session, binding?.bootConfig),
        source: {
          kind: "mcp_owner",
          ownerBootId: this.bootId,
          sessionId: session?.id || null,
        },
      });
      if (!gatewayBindingIsCurrent(session, binding)) {
        releaseSourceContextHeadroomReservation(contextHeadroomReservation);
        contextHeadroomReservation = null;
        for (const entry of coverageReservationsToRelease) {
          entry.owner?.settleReservation(entry.reservation, "stale_binding");
        }
        appendRunTelemetry("diagnostics", {
          kind: "mcp.owner.atlas_tool_call",
          ...context,
          outcome: "discarded",
          tool_name: toolName,
          duration_ms: Date.now() - startedAt,
          queue_wait_ms: queueWaitMs,
          reason: "stale_gateway_binding",
        });
        return staleGatewayBindingToolResult(message);
      }
      let result = executed?.result && typeof executed.result === "object"
        ? executed.result
        : mcpToolErrorPayload("ATLAS executor returned no MCP result");
      if (coverageOwner) {
        result = prepareSourceCoverage(result, coverageOwner, toolArgs || {}, { toolName: requested.name });
      }
      const evidenceResult = result;
      const executorCompletedAt = Date.now();
      const transformStartedAt = Date.now();
      if (memoryAction && result?.isError === true) {
        this._terminalMemoryToolSessions.add(session);
        result = appendTerminalMemoryToolNotice(result);
      }
      session.noteAtlasGateEvent?.({
        action: effectiveAtlasResearchAction(requested) || toolName,
        args: toolArgs,
        ...atlasGateResultState(result),
      });
      result = appendResearcherSymbolHandles(result, session);
      result = appendHashRefToMcpTextResult(result, toolName, toolArgs, session);
      noteResearcherTypedTraversalPromotion(session, toolName, toolArgs, result);
      if (coverageOwner) {
        result = materializeSourceCoverage(result, coverageOwner, toolArgs || {}, { toolName: requested.name });
      }
      result = compactResearcherTypedAtlasResult(result, session, toolName, toolArgs);
      for (const transform of providerTransforms) {
        result = annotateOwnerResultTransform(result, transform);
      }
      for (const admission of coverageAdmissions) {
        coverageOwner?.settleReservation(admission.reservation, result?.isError ? "failed" : "confirmed");
      }
      coverageReservationsToRelease = [];
      // F1: a delivered result's tokens are not spent when the call returns —
      // they sit in the model's context until the next provider request carries
      // them. Releasing here made every serialized read see an empty scope, so
      // roles on the serial queue (every role but researcher) admitted N reads
      // against the same budget. The reservation therefore outlives the queue
      // slot and is dropped by `supersede()` once a newer checkpoint proves the
      // request that consumed it has been made, with the scope TTL as backstop.
      // A result that was NOT delivered still releases at the throw,
      // stale-binding, and blocked sites below.
      if (result?.isError) releaseSourceContextHeadroomReservation(contextHeadroomReservation);
      contextHeadroomReservation = null;
      // ATLAS calls are the bulk of a retrieval-phase agent's tool traffic;
      // attaching here ensures an Atlas-only phase receives pending operator
      // feedback at its next result boundary.
      this._refundResearchInfrastructureFailure(session, synthesisAdmission, result);
      result = appendOwnerOperatorFeedbackDelivery(result, session, toolName);
      result = appendOwnerResearcherTypedReadyCallBatchingNotice(result, session);
      result = appendOwnerResearchSynthesisNotice(
        result,
        session,
        toolName,
        synthesisAdmission,
      );
      const ownerTransformMs = Math.max(0, Date.now() - transformStartedAt);
      const executorDiagnostics = {
        ...(executed?.executor || {}),
        timings_ms: {
          ...(executed?.executor?.timings_ms || {}),
          owner_executor_await: Math.max(0, executorCompletedAt - executorStartedAt),
          owner_result_transform: ownerTransformMs,
        },
      };
      const resultChars = mcpResultTextChars(result);
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        evidenceResult,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        executor: executorDiagnostics,
        synthesisAdmission,
      });
      if (coverageOwner) {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          coverageOwner,
          coverageCursor: coverageObservationCursor,
          evidenceResult,
          entries: windowSelections.map((_, index) => {
            const admission = coverageAdmissions[index];
            if (admission?.covered) return coveredSourceSelectionObservation(admission);
            return { outcome: "executed", reason: "native_execution", reasonClass: null };
          }),
        });
      }
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_tool_call",
        ...context,
        outcome: result?.isError ? "tool_error" : "ok",
        tool_name: toolName,
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: queueWaitMs,
        result_chars: resultChars,
        over_client_clip: resultChars > CLIENT_RESULT_CLIP_CHARS,
        executor: executorDiagnostics,
      });
      return mcpToolResultMessage(message, result);
    } catch (err) {
      for (const entry of coverageReservationsToRelease) {
        entry.owner?.settleReservation(entry.reservation, "failed");
      }
      releaseSourceContextHeadroomReservation(contextHeadroomReservation);
      contextHeadroomReservation = null;
      if (!gatewayBindingIsCurrent(session, binding)) {
        return staleGatewayBindingToolResult(message);
      }
      session.noteAtlasGateEvent?.({
        action: effectiveAtlasResearchAction(requested) || toolName,
        args: toolArgs,
        ok: false,
        empty: false,
      });
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_tool_call",
        ...context,
        outcome: "error",
        tool_name: toolName,
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: queueWaitMs,
        error: ownerErrorSummary(err),
      });
      let result = mcpToolErrorPayload(
        String(err?.message || err || "ATLAS tool execution failed"),
        err,
        { cwd: session?.bootConfig?.cwd },
      );
      if (memoryAction) {
        this._terminalMemoryToolSessions.add(session);
        result = appendTerminalMemoryToolNotice(result);
      }
      this._refundResearchInfrastructureFailure(session, synthesisAdmission, result, err);
      result = appendOwnerResearchSynthesisNotice(
        result,
        session,
        toolName,
        synthesisAdmission,
      );
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        error: err,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        synthesisAdmission,
      });
      if (requested.name === "code.window") {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          coverageOwner: activeCoverageOwner,
          coverageCursor: coverageObservationCursor,
          entries: sourceSelectionItems(toolArgs).map((_, index) => {
            const admission = activeCoverageAdmissions[index];
            if (admission?.covered) return coveredSourceSelectionObservation(admission);
            return nativeSourceExecutionStarted
              ? { outcome: "executed", reason: "execution_error", reasonClass: "suppression" }
              : { outcome: "blocked", reason: "pre_execution_error", reasonClass: "suppression" };
          }),
        });
      }
      return mcpToolResultMessage(
        message,
        result,
      );
    } finally {
      for (const entry of coverageReservationsToRelease) {
        entry.owner?.settleReservation(entry.reservation, "finally_released");
      }
      releaseSourceContextHeadroomReservation(contextHeadroomReservation);
    }
  }

  async _scheduleAtlasWriteRefresh({ message, session, response }) {
    const toolName = String(message?.params?.name || "");
    const toolArgs = message?.params?.arguments || {};
    const requested = requestedToolPolicyName(toolName, toolArgs);
    if (requested.suite !== "tools") return null;
    if (requested.name !== "write_file" && requested.name !== "edit_file") return null;
    const startedAt = Date.now();
    const executor = getSharedAtlasToolExecutor();
    const scheduled = await executor.scheduleDeterministicWriteRefresh({
      toolName: requested.name,
      args: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
      session: atlasExecutorSessionContext(session),
      source: {
        kind: "mcp_owner_deterministic_write",
        ownerBootId: this.bootId,
        sessionId: session?.id || null,
        originalToolName: toolName,
      },
      result: response?.result || null,
    });
    appendRunTelemetry("diagnostics", {
      kind: "mcp.owner.atlas_write_refresh",
      ...attachTelemetryContext(session, this.bootId),
      outcome: scheduled ? (scheduled.ok === false ? "tool_error" : "ok") : "skipped",
      tool_name: requested.name,
      path: typeof toolArgs?.path === "string" ? capString(toolArgs.path, 240) : null,
      duration_ms: Date.now() - startedAt,
      scheduled: !!scheduled,
      detail: scheduled ? {
        action: scheduled.action || null,
        via: scheduled.via || null,
        branch: scheduled.branch || null,
        queue: scheduled.queue || null,
      } : null,
    });
    return scheduled;
  }

  _authorized(req) {
    return tokenEqual(bearerFrom(req), this.token);
  }
}

export const persistentMcpOwner = new PersistentMcpOwner();
